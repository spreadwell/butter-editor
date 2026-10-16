/**
 * HTML → markdown conversion for the paste path.
 *
 * Walks an HTMLElement tree and produces a markdown string that our
 * production parser can load as editable content. Explicit visibility is
 * resolved in inert DOM before conversion. Visible text uses the file's
 * literal codec; code and table cells use the same model/serializer as saving.
 *
 * Form-choice rules (per inline mark):
 *   • <strong>, <em>           → emit HTML form. Reasons: overlap
 *     survival (cross-boundary `<strong>...<em>...</strong>...</em>`
 *     can't be represented in `**`/`*` markdown form, but our
 *     htmlInlineTagsPlugin's any-match close handles it on parse) and
 *     whitespace robustness (`<strong> foo </strong>` round-trips
 *     cleanly; `**foo **` runs into right-flanking pairing rules).
 *   • <del>, <s>               → qualified HTML strike codec. Adjacent
 *     literal tildes must not enter native Markdown delimiter ownership.
 *   • <u>, <sup>, <sub>, <kbd>, <mark>, <font>
 *                              → HTML form. No markdown shorthand
 *     exists for these in CommonMark/GFM; HTML is the canonical
 *     authoring form.
 *
 * The end-state on disk is the same regardless of which intermediate
 * form is used (the canonical serializer chooses `**` for non-overlap
 * strong, `<strong>` when overlap forces HTML, etc.). Picking the
 * safer intermediate just maximizes the chance the parser produces
 * the structurally-correct PM doc on the way through.
 */

import { escapeMarkdownText, htmlAttribute, serialize } from "../core/bridge/serializer";
import { schema } from "../core/schema";
import { parser } from "../core/parser";
import type { Node as PMNode } from "prosemirror-model";

export function htmlToMarkdown(html: string): string {
  // DOMParser parses into an inert document - scripts don't execute,
  // image error handlers don't fire, etc. - making it the safe primitive
  // for digesting clipboard HTML. (Previously this used `innerHTML` on a
  // detached div, which is safe in practice but flagged by Obsidian's
  // plugin-review guideline against innerHTML for any user input.)
  //
  // Pre-wrap the input in <body>...</body> so the parsed doc always
  // exposes a body element. Some parser implementations (and some
  // malformed clipboard inputs) produce a documentElement-less doc
  // otherwise, which throws on `doc.body` access.
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    "text/html",
  );
  const body = doc.body;
  if (!body) return "";
  removeUnavailableContent(body);
  // Pruning may join text split around a hidden element. Escape its complete
  // lexical run, so '&' + hidden content + 'nbsp;' cannot become an entity.
  body.normalize();
  return serializeNode(body).trim();
}

/** Read only inert clipboard DOM. Explicit display/hidden removes the whole
 * subtree; inherited visibility still allows a child to become visible.
 * Prune before any code/table textContent read can disclose hidden payload. */
