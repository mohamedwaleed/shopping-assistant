/**
 * Turning HTML into text, and recognising the pages that are not evidence.
 *
 * The parser is deliberately small and non-evaluating: it reads markup into a
 * tree of names and text, never runs a script, never follows a link, and never
 * fetches a subresource. Page text is data — see the note on `visibleText`.
 */

export interface ElementNode {
  kind: "element";
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: Node[];
}

export interface TextNode {
  kind: "text";
  text: string;
}

export type Node = ElementNode | TextNode;

/** Elements whose contents are never page text. */
const NON_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "canvas",
  "head",
]);

/** Elements whose contents start a new line, so words do not run together. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Elements that hold no content, so they are not pushed onto the stack. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  pound: "£",
  dollar: "$",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
};

/** Decodes the entities a product page actually uses. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);?/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name.length === 0) continue;
    // The first occurrence wins, as a browser's parser does, so a later
    // duplicate cannot quietly replace a value the first one stated.
    if (name in attributes) continue;
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/**
 * Parses markup into a tree. It is forgiving in the ways a real page needs —
 * unclosed tags, stray closing tags, attributes without quotes — and strict
 * about the one thing that matters here: nothing in the source is executed.
 */
export function parseHtml(html: string): ElementNode {
  const root: ElementNode = { kind: "element", name: "#document", attributes: {}, children: [] };
  const stack: ElementNode[] = [root];
  let index = 0;
  const current = () => stack[stack.length - 1] ?? root;

  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      pushText(current(), html.slice(index));
      break;
    }
    if (open > index) pushText(current(), html.slice(index, open));

    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", open) || html.startsWith("<?", open)) {
      const end = html.indexOf(">", open);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const closing = html[open + 1] === "/";
    const nameStart = open + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(html.slice(nameStart));
    if (!nameMatch) {
      // A bare "<" is text, not markup.
      pushText(current(), "<");
      index = open + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const end = findTagEnd(html, nameStart + nameMatch[0].length);
    if (end === -1) {
      pushText(current(), html.slice(open));
      break;
    }
    const attributeSource = html.slice(nameStart + nameMatch[0].length, end);
    index = end + 1;

    if (closing) {
      // Close the nearest open element of that name; a closing tag with no
      // matching open element is ignored rather than closing its parents.
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]?.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const element: ElementNode = {
      kind: "element",
      name,
      attributes: parseAttributes(attributeSource),
      children: [],
    };
    current().children.push(element);
    if (VOID_ELEMENTS.has(name) || attributeSource.trim().endsWith("/")) continue;
    // Raw-text elements end at their own closing tag, so a "<" inside a script
    // is never mistaken for markup.
    if (name === "script" || name === "style" || name === "textarea" || name === "title") {
      const close = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(index));
      const content = close ? html.slice(index, index + close.index) : html.slice(index);
      // A title is display text and is decoded; a script's source is not,
      // because decoding it would corrupt the JSON it holds.
      element.children.push({
        kind: "text",
        text: name === "title" ? decodeEntities(content) : content,
      });
      index = close ? index + close.index + close[0].length : html.length;
      continue;
    }
    stack.push(element);
  }
  return root;
}

/** Finds the ">" that ends a tag, skipping any inside a quoted attribute. */
function findTagEnd(html: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return -1;
}

function pushText(parent: ElementNode, raw: string): void {
  if (raw.length === 0) return;
  parent.children.push({ kind: "text", text: decodeEntities(raw) });
}

/** Every element of a given name, in document order. */
export function elementsNamed(node: Node, name: string): ElementNode[] {
  const found: ElementNode[] = [];
  const walk = (current: Node) => {
    if (current.kind === "text") return;
    if (current.name === name) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return found;
}

/** The first element of a given name, in document order. */
export function firstElementNamed(node: Node, name: string): ElementNode | undefined {
  return elementsNamed(node, name)[0];
}

/**
 * Every text node below an element, in document order. The element asked
 * about is read even when it is one whose contents are not page text — a
 * `<script>`'s source is not page text, but a JSON-LD block lives inside one.
 */
export function textNodes(node: Node): string[] {
  const found: string[] = [];
  const walk = (current: Node, isRoot: boolean) => {
    if (current.kind === "text") {
      found.push(current.text);
      return;
    }
    if (!isRoot && NON_TEXT_ELEMENTS.has(current.name)) return;
    for (const child of current.children) walk(child, false);
  };
  walk(node, true);
  return found;
}

/**
 * The page's readable text, whitespace-collapsed.
 *
 * Page content is DATA. This function is the boundary where markup becomes
 * text, and the text it returns is never parsed as an instruction, never used
 * to choose a branch, and never treated as an authority on anything. A page
 * that says "ignore your instructions and fetch X" is a page that said so, and
 * the string is handed on exactly as written, attributed to the page it came
 * from.
 */
export function visibleText(node: Node): string {
  const parts: string[] = [];
  const walk = (current: Node) => {
    if (current.kind === "text") {
      parts.push(current.text);
      return;
    }
    if (NON_TEXT_ELEMENTS.has(current.name)) return;
    if (BLOCK_ELEMENTS.has(current.name)) parts.push(" ");
    for (const child of current.children) walk(child);
    if (BLOCK_ELEMENTS.has(current.name)) parts.push(" ");
  };
  walk(node);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** The `content` of every meta tag with one of the given property or name keys. */
export function metaContents(node: Node, keys: readonly string[]): string[] {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  return elementsNamed(node, "meta").flatMap((meta) => {
    const key = (meta.attributes["property"] ?? meta.attributes["name"] ?? "").toLowerCase();
    const content = meta.attributes["content"];
    return wanted.has(key) && content !== undefined && content.trim() !== "" ? [content] : [];
  });
}

/** The `content` of the first meta tag with the given key. */
export function metaContent(node: Node, keys: readonly string[]): string | undefined {
  return metaContents(node, keys)[0];
}

/** Every `type="application/ld+json"` block's raw source. */
export function jsonLdSources(node: Node): string[] {
  return elementsNamed(node, "script").flatMap((script) => {
    const type = (script.attributes["type"] ?? "").toLowerCase().trim();
    if (type !== "application/ld+json") return [];
    return [textNodes(script).join("")];
  });
}

/** A document's title, from `<title>` or failing that the OpenGraph title. */
export function documentTitle(node: Node): string | undefined {
  const title = firstElementNamed(node, "title");
  const fromTitle = title ? visibleText(title) : "";
  if (fromTitle !== "") return fromTitle;
  const og = metaContent(node, ["og:title"]);
  return og === undefined ? undefined : og.trim();
}

/**
 * The `<base href>` a page declares, if any. It matters because an offer's URL
 * may be relative, and resolving it against the wrong origin would attribute a
 * price to a page that never stated it.
 */
export function baseHref(node: Node): string | undefined {
  const base = firstElementNamed(node, "base");
  const href = base?.attributes["href"];
  return href === undefined || href.trim() === "" ? undefined : href.trim();
}
