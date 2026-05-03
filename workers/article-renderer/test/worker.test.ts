import type { RepoSyncClaim, RepoSyncCompleteResult, RepoSyncFailure, RepoSyncQueueMessage } from "@hosonan/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { syncRepositoryMessage } from "../src/worker";

vi.mock("../src/github", () => ({
  createInstallationAccessToken: vi.fn(async () => "token"),
  compareCommits: vi.fn(async () => ({ ok: true, files: [] })),
  fetchMarkdownAtCommit: vi.fn(async (_owner: string, _repo: string, path: string) => `# ${path}`),
  listArticleFilesAtCommit: vi.fn(async () => [])
}));

const github = await import("../src/github");

class MockR2Bucket {
  puts: Array<{ key: string; value: string; contentType?: string }> = [];
  deletes: string[] = [];

  async put(key: string, value: string, options?: R2PutOptions): Promise<R2Object> {
    const httpMetadata = options?.httpMetadata;
    this.puts.push({
      key,
      value,
      contentType: httpMetadata instanceof Headers ? (httpMetadata.get("content-type") ?? undefined) : httpMetadata?.contentType
    });
    return {} as R2Object;
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
  }
}

class MockRepoSyncStub {
  claim: RepoSyncClaim = {
    status: "claimed",
    leaseId: "lease-1",
    leaseExpiresAt: Date.now() + 600_000,
    repositoryId: 42,
    ownerLogin: "octo",
    repoName: "articles",
    installationId: 123,
    targetBranch: "main",
    targetCommit: "new",
    lastSyncedCommit: "old",
    lastArticleIndex: []
  };
  completed?: { leaseId: string; result: RepoSyncCompleteResult };
  failed?: { leaseId: string; error: RepoSyncFailure };

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/claim") {
      return Response.json(this.claim);
    }
    if (path === "/complete") {
      this.completed = body;
      return Response.json({ completed: true });
    }
    if (path === "/fail") {
      this.failed = body;
      return Response.json({ failed: true });
    }
    if (path === "/extend-lease") {
      return Response.json({ extended: true, leaseExpiresAt: Date.now() + 600_000 });
    }
    return new Response("not found", { status: 404 });
  }
}

class MockDurableObjectNamespace {
  constructor(readonly stub = new MockRepoSyncStub()) {}

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  get(_id: DurableObjectId): DurableObjectStub {
    return this.stub as unknown as DurableObjectStub;
  }
}

function env(bucket = new MockR2Bucket(), namespace = new MockDurableObjectNamespace()): Env {
  return {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "unused",
    ARTICLES_BUCKET: bucket as unknown as R2Bucket,
    REPO_SYNC_STATE: namespace as unknown as DurableObjectNamespace
  };
}

function message(): RepoSyncQueueMessage {
  return {
    repositoryId: 42,
    ownerLogin: "octo",
    repoName: "articles",
    installationId: 123,
    targetBranch: "main"
  };
}

describe("article renderer", () => {
  beforeEach(() => {
    vi.mocked(github.createInstallationAccessToken).mockClear();
    vi.mocked(github.compareCommits).mockClear();
    vi.mocked(github.fetchMarkdownAtCommit).mockClear();
    vi.mocked(github.listArticleFilesAtCommit).mockClear();
  });

  it("uses GitHub compare to upsert and delete changed articles", async () => {
    const bucket = new MockR2Bucket();
    const stub = new MockRepoSyncStub();
    stub.claim.lastArticleIndex = [
      {
        date: "2026-05-01",
        slug: "removed",
        path: "articles/2026-05-01/removed/index.md",
        r2Key: "gh/octo/articles/2026-05-01/removed/index.html"
      }
    ];
    vi.mocked(github.compareCommits).mockResolvedValueOnce({
      ok: true,
      files: [
        { filename: "articles/2026-05-02/first/index.md", status: "added" },
        { filename: "articles/2026-05-01/removed/index.md", status: "removed" }
      ]
    });

    await syncRepositoryMessage(message(), env(bucket, new MockDurableObjectNamespace(stub)));

    expect(github.createInstallationAccessToken).toHaveBeenCalledWith(expect.objectContaining({ GITHUB_APP_ID: "1" }), 123);
    expect(github.compareCommits).toHaveBeenCalledWith("octo", "articles", "old", "new", "token");
    expect(bucket.deletes).toEqual(["gh/octo/articles/2026-05-01/removed/index.html"]);
    expect(bucket.puts).toEqual([
      {
        key: "gh/octo/articles/2026-05-02/first/index.html",
        value: '<h1 id="articles2026-05-02firstindexmd">articles/2026-05-02/first/index.md</h1>',
        contentType: "text/html; charset=utf-8"
      }
    ]);
    expect(stub.completed?.result).toEqual({
      syncedCommit: "new",
      articleIndex: [
        {
          date: "2026-05-02",
          slug: "first",
          path: "articles/2026-05-02/first/index.md",
          r2Key: "gh/octo/articles/2026-05-02/first/index.html"
        }
      ]
    });
  });

  it("falls back to full scan and deletes missing previous articles when compare is unavailable", async () => {
    const bucket = new MockR2Bucket();
    const stub = new MockRepoSyncStub();
    stub.claim.lastArticleIndex = [
      {
        date: "2026-05-01",
        slug: "removed",
        path: "articles/2026-05-01/removed/index.md",
        r2Key: "gh/octo/articles/2026-05-01/removed/index.html"
      }
    ];
    vi.mocked(github.compareCommits).mockResolvedValueOnce({ ok: false, files: [] });
    vi.mocked(github.listArticleFilesAtCommit).mockResolvedValueOnce([
      {
        date: "2026-05-03",
        slug: "latest",
        path: "articles/2026-05-03/latest/index.md"
      }
    ]);

    await syncRepositoryMessage(message(), env(bucket, new MockDurableObjectNamespace(stub)));

    expect(bucket.deletes).toEqual(["gh/octo/articles/2026-05-01/removed/index.html"]);
    expect(bucket.puts[0].key).toBe("gh/octo/articles/2026-05-03/latest/index.html");
    expect(stub.completed?.result.articleIndex).toEqual([
      {
        date: "2026-05-03",
        slug: "latest",
        path: "articles/2026-05-03/latest/index.md",
        r2Key: "gh/octo/articles/2026-05-03/latest/index.html"
      }
    ]);
  });

  it("reports failures to the repo sync state without completing the commit", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stub = new MockRepoSyncStub();
    const retry = vi.fn();
    vi.mocked(github.createInstallationAccessToken).mockRejectedValueOnce(new Error("token failed"));

    await worker.queue(
      { messages: [{ body: message(), retry }] } as unknown as MessageBatch<RepoSyncQueueMessage>,
      env(new MockR2Bucket(), new MockDurableObjectNamespace(stub))
    );

    expect(stub.completed).toBeUndefined();
    expect(stub.failed).toEqual({ leaseId: "lease-1", error: { message: "token failed" } });
    expect(retry).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("delays queue retry instead of failing the message when another lease is active", async () => {
    const stub = new MockRepoSyncStub();
    stub.claim = { status: "busy", retryAfterSeconds: 30 };
    const retry = vi.fn();

    await worker.queue(
      { messages: [{ body: message(), retry }] } as unknown as MessageBatch<RepoSyncQueueMessage>,
      env(new MockR2Bucket(), new MockDurableObjectNamespace(stub))
    );

    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(github.createInstallationAccessToken).not.toHaveBeenCalled();
  });
});
