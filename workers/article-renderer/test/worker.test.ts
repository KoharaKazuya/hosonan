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
  fetchChannelConfigAtCommit: vi.fn(async () => null),
  fetchDefaultBranchHead: vi.fn(async () => "head"),
  fetchFileMetadataAtCommit: vi.fn(async () => ({ size: 1024 })),
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

class MockD1PreparedStatement {
  values: unknown[] = [];

  constructor(
    private readonly db: MockD1Database,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): MockD1PreparedStatement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result> {
    return this.db.run(this.query, this.values);
  }
}

class MockD1Database {
  articles = new Map<string, Record<string, unknown>>();
  repositories = new Map<number, Record<string, unknown>>([[42, { repository_id: 42 }]]);

  prepare(query: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this, query);
  }

  async run(query: string, values: unknown[]): Promise<D1Result> {
    if (query.includes("INSERT INTO articles")) {
      this.articles.set(`${values[0]}:${values[3]}`, {
        repository_id: values[0],
        owner_login: values[1],
        repo_name: values[2],
        article_path: values[3],
        slug: values[4],
        title: values[5],
        created_at: values[6],
        canonical_path: values[7],
        r2_key: values[8],
        status: values[9],
        synced_commit: values[10],
        updated_at: values[11]
      });
    } else if (query.includes("UPDATE repositories")) {
      const row = this.repositories.get(Number(values[4])) ?? { repository_id: values[4] };
      row.channel_name = values[0];
      row.channel_icon_path = values[1];
      row.channel_biography = values[2];
      row.channel_updated_at = values[3];
      this.repositories.set(Number(values[4]), row);
    } else if (query.includes("WHERE repository_id = ? AND article_path = ?")) {
      const row = this.articles.get(`${values[2]}:${values[3]}`);
      if (row) {
        row.status = values[0];
        row.updated_at = values[1];
      }
    } else if (query.includes("WHERE repository_id = ?")) {
      for (const row of this.articles.values()) {
        if (row.repository_id === values[2]) {
          row.status = values[0];
          row.updated_at = values[1];
        }
      }
    }

    return {
      success: true,
      meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 1, last_row_id: 0, changed_db: true, changes: 1 },
      results: []
    };
  }
}

