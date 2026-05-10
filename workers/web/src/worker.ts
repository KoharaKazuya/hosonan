import {
  buildRepositoryRawUrl,
  escapeHtml,
  parseServedArticlePath,
  validateChannelIconPath,
  type RepoSyncDesiredState,
  type RepoSyncNotification,
  type ServedArticlePath,
  type StoredArticle
} from "@hosonan/shared";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential
} from "@simplewebauthn/server";
import { KISO_CSS } from "./kiso-css";

const CACHE_TTL_SECONDS = 300;
const HOME_ARTICLE_LIMIT = 10;
const SESSION_COOKIE_NAME = "__Host-hosonan_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_TTL_SECONDS = 60 * 10;
const RP_NAME = "Hosonan";
const PASSKEY_USER_LABEL = "Hosonan user";

const ARTICLE_PAGE_CSS = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7;background:#f7f7f8;color:#1f2328}
.article{width:min(100% - 32px,840px);margin:0 auto;padding:48px 0 72px}
.article :first-child{margin-top:0}
.article :where(p,blockquote,figure,pre,ul,ol,dl,table){margin-block:1em}
.article :where(ul,ol){padding-inline-start:1.5em;list-style:revert}
.article pre{overflow:auto;padding:16px;border-radius:6px;background:#24292f;color:#f6f8fa}
.article code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.article img,.article table{max-width:100%}
`;

const HOME_PAGE_CSS = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6;background:#f7f7f8;color:#1f2328}
.home{width:min(100% - 32px,1040px);margin:0 auto;padding:40px 0 64px}
.home h1{margin:0 0 24px;font-size:2rem;line-height:1.2}
.article-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
.article-card{overflow:hidden;border:1px solid #d0d7de;border-radius:8px;background:#fff;color:inherit;text-decoration:none}
.article-card:focus-visible{outline:3px solid #0969da;outline-offset:2px}
.article-thumb-frame{position:relative;display:block;aspect-ratio:16/9;overflow:hidden;border-bottom:1px solid #d0d7de;background:#eef2f6}
.article-thumb{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover}
.article-thumb[hidden]{display:none}
.article-thumb-fallback{position:absolute;inset:0;display:grid;place-items:center;background:linear-gradient(135deg,#f6f8fa,#eaeef2);color:#57606a;font-size:.82rem;font-weight:600}
.article-thumb-fallback-error{display:none}
.article-thumb-frame.is-error .article-thumb-fallback-loading{display:none}
.article-thumb-frame.is-error .article-thumb-fallback-error{display:inline}
.article-card-body{padding:14px 16px 16px}
.article-card h2{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;margin:0 0 10px;font-size:1.05rem;line-height:1.35}
.article-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0;color:#57606a;font-size:.9rem}
.channel{display:inline-flex;min-width:0;align-items:center;gap:6px}
.channel-icon,.channel-placeholder{flex:0 0 auto;width:22px;height:22px;border-radius:50%}
.channel-icon{display:block;object-fit:cover;background:#eaeef2}
.channel-placeholder{display:inline-grid;place-items:center;background:#d8dee4;color:#57606a;font-size:.75rem;font-weight:700;line-height:1}
.channel-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-color-scheme:dark){
:root{background:#0d1117;color:#f0f6fc}
.article-card{border-color:#30363d;background:#161b22}
.article-thumb-frame{border-bottom-color:#30363d;background:#21262d}
.article-thumb-fallback{background:linear-gradient(135deg,#21262d,#161b22);color:#8b949e}
.article-meta{color:#8b949e}
.channel-placeholder{background:#30363d;color:#c9d1d9}
}
`;

export interface ViewerContext {
  request: Request;
}

export function buildHtmlDocumentPrefix(article: ServedArticlePath): string {
  const title = escapeHtml(`${article.owner}/${article.repo}/${article.slug}`);

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${buildInlineStyle(ARTICLE_PAGE_CSS)}
</head>
<body>
<main class="article">
`;
}

export function buildHtmlDocumentSuffix(): string {
  return `
</main>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/login") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      return responseForMethod(await loginPageResponse(request, env), request.method);
    }

    if (requestUrl.pathname === "/signup") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD"]);
      }
      return responseForMethod(await signupPageResponse(request, env), request.method);
    }

    if (requestUrl.pathname === "/settings") {
      if (request.method === "POST") {
        return settingsSaveResponse(request, env);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(["GET", "HEAD", "POST"]);
      }
      return responseForMethod(await settingsPageResponse(request, env), request.method);
    }

    if (requestUrl.pathname === "/settings/github/setup") {
      return requireMethod(request, ["GET"], () => githubSetupResponse(request, env));
    }

    if (requestUrl.pathname.startsWith("/api/auth/")) {
      return authApiResponse(request, env);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }

    if (requestUrl.pathname === "/") {
      return responseForMethod(await homePageResponse(env, { request }, HOME_ARTICLE_LIMIT), request.method);
    }

    const article = parseServedArticlePath(requestUrl.pathname);
    if (!article) {
      return textResponse("not found\n", 404, request.method);
    }

    const canonicalUrl = new URL(request.url);
    canonicalUrl.pathname = article.canonicalPath;
    canonicalUrl.search = "";
    canonicalUrl.hash = "";
    const storedArticle = await activeStoredArticleForPath(env, article.r2Key);
    if (!storedArticle) {
      return textResponse("not found\n", 404, request.method);
    }

    const defaultCache = getDefaultCache();
    const cacheKey = new Request(canonicalUrl.toString(), { method: "GET" });
    const cached = await defaultCache.match(cacheKey);
    if (cached) {
      return responseForMethod(cached, request.method);
    }

    const object = await env.ARTICLES_BUCKET.get(article.r2Key);
    if (!object) {
      return textResponse("not found\n", 404, request.method);
    }

    if (!object.body) {
      return textResponse("article body unavailable\n", 500, request.method);
    }

    const response = new Response(buildHtmlDocumentStream(article, object.body), {
      headers: {
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "Content-Type": "text/html; charset=utf-8"
      }
    });
    await defaultCache.put(cacheKey, response.clone());

    return responseForMethod(response, request.method);
  }
};

