import type { Element, Root } from "hast";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parseDocument } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const HEADING_RE = /^#\s+(.+?)\s*#*\s*$/m;

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER_RE, "");
}

export function extractMarkdownTitle(markdown: string, fallback: string): string {
  const frontmatterTitle = frontmatterTitleValue(markdown);
  if (frontmatterTitle) {
    return frontmatterTitle;
  }

  const headingTitle = stripFrontmatter(markdown).match(HEADING_RE)?.[1];
  if (headingTitle) {
    return headingTitle.trim();
  }

  return fallback;
}

function frontmatterTitleValue(markdown: string): string | null {
  const yamlSource = markdown.match(FRONTMATTER_RE)?.[1];
  if (!yamlSource) {
    return null;
  }

  const document = parseDocument(yamlSource);
  if (document.errors.length > 0) {
    return null;
  }

  const data = document.toJS() as unknown;
  if (!data || typeof data !== "object" || !("title" in data)) {
    return null;
  }

  const title = (data as { title?: unknown }).title;
  if (typeof title === "string") {
    return title.trim() || null;
  }
  if (typeof title === "number" || typeof title === "boolean") {
    return String(title);
  }
  return null;
}

function removeUnsafeUrls() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (typeof node.properties?.href === "string" && !isAllowedHref(node.properties.href)) {
        delete node.properties.href;
      }

      if (typeof node.properties?.src === "string" && !isAllowedUrl(node.properties.src, ["https:"])) {
        delete node.properties.src;
      }
    });
  };
}

function isAllowedHref(value: string): boolean {
  return value.startsWith("#") || isAllowedUrl(value, ["https:", "mailto:"]);
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
    a: ["href", "id", "className", "ariaDescribedBy", "ariaLabel", "dataFootnoteRef", "dataFootnoteBackref"],
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
      .use(remarkRehype)
      .use(rehypeSlug)
      .use(rehypeHighlight, { detect: false })
      .use(removeUnsafeUrls)
      .use(rehypeSanitize, sanitizeSchema)
      .use(rehypeStringify)
      .processSync(body)
  ).trim();
}
