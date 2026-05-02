import { buildArticleR2Key, matchArticleMarkdownPath } from "@ai-generated-articles/site-shared";
import { convertMarkdownToHtmlFragment } from "./markdown";
import { createInstallationAccessToken, fetchMarkdownAtCommit, verifyGitHubSignature } from "./github";
import type { ArticlePath, Env, GitHubPushPayload } from "./types";

export function matchArticlePath(path: string): ArticlePath | null {
  return matchArticleMarkdownPath(path);
}

export function r2Key(ownerLogin: string, article: ArticlePath): string {
  return buildArticleR2Key(ownerLogin, article);
}

async function handlePush(payload: GitHubPushPayload, env: Env): Promise<Response> {
  if (!payload.installation?.id || !payload.commits?.length) {
    return new Response("ignored\n", { status: 202 });
  }

  const ownerLogin = payload.repository.owner.login;
  const repoName = payload.repository.name;
  let token: string | undefined;
  let putCount = 0;
  let deleteCount = 0;

  for (const commit of payload.commits) {
    for (const path of [...(commit.added ?? []), ...(commit.modified ?? [])]) {
      const article = matchArticlePath(path);
      if (!article) {
        continue;
      }

      token ??= await createInstallationAccessToken(env, payload.installation.id);
      const markdown = await fetchMarkdownAtCommit(ownerLogin, repoName, article.path, commit.id, token);
      const html = convertMarkdownToHtmlFragment(markdown);
      await env.ARTICLES_BUCKET.put(r2Key(ownerLogin, article), html, {
        httpMetadata: {
          contentType: "text/html; charset=utf-8"
        }
      });
      putCount += 1;
    }

    for (const path of commit.removed ?? []) {
      const article = matchArticlePath(path);
      if (!article) {
        continue;
      }
      await env.ARTICLES_BUCKET.delete(r2Key(ownerLogin, article));
      deleteCount += 1;
    }
  }

  return Response.json({ put: putCount, deleted: deleteCount });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed\n", { status: 405 });
    }

    const rawBody = await request.text();
    const validSignature = await verifyGitHubSignature(rawBody, request.headers.get("x-hub-signature-256"), env.WEBHOOK_SECRET);
    if (!validSignature) {
      return new Response("unauthorized\n", { status: 401 });
    }

    const event = request.headers.get("x-github-event");
    if (event !== "push") {
      return new Response("ignored\n", { status: 202 });
    }

    const payload = JSON.parse(rawBody) as GitHubPushPayload;
    return handlePush(payload, env);
  }
};
