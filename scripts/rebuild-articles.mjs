#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_QUEUE_NAME = "hosonan-article-render";
const DEFAULT_D1_BINDING = "GITHUB_REGISTRY";
const GITHUB_WEBHOOK_CONFIG = "workers/github-webhook/wrangler.jsonc";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

const COUNT_SQL = `
SELECT COUNT(*) AS count
FROM repositories r
INNER JOIN installations i ON i.installation_id = r.installation_id
WHERE i.status = 'active'
  AND r.status = 'active'
  AND r.archived = 0
`;

export const ACTIVE_REPOSITORIES_SQL = `
SELECT
  r.repository_id AS repositoryId,
  r.owner_login AS ownerLogin,
  r.repo_name AS repoName,
  r.installation_id AS installationId,
  r.default_branch AS targetBranch
FROM repositories r
INNER JOIN installations i ON i.installation_id = r.installation_id
WHERE i.status = 'active'
  AND r.status = 'active'
  AND r.archived = 0
ORDER BY r.repository_id
`;

const USAGE = `Usage: npm run rebuild:articles -- [--dry-run]

Environment:
  Optional: CLOUDFLARE_ACCOUNT_ID or CF_ACCOUNT_ID

Requirements:
  Log in to Wrangler before running this script.
`;

if (isMainModule()) {
  try {
    await main(process.argv.slice(2), process.env, console, { fetchImpl: fetch, runCommand: runWranglerCommand });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function main(argv, env, io, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const runCommand = options.runCommand ?? runWranglerCommand;
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    io.log(USAGE);
    return;
  }

  const config = await readGitHubWebhookConfig();
  const d1Binding = config.d1Binding ?? DEFAULT_D1_BINDING;
  const queueName = config.queueName ?? DEFAULT_QUEUE_NAME;
  const repositories = await listActiveRepositories(runCommand, d1Binding);

  if (args.has("--dry-run")) {
    const count = await countActiveRepositories(runCommand, d1Binding);
    io.log(`対象リポジトリ数: ${count}`);
    for (const repository of repositories) {
      io.log(
        `- ${repository.ownerLogin}/${repository.repoName} repositoryId=${repository.repositoryId} installationId=${repository.installationId} targetBranch=${repository.targetBranch}`
      );
    }
    return;
  }

  const { accountId, token } = await resolveCloudflareCredentials(env, runCommand);
  const queueId =
    optionalEnv(env, "HOSONAN_ARTICLE_RENDER_QUEUE_ID", "CLOUDFLARE_QUEUE_ID") ??
    (await findQueueId(accountId, token, queueName, fetchImpl));

  for (const repository of repositories) {
    try {
      await publishRebuildRepository(accountId, token, queueId, repository, fetchImpl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to queue rebuild_repository for ${repository.ownerLogin}/${repository.repoName} (repositoryId=${repository.repositoryId}): ${message}`
      );
    }
    io.log(`queued rebuild_repository for ${repository.ownerLogin}/${repository.repoName}`);
  }

  io.log(`queued ${repositories.length} rebuild_repository messages to ${queueName}`);
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

function optionalEnv(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (value) {
      return value;
    }
  }
  return undefined;
}

async function readGitHubWebhookConfig() {
  const raw = await readFile(resolve(ROOT, GITHUB_WEBHOOK_CONFIG), "utf8");
  return {
    d1Binding: matchJsoncString(raw, "binding", "d1_databases"),
    queueName: matchJsoncString(raw, "queue", "producers")
  };
}

function matchJsoncString(raw, key, afterKey) {
  const start = afterKey ? raw.indexOf(`"${afterKey}"`) : 0;
  if (start < 0) {
    return undefined;
  }
  const source = raw.slice(start);
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(source);
  return match?.[1];
}

async function runWranglerCommand(args) {
  const { stdout } = await execFileAsync("npx", ["wrangler", ...args], {
    cwd: ROOT,
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
}

async function runD1Query(runCommand, sql, d1Binding = DEFAULT_D1_BINDING) {
  const stdout = await runCommand([
    "d1",
    "execute",
    d1Binding,
    "--config",
    GITHUB_WEBHOOK_CONFIG,
    "--remote",
    "--json",
    "--command",
    sql
  ]);
  return parseWranglerD1Rows(stdout);
}

function parseWranglerD1Rows(stdout) {
  const body = parseJson(stdout, "Wrangler D1 query");
  const firstResult = Array.isArray(body) ? body[0] : Array.isArray(body.result) ? body.result[0] : body.result ?? body;
  return firstResult?.results ?? firstResult?.result ?? body.results ?? [];
}

async function resolveCloudflareCredentials(env, runCommand) {
  const token = await resolveWranglerBearerToken(runCommand);
  const accountId = optionalEnv(env, "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID") ?? (await resolveWranglerAccountId(runCommand));
  return { accountId, token };
}

async function resolveWranglerBearerToken(runCommand) {
  let stdout;
  try {
    stdout = await runCommand(["auth", "token", "--json"]);
  } catch (error) {
    throw new Error(`Wrangler is not logged in or could not provide an auth token: ${errorMessage(error)}`);
  }

  const body = parseJson(stdout, "wrangler auth token --json");
  const type = body.type ?? body.auth_type ?? body.token_type;
  if (type === "api_key") {
    throw new Error("wrangler auth token returned api_key credentials, which cannot be used as a Bearer token. Run wrangler login.");
  }

  const token = body.oauth ?? body.api_token ?? body.token ?? body.access_token;
  if (!token) {
    throw new Error("wrangler auth token --json did not return an oauth or api_token value. Run wrangler login.");
  }
  return token;
}

async function resolveWranglerAccountId(runCommand) {
  let stdout;
  try {
    stdout = await runCommand(["whoami", "--json"]);
  } catch (error) {
    throw new Error(`Failed to resolve Cloudflare account id from wrangler whoami --json: ${errorMessage(error)}`);
  }

  const body = parseJson(stdout, "wrangler whoami --json");
  const accounts = normalizeWranglerAccounts(body);
  if (accounts.length === 1 && accounts[0].id) {
    return accounts[0].id;
  }
  if (accounts.length > 1) {
    throw new Error("Multiple Cloudflare accounts are available. Set CLOUDFLARE_ACCOUNT_ID or CF_ACCOUNT_ID.");
  }
  throw new Error("wrangler whoami --json did not return a Cloudflare account id. Set CLOUDFLARE_ACCOUNT_ID or CF_ACCOUNT_ID.");
}

function normalizeWranglerAccounts(body) {
  if (Array.isArray(body)) {
    return body
      .map((account) => ({
        id: account?.id ?? account?.account_id,
        name: account?.name ?? account?.account_name
      }))
      .filter((account) => account.id);
  }

  if (body.id || body.account_id) {
    return [{ id: body.id ?? body.account_id, name: body.name ?? body.account_name }];
  }

  const candidates = body.accounts ?? body.account ?? body.result?.accounts ?? body.result?.account ?? [];
  const accounts = Array.isArray(candidates)
    ? candidates
    : Object.entries(candidates).map(([id, value]) => {
        if (typeof value === "string") {
          return { id, name: value };
        }
        return { ...value, id: value?.id ?? value?.account_id ?? id };
      });
  return accounts
    .map((account) => ({
      id: account?.id ?? account?.account_id,
      name: account?.name ?? account?.account_name
    }))
    .filter((account) => account.id);
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function cfFetch(accountId, token, path, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_BASE}/accounts/${accountId}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...init.headers
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok || body.success === false) {
    throw new Error(`Cloudflare API request failed: ${response.status} ${text}`);
  }
  return body;
}

export async function findQueueId(accountId, token, queueName, fetchImpl = fetch) {
  const body = await cfFetch(accountId, token, "/queues", {}, fetchImpl);
  const queue = (body.result ?? []).find((item) => item.queue_name === queueName || item.name === queueName);
  const id = queue?.queue_id ?? queue?.id;
  if (!id) {
    throw new Error(`Queue id for ${queueName} was not found.`);
  }
  return id;
}

export async function countActiveRepositories(runCommand, d1Binding = DEFAULT_D1_BINDING) {
  const rows = await runD1Query(runCommand, COUNT_SQL, d1Binding);
  const row = rows[0];
  const count = Number(row?.count ?? row?.COUNT ?? 0);
  if (!Number.isFinite(count)) {
    throw new Error("D1 count query did not return a numeric count.");
  }
  return count;
}

export async function listActiveRepositories(runCommand, d1Binding = DEFAULT_D1_BINDING) {
  const rows = await runD1Query(runCommand, ACTIVE_REPOSITORIES_SQL, d1Binding);
  return rows.map((row) => ({
    repositoryId: Number(row.repositoryId ?? row.repository_id),
    ownerLogin: String(row.ownerLogin ?? row.owner_login),
    repoName: String(row.repoName ?? row.repo_name),
    installationId: Number(row.installationId ?? row.installation_id),
    targetBranch: String(row.targetBranch ?? row.default_branch)
  }));
}

export async function publishRebuildRepository(accountId, token, queueId, repository, fetchImpl = fetch) {
  const message = {
    type: "rebuild_repository",
    repositoryId: repository.repositoryId,
    ownerLogin: repository.ownerLogin,
    repoName: repository.repoName,
    installationId: repository.installationId,
    targetBranch: repository.targetBranch
  };

  await cfFetch(accountId, token, `/queues/${queueId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: message })
  }, fetchImpl);
}
