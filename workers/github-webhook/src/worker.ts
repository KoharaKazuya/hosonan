import type {
  ArticleIndexEntry,
  RepoSyncClaim,
  RepoSyncCompleteResult,
  RepoSyncFailure,
  RepoSyncNotification
} from "@hosonan/shared";
import { verifyGitHubSignature } from "./github";
import type { GitHubPushPayload } from "./types";

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
  targetCommit?: string;
  lastSyncedCommit?: string;
  lastArticleIndex: ArticleIndexEntry[];
  inFlightLease?: SyncLease;
  lastError?: RepoSyncFailure;
  retryAt?: number;
}

function repoStateObject(env: Env, repositoryId: number): DurableObjectStub {
  return env.REPO_SYNC_STATE.get(env.REPO_SYNC_STATE.idFromName(String(repositoryId)));
}

function targetBranch(payload: GitHubPushPayload): string {
  return payload.repository.default_branch ?? "main";
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function retryAfterSeconds(timestamp: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((timestamp - now) / 1000));
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

async function handlePush(payload: GitHubPushPayload, env: Env): Promise<Response> {
  const branch = targetBranch(payload);
  if (
    !payload.installation?.id ||
    !payload.after ||
    payload.deleted ||
    payload.ref !== branchRef(branch)
  ) {
    return new Response("ignored\n", { status: 202 });
  }

  const notification: RepoSyncNotification = {
    repositoryId: payload.repository.id,
    ownerLogin: payload.repository.owner.login,
    repoName: payload.repository.name,
    installationId: payload.installation.id,
    targetBranch: branch,
    targetCommit: payload.after
  };

  await postJson(repoStateObject(env, payload.repository.id), "/notify", notification);
  return Response.json({ notified: true, repositoryId: payload.repository.id, targetCommit: payload.after });
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
    if (!state?.targetCommit || state.targetCommit === state.lastSyncedCommit) {
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
      targetBranch: state.targetBranch
    });
  }

  async notify(notification: RepoSyncNotification): Promise<{ targetCommit: string }> {
    const previous = await this.readState();
    const state: RepoSyncState = {
      repositoryId: notification.repositoryId,
      installationId: notification.installationId,
      ownerLogin: notification.ownerLogin,
      repoName: notification.repoName,
      targetBranch: notification.targetBranch,
      targetCommit: notification.targetCommit,
      lastSyncedCommit: previous?.lastSyncedCommit,
      lastArticleIndex: previous?.lastArticleIndex ?? [],
      inFlightLease: previous?.inFlightLease,
      lastError: previous?.lastError,
      retryAt: previous?.retryAt
    };

    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
    return { targetCommit: notification.targetCommit };
  }

  async claimSync(): Promise<RepoSyncClaim> {
    const state = await this.readState();
    const now = Date.now();
    if (!state?.targetCommit || state.targetCommit === state.lastSyncedCommit) {
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

    state.lastSyncedCommit = result.syncedCommit;
    state.lastArticleIndex = result.articleIndex;
    state.inFlightLease = undefined;
    state.lastError = undefined;
    state.retryAt = undefined;
    await this.ctx.storage.put(STATE_KEY, state);

    if (state.targetCommit && state.targetCommit !== state.lastSyncedCommit) {
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
    return this.ctx.storage.get<RepoSyncState>(STATE_KEY);
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

    const event = request.headers.get("x-github-event");
    if (event !== "push") {
      return new Response("ignored\n", { status: 202 });
    }

    const payload = JSON.parse(rawBody) as GitHubPushPayload;
    return handlePush(payload, env);
  }
};
