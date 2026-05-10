import {
  ARTICLE_MARKDOWN_MAX_BYTES,
  HOSONAN_CHANNEL_CONFIG_PATH,
  buildArticleR2Key,
  buildServedArticlePath,
  escapeHtml,
  matchArticleMarkdownPath,
  parseChannelConfigJson,
  truncateArticleTitle,
  type ArticleIndexEntry,
  type ArticlePath,
  type ChannelConfig,
  type RebuildRepositoryChunkQueueMessage,
  type RebuildRepositoryQueueMessage,
  type RepoSyncClaim,
  type RepoSyncCompleteResult,
  type RepoSyncFailure,
  type RepoSyncRepositoryQueueMessage,
  type RepoSyncQueueMessage
} from "@hosonan/shared";
import {
  compareCommits,
  createInstallationAccessToken,
  fetchChannelConfigAtCommit,
  fetchDefaultBranchHead,
  fetchFileMetadataAtCommit,
  fetchMarkdownAtCommit,
  listArticleFilesAtCommit,
  type GitHubChangedFile
} from "./github";
import { convertMarkdownToHtmlFragment, extractMarkdownCreatedAt, extractMarkdownTitle } from "./markdown";

const LEASE_EXTEND_WINDOW_MS = 2 * 60_000;
const DEFAULT_RETRY_SECONDS = 60;
const REBUILD_REPOSITORY_CHUNK_SIZE = 100;
const QUEUE_MESSAGE_MAX_BYTES = 128 * 1024;

export function r2Key(ownerLogin: string, repoName: string, article: Pick<ArticlePath, "date" | "slug">): string {
  return buildArticleR2Key(ownerLogin, repoName, article);
}

export async function renderArticleToR2(
  ownerLogin: string,
  repoName: string,
  article: ArticlePath,
  commitSha: string,
  token: string,
  env: Env
): Promise<RenderedArticle> {
  const metadata = await fetchFileMetadataAtCommit(ownerLogin, repoName, article.path, commitSha, token);
  const markdown =
    metadata.size > ARTICLE_MARKDOWN_MAX_BYTES
      ? undefined
      : await fetchMarkdownAtCommit(ownerLogin, repoName, article.path, commitSha, token);
  const html = markdown
    ? convertMarkdownToHtmlFragment(markdown)
    : oversizedMarkdownHtml(ownerLogin, repoName, article.path, commitSha);
  const title = truncateArticleTitle(markdown ? extractMarkdownTitle(markdown, article.slug) : article.slug);
  const createdAt = markdown ? extractMarkdownCreatedAt(markdown, article.date) : article.date;
  const key = r2Key(ownerLogin, repoName, article);

  await env.ARTICLES_BUCKET.put(key, html, {
    httpMetadata: {
      contentType: "text/html; charset=utf-8"
    }
  });

  return { ...article, r2Key: key, title, createdAt };
}

function oversizedMarkdownHtml(ownerLogin: string, repoName: string, path: string, commitSha: string): string {
  const url = githubBlobUrl(ownerLogin, repoName, commitSha, path);
  return [
    "<p>Markdown ファイルが 1 MiB を超えているため、このページでは本文を表示していません。</p>",
    `<p>元記事は <a href="${escapeHtml(url)}" rel="noopener noreferrer">GitHub で確認</a> できます。</p>`
  ].join("\n");
}