function removeUnavailableContent(node: Node, invisible = false): void {
  if (node.nodeType === Node.TEXT_NODE) {
    if (invisible) node.parentNode?.removeChild(node);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as HTMLElement;
  const display = (element.style.display ?? "").trim().toLowerCase();
  const hiddenAttribute = element.getAttribute("hidden");
  // Inline display overrides the UA's ordinary [hidden] display:none rule.
  // until-found uses content visibility and is not this display codec.
  const attributeHides = hiddenAttribute !== null &&
    (hiddenAttribute.toLowerCase() === "until-found" || !display || ["none", "revert", "revert-layer"].includes(display));
  if (["script", "style", "template", "noscript", "title", "head"].includes(element.tagName.toLowerCase()) ||
    attributeHides || display === "none") {
    element.parentNode?.removeChild(element);
    return;
  }
  const visibility = (element.style.visibility ?? "").trim().toLowerCase();
  const hidden = visibility === "visible" ? false
    : visibility === "hidden" || visibility === "collapse" ? true : invisible;
  for (const child of Array.from(element.childNodes)) removeUnavailableContent(child, hidden);
}

function serializeLiteralCode(text: string, language?: string): string {
  const content = text ? schema.text(text) : undefined;
  const block = language === undefined
    ? schema.nodes.paragraph.create(null, text ? schema.text(text, [schema.marks.code.create()]) : undefined)
    : schema.nodes.code_block.create({ language }, content);
  return serialize(schema.nodes.doc.create(null, block));
}

export function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const children = Array.from(el.childNodes).map(serializeNode).join("");
  switch (el.tagName.toLowerCase()) {
    // Inline marks with both HTML and markdown forms - emit HTML form.
    case "strong":
    case "b":
      return `<strong>${children}</strong>`;
    case "em":
    case "i":
      return `<em>${children}</em>`;
    case "del":
    case "s":
      // A literal tilde beside a strike delimiter changes native ownership.
      // The qualified HTML codec preserves the exact requested interval.
      return `<s>${children}</s>`;
    // HTML-only inline marks (no markdown shorthand exists).
    case "u":
      return `<u>${children}</u>`;
    case "sup":
      return `<sup>${children}</sup>`;
    case "sub":
      return `<sub>${children}</sub>`;
    case "kbd":
      return `<kbd>${children}</kbd>`;
    case "mark":
      return `<mark>${children}</mark>`;
    case "font": {
      const color = el.getAttribute("color");
      const face = el.getAttribute("face");
      const size = el.getAttribute("size");
      const attrs: string[] = [];
      if (color) attrs.push(`color="${htmlAttribute(color)}"`);
      if (face) attrs.push(`face="${htmlAttribute(face)}"`);
      if (size) attrs.push(`size="${htmlAttribute(size)}"`);
      const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
      return `<font${attrStr}>${children}</font>`;
    }
    case "code": {
      // <code> in <pre> is part of a fenced block - let the <pre> case
      // handle the wrap. Multi-line <code> w/o <pre> is also fenced
      // (some sources emit bare <code class="language-X">…</code>);
      // wrapping multi-line in single backticks would be invalid.
      const parentIsPre =
        el.parentElement?.tagName.toLowerCase() === "pre";
      if (parentIsPre) return el.textContent ?? "";
      const text = el.textContent ?? "";
      return serializeLiteralCode(text);
    }
    case "a": {
      const href = el.getAttribute("href");
      // A targetless external anchor contributes its visible children only.
      // Empty navigable anchors remain empty rather than exposing their URL.
      if (href === null) return children;
      const title = el.getAttribute("title");
      return `<a href="${htmlAttribute(href)}"${title !== null ? ` title="${htmlAttribute(title)}"` : ""}>${children}</a>`;
    }
    case "img": {
      const src = el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || "";
      const title = el.getAttribute("title");
      const width = el.getAttribute("width"), height = el.getAttribute("height");
      return `<img src="${htmlAttribute(src)}" alt="${htmlAttribute(alt)}"${title !== null ? ` title="${htmlAttribute(title)}"` : ""}${width !== null ? ` width="${htmlAttribute(width)}"` : ""}${height !== null ? ` height="${htmlAttribute(height)}"` : ""}>`;
    }
    case "h1":
      return `\n# ${children}\n`;
    case "h2":
      return `\n## ${children}\n`;
    case "h3":
      return `\n### ${children}\n`;
    case "h4":
      return `\n#### ${children}\n`;
    case "h5":
      return `\n##### ${children}\n`;
    case "h6":
      return `\n###### ${children}\n`;
    case "p":
      return `\n${children}\n`;
    case "br":
      return "\n";
    case "hr":
      return `\n\n---\n\n`;
    case "li":
      return `- ${children}\n`;
    case "ul":
    case "ol":
      return `\n${children}\n`;
    case "blockquote":
      return `\n${children
        .split("\n")
        .map((l) => (l ? `> ${l}` : ""))
        .join("\n")}\n`;
    case "pre": {
      // Fenced code. Pull language from nested <code class="language-X">.
      const codeChild = el.querySelector("code");
      const langMatch = codeChild?.className.match(/language-(\S+)/);
      const lang = langMatch ? langMatch[1] : "";
      return `\n\n${serializeLiteralCode(el.textContent ?? "", lang)}\n\n`;
    }
    case "table":
      return htmlTableToMd(el);
    default:
      return children;
  }
}

function htmlTableToMd(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll("tr")).filter(row => row.closest("table") === table);
  if (!rows.length) return "";
  // Use the actual Markdown parser and table serializer for rich cell
  // content. textContent/trim destroys code padding, formatting and links
  // before the save oracle can compare anything.
  const cells = rows.map(row => Array.from(row.children).filter(cell => /^(TH|TD)$/.test(cell.tagName)));
  const colCount = Math.max(...cells.map(row => row.length));
  if (!colCount) return "";
  const parsedRows = cells.map((row, index) => {
    const type = index === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
    const parsedCells = row.map(cell => {
      if (["colspan", "rowspan"].some(name => cell.hasAttribute(name) && cell.getAttribute(name) !== "1")) {
        throw new Error("Rich clipboard table spans have no supported cell projection");
      }
      const content = Array.from(cell.childNodes).map(serializeNode).join("");
      const doc = parser.parse(content);
      const inline: PMNode[] = [];
      const appendBlock = (block: PMNode): void => {
        if (["blockquote", "list_item", "callout"].includes(block.type.name)) {
          block.forEach(appendBlock);
          return;
        }
        if (inline.length) inline.push(schema.nodes.softbreak.create());
        if (block.inlineContent) block.forEach(child => inline.push(child));
        else if (block.type.name === "code_block" && block.textContent) {
          inline.push(schema.text(block.textContent, [schema.marks.code.create()]));
        } else if (block.type.name !== "code_block") {
          throw new Error("Rich clipboard block has no supported cell projection");
        }
      };
      doc?.forEach(appendBlock);
      return type.create(null, inline);
    });
    while (parsedCells.length < colCount) parsedCells.push(type.create());
    return schema.nodes.table_row.create(null, parsedCells);
  });
  return serialize(schema.nodes.doc.create(null, schema.nodes.table.create(null, parsedRows)));
}
