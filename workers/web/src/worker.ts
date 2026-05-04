import {
  buildRepositoryRawUrl,
  escapeHtml,
  parseServedArticlePath,
  validateChannelIconPath,
  type ServedArticlePath,
  type StoredArticle
} from "@hosonan/shared";
import { KISO_CSS } from "./kiso-css";

const CACHE_TTL_SECONDS = 300;
const HOME_ARTICLE_LIMIT = 10;

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
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
          "Content-Type": "text/plain; charset=utf-8"
        }
      });
    }

    const requestUrl = new URL(request.url);
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
     WHERE a.status = 'active' AND r.status = 'active'
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
