import { describe, expect, it } from "vitest";
import { convertMarkdownToHtmlFragment, extractMarkdownCreatedAt, extractMarkdownTitle } from "../src/markdown";

describe("convertMarkdownToHtmlFragment", () => {
  it("removes frontmatter from rendered HTML", () => {
    const html = convertMarkdownToHtmlFragment("---\ntitle: Test\n---\n# Hello");

    expect(html).toContain('<h1 id="hello">Hello</h1>');
    expect(html).not.toContain("title:");
  });

  it("renders GFM-like tables, task lists, strikethrough, autolinks, and footnotes", () => {
    const html = convertMarkdownToHtmlFragment([
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "- [x] done",
      "",
      "~~old~~ https://example.com note[^1]",
      "",
      "[^1]: footnote"
    ].join("\n"));

    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
    expect(html).toContain("footnote");
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).toContain('aria-label="Back to reference 1"');
    expect(html).toContain("data-footnote-backref");
  });

  it("sanitizes raw HTML instead of failing conversion", () => {
    const html = convertMarkdownToHtmlFragment([
      "before",
      "",
      "<script>alert(1)</script>",
      "",
      "middle <span onclick=\"alert(1)\">raw</span>",
      "",
      "after"
    ].join("\n"));

    expect(html).toContain("<p>before</p>");
    expect(html).toContain("<p>middle <span>raw</span></p>");
    expect(html).toContain("<p>after</p>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
  });

  it("drops unsupported raw HTML and strips unsupported attributes", () => {
    const html = convertMarkdownToHtmlFragment([
      "<iframe src=\"https://example.com/embed\">embed</iframe>",
      "",
      "<span style=\"color: red\" onclick=\"alert(1)\" data-extra=\"x\">inline</span>",
      "",
      "<section hidden aria-label=\"note\">section text</section>"
    ].join("\n"));

    expect(html).toBe("embed\n<p><span>inline</span></p>\n<section>section text</section>");
    expect(html).toContain("<span>inline</span>");
    expect(html).toContain("<section>section text</section>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("onclick=");
    expect(html).not.toContain("data-extra=");
    expect(html).not.toContain("hidden");
    expect(html).not.toContain("aria-label");
  });

  it("keeps GitHub-style details and summary disclosure blocks", () => {
    const html = convertMarkdownToHtmlFragment([
      "<details open>",
      "<summary>Read more</summary>",
      "",
      "Hidden **markdown** body.",
      "",
      "</details>"
    ].join("\n"));

    expect(html).toContain("<details open>");
    expect(html).toContain("<summary>Read more</summary>");
    expect(html).toContain("<p>Hidden <strong>markdown</strong> body.</p>");
    expect(html).toContain("</details>");
  });

  it("strips unsafe disclosure attributes and unsupported raw HTML", () => {
    const html = convertMarkdownToHtmlFragment([
      "<details onclick=\"alert(1)\">",
      "<summary>Unsafe wrapper</summary>",
      "",
      "body",
      "",
      "</details>",
      "",
      "<summary onclick=\"alert(1)\">Unsafe summary</summary>",
      "",
      "<script>alert(1)</script>"
    ].join("\n"));

    expect(html).toContain("<p>body</p>");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Unsafe wrapper</summary>");
    expect(html).toContain("<summary>Unsafe summary</summary>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
  });

  it("keeps only allowed URL protocols", () => {
    const html = convertMarkdownToHtmlFragment([
      "[secure](https://example.com)",
      "[mail](mailto:hello@example.com)",
      "[plain](http://example.com)",
      "[script](javascript:alert(1))",
      "[data](data:text/html,hello)",
      "[fragment](#footnote-label)",
      "[relative](/docs)"
    ].join("\n\n"));

    expect(html).toContain('<a href="https://example.com">secure</a>');
    expect(html).toContain('<a href="mailto:hello@example.com">mail</a>');
    expect(html).toContain('<a href="#footnote-label">fragment</a>');
    expect(html).toContain("<a>plain</a>");
    expect(html).toContain("<a>script</a>");
    expect(html).toContain("<a>data</a>");
    expect(html).toContain("<a>relative</a>");
  });

  it("removes unsupported image elements and unsafe image URL schemes", () => {
    const html = convertMarkdownToHtmlFragment([
      "before",
      "",
      "![secure](https://example.com/image.png)",
      "![plain](http://example.com/image.png)",
      "![script](javascript:alert(1))",
      "![data](data:image/png;base64,AAAA)",
      "![relative](/image.png)",
      "",
      "after"
    ].join("\n"));

    expect(html).toContain("<p>before</p>");
    expect(html).toContain("<p>after</p>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("https://example.com/image.png");
    expect(html).not.toContain("http://example.com/image.png");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("/image.png");
  });

  it("keeps supported link attributes only when the URL scheme is supported", () => {
    const html = convertMarkdownToHtmlFragment("[secure](https://example.com \"ignored title\")");

    expect(html).toBe('<p><a href="https://example.com">secure</a></p>');
  });

  it("adds stable heading ids and avoids duplicate collisions", () => {
    const html = convertMarkdownToHtmlFragment("## Same!\n\n## Same!\n\n## 日本語 見出し");

    expect(html).toContain('<h2 id="same">Same!</h2>');
    expect(html).toContain('<h2 id="same-1">Same!</h2>');
    expect(html).toContain('<h2 id="日本語-見出し">日本語 見出し</h2>');
  });

  it("adds syntax highlight classes to fenced code blocks", () => {
    const html = convertMarkdownToHtmlFragment("```ts\nconst value = 1;\n```");

    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain("hljs-keyword");
  });
});

describe("extractMarkdownTitle", () => {
  it("prefers frontmatter title, then heading, then fallback", () => {
    expect(extractMarkdownTitle("---\ntitle: Frontmatter title\n---\n# Heading title", "slug")).toBe("Frontmatter title");
    expect(extractMarkdownTitle("# Heading title", "slug")).toBe("Heading title");
    expect(extractMarkdownTitle("body only", "slug")).toBe("slug");
  });

  it("reads YAML frontmatter title values", () => {
    expect(extractMarkdownTitle("---\ntitle: \"Quoted title\"\n---\n# Heading", "slug")).toBe("Quoted title");
    expect(extractMarkdownTitle("---\ntitle: folded\n  title\n---\n# Heading", "slug")).toBe("folded title");
    expect(extractMarkdownTitle("---\ntitle: 42\n---\n# Heading", "slug")).toBe("42");
  });

  it("falls back when frontmatter YAML is invalid or title is not scalar", () => {
    expect(extractMarkdownTitle("---\ntitle: [unterminated\n---\n# Heading", "slug")).toBe("Heading");
    expect(extractMarkdownTitle("---\ntitle:\n  nested: value\n---\n# Heading", "slug")).toBe("Heading");
  });
});

describe("extractMarkdownCreatedAt", () => {
  it("reads RFC3339 frontmatter createdAt values at second precision", () => {
    expect(extractMarkdownCreatedAt("---\ncreatedAt: 2026-05-02T12:34:56Z\n---\n# Heading", "2026-05-02")).toBe(
      "2026-05-02T12:34:56Z"
    );
    expect(extractMarkdownCreatedAt("---\ncreatedAt: 2026-05-02T12:34:56+09:00\n---\n# Heading", "2026-05-02")).toBe(
      "2026-05-02T03:34:56Z"
    );
  });

  it("falls back to the path date when createdAt is missing or invalid", () => {
    expect(extractMarkdownCreatedAt("---\ntitle: Test\n---\n# Heading", "2026-05-02")).toBe("2026-05-02");
    expect(extractMarkdownCreatedAt("---\ncreatedAt: 2026-05-02\n---\n# Heading", "2026-05-02")).toBe("2026-05-02");
    expect(extractMarkdownCreatedAt("---\ncreatedAt: invalid\n---\n# Heading", "2026-05-02")).toBe("2026-05-02");
    expect(extractMarkdownCreatedAt("---\ncreatedAt: [2026-05-02T12:34:56Z]\n---\n# Heading", "2026-05-02")).toBe(
      "2026-05-02"
    );
  });
});
