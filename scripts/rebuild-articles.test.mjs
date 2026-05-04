import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVE_REPOSITORIES_SQL, listActiveRepositories, main } from "./rebuild-articles.mjs";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  CLOUDFLARE_API_TOKEN: "token",
  HOSONAN_GITHUB_REGISTRY_DATABASE_ID: "database-id",
  HOSONAN_ARTICLE_RENDER_QUEUE_ID: "queue-id"
};

describe("rebuild-articles", () => {
  it("queries active, non-archived repositories with active installations", async () => {
    const requests = [];
    const repositories = await listActiveRepositories("account-id", "token", "database-id", async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        success: true,
        result: [
          {
            results: [
              {
                repositoryId: 42,
                ownerLogin: "octo",
                repoName: "articles",
                installationId: 123,
                targetBranch: "main"
              }
            ]
          }
        ]
      });
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id/query");
    const body = JSON.parse(requests[0].init.body);
    assert.match(body.sql, /i\.status = 'active'/);
    assert.match(body.sql, /r\.status = 'active'/);
    assert.match(body.sql, /r\.archived = 0/);
    assert.equal(body.sql, ACTIVE_REPOSITORIES_SQL);
    assert.deepEqual(repositories, [
      {
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main"
      }
    ]);
  });

  it("prints a dry-run summary without queueing messages", async () => {
    const requests = [];
    const logs = [];

    await main(["--dry-run"], env, { log: (message) => logs.push(message) }, async (url, init) => {
      requests.push({ url, init });
      const sql = JSON.parse(init.body).sql;
      if (sql.includes("COUNT(*)")) {
        return jsonResponse({ success: true, result: [{ results: [{ count: 1 }] }] });
      }
      return jsonResponse({ success: true, result: [{ results: [repositoryRow()] }] });
    });

    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => !request.url.includes("/queues/")));
    assert.deepEqual(logs, ["対象リポジトリ数: 1", "- octo/articles repositoryId=42 installationId=123 targetBranch=main"]);
  });

  it("queues rebuild_repository messages for each active repository in order", async () => {
    const queued = [];
    const logs = [];

    await main([], env, { log: (message) => logs.push(message) }, async (url, init) => {
      if (url.includes("/d1/database/")) {
        return jsonResponse({
          success: true,
          result: [
            {
              results: [
                repositoryRow(),
                {
                  repositoryId: 43,
                  ownerLogin: "octo",
                  repoName: "notes",
                  installationId: 123,
                  targetBranch: "trunk"
                }
              ]
            }
          ]
        });
      }

      queued.push(JSON.parse(init.body).body);
      return jsonResponse({ success: true, result: {} });
    });

    assert.deepEqual(queued, [
      {
        type: "rebuild_repository",
        repositoryId: 42,
        ownerLogin: "octo",
        repoName: "articles",
        installationId: 123,
        targetBranch: "main"
      },
      {
        type: "rebuild_repository",
        repositoryId: 43,
        ownerLogin: "octo",
        repoName: "notes",
        installationId: 123,
        targetBranch: "trunk"
      }
    ]);
    assert.deepEqual(logs, [
      "queued rebuild_repository for octo/articles",
      "queued rebuild_repository for octo/notes",
      "queued 2 rebuild_repository messages to hosonan-article-render"
    ]);
  });

  it("includes the failed repository in queueing errors", async () => {
    await assert.rejects(
      main([], env, { log: () => undefined }, async (url) => {
        if (url.includes("/d1/database/")) {
          return jsonResponse({ success: true, result: [{ results: [repositoryRow()] }] });
        }
        return jsonResponse({ success: false, errors: [{ message: "queue failed" }] }, { status: 500 });
      }),
      /Failed to queue rebuild_repository for octo\/articles \(repositoryId=42\)/
    );
  });
});

function repositoryRow() {
  return {
    repositoryId: 42,
    ownerLogin: "octo",
    repoName: "articles",
    installationId: 123,
    targetBranch: "main"
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" }
  });
}