function githubBlobUrl(ownerLogin: string, repoName: string, commitSha: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(repoName)}/blob/${encodeURIComponent(commitSha)}/${encodedPath}`;
}

export async function rebuildRepositoryMessage(message: RebuildRepositoryQueueMessage, env: Env): Promise<number> {
  const token = await createInstallationAccessToken(env, message.installationId, message.repositoryId);
  const targetCommit = await fetchDefaultBranchHead(message.ownerLogin, message.repoName, message.targetBranch, token);
  await updateRepositoryChannelConfig(message.repositoryId, message.ownerLogin, message.repoName, targetCommit, token, env);
  const articles = (await listArticleFilesAtCommit(message.ownerLogin, message.repoName, targetCommit, token)).sort(compareArticlePath);
  let enqueued = 0;

  for (const articlesChunk of chunkRebuildArticles(message, targetCommit, articles)) {
    await env.ARTICLE_RENDER_QUEUE.send({
      type: "rebuild_repository_chunk",
      repositoryId: message.repositoryId,
      ownerLogin: message.ownerLogin,
      repoName: message.repoName,
      installationId: message.installationId,
      targetBranch: message.targetBranch,
      targetCommit,
      articles: articlesChunk
    } satisfies RebuildRepositoryChunkQueueMessage);
    enqueued += 1;
  }

  return enqueued;
}

export async function rebuildRepositoryChunkMessage(
  message: RebuildRepositoryChunkQueueMessage,
  env: Env
): Promise<ArticleIndexEntry[]> {
  const token = await createInstallationAccessToken(env, message.installationId, message.repositoryId);
  const rendered: ArticleIndexEntry[] = [];

  for (const article of message.articles) {
    const result = await renderArticleToR2(message.ownerLogin, message.repoName, article, message.targetCommit, token, env);
    await upsertArticleRecord(message.repositoryId, message.ownerLogin, message.repoName, result, message.targetCommit, env);
    rendered.push(toArticleIndexEntry(result));
  }

  return rendered;
}

export async function syncRepositoryMessage(message: RepoSyncRepositoryQueueMessage, env: Env): Promise<"synced" | "busy" | "idle"> {
  const stub = repoStateObject(env, message.repositoryId);
  const claim = await postJson<RepoSyncClaim>(stub, "/claim", {});
  if (claim.status === "busy" || claim.status === "retry_later") {
    throw new RetryLaterError(claim.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS);
  }
  if (claim.status === "idle") {
    return "idle";
  }
  if (!isClaimed(claim)) {
    throw new Error("Repo sync state returned an invalid claim.");
  }

  try {
    const result =
      claim.desiredState === "active"
        ? await syncActiveRepository({ ...claim, desiredState: "active" }, env, stub)
        : await syncInactiveRepository(claim, env, stub);
    await postJson(stub, "/complete", { leaseId: claim.leaseId, result });
    return "synced";
  } catch (error) {
    const failure = failureFromError(error);
    await postJson(stub, "/fail", { leaseId: claim.leaseId, error: failure });
    throw error;
  }
}

export async function syncClaimedRepository(
  claim: ActiveClaim,
  token: string,
  env: Env,
  stub: DurableObjectStub
): Promise<RepoSyncCompleteResult> {
  const previousIndex = new Map((claim.lastArticleIndex ?? []).map((article) => [article.path, article]));
  const nextIndex = new Map(previousIndex);
  const touchedPaths = await changedArticlePaths(claim, token);

  if (!touchedPaths) {
    return fullScanSync(claim, token, env, stub);
  }

  if (touchedPaths.channelConfigChanged) {
    await ensureLeaseFresh(claim, stub);
    await updateRepositoryChannelConfig(claim.repositoryId, claim.ownerLogin, claim.repoName, claim.targetCommit, token, env);
  }

  for (const path of touchedPaths.removed) {
    const previous = nextIndex.get(path);
    if (previous) {
      await ensureLeaseFresh(claim, stub);
      await env.ARTICLES_BUCKET.delete(previous.r2Key);
      await markArticleRecordStatus(claim.repositoryId, path, "deleted", env);
      nextIndex.delete(path);
    }
  }

  for (const article of touchedPaths.upserted) {
    await ensureLeaseFresh(claim, stub);
    const rendered = await renderArticleToR2(claim.ownerLogin, claim.repoName, article, claim.targetCommit, token, env);
    await upsertArticleRecord(claim.repositoryId, claim.ownerLogin, claim.repoName, rendered, claim.targetCommit, env);
    nextIndex.set(article.path, toArticleIndexEntry(rendered));
  }

  return {
    syncedCommit: claim.targetCommit,
    articleIndex: [...nextIndex.values()].sort(compareArticleIndex)
  };
}

async function syncActiveRepository(
  claim: RequiredClaim & { desiredState: "active" },
  env: Env,
  stub: DurableObjectStub
): Promise<RepoSyncCompleteResult> {
  if (!(await isRepositoryCurrentlyActive(env, claim.repositoryId))) {
    return syncInactiveRepository(claim, env, stub);
  }

  const token = await createInstallationAccessToken(env, claim.installationId, claim.repositoryId);
  const targetCommit = claim.targetCommit ?? (await fetchDefaultBranchHead(claim.ownerLogin, claim.repoName, claim.targetBranch, token));
  return syncClaimedRepository({ ...claim, targetCommit }, token, env, stub);
}

async function isRepositoryCurrentlyActive(env: Env, repositoryId: number): Promise<boolean> {
  const repository = await env.GITHUB_REGISTRY.prepare("SELECT status, sync_enabled FROM repositories WHERE repository_id = ?")
    .bind(repositoryId)
    .first<{ status: string; sync_enabled: number }>();
  return repository?.status === "active" && repository.sync_enabled === 1;
}

async function syncInactiveRepository(
  claim: RequiredClaim,
  env: Env,
  stub: DurableObjectStub
): Promise<RepoSyncCompleteResult> {
  await ensureLeaseFresh(claim, stub);

  return {
    syncedCommit: claim.lastSyncedCommit,
    articleIndex: claim.lastArticleIndex ?? []
  };
}

async function fullScanSync(
  claim: ActiveClaim,
  token: string,
  env: Env,
  stub: DurableObjectStub
): Promise<RepoSyncCompleteResult> {
  await updateRepositoryChannelConfig(claim.repositoryId, claim.ownerLogin, claim.repoName, claim.targetCommit, token, env);

  const articles = await listArticleFilesAtCommit(claim.ownerLogin, claim.repoName, claim.targetCommit, token);
  const previousByPath = new Map((claim.lastArticleIndex ?? []).map((article) => [article.path, article]));
  const latestPaths = new Set(articles.map((article) => article.path));
  const nextIndex: ArticleIndexEntry[] = [];

  for (const previous of previousByPath.values()) {
    if (!latestPaths.has(previous.path)) {
      await ensureLeaseFresh(claim, stub);
      await env.ARTICLES_BUCKET.delete(previous.r2Key);
      await markArticleRecordStatus(claim.repositoryId, previous.path, "deleted", env);
    }
  }

  for (const article of articles.sort(compareArticlePath)) {
    await ensureLeaseFresh(claim, stub);
    const rendered = await renderArticleToR2(claim.ownerLogin, claim.repoName, article, claim.targetCommit, token, env);
    await upsertArticleRecord(claim.repositoryId, claim.ownerLogin, claim.repoName, rendered, claim.targetCommit, env);
    nextIndex.push(toArticleIndexEntry(rendered));
  }

  return {
    syncedCommit: claim.targetCommit,
    articleIndex: nextIndex
  };
}

async function upsertArticleRecord(
  repositoryId: number,
  ownerLogin: string,
  repoName: string,
  article: RenderedArticle,
  syncedCommit: string,
  env: Env
): Promise<void> {
  const now = new Date().toISOString();
  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO articles
       (repository_id, owner_login, repo_name, article_path, slug, title, created_at, canonical_path, r2_key, status, synced_commit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, article_path) DO UPDATE SET
       owner_login = excluded.owner_login,
       repo_name = excluded.repo_name,
       slug = excluded.slug,
       title = excluded.title,
       created_at = excluded.created_at,
       canonical_path = excluded.canonical_path,
       r2_key = excluded.r2_key,
       status = excluded.status,
       synced_commit = excluded.synced_commit,
       updated_at = excluded.updated_at`
  )
    .bind(
      repositoryId,
      ownerLogin,
      repoName,
      article.path,
      article.slug,
      article.title,
      article.createdAt,
      buildServedArticlePath(ownerLogin, repoName, article),
      article.r2Key,
      "active",
      syncedCommit,
      now
    )
    .run();
}

