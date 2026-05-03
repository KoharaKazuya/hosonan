import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { GitHubPushPayload } from "../src/types";

vi.mock("../src/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github")>();
  return {
    ...actual,
    createInstallationAccessToken: vi.fn(async () => "token"),
    fetchMarkdownAtCommit: vi.fn(async () => "# Article")
  };
});

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

function env(bucket = new MockR2Bucket()): Env {
  return {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "unused",
    WEBHOOK_SECRET: "secret",
    ARTICLES_BUCKET: bucket as unknown as R2Bucket
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

type PushCommit = NonNullable<GitHubPushPayload["commits"]>[number];

function pushPayload(commit: Partial<PushCommit>): GitHubPushPayload {
  return {
    repository: {
      owner: { login: "octo" },
      name: "articles",
      full_name: "octo/articles"
    },
    installation: { id: 123 },
    commits: [
      {
        id: "abc123",
        added: [],
        modified: [],
        removed: [],
        ...commit
      }
    ]
  };
}

describe("worker webhook", () => {
  beforeEach(() => {
    vi.mocked(github.createInstallationAccessToken).mockClear();
    vi.mocked(github.fetchMarkdownAtCommit).mockClear();
  });

  it("returns 401 for invalid signatures", async () => {
    const payload = pushPayload({ added: ["articles/2026-05-02/test/index.md"] });
    const response = await worker.fetch(await request(payload, "push", "wrong"), env());

    expect(response.status).toBe(401);
  });

  it("ignores non-push events", async () => {
    const bucket = new MockR2Bucket();
    const response = await worker.fetch(await request(pushPayload({}), "ping"), env(bucket));

    expect(response.status).toBe(202);
    expect(bucket.puts).toHaveLength(0);
    expect(bucket.deletes).toHaveLength(0);
  });

  it("puts added and modified article Markdown into R2", async () => {
    const bucket = new MockR2Bucket();
    const response = await worker.fetch(
      await request(
        pushPayload({
          added: ["articles/2026-05-02/first/index.md"],
          modified: ["articles/2026-05-03/second/index.md"]
        })
      ),
      env(bucket)
    );

    expect(response.status).toBe(200);
    expect(bucket.puts).toEqual([
      {
        key: "gh/octo/2026-05-02/first/index.html",
        value: '<h1 id="article">Article</h1>',
        contentType: "text/html; charset=utf-8"
      },
      {
        key: "gh/octo/2026-05-03/second/index.html",
        value: '<h1 id="article">Article</h1>',
        contentType: "text/html; charset=utf-8"
      }
    ]);
    expect(github.fetchMarkdownAtCommit).toHaveBeenCalledWith(
      "octo",
      "articles",
      "articles/2026-05-02/first/index.md",
      "abc123",
      "token"
    );
  });

  it("deletes removed article Markdown from R2", async () => {
    const bucket = new MockR2Bucket();
    const response = await worker.fetch(
      await request(pushPayload({ removed: ["articles/2026-05-02/first/index.md"] })),
      env(bucket)
    );

    expect(response.status).toBe(200);
    expect(bucket.deletes).toEqual(["gh/octo/2026-05-02/first/index.html"]);
    expect(github.createInstallationAccessToken).not.toHaveBeenCalled();
  });

  it("does not update R2 for non-target files", async () => {
    const bucket = new MockR2Bucket();
    const response = await worker.fetch(
      await request(
        pushPayload({
          added: ["articles/2026-05-02/first/index.html", "articles/2026-05-02/first/thumbnail.webp"]
        })
      ),
      env(bucket)
    );

    expect(response.status).toBe(200);
    expect(bucket.puts).toHaveLength(0);
    expect(bucket.deletes).toHaveLength(0);
    expect(github.createInstallationAccessToken).not.toHaveBeenCalled();
  });
});
