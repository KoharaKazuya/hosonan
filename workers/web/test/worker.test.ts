import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: "login-challenge", rpId: "articles.example" })),
  generateRegistrationOptions: vi.fn(async () => ({
    challenge: "register-challenge",
    rp: { name: "Hosonan", id: "articles.example" },
    user: { id: "user-id", name: "Hosonan user", displayName: "Hosonan user" },
    pubKeyCredParams: []
  })),
  verifyAuthenticationResponse: vi.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 7 }
  })),
  verifyRegistrationResponse: vi.fn(async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: "credential-id",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 3,
        transports: ["internal"]
      },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true
    }
  }))
}));

import worker from "../src/worker";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";

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

  constructor(private readonly db: MockD1Database, private readonly query: string) {}

  bind(...values: unknown[]): MockD1PreparedStatement {
    this.values = values;
    return this;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (this.query.includes("FROM passkey_credentials WHERE user_id = ?")) {
      return this.db.result(this.db.passkeyCredentials.filter((credential) => credential.user_id === this.values[0]) as T[]);
    }

    return {
      success: true,
      meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 },
      results: this.db.select(Number(this.values[0])) as T[]
    };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.db.first(this.query, this.values) as T | null;
  }

  async run(): Promise<D1Result> {
    return this.db.run(this.query, this.values);
  }
}

class MockD1Database {
  readonly users: Array<Record<string, unknown>> = [];
  readonly identities: Array<Record<string, unknown>> = [];
  readonly challenges: Array<Record<string, unknown>> = [];
  readonly sessions: Array<Record<string, unknown>> = [];
  readonly passkeyCredentials: Array<Record<string, unknown>> = [];

  constructor(readonly articles: Array<Record<string, unknown>> = []) {}

