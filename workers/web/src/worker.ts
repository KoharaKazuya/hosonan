import { escapeHtml, parseServedArticlePath, type ServedArticlePath } from "@hosonan/shared";

const CACHE_TTL_SECONDS = 300;

export function buildHtmlDocumentPrefix(article: ServedArticlePath): string {
  const title = escapeHtml(`${article.owner}/${article.slug}`);

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.7;background:#f7f7f8;color:#1f2328}
body{margin:0}
.article{box-sizing:border-box;width:min(100% - 32px,840px);margin:0 auto;padding:48px 0 72px}
.article :first-child{margin-top:0}
.article pre{overflow:auto;padding:16px;border-radius:6px;background:#24292f;color:#f6f8fa}
.article code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.article img,.article table{max-width:100%}
</style>
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
