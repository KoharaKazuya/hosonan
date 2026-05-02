import { describe, expect, it } from "vitest";
import { convertMarkdownToHtmlFragment, MarkdownConversionError } from "../src/markdown";

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
  });

  it("fails when Markdown contains raw HTML", () => {
    expect(() => convertMarkdownToHtmlFragment("before\n\n<div>raw</div>")).toThrow(MarkdownConversionError);
    expect(() => convertMarkdownToHtmlFragment("before <span>raw</span>")).toThrow(MarkdownConversionError);
  });

  it("keeps only allowed URL protocols", () => {
    const html = convertMarkdownToHtmlFragment([
      "[secure](https://example.com)",
      "[mail](mailto:hello@example.com)",
      "[plain](http://example.com)",
      "[script](javascript:alert(1))",
      "[data](data:text/html,hello)",
      "[relative](/docs)"
    ].join("\n\n"));

    expect(html).toContain('<a href="https://example.com">secure</a>');
    expect(html).toContain('<a href="mailto:hello@example.com">mail</a>');
    expect(html).toContain("<a>plain</a>");
    expect(html).toContain("<a>script</a>");
    expect(html).toContain("<a>data</a>");
    expect(html).toContain("<a>relative</a>");
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
