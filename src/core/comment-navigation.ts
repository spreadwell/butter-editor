import type MarkdownIt from "markdown-it";
import type { Node as PMNode } from "prosemirror-model";
import { canEncodeButterFileUtf8 } from "./file-shell";

export type CommentNavigationKind = "wikilink" | "obsidian_embed_inline";
interface NavigationAttrs {
  readonly target?: unknown;
  readonly alias?: unknown;
  readonly src?: unknown;
  readonly literalSource?: unknown;
  readonly emptyAlias?: unknown;
}
export interface NativeSourceNavigation {
  readonly kind: CommentNavigationKind;
  readonly start: number;
  readonly end: number;
  readonly source: string;
  readonly target?: string;
  readonly alias?: string;
  readonly emptyAlias?: boolean;
  readonly src?: string;
}

/** Opaque provenance is a complete raw token whose resolved navigation fields
 * agree exactly. It cannot carry adjacent syntax, line endings or %% seams. */
export function isCommentNavigationSource(kind: CommentNavigationKind, attrs: NavigationAttrs, source: unknown): source is string {
  if (typeof source !== "string" || /[\r\n\0]/.test(source) || source.includes("%%") || !canEncodeButterFileUtf8(source)) return false;
  const prefix = kind === "wikilink" ? "[[" : "![[";
  if (!source.startsWith(prefix) || !source.endsWith("]]")) return false;
  const inner = source.slice(prefix.length, -2);
  if (!inner || inner.includes("]]") || inner.includes("[[")) return false;
  if (kind === "obsidian_embed_inline") return inner === attrs.src;
  const pipe = inner.indexOf("|");
  return (pipe < 0 ? inner : inner.slice(0, pipe)) === attrs.target &&
    (pipe < 0 ? "" : inner.slice(pipe + 1)) === attrs.alias &&
    (attrs.emptyAlias === undefined || attrs.emptyAlias === (pipe >= 0 && inner.slice(pipe + 1) === ""));
}

export function canonicalNavigationSource(kind: CommentNavigationKind, attrs: NavigationAttrs): string {
  return kind === "obsidian_embed_inline" ? `![[${attrs.src as string}]]` : attrs.alias || attrs.emptyAlias === true
    ? `[[${attrs.target as string}|${attrs.alias as string}]]` : `[[${attrs.target as string}]]`;
}

/** Exact opaque spelling is semantic only while the comment owns this atom.
 * Ordinary visible navigation keeps its normal exact attribute contract. */
export function commentNavigationSource(node: PMNode): string | null {
  const kind = node.type.name;
  if (kind !== "wikilink" && kind !== "obsidian_embed_inline") return null;
  if (!node.marks.some(mark => mark.type.name === "comment")) return null;
  const source: unknown = node.attrs.literalSource;
  return source === null || source === undefined ? canonicalNavigationSource(kind, node.attrs)
    : isCommentNavigationSource(kind, node.attrs, source) ? source : null;
}

export function hasValidCommentNavigationProvenance(doc: PMNode): boolean {
  let valid = true;
  doc.descendants(node => {
    if (node.type.name !== "wikilink" && node.type.name !== "obsidian_embed_inline") return;
    if (node.type.name === "wikilink" && (typeof node.attrs.emptyAlias !== "boolean" || node.attrs.emptyAlias && node.attrs.alias !== "")) { valid = false; return; }
    const source: unknown = node.attrs.literalSource;
    if (source === null || source === undefined) return;
    if (!node.marks.some(mark => mark.type.name === "comment") ||
      !isCommentNavigationSource(node.type.name, node.attrs, source)) valid = false;
  });
  return valid;
}

/** Navigation selected by genuine inline source tokens. Raw ranges exclude
 * escaped/entity spellings and opaque native code/math content naturally. */
export function nativeSourceNavigation(md: MarkdownIt, source: string): NativeSourceNavigation[] {
  const result: NativeSourceNavigation[] = [];
  for (const inline of md.parseInline(source, {})) for (const token of inline.children ?? []) {
    if (token.type !== "wikilink" && token.type !== "obsidian_embed_inline") continue;
    const meta = token.meta as { rawNavigationStart?: unknown; rawNavigationEnd?: unknown; target?: string; alias?: string } | null;
    if (typeof meta?.rawNavigationStart !== "number" || typeof meta.rawNavigationEnd !== "number") continue;
    const literal = source.slice(meta.rawNavigationStart, meta.rawNavigationEnd);
    const attrs = token.type === "wikilink" ? { target: meta.target, alias: meta.alias, emptyAlias: /\|\]\]$/.test(literal) } : { src: token.content };
    if (!isCommentNavigationSource(token.type, attrs, literal)) continue;
    result.push({ kind: token.type, start: meta.rawNavigationStart, end: meta.rawNavigationEnd, source: literal, ...attrs });
  }
  return result;
}
