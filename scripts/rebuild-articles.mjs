#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_QUEUE_NAME = "hosonan-article-render";
const DEFAULT_D1_DATABASE_NAME = "hosonan-github-registry";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  CLOUDFLARE_ACCOUNT_ID or CF_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN or CF_API_TOKEN
  HOSONAN_ARTICLE_RENDER_QUEUE_ID or CLOUDFLARE_QUEUE_ID
  HOSONAN_GITHUB_REGISTRY_DATABASE_ID or CLOUDFLARE_D1_DATABASE_ID
`;

if (isMainModule()) {
  try {
    await main(process.argv.slice(2), process.env, console, fetch);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function main(argv, env, io, fetchImpl) {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    io.log(USAGE);
    return;
  }

  const accountId = requiredEnv(env, "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID");
  const token = requiredEnv(env, "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN");
  const databaseId = await resolveD1DatabaseId(accountId, token, env, fetchImpl);
  const repositories = await listActiveRepositories(accountId, token, databaseId, fetchImpl);

  if (args.has("--dry-run")) {
    const count = await countActiveRepositories(accountId, token, databaseId, fetchImpl);
    io.log(`対象リポジトリ数: ${count}`);
    for (const repository of repositories) {
      io.log(
        `- ${repository.ownerLogin}/${repository.repoName} repositoryId=${repository.repositoryId} installationId=${repository.installationId} targetBranch=${repository.targetBranch}`
      );
    }
    return;
  }

  const queueId =
    optionalEnv(env, "HOSONAN_ARTICLE_RENDER_QUEUE_ID", "CLOUDFLARE_QUEUE_ID") ??
    (await findQueueId(accountId, token, DEFAULT_QUEUE_NAME, fetchImpl));

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

  io.log(`queued ${repositories.length} rebuild_repository messages to ${DEFAULT_QUEUE_NAME}`);
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

function requiredEnv(env, ...names) {
  const value = optionalEnv(env, ...names);
  if (!value) {
    throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
  }
  return value;
}

async function resolveD1DatabaseId(accountId, token, env, fetchImpl) {
  return (
    optionalEnv(env, "HOSONAN_GITHUB_REGISTRY_DATABASE_ID", "CLOUDFLARE_D1_DATABASE_ID") ??
    (await readGitHubWebhookConfig()).d1DatabaseId ??
    (await findD1DatabaseId(accountId, token, DEFAULT_D1_DATABASE_NAME, fetchImpl))
  );
}

async function readGitHubWebhookConfig() {
  const raw = await readFile(resolve(ROOT, "workers/github-webhook/wrangler.jsonc"), "utf8");
  return {
    d1DatabaseId: matchJsoncString(raw, "database_id")
  };
}

function matchJsoncString(raw, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(raw);
  return match?.[1];
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
    throw new Error(`Queue id for ${queueName} was not found. Set HOSONAN_ARTICLE_RENDER_QUEUE_ID.`);
  }
  return id;
}

export async function findD1DatabaseId(accountId, token, databaseName, fetchImpl = fetch) {
  const body = await cfFetch(accountId, token, `/d1/database?name=${encodeURIComponent(databaseName)}`, {}, fetchImpl);
  const database = (body.result ?? []).find((item) => item.name === databaseName);
  const id = database?.uuid ?? database?.id;
  if (!id) {
    throw new Error(`D1 database id for ${databaseName} was not found. Set HOSONAN_GITHUB_REGISTRY_DATABASE_ID.`);
  }
  return id;
}

export async function countActiveRepositories(accountId, token, databaseId, fetchImpl = fetch) {
  const body = await cfFetch(accountId, token, `/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: COUNT_SQL })
  }, fetchImpl);
  const firstResult = Array.isArray(body.result) ? body.result[0] : body.result;
  const row = firstResult?.results?.[0] ?? firstResult?.result?.[0] ?? body.result?.[0];
  const count = Number(row?.count ?? row?.COUNT ?? 0);
  if (!Number.isFinite(count)) {
    throw new Error("D1 count query did not return a numeric count.");
  }
  return count;
}

export async function listActiveRepositories(accountId, token, databaseId, fetchImpl = fetch) {
  const body = await cfFetch(accountId, token, `/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: ACTIVE_REPOSITORIES_SQL })
  }, fetchImpl);
  const firstResult = Array.isArray(body.result) ? body.result[0] : body.result;
  const rows = firstResult?.results ?? firstResult?.result ?? [];
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
