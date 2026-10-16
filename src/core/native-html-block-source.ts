import htmlBlockTags from "markdown-it/lib/common/html_blocks.mjs";
import { findHtmlCommentEnd } from "./html-comments";
import { readHtmlElement } from "./html-source-safety";

// This codec interrupts paragraphs only for the shared native type-6 set.
// markdown-it 14.3 adds `search`, absent from the qualified Obsidian renderer;
// treating it as an interrupt would split a native inline paragraph.
const blockTags = new Set(htmlBlockTags.filter(tag => tag !== "search"));
const voidTags = new Set(["area", "base", "basefont", "br", "col", "embed", "frame", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const rawTextTags = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);

/** Match markdown-it's semantic line endings. Physical file EOL and the
 * final block separator belong to the source range/file shell, not the atom.
 * DOM clipboard admission must create the same payload as a source reparse. */
export function nativeHtmlBlockPayload(source: string): string {
  return source.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

/** A complete native HTML block is an opaque source island, never rich text.
 * Require explicit, balanced element boundaries inside one CommonMark block.
 * Malformed/unclosed source and inline HTML retain the existing safety owner. */
export function isNativeHtmlSourceBlock(source: string): boolean {
  const indent = /^[ \t]*/.exec(source)?.[0] ?? "";
  const start = indent.length;
  const normalized = source.replace(/\r\n?/g, "\n");
  if (indent.includes("\t") || start > 3 || /\n[ \t]*\n|\n[ \t]+$/.test(normalized)) return false;
  const first = readHtmlElement(source, start, source.length);
  if (!first || first.closing || !blockTags.has(first.name)) return false;
  const stack: string[] = [];
  let cursor = start;
  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening < 0) break;
    if (source.startsWith("<!--", opening)) {
      const end = findHtmlCommentEnd(source, opening, source.length);
      if (end < 0) return false;
      cursor = end;
      continue;
    }
    // Declarations/processing instructions require a different source codec.
    if (/^<[!?]/.test(source.slice(opening))) return false;
    const element = readHtmlElement(source, opening, source.length);
    if (!element) {
      if (/^<\/?[A-Za-z]/.test(source.slice(opening))) return false;
      cursor = opening + 1;
      continue;
    }
    if (element.closing) {
      if (stack.pop() !== element.name) return false;
    } else if (!voidTags.has(element.name)) {
      // HTML does not self-close ordinary containers with XML's '/>' syntax.
      if (element.selfClosing || element.name === "plaintext") return false;
      if (rawTextTags.has(element.name)) {
        const close = new RegExp(`</${element.name}[\\t\\n\\f\\r ]*>`, "ig");
        close.lastIndex = element.end;
        const match = close.exec(source);
        if (!match) return false;
        cursor = close.lastIndex;
        continue;
      }
      stack.push(element.name);
    }
    cursor = element.end;
  }
  return stack.length === 0;
}

export function isNativeHtmlSourceKind(kind: unknown, raw: unknown): boolean {
  return kind === "native-html-comment" ||
    kind === "native-html-block" && typeof raw === "string" && isNativeHtmlSourceBlock(raw);
}
