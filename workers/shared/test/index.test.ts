import { describe, expect, it } from "vitest";
import { buildArticleR2Key, escapeHtml, matchArticleMarkdownPath, parseServedArticlePath } from "../src/index";

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
