import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";

class MockR2Bucket {
  gets: string[] = [];

  constructor(private readonly objects: Map<string, string | string[]> = new Map()) {}

  async get(key: string): Promise<R2ObjectBody | null> {
    this.gets.push(key);
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }

    return {
      body: streamFromChunks(Array.isArray(value) ? value : [value])
    } as R2ObjectBody;
  }
}

class MockCache {
  readonly keys: string[] = [];
  private readonly responses = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    this.keys.push(request.url);
    return this.responses.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.responses.set(request.url, response.clone());
  }
}

class MockD1PreparedStatement {
  values: unknown[] = [];

  constructor(private readonly db: MockD1Database) {}

  bind(...values: unknown[]): MockD1PreparedStatement {
    this.values = values;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return {
      success: true,
      meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 },
      results: this.db.select(Number(this.values[0])) as T[]
    };
  }
}

class MockD1Database {
  constructor(readonly articles: Array<Record<string, unknown>> = []) {}

  prepare(_query: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this);
  }

  select(limit: number): Array<Record<string, unknown>> {
    return this.articles
      .filter((article) => article.status === "active")
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, limit);
  }
}

function env(bucket: { get(key: string): Promise<R2ObjectBody | null> }, registry = new MockD1Database()): Env {
  return {
    ARTICLES_BUCKET: bucket as unknown as R2Bucket,
    GITHUB_REGISTRY: registry as unknown as D1Database
  };
}

function request(path: string, method = "GET"): Request {
  return new Request(`https://articles.example${path}`, { method });
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

function article(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository_id: 42,
    owner_login: "octo",
    repo_name: "articles",
    article_path: "articles/2026-05-02/example/index.md",
    slug: "example",
    title: "Example",
    created_at: "2026-05-02",
    canonical_path: "/gh/octo/articles/2026-05-02/example/",
    r2_key: "gh/octo/articles/2026-05-02/example/index.html",
    status: "active",
    synced_commit: "abc123",
    updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides
  };
}

