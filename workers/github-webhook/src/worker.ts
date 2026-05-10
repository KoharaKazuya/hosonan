import type {
  ArticleIndexEntry,
  RepoSyncClaim,
  RepoSyncCompleteResult,
  RepoSyncDesiredState,
  RepoSyncFailure,
  RepoSyncNotification
} from "@hosonan/shared";
import { verifyGitHubSignature } from "./github";
import type {
  GitHubAccountPayload,
  GitHubInstallationEventPayload,
  GitHubInstallationRepositoriesPayload,
  GitHubInstallationTargetPayload,
  GitHubPushPayload,
  GitHubRepositoryEventPayload,
  GitHubRepositoryPayload
} from "./types";

const DEBOUNCE_MS = 60_000;
const LEASE_TTL_MS = 10 * 60_000;
const BUSY_RETRY_SECONDS = 30;
const STATE_KEY = "repo-sync-state";

interface SyncLease {
  id: string;
  expiresAt: number;
}

interface RepoSyncState {
  repositoryId: number;
  installationId: number;
  ownerLogin: string;
  repoName: string;
  targetBranch: string;
  desiredState: RepoSyncDesiredState;
  targetCommit?: string;
  lastSyncedCommit?: string;
  lastArticleIndex: ArticleIndexEntry[];
  inFlightLease?: SyncLease;
  lastError?: RepoSyncFailure;
  retryAt?: number;
}

interface StoredRepository {
  repository_id: number;
  installation_id: number;
  owner_login: string;
  repo_name: string;
  default_branch: string;
  status: string;
  sync_enabled: number;
}

function repoStateObject(env: Env, repositoryId: number): DurableObjectStub {
  return env.REPO_SYNC_STATE.get(env.REPO_SYNC_STATE.idFromName(String(repositoryId)));
}

function repositoryDefaultBranch(repository: { default_branch?: string | null }): string {
  return repository.default_branch ?? "main";
}

function repositoryOwnerLogin(repository: GitHubRepositoryPayload): string {
  const ownerLogin = repository.owner?.login ?? repository.full_name?.split("/")[0];
  if (!ownerLogin) {
    throw new Error("GitHub repository payload did not include owner login.");
  }
  return ownerLogin;
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function retryAfterSeconds(timestamp: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((timestamp - now) / 1000));
}

