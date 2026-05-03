export interface ArticlePath {
  date: string;
  slug: string;
  path: string;
}

export interface ServedArticlePath {
  owner: string;
  date: string;
  slug: string;
  r2Key: string;
  canonicalPath: string;
}

const ARTICLE_INDEX_RE = /^articles\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/index\.md$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function matchArticleMarkdownPath(path: string): ArticlePath | null {
  const match = ARTICLE_INDEX_RE.exec(path);
  if (!match) {
    return null;
  }

  return {
    date: match[1],
    slug: match[2],
    path
  };
}

export function buildArticleR2Key(ownerLogin: string, article: Pick<ArticlePath, "date" | "slug">): string {
  return `gh/${ownerLogin}/${article.date}/${article.slug}/index.html`;
}

export function parseServedArticlePath(pathname: string): ServedArticlePath | null {
  const rawSegments = pathname.split("/");
  if (rawSegments[0] !== "" || rawSegments[1] !== "gh") {
    return null;
  }

  const hasDirectoryPath = rawSegments.length === 6 && rawSegments[5] === "";
  const hasIndexPath = rawSegments.length === 6 && rawSegments[5] === "index.html";
  if (!hasDirectoryPath && !hasIndexPath) {
    return null;
  }

  const owner = decodePathSegment(rawSegments[2]);
  const date = decodePathSegment(rawSegments[3]);
  const slug = decodePathSegment(rawSegments[4]);
  if (!owner || !date || !slug || !DATE_RE.test(date)) {
    return null;
  }

  const r2Key = buildArticleR2Key(owner, { date, slug });
  return {
    owner,
    date,
    slug,
    r2Key,
    canonicalPath: `/${r2Key.replace(/\/index\.html$/, "/")}`
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodePathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") ? null : decoded;
  } catch {
    return null;
  }
}