  prepare(query: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this, query);
  }

  select(limit: number): Array<Record<string, unknown>> {
    return this.articles
      .filter((article) => article.status === "active")
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, limit);
  }

  first(query: string, values: unknown[]): Record<string, unknown> | null {
    if (query.includes("COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?")) {
      return { count: this.passkeyCredentials.filter((credential) => credential.user_id === values[0]).length };
    }
    if (query.includes("FROM users WHERE user_id = ?")) {
      return this.users.find((user) => user.user_id === values[0]) ?? null;
    }
    if (query.includes("FROM sessions s")) {
      const session = this.sessions.find(
        (entry) => entry.session_hash === values[0] && entry.revoked_at == null && String(entry.expires_at) > String(values[1])
      );
      if (!session) {
        return null;
      }
      return this.users.find((user) => user.user_id === session.user_id) ?? null;
    }
    if (query.includes("FROM auth_identities i")) {
      const provider = query.includes("i.provider = ?") ? values[0] : "github";
      const providerUserId = query.includes("i.provider = ?") ? values[1] : values[0];
      const identity = this.identities.find((entry) => entry.provider === provider && entry.provider_user_id === providerUserId);
      if (!identity) {
        return null;
      }
      return this.users.find((user) => user.user_id === identity.user_id) ?? null;
    }
    if (query.includes("FROM auth_identities WHERE provider = 'github' AND user_id = ?")) {
      return this.identities.find((entry) => entry.provider === "github" && entry.user_id === values[0]) ?? null;
    }
    if (query.includes("FROM passkey_credentials WHERE credential_id = ?")) {
      return this.passkeyCredentials.find((credential) => credential.credential_id === values[0]) ?? null;
    }
    if (query.includes("FROM auth_challenges") && query.includes("challenge = ?")) {
      return (
        this.challenges.find(
          (challenge) =>
            challenge.kind === values[0] &&
            challenge.challenge === values[1] &&
            challenge.consumed_at == null &&
            String(challenge.expires_at) > String(values[2])
        ) ?? null
      );
    }
    if (query.includes("FROM auth_challenges")) {
      const matches = this.challenges.filter(
        (challenge) =>
          challenge.kind === values[0] &&
          (challenge.user_id === values[1] || challenge.user_id == null) &&
          challenge.consumed_at == null &&
          String(challenge.expires_at) > String(values[2])
      );
      return matches.at(-1) ?? null;
    }
    return null;
  }

  run(query: string, values: unknown[]): D1Result {
    if (query.startsWith("INSERT INTO users")) {
      this.users.push({
        user_id: values[0],
        display_name: values[1],
        created_at: values[2],
        updated_at: values[3]
      });
    } else if (query.includes("INSERT INTO auth_identities")) {
      this.identities.push({
        provider: "github",
        provider_user_id: values[0],
        user_id: values[1],
        provider_username: values[2],
        created_at: values[3],
        updated_at: values[4]
      });
    } else if (query.startsWith("UPDATE auth_identities")) {
      const identity = this.identities.find((entry) => entry.provider === "github" && entry.provider_user_id === values[2]);
      if (identity) {
        identity.provider_username = values[0];
        identity.updated_at = values[1];
      }
    } else if (query.includes("INSERT INTO passkey_credentials")) {
      const existing = this.passkeyCredentials.find((credential) => credential.credential_id === values[0]);
      const record = {
        credential_id: values[0],
        user_id: values[1],
        public_key: values[2],
        counter: values[3],
        transports: values[4],
        credential_device_type: values[5],
        credential_backed_up: values[6],
        created_at: values[7],
        updated_at: values[8]
      };
      if (existing) {
        Object.assign(existing, record);
      } else {
        this.passkeyCredentials.push(record);
      }
    } else if (query.startsWith("UPDATE passkey_credentials")) {
      const credential = this.passkeyCredentials.find((entry) => entry.credential_id === values[2]);
      if (credential) {
        credential.counter = values[0];
        credential.updated_at = values[1];
      }
    } else if (query.includes("INSERT INTO auth_challenges")) {
      this.challenges.push({
        challenge_id: values[0],
        kind: values[1],
        challenge: values[2],
        user_id: values[3],
        redirect_path: values[4],
        expires_at: values[5],
        created_at: values[6],
        consumed_at: null
      });
    } else if (query.startsWith("UPDATE auth_challenges")) {
      const challenge = this.challenges.find((entry) => entry.challenge_id === values[1]);
      if (challenge) {
        challenge.consumed_at = values[0];
      }
    } else if (query.startsWith("INSERT INTO sessions")) {
      this.sessions.push({
        session_id: values[0],
        session_hash: values[1],
        user_id: values[2],
        expires_at: values[3],
        created_at: values[4],
        revoked_at: null
      });
    } else if (query.startsWith("UPDATE sessions")) {
      const session = this.sessions.find((entry) => entry.session_hash === values[1] && entry.revoked_at == null);
      if (session) {
        session.revoked_at = values[0];
      }
    }

    return this.result([]);
  }

  result<T>(results: T[]): D1Result<T> {
    return {
      success: true,
      meta: { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0 },
      results
    };
  }
}

function env(bucket: { get(key: string): Promise<R2ObjectBody | null> }, registry = new MockD1Database()): Env {
  return {
    ARTICLES_BUCKET: bucket as unknown as R2Bucket,
    GITHUB_REGISTRY: registry as unknown as D1Database,
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret"
  } as unknown as Env;
}

function request(path: string, method = "GET", init: RequestInit = {}): Request {
  return new Request(`https://articles.example${path}`, { ...init, method });
}

function authenticationResponse(credentialId: string, challenge = "login-challenge"): Record<string, unknown> {
  return {
    id: credentialId,
    response: {
      clientDataJSON: base64Url(JSON.stringify({ type: "webauthn.get", challenge, origin: "https://articles.example" }))
    }
  };
}

function registrationResponse(credentialId: string, challenge = "register-challenge"): Record<string, unknown> {
  return {
    id: credentialId,
    response: {
      clientDataJSON: base64Url(JSON.stringify({ type: "webauthn.create", challenge, origin: "https://articles.example" }))
    }
  };
}

