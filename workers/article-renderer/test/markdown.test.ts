import { describe, expect, it } from "vitest";
import { convertMarkdownToHtmlFragment } from "../src/markdown";

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

  it("sanitizes unsupported raw HTML instead of failing conversion", () => {
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
    expect(html).toContain("<p>middle raw</p>");
    expect(html).toContain("<p>after</p>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
  });

  it("drops unsupported raw HTML blocks and strips unsupported inline attributes", () => {
    const html = convertMarkdownToHtmlFragment([
      "<iframe src=\"https://example.com/embed\">embed</iframe>",
      "",
      "<span style=\"color: red\" onclick=\"alert(1)\" data-extra=\"x\">inline</span>",
      "",
      "<section hidden aria-label=\"note\">section text</section>"
    ].join("\n"));

    expect(html).toBe("<p>inline</p>");
    expect(html).not.toContain("embed");
    expect(html).not.toContain("section text");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<span");
    expect(html).not.toContain("<section");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("onclick=");
    expect(html).not.toContain("data-extra=");
    expect(html).not.toContain("hidden");
    expect(html).not.toContain("aria-label");
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
