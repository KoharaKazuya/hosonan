import { matchArticleMarkdownPath, type ArticlePath } from "@hosonan/shared";

const textEncoder = new TextEncoder();

export interface GitHubChangedFile {
  filename: string;
  previous_filename?: string;
  status: string;
}

export interface GitHubCompareResult {
  ok: boolean;
  files: GitHubChangedFile[];
  retryAt?: number;
}

export interface GitHubArticleFile extends ArticlePath {
  sha?: string;
}

export async function fetchDefaultBranchHead(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<string> {
  const url = repoApiUrl(owner, repo, `commits/${encodeURIComponent(branch)}`);
  const response = await githubFetch(url, tokenHeaders(`Bearer ${token}`));
  if (!response.ok) {
    throw githubError("Failed to fetch GitHub default branch head", response);
  }

  const body = (await response.json()) as { sha?: string };
  if (!body.sha) {
    throw new Error("GitHub commit response did not include sha.");
  }
  return body.sha;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replaceAll("\\n", "\n");
}

function derLength(length: number): number[] {
  if (length < 0x80) {
    return [length];
  }

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }

  return [0x80 | bytes.length, ...bytes];
}

function derSequence(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  return new Uint8Array([0x30, ...derLength(length), ...parts.flatMap((part) => [...part])]);
}

function derOctetString(value: Uint8Array): Uint8Array {
  return new Uint8Array([0x04, ...derLength(value.length), ...value]);
}

function wrapPkcs1RsaPrivateKey(pkcs1Der: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaEncryptionAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  ]);

  return derSequence(version, rsaEncryptionAlgorithmIdentifier, derOctetString(pkcs1Der));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function importPrivateKey(privateKey: string): Promise<CryptoKey> {
  const normalized = normalizePrivateKey(privateKey);
  const isPkcs1RsaKey = normalized.includes("-----BEGIN RSA PRIVATE KEY-----");
  const pem = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace("-----BEGIN RSA PRIVATE KEY-----", "")
    .replace("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const decodedDer = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const der = isPkcs1RsaKey ? wrapPkcs1RsaPrivateKey(decodedDer) : decodedDer;

  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(der),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

export async function createGitHubAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: env.GITHUB_APP_ID
  };
  const unsignedToken = `${base64Url(textEncoder.encode(JSON.stringify(header)))}.${base64Url(
    textEncoder.encode(JSON.stringify(payload))
  )}`;
  const key = await importPrivateKey(env.GITHUB_PRIVATE_KEY);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, textEncoder.encode(unsignedToken));

  return `${unsignedToken}.${base64Url(signature)}`;
}

export async function createInstallationAccessToken(env: Env, installationId: number): Promise<string> {
  const jwt = await createGitHubAppJwt(env);
  const response = await githubFetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, tokenHeaders(`Bearer ${jwt}`, "POST"));

  if (!response.ok) {
    throw new Error(`Failed to create GitHub installation token: ${response.status}`);
  }

  const body = (await response.json()) as { token?: string };
  if (!body.token) {
    throw new Error("GitHub installation token response did not include token.");
  }
  return body.token;
}

export async function compareCommits(
  owner: string,
  repo: string,
  baseCommit: string,
  headCommit: string,
  token: string
): Promise<GitHubCompareResult> {
  const url = repoApiUrl(owner, repo, `compare/${encodeURIComponent(baseCommit)}...${encodeURIComponent(headCommit)}`);
  const response = await githubFetch(url, tokenHeaders(`Bearer ${token}`));
  if (response.status === 404 || response.status === 409) {
    return { ok: false, files: [] };
  }
  if (response.status === 403 || response.status === 429) {
    return { ok: false, files: [], retryAt: rateLimitRetryAt(response) };
  }
  if (!response.ok) {
    return { ok: false, files: [] };
  }

  const body = (await response.json()) as {
    status?: string;
    ahead_by?: number;
    files?: GitHubChangedFile[];
  };
  if (body.status === "diverged" || (body.ahead_by ?? 0) > 250 || !body.files || body.files.length >= 300) {
    return { ok: false, files: [] };
  }

  return { ok: true, files: body.files };
}

export async function listArticleFilesAtCommit(
  owner: string,
  repo: string,
  commitSha: string,
  token: string
): Promise<GitHubArticleFile[]> {
  const url = repoApiUrl(owner, repo, `git/trees/${encodeURIComponent(commitSha)}?recursive=1`);
  const response = await githubFetch(url, tokenHeaders(`Bearer ${token}`));
  if (!response.ok) {
    throw githubError("Failed to list GitHub tree", response);
  }

  const body = (await response.json()) as {
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; sha?: string }>;
  };
  if (body.truncated) {
    throw new Error("GitHub tree response was truncated.");
  }

  return (body.tree ?? []).flatMap((entry) => {
    if (entry.type !== "blob" || !entry.path) {
      return [];
    }

    const article = matchArticleMarkdownPath(entry.path);
    return article ? [{ ...article, sha: entry.sha }] : [];
  });
}

export async function fetchMarkdownAtCommit(
  owner: string,
  repo: string,
  path: string,
  commitSha: string,
  token: string
): Promise<string> {
  const url = repoApiUrl(
    owner,
    repo,
    `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(commitSha)}`
  );
  const response = await githubFetch(url, {
    headers: {
      Accept: "application/vnd.github.raw",
      Authorization: `Bearer ${token}`,
      "User-Agent": "hosonan-worker",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  if (!response.ok) {
    throw githubError("Failed to fetch Markdown from GitHub", response);
  }

  return response.text();
}

export function rateLimitRetryAt(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Date.now() + seconds * 1000;
    }
  }

  const reset = response.headers.get("x-ratelimit-reset");
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds)) {
      return seconds * 1000;
    }
  }

  return undefined;
}

function repoApiUrl(owner: string, repo: string, path: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`;
}

function tokenHeaders(authorization: string, method = "GET"): RequestInit {
  return {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: authorization,
      "User-Agent": "hosonan-worker",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  };
}

function githubFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function githubError(message: string, response: Response): Error {
  const error = new Error(`${message}: ${response.status}`);
  const retryAt = rateLimitRetryAt(response);
  if (retryAt) {
    (error as Error & { retryAt?: number }).retryAt = retryAt;
  }
  return error;
}
