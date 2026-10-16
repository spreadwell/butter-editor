import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import linkRule from "markdown-it/lib/rules_inline/link.mjs";
import imageRule from "markdown-it/lib/rules_inline/image.mjs";
import type { Node as PMNode } from "prosemirror-model";
import { canEncodeButterFileUtf8 } from "./file-shell";
import { nativeDelimiterPlugin } from "./native-delimiters";
import { nativeSourceTags, nativeSourceFootnoteReferences } from "./source-tags";
import type { SourceFootnote } from "./source-footnotes";

export interface CommentMarkdownNavigation {
  readonly kind: "link" | "image";
  readonly source: string;
  readonly target: string;
  readonly title: string | null;
  readonly reference: boolean;
  readonly sourceKind: "percent" | "span";
  readonly displayText: string;
  readonly nativeTags: readonly string[];
  readonly footnoteRefs: readonly string[];
  readonly labelParts: readonly { readonly text?: string; readonly footnote?: string; readonly inlineFootnote?: string }[];
}
export interface NativeSourceMarkdownNavigation extends CommentMarkdownNavigation {
  readonly start: number;
  readonly end: number;
  readonly tokenKind: "comment_navigation";
}
interface LexicalOccurrence { start: number; end: number; kind: "link" | "image"; target: string; title: string | null; label: string; reference: boolean; }

// This immutable lexical recognizer delegates the published Markdown grammar.
// It never interprets hidden payload as another editable document. In particular,
// a nested footnote label cannot cancel its containing Markdown occurrence.
const lexical = new MarkdownIt("commonmark", { html: true });
nativeDelimiterPlugin(lexical);
for (const [name, rule] of [["link", linkRule], ["image", imageRule]] as const) {
  lexical.inline.ruler.at(name, (state, silent) => {
    const start = state.pos, first = state.tokens.length;
    if (state.src[start + (name === "image" ? 1 : 0)] !== "[") return false;
    const labelEnd = state.md.helpers.parseLinkLabel(state, start + (name === "image" ? 1 : 0), false);
    if (labelEnd < 0 || !["(", "["].includes(state.src[labelEnd + 1])) return false;
    const reference = state.src[labelEnd + 1] === "[";
    if (reference && state.md.helpers.parseLinkLabel(state, labelEnd + 1, false) < 0) return false;
    const env = state.env as { references?: unknown }, references = env.references;
    // An invalid inline destination must stay literal; the lexical placeholder
    // dictionary cannot turn its label into a fallback shortcut reference.
    if (!reference) env.references = undefined;
    let accepted: boolean;
    try { accepted = rule(state, silent); } finally { env.references = references; }
    if (!accepted) return false;
    if (!silent && labelEnd >= 0 && ["(", "["].includes(state.src[labelEnd + 1])) {
      const token = state.tokens.slice(first).find(item => item.type === (name === "image" ? "image" : "link_open"));
      if (token) token.meta = { occurrence: { start, end: state.pos, kind: name, reference,
        target: reference ? "" : token.attrGet(name === "image" ? "src" : "href") ?? "", title: reference ? null : token.attrGet("title"),
        label: state.src.slice(start + (name === "image" ? 2 : 1), labelEnd) } satisfies LexicalOccurrence };
    }
    return true;
  });
}
let nativeGrammar: MarkdownIt | undefined;

function lexicalOccurrences(source: string): LexicalOccurrence[] {
  const result: LexicalOccurrence[] = [];
  // Explicit reference/collapsed occurrences own their source independent of
  // whether a definition exists today. Placeholder resolution is lexical only;
  // no target/title is inferred or stored for these dynamically resolved forms.
  const references: object = new Proxy(Object.create(null) as object, { get: () => ({ href: "", title: "" }) });
  for (const inline of lexical.parseInline(source, { references })) for (const token of inline.children ?? []) {
    const occurrence = (token.meta as { occurrence?: LexicalOccurrence } | null)?.occurrence;
    if (occurrence) result.push(occurrence);
  }
  return result;
}