export async function recommendArticles(
  env: Env,
  _viewerContext: ViewerContext,
  limit = HOME_ARTICLE_LIMIT
): Promise<StoredArticle[]> {
  const result = await env.GITHUB_REGISTRY.prepare(
    `SELECT a.repository_id, a.owner_login, a.repo_name, a.article_path, a.slug, a.title, a.created_at, a.canonical_path, a.r2_key, a.status, a.synced_commit, a.updated_at,
       r.channel_name, r.channel_icon_path, r.channel_biography, r.channel_updated_at
     FROM articles a
     JOIN repositories r ON r.repository_id = a.repository_id
     WHERE a.status = 'active' AND r.status = 'active' AND r.sync_enabled = 1
     ORDER BY a.created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all<StoredArticle>();

  return result.results ?? [];
}

async function homePageResponse(env: Env, viewerContext: ViewerContext, limit: number): Promise<Response> {
  const articles = await recommendArticles(env, viewerContext, limit);
  return new Response(buildHomePage(articles), {
    headers: {
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

async function activeStoredArticleForPath(env: Env, r2Key: string): Promise<{ repository_id: number } | null> {
  return env.GITHUB_REGISTRY.prepare(
    `SELECT a.repository_id
     FROM articles a
     JOIN repositories r ON r.repository_id = a.repository_id
     WHERE a.r2_key = ? AND a.status = 'active' AND r.status = 'active' AND r.sync_enabled = 1
     LIMIT 1`
  )
    .bind(r2Key)
    .first<{ repository_id: number }>();
}

function buildHomePage(articles: StoredArticle[]): string {
  const cards = articles.map(buildArticleCard).join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hosonan</title>
${buildInlineStyle(HOME_PAGE_CSS)}
</head>
<body>
<main class="home">
<h1>Hosonan</h1>
<section class="article-list" aria-label="記事一覧">
${cards}
</section>
</main>
</body>
</html>`;
}

function buildArticleCard(article: StoredArticle): string {
  return `<a class="article-card" href="${escapeHtml(article.canonical_path)}">
<span class="article-thumb-frame">
<span class="article-thumb-fallback" aria-hidden="true"><span class="article-thumb-fallback-loading">読み込み中</span><span class="article-thumb-fallback-error">画像なし</span></span>
<img class="article-thumb" src="${escapeHtml(thumbnailRawUrl(article))}" alt="" onerror="this.closest('.article-thumb-frame').classList.add('is-error');this.hidden=true">
</span>
<div class="article-card-body">
<h2>${escapeHtml(article.title)}</h2>
<p class="article-meta"><time datetime="${escapeHtml(article.created_at)}">${escapeHtml(article.created_at)}</time>${buildChannelMeta(article)}</p>
</div>
</a>`;
}

function buildInlineStyle(pageCss: string): string {
  return `<style>
${KISO_CSS}
${pageCss.trim()}
</style>`;
}

function thumbnailRawUrl(article: Pick<StoredArticle, "owner_login" | "repo_name" | "synced_commit" | "article_path">): string {
  const articleDir = article.article_path.replace(/\/index\.md$/, "");
  return buildRepositoryRawUrl(article.owner_login, article.repo_name, article.synced_commit, `${articleDir}/thumbnail.webp`);
}

function buildChannelMeta(
  article: Pick<StoredArticle, "owner_login" | "repo_name" | "synced_commit" | "channel_name" | "channel_icon_path">
): string {
  const displayName = channelDisplayName(article);
  const iconPath = validateChannelIconPath(article.channel_icon_path);
  const icon = iconPath
    ? `<img class="channel-icon" src="${escapeHtml(
        buildRepositoryRawUrl(article.owner_login, article.repo_name, article.synced_commit, iconPath)
      )}" alt="">`
    : `<span class="channel-placeholder" aria-hidden="true">${escapeHtml(channelPlaceholderText(displayName))}</span>`;
  return `<span class="channel">${icon}<span class="channel-name">${escapeHtml(displayName)}</span></span>`;
}

function channelDisplayName(article: Pick<StoredArticle, "owner_login" | "repo_name" | "channel_name">): string {
  return article.channel_name ?? `${article.owner_login}/${article.repo_name}`;
}

function channelPlaceholderText(displayName: string): string {
  return ([...displayName.trim()][0] ?? "?").toUpperCase();
}

type AuthEnv = Env & {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_USER_TOKEN_ENCRYPTION_KEY?: string;
};

type UserRecord = {
  user_id: string;
  display_name: string | null;
};

type ChallengeRecord = {
  challenge_id: string;
  challenge: string;
  user_id: string | null;
  redirect_path: string | null;
  expires_at: string;
};

type PasskeyCredentialRecord = {
  credential_id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  credential_device_type: string | null;
  credential_backed_up: number;
};

type SettingsAuthState = {
  hasPasskey: boolean;
  hasGitHub: boolean;
};

type SettingsRepository = {
  repository_id: number;
  installation_id: number;
  owner_login: string;
  repo_name: string;
  full_name: string;
  default_branch: string;
  status: string;
  sync_enabled: number;
};

type GitHubTokenResponse = {
  access_token?: string;
  error?: string;
};

type GitHubUserResponse = {
  id?: number;
  login?: string;
  name?: string | null;
};

async function authApiResponse(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/auth/me") {
    return requireMethod(request, ["GET"], () => meResponse(request, env));
  }
  if (pathname === "/api/auth/logout") {
    return requireMethod(request, ["POST"], () => logoutResponse(request, env));
  }
  if (pathname === "/api/auth/passkey/register/options") {
    return requireMethod(request, ["POST"], () => passkeyRegisterOptionsResponse(request, env));
  }
  if (pathname === "/api/auth/passkey/register/verify") {
    return requireMethod(request, ["POST"], () => passkeyRegisterVerifyResponse(request, env));
  }
  if (pathname === "/api/auth/passkey/login/options") {
    return requireMethod(request, ["POST"], () => passkeyLoginOptionsResponse(request, env));
  }
  if (pathname === "/api/auth/passkey/login/verify") {
    return requireMethod(request, ["POST"], () => passkeyLoginVerifyResponse(request, env));
  }
  if (pathname === "/api/auth/github/start") {
    return requireMethod(request, ["GET"], () => githubStartResponse(request, env));
  }
  if (pathname === "/api/auth/github/callback") {
    return requireMethod(request, ["GET"], () => githubCallbackResponse(request, env));
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function requireMethod(
  request: Request,
  methods: string[],
  handler: () => Promise<Response>
): Promise<Response> {
  if (!methods.includes(request.method)) {
    return methodNotAllowed(methods);
  }
  return handler();
}

async function meResponse(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) {
    return jsonResponse({ user: null }, 200);
  }

  return jsonResponse({
    user: {
      id: user.user_id,
      displayName: user.display_name
    }
  });
}

async function logoutResponse(request: Request, env: Env): Promise<Response> {
  const token = sessionTokenFromRequest(request);
  if (token) {
    const sessionHash = await sha256Hex(token);
    await env.GITHUB_REGISTRY.prepare("UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL")
      .bind(nowIso(), sessionHash)
      .run();
  }

  return jsonResponse(
    { ok: true },
    200,
    new Headers({
      "Set-Cookie": expiredSessionCookie()
    })
  );
}

async function passkeyRegisterOptionsResponse(request: Request, env: Env): Promise<Response> {
  const current = await currentUser(request, env);
  const user = current ?? (await createUnnamedUser(env));
  const credentials = await passkeyCredentialsForUser(env, user.user_id);
  if (current && credentials.length > 0) {
    return jsonResponse({ error: "passkey_already_registered" }, 409);
  }
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpIdFromRequest(request),
    userName: PASSKEY_USER_LABEL,
    userID: new TextEncoder().encode(user.user_id),
    userDisplayName: PASSKEY_USER_LABEL,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "preferred"
    },
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: parseTransports(credential.transports)
    }))
  });

  await createChallenge(env, {
    kind: "passkey_register",
    challenge: options.challenge,
    userId: user.user_id
  });

  return jsonResponse(options);
}