function base64Url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("caches", { default: cache });
  });

  it("returns null from /api/auth/me when the request has no valid session", async () => {
    const response = await worker.fetch(request("/api/auth/me"), env(new MockR2Bucket()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user: null });
  });

  it("shows login actions without a username field to anonymous users", async () => {
    const response = await worker.fetch(request("/login"), env(new MockR2Bucket()));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Passkey でログイン");
    expect(html).toContain('href="/signup"');
    expect(html).not.toContain("ユーザー名");
    expect(html).not.toContain("Passkey を登録");
  });

  it("shows signup actions without a username field to anonymous users", async () => {
    const response = await worker.fetch(request("/signup"), env(new MockR2Bucket()));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Passkey で登録");
    expect(html).toContain("GitHub で登録");
    expect(html).not.toContain("ユーザー名");
  });

  it("redirects anonymous users from /settings to login", async () => {
    const response = await worker.fetch(request("/settings"), env(new MockR2Bucket()));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://articles.example/login?redirectTo=%2Fsettings");
  });

  it("shows logged-in state on login and signup pages", async () => {
    const registry = new MockD1Database();
    await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", { body: JSON.stringify({}) }),
      env(new MockR2Bucket(), registry)
    );
    const verified = await worker.fetch(
      request("/api/auth/passkey/register/verify", "POST", {
        body: JSON.stringify({ response: registrationResponse("credential-id") })
      }),
      env(new MockR2Bucket(), registry)
    );
    const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";

    const login = await worker.fetch(request("/login", "GET", { headers: { Cookie: cookie } }), env(new MockR2Bucket(), registry));
    const signup = await worker.fetch(request("/signup", "GET", { headers: { Cookie: cookie } }), env(new MockR2Bucket(), registry));
    const loginHtml = await login.text();
    const signupHtml = await signup.text();

    expect(loginHtml).toContain("ログイン済み");
    expect(loginHtml).toContain('href="/settings"');
    expect(loginHtml).not.toContain("Passkey でログイン");
    expect(signupHtml).toContain("ログイン済み");
    expect(signupHtml).not.toContain("Passkey で登録");
  });

  it("renders settings for logged-in users", async () => {
    const registry = new MockD1Database();
    const login = await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", { body: JSON.stringify({}) }),
      env(new MockR2Bucket(), registry)
    );
    expect(login.status).toBe(200);
    const verified = await worker.fetch(
      request("/api/auth/passkey/register/verify", "POST", {
        body: JSON.stringify({ response: registrationResponse("credential-id") })
      }),
      env(new MockR2Bucket(), registry)
    );
    const cookie = verified.headers.get("set-cookie")?.split(";")[0] ?? "";

    const response = await worker.fetch(request("/settings", "GET", { headers: { Cookie: cookie } }), env(new MockR2Bucket(), registry));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<title>設定 - Hosonan</title>");
    expect(html).toContain("Passkey 登録済み");
    expect(html).not.toContain('id="register-passkey"');
    expect(html).toContain("/api/auth/github/start?redirectTo=%2Fsettings");
  });

  it("stores GitHub OAuth state and redirects to GitHub", async () => {
    const registry = new MockD1Database();
    const response = await worker.fetch(
      request("/api/auth/github/start?redirectTo=/gh/octo/articles/2026-05-02/example/"),
      env(new MockR2Bucket(), registry)
    );
    const location = response.headers.get("location");

    expect(response.status).toBe(302);
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=client-id");
    expect(registry.challenges).toHaveLength(1);
    expect(registry.challenges[0]).toMatchObject({
      kind: "github_oauth",
      redirect_path: "/gh/octo/articles/2026-05-02/example/"
    });
  });

  it("verifies GitHub OAuth state, creates a user, links the identity, and issues a session cookie", async () => {
    const registry = new MockD1Database();
    const startResponse = await worker.fetch(request("/api/auth/github/start?redirectTo=/"), env(new MockR2Bucket(), registry));
    const state = new URL(startResponse.headers.get("location") ?? "").searchParams.get("state");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: "github-token" }))
        .mockResolvedValueOnce(Response.json({ id: 123, login: "octocat", name: "Octo Cat" }))
    );

    const response = await worker.fetch(request(`/api/auth/github/callback?code=code&state=${state}`), env(new MockR2Bucket(), registry));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("__Host-hosonan_session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(registry.users).toHaveLength(1);
    expect(registry.users[0]).toMatchObject({ display_name: "Octo Cat" });
    expect(registry.identities[0]).toMatchObject({
      provider: "github",
      provider_user_id: "123",
      provider_username: "octocat"
    });
    expect(registry.sessions).toHaveLength(1);
    expect(registry.sessions[0].session_hash).not.toBe("github-token");
    expect(registry.challenges[0].consumed_at).not.toBeNull();
  });

  it("rejects invalid or expired GitHub OAuth state before calling GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      request("/api/auth/github/callback?code=code&state=missing"),
      env(new MockR2Bucket(), new MockD1Database())
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_state" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when GitHub token exchange fails", async () => {
    const registry = new MockD1Database();
    const startResponse = await worker.fetch(request("/api/auth/github/start"), env(new MockR2Bucket(), registry));
    const state = new URL(startResponse.headers.get("location") ?? "").searchParams.get("state");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("bad", { status: 500 })));

    const response = await worker.fetch(request(`/api/auth/github/callback?code=code&state=${state}`), env(new MockR2Bucket(), registry));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "github_token_failed" });
  });

  it("links GitHub to the logged-in user", async () => {
    const registry = new MockD1Database();
    await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", { body: JSON.stringify({}) }),
      env(new MockR2Bucket(), registry)
    );
    const login = await worker.fetch(
      request("/api/auth/passkey/register/verify", "POST", {
        body: JSON.stringify({ response: registrationResponse("credential-id") })
      }),
      env(new MockR2Bucket(), registry)
    );
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const startResponse = await worker.fetch(
      request("/api/auth/github/start?redirectTo=/settings", "GET", { headers: { Cookie: cookie } }),
      env(new MockR2Bucket(), registry)
    );
    const state = new URL(startResponse.headers.get("location") ?? "").searchParams.get("state");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: "github-token" }))
        .mockResolvedValueOnce(Response.json({ id: 123, login: "octocat", name: "Octo Cat" }))
    );

    const response = await worker.fetch(request(`/api/auth/github/callback?code=code&state=${state}`), env(new MockR2Bucket(), registry));

    expect(registry.challenges.at(-1)).toMatchObject({ kind: "github_oauth", user_id: registry.users[0].user_id });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings");
    expect(registry.users).toHaveLength(1);
    expect(registry.identities[0]).toMatchObject({
      provider: "github",
      provider_user_id: "123",
      user_id: registry.users[0].user_id
    });

    const settings = await worker.fetch(request("/settings", "GET", { headers: { Cookie: cookie } }), env(new MockR2Bucket(), registry));
    const html = await settings.text();
    expect(html).toContain("GitHub 連携済み");
    expect(html).not.toContain("/api/auth/github/start?redirectTo=%2Fsettings");
  });

  it("rejects linking GitHub when the identity belongs to another user", async () => {
    const registry = new MockD1Database();
    registry.users.push({
      user_id: "bob-id",
      display_name: "Bob",
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z"
    });
    registry.identities.push({
      provider: "github",
      provider_user_id: "123",
      user_id: "bob-id",
      provider_username: "octocat",
      created_at: "2026-05-05T00:00:00.000Z",
      updated_at: "2026-05-05T00:00:00.000Z"
    });
    await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", { body: JSON.stringify({}) }),
      env(new MockR2Bucket(), registry)
    );
    const login = await worker.fetch(
      request("/api/auth/passkey/register/verify", "POST", {
        body: JSON.stringify({ response: registrationResponse("credential-id") })
      }),
      env(new MockR2Bucket(), registry)
    );
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const startResponse = await worker.fetch(
      request("/api/auth/github/start?redirectTo=/settings", "GET", { headers: { Cookie: cookie } }),
      env(new MockR2Bucket(), registry)
    );
    const state = new URL(startResponse.headers.get("location") ?? "").searchParams.get("state");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: "github-token" }))
        .mockResolvedValueOnce(Response.json({ id: 123, login: "octocat", name: "Octo Cat" }))
    );

    const response = await worker.fetch(request(`/api/auth/github/callback?code=code&state=${state}`), env(new MockR2Bucket(), registry));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "identity_already_linked" });
    expect(registry.identities).toHaveLength(1);
    expect(registry.identities[0].user_id).toBe("bob-id");
  });

  it("creates and verifies passkey registration challenges", async () => {
    const registry = new MockD1Database();
    const registerOptions = await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", {
        body: JSON.stringify({})
      }),
      env(new MockR2Bucket(), registry)
    );

    expect(registerOptions.status).toBe(200);
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        userName: "Hosonan user",
        userDisplayName: "Hosonan user",
        authenticatorSelection: expect.objectContaining({ residentKey: "required", requireResidentKey: true })
      })
    );
    expect(registry.users).toHaveLength(1);
    expect(registry.challenges[0]).toMatchObject({ kind: "passkey_register", challenge: "register-challenge" });

    const verifyResponse = await worker.fetch(
      request("/api/auth/passkey/register/verify", "POST", {
        body: JSON.stringify({ response: registrationResponse("credential-id") })
      }),
      env(new MockR2Bucket(), registry)
    );

    expect(verifyResponse.status).toBe(200);
    expect(verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: "register-challenge" }));
    expect(registry.passkeyCredentials[0]).toMatchObject({
      credential_id: "credential-id",
      public_key: "AQID",
      counter: 3,
      credential_backed_up: 1
    });
    expect(verifyResponse.headers.get("set-cookie")).toContain("__Host-hosonan_session=");
  });

  it("rejects registering another passkey when the logged-in user already has one", async () => {
    const registry = new MockD1Database();
    await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", { body: JSON.stringify({}) }),
      env(new MockR2Bucket(), registry)
    );
    const firstVerify = await worker.fetch(
      request("/api/auth/passkey/register/verify", "POST", {
        body: JSON.stringify({ response: registrationResponse("credential-id") })
      }),
      env(new MockR2Bucket(), registry)
    );
    const cookie = firstVerify.headers.get("set-cookie")?.split(";")[0] ?? "";

    const optionsResponse = await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", {
        headers: { Cookie: cookie },
        body: JSON.stringify({})
      }),
      env(new MockR2Bucket(), registry)
    );

    expect(optionsResponse.status).toBe(409);
    await expect(optionsResponse.json()).resolves.toEqual({ error: "passkey_already_registered" });
    expect(registry.users).toHaveLength(1);
    expect(registry.passkeyCredentials).toHaveLength(1);
  });

  it("creates and verifies passkey login challenges", async () => {
    const registry = new MockD1Database();
    await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", { body: JSON.stringify({}) }),
      env(new MockR2Bucket(), registry)
    );
    await worker.fetch(
      request("/api/auth/passkey/register/verify", "POST", {
        body: JSON.stringify({ response: registrationResponse("credential-id") })
      }),
      env(new MockR2Bucket(), registry)
    );
    vi.clearAllMocks();

    const optionsResponse = await worker.fetch(
      request("/api/auth/passkey/login/options", "POST", { body: JSON.stringify({}) }),
      env(new MockR2Bucket(), registry)
    );

    expect(optionsResponse.status).toBe(200);
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "articles.example",
        userVerification: "preferred"
      })
    );
    expect(vi.mocked(generateAuthenticationOptions).mock.calls.at(-1)?.[0]).not.toHaveProperty("allowCredentials");
    expect(registry.challenges.at(-1)).toMatchObject({ kind: "passkey_login", user_id: null });

    const verifyResponse = await worker.fetch(
      request("/api/auth/passkey/login/verify", "POST", { body: JSON.stringify({ response: authenticationResponse("credential-id") }) }),
      env(new MockR2Bucket(), registry)
    );

    expect(verifyResponse.status).toBe(200);
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: "login-challenge" }));
    expect(registry.passkeyCredentials[0].counter).toBe(7);
    expect(verifyResponse.headers.get("set-cookie")).toContain("__Host-hosonan_session=");
  });

  it("revokes the current session and clears the cookie on logout", async () => {
    const registry = new MockD1Database();
    await worker.fetch(
      request("/api/auth/passkey/register/options", "POST", { body: JSON.stringify({}) }),
      env(new MockR2Bucket(), registry)
    );
    const login = await worker.fetch(
      request("/api/auth/passkey/register/verify", "POST", {
        body: JSON.stringify({ response: registrationResponse("credential-id") })
      }),
      env(new MockR2Bucket(), registry)
    );
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const response = await worker.fetch(
      request("/api/auth/logout", "POST", {
        headers: { Cookie: cookie }
      }),
      env(new MockR2Bucket(), registry)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(registry.sessions[0].revoked_at).not.toBeNull();
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