async function markArticleRecordStatus(repositoryId: number, articlePath: string, status: string, env: Env): Promise<void> {
  await env.GITHUB_REGISTRY.prepare(
    "UPDATE articles SET status = ?, updated_at = ? WHERE repository_id = ? AND article_path = ?"
  )
    .bind(status, new Date().toISOString(), repositoryId, articlePath)
    .run();
}

async function markRepositoryArticleRecordsStatus(repositoryId: number, status: string, env: Env): Promise<void> {
  await env.GITHUB_REGISTRY.prepare("UPDATE articles SET status = ?, updated_at = ? WHERE repository_id = ?")
    .bind(status, new Date().toISOString(), repositoryId)
    .run();
}

async function updateRepositoryChannelConfig(
  repositoryId: number,
  ownerLogin: string,
  repoName: string,
  commitSha: string,
  token: string,
  env: Env
): Promise<void> {
  const configJson = await fetchChannelConfigAtCommit(ownerLogin, repoName, commitSha, token);
  const config = configJson === null ? emptyChannelConfig() : parseChannelConfigJson(configJson);
  await saveRepositoryChannelConfig(repositoryId, config, env);
}

async function saveRepositoryChannelConfig(repositoryId: number, config: ChannelConfig, env: Env): Promise<void> {
  await env.GITHUB_REGISTRY.prepare(
    `UPDATE repositories
     SET channel_name = ?, channel_icon_path = ?, channel_biography = ?, channel_updated_at = ?
     WHERE repository_id = ?`
  )
    .bind(config.name, config.icon, config.biography, new Date().toISOString(), repositoryId)
    .run();
}

