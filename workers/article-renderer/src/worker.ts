import {
  buildArticleR2Key,
  matchArticleMarkdownPath,
  type ArticleIndexEntry,
  type ArticlePath,
  type RepoSyncClaim,
  type RepoSyncCompleteResult,
  type RepoSyncFailure,
  type RepoSyncQueueMessage
} from "@hosonan/shared";
import {
  compareCommits,
  createInstallationAccessToken,
  fetchMarkdownAtCommit,
  listArticleFilesAtCommit,
  type GitHubChangedFile
} from "./github";
import { convertMarkdownToHtmlFragment } from "./markdown";

const LEASE_EXTEND_WINDOW_MS = 2 * 60_000;
const DEFAULT_RETRY_SECONDS = 60;

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
): Promise<ArticleIndexEntry> {
  const markdown = await fetchMarkdownAtCommit(ownerLogin, repoName, article.path, commitSha, token);
  const html = convertMarkdownToHtmlFragment(markdown);
  const key = r2Key(ownerLogin, repoName, article);

  await env.ARTICLES_BUCKET.put(key, html, {
    httpMetadata: {
      contentType: "text/html; charset=utf-8"
    }
  });

  return { ...article, r2Key: key };
}

export async function syncRepositoryMessage(message: RepoSyncQueueMessage, env: Env): Promise<"synced" | "busy" | "idle"> {
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
    const token = await createInstallationAccessToken(env, claim.installationId);
    const result = await syncClaimedRepository(claim, token, env, stub);
    await postJson(stub, "/complete", { leaseId: claim.leaseId, result });
    return "synced";
  } catch (error) {
    const failure = failureFromError(error);
    await postJson(stub, "/fail", { leaseId: claim.leaseId, error: failure });
    throw error;
  }
}

export async function syncClaimedRepository(
  claim: RequiredClaim,
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

  for (const path of touchedPaths.removed) {
    const previous = nextIndex.get(path);
    if (previous) {
      await ensureLeaseFresh(claim, stub);
      await env.ARTICLES_BUCKET.delete(previous.r2Key);
      nextIndex.delete(path);
    }
  }

  for (const article of touchedPaths.upserted) {
    await ensureLeaseFresh(claim, stub);
    const rendered = await renderArticleToR2(claim.ownerLogin, claim.repoName, article, claim.targetCommit, token, env);
    nextIndex.set(article.path, rendered);
  }

  return {
    syncedCommit: claim.targetCommit,
    articleIndex: [...nextIndex.values()].sort(compareArticleIndex)
  };
}

async function fullScanSync(
  claim: RequiredClaim,
  token: string,
  env: Env,
  stub: DurableObjectStub
): Promise<RepoSyncCompleteResult> {
  const articles = await listArticleFilesAtCommit(claim.ownerLogin, claim.repoName, claim.targetCommit, token);
  const previousByPath = new Map((claim.lastArticleIndex ?? []).map((article) => [article.path, article]));
  const latestPaths = new Set(articles.map((article) => article.path));
  const nextIndex: ArticleIndexEntry[] = [];

  for (const previous of previousByPath.values()) {
    if (!latestPaths.has(previous.path)) {
      await ensureLeaseFresh(claim, stub);
      await env.ARTICLES_BUCKET.delete(previous.r2Key);
    }
  }

  for (const article of articles.sort(compareArticlePath)) {
    await ensureLeaseFresh(claim, stub);
    nextIndex.push(await renderArticleToR2(claim.ownerLogin, claim.repoName, article, claim.targetCommit, token, env));
  }

  return {
    syncedCommit: claim.targetCommit,
    articleIndex: nextIndex
  };
}

async function changedArticlePaths(
  claim: RequiredClaim,
  token: string
): Promise<{ upserted: ArticlePath[]; removed: string[] } | null> {
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
  for (const file of comparison.files) {
    collectChangedArticleFile(file, upserted, removed);
  }

  return { upserted: [...upserted.values()], removed: [...removed] };
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
    typeof claim.ownerLogin === "string" &&
    typeof claim.repoName === "string" &&
    typeof claim.installationId === "number" &&
    typeof claim.targetCommit === "string"
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

class RetryLaterError extends Error {
  constructor(readonly delaySeconds: number) {
    super("Repo sync is already running or waiting for retry.");
  }
}

type RequiredClaim = RepoSyncClaim & {
  status: "claimed";
  leaseId: string;
  leaseExpiresAt: number;
  ownerLogin: string;
  repoName: string;
  installationId: number;
  targetCommit: string;
};

export default {
  async queue(batch: MessageBatch<RepoSyncQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await syncRepositoryMessage(message.body, env);
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
