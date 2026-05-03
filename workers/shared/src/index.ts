export interface ArticlePath {
  date: string;
  slug: string;
  path: string;
}

export interface ServedArticlePath {
  owner: string;
  repo: string;
  date: string;
  slug: string;
  r2Key: string;
  canonicalPath: string;
}

export interface ArticleIndexEntry extends ArticlePath {
  r2Key: string;
}

export interface RepoSyncQueueMessage {
  repositoryId: number;
  ownerLogin: string;
  repoName: string;
  installationId: number;
  targetBranch: string;
}

export interface RepoSyncNotification extends RepoSyncQueueMessage {
  targetCommit: string;
}

export interface RepoSyncClaim {
  status: "claimed" | "busy" | "idle" | "retry_later";
  leaseId?: string;
  leaseExpiresAt?: number;
  retryAfterSeconds?: number;
  repositoryId?: number;
  ownerLogin?: string;
  repoName?: string;
  installationId?: number;
  targetBranch?: string;
  targetCommit?: string;
  lastSyncedCommit?: string;
  lastArticleIndex?: ArticleIndexEntry[];
}

export interface RepoSyncCompleteResult {
  syncedCommit: string;
  articleIndex: ArticleIndexEntry[];
}

export interface RepoSyncFailure {
  message: string;
  retryAt?: number;
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

export function buildArticleR2Key(ownerLogin: string, repoName: string, article: Pick<ArticlePath, "date" | "slug">): string {
  return `gh/${ownerLogin}/${repoName}/${article.date}/${article.slug}/index.html`;
}

export function parseServedArticlePath(pathname: string): ServedArticlePath | null {
  const rawSegments = pathname.split("/");
  if (rawSegments[0] !== "" || rawSegments[1] !== "gh") {
    return null;
  }

  const hasDirectoryPath = rawSegments.length === 7 && rawSegments[6] === "";
  const hasIndexPath = rawSegments.length === 7 && rawSegments[6] === "index.html";
  if (!hasDirectoryPath && !hasIndexPath) {
    return null;
  }

  const owner = decodePathSegment(rawSegments[2]);
  const repo = decodePathSegment(rawSegments[3]);
  const date = decodePathSegment(rawSegments[4]);
  const slug = decodePathSegment(rawSegments[5]);
  if (!owner || !repo || !date || !slug || !DATE_RE.test(date)) {
    return null;
  }

  const r2Key = buildArticleR2Key(owner, repo, { date, slug });
  return {
    owner,
    repo,
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