function emptyChannelConfig(): ChannelConfig {
  return { name: null, icon: null, biography: null };
}

function toArticleIndexEntry(article: RenderedArticle): ArticleIndexEntry {
  return {
    date: article.date,
    slug: article.slug,
    path: article.path,
    r2Key: article.r2Key
  };
}

async function changedArticlePaths(
  claim: ActiveClaim,
  token: string
): Promise<{ upserted: ArticlePath[]; removed: string[]; channelConfigChanged: boolean } | null> {
  if (!claim.lastSyncedCommit) {
    return null;
  }

  const comparison = await compareCommits(claim.ownerLogin, claim.repoName, claim.lastSyncedCommit, claim.targetCommit, token);
  if (!comparison.ok || comparison.retryAt) {
    if (comparison.retryAt) {
      const error = new Error("GitHub compare is rate limited.");
      (error as Error & { retryAt?: number }).retryAt = comparison.retryAt;
      throw error;
    }
    return null;
  }

  const upserted = new Map<string, ArticlePath>();
  const removed = new Set<string>();
  let channelConfigChanged = false;
  for (const file of comparison.files) {
    channelConfigChanged ||= isChannelConfigChanged(file);
    collectChangedArticleFile(file, upserted, removed);
  }

  return { upserted: [...upserted.values()], removed: [...removed], channelConfigChanged };
}

function isChannelConfigChanged(file: GitHubChangedFile): boolean {
  return file.filename === HOSONAN_CHANNEL_CONFIG_PATH || file.previous_filename === HOSONAN_CHANNEL_CONFIG_PATH;
}

function collectChangedArticleFile(file: GitHubChangedFile, upserted: Map<string, ArticlePath>, removed: Set<string>): void {
  if (file.previous_filename && (file.status === "renamed" || file.status === "removed")) {
    const previousArticle = matchArticleMarkdownPath(file.previous_filename);
    if (previousArticle) {
      removed.add(previousArticle.path);
    }
  }

  const article = matchArticleMarkdownPath(file.filename);
  if (!article) {
    return;
  }

  if (file.status === "removed") {
    removed.add(article.path);
    upserted.delete(article.path);
  } else {
    removed.delete(article.path);
    upserted.set(article.path, article);
  }
}

async function ensureLeaseFresh(claim: RequiredClaim, stub: DurableObjectStub): Promise<void> {
  if (claim.leaseExpiresAt - Date.now() > LEASE_EXTEND_WINDOW_MS) {
    return;
  }

  const result = await postJson<{ extended: boolean; leaseExpiresAt?: number }>(stub, "/extend-lease", {
    leaseId: claim.leaseId
  });
  if (!result.extended || !result.leaseExpiresAt) {
    throw new Error("Repo sync lease could not be extended.");
  }
  claim.leaseExpiresAt = result.leaseExpiresAt;
}

function repoStateObject(env: Env, repositoryId: number): DurableObjectStub {
  return env.REPO_SYNC_STATE.get(env.REPO_SYNC_STATE.idFromName(String(repositoryId)));
}

async function postJson<T>(stub: DurableObjectStub, path: string, body: unknown): Promise<T> {
  const response = await stub.fetch(`https://repo-sync-state.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Repo sync state request failed: ${response.status}`);
  }
  return response.json();
}