describe("site worker", () => {
  let cache: MockCache;

  beforeEach(() => {
    cache = new MockCache();
    vi.stubGlobal("caches", { default: cache });
  });

  it("returns the home page with at most 10 active article cards ordered by latest date", async () => {
    const articles = Array.from({ length: 12 }, (_, index) =>
      article({
        repository_id: index,
        article_path: `articles/2026-05-${String(index + 1).padStart(2, "0")}/post-${index}/index.md`,
        slug: `post-${index}`,
        title: `Post ${index}`,
        created_at: `2026-05-${String(index + 1).padStart(2, "0")}`,
        canonical_path: `/gh/octo/articles/2026-05-${String(index + 1).padStart(2, "0")}/post-${index}/`,
        r2_key: `gh/octo/articles/2026-05-${String(index + 1).padStart(2, "0")}/post-${index}/index.html`,
        synced_commit: `commit-${index}`
      })
    );
    articles.push(article({ title: "Inactive", status: "inactive", created_at: "2026-06-01" }));

    const response = await worker.fetch(request("/"), env(new MockR2Bucket(), new MockD1Database(articles)));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.match(/class="article-card"/g)).toHaveLength(10);
    expect(html.indexOf("Post 11")).toBeLessThan(html.indexOf("Post 10"));
    expect(html).toContain('<a class="article-card" href="/gh/octo/articles/2026-05-12/post-11/">');
    expect(html).toContain("/*! kiso.css v1.2.4 | MIT License | https://github.com/tak-dcxi/kiso.css */");
    expect(html).toContain('<span class="article-thumb-frame">');
    expect(html).toContain('<span class="article-thumb-fallback" aria-hidden="true">');
    expect(html).toContain('<span class="article-thumb-fallback-loading">読み込み中</span>');
    expect(html).toContain('<span class="article-thumb-fallback-error">画像なし</span>');
    expect(html).toContain('src="https://raw.githubusercontent.com/octo/articles/commit-11/articles/2026-05-12/post-11/thumbnail.webp"');
    expect(html).toContain(
      `onerror="this.closest('.article-thumb-frame').classList.add('is-error');this.hidden=true"`
    );
    expect(html).toContain("<h2>Post 11</h2>");
    expect(html).toContain("-webkit-line-clamp:3");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain('<time datetime="2026-05-12">2026-05-12</time>');
    expect(html).toContain('<span class="channel-placeholder" aria-hidden="true">O</span>');
    expect(html).toContain('<span class="channel-name">octo/articles</span>');
    expect(html).not.toContain("Inactive");
  });

  it("renders channel name and repository icon on home article cards", async () => {
    const response = await worker.fetch(
      request("/"),
      env(
        new MockR2Bucket(),
        new MockD1Database([
          article({
            channel_name: "Octo & Friends",
            channel_icon_path: "images/channel icon.webp",
            channel_biography: "Not rendered"
          })
        ])
      )
    );
    const html = await response.text();

    expect(html).toContain('<span class="channel-name">Octo &amp; Friends</span>');
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/octo/articles/abc123/images/channel%20icon.webp"'
    );
    expect(html).not.toContain("Not rendered");
  });

  it("escapes channel fallback text and encodes raw icon URLs", async () => {
    const response = await worker.fetch(
      request("/"),
      env(
        new MockR2Bucket(),
        new MockD1Database([
          article({
            owner_login: "octo user",
            repo_name: "article repo",
            synced_commit: "commit sha",
            channel_name: "<Channel>",
            channel_icon_path: "assets/icon & avatar.webp"
          })
        ])
      )
    );
    const html = await response.text();

    expect(html).toContain('<span class="channel-name">&lt;Channel&gt;</span>');
    expect(html).toContain(
      'src="https://raw.githubusercontent.com/octo%20user/article%20repo/commit%20sha/assets/icon%20%26%20avatar.webp"'
    );
  });

  it("falls back to a placeholder when the stored channel icon path is unsafe", async () => {
    const response = await worker.fetch(
      request("/"),
      env(new MockR2Bucket(), new MockD1Database([article({ channel_name: "Unsafe", channel_icon_path: "https://example.com/icon.webp" })]))
    );
    const html = await response.text();

    expect(html).toContain('<span class="channel-placeholder" aria-hidden="true">U</span>');
    expect(html).not.toContain("https://example.com/icon.webp");
  });

  it("supports HEAD for the home page without a response body", async () => {
    const response = await worker.fetch(request("/", "HEAD"), env(new MockR2Bucket(), new MockD1Database([article()])));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });

  it("returns a complete HTML document for stored article fragments", async () => {
    const bucket = new MockR2Bucket(new Map([["gh/octo/articles/2026-05-02/example/index.html", "<h1>Hello</h1>"]]));
    const response = await worker.fetch(request("/gh/octo/articles/2026-05-02/example/"), env(bucket));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    await expect(response.text()).resolves.toContain("<!doctype html>");
    expect(bucket.gets).toEqual(["gh/octo/articles/2026-05-02/example/index.html"]);
  });

  it("streams prefix, chunked R2 body, and suffix in order", async () => {
    const bucket = new MockR2Bucket(
      new Map([["gh/octo/articles/2026-05-02/example/index.html", ["<h1>Hel", "lo</h1>", "<p>body</p>"]]])
    );
    const response = await worker.fetch(request("/gh/octo/articles/2026-05-02/example/"), env(bucket));
    const html = await response.text();

    expect(html).toContain("/*! kiso.css v1.2.4 | MIT License | https://github.com/tak-dcxi/kiso.css */");
    expect(html).toContain(".article :where(ul,ol){padding-inline-start:1.5em;list-style:revert}");
    expect(html).toMatch(/<main class="article">\n<h1>Hello<\/h1><p>body<\/p>\n<\/main>/);
  });

  it("normalizes directory and index URLs to the same R2 key and cache key", async () => {
    const bucket = new MockR2Bucket(new Map([["gh/octo/articles/2026-05-02/example/index.html", "<p>cached</p>"]]));

    const first = await worker.fetch(request("/gh/octo/articles/2026-05-02/example/index.html"), env(bucket));
    const second = await worker.fetch(request("/gh/octo/articles/2026-05-02/example/"), env(bucket));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(bucket.gets).toEqual(["gh/octo/articles/2026-05-02/example/index.html"]);
    expect(cache.keys).toEqual([
      "https://articles.example/gh/octo/articles/2026-05-02/example/",
      "https://articles.example/gh/octo/articles/2026-05-02/example/"
    ]);
  });

  it("does not fetch R2 again on cache hit", async () => {
    const bucket = new MockR2Bucket(new Map([["gh/octo/articles/2026-05-02/example/index.html", "<p>cached</p>"]]));

    await worker.fetch(request("/gh/octo/articles/2026-05-02/example/"), env(bucket));
    const response = await worker.fetch(request("/gh/octo/articles/2026-05-02/example/"), env(bucket));

    expect(response.status).toBe(200);
    expect(bucket.gets).toHaveLength(1);
  });

  it("returns 404 when the R2 object does not exist", async () => {
    const response = await worker.fetch(request("/gh/octo/articles/2026-05-02/missing/"), env(new MockR2Bucket()));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not found\n");
  });

  it("returns 500 when the R2 object has no readable body", async () => {
    const bucket = {
      async get() {
        return {} as R2ObjectBody;
      }
    };

    const response = await worker.fetch(request("/gh/octo/articles/2026-05-02/example/"), env(bucket));

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("article body unavailable\n");
  });

  it("returns 405 for unsupported methods", async () => {
    const response = await worker.fetch(request("/gh/octo/articles/2026-05-02/example/", "POST"), env(new MockR2Bucket()));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns 404 for invalid URLs", async () => {
    const response = await worker.fetch(request("/gh/octo/articles/20260502/example/"), env(new MockR2Bucket()));

    expect(response.status).toBe(404);
  });

  it("supports HEAD without a response body", async () => {
    const bucket = new MockR2Bucket(new Map([["gh/octo/articles/2026-05-02/example/index.html", "<p>head</p>"]]));
    const response = await worker.fetch(request("/gh/octo/articles/2026-05-02/example/", "HEAD"), env(bucket));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
    expect(bucket.gets).toEqual(["gh/octo/articles/2026-05-02/example/index.html"]);
  });
});
