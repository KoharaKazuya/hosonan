const GITHUB_WEBHOOK_PATHS = new Set(["/api/github/webhook", "/api/github/webhook/"]);
const AUTH_API_PREFIX = "/api/auth/";

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const { pathname } = new URL(request.url);

    if (GITHUB_WEBHOOK_PATHS.has(pathname)) {
      return env.GITHUB_WEBHOOK.fetch(request);
    }

    if (pathname.startsWith(AUTH_API_PREFIX)) {
      return env.WEB.fetch(request);
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return new Response("not found\n", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    return env.WEB.fetch(request);
  }
};
