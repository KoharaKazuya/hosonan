import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { Env } from "../src/types";

class MockR2Bucket {
  gets: string[] = [];

  constructor(private readonly objects: Map<string, string> = new Map()) {}

  async get(key: string): Promise<R2ObjectBody | null> {
    this.gets.push(key);
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }

    return {
      text: async () => value
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

function env(bucket: MockR2Bucket): Env {
  return {
    ARTICLES_BUCKET: bucket as unknown as R2Bucket
  };
}

function request(path: string, method = "GET"): Request {
  return new Request(`https://articles.example${path}`, { method });
}

describe("site worker", () => {
  let cache: MockCache;

  beforeEach(() => {
    cache = new MockCache();
    vi.stubGlobal("caches", { default: cache });
  });

  it("returns a complete HTML document for stored article fragments", async () => {
    const bucket = new MockR2Bucket(new Map([["gh/octo/2026-05-02/example/index.html", "<h1>Hello</h1>"]]));
    const response = await worker.fetch(request("/gh/octo/2026-05-02/example/"), env(bucket));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    await expect(response.text()).resolves.toContain("<!doctype html>");
    expect(bucket.gets).toEqual(["gh/octo/2026-05-02/example/index.html"]);
  });

  it("normalizes directory and index URLs to the same R2 key and cache key", async () => {
    const bucket = new MockR2Bucket(new Map([["gh/octo/2026-05-02/example/index.html", "<p>cached</p>"]]));

    const first = await worker.fetch(request("/gh/octo/2026-05-02/example/index.html"), env(bucket));
    const second = await worker.fetch(request("/gh/octo/2026-05-02/example/"), env(bucket));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(bucket.gets).toEqual(["gh/octo/2026-05-02/example/index.html"]);
    expect(cache.keys).toEqual([
      "https://articles.example/gh/octo/2026-05-02/example/",
      "https://articles.example/gh/octo/2026-05-02/example/"
    ]);
  });

  it("does not fetch R2 again on cache hit", async () => {
    const bucket = new MockR2Bucket(new Map([["gh/octo/2026-05-02/example/index.html", "<p>cached</p>"]]));

    await worker.fetch(request("/gh/octo/2026-05-02/example/"), env(bucket));
    const response = await worker.fetch(request("/gh/octo/2026-05-02/example/"), env(bucket));

    expect(response.status).toBe(200);
    expect(bucket.gets).toHaveLength(1);
  });

  it("returns 404 when the R2 object does not exist", async () => {
    const response = await worker.fetch(request("/gh/octo/2026-05-02/missing/"), env(new MockR2Bucket()));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not found\n");
  });

  it("returns 405 for unsupported methods", async () => {
    const response = await worker.fetch(request("/gh/octo/2026-05-02/example/", "POST"), env(new MockR2Bucket()));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns 404 for invalid URLs", async () => {
    const response = await worker.fetch(request("/gh/octo/20260502/example/"), env(new MockR2Bucket()));

    expect(response.status).toBe(404);
  });

  it("supports HEAD without a response body", async () => {
    const bucket = new MockR2Bucket(new Map([["gh/octo/2026-05-02/example/index.html", "<p>head</p>"]]));
    const response = await worker.fetch(request("/gh/octo/2026-05-02/example/", "HEAD"), env(bucket));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
    expect(bucket.gets).toEqual(["gh/octo/2026-05-02/example/index.html"]);
  });
});