function isConverged(state: RepoSyncState): boolean {
  if (state.desiredState === "active") {
    return Boolean(state.lastSyncedCommit) && state.targetCommit === state.lastSyncedCommit;
  }
  if (state.desiredState === "inactive") {
    return true;
  }
  return state.lastArticleIndex.length === 0;
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

async function notifyRepository(
  env: Env,
  installationId: number,
  repository: GitHubRepositoryPayload,
  desiredState: RepoSyncDesiredState,
  targetCommit?: string
): Promise<void> {
  await postJson(repoStateObject(env, repository.id), "/notify", {
    repositoryId: repository.id,
    ownerLogin: repositoryOwnerLogin(repository),
    repoName: repository.name,
    installationId,
    targetBranch: repositoryDefaultBranch(repository),
    desiredState,
    targetCommit
  } satisfies RepoSyncNotification);
}

async function notifyStoredRepository(
  env: Env,
  repository: StoredRepository,
  desiredState: RepoSyncDesiredState
): Promise<void> {
  await postJson(repoStateObject(env, repository.repository_id), "/notify", {
    repositoryId: repository.repository_id,
    ownerLogin: repository.owner_login,
    repoName: repository.repo_name,
    installationId: repository.installation_id,
    targetBranch: repository.default_branch,
    desiredState
  } satisfies RepoSyncNotification);
}

async function handlePush(payload: GitHubPushPayload, env: Env): Promise<Response> {
  const branch = repositoryDefaultBranch(payload.repository);
  if (
    !payload.installation?.id ||
    !payload.after ||
    payload.deleted ||
    payload.ref !== branchRef(branch)
  ) {
    return new Response("ignored\n", { status: 202 });
  }

  await upsertRepository(env, payload.installation.id, payload.repository, "active");
  const stored = await findRepository(env, payload.repository.id);
  if (!stored || stored.status !== "active" || stored.sync_enabled !== 1) {
    return new Response("ignored\n", { status: 202 });
  }
  await notifyRepository(env, payload.installation.id, payload.repository, "active", payload.after);
  return Response.json({ notified: true, repositoryId: payload.repository.id, targetCommit: payload.after });
}

async function handleInstallation(payload: GitHubInstallationEventPayload, env: Env): Promise<Response> {
  const action = payload.action ?? "";
  if (action === "created") {
    await upsertInstallation(env, payload.installation, "active");
    for (const repository of payload.repositories ?? []) {
      await upsertRepository(env, payload.installation.id, repository, "active");
    }
    return Response.json({ handled: true, event: "installation", action });
  }

  if (action === "deleted") {
    await updateInstallationStatus(env, payload.installation.id, "deleted");
    const repositories = await listRepositoriesByInstallation(env, payload.installation.id);
    for (const repository of repositories) {
      await updateRepositoryStatus(env, repository.repository_id, "deleted");
    }
    return Response.json({ handled: true, event: "installation", action });
  }

  return new Response("ignored\n", { status: 202 });
}

async function handleInstallationRepositories(
  payload: GitHubInstallationRepositoriesPayload,
  env: Env
): Promise<Response> {
  const action = payload.action ?? "";
  const installationId = payload.installation.id;
  if (action === "added") {
    for (const repository of payload.repositories_added ?? []) {
      await upsertRepository(env, installationId, repository, "active");
    }
    return Response.json({ handled: true, event: "installation_repositories", action });
  }

  if (action === "removed") {
    for (const repository of payload.repositories_removed ?? []) {
      await updateRepositoryStatus(env, repository.id, "inactive");
    }
    return Response.json({ handled: true, event: "installation_repositories", action });
  }

  return new Response("ignored\n", { status: 202 });
}

async function handleRepository(payload: GitHubRepositoryEventPayload, env: Env): Promise<Response> {
  const action = payload.action ?? "";
  const installationId = payload.installation?.id;
  const repository = payload.repository;

  if (action === "deleted") {
    await updateRepositoryStatus(env, repository.id, "deleted");
    return Response.json({ handled: true, event: "repository", action });
  }

  if (action === "privatized" || action === "archived") {
    if (installationId) {
      await upsertRepository(env, installationId, repository, "inactive");
    }
    return Response.json({ handled: true, event: "repository", action });
  }

  if (["created", "edited", "renamed", "transferred", "publicized", "unarchived"].includes(action)) {
    if (!installationId) {
      return new Response("ignored\n", { status: 202 });
    }
    await upsertRepository(env, installationId, repository, "active");
    const stored = await findRepository(env, repository.id);
    if (action !== "edited" && stored?.status === "active" && stored.sync_enabled === 1) {
      await notifyRepository(env, installationId, repository, "active");
    }
    return Response.json({ handled: true, event: "repository", action });
  }

  return new Response("ignored\n", { status: 202 });
}

async function handleInstallationTarget(payload: GitHubInstallationTargetPayload, env: Env): Promise<Response> {
  if (payload.action !== "renamed" || !payload.installation?.id || !payload.account?.login) {
    return new Response("ignored\n", { status: 202 });
  }

  await updateInstallationAccount(env, payload.installation.id, payload.account);
  const previousLogin = payload.changes?.login?.from;
  if (previousLogin) {
    await updateRepositoryOwnerLogin(env, payload.installation.id, previousLogin, payload.account.login);
  }
  return Response.json({ handled: true, event: "installation_target", action: payload.action });
}

function visibility(repository: GitHubRepositoryPayload): string {
  return repository.visibility ?? (repository.private ? "private" : "public");
}

async function upsertInstallation(
  env: Env,
  installation: { id: number; account?: GitHubAccountPayload },
  status: string
): Promise<void> {
  const now = new Date().toISOString();
  const account = installation.account;
  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO installations (installation_id, account_id, account_login, account_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(installation_id) DO UPDATE SET
       account_id = excluded.account_id,
       account_login = excluded.account_login,
       account_type = excluded.account_type,
       status = excluded.status,
       updated_at = excluded.updated_at`
  )
    .bind(installation.id, account?.id ?? null, account?.login ?? null, account?.type ?? null, status, now, now)
    .run();
}

async function updateInstallationStatus(env: Env, installationId: number, status: string): Promise<void> {
  await env.GITHUB_REGISTRY.prepare("UPDATE installations SET status = ?, updated_at = ? WHERE installation_id = ?")
    .bind(status, new Date().toISOString(), installationId)
    .run();
}

async function updateInstallationAccount(env: Env, installationId: number, account: GitHubAccountPayload): Promise<void> {
  await env.GITHUB_REGISTRY.prepare(
    "UPDATE installations SET account_id = ?, account_login = ?, account_type = ?, updated_at = ? WHERE installation_id = ?"
  )
    .bind(account.id, account.login, account.type ?? null, new Date().toISOString(), installationId)
    .run();
}

async function upsertRepository(
  env: Env,
  installationId: number,
  repository: GitHubRepositoryPayload,
  status: string
): Promise<void> {
  const now = new Date().toISOString();
  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO repositories
       (repository_id, installation_id, owner_login, repo_name, full_name, default_branch, visibility, archived, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_id) DO UPDATE SET
       installation_id = excluded.installation_id,
       owner_login = excluded.owner_login,
       repo_name = excluded.repo_name,
       full_name = excluded.full_name,
       default_branch = excluded.default_branch,
       visibility = excluded.visibility,
       archived = excluded.archived,
       status = excluded.status,
       updated_at = excluded.updated_at`
  )
    .bind(
      repository.id,
      installationId,
      repositoryOwnerLogin(repository),
      repository.name,
      repository.full_name ?? `${repositoryOwnerLogin(repository)}/${repository.name}`,
      repositoryDefaultBranch(repository),
      visibility(repository),
      repository.archived ? 1 : 0,
      status,
      now,
      now
    )
    .run();
}

async function updateRepositoryStatus(env: Env, repositoryId: number, status: string): Promise<void> {
  await env.GITHUB_REGISTRY.prepare("UPDATE repositories SET status = ?, updated_at = ? WHERE repository_id = ?")
    .bind(status, new Date().toISOString(), repositoryId)
    .run();
}

async function updateRepositoryOwnerLogin(env: Env, installationId: number, from: string, to: string): Promise<void> {
  await env.GITHUB_REGISTRY.prepare(
    "UPDATE repositories SET owner_login = ?, full_name = ? || '/' || repo_name, updated_at = ? WHERE installation_id = ? AND owner_login = ?"
  )
    .bind(to, to, new Date().toISOString(), installationId, from)
    .run();
}

async function listRepositoriesByInstallation(env: Env, installationId: number): Promise<StoredRepository[]> {
  const result = await env.GITHUB_REGISTRY.prepare(
    "SELECT repository_id, installation_id, owner_login, repo_name, default_branch, status, sync_enabled FROM repositories WHERE installation_id = ? AND status != 'deleted'"
  )
    .bind(installationId)
    .all<StoredRepository>();
  return result.results ?? [];
}

async function findRepository(env: Env, repositoryId: number): Promise<StoredRepository | undefined> {
  const result = await env.GITHUB_REGISTRY.prepare(
    "SELECT repository_id, installation_id, owner_login, repo_name, default_branch, status, sync_enabled FROM repositories WHERE repository_id = ?"
  )
    .bind(repositoryId)
    .first<StoredRepository>();
  return result ?? undefined;
}

async function insertDelivery(
  env: Env,
  deliveryId: string,
  event: string,
  action?: string,
  targetId?: number
): Promise<boolean> {
  const result = await env.GITHUB_REGISTRY.prepare(
    "INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, action, target_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(deliveryId, event, action ?? null, targetId ?? null, "processing", new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function updateDelivery(env: Env, deliveryId: string, status: string, error?: string): Promise<void> {
  await env.GITHUB_REGISTRY.prepare(
    "UPDATE webhook_deliveries SET status = ?, error = ?, completed_at = ? WHERE delivery_id = ?"
  )
    .bind(status, error ?? null, new Date().toISOString(), deliveryId)
    .run();
}

export class RepoSyncStateDurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return new Response("method not allowed\n", { status: 405 });
    }

    if (url.pathname === "/notify") {
      return Response.json(await this.notify((await request.json()) as RepoSyncNotification));
    }
    if (url.pathname === "/claim") {
      return Response.json(await this.claimSync());
    }
    if (url.pathname === "/extend-lease") {
      const { leaseId } = (await request.json()) as { leaseId?: string };
      return Response.json(await this.extendLease(String(leaseId ?? "")));
    }
    if (url.pathname === "/complete") {
      const { leaseId, result } = (await request.json()) as { leaseId?: string; result?: RepoSyncCompleteResult };
      return Response.json(await this.completeSync(String(leaseId ?? ""), result));
    }
    if (url.pathname === "/fail") {
      const { leaseId, error } = (await request.json()) as { leaseId?: string; error?: RepoSyncFailure };
      return Response.json(await this.failSync(String(leaseId ?? ""), error));
    }

    return new Response("not found\n", { status: 404 });
  }

  async alarm(): Promise<void> {
    const state = await this.readState();
    if (!state || isConverged(state)) {
      return;
    }

    const now = Date.now();
    if (state.retryAt && state.retryAt > now) {
      await this.ctx.storage.setAlarm(state.retryAt);
      return;
    }

    if (state.inFlightLease && state.inFlightLease.expiresAt > now) {
      await this.ctx.storage.setAlarm(state.inFlightLease.expiresAt);
      return;
    }

    await this.env.ARTICLE_RENDER_QUEUE.send({
      repositoryId: state.repositoryId,
      ownerLogin: state.ownerLogin,
      repoName: state.repoName,
      installationId: state.installationId,
      targetBranch: state.targetBranch,
      desiredState: state.desiredState
    });
  }

  async notify(notification: RepoSyncNotification): Promise<{ desiredState: RepoSyncDesiredState; targetCommit?: string }> {
    const previous = await this.readState();
    const state: RepoSyncState = {
      repositoryId: notification.repositoryId,
      installationId: notification.installationId,
      ownerLogin: notification.ownerLogin,
      repoName: notification.repoName,
      targetBranch: notification.targetBranch,
      desiredState: notification.desiredState,
      targetCommit: notification.targetCommit,
      lastSyncedCommit: previous?.lastSyncedCommit,
      lastArticleIndex: previous?.lastArticleIndex ?? [],
      inFlightLease: previous?.inFlightLease,
      lastError: previous?.lastError,
      retryAt: previous?.retryAt
    };

    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
    return { desiredState: notification.desiredState, targetCommit: notification.targetCommit };
  }

  async claimSync(): Promise<RepoSyncClaim> {
    const state = await this.readState();
    const now = Date.now();
    if (!state || isConverged(state)) {
      return { status: "idle" };
    }

    if (state.retryAt && state.retryAt > now) {
      return { status: "retry_later", retryAfterSeconds: retryAfterSeconds(state.retryAt, now) };
    }

    if (state.inFlightLease && state.inFlightLease.expiresAt > now) {
      return { status: "busy", retryAfterSeconds: BUSY_RETRY_SECONDS };
    }

    const lease: SyncLease = {
      id: crypto.randomUUID(),
      expiresAt: now + LEASE_TTL_MS
    };
    state.inFlightLease = lease;
    state.retryAt = undefined;
    state.lastError = undefined;
    await this.ctx.storage.put(STATE_KEY, state);

    return {
      status: "claimed",
      leaseId: lease.id,
      leaseExpiresAt: lease.expiresAt,
      repositoryId: state.repositoryId,
      ownerLogin: state.ownerLogin,
      repoName: state.repoName,
      installationId: state.installationId,
      targetBranch: state.targetBranch,
      desiredState: state.desiredState,
      targetCommit: state.targetCommit,
      lastSyncedCommit: state.lastSyncedCommit,
      lastArticleIndex: state.lastArticleIndex
    };
  }

  async extendLease(leaseId: string): Promise<{ extended: boolean; leaseExpiresAt?: number }> {
    const state = await this.readState();
    if (!state?.inFlightLease || state.inFlightLease.id !== leaseId || state.inFlightLease.expiresAt <= Date.now()) {
      return { extended: false };
    }

    state.inFlightLease.expiresAt = Date.now() + LEASE_TTL_MS;
    await this.ctx.storage.put(STATE_KEY, state);
    return { extended: true, leaseExpiresAt: state.inFlightLease.expiresAt };
  }

  async completeSync(
    leaseId: string,
    result?: RepoSyncCompleteResult
  ): Promise<{ completed: boolean; ignored?: boolean }> {
    const state = await this.readState();
    if (!state?.inFlightLease || state.inFlightLease.id !== leaseId || !result) {
      return { completed: false, ignored: true };
    }

    if (state.desiredState === "active" || state.desiredState === "inactive") {
      state.lastSyncedCommit = result.syncedCommit;
      state.targetCommit = result.syncedCommit;
      state.lastArticleIndex = result.articleIndex;
    } else {
      state.lastSyncedCommit = undefined;
      state.targetCommit = undefined;
      state.lastArticleIndex = [];
    }
    state.inFlightLease = undefined;
    state.lastError = undefined;
    state.retryAt = undefined;
    await this.ctx.storage.put(STATE_KEY, state);

    if (!isConverged(state)) {
      await this.ctx.storage.setAlarm(Date.now());
    }

    return { completed: true };
  }

  async failSync(leaseId: string, error?: RepoSyncFailure): Promise<{ failed: boolean; ignored?: boolean }> {
    const state = await this.readState();
    if (!state?.inFlightLease || state.inFlightLease.id !== leaseId) {
      return { failed: false, ignored: true };
    }

    state.inFlightLease = undefined;
    state.lastError = error ?? { message: "unknown error" };
    state.retryAt = error?.retryAt;
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.setAlarm(state.retryAt ?? Date.now() + BUSY_RETRY_SECONDS * 1000);
    return { failed: true };
  }

  private async readState(): Promise<RepoSyncState | undefined> {
    const state = await this.ctx.storage.get<RepoSyncState>(STATE_KEY);
    if (state && !state.desiredState) {
      state.desiredState = "active";
    }
    return state;
  }
}

