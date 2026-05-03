import { describe, expect, it } from "vitest";
import worker from "../src/worker";
import type { Env } from "../src/types";

class MockService {
  readonly requests: Request[] = [];

  constructor(private readonly body: string) {}

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    return new Response(this.body);
  }
}

function request(path: string): Request {
  return new Request(`https://hosonan.koharakazuya.workers.dev${path}`);
}

function env(siteWorker = new MockService("site\n"), articleWorker = new MockService("article\n")): Env {
  return {
    SITE_WORKER: siteWorker as unknown as Fetcher,
    ARTICLE_WORKER: articleWorker as unknown as Fetcher
  };
}

describe("router worker", () => {
  it("delegates article paths to the site worker", async () => {
    const siteWorker = new MockService("site\n");
    const articleWorker = new MockService("article\n");

    const response = await worker.fetch(
      request("/gh/octo/2026-05-02/example/"),
      env(siteWorker, articleWorker)
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("site\n");
    expect(siteWorker.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/gh/octo/2026-05-02/example/"
    ]);
    expect(articleWorker.requests).toHaveLength(0);
  });

  it("delegates root and unknown non-api paths to the site worker", async () => {
    const siteWorker = new MockService("site\n");
    const articleWorker = new MockService("article\n");
    const routerEnv = env(siteWorker, articleWorker);

    await worker.fetch(request("/"), routerEnv);
    await worker.fetch(request("/unknown/path"), routerEnv);

    expect(siteWorker.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/",
      "/unknown/path"
    ]);
    expect(articleWorker.requests).toHaveLength(0);
  });

  it("delegates the GitHub webhook path to the article worker", async () => {
    const siteWorker = new MockService("site\n");
    const articleWorker = new MockService("article\n");

    const response = await worker.fetch(request("/api/github/webhook"), env(siteWorker, articleWorker));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("article\n");
    expect(articleWorker.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/api/github/webhook"
    ]);
    expect(siteWorker.requests).toHaveLength(0);
  });

  it("treats the trailing-slash GitHub webhook path as the webhook", async () => {
    const siteWorker = new MockService("site\n");
    const articleWorker = new MockService("article\n");

    const response = await worker.fetch(request("/api/github/webhook/"), env(siteWorker, articleWorker));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("article\n");
    expect(articleWorker.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/api/github/webhook/"
    ]);
    expect(siteWorker.requests).toHaveLength(0);
  });

  it("returns 404 for undefined api paths", async () => {
    const siteWorker = new MockService("site\n");
    const articleWorker = new MockService("article\n");

    const response = await worker.fetch(request("/api/unknown"), env(siteWorker, articleWorker));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await expect(response.text()).resolves.toBe("not found\n");
    expect(siteWorker.requests).toHaveLength(0);
    expect(articleWorker.requests).toHaveLength(0);
  });

  it("reserves the api root and returns 404", async () => {
    const siteWorker = new MockService("site\n");
    const articleWorker = new MockService("article\n");

    const response = await worker.fetch(request("/api"), env(siteWorker, articleWorker));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not found\n");
    expect(siteWorker.requests).toHaveLength(0);
    expect(articleWorker.requests).toHaveLength(0);
  });
});