function labelParts(md: MarkdownIt, label: string): CommentMarkdownNavigation["labelParts"] {
  const result: { text?: string; footnote?: string; inlineFootnote?: string }[] = [];
  const text = (value: string): void => {
    if (!value) return;
    const last = result[result.length - 1];
    if (last?.text !== undefined) last.text += value; else result.push({ text: value });
  };
  for (const inline of md.parseInline(label, { butterNativeCommentSource: true })) for (const token of inline.children ?? []) {
    if (["text", "text_special", "code_inline"].includes(token.type)) text(token.content);
    else if (token.type === "obsidian_tag") text("#" + token.content);
    else if (token.type === "footnote_ref") result.push({ footnote: token.content });
    else if (token.type === "inline_footnote") result.push({ inlineFootnote: token.content });
    else if (token.type === "image") text(md.normalizeLinkText(token.attrGet("src") ?? ""));
    else if (token.type === "softbreak" || token.type === "hardbreak") text("\n");
    else if (token.type === "wikilink") {
      const meta = token.meta as { target?: string; alias?: string } | null;
      text(meta?.alias || meta?.target || token.content);
    }
  }
  return result;
}

export function nativeSourceMarkdownNavigation(md: MarkdownIt, source: string): NativeSourceMarkdownNavigation[] {
  return lexicalOccurrences(source).filter(item => !/[\r\n\0]/.test(source.slice(item.start, item.end)) &&
    !source.slice(item.start, item.end).includes("%%")).map(item => assembleOccurrence(md, source, item));
}

/** Explicitly hiding a genuine image can transfer its complete native source
 * occurrence to the opaque comment owner. Literal bracket text never uses
 * this factory; the caller must prove the surviving image edit's provenance. */
export function commentMarkdownNavigationFromSource(source: string, sourceKind: "percent" | "span"): CommentMarkdownNavigation | null {
  if (!nativeGrammar) return null;
  const items = nativeSourceMarkdownNavigation(nativeGrammar, source);
  if (items.length !== 1 || items[0].start !== 0 || items[0].end !== source.length) return null;
  const { start: _start, end: _end, tokenKind: _tokenKind, ...fields } = items[0];
  const attrs = { ...fields, sourceKind };
  return isCommentMarkdownNavigation(attrs) ? attrs : null;
}

function assembleOccurrence(md: MarkdownIt, source: string, item: LexicalOccurrence): NativeSourceMarkdownNavigation {
    const parts = item.kind === "image" ? [{ text: md.utils.unescapeAll(item.label) }] : labelParts(md, item.label);
    return { ...item, source: source.slice(item.start, item.end), sourceKind: "percent", tokenKind: "comment_navigation" as const,
      displayText: parts.map(part => part.text ?? "").join(""), labelParts: parts,
      nativeTags: item.kind === "image" ? [] : nativeSourceTags(md, item.label).map(tag => tag.tag),
      footnoteRefs: item.kind === "image" ? [] : nativeSourceFootnoteReferences(md, item.label).map(ref => ref.label) };
}

export function isCommentMarkdownNavigation(attrs: Readonly<Record<string, unknown>>): boolean {
  if (typeof attrs.source !== "string" || /[\r\n\0]/.test(attrs.source) || attrs.source.includes("%%") || !canEncodeButterFileUtf8(attrs.source)) return false;
  const [item, ...nested] = lexicalOccurrences(attrs.source);
  if (!item || nested.some(child => child.start < item.start || child.end > item.end) || item.start !== 0 || item.end !== attrs.source.length ||
    item.kind !== attrs.kind || item.reference !== attrs.reference || item.target !== attrs.target || item.title !== attrs.title ||
    !["percent", "span"].includes(String(attrs.sourceKind)) || typeof attrs.displayText !== "string") return false;
  if (![attrs.nativeTags, attrs.footnoteRefs].every(value => Array.isArray(value) && value.every(item => typeof item === "string"))) return false;
  if (!Array.isArray(attrs.labelParts) || !attrs.labelParts.every((part: unknown) => {
    if (!part || typeof part !== "object") return false;
    const value = part as { text?: unknown; footnote?: unknown; inlineFootnote?: unknown };
    return [value.text, value.footnote, value.inlineFootnote].filter(item => typeof item === "string").length === 1 &&
      [value.text, value.footnote, value.inlineFootnote].every(item => item === undefined || typeof item === "string");
  })) return false;
  if (!nativeGrammar) return false;
  const expected = nativeSourceMarkdownNavigation(nativeGrammar, attrs.source)[0];
  return Boolean(expected && ["displayText", "nativeTags", "footnoteRefs", "labelParts"].every(key =>
    JSON.stringify(attrs[key]) === JSON.stringify(expected[key as keyof CommentMarkdownNavigation])));
}