export { RepoSyncStateDurableObject as RepoSyncState };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed\n", { status: 405 });
    }

    const rawBody = await request.text();
    const validSignature = await verifyGitHubSignature(rawBody, request.headers.get("x-hub-signature-256"), env.WEBHOOK_SECRET);
    if (!validSignature) {
      return new Response("unauthorized\n", { status: 401 });
    }

    const event = request.headers.get("x-github-event") ?? "";
    const deliveryId = request.headers.get("x-github-delivery");
    const payload = JSON.parse(rawBody) as {
      action?: string;
      repository?: { id?: number };
      installation?: { id?: number };
    };

    if (deliveryId) {
      const inserted = await insertDelivery(env, deliveryId, event, payload.action, payload.repository?.id ?? payload.installation?.id);
      if (!inserted) {
        return new Response("duplicate\n", { status: 202 });
      }
    }

    try {
      let response: Response;
      switch (event) {
        case "push":
          response = await handlePush(payload as GitHubPushPayload, env);
          break;
        case "installation":
          response = await handleInstallation(payload as GitHubInstallationEventPayload, env);
          break;
        case "installation_repositories":
          response = await handleInstallationRepositories(payload as GitHubInstallationRepositoriesPayload, env);
          break;
        case "repository":
          response = await handleRepository(payload as GitHubRepositoryEventPayload, env);
          break;
        case "installation_target":
          response = await handleInstallationTarget(payload as GitHubInstallationTargetPayload, env);
          break;
        default:
          response = new Response("ignored\n", { status: 202 });
      }

      if (deliveryId) {
        await updateDelivery(env, deliveryId, response.status === 200 ? "completed" : "ignored");
      }
      return response;
    } catch (error) {
      if (deliveryId) {
        await updateDelivery(env, deliveryId, "failed", error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }
};