function env(
  bucket = new MockR2Bucket(),
  namespace = new MockDurableObjectNamespace(),
  queue = new MockQueue(),
  registry = new MockD1Database()
): Env {
  return {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "unused",
    ARTICLES_BUCKET: bucket as unknown as R2Bucket,
    REPO_SYNC_STATE: namespace as unknown as DurableObjectNamespace,
    ARTICLE_RENDER_QUEUE: queue as unknown as Queue,
    GITHUB_REGISTRY: registry as unknown as D1Database
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
    vi.mocked(github.fetchChannelConfigAtCommit).mockClear();
    vi.mocked(github.fetchChannelConfigAtCommit).mockResolvedValue(null);
    vi.mocked(github.fetchDefaultBranchHead).mockClear();
    vi.mocked(github.fetchFileMetadataAtCommit).mockClear();
    vi.mocked(github.fetchMarkdownAtCommit).mockClear();
    vi.mocked(github.listArticleFilesAtCommit).mockClear();
  });

  it("uses GitHub compare to upsert and delete changed articles", async () => {
    const bucket = new MockR2Bucket();
    const registry = new MockD1Database();
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

    await syncRepositoryMessage(message(), env(bucket, new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(github.createInstallationAccessToken).toHaveBeenCalledWith(expect.objectContaining({ GITHUB_APP_ID: "1" }), 123, 42);
    expect(github.compareCommits).toHaveBeenCalledWith("octo", "articles", "old", "new", "token");
    expect(github.fetchChannelConfigAtCommit).not.toHaveBeenCalled();
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
    expect(registry.articles.get("42:articles/2026-05-02/first/index.md")).toMatchObject({
      repository_id: 42,
      owner_login: "octo",
      repo_name: "articles",
      article_path: "articles/2026-05-02/first/index.md",
      slug: "first",
      title: "articles/2026-05-02/first/index.md",
      created_at: "2026-05-02",
      canonical_path: "/gh/octo/articles/2026-05-02/first/",
      r2_key: "gh/octo/articles/2026-05-02/first/index.html",
      status: "active",
      synced_commit: "new"
    });
    expect(Object.keys(registry.articles.get("42:articles/2026-05-02/first/index.md") ?? {})).not.toContain("thumbnail_path");
    expect(Object.keys(registry.articles.get("42:articles/2026-05-02/first/index.md") ?? {})).not.toContain("thumbnail_raw_url");
  });

  it("stores a GitHub fallback instead of fetching oversized Markdown during sync", async () => {
    const bucket = new MockR2Bucket();
    const stub = new MockRepoSyncStub();
    stub.claim.ownerLogin = "octo user";
    stub.claim.repoName = "article repo";
    stub.claim.targetCommit = "commit sha";
    vi.mocked(github.compareCommits).mockResolvedValueOnce({
      ok: true,
      files: [{ filename: "articles/2026-05-02/large article/index.md", status: "added" }]
    });
    vi.mocked(github.fetchFileMetadataAtCommit).mockResolvedValueOnce({ size: 1_048_577 });

    await syncRepositoryMessage(message(), env(bucket, new MockDurableObjectNamespace(stub)));

    expect(github.fetchFileMetadataAtCommit).toHaveBeenCalledWith(
      "octo user",
      "article repo",
      "articles/2026-05-02/large article/index.md",
      "commit sha",
      "token"
    );
    expect(github.fetchMarkdownAtCommit).not.toHaveBeenCalled();
    expect(bucket.puts).toEqual([
      {
        key: "gh/octo user/article repo/2026-05-02/large article/index.html",
        value:
          '<p>Markdown ファイルが 1 MiB を超えているため、このページでは本文を表示していません。</p>\n<p>元記事は <a href="https://github.com/octo%20user/article%20repo/blob/commit%20sha/articles/2026-05-02/large%20article/index.md" rel="noopener noreferrer">GitHub で確認</a> できます。</p>',
        contentType: "text/html; charset=utf-8"
      }
    ]);
    expect(stub.completed?.result.articleIndex).toEqual([
      {
        date: "2026-05-02",
        slug: "large article",
        path: "articles/2026-05-02/large article/index.md",
        r2Key: "gh/octo user/article repo/2026-05-02/large article/index.html"
      }
    ]);
  });

  it("extracts article titles from frontmatter before storing D1 article records", async () => {
    const registry = new MockD1Database();
    const stub = new MockRepoSyncStub();
    vi.mocked(github.compareCommits).mockResolvedValueOnce({
      ok: true,
      files: [{ filename: "articles/2026-05-02/titled/index.md", status: "added" }]
    });
    vi.mocked(github.fetchMarkdownAtCommit).mockResolvedValueOnce("---\ntitle: Stored title\n---\n# Rendered title");

    await syncRepositoryMessage(message(), env(new MockR2Bucket(), new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(registry.articles.get("42:articles/2026-05-02/titled/index.md")).toMatchObject({
      title: "Stored title",
      created_at: "2026-05-02",
      synced_commit: "new"
    });
  });

  it("stores frontmatter createdAt timestamps in D1 article records", async () => {
    const registry = new MockD1Database();
    const stub = new MockRepoSyncStub();
    vi.mocked(github.compareCommits).mockResolvedValueOnce({
      ok: true,
      files: [{ filename: "articles/2026-05-02/timed/index.md", status: "added" }]
    });
    vi.mocked(github.fetchMarkdownAtCommit).mockResolvedValueOnce(
      "---\ntitle: Timed title\ncreatedAt: 2026-05-02T23:45:01+09:00\n---\n# Rendered title"
    );

    await syncRepositoryMessage(message(), env(new MockR2Bucket(), new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(registry.articles.get("42:articles/2026-05-02/timed/index.md")).toMatchObject({
      title: "Timed title",
      created_at: "2026-05-02T14:45:01Z",
      synced_commit: "new"
    });
  });

  it("stores channel config from hosonan.json when the config file changes during active sync", async () => {
    const registry = new MockD1Database();
    const stub = new MockRepoSyncStub();
    vi.mocked(github.fetchChannelConfigAtCommit).mockResolvedValueOnce(
      JSON.stringify({ name: "  Octo Channel  ", icon: "assets/channel.webp", biography: "  Articles from Octo  " })
    );
    vi.mocked(github.compareCommits).mockResolvedValueOnce({ ok: true, files: [{ filename: "hosonan.json", status: "modified" }] });

    await syncRepositoryMessage(message(), env(new MockR2Bucket(), new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(github.fetchChannelConfigAtCommit).toHaveBeenCalledWith("octo", "articles", "new", "token");
    expect(registry.repositories.get(42)).toMatchObject({
      channel_name: "Octo Channel",
      channel_icon_path: "assets/channel.webp",
      channel_biography: "Articles from Octo"
    });
    expect(typeof registry.repositories.get(42)?.channel_updated_at).toBe("string");
  });

  it("clears channel config when changed hosonan.json is absent during active sync", async () => {
    const registry = new MockD1Database();
    const stub = new MockRepoSyncStub();
    registry.repositories.set(42, {
      repository_id: 42,
      channel_name: "Old",
      channel_icon_path: "old.webp",
      channel_biography: "Old bio"
    });
    vi.mocked(github.fetchChannelConfigAtCommit).mockResolvedValueOnce(null);
    vi.mocked(github.compareCommits).mockResolvedValueOnce({ ok: true, files: [{ filename: "hosonan.json", status: "removed" }] });

    await syncRepositoryMessage(message(), env(new MockR2Bucket(), new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(registry.repositories.get(42)).toMatchObject({
      channel_name: null,
      channel_icon_path: null,
      channel_biography: null
    });
  });

  it("ignores malformed changed channel config fields without failing article sync", async () => {
    const registry = new MockD1Database();
    const stub = new MockRepoSyncStub();
    vi.mocked(github.fetchChannelConfigAtCommit).mockResolvedValueOnce(
      JSON.stringify({ name: "Valid", icon: "https://example.com/icon.webp", biography: 12 })
    );
    vi.mocked(github.compareCommits).mockResolvedValueOnce({
      ok: true,
      files: [
        { filename: "hosonan.json", status: "modified" },
        { filename: "articles/2026-05-02/first/index.md", status: "added" }
      ]
    });

    await syncRepositoryMessage(message(), env(new MockR2Bucket(), new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(registry.repositories.get(42)).toMatchObject({
      channel_name: "Valid",
      channel_icon_path: null,
      channel_biography: null
    });
    expect(registry.articles.get("42:articles/2026-05-02/first/index.md")).toMatchObject({ status: "active" });
  });

  it("does not fetch channel config when compare shows only article changes", async () => {
    const registry = new MockD1Database();
    const stub = new MockRepoSyncStub();
    registry.repositories.set(42, {
      repository_id: 42,
      channel_name: "Existing",
      channel_icon_path: "existing.webp",
      channel_biography: "Existing bio"
    });
    vi.mocked(github.compareCommits).mockResolvedValueOnce({
      ok: true,
      files: [{ filename: "articles/2026-05-02/first/index.md", status: "added" }]
    });

    await syncRepositoryMessage(message(), env(new MockR2Bucket(), new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(github.fetchChannelConfigAtCommit).not.toHaveBeenCalled();
    expect(registry.repositories.get(42)).toMatchObject({
      channel_name: "Existing",
      channel_icon_path: "existing.webp",
      channel_biography: "Existing bio"
    });
    expect(registry.articles.get("42:articles/2026-05-02/first/index.md")).toMatchObject({ status: "active" });
  });

  it("truncates long frontmatter titles before storing D1 article records", async () => {
    const registry = new MockD1Database();
    const stub = new MockRepoSyncStub();
    const longTitle = "  " + "a".repeat(201) + "  ";
    vi.mocked(github.compareCommits).mockResolvedValueOnce({
      ok: true,
      files: [{ filename: "articles/2026-05-02/long-title/index.md", status: "added" }]
    });
    vi.mocked(github.fetchMarkdownAtCommit).mockResolvedValueOnce(`---\ntitle: "${longTitle}"\n---\n# Rendered title`);

    await syncRepositoryMessage(message(), env(new MockR2Bucket(), new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(registry.articles.get("42:articles/2026-05-02/long-title/index.md")).toMatchObject({
      title: "a".repeat(200)
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

    expect(github.fetchChannelConfigAtCommit).toHaveBeenCalledWith("octo", "articles", "new", "token");
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
    expect(github.fetchChannelConfigAtCommit).toHaveBeenCalledWith("octo", "articles", "head", "token");
    expect(github.listArticleFilesAtCommit).toHaveBeenCalledWith("octo", "articles", "head", "token");
    expect(stub.completed?.result.syncedCommit).toBe("head");
    expect(bucket.puts[0].key).toBe("gh/octo/articles/2026-05-03/latest/index.html");
  });

  it("keeps previous R2 objects and article records for inactive repositories without calling GitHub", async () => {
    const bucket = new MockR2Bucket();
    const registry = new MockD1Database();
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

    registry.articles.set("42:articles/2026-05-01/old/index.md", {
      repository_id: 42,
      article_path: "articles/2026-05-01/old/index.md",
      status: "active"
    });

    await syncRepositoryMessage(message(), env(bucket, new MockDurableObjectNamespace(stub), new MockQueue(), registry));

    expect(github.createInstallationAccessToken).not.toHaveBeenCalled();
    expect(github.fetchDefaultBranchHead).not.toHaveBeenCalled();
    expect(bucket.deletes).toEqual([]);
    expect(stub.completed?.result).toEqual({
      syncedCommit: "old",
      articleIndex: [
        {
          date: "2026-05-01",
          slug: "old",
          path: "articles/2026-05-01/old/index.md",
          r2Key: "gh/octo/articles/2026-05-01/old/index.html"
        }
      ]
    });
    expect(registry.articles.get("42:articles/2026-05-01/old/index.md")?.status).toBe("active");
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

    expect(github.createInstallationAccessToken).toHaveBeenCalledWith(expect.objectContaining({ GITHUB_APP_ID: "1" }), 123, 42);
    expect(github.fetchDefaultBranchHead).toHaveBeenCalledWith("octo", "articles", "main", "token");
    expect(github.fetchChannelConfigAtCommit).toHaveBeenCalledWith("octo", "articles", "fresh-head", "token");
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

  it("updates channel config during rebuild repository before enqueueing chunks", async () => {
    const registry = new MockD1Database();
    vi.mocked(github.fetchDefaultBranchHead).mockResolvedValueOnce("fresh-head");
    vi.mocked(github.fetchChannelConfigAtCommit).mockResolvedValueOnce(JSON.stringify({ name: "Rebuilt", icon: "icon.webp" }));
    vi.mocked(github.listArticleFilesAtCommit).mockResolvedValueOnce([]);

    await rebuildRepositoryMessage(
      {
        type: "rebuild_repository",
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main"
      },
      env(new MockR2Bucket(), new MockDurableObjectNamespace(), new MockQueue(), registry)
    );

    expect(registry.repositories.get(42)).toMatchObject({
      channel_name: "Rebuilt",
      channel_icon_path: "icon.webp",
      channel_biography: null
    });
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

    expect(github.createInstallationAccessToken).toHaveBeenCalledWith(expect.objectContaining({ GITHUB_APP_ID: "1" }), 123, 42);
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

  it("keeps oversized articles in rebuild chunk results", async () => {
    const bucket = new MockR2Bucket();
    vi.mocked(github.fetchFileMetadataAtCommit).mockResolvedValueOnce({ size: 1_048_577 });

    const result = await rebuildRepositoryChunkMessage(
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
            slug: "large",
            path: "articles/2026-05-04/large/index.md"
          }
        ]
      },
      env(bucket)
    );

    expect(github.fetchMarkdownAtCommit).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        date: "2026-05-04",
        slug: "large",
        path: "articles/2026-05-04/large/index.md",
        r2Key: "gh/octo/articles/2026-05-04/large/index.html"
      }
    ]);
    expect(bucket.puts[0].value).toContain("Markdown ファイルが 1 MiB を超えているため、このページでは本文を表示していません。");
    expect(bucket.puts[0].value).toContain("https://github.com/octo/articles/blob/fixed-head/articles/2026-05-04/large/index.md");
  });

  it("truncates oversized article slug titles in rebuild chunk records", async () => {
    const registry = new MockD1Database();
    const slug = "s".repeat(201);
    vi.mocked(github.fetchFileMetadataAtCommit).mockResolvedValueOnce({ size: 1_048_577 });

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
            slug,
            path: `articles/2026-05-04/${slug}/index.md`
          }
        ]
      },
      env(new MockR2Bucket(), new MockDurableObjectNamespace(), new MockQueue(), registry)
    );

    expect(registry.articles.get(`42:articles/2026-05-04/${slug}/index.md`)).toMatchObject({
      title: "s".repeat(200)
    });
  });
});
