import type MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import { findHtmlCommentEnd } from "./html-comments";
import { parseHtmlAttributes, readHtmlElement } from "./html-source-safety";

export type TextAlignment = "left" | "center" | "right" | "justify";
const alignments = new Set<string>(["left", "center", "right", "justify"]);

export function textAlignment(value: unknown): TextAlignment | null {
  return typeof value === "string" && alignments.has(value) ? value as TextAlignment : null;
}

/** An inline element keeps Markdown in the native inline parser. A block
 * HTML element would instead make its Markdown body literal in reading view. */
export function alignmentOpening(value: TextAlignment): string {
  // Inline-block retains the native task checkbox's baseline. A block box
  // forces the aligned text onto a separate line below that checkbox.
  return `<span style="display: inline-block; width: 100%; vertical-align: top; text-align: ${value};">`;
}

export function alignmentDOM(dom: HTMLElement): { textAlign: TextAlignment | null } {
  return { textAlign: textAlignment((dom.style.textAlign ?? "").toLowerCase()) };
}

function wrapperAlignment(attributes: string, tag: string): TextAlignment | null {
  const fields = parseHtmlAttributes(attributes);
  if (!fields || new Set(fields.map(field => field.name)).size !== fields.length) return null;
  let alignment: TextAlignment | null = tag === "center" ? "center" : null;
  let display: "block" | "inline-block" | null = null;
  let fullWidth = false;
  for (const field of fields) {
    if (field.value === null) return null;
    if (field.name === "align" && tag !== "span") {
      if (fields.some(other => other.name === "style")) return null;
      alignment = textAlignment(field.value.toLowerCase());
      if (!alignment) return null;
    } else if (field.name === "style") {
      const declarations = field.value.toLowerCase().split(";").map(part => part.trim()).filter(Boolean);
      const seen = new Set<string>();
      for (const declaration of declarations) {
        const match = /^(text-align|display|width|vertical-align)\s*:\s*([a-z-]+|100%)$/.exec(declaration);
        if (!match || seen.has(match[1])) return null;
        seen.add(match[1]);
        if (match[1] === "text-align") {
          alignment = textAlignment(match[2]);
          if (!alignment) return null;
        } else if (tag === "span" && match[1] === "display" &&
            (match[2] === "block" || match[2] === "inline-block")) display = match[2];
        else if (tag === "span" && match[1] === "width" && match[2] === "100%") fullWidth = true;
        else if (tag === "span" && match[1] === "vertical-align" && match[2] === "top") { /* Native first-line checkbox baseline. */ }
        else return null;
      }
    } else return null;
  }
  return tag !== "span" || display === "block" || display === "inline-block" && fullWidth ? alignment : null;
}

function alignedWrapper(source: string, inline: boolean): {
  alignment: TextAlignment; tag: string; body: string; blockId: string | null;
} | null {
  const opening = readHtmlElement(source, 0, source.length);
  if (!opening || opening.closing || opening.selfClosing ||
      (inline ? opening.name !== "span" : !/^(?:p|center|div)$/.test(opening.name))) return null;
  const alignment = wrapperAlignment(opening.attributes, opening.name);
  if (!alignment) return null;
  const suffix = inline ? "([^\\S\\r\\n]+\\^[A-Za-z0-9-]+)?" : "";
  const closing = new RegExp(`</${opening.name}[\\t\\n\\f\\r ]*>${suffix}[\\t ]*$`, "i").exec(source);
  if (!closing || closing.index < opening.end) return null;
  return { alignment, tag: opening.name, body: source.slice(opening.end, closing.index),
    blockId: inline && closing[1] ? closing[1].trim().slice(1) : null };
}

/** HTML's text is literal, including Markdown-looking punctuation. Retain
 * only inline elements our existing codecs own; everything else stays in the
 * native opaque HTML source island, including every unmodeled attribute. */
