import type MarkdownIt from "markdown-it";
import type { Node as PMNode } from "prosemirror-model";
import { canEncodeButterFileUtf8 } from "./file-shell";

export type SourceFootnote = { readonly kind: "reference"; readonly label: string } |
  { readonly kind: "inline"; readonly content: string };
let grammar: MarkdownIt | undefined;
let blockInventories = new WeakMap<PMNode, readonly SourceFootnote[]>();
export function setSourceFootnoteGrammar(md: MarkdownIt): void { grammar = md; blockInventories = new WeakMap(); }

/** Token-derived source inventory is immutable and definition-independent.
 * Physical opaque blocks exclude their contained footnote-like spelling. */
export function nativeSourceFootnotes(md: MarkdownIt, source: string, block = false): SourceFootnote[] {
  const excluded: { from: number; to: number }[] = [];
  if (block) {
    const lines = [0];
    for (let index = 0; index < source.length; index++) if (source[index] === "\n") lines.push(index + 1);
    for (const token of md.parse(source, {})) {
      if (!token.map) continue;
      if (["fence", "math_block", "html_comment_raw"].includes(token.type) ||
        token.type === "block_comment" && (token.meta as { nativeSyntax?: unknown } | null)?.nativeSyntax !== "percent") {
        excluded.push({ from: lines[token.map[0]], to: lines[token.map[1]] ?? source.length });
      } else if (token.type === "footnote_def") {
        // Its defining [^label] is not a reference occurrence.
        const label = (token.meta as { label?: unknown } | null)?.label;
        excluded.push({ from: lines[token.map[0]], to: lines[token.map[0]] + 3 + (typeof label === "string" ? label.length : 0) });
      }
    }
  }
  const result: SourceFootnote[] = [];
  for (const inline of md.parseInline(source, { butterNativeCommentSource: true })) for (const token of inline.children ?? []) {
    const meta = token.meta as { rawFootnoteStart?: number; rawInlineFootnoteStart?: number; start?: number;
      labelParts?: readonly { footnote?: string; inlineFootnote?: string }[] } | null;
    const start = token.type === "footnote_ref" ? meta?.rawFootnoteStart : token.type === "inline_footnote" ? meta?.rawInlineFootnoteStart : meta?.start;
    if (start === undefined || excluded.some(range => start >= range.from && start < range.to)) continue;
    if (token.type === "footnote_ref") result.push({ kind: "reference", label: token.content });
    else if (token.type === "inline_footnote") result.push({ kind: "inline", content: token.content });
    else if (token.type === "comment_navigation") for (const part of meta?.labelParts ?? []) {
      if (part.footnote !== undefined) result.push({ kind: "reference", label: part.footnote });
      else if (part.inlineFootnote !== undefined) result.push({ kind: "inline", content: part.inlineFootnote });
    }
  }
  return result;
}

export function blockCommentFootnotes(node: PMNode): readonly SourceFootnote[] {
  if (!grammar || node.type.name !== "block_comment" || node.attrs.nativeSyntax !== "percent" ||
    typeof node.attrs.value !== "string" || !canEncodeButterFileUtf8(node.attrs.value)) return [];
  const retained = blockInventories.get(node);
  if (retained) return retained;
  const inventory = nativeSourceFootnotes(grammar, node.attrs.value, true);
  blockInventories.set(node, inventory);
  return inventory;
}

export function hiddenFootnoteDOM(entry: SourceFootnote): readonly unknown[] {
  return ["sup", { class: "butter-footnote-ref", "data-footnote-kind": entry.kind,
    ...(entry.kind === "reference" ? { "data-footnote-label": entry.label } : {}), style: "display:none" },
    ["span", { class: "footnote-link" }, entry.kind === "reference" ? entry.label : ""]];
}
