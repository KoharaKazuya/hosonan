import { describe, expect, it } from "vitest";
import worker from "../src/worker";

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

function env(web = new MockService("web\n"), githubWebhook = new MockService("webhook\n")): Env {
  return {
    WEB: web as unknown as Fetcher,
    GITHUB_WEBHOOK: githubWebhook as unknown as Fetcher
  };
}

describe("router worker", () => {
  it("delegates article paths to the web worker", async () => {
    const web = new MockService("web\n");
    const githubWebhook = new MockService("webhook\n");

    const response = await worker.fetch(
      request("/gh/octo/2026-05-02/example/"),
      env(web, githubWebhook)
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("web\n");
    expect(web.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/gh/octo/2026-05-02/example/"
    ]);
    expect(githubWebhook.requests).toHaveLength(0);
  });

  it("delegates root and unknown non-api paths to the web worker", async () => {
    const web = new MockService("web\n");
    const githubWebhook = new MockService("webhook\n");
    const routerEnv = env(web, githubWebhook);

    await worker.fetch(request("/"), routerEnv);
    await worker.fetch(request("/unknown/path"), routerEnv);

    expect(web.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/",
      "/unknown/path"
    ]);
    expect(githubWebhook.requests).toHaveLength(0);
  });

  it("delegates the GitHub webhook path to the github-webhook worker", async () => {
    const web = new MockService("web\n");
    const githubWebhook = new MockService("webhook\n");

    const response = await worker.fetch(request("/api/github/webhook"), env(web, githubWebhook));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("webhook\n");
    expect(githubWebhook.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/api/github/webhook"
    ]);
    expect(web.requests).toHaveLength(0);
  });

  it("delegates auth api paths to the web worker", async () => {
    const web = new MockService("web\n");
    const githubWebhook = new MockService("webhook\n");
    const routerEnv = env(web, githubWebhook);

    await worker.fetch(request("/api/auth/me"), routerEnv);
    await worker.fetch(request("/api/auth/github/callback"), routerEnv);

    expect(web.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/api/auth/me",
      "/api/auth/github/callback"
    ]);
    expect(githubWebhook.requests).toHaveLength(0);
  });

  it("treats the trailing-slash GitHub webhook path as the webhook", async () => {
    const web = new MockService("web\n");
    const githubWebhook = new MockService("webhook\n");

    const response = await worker.fetch(request("/api/github/webhook/"), env(web, githubWebhook));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("webhook\n");
    expect(githubWebhook.requests.map((sentRequest) => new URL(sentRequest.url).pathname)).toEqual([
      "/api/github/webhook/"
    ]);
    expect(web.requests).toHaveLength(0);
  });

  it("returns 404 for undefined api paths", async () => {
    const web = new MockService("web\n");
    const githubWebhook = new MockService("webhook\n");

    const response = await worker.fetch(request("/api/unknown"), env(web, githubWebhook));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await expect(response.text()).resolves.toBe("not found\n");
    expect(web.requests).toHaveLength(0);
    expect(githubWebhook.requests).toHaveLength(0);
  });

  it("reserves the api root and returns 404", async () => {
    const web = new MockService("web\n");
    const githubWebhook = new MockService("webhook\n");

    const response = await worker.fetch(request("/api"), env(web, githubWebhook));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not found\n");
    expect(web.requests).toHaveLength(0);
    expect(githubWebhook.requests).toHaveLength(0);
  });
});