export function commentMarkdownSource(node: PMNode): string | null {
  return node.type.name === "comment_navigation" && node.marks.some(mark => mark.type.name === "comment") &&
    isCommentMarkdownNavigation(node.attrs) ? node.attrs.source as string : null;
}

export function hasValidCommentMarkdownNavigation(doc: PMNode): boolean {
  let valid = true;
  doc.descendants(node => { if (node.type.name === "comment_navigation" && commentMarkdownSource(node) === null) valid = false; });
  return valid;
}

export function commentMarkdownFootnoteRefs(node: PMNode): readonly string[] {
  return commentMarkdownSource(node) === null ? [] : node.attrs.footnoteRefs as readonly string[];
}

const footnoteInventories = new WeakMap<PMNode, readonly SourceFootnote[]>();
export function commentMarkdownFootnotes(node: PMNode): readonly SourceFootnote[] {
  const retained = footnoteInventories.get(node);
  if (retained) return retained;
  if (commentMarkdownSource(node) === null) return [];
  const inventory: SourceFootnote[] = [];
  (node.attrs.labelParts as CommentMarkdownNavigation["labelParts"]).forEach(part => {
    if (part.footnote !== undefined) inventory.push({ kind: "reference", label: part.footnote });
    else if (part.inlineFootnote !== undefined) inventory.push({ kind: "inline", content: part.inlineFootnote });
  });
  footnoteInventories.set(node, inventory);
  return inventory;
}

/** Definition resolution is presentation, rather than stale stored identity. */
export function commentMarkdownDisplayText(node: PMNode, definitions: ReadonlySet<string>): string | null {
  if (commentMarkdownSource(node) === null) return null;
  return (node.attrs.labelParts as CommentMarkdownNavigation["labelParts"])
    .map(part => part.text ?? (part.footnote !== undefined && !definitions.has(part.footnote) ? part.footnote : "")).join("");
}

/** Only Markdown occurrences opened inside a genuine hidden HTML scope are
 * opaque owners. A span inside an already-open visible link stays scoped to
 * that link's native DOM ownership rules. */
export function commentMarkdownNavigationPlugin(md: MarkdownIt): void {
  nativeGrammar = md;
  const scopes = new WeakMap<StateInline, { scanned: number; hidden: number }>();
  const occurrences = new WeakMap<StateInline, { source: string; limit: number; positions: ReadonlyMap<number, LexicalOccurrence> }>();
  md.inline.ruler.before("link", "comment_markdown_navigation", (state, silent) => {
    const scope = scopes.get(state) ?? { scanned: 0, hidden: 0 };
    for (; scope.scanned < state.tokens.length; scope.scanned++) {
      const token = state.tokens[scope.scanned];
      if (token.type === "html_comment_open" && token.markup !== "<!--") scope.hidden++;
      else if (token.type === "html_comment_close" && token.markup !== "-->") scope.hidden = Math.max(0, scope.hidden - 1);
    }
    scopes.set(state, scope);
    if (!scope.hidden || (state.src[state.pos] !== "[" && !(state.src[state.pos] === "!" && state.src[state.pos + 1] === "["))) return false;
    let cached = occurrences.get(state);
    if (!cached || cached.source !== state.src || cached.limit !== state.posMax) {
      cached = { source: state.src, limit: state.posMax,
        positions: new Map(lexicalOccurrences(state.src.slice(0, state.posMax)).map(item => [item.start, item])) };
      occurrences.set(state, cached);
    }
    const raw = cached.positions.get(state.pos);
    if (!raw || /[\r\n\0]/.test(state.src.slice(raw.start, raw.end)) || state.src.slice(raw.start, raw.end).includes("%%")) return false;
    const item = assembleOccurrence(md, state.src, raw);
    if (!silent) state.push("comment_navigation", "", 0).meta = { ...item, sourceKind: "span" };
    state.pos = item.end;
    return true;
  });
}