async function passkeyRegisterVerifyResponse(request: Request, env: Env): Promise<Response> {
  const current = await currentUser(request, env);
  const body = await readJsonObject(request);
  const response = body.response as RegistrationResponseJSON | undefined;
  if (!response) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const receivedChallenge = challengeFromRegistrationResponse(response);
  if (!receivedChallenge) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const challenge = await challengeByValue(env, "passkey_register", receivedChallenge);
  if (!challenge || !challenge.user_id) {
    return jsonResponse({ error: "challenge_not_found" }, 400);
  }
  if (current && challenge.user_id !== current.user_id) {
    return jsonResponse({ error: "challenge_not_found" }, 400);
  }

  const user = current ?? (await userById(env, challenge.user_id));
  if (!user) {
    return jsonResponse({ error: "user_not_found" }, 500);
  }

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: originFromRequest(request),
    expectedRPID: rpIdFromRequest(request),
    requireUserVerification: false
  });
  if (!verification.verified) {
    return jsonResponse({ error: "verification_failed" }, 400);
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const savedAt = nowIso();
  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO passkey_credentials
       (credential_id, user_id, public_key, counter, transports, credential_device_type, credential_backed_up, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_id) DO UPDATE SET
       user_id = excluded.user_id,
       public_key = excluded.public_key,
       counter = excluded.counter,
       transports = excluded.transports,
       credential_device_type = excluded.credential_device_type,
       credential_backed_up = excluded.credential_backed_up,
       updated_at = excluded.updated_at`
  )
    .bind(
      credential.id,
      user.user_id,
      bytesToBase64Url(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      savedAt,
      savedAt
    )
    .run();
  await consumeChallenge(env, challenge.challenge_id);

  return current ? userJsonResponse(user) : sessionJsonResponse(env, user);
}

async function passkeyLoginOptionsResponse(request: Request, env: Env): Promise<Response> {
  const options = await generateAuthenticationOptions({
    rpID: rpIdFromRequest(request),
    userVerification: "preferred"
  });

  await createChallenge(env, {
    kind: "passkey_login",
    challenge: options.challenge
  });

  return jsonResponse(options);
}

async function passkeyLoginVerifyResponse(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const response = body.response as AuthenticationResponseJSON | undefined;
  if (!response) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const credentialRecord = await env.GITHUB_REGISTRY.prepare(
    "SELECT credential_id, user_id, public_key, counter, transports, credential_device_type, credential_backed_up FROM passkey_credentials WHERE credential_id = ?"
  )
    .bind(response.id)
    .first<PasskeyCredentialRecord>();
  if (!credentialRecord) {
    return jsonResponse({ error: "credential_not_found" }, 404);
  }

  const receivedChallenge = challengeFromAuthenticationResponse(response);
  if (!receivedChallenge) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const challenge = await challengeByValue(env, "passkey_login", receivedChallenge);
  if (!challenge) {
    return jsonResponse({ error: "challenge_not_found" }, 400);
  }
  if (challenge.user_id && challenge.user_id !== credentialRecord.user_id) {
    return jsonResponse({ error: "challenge_not_found" }, 400);
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: originFromRequest(request),
    expectedRPID: rpIdFromRequest(request),
    credential: webAuthnCredentialFromRecord(credentialRecord),
    requireUserVerification: false
  });
  if (!verification.verified) {
    return jsonResponse({ error: "verification_failed" }, 400);
  }

  await env.GITHUB_REGISTRY.prepare("UPDATE passkey_credentials SET counter = ?, updated_at = ? WHERE credential_id = ?")
    .bind(verification.authenticationInfo.newCounter, nowIso(), credentialRecord.credential_id)
    .run();
  await consumeChallenge(env, challenge.challenge_id);

  const user = await userById(env, credentialRecord.user_id);
  if (!user) {
    return jsonResponse({ error: "user_not_found" }, 500);
  }

  return sessionJsonResponse(env, user);
}

async function githubStartResponse(request: Request, env: Env): Promise<Response> {
  const authEnv = env as AuthEnv;
  if (!authEnv.GITHUB_CLIENT_ID) {
    return jsonResponse({ error: "github_oauth_not_configured" }, 500);
  }

  const current = await currentUser(request, env);
  const requestUrl = new URL(request.url);
  const redirectPath = safeRedirectPath(requestUrl.searchParams.get("redirectTo"));
  const state = randomToken();
  await createChallenge(env, {
    kind: "github_oauth",
    challenge: await sha256Hex(state),
    userId: current?.user_id ?? null,
    redirectPath
  });

  const githubUrl = new URL("https://github.com/login/oauth/authorize");
  githubUrl.searchParams.set("client_id", authEnv.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set("state", state);
  githubUrl.searchParams.set("redirect_uri", `${originFromRequest(request)}/api/auth/github/callback`);

  return Response.redirect(githubUrl.toString(), 302);
}

async function githubCallbackResponse(request: Request, env: Env): Promise<Response> {
  const authEnv = env as AuthEnv;
  if (!authEnv.GITHUB_CLIENT_ID || !authEnv.GITHUB_CLIENT_SECRET) {
    return jsonResponse({ error: "github_oauth_not_configured" }, 500);
  }

  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  if (!code || !state) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const challenge = await challengeByValue(env, "github_oauth", await sha256Hex(state));
  if (!challenge) {
    return jsonResponse({ error: "invalid_state" }, 400);
  }
  await consumeChallenge(env, challenge.challenge_id);

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "hosonan"
    },
    body: JSON.stringify({
      client_id: authEnv.GITHUB_CLIENT_ID,
      client_secret: authEnv.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${originFromRequest(request)}/api/auth/github/callback`,
      state
    })
  });
  if (!tokenResponse.ok) {
    return jsonResponse({ error: "github_token_failed" }, 502);
  }

  const tokenBody = (await tokenResponse.json()) as GitHubTokenResponse;
  if (!tokenBody.access_token || tokenBody.error) {
    return jsonResponse({ error: "github_token_failed" }, 502);
  }

  const githubUserResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "User-Agent": "hosonan",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!githubUserResponse.ok) {
    return jsonResponse({ error: "github_user_failed" }, 502);
  }

  const githubUser = (await githubUserResponse.json()) as GitHubUserResponse;
  if (typeof githubUser.id !== "number" || !githubUser.login) {
    return jsonResponse({ error: "github_user_failed" }, 502);
  }

  const user =
    challenge.user_id === null
      ? await ensureGitHubUser(env, {
          id: githubUser.id,
          login: githubUser.login,
          name: githubUser.name
        })
      : await linkGitHubIdentityToUser(env, challenge.user_id, {
          id: githubUser.id,
          login: githubUser.login,
          name: githubUser.name
        });
  if (!user) {
    return jsonResponse({ error: "identity_already_linked" }, 409);
  }
  await saveGitHubUserToken(authEnv, user.user_id, String(githubUser.id), tokenBody.access_token);
  return sessionRedirectResponse(env, user, challenge.redirect_path ?? "/");
}

