import type { RepoSyncNotification, RepoSyncQueueMessage } from "@hosonan/shared";
import { describe, expect, it, vi } from "vitest";
import worker, { RepoSyncStateDurableObject } from "../src/worker";
import type { GitHubPushPayload } from "../src/types";

class MockQueue {
  messages: RepoSyncQueueMessage[] = [];

  async send(message: RepoSyncQueueMessage): Promise<void> {
    this.messages.push(message);
  }
}

class MockStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async setAlarm(alarm: number): Promise<void> {
    this.alarm = alarm;
  }
}

class MockRepoSyncStub {
  notifications: RepoSyncNotification[] = [];

  async fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.notifications.push(JSON.parse(String(init?.body)) as RepoSyncNotification);
    return Response.json({ ok: true });
  }
}

class MockDurableObjectNamespace {
  readonly stub = new MockRepoSyncStub();

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  get(_id: DurableObjectId): DurableObjectStub {
    return this.stub as unknown as DurableObjectStub;
  }
}

function env(queue = new MockQueue(), namespace = new MockDurableObjectNamespace()): Env {
  return {
    WEBHOOK_SECRET: "secret",
    ARTICLE_RENDER_QUEUE: queue as unknown as Queue<RepoSyncQueueMessage>,
    REPO_SYNC_STATE: namespace as unknown as Env["REPO_SYNC_STATE"]
  };
}

async function signature(body: string, secret = "secret"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function request(payload: GitHubPushPayload, event = "push", secret = "secret"): Promise<Request> {
  const body = JSON.stringify(payload);
  return new Request("https://worker.example/webhook", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-hub-signature-256": await signature(body, secret)
    },
    body
  });
}

function pushPayload(overrides: Partial<GitHubPushPayload> = {}): GitHubPushPayload {
  return {
    ref: "refs/heads/main",
    after: "abc123",
    repository: {
      id: 42,
      owner: { login: "octo" },
      name: "articles",
      full_name: "octo/articles",
      default_branch: "main"
    },
    installation: { id: 123 },
    commits: [],
    ...overrides
  };
}

function durableObject(queue = new MockQueue(), storage = new MockStorage()): RepoSyncStateDurableObject {
  return new RepoSyncStateDurableObject({ storage } as unknown as DurableObjectState, {
    ARTICLE_RENDER_QUEUE: queue as unknown as Queue<RepoSyncQueueMessage>
  } as Env);
}

describe("worker webhook", () => {
  it("returns 401 for invalid signatures", async () => {
    const namespace = new MockDurableObjectNamespace();
    const response = await worker.fetch(await request(pushPayload(), "push", "wrong"), env(new MockQueue(), namespace));

    expect(response.status).toBe(401);
    expect(namespace.stub.notifications).toHaveLength(0);
  });

  it("ignores non-push events without notifying the repo sync state", async () => {
    const namespace = new MockDurableObjectNamespace();
    const response = await worker.fetch(await request(pushPayload(), "ping"), env(new MockQueue(), namespace));

    expect(response.status).toBe(202);
    expect(namespace.stub.notifications).toHaveLength(0);
  });

  it("notifies the repo sync state for target branch pushes", async () => {
    const namespace = new MockDurableObjectNamespace();
    const response = await worker.fetch(await request(pushPayload()), env(new MockQueue(), namespace));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ notified: true, repositoryId: 42, targetCommit: "abc123" });
    expect(namespace.stub.notifications).toEqual([
      {
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main",
        targetCommit: "abc123"
      }
    ]);
  });

  it("ignores pushes for non-target branches", async () => {
    const namespace = new MockDurableObjectNamespace();
    const response = await worker.fetch(
      await request(pushPayload({ ref: "refs/heads/feature" })),
      env(new MockQueue(), namespace)
    );

    expect(response.status).toBe(202);
    expect(namespace.stub.notifications).toHaveLength(0);
  });
});

describe("RepoSyncStateDurableObject", () => {
  it("debounces notifications and enqueues the latest target commit on alarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const storage = new MockStorage();
    const queue = new MockQueue();
    const object = durableObject(queue, storage);

    await object.notify({
      repositoryId: 42,
      ownerLogin: "octo",
      repoName: "articles",
      installationId: 123,
      targetBranch: "main",
      targetCommit: "first"
    });
    await object.notify({
      repositoryId: 42,
      ownerLogin: "octo",
      repoName: "articles",
      installationId: 123,
      targetBranch: "main",
      targetCommit: "second"
    });

    expect(storage.alarm).toBe(61_000);
    await object.alarm();
    expect(queue.messages).toEqual([
      {
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main"
      }
    ]);
    vi.useRealTimers();
  });

  it("does not issue a second lease while the first lease is active, then reclaims after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const object = durableObject();
    await object.notify({
      repositoryId: 42,
      ownerLogin: "octo",
      repoName: "articles",
      installationId: 123,
      targetBranch: "main",
      targetCommit: "abc123"
    });

    const first = await object.claimSync();
    const busy = await object.claimSync();
    vi.setSystemTime(11 * 60_000);
    const second = await object.claimSync();

    expect(first.status).toBe("claimed");
    expect(busy.status).toBe("busy");
    expect(second.status).toBe("claimed");
    expect(second.leaseId).not.toBe(first.leaseId);
    vi.useRealTimers();
  });

  it("ignores stale complete and fail calls with mismatched leases", async () => {
    const object = durableObject();
    await object.notify({
      repositoryId: 42,
      ownerLogin: "octo",
      repoName: "articles",
      installationId: 123,
      targetBranch: "main",
      targetCommit: "abc123"
    });
    const claim = await object.claimSync();

    await expect(
      object.completeSync("stale", { syncedCommit: "abc123", articleIndex: [] })
    ).resolves.toEqual({ completed: false, ignored: true });
    await expect(object.failSync("stale", { message: "failed" })).resolves.toEqual({ failed: false, ignored: true });
    await expect(
      object.completeSync(String(claim.leaseId), { syncedCommit: "abc123", articleIndex: [] })
    ).resolves.toEqual({ completed: true });
    await expect(object.claimSync()).resolves.toEqual({ status: "idle" });
  });
});