function isClaimed(claim: RepoSyncClaim): claim is RequiredClaim {
  return (
    claim.status === "claimed" &&
    typeof claim.leaseId === "string" &&
    typeof claim.leaseExpiresAt === "number" &&
    typeof claim.repositoryId === "number" &&
    typeof claim.ownerLogin === "string" &&
    typeof claim.repoName === "string" &&
    typeof claim.installationId === "number" &&
    typeof claim.targetBranch === "string" &&
    (claim.desiredState === "active" || claim.desiredState === "inactive" || claim.desiredState === "deleted")
  );
}

function failureFromError(error: unknown): RepoSyncFailure {
  const maybeRetry = error as Error & { retryAt?: number };
  return {
    message: error instanceof Error ? error.message : String(error),
    retryAt: maybeRetry.retryAt
  };
}

function compareArticleIndex(left: ArticleIndexEntry, right: ArticleIndexEntry): number {
  return left.path.localeCompare(right.path);
}

function compareArticlePath(left: ArticlePath, right: ArticlePath): number {
  return left.path.localeCompare(right.path);
}

function isRebuildRepositoryMessage(message: RepoSyncQueueMessage): message is RebuildRepositoryQueueMessage {
  return "type" in message && message.type === "rebuild_repository";
}

function isRebuildRepositoryChunkMessage(message: RepoSyncQueueMessage): message is RebuildRepositoryChunkQueueMessage {
  return "type" in message && message.type === "rebuild_repository_chunk";
}

function chunkRebuildArticles(
  message: RebuildRepositoryQueueMessage,
  targetCommit: string,
  articles: ArticlePath[]
): ArticlePath[][] {
  const chunks: ArticlePath[][] = [];
  let index = 0;

  while (index < articles.length) {
    const end = findRebuildChunkEnd(message, targetCommit, articles, index);
    chunks.push(articles.slice(index, end));
    index = end;
  }

  return chunks;
}

function findRebuildChunkEnd(
  message: RebuildRepositoryQueueMessage,
  targetCommit: string,
  articles: ArticlePath[],
  start: number
): number {
  let low = start + 1;
  let high = Math.min(start + REBUILD_REPOSITORY_CHUNK_SIZE, articles.length);
  let best = low;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = rebuildChunkMessage(message, targetCommit, articles.slice(start, mid));
    if (queueMessageSize(candidate) <= QUEUE_MESSAGE_MAX_BYTES || mid === start + 1) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function rebuildChunkMessage(
  message: RebuildRepositoryQueueMessage,
  targetCommit: string,
  articles: ArticlePath[]
): RebuildRepositoryChunkQueueMessage {
  return {
    type: "rebuild_repository_chunk",
    repositoryId: message.repositoryId,
    ownerLogin: message.ownerLogin,
    repoName: message.repoName,
    installationId: message.installationId,
    targetBranch: message.targetBranch,
    targetCommit,
    articles
  };
}

function queueMessageSize(message: RepoSyncQueueMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}

class RetryLaterError extends Error {
  constructor(readonly delaySeconds: number) {
    super("Repo sync is already running or waiting for retry.");
  }
}

type RequiredClaim = RepoSyncClaim & {
  status: "claimed";
  leaseId: string;
  leaseExpiresAt: number;
  repositoryId: number;
  ownerLogin: string;
  repoName: string;
  installationId: number;
  targetBranch: string;
  desiredState: "active" | "inactive" | "deleted";
  targetCommit?: string;
};

type ActiveClaim = RequiredClaim & {
  desiredState: "active";
  targetCommit: string;
};

type RenderedArticle = ArticleIndexEntry & {
  title: string;
  createdAt: string;
};

export default {
  async queue(batch: MessageBatch<RepoSyncQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (isRebuildRepositoryMessage(message.body)) {
          await rebuildRepositoryMessage(message.body, env);
        } else if (isRebuildRepositoryChunkMessage(message.body)) {
          await rebuildRepositoryChunkMessage(message.body, env);
        } else {
          await syncRepositoryMessage(message.body, env);
        }
      } catch (error) {
        if (error instanceof RetryLaterError) {
          message.retry({ delaySeconds: error.delaySeconds });
          continue;
        }

        console.error("Failed to sync repository queue message.", error);
        const retryAt = (error as Error & { retryAt?: number }).retryAt;
        if (retryAt) {
          message.retry({ delaySeconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) });
        } else {
          message.retry();
        }
      }
    }
  }
};
