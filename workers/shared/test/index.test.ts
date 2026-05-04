import { describe, expect, it } from "vitest";
import {
  ARTICLE_MARKDOWN_MAX_BYTES,
  ARTICLE_TITLE_MAX_CHARS,
  buildArticleR2Key,
  escapeHtml,
  matchArticleMarkdownPath,
  parseServedArticlePath,
  truncateArticleTitle
} from "../src/index";

describe("ARTICLE_MARKDOWN_MAX_BYTES", () => {
  it("sets the Markdown source limit to 1 MiB", () => {
    expect(ARTICLE_MARKDOWN_MAX_BYTES).toBe(1_048_576);
  });
});

describe("ARTICLE_TITLE_MAX_CHARS", () => {
  it("sets the public article title limit to 200 characters", () => {
    expect(ARTICLE_TITLE_MAX_CHARS).toBe(200);
  });
});

describe("truncateArticleTitle", () => {
  it("keeps titles at or below the article title limit unchanged", () => {
    expect(truncateArticleTitle("a".repeat(200))).toBe("a".repeat(200));
  });

  it("truncates titles longer than the article title limit", () => {
    expect(truncateArticleTitle("a".repeat(201))).toBe("a".repeat(200));
  });

  it("counts Unicode code points instead of UTF-16 code units", () => {
    expect(truncateArticleTitle("😀".repeat(201))).toBe("😀".repeat(200));
  });
});

describe("matchArticleMarkdownPath", () => {
  it("extracts article information from Markdown index paths", () => {
    expect(matchArticleMarkdownPath("articles/2026-05-02/example/index.md")).toEqual({
      date: "2026-05-02",
      slug: "example",
      path: "articles/2026-05-02/example/index.md"
    });
  });

  it("rejects non-article paths", () => {
    expect(matchArticleMarkdownPath("articles/2026-05-02/example/readme.md")).toBeNull();
    expect(matchArticleMarkdownPath("articles/2026-05-02/example/nested/index.md")).toBeNull();
  });
});

describe("buildArticleR2Key", () => {
  it("includes owner and repo in the R2 key", () => {
    expect(buildArticleR2Key("octo", "articles", { date: "2026-05-02", slug: "example" })).toBe(
      "gh/octo/articles/2026-05-02/example/index.html"
    );
  });
});

describe("parseServedArticlePath", () => {
  it("normalizes directory and index URLs to the same R2 key and canonical path", () => {
    const directory = parseServedArticlePath("/gh/octo/articles/2026-05-02/example/");
    const index = parseServedArticlePath("/gh/octo/articles/2026-05-02/example/index.html");

    expect(directory).toEqual(index);
    expect(directory).toMatchObject({
      owner: "octo",
      repo: "articles",
      date: "2026-05-02",
      slug: "example",
      r2Key: "gh/octo/articles/2026-05-02/example/index.html",
      canonicalPath: "/gh/octo/articles/2026-05-02/example/"
    });
  });

  it("rejects invalid served article URLs", () => {
    expect(parseServedArticlePath("/")).toBeNull();
    expect(parseServedArticlePath("/gh/octo/articles/2026/05/02/example/")).toBeNull();
    expect(parseServedArticlePath("/gh/octo/articles/20260502/example/")).toBeNull();
    expect(parseServedArticlePath("/gh/octo/articles/2026-05-02/example/extra")).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("escapes text for document metadata", () => {
    expect(escapeHtml(`a&b<"'>`)).toBe("a&amp;b&lt;&quot;&#39;&gt;");
  });
});
