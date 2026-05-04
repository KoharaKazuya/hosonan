import type {
  ArticlePath,
  RebuildRepositoryChunkQueueMessage,
  RepoSyncClaim,
  RepoSyncCompleteResult,
  RepoSyncFailure,
  RepoSyncQueueMessage,
  RepoSyncRepositoryQueueMessage
} from "@hosonan/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { rebuildRepositoryChunkMessage, rebuildRepositoryMessage, syncRepositoryMessage } from "../src/worker";

vi.mock("../src/github", () => ({
  createInstallationAccessToken: vi.fn(async () => "token"),
  compareCommits: vi.fn(async () => ({ ok: true, files: [] })),
  fetchDefaultBranchHead: vi.fn(async () => "head"),
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
    desiredState: "active",
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

class MockQueue {
  messages: RepoSyncQueueMessage[] = [];

  async send(message: RepoSyncQueueMessage): Promise<void> {
    this.messages.push(message);
  }
}

function env(
  bucket = new MockR2Bucket(),
  namespace = new MockDurableObjectNamespace(),
  queue = new MockQueue()
): Env {
  return {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "unused",
    ARTICLES_BUCKET: bucket as unknown as R2Bucket,
    REPO_SYNC_STATE: namespace as unknown as DurableObjectNamespace,
    ARTICLE_RENDER_QUEUE: queue as unknown as Queue
  };
}

function message(): RepoSyncRepositoryQueueMessage {
  return {
    repositoryId: 42,
    ownerLogin: "octo",
    repoName: "articles",
    installationId: 123,
    targetBranch: "main",
    desiredState: "active"
  };
}

function isRebuildRepositoryChunkMessage(message: RepoSyncQueueMessage): message is RebuildRepositoryChunkQueueMessage {
  return "type" in message && message.type === "rebuild_repository_chunk";
}

describe("article renderer", () => {
  beforeEach(() => {
    vi.mocked(github.createInstallationAccessToken).mockClear();
    vi.mocked(github.compareCommits).mockClear();
    vi.mocked(github.fetchDefaultBranchHead).mockClear();
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

  it("resolves default branch head before initial active sync without a target commit", async () => {
    const bucket = new MockR2Bucket();
    const stub = new MockRepoSyncStub();
    stub.claim.targetCommit = undefined;
    stub.claim.lastSyncedCommit = undefined;
    vi.mocked(github.listArticleFilesAtCommit).mockResolvedValueOnce([
      {
        date: "2026-05-03",
        slug: "latest",
        path: "articles/2026-05-03/latest/index.md"
      }
    ]);

    await syncRepositoryMessage(message(), env(bucket, new MockDurableObjectNamespace(stub)));

    expect(github.fetchDefaultBranchHead).toHaveBeenCalledWith("octo", "articles", "main", "token");
    expect(github.listArticleFilesAtCommit).toHaveBeenCalledWith("octo", "articles", "head", "token");
    expect(stub.completed?.result.syncedCommit).toBe("head");
    expect(bucket.puts[0].key).toBe("gh/octo/articles/2026-05-03/latest/index.html");
  });

  it("deletes previous R2 objects for inactive repositories without calling GitHub", async () => {
    const bucket = new MockR2Bucket();
    const stub = new MockRepoSyncStub();
    stub.claim.desiredState = "inactive";
    stub.claim.targetCommit = undefined;
    stub.claim.lastArticleIndex = [
      {
        date: "2026-05-01",
        slug: "old",
        path: "articles/2026-05-01/old/index.md",
        r2Key: "gh/octo/articles/2026-05-01/old/index.html"
      }
    ];

    await syncRepositoryMessage(message(), env(bucket, new MockDurableObjectNamespace(stub)));

    expect(github.createInstallationAccessToken).not.toHaveBeenCalled();
    expect(github.fetchDefaultBranchHead).not.toHaveBeenCalled();
    expect(bucket.deletes).toEqual(["gh/octo/articles/2026-05-01/old/index.html"]);
    expect(stub.completed?.result).toEqual({ syncedCommit: undefined, articleIndex: [] });
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

  it("enqueues rebuild repository chunks from the current default branch without touching R2 or sync state", async () => {
    const bucket = new MockR2Bucket();
    const stub = new MockRepoSyncStub();
    const queue = new MockQueue();
    vi.mocked(github.fetchDefaultBranchHead).mockResolvedValueOnce("fresh-head");
    vi.mocked(github.listArticleFilesAtCommit).mockResolvedValueOnce([
      {
        date: "2026-05-04",
        slug: "updated",
        path: "articles/2026-05-04/updated/index.md"
      }
    ]);

    await rebuildRepositoryMessage(
      {
        type: "rebuild_repository",
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main"
      },
      env(bucket, new MockDurableObjectNamespace(stub), queue)
    );

    expect(github.createInstallationAccessToken).toHaveBeenCalledWith(expect.objectContaining({ GITHUB_APP_ID: "1" }), 123);
    expect(github.fetchDefaultBranchHead).toHaveBeenCalledWith("octo", "articles", "main", "token");
    expect(github.listArticleFilesAtCommit).toHaveBeenCalledWith("octo", "articles", "fresh-head", "token");
    expect(bucket.puts).toEqual([]);
    expect(queue.messages).toEqual([
      {
        type: "rebuild_repository_chunk",
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main",
        targetCommit: "fresh-head",
        articles: [
          {
            date: "2026-05-04",
            slug: "updated",
            path: "articles/2026-05-04/updated/index.md"
          }
        ]
      }
    ]);
    expect(stub.completed).toBeUndefined();
    expect(stub.failed).toBeUndefined();
  });

  it("splits rebuild repository chunks into at most 100 articles", async () => {
    const queue = new MockQueue();
    const articles = Array.from({ length: 101 }, (_, index): ArticlePath => {
      const day = String((index % 28) + 1).padStart(2, "0");
      const slug = `article-${String(index + 1).padStart(3, "0")}`;
      return {
        date: `2026-05-${day}`,
        slug,
        path: `articles/2026-05-${day}/${slug}/index.md`
      };
    });
    vi.mocked(github.fetchDefaultBranchHead).mockResolvedValueOnce("fresh-head");
    vi.mocked(github.listArticleFilesAtCommit).mockResolvedValueOnce(articles);

    await rebuildRepositoryMessage(
      {
        type: "rebuild_repository",
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main"
      },
      env(new MockR2Bucket(), new MockDurableObjectNamespace(), queue)
    );

    expect(queue.messages).toHaveLength(2);
    expect(queue.messages.map((message) => (isRebuildRepositoryChunkMessage(message) ? message.articles.length : 0))).toEqual([100, 1]);
    expect(queue.messages.every((message) => isRebuildRepositoryChunkMessage(message) && message.targetCommit === "fresh-head")).toBe(true);
  });

  it("splits rebuild repository chunks below the queue message size limit", async () => {
    const queue = new MockQueue();
    const articles = Array.from({ length: 100 }, (_, index): ArticlePath => {
      const slug = `${String(index).padStart(3, "0")}-${"x".repeat(1600)}`;
      return {
        date: "2026-05-04",
        slug,
        path: `articles/2026-05-04/${slug}/index.md`
      };
    });
    vi.mocked(github.fetchDefaultBranchHead).mockResolvedValueOnce("fresh-head");
    vi.mocked(github.listArticleFilesAtCommit).mockResolvedValueOnce(articles);

    await rebuildRepositoryMessage(
      {
        type: "rebuild_repository",
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main"
      },
      env(new MockR2Bucket(), new MockDurableObjectNamespace(), queue)
    );

    expect(queue.messages.length).toBeGreaterThan(1);
    for (const message of queue.messages) {
      expect(isRebuildRepositoryChunkMessage(message)).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(128 * 1024);
    }
  });

  it("rebuilds only the articles in a repository chunk", async () => {
    const bucket = new MockR2Bucket();

    await rebuildRepositoryChunkMessage(
      {
        type: "rebuild_repository_chunk",
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main",
        targetCommit: "fixed-head",
        articles: [
          {
            date: "2026-05-04",
            slug: "updated",
            path: "articles/2026-05-04/updated/index.md"
          }
        ]
      },
      env(bucket)
    );

    expect(github.createInstallationAccessToken).toHaveBeenCalledWith(expect.objectContaining({ GITHUB_APP_ID: "1" }), 123);
    expect(github.fetchDefaultBranchHead).not.toHaveBeenCalled();
    expect(github.listArticleFilesAtCommit).not.toHaveBeenCalled();
    expect(github.fetchMarkdownAtCommit).toHaveBeenCalledWith(
      "octo",
      "articles",
      "articles/2026-05-04/updated/index.md",
      "fixed-head",
      "token"
    );
    expect(bucket.puts).toEqual([
      {
        key: "gh/octo/articles/2026-05-04/updated/index.html",
        value: '<h1 id="articles2026-05-04updatedindexmd">articles/2026-05-04/updated/index.md</h1>',
        contentType: "text/html; charset=utf-8"
      }
    ]);
  });
});
