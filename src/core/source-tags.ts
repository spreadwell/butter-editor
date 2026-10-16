import type MarkdownIt from "markdown-it";

export interface NativeSourceTag {
  readonly tag: string;
  readonly start: number;
  readonly end: number;
}

/** Cached tags from genuine native source tokens, never decoded editor text.
 * Raw positions let an opaque comment retain every other source byte without
 * turning its embedded Markdown/HTML into visible rich content. */
export function nativeSourceTags(md: MarkdownIt, source: string, blockComment = false): NativeSourceTag[] {
  const opaque: { start: number; end: number }[] = [];
  if (blockComment) {
    // Native percent-block metadata suppresses physical fenced code/math,
    // but not merely indented comment lines. Use actual source block tokens
    // for those ranges instead of guessing from decoded payload characters.
    const lineStarts = [0];
    for (let index = 0; index < source.length; index++) if (source[index] === "\n") lineStarts.push(index + 1);
    for (const token of md.parse(source, {})) if ((token.type === "fence" || token.type === "math_block") && token.map) {
      opaque.push({ start: lineStarts[token.map[0]], end: lineStarts[token.map[1]] ?? source.length });
    }
  }
  const tags: NativeSourceTag[] = [];
  let rangeIndex = 0;
  for (const inline of md.parseInline(source, { butterNativeCommentSource: true })) for (const token of inline.children ?? []) {
    if (token.type !== "obsidian_tag") continue;
    const start = (token.meta as { rawTagStart?: unknown } | null)?.rawTagStart;
    if (typeof start !== "number") continue;
    const end = start + 1 + token.content.length;
    if (source.slice(start, end) !== `#${token.content}`) continue;
    while (rangeIndex < opaque.length && start >= opaque[rangeIndex].end) rangeIndex++;
    if (rangeIndex < opaque.length && start >= opaque[rangeIndex].start && start < opaque[rangeIndex].end) continue;
    tags.push({ tag: token.content, start, end });
  }
  return tags;
}

export interface NativeSourceFootnote {
  readonly kind: "footnote_ref";
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

export function nativeSourceFootnoteReferences(md: MarkdownIt, source: string): NativeSourceFootnote[] {
  const result: NativeSourceFootnote[] = [];
  for (const inline of md.parseInline(source, { butterNativeCommentSource: true })) for (const token of inline.children ?? []) {
    if (token.type !== "footnote_ref") continue;
    const start = (token.meta as { rawFootnoteStart?: unknown } | null)?.rawFootnoteStart;
    if (typeof start !== "number") continue;
    const end = start + 3 + token.content.length;
    if (source.slice(start, end) === `[^${token.content}]`) result.push({ kind: "footnote_ref", label: token.content, start, end });
  }
  return result;
}
