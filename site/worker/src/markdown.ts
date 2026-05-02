import type { Element, Root } from "hast";
import type { Root as MdastRoot } from "mdast";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export class MarkdownConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownConversionError";
  }
}

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_RE, "");
}

function removeUnsafeUrls() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (typeof node.properties?.href === "string" && !isAllowedUrl(node.properties.href, ["https:", "mailto:"])) {
        delete node.properties.href;
      }

      if (typeof node.properties?.src === "string" && !isAllowedUrl(node.properties.src, ["https:"])) {
        delete node.properties.src;
      }
    });
  };
}

function failOnRawHtml() {
  return (tree: MdastRoot) => {
    visit(tree, "html", () => {
      throw new MarkdownConversionError("Raw HTML is not supported in article Markdown.");
    });
  };
}

function isAllowedUrl(value: string, protocols: string[]): boolean {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol);
  } catch {
    return false;
  }
}

const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "section",
    "span",
    "strong",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul"
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": ["className", "id"],
    a: ["href", "id", "className", "ariaDescribedBy", "dataFootnoteRef"],
    code: ["className"],
    input: ["checked", "className", "disabled", "type"],
    li: ["className"],
    ol: ["className"],
    span: ["className"],
    sup: ["id"],
    td: ["align"],
    th: ["align"],
    ul: ["className"]
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["https", "mailto"],
    src: ["https"]
  },
  clobberPrefix: ""
};

export function convertMarkdownToHtmlFragment(markdown: string): string {
  const body = stripFrontmatter(markdown);

  return String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(failOnRawHtml)
      .use(remarkRehype)
      .use(rehypeSlug)
      .use(rehypeHighlight, { detect: false })
      .use(removeUnsafeUrls)
      .use(rehypeSanitize, sanitizeSchema)
      .use(rehypeStringify)
      .processSync(body)
  ).trim();
}