function htmlBodyMarkdown(body: string, md: MarkdownIt): string | null {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    strong: [], em: [], s: [], del: [], u: [], sup: [], sub: [], kbd: [], code: [],
    mark: ["style"], font: ["color", "face", "size"], span: ["style"],
    a: ["href", "title"], img: ["src", "alt", "title", "width", "height"], br: [],
  };
  const stack: string[] = [];
  const decode = (value: string): string => value.replace(
    /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/g,
    entity => md.utils.unescapeAll(entity),
  );
  const literal = (value: string): string => decode(value).replace(
    /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&",
  );
  let result = "", cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf("<", cursor);
    if (start < 0) { result += literal(body.slice(cursor)); break; }
    result += literal(body.slice(cursor, start));
    if (body.startsWith("<!--", start)) {
      const end = findHtmlCommentEnd(body, start, body.length);
      if (end < 0) return null;
      result += body.slice(start, end); cursor = end; continue;
    }
    const element = readHtmlElement(body, start, body.length);
    if (!element) {
      if (/^<[!/?A-Za-z]/.test(body.slice(start))) return null;
      result += "\\<"; cursor = start + 1; continue;
    }
    const attributes = parseHtmlAttributes(element.attributes);
    if (!Object.prototype.hasOwnProperty.call(allowed, element.name) || !attributes ||
        new Set(attributes.map(attribute => attribute.name)).size !== attributes.length ||
        attributes.some(attribute => attribute.value === null || !allowed[element.name].includes(attribute.name))) return null;
    if (element.name === "span" && !element.closing &&
        !/^\s*display\s*:\s*none\s*;?\s*$/i.test(attributes[0]?.value ?? "")) return null;
    const voidElement = element.name === "br" || element.name === "img";
    if (element.closing) { if (voidElement || stack.pop() !== element.name) return null; }
    else if (!voidElement) { if (element.selfClosing) return null; stack.push(element.name); }
    result += element.markup;
    cursor = element.end;
  }
  if (stack.length) return null;
  // Existing inline codecs remain authoritative for style values, URLs,
  // dimensions and hidden source. Do not broaden their admission here.
  const children: import("markdown-it/lib/token.mjs").default[] = [];
  md.inline.parse(result, md, {}, children);
  if (children.some(token => (token.meta as { nativeUnsupportedHtml?: boolean } | null)?.nativeUnsupportedHtml)) return null;
  return result;
}

export function textAlignmentPlugin(md: MarkdownIt): void {
  md.block.ruler.before("native_html_source_block", "aligned_html_textblock", (state, startLine, endLine, silent) => {
    if (startLine >= endLine || state.sCount[startLine] - state.blkIndent >= 4) return false;
    // Paragraph interruption probes run on every physical line. Reject
    // ordinary Markdown before collecting a potentially large HTML block.
    const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    if (!/^<(?:p|center|div)(?=[\t />]|$)/i.test(first)) return false;
    let nextLine = startLine;
    while (nextLine < endLine && !state.isEmpty(nextLine) && state.sCount[nextLine] >= state.blkIndent) nextLine++;
    const source = state.getLines(startLine, nextLine, state.blkIndent, true).replace(/\n$/, "");
    const wrapper = alignedWrapper(source.replace(/^ {1,3}(?=<)/, ""), false);
    if (!wrapper) return false;
    const body = htmlBodyMarkdown(wrapper.body, md);
    if (body === null) return false;
    if (silent) return true;
    const type = "paragraph", tag = "p";
    const opening = state.push(`${type}_open`, tag, 1);
    opening.map = [startLine, nextLine];
    opening.attrSet("data-text-align", wrapper.alignment);
    const content = state.push("inline", "", 0);
    content.content = body; content.map = [startLine, nextLine]; content.children = [];
    state.push(`${type}_close`, tag, -1);
    state.line = nextLine;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.core.ruler.before("inline", "text_alignment", state => {
    for (let index = 1; index < state.tokens.length; index++) {
      const token = state.tokens[index], opening = state.tokens[index - 1];
      if (token.type !== "inline" || opening.type !== "paragraph_open") continue;
      // A native task marker precedes its editable paragraph body. Keep it
      // outside the style wrapper and available to the existing task codec.
      const taskPrefix = state.tokens[index - 2]?.type === "list_item_open"
        ? /^\[[ xX]\][\t ]/.exec(token.content)?.[0] ?? "" : "";
      const wrapper = alignedWrapper(token.content.slice(taskPrefix.length), true);
      if (!wrapper) continue;
      opening.attrSet("data-text-align", wrapper.alignment);
      token.content = taskPrefix + wrapper.body;
      if (wrapper.blockId) token.meta = { ...(token.meta as Record<string, unknown> | null), alignmentBlockId: wrapper.blockId };
    }
  });
  // The physical separator after the closing HTML element is native block-ID
  // syntax, not an added editable space. Keep the original inline body exact.
  md.core.ruler.after("block_id_boundaries", "alignment_block_id", state => {
    for (const token of state.tokens) {
      const id = (token.meta as { alignmentBlockId?: string } | null)?.alignmentBlockId;
      if (token.type !== "inline" || !id || !token.children) continue;
      const blockId = new Token("block_id", "", 0); blockId.content = id;
      token.children.push(blockId);
    }
  });
}
