import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVE_REPOSITORIES_SQL, listActiveRepositories, main } from "./rebuild-articles.mjs";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "account-id"
};

describe("rebuild-articles", () => {
  it("queries active, non-archived repositories with active installations through wrangler", async () => {
    const commands = [];
    const repositories = await listActiveRepositories(async (args) => {
      commands.push(args);
      return JSON.stringify([
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
      ]);
    });

    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].slice(0, 8), [
      "d1",
      "execute",
      "GITHUB_REGISTRY",
      "--config",
      "workers/github-webhook/wrangler.jsonc",
      "--remote",
      "--json",
      "--command"
    ]);
    assert.match(commands[0][8], /i\.status = 'active'/);
    assert.match(commands[0][8], /r\.status = 'active'/);
    assert.match(commands[0][8], /r\.archived = 0/);
    assert.equal(commands[0][8], ACTIVE_REPOSITORIES_SQL);
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
    const commands = [];
    const requests = [];
    const logs = [];

    await main(["--dry-run"], env, { log: (message) => logs.push(message) }, {
      runCommand: async (args) => {
        commands.push(args);
        const sql = args.at(-1);
        if (sql.includes("COUNT(*)")) {
          return JSON.stringify([{ results: [{ count: 1 }] }]);
        }
        return JSON.stringify({ result: [{ results: [repositoryRow()] }] });
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ success: true, result: {} });
      }
    });

    assert.equal(commands.length, 2);
    assert.ok(commands.every((command) => command[0] === "d1" && command[1] === "execute"));
    assert.equal(requests.length, 0);
    assert.deepEqual(logs, ["対象リポジトリ数: 1", "- octo/articles repositoryId=42 installationId=123 targetBranch=main"]);
  });

  it("queues rebuild_repository messages for each active repository in order", async () => {
    const queued = [];
    const logs = [];

    await main([], env, { log: (message) => logs.push(message) }, {
      runCommand: async (args) => {
        if (args[0] === "auth") {
          return JSON.stringify({ type: "oauth", oauth: "token" });
        }
        if (args[0] === "d1") {
          return JSON.stringify([
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
          ]);
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      fetchImpl: async (url, init) => {
        if (url.endsWith("/queues")) {
          return jsonResponse({ success: true, result: [{ queue_name: "hosonan-article-render", queue_id: "queue-id" }] });
        }

        queued.push(JSON.parse(init.body).body);
        return jsonResponse({ success: true, result: {} });
      }
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

  it("resolves account id from wrangler whoami when the environment does not specify one", async () => {
    const urls = [];

    await main([], {}, { log: () => undefined }, {
      runCommand: async (args) => {
        if (args[0] === "auth") {
          return JSON.stringify({ type: "api_token", api_token: "token" });
        }
        if (args[0] === "whoami") {
          return JSON.stringify({ accounts: [{ id: "account-from-wrangler", name: "example" }] });
        }
        if (args[0] === "d1") {
          return JSON.stringify([{ results: [repositoryRow()] }]);
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.endsWith("/queues")) {
          return jsonResponse({ success: true, result: [{ queue_name: "hosonan-article-render", queue_id: "queue-id" }] });
        }
        return jsonResponse({ success: true, result: {} });
      }
    });

    assert.ok(urls.every((url) => url.includes("/accounts/account-from-wrangler/")));
  });

  it("includes the failed repository in queueing errors", async () => {
    await assert.rejects(
      main([], env, { log: () => undefined }, {
        runCommand: async (args) => {
          if (args[0] === "auth") {
            return JSON.stringify({ type: "oauth", oauth: "token" });
          }
          if (args[0] === "d1") {
            return JSON.stringify([{ results: [repositoryRow()] }]);
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        fetchImpl: async (url) => {
          if (url.endsWith("/queues")) {
            return jsonResponse({ success: true, result: [{ queue_name: "hosonan-article-render", queue_id: "queue-id" }] });
          }
          return jsonResponse({ success: false, errors: [{ message: "queue failed" }] }, { status: 500 });
        }
      }),
      /Failed to queue rebuild_repository for octo\/articles \(repositoryId=42\)/
    );
  });

  it("rejects wrangler api_key credentials because they are not Bearer tokens", async () => {
    await assert.rejects(
      main([], env, { log: () => undefined }, {
        runCommand: async (args) => {
          if (args[0] === "auth") {
            return JSON.stringify({ type: "api_key", api_key: "key" });
          }
          if (args[0] === "d1") {
            return JSON.stringify([{ results: [repositoryRow()] }]);
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        fetchImpl: async () => jsonResponse({ success: true, result: {} })
      }),
      /api_key credentials/
    );
  });

  it("reports wrangler auth failures as login problems", async () => {
    await assert.rejects(
      main([], env, { log: () => undefined }, {
        runCommand: async (args) => {
          if (args[0] === "auth") {
            throw new Error("not logged in");
          }
          if (args[0] === "d1") {
            return JSON.stringify([{ results: [repositoryRow()] }]);
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        fetchImpl: async () => jsonResponse({ success: true, result: {} })
      }),
      /Wrangler is not logged in/
    );
  });

  it("reports invalid wrangler auth JSON clearly", async () => {
    await assert.rejects(
      main([], env, { log: () => undefined }, {
        runCommand: async (args) => {
          if (args[0] === "auth") {
            return "not json";
          }
          if (args[0] === "d1") {
            return JSON.stringify([{ results: [repositoryRow()] }]);
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        fetchImpl: async () => jsonResponse({ success: true, result: {} })
      }),
      /wrangler auth token --json returned invalid JSON/
    );
  });

  it("requires account id environment variable when wrangler has multiple accounts", async () => {
    await assert.rejects(
      main([], {}, { log: () => undefined }, {
        runCommand: async (args) => {
          if (args[0] === "auth") {
            return JSON.stringify({ type: "oauth", oauth: "token" });
          }
          if (args[0] === "whoami") {
            return JSON.stringify({ accounts: [{ id: "account-a" }, { id: "account-b" }] });
          }
          if (args[0] === "d1") {
            return JSON.stringify([{ results: [repositoryRow()] }]);
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        fetchImpl: async () => jsonResponse({ success: true, result: {} })
      }),
      /Multiple Cloudflare accounts/
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