async function githubSetupResponse(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) {
    return Response.redirect(`${originFromRequest(request)}/login?redirectTo=%2Fsettings`, 303);
  }

  const requestUrl = new URL(request.url);
  const installationId = Number(requestUrl.searchParams.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return jsonResponse({ error: "invalid_installation_id" }, 400);
  }

  const timestamp = nowIso();
  await env.GITHUB_REGISTRY.prepare(
    `INSERT OR IGNORE INTO installations
       (installation_id, account_id, account_login, account_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(installationId, null, null, null, "active", timestamp, timestamp)
    .run();
  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO github_installation_users (installation_id, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(installation_id, user_id) DO UPDATE SET updated_at = excluded.updated_at`
  )
    .bind(installationId, user.user_id, timestamp, timestamp)
    .run();

  return Response.redirect(`${originFromRequest(request)}/settings`, 303);
}

async function saveGitHubUserToken(env: AuthEnv, userId: string, githubUserId: string, accessToken: string): Promise<void> {
  const timestamp = nowIso();
  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO github_user_tokens (user_id, github_user_id, encrypted_access_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, github_user_id) DO UPDATE SET
       encrypted_access_token = excluded.encrypted_access_token,
       updated_at = excluded.updated_at`
  )
    .bind(userId, githubUserId, await encryptGitHubUserToken(env, accessToken), timestamp, timestamp)
    .run();
}

async function encryptGitHubUserToken(env: AuthEnv, accessToken: string): Promise<string> {
  const keyMaterial = env.GITHUB_USER_TOKEN_ENCRYPTION_KEY ?? env.GITHUB_CLIENT_SECRET;
  if (!keyMaterial) {
    throw new Error("GitHub user token encryption key is not configured.");
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(accessToken));
  return `aes-gcm:${bytesToBase64Url(iv)}:${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function currentUser(request: Request, env: Env): Promise<UserRecord | null> {
  const token = sessionTokenFromRequest(request);
  if (!token) {
    return null;
  }

  const sessionHash = await sha256Hex(token);
  return env.GITHUB_REGISTRY.prepare(
    `SELECT u.user_id, u.display_name
     FROM sessions s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.session_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
  )
    .bind(sessionHash, nowIso())
    .first<UserRecord>();
}

async function createUnnamedUser(env: Env): Promise<UserRecord> {
  const userId = crypto.randomUUID();
  const timestamp = nowIso();
  await env.GITHUB_REGISTRY.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(userId, null, timestamp, timestamp)
    .run();
  return {
    user_id: userId,
    display_name: null
  };
}

async function ensureGitHubUser(env: Env, githubUser: GitHubUserResponse & { id: number; login: string }): Promise<UserRecord> {
  const providerUserId = String(githubUser.id);
  const existing = await userByIdentity(env, "github", providerUserId);
  if (existing) {
    await env.GITHUB_REGISTRY.prepare(
      "UPDATE auth_identities SET provider_username = ?, updated_at = ? WHERE provider = 'github' AND provider_user_id = ?"
    )
      .bind(githubUser.login, nowIso(), providerUserId)
      .run();
    return existing;
  }

  const user = await createUser(env, githubUser.name ?? githubUser.login);
  const timestamp = nowIso();
  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO auth_identities (provider, provider_user_id, user_id, provider_username, created_at, updated_at)
     VALUES ('github', ?, ?, ?, ?, ?)`
  )
    .bind(providerUserId, user.user_id, githubUser.login, timestamp, timestamp)
    .run();
  return user;
}

async function linkGitHubIdentityToUser(
  env: Env,
  userId: string,
  githubUser: GitHubUserResponse & { id: number; login: string }
): Promise<UserRecord | null> {
  const providerUserId = String(githubUser.id);
  const existing = await userByIdentity(env, "github", providerUserId);
  if (existing && existing.user_id !== userId) {
    return null;
  }

  const user = await userById(env, userId);
  if (!user) {
    return null;
  }

  const timestamp = nowIso();
  if (existing) {
    await env.GITHUB_REGISTRY.prepare(
      "UPDATE auth_identities SET provider_username = ?, updated_at = ? WHERE provider = 'github' AND provider_user_id = ?"
    )
      .bind(githubUser.login, timestamp, providerUserId)
      .run();
    return user;
  }

  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO auth_identities (provider, provider_user_id, user_id, provider_username, created_at, updated_at)
     VALUES ('github', ?, ?, ?, ?, ?)`
  )
    .bind(providerUserId, user.user_id, githubUser.login, timestamp, timestamp)
    .run();
  return user;
}

async function createUser(env: Env, displayName: string | null): Promise<UserRecord> {
  const userId = crypto.randomUUID();
  const timestamp = nowIso();
  await env.GITHUB_REGISTRY.prepare("INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(userId, displayName, timestamp, timestamp)
    .run();
  return {
    user_id: userId,
    display_name: displayName
  };
}

async function userById(env: Env, userId: string): Promise<UserRecord | null> {
  return env.GITHUB_REGISTRY.prepare("SELECT user_id, display_name FROM users WHERE user_id = ?")
    .bind(userId)
    .first<UserRecord>();
}

async function userByIdentity(env: Env, provider: string, providerUserId: string): Promise<UserRecord | null> {
  return env.GITHUB_REGISTRY.prepare(
    `SELECT u.user_id, u.display_name
     FROM auth_identities i
     JOIN users u ON u.user_id = i.user_id
     WHERE i.provider = ? AND i.provider_user_id = ?`
  )
    .bind(provider, providerUserId)
    .first<UserRecord>();
}

async function passkeyCredentialsForUser(env: Env, userId: string): Promise<PasskeyCredentialRecord[]> {
  const result = await env.GITHUB_REGISTRY.prepare(
    "SELECT credential_id, user_id, public_key, counter, transports, credential_device_type, credential_backed_up FROM passkey_credentials WHERE user_id = ?"
  )
    .bind(userId)
    .all<PasskeyCredentialRecord>();
  return result.results ?? [];
}

async function settingsAuthState(env: Env, userId: string): Promise<SettingsAuthState> {
  const passkey = await env.GITHUB_REGISTRY.prepare("SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  const github = await env.GITHUB_REGISTRY.prepare(
    "SELECT provider_user_id FROM auth_identities WHERE provider = 'github' AND user_id = ? LIMIT 1"
  )
    .bind(userId)
    .first<{ provider_user_id: string }>();

  return {
    hasPasskey: (passkey?.count ?? 0) > 0,
    hasGitHub: github !== null
  };
}

async function settingsRepositories(env: Env, userId: string): Promise<SettingsRepository[]> {
  const result = await env.GITHUB_REGISTRY.prepare(
    `SELECT r.repository_id, r.installation_id, r.owner_login, r.repo_name, r.full_name, r.default_branch, r.status, r.sync_enabled
     FROM github_installation_users u
     JOIN repositories r ON r.installation_id = u.installation_id
     WHERE u.user_id = ? AND r.status != 'deleted'
     ORDER BY r.full_name COLLATE NOCASE`
  )
    .bind(userId)
    .all<SettingsRepository>();
  return result.results ?? [];
}

async function settingsSaveResponse(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) {
    return Response.redirect(`${originFromRequest(request)}/login?redirectTo=%2Fsettings`, 303);
  }

  const form = await request.formData();
  const enabledIds = new Set(
    form
      .getAll("sync_repository_id")
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  );
  const repositories = await settingsRepositories(env, user.user_id);
  const timestamp = nowIso();

  for (const repository of repositories) {
    const previousEnabled = repository.sync_enabled;
    const nextEnabled = enabledIds.has(repository.repository_id) ? 1 : 0;
    if (nextEnabled === previousEnabled) {
      continue;
    }
    if (previousEnabled === 0 && nextEnabled === 1 && repository.status === "active") {
      await notifySettingsRepository(env, repository, "active");
    }
    await env.GITHUB_REGISTRY.prepare("UPDATE repositories SET sync_enabled = ?, updated_at = ? WHERE repository_id = ?")
      .bind(nextEnabled, timestamp, repository.repository_id)
      .run();
    if (previousEnabled === 1 && nextEnabled === 0) {
      await notifySettingsRepository(env, repository, "inactive");
    }
  }

  return Response.redirect(`${originFromRequest(request)}/settings`, 303);
}

async function notifySettingsRepository(
  env: Env,
  repository: SettingsRepository,
  desiredState: RepoSyncDesiredState
): Promise<void> {
  await postJson(repoSyncStateObject(env, repository.repository_id), "/notify", {
    repositoryId: repository.repository_id,
    ownerLogin: repository.owner_login,
    repoName: repository.repo_name,
    installationId: repository.installation_id,
    targetBranch: repository.default_branch,
    desiredState
  } satisfies RepoSyncNotification);
}

function repoSyncStateObject(env: Env, repositoryId: number): DurableObjectStub {
  return env.REPO_SYNC_STATE.get(env.REPO_SYNC_STATE.idFromName(String(repositoryId)));
}

async function postJson<T>(stub: DurableObjectStub, path: string, body: unknown): Promise<T> {
  const response = await stub.fetch(`https://repo-sync-state.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Repo sync state request failed: ${response.status}`);
  }
  return response.json();
}

async function createChallenge(
  env: Env,
  input: {
    kind: string;
    challenge: string;
    userId?: string | null;
    redirectPath?: string | null;
  }
): Promise<void> {
  const timestamp = nowIso();
  await env.GITHUB_REGISTRY.prepare(
    `INSERT INTO auth_challenges
       (challenge_id, kind, challenge, user_id, redirect_path, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      input.kind,
      input.challenge,
      input.userId ?? null,
      input.redirectPath ?? null,
      new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
      timestamp
    )
    .run();
}

async function latestChallenge(env: Env, kind: string, userId: string): Promise<ChallengeRecord | null> {
  return env.GITHUB_REGISTRY.prepare(
    `SELECT challenge_id, challenge, user_id, redirect_path, expires_at
     FROM auth_challenges
     WHERE kind = ? AND (user_id = ? OR user_id IS NULL) AND consumed_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(kind, userId, nowIso())
    .first<ChallengeRecord>();
}

async function challengeByValue(env: Env, kind: string, challenge: string): Promise<ChallengeRecord | null> {
  return env.GITHUB_REGISTRY.prepare(
    `SELECT challenge_id, challenge, user_id, redirect_path, expires_at
     FROM auth_challenges
     WHERE kind = ? AND challenge = ? AND consumed_at IS NULL AND expires_at > ?
     LIMIT 1`
  )
    .bind(kind, challenge, nowIso())
    .first<ChallengeRecord>();
}

async function consumeChallenge(env: Env, challengeId: string): Promise<void> {
  await env.GITHUB_REGISTRY.prepare("UPDATE auth_challenges SET consumed_at = ? WHERE challenge_id = ?")
    .bind(nowIso(), challengeId)
    .run();
}

async function sessionJsonResponse(env: Env, user: UserRecord): Promise<Response> {
  const { cookie } = await createSession(env, user.user_id);
  return jsonResponse(
    {
      user: {
        id: user.user_id,
        displayName: user.display_name
      }
    },
    200,
    new Headers({ "Set-Cookie": cookie })
  );
}

function userJsonResponse(user: UserRecord): Response {
  return jsonResponse({
    user: {
      id: user.user_id,
      displayName: user.display_name
    }
  });
}

async function sessionRedirectResponse(env: Env, user: UserRecord, redirectPath: string): Promise<Response> {
  const { cookie } = await createSession(env, user.user_id);
  return new Response(null, {
    status: 303,
    headers: {
      Location: safeRedirectPath(redirectPath),
      "Set-Cookie": cookie
    }
  });
}

async function createSession(env: Env, userId: string): Promise<{ cookie: string }> {
  const token = randomToken(32);
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await env.GITHUB_REGISTRY.prepare(
    "INSERT INTO sessions (session_id, session_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), await sha256Hex(token), userId, expiresAt, timestamp)
    .run();
  return { cookie: sessionCookie(token) };
}

async function settingsPageResponse(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) {
    return Response.redirect(`${originFromRequest(request)}/login?redirectTo=%2Fsettings`, 303);
  }

  const [authState, repositories] = await Promise.all([
    settingsAuthState(env, user.user_id),
    settingsRepositories(env, user.user_id)
  ]);
  return new Response(buildSettingsPage(user, authState, repositories, env as AuthEnv), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

async function signupPageResponse(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  return new Response(user ? buildSignedInPage("アカウント登録", user) : buildSignupPage(request), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

async function loginPageResponse(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  return new Response(user ? buildSignedInPage("ログイン", user) : buildLoginPage(request), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

function authPageCss(): string {
  return `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6;background:#f7f7f8;color:#1f2328}
.auth{width:min(100% - 32px,420px);margin:0 auto;padding:48px 0}
.auth h1{margin:0 0 20px;font-size:1.7rem;line-height:1.2}
.account{margin:0 0 18px;color:#57606a;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
.button{min-height:42px;border:1px solid #0969da;border-radius:6px;padding:8px 12px;font:inherit;font-weight:600;background:#0969da;color:#fff;cursor:pointer;text-decoration:none}
.button.secondary{border-color:#d0d7de;background:#fff;color:#1f2328}
.status{min-height:1.5em;color:#57606a}
@media (prefers-color-scheme:dark){:root{background:#0d1117;color:#f0f6fc}.account,.status{color:#8b949e}.button.secondary{border-color:#30363d;background:#161b22;color:#f0f6fc}}
`;
}

function buildLoginPage(request: Request): string {
  const redirectTo = safeRedirectPath(new URL(request.url).searchParams.get("redirectTo"));
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログイン - Hosonan</title>
${buildInlineStyle(authPageCss())}
</head>
<body>
<main class="auth">
<h1>Hosonan</h1>
<div class="actions">
<button class="button" type="button" id="login-passkey">Passkey でログイン</button>
<a class="button secondary" href="/api/auth/github/start?redirectTo=${encodeURIComponent(redirectTo)}">GitHub でログイン</a>
</div>
<p><a href="/signup">アカウント登録</a></p>
<p class="status" id="status"></p>
</main>
<script type="module">
import { startAuthentication } from "https://esm.sh/@simplewebauthn/browser@13.3.0";
const redirectTo = ${JSON.stringify(redirectTo)};
const status = document.querySelector("#status");
function setStatus(message){ status.textContent = message; }
async function postJson(path, body){
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "request_failed");
  return json;
}
document.querySelector("#login-passkey").addEventListener("click", async () => {
  try {
    setStatus("認証しています");
    const options = await postJson("/api/auth/passkey/login/options", {});
    const response = await startAuthentication({ optionsJSON: options });
    await postJson("/api/auth/passkey/login/verify", { response });
    location.href = redirectTo;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "ログインできませんでした");
  }
});
</script>
</body>
</html>`;
}

function buildSignupPage(request: Request): string {
  const redirectTo = safeRedirectPath(new URL(request.url).searchParams.get("redirectTo"));
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>アカウント登録 - Hosonan</title>
${buildInlineStyle(authPageCss())}
</head>
<body>
<main class="auth">
<h1>アカウント登録</h1>
<div class="actions">
<button class="button" type="button" id="register-passkey">Passkey で登録</button>
<a class="button secondary" href="/api/auth/github/start?redirectTo=${encodeURIComponent(redirectTo)}">GitHub で登録</a>
</div>
<p><a href="/login">ログイン</a></p>
<p class="status" id="status"></p>
</main>
<script type="module">
import { startRegistration } from "https://esm.sh/@simplewebauthn/browser@13.3.0";
const redirectTo = ${JSON.stringify(redirectTo)};
const status = document.querySelector("#status");
function setStatus(message){ status.textContent = message; }
async function postJson(path, body){
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "request_failed");
  return json;
}
document.querySelector("#register-passkey").addEventListener("click", async () => {
  try {
    setStatus("登録しています");
    const options = await postJson("/api/auth/passkey/register/options", {});
    const response = await startRegistration({ optionsJSON: options });
    await postJson("/api/auth/passkey/register/verify", { response });
    location.href = redirectTo;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "登録できませんでした");
  }
});
</script>
</body>
</html>`;
}

function buildSignedInPage(title: string, user: UserRecord): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Hosonan</title>
${buildInlineStyle(authPageCss())}
</head>
<body>
<main class="auth">
<h1>Hosonan</h1>
<p class="account">ログイン済み: ${escapeHtml(accountLabel(user))}</p>
<div class="actions">
<a class="button" href="/settings">設定を開く</a>
<button class="button secondary" type="button" id="logout">ログアウト</button>
</div>
<p class="status" id="status"></p>
</main>
<script type="module">
const status = document.querySelector("#status");
document.querySelector("#logout").addEventListener("click", async () => {
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (response.ok) {
    location.href = "/login";
    return;
  }
  status.textContent = "ログアウトできませんでした";
});
</script>
</body>
</html>`;
}

function buildSettingsPage(
  user: UserRecord,
  authState: SettingsAuthState,
  repositories: SettingsRepository[],
  authEnv: AuthEnv
): string {
  const passkeyControl = authState.hasPasskey
    ? `<button class="button" type="button" disabled>Passkey 登録済み</button>`
    : `<button class="button" type="button" id="register-passkey">Passkey を追加</button>`;
  const githubControl = authState.hasGitHub
    ? `<button class="button secondary" type="button" disabled>GitHub 連携済み</button>`
    : `<a class="button secondary" href="/api/auth/github/start?redirectTo=%2Fsettings">GitHub を連携</a>`;
  const installControl = authEnv.GITHUB_APP_SLUG
    ? `<a class="button secondary" href="https://github.com/apps/${encodeURIComponent(authEnv.GITHUB_APP_SLUG)}/installations/new">GitHub App をインストール</a>`
    : `<button class="button secondary" type="button" disabled>GitHub App 未設定</button>`;
  const repositoryControls =
    repositories.length === 0
      ? `<p class="muted">インストール済み repository はありません。</p>`
      : `<form method="post" class="repo-form">
${repositories.map(buildRepositoryCheckbox).join("\n")}
<button class="button" type="submit">保存</button>
</form>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>設定 - Hosonan</title>
${buildInlineStyle(`
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6;background:#f7f7f8;color:#1f2328}
.settings{width:min(100% - 32px,720px);margin:0 auto;padding:48px 0}
.settings h1{margin:0 0 10px;font-size:1.7rem;line-height:1.2}
.account{margin:0 0 24px;color:#57606a}
.section{padding:20px 0;border-top:1px solid #d0d7de}
.section h2{margin:0 0 12px;font-size:1.1rem}
.actions{display:flex;flex-wrap:wrap;gap:10px}
.repo-form{display:grid;gap:12px}
.repo-row{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;padding:12px 0;border-top:1px solid #d8dee4}
.repo-row:first-child{border-top:0}
.repo-row input{margin-top:.25em}
.repo-name{display:block;font-weight:600;overflow-wrap:anywhere}
.repo-state{display:block;color:#57606a;font-size:.9rem}
.button{min-height:42px;border:1px solid #0969da;border-radius:6px;padding:8px 12px;font:inherit;font-weight:600;background:#0969da;color:#fff;cursor:pointer;text-decoration:none}
.button.secondary{border-color:#d0d7de;background:#fff;color:#1f2328}
.button:disabled{border-color:#d0d7de;background:#eaeef2;color:#57606a;cursor:default}
.status,.muted{min-height:1.5em;color:#57606a}
@media (prefers-color-scheme:dark){:root{background:#0d1117;color:#f0f6fc}.account,.status,.muted,.repo-state{color:#8b949e}.section,.repo-row{border-color:#30363d}.button.secondary{border-color:#30363d;background:#161b22;color:#f0f6fc}.button:disabled{border-color:#30363d;background:#21262d;color:#8b949e}}
`)}
</head>
<body>
<main class="settings">
<h1>設定</h1>
<p class="account">${escapeHtml(accountLabel(user))}</p>
<section class="section">
<h2>認証方法</h2>
<div class="actions">
${passkeyControl}
${githubControl}
</div>
</section>
<section class="section">
<h2>GitHub App</h2>
<div class="actions">
${installControl}
</div>
</section>
<section class="section">
<h2>同期する repository</h2>
${repositoryControls}
</section>
<p class="status" id="status"></p>
</main>
${authState.hasPasskey ? "" : settingsPasskeyScript()}
</body>
</html>`;
}

function buildRepositoryCheckbox(repository: SettingsRepository): string {
  const checked = repository.sync_enabled === 1 ? " checked" : "";
  const disabled = repository.status === "active" ? "" : " disabled";
  const statusText = repository.status === "active" ? "配信可能" : "GitHub 側で配信不可";
  return `<label class="repo-row">
<input type="checkbox" name="sync_repository_id" value="${repository.repository_id}"${checked}${disabled}>
<span><span class="repo-name">${escapeHtml(repository.full_name)}</span><span class="repo-state">${escapeHtml(statusText)}</span></span>
</label>`;
}

function settingsPasskeyScript(): string {
  return `<script type="module">
import { startRegistration } from "https://esm.sh/@simplewebauthn/browser@13.3.0";
const status = document.querySelector("#status");
function setStatus(message){ status.textContent = message; }
async function postJson(path, body){
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "request_failed");
  return json;
}
document.querySelector("#register-passkey").addEventListener("click", async () => {
  try {
    setStatus("登録しています");
    const options = await postJson("/api/auth/passkey/register/options", {});
    const response = await startRegistration({ optionsJSON: options });
    await postJson("/api/auth/passkey/register/verify", { response });
    location.reload();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "登録できませんでした");
  }
});
</script>`;
}

function accountLabel(user: UserRecord): string {
  return user.display_name ?? "アカウント";
}

function webAuthnCredentialFromRecord(record: PasskeyCredentialRecord): WebAuthnCredential {
  return {
    id: record.credential_id,
    publicKey: base64UrlToBytes(record.public_key) as Uint8Array<ArrayBuffer>,
    counter: record.counter,
    transports: parseTransports(record.transports)
  };
}

function parseTransports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as AuthenticatorTransportFuture[]) : undefined;
  } catch {
    return undefined;
  }
}

function challengeFromAuthenticationResponse(response: AuthenticationResponseJSON): string | null {
  try {
    const clientData = JSON.parse(new TextDecoder().decode(base64UrlToBytes(response.response.clientDataJSON)));
    return typeof clientData.challenge === "string" ? clientData.challenge : null;
  } catch {
    return null;
  }
}

function challengeFromRegistrationResponse(response: RegistrationResponseJSON): string | null {
  try {
    const clientData = JSON.parse(new TextDecoder().decode(base64UrlToBytes(response.response.clientDataJSON)));
    return typeof clientData.challenge === "string" ? clientData.challenge : null;
  } catch {
    return null;
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeRedirectPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function sessionTokenFromRequest(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) {
    return null;
  }

  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return valueParts.join("=") || null;
    }
  }
  return null;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function expiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function methodNotAllowed(methods: string[]): Response {
  return new Response("method not allowed\n", {
    status: 405,
    headers: {
      Allow: methods.join(", "),
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function jsonResponse(value: unknown, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}

function originFromRequest(request: Request): string {
  return new URL(request.url).origin;
}

function rpIdFromRequest(request: Request): string {
  return new URL(request.url).hostname;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomToken(bytes = 24): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return bytesToBase64Url(array);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function buildHtmlDocumentStream(article: ServedArticlePath, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(buildHtmlDocumentPrefix(article)));

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          controller.enqueue(value);
        }

        controller.enqueue(encoder.encode(buildHtmlDocumentSuffix()));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

function textResponse(body: string, status: number, method: string): Response {
  const response = new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
  return responseForMethod(response, method);
}

function responseForMethod(response: Response, method: string): Response {
  if (method !== "HEAD") {
    return response;
  }

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function getDefaultCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}
