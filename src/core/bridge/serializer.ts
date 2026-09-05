import { Node as PMNode, Fragment, Mark } from "prosemirror-model";
import { schema } from "../schema";
import { CANONICAL_DEFAULTS, type CanonicalFormOptions } from "./common";
import { isDigitCode } from "../inline-math-delimiters";
import {
  flatListLayoutFor,
  listItemCanRepresentLooseNestedEdge,
  listItemHasSyntheticLeadingParagraph,
  listItemIsMarkerOnly,
  listItemRequiresLooseParentEdge,
  listKind,
  orderedListStart,
  type FlatListLayoutEntry,
} from "../list-layout";



// ═══════════════════════════════════════════════
//  SERIALIZER: ProseMirror doc -> markdown
// ═══════════════════════════════════════════════

// ── Mark specs ──

export interface MarkSpec {
  open: string | ((mark: Mark, parent: PMNode, index: number) => string);
  close: string | ((mark: Mark, parent: PMNode, index: number) => string);
  escape?: boolean;  // default true - escape text inside this mark?
  expel?: boolean | ((mark: Mark) => boolean);
  /** Lower rank = opens FIRST (outer mark wrapping everything else).
   *  HTML wrapping marks (font, underline, etc.) want to open
   *  outside markdown content marks (strong, em) so the source reads
   *  `<font>**bold**</font>`, not `**<font>bold**</font>`. Default 100. */
  rank?: number;
}

export const markSpecs: Record<string, MarkSpec> = {
  strong:        { open: "**", close: "**", expel: true },
  em:            { open: "*",  close: "*",  expel: true },
  strikethrough: { open: "~~", close: "~~", expel: true },
  highlight: {
    // A custom `color` attr forces HTML form so the
    // background survives the round-trip. Plain (no color)
    // highlights honour `html` for the markdown vs HTML shape choice.
    open: (mark) => {
      if (mark.attrs.color) {
        return `<mark style="background:${mark.attrs.color}">`;
      }
      return mark.attrs.html ? "<mark>" : "==";
    },
    close: (mark) =>
      mark.attrs.color || mark.attrs.html ? "</mark>" : "==",
    expel: (mark) => !mark.attrs.color && !mark.attrs.html,
    // `escape: false` - the highlight plugin's `==…==` rule consumes
    // the inner content as a single raw text token (no inline-rule
    // re-tokenization), and the parser side doesn't de-escape `\…`
    // sequences inside that span. Escaping markdown syntax inside
    // would create an escape-loop on round-trip: each save adds
    // another layer of backslashes because re-parse keeps the literal
    // `\[` text-content and re-emit escapes the backslash. Tradeoff:
    // a user who authors `==**bold inside**==` won't get nested bold
    // recognized - but that's already the parser's current behavior
    // (highlight is opaque to inner inline rules). escape:false just
    // makes the serializer match the parser's opacity.
    escape: false,
  },
  // `escape: false` - the comment span's content is treated as opaque
  // by the obsidian comment plugin (no inner inline rules fire on it).
  // Escaping markdown syntax inside would create an escape-loop on
  // round-trip: each save adds another layer of backslashes, because
  // re-parse keeps the literal `\*` text-content (the comment plugin
  // doesn't de-escape) and re-emit escapes the backslash. Opaque
  // content with no inner tokenization should never be escaped.
  comment:       { open: "%%", close: "%%", escape: false },
  // Common inline HTML tags. expel:true so adjacent whitespace is
  // pushed outside the tag (markdown convention; matches how strong/
  // em/highlight already behave). rank:0 so they open OUTSIDE
  // markdown content marks (strong, em, etc.) - produces
  // `<font>**bold**</font>` rather than the malformed
  // `**<font>bold**</font>`.
  underline:   { open: "<u>",   close: "</u>",   rank: 0 },
  superscript: { open: "<sup>", close: "</sup>", rank: 0 },
  subscript:   { open: "<sub>", close: "</sub>", rank: 0 },
  kbd:         { open: "<kbd>", close: "</kbd>", rank: 0 },
  font: {
    open: (mark) => {
      const parts: string[] = [];
      if (mark.attrs.color) parts.push(`color="${mark.attrs.color}"`);
      if (mark.attrs.face) parts.push(`face="${mark.attrs.face}"`);
      if (mark.attrs.size) parts.push(`size="${mark.attrs.size}"`);
      return parts.length ? `<font ${parts.join(" ")}>` : "<font>";
    },
    close: () => "</font>",
    rank: 0,
  },
  code: {
    open:   (_m, parent, idx) => backticksFor(parent.child(idx), -1),
    close:  (_m, parent, idx) => backticksFor(parent.child(idx - 1), 1),
    escape: false,
  },
  link: {
    open: "[",
    close: (mark) => {
      // href: CommonMark allows two forms: `(href)` (plain) and
      // `(<href>)` (angle-bracketed, allows whitespace and parens).
      // Plain form must escape `(` `)` and disallow whitespace.
      // Angle form must escape `<` `>` `\` and disallow line breaks.
      // Pick angle form when href contains whitespace or unbalanced
      // parens; otherwise plain (which is the common case and matches
      // what users authored).
      const href = markdownDestination((mark.attrs.href ?? "") as string);
      // title: `"..."`. Inner `"` and `\` need backslash-escaping so
      // the title parses back as a single string. Without this, a
      // title like `she said "hi"` round-trips as broken markdown.
      const rawTitle = (mark.attrs.title ?? "") as string;
      const t = rawTitle
        ? ` "${markdownTitle(rawTitle)}"`
        : "";
      return `](${href}${t})`;
    },
  },
};

function backticksFor(node: PMNode, side: number): string {
  const re = /`+/g;
  let m, len = 0;
  if (node.isText) while ((m = re.exec(node.text!))) len = Math.max(len, m[0].length);
  let result = len > 0 && side > 0 ? " `" : "`";
  for (let i = 0; i < len; i++) result += "`";
  if (len > 0 && side < 0) result += " ";
  return result;
}

// ── Canonical-form preferences ──

// ── Escape helpers ──

function escapeTildeRuns(str: string): string {
  return str.replace(/~{2,}/g, (run) => run.replace(/~/g, "\\~"));
}

function escapeTagLikeHashes(str: string, boundaryAtStart: boolean): string {
  return str.replace(
    /(^|[ \t\r\n])#(?=[A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g,
    (match, prefix: string, offset: number) => {
      if (offset === 0 && prefix === "" && !boundaryAtStart) return match;
      return `${prefix}\\#`;
    },
  );
}

function protectEntityLikeAmpersands(
  str: string,
  replacement: "\\&" | "&amp;",
): string {
  return str.replace(
    /&(?=(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);)/g,
    replacement,
  );
}

function markdownDestination(value: string): string {
  let raw = protectEntityLikeAmpersands(value, "&amp;");
  raw = raw.replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
  const needsAngle = /[\s()<>\\]/.test(raw);
  return needsAngle
    ? `<${raw.replace(/([<>\\])/g, "\\$1")}>`
    : raw;
}

function markdownTitle(value: string): string {
  let raw = protectEntityLikeAmpersands(value, "&amp;");
  raw = raw.replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
  return raw.replace(/(["\\])/g, "\\$1");
}

function encodeBoundaryWhitespace(value: string): string {
  return value.replace(/ /g, "&#32;").replace(/\t/g, "&#9;");
}

function longestCharacterRun(value: string, character: "`" | "~"): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function safeCodeFence(
  content: string,
  language: string,
  preferred: "```" | "~~~",
): string {
  // CommonMark forbids backticks anywhere in a backtick-fence info string.
  // A tilde info string that itself starts with `~` requires a separating
  // space, which markdown-it retains as part of `token.info`. Prefer the
  // alternate delimiter so the PM attribute reparses exactly. If both
  // delimiter constraints apply, there is no lossless CommonMark encoding;
  // refuse instead of silently changing the language attribute.
  const hasBacktick = language.includes("`");
  const startsWithTilde = language.startsWith("~");
  if (hasBacktick && startsWithTilde) {
    throw new Error(
      "Code-block language cannot start with '~' and contain a backtick",
    );
  }
  let character = preferred[0] as "`" | "~";
  if (character === "`" && hasBacktick) character = "~";
  if (character === "~" && startsWithTilde) character = "`";
  return character.repeat(
    Math.max(3, longestCharacterRun(content, character) + 1),
  );
}

function esc(str: string, startOfLine = false, tagBoundaryAtStart = startOfLine): string {
  str = str.replace(/[`*\\[\]_]/g, "\\$&");
  str = escapeTildeRuns(str);
  // Literal entity-looking text must remain literal text. markdown-it decodes
  // `&nbsp;`, `&#160;`, etc. during parse, so a user typing those characters
  // would otherwise get a different document after save/reload. Protect the
  // ampersand before encoding actual NBSP characters on the next line.
  str = protectEntityLikeAmpersands(str, "\\&");
  str = str.replace(/\u00a0/g, "&nbsp;");
  if (startOfLine)
    str = str
      .replace(/^[#\-*+>]/, "\\$&")
      .replace(/^(\s*\d+)([.)])/, "$1\\$2");
  str = escapeTagLikeHashes(str, tagBoundaryAtStart);
  return str;
}

// True when the LAST LINE of `out` consists only of block-level
// prefix tokens - continuation delim chars (`>`, whitespace), list
// markers (`-`, `*`, `+`, `N.`), task markers (`[ ]`, `[x]`, `[X]`).
// In that state the next char written is effectively at the start
// of inner content (after the prefix), and SOL escape rules apply
// - even though `out` doesn't literally end with `\n`. Used by the
// SerState.text() escape-decision to extend SOL handling into
// wrapped contexts (blockquote / list_item / callout body) without
// requiring those serializers to thread an explicit "next is SOL"
// flag through every call site.
function isInnerLineStart(out: string): boolean {
  const lastNL = out.lastIndexOf("\n");
  const lastLine = lastNL >= 0 ? out.slice(lastNL + 1) : out;
  // Only-prefix means: any combination of whitespace, `>` markers,
  // and at most one list marker followed by optional task marker.
  // The regex is permissive - false positives (treating non-prefix
  // text as SOL) only ADD a backslash escape, which is benign on
  // round-trip; false negatives (missing a real SOL) are the bug
  // we're trying to avoid.
  return /^[ \t>]*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?$/.test(lastLine);
}

// ── Serializer state ──

export type NodeSer = (state: SerState, node: PMNode, parent?: PMNode, index?: number) => void;

type DelimiterBoundaryFallbacks = Map<number, Set<string>>;
const unknownDelimiterBoundary = Symbol("unknown-delimiter-boundary");
type DelimiterBoundary = string | null | typeof unknownDelimiterBoundary;

const unicodePunctuationOrSymbol = /[\p{P}\p{S}]/u;

function firstCodePoint(value: string): string | null {
  for (const character of value) return character;
  return null;
}

function lastCodePoint(value: string): string | null {
  let result: string | null = null;
  for (const character of value) result = character;
  return result;
}

/** Match markdown-it's whitespace classification used by scanDelims(). */
function isDelimiterWhitespace(character: string | null): boolean {
  if (character === null) return true;
  const code = character.codePointAt(0)!;
  if (code >= 0x2000 && code <= 0x200a) return true;
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function isDelimiterPunctuation(character: string | null): boolean {
  return character !== null && unicodePunctuationOrSymbol.test(character);
}

function delimiterFlags(
  before: string | null,
  after: string | null,
  canSplitWord: boolean,
): { canOpen: boolean; canClose: boolean } {
  const beforeWhitespace = isDelimiterWhitespace(before);
  const afterWhitespace = isDelimiterWhitespace(after);
  const beforePunctuation = isDelimiterPunctuation(before);
  const afterPunctuation = isDelimiterPunctuation(after);
  const leftFlanking =
    !afterWhitespace &&
    (!afterPunctuation || beforeWhitespace || beforePunctuation);
  const rightFlanking =
    !beforeWhitespace &&
    (!beforePunctuation || afterWhitespace || afterPunctuation);
  return {
    canOpen:
      leftFlanking &&
      (canSplitWord || !rightFlanking || beforePunctuation),
    canClose:
      rightFlanking &&
      (canSplitWord || !leftFlanking || afterPunctuation),
  };
}

/**
 * The character category at an inline node edge. Text covers the ordinary
 * editing path. Known atoms return the first/last character of their emitted
 * Markdown form. Unknown inline nodes return a sentinel: using HTML is safer
 * than claiming a delimiter position we cannot prove representable.
 */
function inlineBoundaryCharacter(
  node: PMNode,
  side: "first" | "last",
): DelimiterBoundary {
  if (node.isText) {
    return (side === "first"
      ? firstCodePoint(node.text ?? "")
      : lastCodePoint(node.text ?? "")) ?? unknownDelimiterBoundary;
  }
  switch (node.type.name) {
    case "hard_break":
      // Edge/consecutive/heading hard breaks use `<br>` because CommonMark's
      // backslash-newline form is not valid at a block edge. The emitted edge
      // character is therefore context-dependent, just like a softbreak.
      return unknownDelimiterBoundary;
    case "softbreak":
      // Its representation is context-dependent (`\n` or `<br>`).
      return unknownDelimiterBoundary;
    case "image":
      return side === "first" ? "!" : ")";
    case "wikilink":
      return side === "first" ? "[" : "]";
    case "obsidian_embed_inline":
      return side === "first" ? "!" : "]";
    case "obsidian_tag": {
      // The tag serializer may insert a boundary space based on emitted state.
      return unknownDelimiterBoundary;
    }
    case "inline_math":
      return "$";
    case "inline_footnote":
      return side === "first" ? "^" : "]";
    case "block_id": {
      if (side === "first") return "^";
      return lastCodePoint(String(node.attrs.id ?? "")) ?? "^";
    }
    default:
      return unknownDelimiterBoundary;
  }
}

function adjacentBoundaryCharacter(
  parent: PMNode,
  index: number,
  direction: -1 | 1,
): DelimiterBoundary {
  const adjacentIndex = index + (direction < 0 ? -1 : 0);
  return adjacentIndex >= 0 && adjacentIndex < parent.childCount
    ? inlineBoundaryCharacter(
        parent.child(adjacentIndex),
        direction < 0 ? "last" : "first",
      )
    : null;
}

function markedRunEdge(
  parent: PMNode,
  start: number,
  end: number,
  side: "first" | "last",
): { character: DelimiterBoundary; expelledWhitespace: boolean } {
  const direction = side === "first" ? 1 : -1;
  let expelledWhitespace = false;
  for (
    let index = side === "first" ? start : end - 1;
    index >= start && index < end;
    index += direction
  ) {
    const node = parent.child(index);
    if (!node.isText) {
      return {
        character: inlineBoundaryCharacter(node, side),
        expelledWhitespace,
      };
    }
    const characters = Array.from(node.text ?? "");
    if (side === "last") characters.reverse();
    for (const character of characters) {
      if (isDelimiterWhitespace(character)) {
        expelledWhitespace = true;
        continue;
      }
      return { character, expelledWhitespace };
    }
  }
  return { character: unknownDelimiterBoundary, expelledWhitespace };
}

function markdownDelimiterFor(
  mark: Mark,
  canonicalForm: Required<CanonicalFormOptions>,
): string | null {
  switch (mark.type.name) {
    case "strong":
      return canonicalForm.bold;
    case "em":
      return canonicalForm.italic;
    case "strikethrough":
      return "~~";
    case "highlight":
      return mark.attrs.color || mark.attrs.html ? null : "==";
    default:
      return null;
  }
}

function inlineDelimiterSearchText(node: PMNode): string | null {
  if (node.isText) return node.text ?? "";
  switch (node.type.name) {
    case "hard_break":
    case "softbreak":
      return "";
    case "image":
    case "wikilink":
    case "obsidian_embed_inline":
    case "obsidian_tag":
    case "inline_math":
    case "inline_footnote":
    case "block_id":
      // We only need to know whether the emitted atom can contain the
      // delimiter, so inspecting every string attr is conservative and exact
      // for this purpose without duplicating each atom's full serializer.
      return JSON.stringify(node.attrs);
    default:
      return null;
  }
}

function markedRunContains(
  parent: PMNode,
  start: number,
  end: number,
  needle: string,
): boolean | null {
  let text = "";
  for (let index = start; index < end; index++) {
    const childText = inlineDelimiterSearchText(parent.child(index));
    if (childText === null) return null;
    text += childText;
    if (text.includes(needle)) return true;
    if (text.length > needle.length) text = text.slice(-(needle.length - 1));
  }
  return false;
}

function markedRunIncludesMark(
  parent: PMNode,
  start: number,
  end: number,
  markName: string,
): boolean {
  for (let index = start; index < end; index++) {
    if (parent.child(index).marks.some((mark) => mark.type.name === markName)) {
      return true;
    }
  }
  return false;
}

function nestedDelimiterBoundaryOverrides(
  parent: PMNode,
  mark: Mark,
  start: number,
  end: number,
  canonicalForm: Required<CanonicalFormOptions>,
): { before: boolean; first: boolean; last: boolean; after: boolean } {
  const result = { before: false, first: false, last: false, after: false };
  const delimiter = markdownDelimiterFor(mark, canonicalForm);
  if (delimiter === null) return result;
  const ordered = parent.child(start).marks
    .filter((candidate) => markdownDelimiterFor(candidate, canonicalForm) !== null)
    .slice()
    .sort((left, right) => {
      const leftRank = markSpecs[left.type.name]?.rank ?? 100;
      const rightRank = markSpecs[right.type.name]?.rank ?? 100;
      return leftRank - rightRank;
    });
  const ownIndex = ordered.findIndex((candidate) => candidate.eq(mark));
  if (ownIndex < 0) return result;
  const previousMarks = start > 0 ? parent.child(start - 1).marks : [];
  const nextMarks = end < parent.childCount ? parent.child(end).marks : [];

  for (let index = 0; index < ordered.length; index++) {
    if (index === ownIndex) continue;
    const peer = ordered[index];
    const peerDelimiter = markdownDelimiterFor(peer, canonicalForm);
    // Identical delimiter characters form one markdown-it run (`***`), whose
    // flanking context is the semantic content outside the complete run.
    if (peerDelimiter === null || peerDelimiter[0] === delimiter[0]) continue;
    const peerStartsHere = !peer.isInSet(previousMarks);
    const peerEndsHere =
      Boolean(peer.isInSet(parent.child(end - 1).marks)) &&
      !peer.isInSet(nextMarks);
    if (peerStartsHere) {
      if (index < ownIndex) result.before = true;
      else result.first = true;
    }
    if (peerEndsHere) {
      if (index < ownIndex) result.after = true;
      else result.last = true;
    }
  }
  return result;
}

function markedRunNeedsHtml(
  parent: PMNode,
  mark: Mark,
  start: number,
  end: number,
  canonicalForm: Required<CanonicalFormOptions>,
): boolean {
  const delimiter = markdownDelimiterFor(mark, canonicalForm);
  if (delimiter === null) return false;

  // Obsidian comments are opaque to inner Markdown tokenization. Any
  // delimiter mark sharing their text must wrap the comment in an HTML mark;
  // putting Markdown delimiters inside `%%...%%` turns them into literal text.
  if (markedRunIncludesMark(parent, start, end, "comment")) return true;

  // The Obsidian highlight rule pairs with the first raw closing `==`.
  // There is no Markdown escape for `=` in this syntax, so literal content
  // containing the delimiter requires the equivalent HTML mark.
  if (
    mark.type.name === "highlight" &&
    markedRunContains(parent, start, end, "==") !== false
  ) {
    return true;
  }
  if (mark.type.name === "highlight") return false;

  const firstEdge = markedRunEdge(parent, start, end, "first");
  const lastEdge = markedRunEdge(parent, start, end, "last");
  if (
    firstEdge.character === unknownDelimiterBoundary ||
    lastEdge.character === unknownDelimiterBoundary
  ) {
    return true;
  }

  const adjacentBefore = adjacentBoundaryCharacter(parent, start, -1);
  const adjacentAfter = adjacentBoundaryCharacter(parent, end, 1);
  if (
    adjacentBefore === unknownDelimiterBoundary ||
    adjacentAfter === unknownDelimiterBoundary
  ) {
    return true;
  }
  const nested = nestedDelimiterBoundaryOverrides(
    parent,
    mark,
    start,
    end,
    canonicalForm,
  );
  const punctuationBoundary = "!";
  const before = nested.before
    ? punctuationBoundary
    : firstEdge.expelledWhitespace ? " " : adjacentBefore;
  const first = nested.first ? punctuationBoundary : firstEdge.character;
  const last = nested.last ? punctuationBoundary : lastEdge.character;
  const after = nested.after
    ? punctuationBoundary
    : lastEdge.expelledWhitespace ? " " : adjacentAfter;
  const canSplitWord = delimiter[0] !== "_";
  return (
    !delimiterFlags(before, first, canSplitWord).canOpen ||
    !delimiterFlags(last, after, canSplitWord).canClose
  );
}

/**
 * Map unsafe Markdown mark runs by their semantic start child. A mark can
 * occur in several disjoint runs with identical attrs; keeping the decision
 * per run preserves Markdown for safe spans while using HTML only where the
 * parser's delimiter grammar cannot represent the exact interval.
 */
function computeDelimiterBoundaryFallbacks(
  parent: PMNode,
  canonicalForm: Required<CanonicalFormOptions>,
): DelimiterBoundaryFallbacks {
  type OpenRun = { mark: Mark; start: number };
  const openRuns = new Map<string, OpenRun>();
  const fallbacks: DelimiterBoundaryFallbacks = new Map();

  for (let index = 0; index <= parent.childCount; index++) {
    const marks = index < parent.childCount
      ? parent.child(index).marks.filter(
          (mark) => markdownDelimiterFor(mark, canonicalForm) !== null,
        )
      : [];
    const current = new Map(
      marks.map((mark) => [SerState.markKey(mark), mark] as const),
    );

    for (const [key, run] of openRuns) {
      if (current.has(key)) continue;
      if (markedRunNeedsHtml(parent, run.mark, run.start, index, canonicalForm)) {
        const starts = fallbacks.get(run.start) ?? new Set<string>();
        starts.add(key);
        fallbacks.set(run.start, starts);
      }
      openRuns.delete(key);
    }
    for (const [key, mark] of current) {
      if (!openRuns.has(key)) openRuns.set(key, { mark, start: index });
    }
  }
  return fallbacks;
}

/** Compute mark keys that need HTML-form emission.
 *
 * The analysis is linear in inline children plus total mark occurrences. A
 * previous implementation compared every distinct mark key with every other
 * key, making a paragraph with N distinct links O(N^2) even though none could
 * overlap. Here stack transitions detect crossings, a whitespace prefix sum
 * handles split runs, and a disjoint-set expands flags through co-marked
 * components. */
function computeOverlapKeys(parent: PMNode): Set<string> {
  type Range = { start: number; end: number };

  const allRanges = new Map<string, Range[]>();
  const open = new Map<string, Range>();
  const childKeySets: Set<string>[] = [];
  const nestedOpaqueHighlights = new Set<string>();

  // Co-mark connectivity is exactly the transitive overlap relation used by
  // the old flag-propagation pass. Unioning every child mark set as a star
  // avoids materializing the potentially quadratic overlap graph.
  const dsuParent = new Map<string, string>();
  const find = (key: string): string => {
    let root = dsuParent.get(key) ?? key;
    while (root !== (dsuParent.get(root) ?? root)) {
      root = dsuParent.get(root)!;
    }
    let cursor = key;
    while (cursor !== root) {
      const next = dsuParent.get(cursor) ?? cursor;
      dsuParent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const ensure = (key: string): void => {
    if (!dsuParent.has(key)) dsuParent.set(key, key);
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) dsuParent.set(rightRoot, leftRoot);
  };

  let previousKeys = new Set<string>();
  let childIndex = 0;
  parent.forEach((child) => {
    const marks = child.isText && child.marks.length
      ? child.marks.slice().sort((a, b) => {
          const ra = markSpecs[a.type.name]?.rank ?? 100;
          const rb = markSpecs[b.type.name]?.rank ?? 100;
          return ra - rb;
        })
      : [];
    const childKeys = new Set<string>();
    let firstKey: string | null = null;

    for (const mark of marks) {
      const key = SerState.markKey(mark);
      childKeys.add(key);
      ensure(key);
      if (firstKey === null) firstKey = key;
      else union(firstKey, key);
      if (
        mark.type.name === "highlight" &&
        !mark.attrs.html &&
        !mark.attrs.color &&
        marks.length > 1
      ) {
        nestedOpaqueHighlights.add(key);
      }
    }

    // Only marks active on the previous child can close here. This makes run
    // tracking proportional to represented mark occurrences, not all keys.
    for (const key of previousKeys) {
      if (childKeys.has(key)) continue;
      const range = open.get(key);
      if (!range) continue;
      const ranges = allRanges.get(key) ?? [];
      ranges.push(range);
      allRanges.set(key, ranges);
      open.delete(key);
    }
    for (const key of childKeys) {
      const range = open.get(key);
      if (range) range.end = childIndex + 1;
      else open.set(key, { start: childIndex, end: childIndex + 1 });
    }

    childKeySets.push(childKeys);
    previousKeys = childKeys;
    childIndex += 1;
  });

  for (const [key, range] of open) {
    const ranges = allRanges.get(key) ?? [];
    ranges.push(range);
    allRanges.set(key, ranges);
  }

  // Markdown `==...==` is opaque to inner inline parsing. Keep the PM attr
  // cosmetic (`html:false`) but emit this span as `<mark>` whenever another
  // mark shares its text; the parser maps HTML back to the same PM mark.
  const overlap = new Set<string>(nestedOpaqueHighlights);

  // A repeated Markdown-delimited mark nested inside another delimiter run is
  // safe only when the intervening source is whitespace-delimited on both
  // sides. Interior whitespace is not sufficient: `***a*words here*b***`
  // remains ambiguous because both inner `*` boundaries touch word chars.
  // Inspecting the two boundary children keeps every gap query O(1).
  for (const [key, runs] of allRanges) {
    for (let runIndex = 0; runIndex < runs.length - 1; runIndex++) {
      const gapStart = runs[runIndex].end;
      const gapEnd = runs[runIndex + 1].start;
      const firstGapChild = parent.maybeChild(gapStart);
      const lastGapChild = parent.maybeChild(gapEnd - 1);
      const safelyDelimited = Boolean(
        gapStart < gapEnd &&
        firstGapChild?.isText &&
        /^\s/.test(firstGapChild.text ?? "") &&
        lastGapChild?.isText &&
        /\s$/.test(lastGapChild.text ?? ""),
      );
      if (!safelyDelimited) {
        overlap.add(key);
        break;
      }
    }
  }

  if (allRanges.size < 2) return overlap;

  // A strict range interleave is precisely a stack transition where a mark
  // closes below a mark that remains active. Scan each active stack bottom-up:
  // every staying mark above a closer and every such closer need HTML form.
  // Pending closers are each visited once, avoiding the old nested scans.
  let stack: string[] = [];
  for (const targetSet of childKeySets) {
    const pendingClosers: string[] = [];
    let hasCloserBelow = false;
    for (const key of stack) {
      if (targetSet.has(key)) {
        if (hasCloserBelow) overlap.add(key);
        if (pendingClosers.length > 0) {
          for (const closingKey of pendingClosers) overlap.add(closingKey);
          pendingClosers.length = 0;
        }
      } else {
        pendingClosers.push(key);
        hasCloserBelow = true;
      }
    }

    stack = stack.filter((key) => targetSet.has(key));
    const active = new Set(stack);
    for (const key of targetSet) {
      if (active.has(key)) continue;
      stack.push(key);
      active.add(key);
    }
  }

  // Expand through connected co-mark components. This is equivalent to the
  // old fixed-point propagation over overlapping runs, without pairwise key
  // or range comparisons.
  if (overlap.size > 0) {
    const flaggedRoots = new Set<string>();
    for (const key of overlap) flaggedRoots.add(find(key));
    for (const key of allRanges.keys()) {
      if (flaggedRoots.has(find(key))) overlap.add(key);
    }
  }
  return overlap;
}

interface SerOutputSnapshot {
  output: string;
  outputAtBlank: boolean;
  outputLastCode: number;
  outputPrefixTail: string | null;
  inlineMathClosePending: boolean;
}

export class SerState {
  private output = "";
  private outputAtBlank = true;
  private outputLastCode = -1;
  private outputPrefixTail: string | null = "";

  get out(): string { return this.output; }

  resetOutput(value: string): void {
    this.output = value;
    this.outputAtBlank = value.length === 0 || value.endsWith("\n");
    this.outputLastCode = value.length > 0 ? value.charCodeAt(value.length - 1) : -1;
    const lastNewline = value.lastIndexOf("\n");
    const tail = lastNewline >= 0 ? value.slice(lastNewline + 1) : value;
    this.outputPrefixTail = isInnerLineStart(tail) ? tail : null;
  }

  snapshotOutput(): SerOutputSnapshot {
    return {
      output: this.output,
      outputAtBlank: this.outputAtBlank,
      outputLastCode: this.outputLastCode,
      outputPrefixTail: this.outputPrefixTail,
      inlineMathClosePending: this.inlineMathClosePending,
    };
  }

  restoreOutput(snapshot: SerOutputSnapshot): void {
    this.output = snapshot.output;
    this.outputAtBlank = snapshot.outputAtBlank;
    this.outputLastCode = snapshot.outputLastCode;
    this.outputPrefixTail = snapshot.outputPrefixTail;
    this.inlineMathClosePending = snapshot.inlineMathClosePending;
  }

  replaceOutputSince(snapshot: SerOutputSnapshot, replacement: string): void {
    this.restoreOutput(snapshot);
    // `replacement` is already rendered output and may already include the
    // active block delimiter. Re-entering through write() would prepend that
    // delimiter a second time inside blockquotes/callouts.
    this.appendOutput(replacement);
  }

  private appendOutput(value: string): void {
    if (!value) return;
    this.output += value;
    this.outputLastCode = value.charCodeAt(value.length - 1);
    const lastNewline = value.lastIndexOf("\n");
    if (lastNewline >= 0) {
      const tail = value.slice(lastNewline + 1);
      this.outputAtBlank = tail.length === 0;
      this.outputPrefixTail = isInnerLineStart(tail) ? tail : null;
    } else {
      this.outputAtBlank = false;
      if (this.outputPrefixTail !== null) {
        const tail = this.outputPrefixTail + value;
        this.outputPrefixTail = isInnerLineStart(tail) ? tail : null;
      }
    }
  }

  lastOutputCharacter(): string {
    return this.outputLastCode < 0 ? "" : String.fromCharCode(this.outputLastCode);
  }

  atTagBoundary(): boolean {
    const code = this.outputLastCode;
    return code < 0 || code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
  }

  atInnerLineStart(): boolean { return this.outputPrefixTail !== null; }

  /**
   * Spaces and tabs immediately before a Markdown line break are syntax: one
   * is discarded and two or more create a hard break. Encode only that
   * boundary run so ordinary editor text survives exactly.
   */
  encodeTrailingBreakWhitespace(): void {
    const match = /[ \t]+$/.exec(this.output);
    if (!match) return;
    this.resetOutput(
      this.output.slice(0, -match[0].length) +
        encodeBoundaryWhitespace(match[0]),
    );
  }

  closed: PMNode | false = false;
  delim = "";
  canonicalForm: Required<CanonicalFormOptions>;
  inlineMathClosePending = false;

  /** Marks (by type+attrs key) whose range overlaps another mark's
   *  range in the current inline-render parent. CommonMark emphasis
   *  pairs require strict nesting, so `**` / `*` can't represent
   *  overlap; for these marks we emit `<strong>` / `<em>` HTML form
   *  instead, which my htmlInlineTagsPlugin handles via any-match
   *  close. Set is repopulated per renderInline() call. */
  overlapKeys: Set<string> = new Set();
  delimiterBoundaryFallbacks: DelimiterBoundaryFallbacks = new Map();

  constructor(options?: CanonicalFormOptions) {
    this.canonicalForm = { ...CANONICAL_DEFAULTS, ...(options ?? {}) };
  }

  /** Stable per-instance key for a mark - type + attrs JSON. Two
   *  marks with the same key are considered "the same instance" for
   *  range-tracking; PM normalizes mark equality this way too. */
  static markKey(mark: Mark): string {
    return mark.type.name + "::" + JSON.stringify(mark.attrs);
  }

  isOverlap(mark: Mark): boolean {
    return this.overlapKeys.has(SerState.markKey(mark));
  }

  /** Resolve a mark's open string, honoring user canonical preferences
   *  for `strong` / `em` while leaving other marks at their spec
   *  defaults. Returns the same string the spec would have produced
   *  unless the option overrides it.
   *
   *  When a mark is in `overlapKeys` (set by `computeOverlapKeys`),
   *  we route every markdown-form delimited mark to its HTML form
   *  so the close-and-reopen pattern doesn't land delimiters at
   *  non-flanking positions on re-parse. Marks covered:
   *    strong (`**` → `<strong>`)
   *    em (`*` → `<em>`)
   *    strikethrough (`~~` → `<s>`)
   *    highlight (`==` → `<mark>`)
   *  Marks already in HTML form (font, underline, sup, sub, kbd)
   *  don't need this branch - their spec.open IS the HTML tag. */
  markOpen(
    mark: Mark,
    parent: PMNode,
    index: number,
    forceHtml = false,
  ): string {
    const name = mark.type.name;
    if (this.isOverlap(mark) || forceHtml) {
      if (name === "strong") return "<strong>";
      if (name === "em") return "<em>";
      if (name === "strikethrough") return "<s>";
      if (name === "highlight") {
        return mark.attrs.color
          ? `<mark style="background:${mark.attrs.color}">`
          : "<mark>";
      }
    }
    if (name === "strong") return this.canonicalForm.bold;
    if (name === "em") return this.canonicalForm.italic;
    const spec = markSpecs[name];
    return typeof spec.open === "function"
      ? spec.open(mark, parent, index)
      : spec.open;
  }

  markClose(
    mark: Mark,
    parent: PMNode,
    index: number,
    forceHtml = false,
  ): string {
    const name = mark.type.name;
    if (this.isOverlap(mark) || forceHtml) {
      if (name === "strong") return "</strong>";
      if (name === "em") return "</em>";
      if (name === "strikethrough") return "</s>";
      if (name === "highlight") return "</mark>";
    }
    if (name === "strong") return this.canonicalForm.bold;
    if (name === "em") return this.canonicalForm.italic;
    const spec = markSpecs[name];
    return typeof spec.close === "function"
      ? spec.close(mark, parent, index)
      : spec.close;
  }

  // ── primitives ──

  atBlank(): boolean { return this.outputAtBlank; }

  flushClose(size = 2) {
    if (!this.closed) return;
    if (!this.atBlank()) this.appendOutput("\n");
    for (let i = 1; i < size; i++) this.appendOutput(this.delim + "\n");
    this.closed = false;
  }

  /** Write raw content. Prepends delim if at line start. */
  write(s: string) {
    this.flushClose();
    if (this.delim && this.atBlank()) this.appendOutput(this.delim);
    this.appendOutput(s);
  }

  /** Write text with optional escaping and per-line delim. */
  text(text: string, escape = true) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Start-of-line is true for `i > 0` (after explicit newline)
      // OR output ends with `\n` OR a block just closed OR the last
      // line of output is composed only of MARKDOWN BLOCK PREFIXES
      // (continuation delim like `> `, list markers like `- ` /
      // `1. `, task markers `[ ]` / `[x]`, all interleaved with
      // whitespace). The last clause is what makes text-escape work
      // INSIDE wrapped containers - blockquote prepends `> ` on each
      // inner line; list_item writes a marker `- ` before the
      // paragraph's text; in both cases the next char IS at start-
      // of-inner-content even though `\n` isn't the very last byte
      // in `this.out`. Pre-fix, text-looks-like-block patterns
      // (`## title`, `- list`, `> quote`, `---`) round-tripped
      // wrong inside lists / blockquotes because SOL escape didn't
      // fire there.
      const sol =
        i > 0 ||
        this.atBlank() ||
        !!this.closed ||
        this.atInnerLineStart();
      this.flushClose();
      if (i > 0) {
        this.appendOutput("\n");
        if (this.delim) this.appendOutput(this.delim);
      } else if (this.delim && this.atBlank()) {
        this.appendOutput(this.delim);
      }
      const tagBoundaryAtStart = sol || this.atTagBoundary();
      this.appendOutput(escape ? esc(lines[i], sol, tagBoundaryAtStart) : lines[i]);
    }
  }

  writeTextAfterInlineMath(text: string, escape = true) {
    let rest = text;
    if (this.inlineMathClosePending && this.outputLastCode === 0x24 && rest.length > 0) {
      const first = rest.charCodeAt(0);
      if (first === 0x24 /* $ */ || isDigitCode(first)) {
        this.write(first === 0x24 /* $ */ ? "&#36;" : `&#${first};`);
        rest = rest.slice(1);
      }
    }
    this.inlineMathClosePending = false;
    if (rest) this.text(rest, escape);
  }

  closeBlock(node: PMNode) { this.closed = node; }

  wrapBlock(delim: string, firstDelim: string | null, node: PMNode, fn: () => void) {
    const old = this.delim;
    this.write(firstDelim ?? delim);
    this.delim += delim;
    fn();
    this.delim = old;
    this.closeBlock(node);
  }

  // ── source-preservation context (optional) ──
  // Set by serializeWithSourcePreservation when re-serializing an
  // edited top-level block. If a rendered inline atom is in the
  // original set AND has a valid sourceRange, we bypass its handler
  // and emit the original bytes verbatim - byte-level preservation
  // for atoms even when their containing block is being synthesized.
  sourcePresBody: string | null = null;
  sourcePresOriginalAtoms: Set<PMNode> | null = null;
  topLevelListOverride: {
    node: PMNode;
    depthIndent: string;
    marker: string;
    continuationColumns: number;
  } | null = null;

  // ── rendering ──

  renderNode(node: PMNode, parent?: PMNode, index?: number) {
    // Inline-atom byte-preservation hook. Only fires inside an
    // edited-block synthesis path that set sourcePresBody +
    // sourcePresOriginalAtoms. The check is cheap (Set.has +
    // attribute lookup) and falls through to the normal handler
    // when preservation isn't available or applicable.
    if (
      node.isInline &&
      node.isAtom &&
      this.sourcePresBody != null &&
      this.sourcePresOriginalAtoms?.has(node)
    ) {
      const r = node.attrs.sourceRange as
        | { start: number; end: number }
        | null;
      if (
        r &&
        r.start >= 0 &&
        r.end >= r.start &&
        r.end <= this.sourcePresBody.length
      ) {
        // Some inline atoms require a whitespace-or-start-of-line
        // boundary to parse. When a block merge / inline edit puts
        // the atom next to a non-whitespace inline sibling (or
        // when mark-overlap serialization emits `</strong>` right
        // before the `#`), markdown-it won't recognize the atom —
        // it stays as literal text. Check the actual output buffer
        // for the trailing char so we catch both PM-sibling and
        // mark-boundary cases. Mirror the same check in
        // nodeSer.obsidian_tag for the handler path.
        if (node.type.name === "obsidian_tag") {
          // Match the at-blank / pending-close guard in
          // nodeSer.obsidian_tag so we don't inject a space at the
          // start of a paragraph after a block close.
          if (!this.closed && !this.atBlank()) {
            const last = this.lastOutputCharacter();
            if (last && !/\s/.test(last)) this.write(" ");
          }
        }
        const source = this.sourcePresBody.slice(r.start, r.end);
        this.write(source);
        this.inlineMathClosePending =
          node.type.name === "inline_math" && source.endsWith("$");
        return;
      }
    }
    const handler = nodeSer[node.type.name];
    if (!handler) throw new Error(`No serializer for: ${node.type.name}`);
    handler(this, node, parent, index);
  }

  renderContent(parent: PMNode) {
    parent.forEach((child, _, i) => this.renderNode(child, parent, i));
  }

  renderInline(parent: PMNode) {
    // Pre-pass: compute which mark instances overlap others within
    // this inline parent. A mark "overlaps" another when their text
    // ranges interleave but don't nest (e.g. `*two **three* four**`
    // - em starts inside strong but ends outside it). CommonMark
    // emphasis pairs require strict nesting; for overlapping em /
    // strong we emit `<em>` / `<strong>` HTML form instead, which
    // round-trips via the any-match close in htmlInlineTagsPlugin.
    // Other marks (font etc.) are already HTML-form so they handle
    // overlap natively.
    this.overlapKeys = computeOverlapKeys(parent);
    this.delimiterBoundaryFallbacks = computeDelimiterBoundaryFallbacks(
      parent,
      this.canonicalForm,
    );

    type ActiveMark = { mark: Mark; forceHtml: boolean };
    let active: ActiveMark[] = [];
    let trailing = "";

    const progress = (child: PMNode | null, _off: number, index: number) => {
      let marks = child
        ? child.marks.filter((m) => markSpecs[m.type.name])
        : [];

      // Sort by explicit serialization rank (lower opens first / outer).
      // Marks without an explicit rank fall back to 100, which keeps
      // their relative order vs schema declaration. HTML wrapping marks
      // declare rank: 0 so they wrap markdown content marks like bold
      // (e.g. <font>**fun**</font>, not **<font>fun**</font>).
      if (marks.length > 1) {
        marks = marks.slice().sort((a, b) => {
          const ra = markSpecs[a.type.name]?.rank ?? 100;
          const rb = markSpecs[b.type.name]?.rank ?? 100;
          return ra - rb;
        });
      }

      // Whitespace expelling
      let leading = trailing;
      trailing = "";
      if (child?.isText && child.text) {
        const sharesOpaqueComment = marks.some(
          (mark) => mark.type.name === "comment",
        );
        if (!sharesOpaqueComment && marks.some((m) => {
          const expel = markSpecs[m.type.name]?.expel;
          return typeof expel === "function" ? expel(m) : expel === true;
        })) {
          const match = /^(\s*)(.*?)(\s*)$/s.exec(child.text);
          if (match && (match[1] || match[3])) {
            leading += match[1];
            trailing = match[3];
            child = match[2]
              ? schema.text(match[2], child.marks)
              : null;
            // When the expelled text has NO inner content (pure
            // whitespace), keep `marks` as the child's original mark
            // set - NOT active.slice(). The previous logic perpetuated
            // active marks across the whitespace, which is wrong when
            // the whitespace text node's actual mark set is NARROWER
            // than what's currently active. That happens when the
            // PM doc structure is e.g. `text[em,strong] · text[em] ·
            // wikilink[em]` - the middle whitespace deliberately drops
            // strong. Keeping strong open through the whitespace
            // produces `**Note **[[link]]` where the closing `**` is
            // preceded by whitespace and can't pair as right-flanking,
            // so markdown-it can't re-pair the strong on reparse.
            //
            // With marks = child.marks, the close-marks loop below
            // closes strong before the whitespace, producing
            // `**Note** [[link]]` - clean and round-tripping.
          }
        }
      }

      // Close marks NOT in the target set. Uses set-membership, not
      // positional prefix, so marks that appear in both sets stay
      // open even if their schema-rank position differs (e.g.
      // [em] → [strong, em] keeps em open).
      //
      // When the to-close mark sits BELOW marks that should stay
      // (e.g., active=[strong, font], target=[font] - strong is
      // outer in the open stack, font is inner), HTML / markdown
      // well-formedness requires closing the inners first, closing
      // the target, then reopening the inners. Without this, naive
      // close-and-splice produces invalid `<strong>two <font>three
      // </strong>` style crossings - markdown-it's HTML pass either
      // strips the orphan or normalizes nesting on re-parse, dropping
      // text content and breaking save round-trip.
      //
      // The fix is the close-and-reopen pattern below: when an
      // unwanted mark is found at index j, close every inner above
      // (top-down), close the target, then reopen the inners that
      // should still be active. Inners that ALSO need to close (i.e.,
      // not in target) get filtered out of the reopen list - they
      // close as a side effect of the inner-close pass.
      for (let j = active.length - 1; j >= 0; j--) {
        if (active[j].mark.isInSet(marks)) continue;
        const reopenList = active
          .slice(j + 1)
          .filter((entry) => entry.mark.isInSet(marks));
        // Close inners (top-down) so the HTML/markdown stack stays
        // well-formed when we close the target below.
        for (let k = active.length - 1; k > j; k--) {
          this.write(this.markClose(
            active[k].mark,
            parent,
            index,
            active[k].forceHtml,
          ));
        }
        // Close the unwanted mark.
        this.write(this.markClose(
          active[j].mark,
          parent,
          index,
          active[j].forceHtml,
        ));
        // Replace active[j..end] with the kept inners. Marks that
        // were above j and aren't in target are simply gone - they
        // already closed in the inner-pass above.
        active.splice(j, active.length - j, ...reopenList);
        // Reopen the kept inners (preserve original opening order).
        for (const entry of reopenList) {
          this.write(this.markOpen(
            entry.mark,
            parent,
            index,
            entry.forceHtml,
          ));
        }
        // Restart from new top - `j--` will fire and land at
        // active.length - 1 next iteration.
        j = active.length;
      }

      // Leading whitespace (between close and open). At the start of a
      // textblock or immediately after a line break, Markdown would trim it
      // or reinterpret it as indentation, so emit character references
      // through the raw writer. Whitespace expelled from a mark stays outside
      // that mark as intended.
      const previousSibling = index > 0 ? parent.child(index - 1) : null;
      const followsBreak = previousSibling?.type.name === "softbreak" ||
        previousSibling?.type.name === "hard_break";
      if (leading) {
        if (
          (index === 0 || followsBreak) &&
          !marks.some((m) => markSpecs[m.type.name]?.escape === false)
        ) {
          const boundary = /^[ \t]+/.exec(leading)?.[0] ?? "";
          if (boundary) {
            this.write(encodeBoundaryWhitespace(boundary));
            leading = leading.slice(boundary.length);
          }
        }
        if (leading) this.write(leading);
      }

      // Open marks NOT currently active
      for (let j = 0; j < marks.length; j++) {
        if (!active.some((entry) => entry.mark.eq(marks[j]))) {
          const forceHtml = Boolean(
            this.delimiterBoundaryFallbacks
              .get(index)
              ?.has(SerState.markKey(marks[j])),
          );
          this.write(this.markOpen(marks[j], parent, index, forceHtml));
          active.push({ mark: marks[j], forceHtml });
        }
      }
      if (!child) return;

      if (child.isText) {
        const noEsc = active.some(
          (entry) => markSpecs[entry.mark.type.name]?.escape === false,
        );
        let text = child.text!;
        if ((index === 0 || followsBreak) && !noEsc) {
          const boundary = /^[ \t]+/.exec(text)?.[0] ?? "";
          if (boundary) {
            this.write(encodeBoundaryWhitespace(boundary));
            text = text.slice(boundary.length);
          }
        }
        if (text) this.writeTextAfterInlineMath(text, !noEsc);
      } else {
        this.renderNode(child, parent, index);
      }
    };

    const startOutput = this.snapshotOutput();
    const startLen = this.out.length;
    parent.forEach((child, off, idx) => progress(child, off, idx));
    progress(null, 0, parent.childCount);
    if (trailing) this.write(trailing);

    // Defensive: text content that ends with `^[A-Za-z0-9_-]+` at the
    // end of a textblock parses back as a `block_id` atom under the
    // markdown-it block-id rule (which fires when the rest-of-line
    // after the id is whitespace-only). Round-trip then drops the
    // characters of the would-be id from textContent - typically how
    // a user typing `^foo` at the end of a line gets a save-failure
    // round-trip rejection. Escape the `^` with a leading backslash
    // so reparse treats it as plain text.
    //
    // Skip this when the parent's last inline child is an actual
    // block_id node - that atom ALSO emits `^id` but we want it to
    // round-trip as a block_id, not be turned into escaped text.
    const lastChild = parent.lastChild;
    if (
      lastChild?.isText &&
      /\^[A-Za-z0-9_-]+$/.test(lastChild.text ?? "")
    ) {
      const tail = this.out.slice(startLen);
      const m = /\^[A-Za-z0-9_-]+$/.exec(tail);
      if (m) {
        const insertAt = tail.length - m[0].length;
        const escapedTail =
          tail.slice(0, insertAt) + "\\" + tail.slice(insertAt);
        this.replaceOutputSince(startOutput, escapedTail);
      }
    }

    // Markdown parsers discard ordinary trailing spaces/tabs at the end of a
    // textblock (and two spaces can acquire hard-break meaning). They are
    // nevertheless normal editable text in PM. Encode only the terminal run
    // so paragraphs, list rows, headings, and container text share one exact
    // representation without changing explicit hard_break nodes.
    if (
      lastChild?.isText &&
      !lastChild.marks.some(
        (mark) => markSpecs[mark.type.name]?.escape === false,
      ) &&
      /[ \t]+$/.test(lastChild.text ?? "")
    ) {
      const tail = this.out.slice(startLen);
      const encodedTail = tail.replace(
        /[ \t]+$/,
        encodeBoundaryWhitespace,
      );
      if (encodedTail !== tail) {
        this.replaceOutputSince(startOutput, encodedTail);
      }
    }
  }

  renderList(
    node: PMNode,
    indent: string,
    getMarker: (i: number) => string,
    parent?: PMNode,
  ) {
    // Separate consecutive same-type lists with an invisible
    // block_comment block. Without a non-list block between them,
    // CommonMark merges adjacent same-marker lists into ONE on
    // reparse - losing the user's intent of "two separate lists."
    // Blank lines alone don't break the adjacency by spec; only a
    // different-kind block does. We use Obsidian's `%%\n\n%%`
    // block-comment syntax because:
    //   1. It renders invisibly via blockCommentView's display:none.
    //   2. It's Obsidian-native (better than HTML `<!-- -->` for an
    //      Obsidian plugin's source).
    //   3. Our parser produces a `block_comment` PM node for it,
    //      which is a non-list block - exactly what CommonMark
    //      requires to terminate a list.
    // Round-trip is clean: editor shows two lists with an invisible
    // separator between them; source has the comment; reparse
    // reconstructs the same shape.
    if (this.closed && (this.closed as { type: unknown }).type === node.type) {
      this.flushClose(2);
      // Emit a self-documenting list-break separator: `%%list-break%%`
      // followed by a blank line before the next list. The parser
      // recognizes this exact sentinel as an empty `block_comment`
      // (display:none NodeView), so it's invisible in the editor but
      // explains itself when someone reads the raw markdown source.
      // Each line gets the current delim so the marker renders
      // correctly inside blockquotes / callouts.
      this.appendOutput(this.delim + "%%list-break%%\n");
      this.appendOutput(this.delim + "\n");
    }

    // Spacing rule for the FIRST item depends on context:
    //   - Nested in a `list_item` (the "- item\n  - sub" case) - the
    //     list's `tight` attr decides whether to emit a blank line
    //     between the parent's content and this nested list. Tight
    //     gives `\n` only; loose gives a blank line. Matches what
    //     Obsidian's source view shows.
    //   - At the top level (or any non-list-item parent: doc,
    //     blockquote, callout body), the previous block is unrelated
    //     to this list and should ALWAYS get standard block spacing
    //     (a blank line). Otherwise a tight list squishes against
    //     whatever came before it - paragraph, heading, separator
    //     comment, blockquote, etc.
    //
    // For SUBSEQUENT items (i > 0), the list's tight attr always
    // applies - that's inter-item spacing within this list, which is
    // exactly what tight/loose is meant to control.
    const nestedInListItem = parent?.type.name === "list_item";
    const listTight = Boolean((node.attrs as { tight?: unknown }).tight);
    node.forEach((child, _, i) => {
      if (this.closed) {
        const isFirst = i === 0;
        const useTight = isFirst
          ? nestedInListItem && listTight
          : listTight;
        this.flushClose(useTight ? 1 : 2);
      }
      const old = this.delim;
      this.write(getMarker(i));
      this.delim += indent;
      // Dispatch to list_item handler - correctly emits task markers
      this.renderNode(child, node, i);
      this.delim = old;
    });
  }
}

// ── list_item helpers ──

/**
 * Compute the indent prefix for a flat list_item - sum of the marker
 * widths of all ancestor items. For an item at depth=2 nested under
 * "1. foo" → "1. nested-parent" → "    - me", the indent is the
 * marker width of "1. " (3) PLUS the marker width of "1. " again (3)
 * = 6 spaces.
 *
 * Walks back through siblings to find the closest ancestor at each
 * shallower depth. Skips items at greater depth (they're cousins,
 * not ancestors).
 */
function computeDepthIndent(
  _node: PMNode,
  parent: PMNode | undefined,
  index: number | undefined,
  _bulletChar: string,
): string {
  if (!parent || index === undefined) return "";
  const entry = flatListLayoutFor(parent)[index];
  if (!entry || entry.effectiveDepth === 0) return "";

  // Use exact columns, not tabs. CommonMark expands a tab relative to the
  // current source column; inside blockquote/callout prefixes that column is
  // no longer zero, so a tab that nests correctly at the document root can
  // reparse as a depth-0 sibling under `> `. Spaces are context-independent
  // and preserve the flat model's computed ancestry everywhere.
  return " ".repeat(entry.requiredColumns);
}

function indentVisualWidth(indent: string): number {
  let col = 0;
  for (const ch of indent) {
    if (ch === "\t") col += 4 - (col % 4);
    else col++;
  }
  return col;
}

interface ListPrefixMetrics {
  indentColumns: number;
  markerColumns: number;
  bulletMarker: "-" | "+" | "*" | null;
  orderedNumber: number | null;
  orderedDelimiter: "." | ")" | null;
}

/** Read only the structural prefix of an authored list-item slice. */
function sourceListPrefixMetrics(source: string): ListPrefixMetrics | null {
  const match = /^([ \t]*)(?:([-+*])([ \t]+)|(\d{1,9}[.)])([ \t]+))/.exec(
    source,
  );
  if (!match) return null;
  const marker = match[2] ?? match[4];
  const padding = match[3] ?? match[5];
  const indentColumns = indentVisualWidth(match[1]);
  const markerEndColumns = indentVisualWidth(match[1] + marker);
  const prefixEndColumns = indentVisualWidth(match[1] + marker + padding);
  const authoredPaddingColumns = prefixEndColumns - markerEndColumns;
  // CommonMark treats one-to-four post-marker columns as structural list
  // padding. With more than four, only one column belongs to the marker and
  // the remainder starts the item's content (most notably an indented-code
  // first block). Do not project those content columns onto descendants.
  const structuralPaddingColumns = authoredPaddingColumns <= 4
    ? authoredPaddingColumns
    : 1;
  return {
    indentColumns,
    markerColumns:
      markerEndColumns - indentColumns + structuralPaddingColumns,
    bulletMarker:
      match[2] === "-" || match[2] === "+" || match[2] === "*"
        ? match[2]
        : null,
    orderedNumber: match[4]
      ? Number.parseInt(match[4].slice(0, -1), 10)
      : null,
    orderedDelimiter: match[4]
      ? match[4].endsWith(")") ? ")" : "."
      : null,
  };
}

/**
 * Width (in characters) of just the bullet/number marker for an
 * item, NOT including any task brackets. Used to compute the indent
 * for nested children - child indent only needs to clear the bullet
 * or number prefix, since CommonMark treats task brackets as content.
 *   - bullet: `- ` → 2
 *   - task:   `- ` (the bullet part of `- [ ] `) → 2
 *   - ordered: depends on rendered number - `1. ` → 3, `10. ` → 4
 */
function bareMarkerWidth(
  node: PMNode,
  parent: PMNode | undefined,
  index: number | undefined,
): number {
  const kind = node.attrs.kind as "bullet" | "ordered" | "task";
  if (kind === "bullet" || kind === "task") return 2;
  if (parent && index !== undefined) {
    const entry = flatListLayoutFor(parent)[index];
    if (entry) return entry.markerWidth;
  }
  const number = orderedListStart(node.attrs.start);
  return `${number}. `.length;
}

/**
 * Compute the markdown marker for a flat list_item (`- `, `1. `,
 * `- [ ] `, etc.). For ordered items, walks back through siblings
 * (skipping deeper-nested ones) to determine our 1-based position
 * in the contiguous run, anchored at the run's first item's `start`
 * attr (default 1).
 */
function computeListMarker(
  node: PMNode,
  parent: PMNode | undefined,
  index: number | undefined,
  bulletChar: string = "-",
): string {
  const kind = node.attrs.kind as "bullet" | "ordered" | "task";
  if (kind === "task") {
    // Task uses canonical `-` (per GFM convention) regardless of the
    // bullet-character canonical option. Mixed bullets + tasks should
    // not have task items rendering as `* [x]` if the user picked `*`
    // for plain bullets - GFM task syntax is anchored to `-`.
    return node.attrs.checked ? "- [x] " : "- [ ] ";
  }
  if (kind === "bullet") {
    return `${bulletChar} `;
  }
  if (parent && index !== undefined) {
    const entry = flatListLayoutFor(parent)[index];
    const markerNumber = entry?.markerNumber;
    if (markerNumber !== null && markerNumber !== undefined) {
      return `${markerNumber}${entry?.orderedDelimiter ?? "."} `;
    }
  }
  const start = orderedListStart(node.attrs.start);
  return `${start}. `;
}

function isEmptyListItem(node: PMNode): boolean {
  return node.type.name === "list_item" &&
    node.childCount === 1 &&
    node.firstChild?.type.name === "paragraph" &&
    node.firstChild.childCount === 0;
}

function listItemUsesTightLeadingEdge(
  parent: PMNode | undefined,
  index: number | undefined,
  entry: FlatListLayoutEntry | null,
): boolean {
  const looseDirectOwner = Boolean(
    entry &&
    parent &&
    index !== undefined &&
    entry.parentIndex !== null &&
    entry.parentIndex === index - 1 &&
    parent.child(entry.parentIndex).attrs.tight === false &&
    listItemCanRepresentLooseNestedEdge(parent.child(entry.parentIndex)),
  );
  return Boolean(
    entry &&
    entry.tightBefore === true &&
    parent &&
    index !== undefined &&
    !looseDirectOwner &&
    !listItemRequiresLooseParentEdge(parent, index, entry),
  );
}

// ── Node serializer table ──

export const nodeSer: Record<string, NodeSer> = {
  // Standard blocks
  paragraph(state, node, parent, index) {
    // The flat-list schema requires a leading paragraph even when authored
    // Markdown starts the item with another block (for example `- > quote`
    // or a reference definition). The parser supplies that empty paragraph
    // only to satisfy `paragraph block*`; it has no independent Markdown
    // representation. Keep the list marker open so the following block is
    // emitted as the item's first real content instead of being detached.
    if (
      node.childCount === 0 &&
      parent &&
      index === 0 &&
      listItemHasSyntheticLeadingParagraph(parent)
    ) {
      return;
    }
    // Block-IDs (`^abc123`) are paragraph-level metadata in Obsidian
    // syntax: they ONLY parse at end-of-block. The PM schema models
    // them as inline atoms inside the paragraph, so a paragraph
    // merge / inline edit could leave a `block_id` node in the
    // middle. If we just `renderInline` it would emit `text^idmore_
    // text` and reparse as text — drift, save guard fires. Hoist
    // any block_id children to the END of the paragraph before
    // rendering so they always land in the parseable position. If
    // there are multiple block_ids, keep them all (each emits in
    // order) — at worst, only the last is actually used by Obsidian
    // but all the bytes survive round-trip.
    let hasMidBlockId = false;
    const inlineChildren: PMNode[] = [];
    const tailBlockIds: PMNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type.name === "block_id") {
        if (i < node.childCount - 1) hasMidBlockId = true;
        tailBlockIds.push(c);
      } else {
        inlineChildren.push(c);
      }
    }
    if (hasMidBlockId && tailBlockIds.length > 0) {
      const reordered = node.copy(
        Fragment.fromArray([...inlineChildren, ...tailBlockIds]),
      );
      state.renderInline(reordered);
    } else {
      state.renderInline(node);
    }
    state.closeBlock(node);
  },
  heading(state, node) {
    // Setext headings (`text\n---` / `text\n===`) parse to a heading
    // node whose inline content carries a softbreak - i.e. multi-line
    // text. ATX-style serialization (`## ` + inline) would emit the
    // newline verbatim, and re-parse splits the second line into a
    // paragraph. Collapse internal soft/hard breaks to spaces so the
    // heading always lands on a single line, regardless of whether
    // markdown-it produced it from setext or ATX form. Also clamp
    // level into 1..6 so a malformed `level: 0 / NaN` (which would
    // emit zero `#` chars and re-parse as a paragraph) still produces
    // a valid `#`-prefixed heading.
    const level = Math.max(
      1,
      Math.min(6, Math.floor(Number(node.attrs.level) || 1)),
    );
    state.write("#".repeat(level) + " ");
    // Capture the inline render output so we can scrub line breaks
    // before flushing it into the main state buffer. `.out` is the
    // internal accumulator on SerializerState — not in PM's public
    // d.ts but stable in practice.
    const beforeOutput = state.snapshotOutput();
    const before = state.out.length;
    state.renderInline(node);
    const inline = state.out.slice(before);
    const collapsed = inline.replace(/[ \t]*\n[ \t]*/g, " ");
    // A trailing hash run followed only by whitespace is ATX closing syntax.
    // Escape literal hashes, then encode trailing whitespace because Markdown
    // parsers otherwise trim it from the heading's inline text.
    const safeInline = collapsed
      .replace(/^[ \t]+/, (prefix) =>
        prefix.replace(/ /g, "&#32;").replace(/\t/g, "&#9;"),
      )
      .replace(
        /(^|[ \t])(#+)([ \t]*)$/,
        (_match, prefix: string, hashes: string, suffix: string) =>
          prefix + hashes.replace(/#/g, "\\#") + suffix,
      )
      .replace(/[ \t]+$/, (suffix) =>
        suffix.replace(/ /g, "&#32;").replace(/\t/g, "&#9;"),
      );
    if (safeInline !== inline) {
      state.restoreOutput(beforeOutput);
      state.write(safeInline);
    }
    state.closeBlock(node);
  },
  blockquote(state, node) {
    state.wrapBlock("> ", null, node, () => state.renderContent(node));
  },
  // ── Flat list_item serializer ──
  //
  // Each list_item is a top-level block (no `bullet_list` /
  // `ordered_list` containers). We emit standard markdown - `- `,
  // `1. `, `- [ ] ` - with `depth * 2` spaces of indent, so the
  // output reparses through markdown-it's normal nested ul/ol/li
  // tokens and back through OUR parser into the same flat
  // list_item sequence.
  //
  // Inter-item spacing:
  //   • Continuation (previous sibling is a list_item at same kind +
  //     depth, possibly with deeper-nested items in between): use cumulative
  //     run tightness - tight = single \n, loose = blank line. A marker-only
  //     item's own tight projection cannot erase an earlier loose edge.
  //   • Nested under (previous sibling is a list_item at SHALLOWER
  //     depth): same tight/loose rule based on this item's tight.
  //   • Otherwise (different kind at same depth, after non-list block,
  //     or first block of doc): standard 2-newline block separator.
  //
  // The walk-back skips DEEPER siblings (those are children of an
  // earlier shallower item) so a list like `- foo\n  - nested\n- bar`
  // correctly identifies "bar" as a continuation of "foo" despite the
  // intervening "nested" sibling at depth 1.
  list_item(state, node, parent, index) {
    const layoutEntry = parent && index !== undefined
      ? flatListLayoutFor(parent)[index]
      : null;
    if (state.closed) {
      // The ordinary leading-edge calculation already separates an empty
      // marker from preceding callout prose, while the callout writer handles
      // an empty first body item. Do not force a blank line for an empty item
      // that continues a tight list: that would loosen the preceding item on
      // reparse and make an ordinary Enter fail exact-save preflight.
      state.flushClose(
        listItemUsesTightLeadingEdge(parent, index, layoutEntry) ? 1 : 2,
      );
    }

    // Sum marker widths of ancestor items so the indent matches what
    // CommonMark requires for nesting (≥ parent marker width). For a
    // bullet/task parent that's 2 chars (`- ` / `* `); for an ordered
    // parent it depends on its rendered number ("1. " → 3, "10. " →
    // 4, etc.). Without this an item nested under "1. foo" would
    // serialize with 2-space indent, which markdown-it reads as a
    // sibling at depth 0, not a nested child - breaking round-trip.
    const override = state.topLevelListOverride?.node === node
      ? state.topLevelListOverride
      : null;
    const depthIndent = override?.depthIndent ?? computeDepthIndent(
      node,
      parent,
      index,
      state.canonicalForm.bullet,
    );
    const marker = override?.marker ??
      computeListMarker(node, parent, index, state.canonicalForm.bullet);
    state.write(depthIndent + marker);

    // Continuation indent = depth indent + BARE marker width (just
    // the bullet/number prefix, not the task brackets). markdown-it
    // accepts task-item continuation at the bullet-marker column
    // the `[ ]` brackets are consumed as content. If we used the
    // full task marker width (6 chars for `- [ ] `), continuation
    // lines would land at column 6+ which markdown-it reads as a
    // 4+ space-indented code block, corrupting any callout / nested
    // markdown content inside the task.
    const contIndent = override?.continuationColumns ??
      (indentVisualWidth(depthIndent) + bareMarkerWidth(node, parent, index));
    const old = state.delim;
    state.delim += " ".repeat(contIndent);
    state.renderContent(node);
    state.delim = old;
    state.closeBlock(node);
  },
  code_block(state, node) {
    // Fence info strings are not inline HTML and markdown-it does not decode
    // entities in them. Emit the language literally; protecting `&copy;`
    // would change the stored language to `&amp;copy;` on reparse.
    const lang = (node.attrs.language as string | undefined) ?? "";
    const fence = safeCodeFence(
      node.textContent,
      lang,
      state.canonicalForm.codeFence,
    );
    const infoSeparator = lang.startsWith(fence[0]) ? " " : "";
    state.write(fence + infoSeparator + lang);
    state.write("\n");
    state.text(node.textContent, false);
    state.write("\n");
    state.write(fence);
    state.closeBlock(node);
  },
  horizontal_rule(state, node) {
    state.write(state.canonicalForm.horizontalRule);
    state.closeBlock(node);
  },
  hard_break(state, node, parent, index) {
    if (index != null && index > 0) state.encodeTrailingBreakWhitespace();
    const previous = parent && index != null && index > 0
      ? parent.child(index - 1)
      : null;
    const next = parent && index != null && index + 1 < parent.childCount
      ? parent.child(index + 1)
      : null;
    const isBreak = (candidate: PMNode | null): boolean =>
      candidate?.type.name === "softbreak" ||
      candidate?.type.name === "hard_break";
    const nativeInterior = parent?.type.name !== "heading" &&
      previous !== null &&
      next !== null &&
      !isBreak(previous) &&
      !isBreak(next);
    // CommonMark explicitly rejects backslash/two-space hard breaks at a
    // block edge. Standard inline HTML is the portable exact spelling there,
    // and is deterministic for consecutive breaks and headings too.
    state.write(nativeInterior ? "\\\n" : "<br>");
  },
  softbreak(state, _node, parent, index) {
    if (index != null && index > 0) state.encodeTrailingBreakWhitespace();
    const previous = parent && index != null && index > 0
      ? parent.child(index - 1)
      : null;
    const next = parent && index != null && index + 1 < parent.childCount
      ? parent.child(index + 1)
      : null;
    const isBreak = (node: PMNode | null): boolean =>
      node?.type.name === "softbreak" || node?.type.name === "hard_break";
    // A single interior source newline is exact and keeps ordinary Markdown
    // readable. At textblock edges, in headings, or in consecutive runs,
    // CommonMark trims/splits it, so use portable `<br />` for those cases.
    state.write(
      parent?.type.name !== "heading" &&
        previous && next && !isBreak(previous) && !isBreak(next)
        ? "\n"
        : "<br />",
    );
  },
  image(state, node) {
    const attrs = node.attrs as {
      src?: string;
      title?: string;
      alt?: string;
      width?: number | null;
      height?: number | null;
      displayMode?: string | null;
    };
    const src = markdownDestination(attrs.src ?? "");
    const title = attrs.title ? markdownTitle(attrs.title) : attrs.title;
    const width = attrs.width;
    const height = attrs.height;
    const displayMode = attrs.displayMode;
    const rawAlt = attrs.alt ?? "";
    let alt = esc(rawAlt);
    if (displayMode === "full") {
      // Full-column-width sentinel - overrides any pixel size.
      alt = alt ? `${alt}|full` : "|full";
    } else if (width) {
      const sz = height ? `|${width}x${height}` : `|${width}`;
      alt = alt ? `${alt}${sz}` : sz;
    } else if (/\|(?:full|\d+(?:x\d+)?)$/i.test(rawAlt)) {
      // A semantic alt may happen to look like Butter's display/size suffix.
      // Escape its final separator using standard Markdown label syntax so
      // generic renderers see the intended alt rather than a private doubled
      // pipe convention. The parser inspects the raw label before deciding
      // whether the suffix is Butter metadata.
      const split = alt.lastIndexOf("|");
      alt = `${alt.slice(0, split)}\\|${alt.slice(split + 1)}`;
    }
    state.write(`![${alt}](${src}${title ? ` "${title}"` : ""})`);
  },
  text(state, node) { state.text(node.text!); },

  // Tables
  table(state, node) {
    // LP-style aligned table output. Every column is padded to the
    // width of its widest cell (or the alignment marker's minimum
    // width, whichever is greater). Source on disk reads cleanly:
    //
    //   | Header 1 | Header 2 | Header 3 |
    //   | -------- | :------: | -------: |
    //   | short    | center   |    right |
    //   | longer   | b        |        c |
    //
    // Two-phase: pre-render every cell to a string (rewinding
    // `state.out` after each capture so we can pad before writing
    // the final bytes), compute per-column widths, then write
    // padded rows + a width-matched separator row.
    //
    // Cell content escaping (pipes → `\|`, soft/hard breaks → `<br>`)
    // happens during the capture phase so widths reflect what
    // actually lands in source, not the pre-escaped form.
    //
    // Capture pattern: temporarily swap `state.out` to a single-char
    // sentinel and clear `state.delim` / `state.closed` so renderInline
    // doesn't fire flushClose padding or prepend block delimiters
    // (e.g. the `> ` from a callout-wrapped table) into our captured
    // cell content. Restore after capture so the actual table writes
    // emit prefixes correctly.
    const renderCellToString = (c: PMNode): string => {
      const savedOutput = state.snapshotOutput();
      const stateAny = state as unknown as { delim: string; closed: boolean };
      const savedDelim = stateAny.delim;
      const savedClosed = stateAny.closed;
      state.resetOutput("x"); // anchor - atBlankLine() returns false
      stateAny.delim = "";
      stateAny.closed = false;
      state.renderInline(c);
      const captured = state.out.slice(1)
        .replace(/\\\n/g, "<br>")
        .replace(/\n/g, "<br />")
        .replace(/\|/g, "\\|");
      state.restoreOutput(savedOutput);
      stateAny.delim = savedDelim;
      stateAny.closed = savedClosed;
      return captured;
    };

    // Phase 1: render every cell to a string, collect alignment.
    const hdr = node.child(0);
    const aligns: (string | null)[] = [];
    for (let i = 0; i < hdr.childCount; i++) {
      const a = (hdr.child(i).attrs as { alignment?: unknown }).alignment;
      aligns.push(typeof a === "string" ? a : null);
    }
    const colCount = hdr.childCount;
    const renderedRows: string[][] = [];
    for (let r = 0; r < node.childCount; r++) {
      const row = node.child(r);
      const cells: string[] = [];
      for (let c = 0; c < row.childCount; c++) {
        cells.push(renderCellToString(row.child(c)));
      }
      // Pad sparse rows (rare - should match colCount in well-formed
      // tables, but tolerate just in case).
      while (cells.length < colCount) cells.push("");
      renderedRows.push(cells);
    }

    // Phase 2: compute per-column widths.
    // Minimum alignment-marker widths:
    //   none:   `---`     → 3
    //   left:   `:---`    → 4
    //   right:  `---:`    → 4
    //   center: `:---:`   → 5
    const minMarkerWidth = (a: string | null): number =>
      a === "center" ? 5 : (a === "left" || a === "right") ? 4 : 3;
    const widths: number[] = [];
    for (let c = 0; c < colCount; c++) {
      let w = minMarkerWidth(aligns[c]);
      for (const row of renderedRows) {
        const cellLen = (row[c] ?? "").length;
        if (cellLen > w) w = cellLen;
      }
      widths.push(w);
    }

    // Helper: build the alignment marker padded to `width`.
    const buildMarker = (a: string | null, width: number): string => {
      // Each branch carries its colons in the right slots and fills
      // the rest with dashes, ensuring total length === width.
      if (a === "left") return ":" + "-".repeat(Math.max(3, width - 1));
      if (a === "right") return "-".repeat(Math.max(3, width - 1)) + ":";
      if (a === "center")
        return ":" + "-".repeat(Math.max(3, width - 2)) + ":";
      return "-".repeat(Math.max(3, width));
    };

    // Phase 3: write padded rows. Cells are left-justified in source
    // (text + spaces). Visual alignment in the rendered table comes
    // from the separator row's colons; source-side padding is just
    // for source-on-disk readability.
    const writeRow = (cells: string[]) => {
      state.write("|");
      for (let c = 0; c < colCount; c++) {
        const text = cells[c] ?? "";
        const pad = " ".repeat(Math.max(0, widths[c] - text.length));
        state.write(" " + text + pad + " |");
      }
      state.write("\n");
    };
    writeRow(renderedRows[0] ?? []);
    // Separator row.
    state.write("|");
    for (let c = 0; c < colCount; c++) {
      state.write(" " + buildMarker(aligns[c], widths[c]) + " |");
    }
    state.write("\n");
    // Body rows.
    for (let r = 1; r < node.childCount; r++) {
      writeRow(renderedRows[r] ?? []);
    }
    state.write("\n");
  },
  table_row() {},
  table_header() {},
  table_cell() {},

  /** Raw passthrough - emit the stored bytes verbatim. Source
   *  preservation holds even when Butter doesn't understand the
   *  content; bytes go in, bytes come out. */
  raw_block(state, node) {
    // Write without any escaping - the raw attr IS the source.
    state.text((node.attrs.raw as string | undefined) ?? "", false);
    state.closeBlock(node);
  },

  // Obsidian blocks
  obsidian_callout(state, node) {
    const a = node.attrs as { calloutType?: string; foldState?: string; title?: string };
    const type = a.calloutType || "note";
    const fold = a.foldState ?? "";
    const tp = a.title ? ` ${a.title}` : "";
    state.wrapBlock("> ", null, node, () => {
      state.write(`[!${type}]${fold}${tp}\n`);
      // Insert a blank line separator if the first body block could
      // be interpreted by markdown-it as setext-heading underline of
      // the `[!type]` opener line. `---` and `===` are the two
      // setext-h underline markers; an HR (`---`) as the first child
      // would otherwise re-parse as a level-2 heading "[!type]"
      // INSIDE the callout (the callout itself still parses, but
      // its first body block is the heading instead of the HR).
      // Writing an explicit blank line breaks the setext attachment
      // - `---` after a blank line is unambiguously a HR.
      const first = node.firstChild;
      if (
        first &&
        (first.type.name === "horizontal_rule" ||
          first.type.name === "reference_definition" ||
          isEmptyListItem(first))
      ) {
        state.write("\n");
      }
      state.renderContent(node);
    });
  },
  obsidian_embed(state, node) {
    state.write(`![[${(node.attrs.src as string | undefined) ?? ""}]]`);
    state.closeBlock(node);
  },
  obsidian_embed_inline(state, node) {
    state.write(`![[${(node.attrs.src as string | undefined) ?? ""}]]`);
  },
  math_block(state, node) {
    state.write("$$");
    state.write("\n");
    state.text((node.attrs.value as string | undefined) ?? "", false);
    state.write("\n");
    state.write("$$");
    state.closeBlock(node);
  },
  block_comment(state, node, parent, index) {
    const value = ((node.attrs.value as string | undefined) ?? "");
    const isEmpty = value.length === 0;
    const isListBreak = value === "list-break";

    // Stale-separator cleanup. Both empty (`%% %%`) and list-break
    // (`%%list-break%%`) comments only serve a purpose between two
    // adjacent same-type lists (where they prevent CommonMark from
    // merging the lists on reparse). If the surrounding context
    // isn't that, the comment is leftover noise - most commonly
    // from a previous save where adjacent lists got dragged apart,
    // leaving the separator stranded. Skip emitting it; the auto-
    // injection in renderList will regenerate one if needed on the
    // next save where adjacency returns.
    //
    // Non-empty comments OTHER than the `list-break` sentinel
    // (user-authored notes inside `%%...%%`) are never dropped
    // only the exact-shape separator forms.
    if ((isEmpty || isListBreak) && parent != null && index != null) {
      const prev = index > 0 ? parent.child(index - 1) : null;
      const next =
        index < parent.childCount - 1 ? parent.child(index + 1) : null;
      // Flat-list model: two list_items at same kind+depth that the
      // user wants visually separated (not a continuation) need this
      // sentinel between them. Without it the markdown reparser would
      // merge them into one list.
      const isSeparator =
        prev != null &&
        next != null &&
        prev.type.name === "list_item" &&
        next.type.name === "list_item" &&
        prev.attrs.kind === next.attrs.kind &&
        prev.attrs.depth === next.attrs.depth;
      if (!isSeparator) return; // drop stale separator
    }

    // Single-line forms for the two recognized separator shapes.
    // Empty stays as `%% %%` (back-compat with anything saved before
    // the labeled form shipped); list-break emits as the descriptive
    // `%%list-break%%`. Both round-trip via the parser's single-line
    // sentinel detection. Other content emits the traditional
    // multi-line `%%\n<value>\n%%` form so user-authored notes keep
    // their layout.
    if (isEmpty) {
      state.write("%% %%");
      state.closeBlock(node);
      return;
    }
    if (isListBreak) {
      state.write("%%list-break%%");
      state.closeBlock(node);
      return;
    }
    state.write("%%");
    state.write("\n");
    state.text(value, false);
    state.write("\n");
    state.write("%%");
    state.closeBlock(node);
  },

  // Footnotes
  footnote_ref(state, node) {
    const label = (node.attrs.label as string | undefined) ?? "";
    state.write(`[^${label}]`);
  },
  footnote_def(state, node) {
    const label = (node.attrs.label as string | undefined) ?? "";
    const content = (node.attrs.content as string | undefined) ?? "";
    const lines = content.split("\n");
    state.write(`[^${label}]: ${lines[0]}`);
    for (let i = 1; i < lines.length; i++) state.write(`\n    ${lines[i]}`);
    state.closeBlock(node);
  },
  reference_definition(state, node) {
    const raw = (node.attrs.raw as string | undefined) ?? "";
    state.text(raw, false);
    state.closeBlock(node);
  },

  // Obsidian inline
  wikilink(state, node) {
    const a = node.attrs as { target?: string; alias?: string };
    const target = a.target ?? "";
    const alias = a.alias ?? "";
    state.write(alias ? `[[${target}|${alias}]]` : `[[${target}]]`);
  },
  obsidian_tag(state, node) {
    // The tag plugin requires `#` to be at start-of-text or after
    // whitespace. The reliable check is the actual emitted buffer's
    // last char — PM-sibling checks miss inline-mark boundaries
    // (e.g. `</strong>#tag` from an overlap-mark serialization),
    // where the previous PM sibling is plain text but the emitted
    // bytes have closing HTML tags between text and `#`.
    //
    // BUT: if a block close is PENDING (state.closed = true) or the
    // buffer is already at a blank line, the tag will start on a
    // fresh line after flushClose — no separator needed. Otherwise
    // the buffer's stale last char (from the previous block's text)
    // would falsely trigger separator injection at paragraph start
    // (`intro\n\n#tag` became `intro\n\n #tag` — leading space drift).
    const stateAny = state as unknown as { closed: unknown };
    if (!stateAny.closed && !state.atBlank()) {
      const last = state.lastOutputCharacter();
      if (last && !/\s/.test(last)) state.write(" ");
    }
    state.write(`#${(node.attrs.tag as string | undefined) ?? ""}`);
  },
  inline_math(state, node) {
    state.write(`$${(node.attrs.value as string | undefined) ?? ""}$`);
    state.inlineMathClosePending = true;
  },
  inline_footnote(state, node) {
    state.write(`^[${(node.attrs.content as string | undefined) ?? ""}]`);
  },
  block_id(state, node) {
    state.write(`^${(node.attrs.id as string | undefined) ?? ""}`);
  },
};
// ── Public serialize ──

export function serialize(doc: PMNode, options?: CanonicalFormOptions): string {
  const state = new SerState(options);
  state.renderContent(doc);
  return state.out;
}

/**
 * Serialize a single top-level block to markdown in isolation.
 * Used by the source-preserving serializer below for nodes whose
 * sourceRange is null (inserted, edited, or otherwise synthesized
 * without an original byte range to emit).
 *
 * When `context` is provided, inline atoms inside the block that
 * are still reference-identical to their parse-time originals emit
 * their original source bytes verbatim (byte-level preservation
 * within an edited block). When context is null, normal canonical
 * synthesis happens.
 */
function serializeBlock(
  block: PMNode,
  context?: {
    originalBody: string;
    originalInlineAtoms: Set<PMNode>;
  },
  options?: CanonicalFormOptions,
  listOverride?: {
    depthIndent: string;
    marker: string;
    continuationColumns: number;
  },
): string {
  const wrap = schema.nodes.doc.create(null, Fragment.from(block));
  const state = new SerState(options);
  if (context) {
    state.sourcePresBody = context.originalBody;
    state.sourcePresOriginalAtoms = context.originalInlineAtoms;
  }
  if (listOverride) {
    state.topLevelListOverride = { node: block, ...listOverride };
  }
  state.renderContent(wrap);
  return state.out;
}

/** Collect every inline atom in `doc` into a reference-identity set.
 *  Used as the "original inline atoms" set at save time so reference
 *  checks can tell whether an atom in the current doc has survived
 *  untouched from the parse-time tree. */
function collectInlineAtoms(doc: PMNode): Set<PMNode> {
  const set = new Set<PMNode>();
  doc.descendants((node) => {
    if (node.isInline && node.isAtom) set.add(node);
  });
  return set;
}

function collectReferenceDefinitions(doc: PMNode): PMNode[] {
  const definitions: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === "reference_definition") {
      definitions.push(node);
    }
  });
  return definitions;
}

/**
 * Source-preserving serialize.
 *
 * Walks the current doc's top-level children. For each child:
 *   • Node is reference-identical to one of the originalDoc's children
 *     AND has a valid sourceRange → emit `originalBody.slice(start, end)`
 *     verbatim. Zero bytes mutated, zero escaping decisions re-made,
 *     zero formatting preferences re-applied.
 *   • Otherwise → serialize through the normal block serializer,
 *     cushioned by `\n\n` separators so it doesn't glue onto
 *     neighbors.
 *
 * Why reference identity? ProseMirror's immutable-tree model means
 * a node's JS reference survives if-and-only-if no step has mutated
 * it. Structural sharing: an edit in one paragraph produces a new
 * doc whose other paragraphs are the SAME objects as before. So
 * `originals.has(child)` is a precise "this node has not been
 * mutated since parse" check. Cheaper than content hashing and
 * correct against every PM step type including splits/merges (which
 * always produce new node objects).
 *
 * Drag-reordered blocks retain reference identity - the same node
 * object lands at a new index. We emit its original bytes in the
 * new position. That's preservation-through-drag by construction.
 *
 * Inserted / edited / split / pasted blocks are NEW references →
 * synthesized fresh, surrounded by original bytes of the survivors.
 *
 * This is the mechanism that makes the invariant true: bytes the
 * user didn't touch stay byte-identical on save.
 */
export function serializeWithSourcePreservation(
  doc: PMNode,
  originalBody: string,
  originalDoc: PMNode,
  options?: CanonicalFormOptions,
): string {
  // A semantic no-op (including undo back to the loaded document) must be a
  // byte no-op. This also covers unusual valid source whose parser creates
  // zero-length carrier nodes that cannot be reconstructed block-by-block.
  if (doc.eq(originalDoc)) return originalBody;

  // ── Identity map: parse-time block → its index in originalDoc ──
  // Reference identity is the STRICT "this block wasn't edited" check
  // (PM's immutable-tree model means an edit produces a new object).
  // Byte identity (same sourceRange.start) is the LENIENT "this was
  // originally THIS block, even if edited" check - PM preserves attrs
  // through ReplaceStep, so a content-only edit keeps sourceRange on
  // the new node. Byte identity lets us look up the ORIGINAL gap
  // between two blocks even when one has been edited in place.
  const originalBlocks: PMNode[] = [];
  originalDoc.forEach((child) => originalBlocks.push(child));
  const originalRefs = new Set<PMNode>(originalBlocks);
  const origIndexByStart = new Map<number, number>();
  for (let i = 0; i < originalBlocks.length; i++) {
    const r = originalBlocks[i].attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (r && typeof r.start === "number" && r.start >= 0) {
      origIndexByStart.set(r.start, i);
    }
  }

  // Reference-identity set of EVERY inline atom that existed in the
  // parse-time doc. When a block is edited (its reference changed)
  // but some of its inline atoms survived untouched, those atoms
  // still have their original byte ranges and can be spliced in
  // verbatim during block synthesis. This is the mechanism for
  // byte-level preservation WITHIN an edited block.
  const originalInlineAtoms = collectInlineAtoms(originalDoc);
  const blockSynthCtx = { originalBody, originalInlineAtoms };

  // Identify each current block: its origIdx (if any) and whether
  // it's still reference-identical (unchanged).
  const n = doc.childCount;
  type BlockIdent = { origIdx: number | null; preserved: boolean };
  const ids: BlockIdent[] = [];
  for (let i = 0; i < n; i++) {
    const child = doc.child(i);
    const r = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    const origIdx =
      r && typeof r.start === "number" && origIndexByStart.has(r.start)
        ? origIndexByStart.get(r.start)!
        : null;
    ids.push({ origIdx, preserved: originalRefs.has(child) });
  }

  // A preserved list slice is safe only when its original absolute depth is
  // still expressible in the CURRENT sibling sequence. Use the same linear
  // layout plan as canonical serialization. This catches transitive orphaning:
  // after a depth-1 item is re-rooted, its raw depth-2 follower must also be
  // synthesized at effective depth 1 rather than emitted with stale bytes.
  const currentListLayout = flatListLayoutFor(doc);
  const originalListLayout = flatListLayoutFor(originalDoc);
  const originalListMetrics = originalBlocks.map((block) => {
    const range = block.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    return range && range.start >= 0 && range.end <= originalBody.length
      ? sourceListPrefixMetrics(originalBody.slice(range.start, range.end))
      : null;
  });
  const originalPreviousAtDepth = new Array<number | null>(
    originalDoc.childCount,
  ).fill(null);
  {
    const lastAtDepth: Array<number | undefined> = [];
    for (let index = 0; index < originalDoc.childCount; index++) {
      const entry = originalListLayout[index];
      if (!entry) {
        lastAtDepth.length = 0;
        continue;
      }
      originalPreviousAtDepth[index] =
        lastAtDepth[entry.effectiveDepth] ?? null;
      lastAtDepth.length = entry.effectiveDepth + 1;
      lastAtDepth[entry.effectiveDepth] = index;
    }
  }
  const hasUnstableListLayout = (i: number): boolean => {
    const child = doc.child(i);
    if (child.type.name !== "list_item") return false;
    const entry = currentListLayout[i];
    return !entry || entry.effectiveDepth !== entry.rawDepth;
  };

  // Preserve each reference-identical block unless its list depth is no longer
  // expressible in the current sibling sequence. Adjacent list items remain
  // independent source slices: splitting or editing one item must not rewrite
  // the markers or inline bytes of unaffected siblings.
  const canPreserveContent: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const child = doc.child(i);
    const range = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    const originalIndex = ids[i].origIdx;
    const sameAuthoredLeftContext = originalIndex !== null && (
      originalIndex === 0
        ? i === 0
        : i > 0 &&
          ids[i - 1].origIdx === originalIndex - 1 &&
          ids[i - 1].preserved
    );
    const authoredSource = range &&
        range.start >= 0 && range.end >= range.start &&
        range.end <= originalBody.length
      ? originalBody.slice(range.start, range.end)
      : "";
    const contextSensitiveIndentedCode =
      child.type.name === "code_block" && /^(?: {4}|\t)/.test(authoredSource);
    canPreserveContent.push(Boolean(
      ids[i].preserved &&
      !hasUnstableListLayout(i) &&
      (!contextSensitiveIndentedCode || sameAuthoredLeftContext) &&
      range &&
      typeof range.start === "number" &&
      typeof range.end === "number" &&
      range.start >= 0 &&
      range.end >= range.start &&
      range.end <= originalBody.length,
    ));
  }

  // Reference definitions populate one document-wide resolution environment.
  // Preserving an unchanged paragraph's authored `[text][label]` bytes is
  // therefore safe only while the complete definition sequence is unchanged.
  // If a definition is inserted, removed, edited, or reordered, synthesize all
  // visible blocks from their already-resolved PM semantics. This turns links
  // into self-contained inline destinations and prevents an unchanged source
  // slice from reparsing as literal bracket text or binding to a different
  // duplicate definition. The definitions themselves remain exact artifacts.
  const originalDefinitions = collectReferenceDefinitions(originalDoc);
  const currentDefinitions = collectReferenceDefinitions(doc);
  const referenceEnvironmentStable =
    originalDefinitions.length === currentDefinitions.length &&
    currentDefinitions.every(
      (definition, index) => definition === originalDefinitions[index],
    );
  if (!referenceEnvironmentStable) {
    for (let i = 0; i < n; i++) {
      if (doc.child(i).type.name !== "reference_definition") {
        canPreserveContent[i] = false;
      }
    }
  }

  // A CommonMark list is a source container even though Butter represents its
  // items as flat sibling blocks. If an edit changes a run's membership or
  // tightness, authored whitespace from any one old item/gap can change the
  // meaning of every sibling in that run. In that case synthesize the whole
  // affected run; preserving independent stale slices is not semantically
  // valid. Intact runs (including an intact run moved elsewhere) remain
  // byte-preservable.
  const membersByRun = (
    layout: ReadonlyArray<FlatListLayoutEntry | null>,
  ): Map<number, number[]> => {
    const result = new Map<number, number[]>();
    for (let index = 0; index < layout.length; index++) {
      const entry = layout[index];
      if (!entry) continue;
      const members = result.get(entry.runStartIndex) ?? [];
      members.push(index);
      result.set(entry.runStartIndex, members);
    }
    return result;
  };
  const currentMembersByRun = membersByRun(currentListLayout);
  const originalMembersByRun = membersByRun(originalListLayout);
  const listRunStable = new Array<boolean>(n).fill(false);
  for (const currentMembers of currentMembersByRun.values()) {
    const originalIndices = currentMembers.map((index) => ids[index].origIdx);
    const firstOriginalIndex = originalIndices[0];
    const firstOriginalEntry = firstOriginalIndex === null
      ? null
      : originalListLayout[firstOriginalIndex];
    const originalMembers = firstOriginalEntry
      ? originalMembersByRun.get(firstOriginalEntry.runStartIndex)
      : undefined;
    const sameMembership = Boolean(
      originalMembers &&
      originalMembers.length === originalIndices.length &&
      originalIndices.every(
        (originalIndex, index) => originalIndex === originalMembers[index],
      ),
    );
    const sameTightness = sameMembership && currentMembers.every(
      (currentIndex, index) =>
        doc.child(currentIndex).attrs.tight ===
        originalBlocks[originalIndices[index]!].attrs.tight,
    );
    for (const index of currentMembers) {
      listRunStable[index] = sameMembership && sameTightness;
    }
    if (!sameMembership || !sameTightness) {
      for (const index of currentMembers) canPreserveContent[index] = false;
    }
  }

  // A direct owner-to-first-child gap can carry looseness established later
  // in the same flat-list subtree. Prove that the complete owned subtree is
  // still the same before reusing that gap. The stack computes every subtree
  // end once; the reverse span proves consecutive provenance, relative depth,
  // parentage, and constituent run stability without rescanning descendants.
  const listSubtreeEnds = (
    layout: ReadonlyArray<FlatListLayoutEntry | null>,
  ): number[] => {
    const ends = new Array<number>(layout.length).fill(layout.length);
    const open: number[] = [];
    for (let index = 0; index < layout.length; index++) {
      const entry = layout[index];
      if (!entry) {
        while (open.length > 0) ends[open.pop()!] = index;
        continue;
      }
      while (open.length > 0) {
        const ownerIndex = open[open.length - 1];
        const ownerEntry = layout[ownerIndex]!;
        if (ownerEntry.effectiveDepth < entry.effectiveDepth) break;
        ends[open.pop()!] = index;
      }
      open.push(index);
    }
    return ends;
  };
  const currentListSubtreeEnds = listSubtreeEnds(currentListLayout);
  const originalListSubtreeEnds = listSubtreeEnds(originalListLayout);
  const listSourceShapeIsStable = (
    currentIndex: number,
    originalIndex: number,
  ): boolean => {
    const current = doc.child(currentIndex);
    const original = originalBlocks[originalIndex];
    return listKind(current) === listKind(original) &&
      current.attrs.start === original.attrs.start &&
      listItemIsMarkerOnly(current) === listItemIsMarkerOnly(original);
  };
  const stableListStructureSpan = new Array<number>(n).fill(0);
  for (let index = n - 1; index >= 0; index--) {
    const entry = currentListLayout[index];
    const originalIndex = ids[index].origIdx;
    const originalEntry = originalIndex === null
      ? null
      : originalListLayout[originalIndex];
    if (
      !entry ||
      originalIndex === null ||
      !originalEntry ||
      !listRunStable[index] ||
      !listSourceShapeIsStable(index, originalIndex)
    ) continue;
    stableListStructureSpan[index] = 1;
    const nextIndex = index + 1;
    if (nextIndex >= n || stableListStructureSpan[nextIndex] === 0) continue;
    const nextEntry = currentListLayout[nextIndex];
    const nextOriginalIndex = ids[nextIndex].origIdx;
    const nextOriginalEntry = nextOriginalIndex === null
      ? null
      : originalListLayout[nextOriginalIndex];
    if (
      !nextEntry ||
      !nextOriginalEntry ||
      nextOriginalIndex !== originalIndex + 1
    ) {
      continue;
    }
    const currentParentOriginalIndex = nextEntry.parentIndex === null
      ? null
      : ids[nextEntry.parentIndex].origIdx;
    const sameRelativeDepth =
      nextEntry.effectiveDepth - nextOriginalEntry.effectiveDepth ===
      entry.effectiveDepth - originalEntry.effectiveDepth;
    if (
      sameRelativeDepth &&
      currentParentOriginalIndex === nextOriginalEntry.parentIndex
    ) {
      stableListStructureSpan[index] += stableListStructureSpan[nextIndex];
    }
  }
  const listOwnerSubtreeStable = new Array<boolean>(n).fill(false);
  for (let index = 0; index < n; index++) {
    const originalIndex = ids[index].origIdx;
    if (originalIndex === null || !currentListLayout[index]) continue;
    const currentLength = currentListSubtreeEnds[index] - index;
    const originalLength = originalListSubtreeEnds[originalIndex] - originalIndex;
    listOwnerSubtreeStable[index] =
      currentLength === originalLength &&
      stableListStructureSpan[index] >= currentLength;
  }
  const listAncestryStable = new Array<boolean>(n).fill(false);
  for (let index = 0; index < n; index++) {
    const entry = currentListLayout[index];
    if (!entry) continue;
    listAncestryStable[index] = listOwnerSubtreeStable[index] &&
      (entry.parentIndex === null || listAncestryStable[entry.parentIndex]);
  }

  type ListOverride = {
    depthIndent: string;
    marker: string;
    continuationColumns: number;
  };
  const listOverrides = new Array<ListOverride | undefined>(n).fill(undefined);
  const emittedListMetrics = new Array<ListPrefixMetrics | null>(n).fill(null);
  const bullet = options?.bullet ?? CANONICAL_DEFAULTS.bullet;
  const orderedDelimiterAtDepth: Array<"." | ")" | undefined> = [];
  const currentPreviousAtDepth: Array<number | undefined> = [];

  // A preserved list prefix is valid only in the context that will actually
  // precede it. Measure authored prefixes and propagate the emitted parent
  // columns forward. This lets unrelated siblings stay byte-identical while
  // resynthesizing only a marker/indent whose semantic context changed.
  for (let i = 0; i < n; i++) {
    const child = doc.child(i);
    if (child.type.name !== "list_item") {
      orderedDelimiterAtDepth.length = 0;
      currentPreviousAtDepth.length = 0;
      continue;
    }
    const entry = currentListLayout[i];
    if (!entry) continue;
    const previousAtDepth = currentPreviousAtDepth[entry.effectiveDepth] ?? null;
    currentPreviousAtDepth.length = entry.effectiveDepth + 1;
    currentPreviousAtDepth[entry.effectiveDepth] = i;
    const parentMetrics = entry?.parentIndex === null || entry?.parentIndex === undefined
      ? null
      : emittedListMetrics[entry.parentIndex];
    const requiredIndent = parentMetrics
      ? parentMetrics.indentColumns + parentMetrics.markerColumns
      : 0;
    const range = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    // Edited blocks retain their parse-time sourceRange. Read their authored
    // marker too: synthesis must not mix `.` and `)` inside one ordered run.
    const sourceMetrics = range && ids[i].origIdx !== null &&
        range.start >= 0 && range.end >= range.start &&
        range.end <= originalBody.length
      ? sourceListPrefixMetrics(originalBody.slice(range.start, range.end))
      : null;
    const kind = listKind(child);
    orderedDelimiterAtDepth.length = entry.effectiveDepth + 1;
    const previousOrderedDelimiter =
      orderedDelimiterAtDepth[entry.effectiveDepth] ?? ".";
    const orderedDelimiter = kind === "ordered"
      ? entry.requiresOrderedRunBreak
        ? sourceMetrics?.orderedDelimiter &&
            sourceMetrics.orderedDelimiter !== previousOrderedDelimiter
          ? sourceMetrics.orderedDelimiter
          : previousOrderedDelimiter === "." ? ")" : "."
        : entry.continuation
          ? orderedDelimiterAtDepth[entry.effectiveDepth] ??
            sourceMetrics?.orderedDelimiter ?? "."
          : sourceMetrics?.orderedDelimiter ?? "."
      : null;
    orderedDelimiterAtDepth[entry.effectiveDepth] =
      orderedDelimiter ?? undefined;

    const originalIndex = ids[i].origIdx;
    const expectedOriginalPrevious = originalIndex === null
      ? null
      : originalPreviousAtDepth[originalIndex];
    const currentPreviousOriginal = previousAtDepth === null
      ? null
      : ids[previousAtDepth].origIdx;
    const sameAuthoredAdjacency =
      originalIndex !== null &&
      (
        previousAtDepth === null
          ? expectedOriginalPrevious === null
          : expectedOriginalPrevious !== null &&
            currentPreviousOriginal === expectedOriginalPrevious
      );
    const rootIndentContextSafe =
      entry.effectiveDepth > 0 ||
      previousAtDepth === null ||
      sourceMetrics?.indentColumns === 0 ||
      sameAuthoredAdjacency;
    const indentCompatible = sourceMetrics !== null && (
      parentMetrics
        ? sourceMetrics.indentColumns >= requiredIndent &&
          sourceMetrics.indentColumns <= requiredIndent + 3
        : sourceMetrics.indentColumns <= 3 && rootIndentContextSafe
    );
    const previousSameDepthMetrics = previousAtDepth === null
      ? null
      : emittedListMetrics[previousAtDepth];
    // Parent-relative indentation is not sufficient after an adjacent item
    // has been synthesized. A marker at or beyond the previous same-depth
    // item's content column is parsed as that item's child even when it also
    // falls inside the parent's individually-valid indentation range. Keep a
    // preserved prefix only while it starts before that child boundary;
    // otherwise synthesize it from the current layout plan as well.
    const sameDepthIndentCompatible = sourceMetrics !== null && (
      previousSameDepthMetrics === null ||
      sourceMetrics.indentColumns <
        previousSameDepthMetrics.indentColumns +
          previousSameDepthMetrics.markerColumns
    );
    const expectedRunStart = orderedListStart(child.attrs.start);
    const orderedStartCompatible =
      kind !== "ordered" ||
      entry?.continuation === true ||
      sourceMetrics?.orderedNumber === expectedRunStart;
    const orderedDelimiterCompatible =
      kind !== "ordered" ||
      sourceMetrics?.orderedDelimiter === orderedDelimiter;
    const sourcePrefixCompatible = Boolean(
      sourceMetrics &&
      indentCompatible &&
      sameDepthIndentCompatible &&
      orderedStartCompatible &&
      orderedDelimiterCompatible,
    );

    if (
      canPreserveContent[i] &&
      sourcePrefixCompatible
    ) {
      emittedListMetrics[i] = sourceMetrics!;
      continue;
    }

    canPreserveContent[i] = false;
    // Content edits should not perturb the structural column basis of a list
    // run. Reuse a still-valid authored indentation width even though the
    // item's content and marker are synthesized; fall back to the canonical
    // layout only when the authored prefix is unsafe in its current context.
    const emittedIndentColumns = sourcePrefixCompatible
      ? sourceMetrics!.indentColumns
      : requiredIndent;
    const depthIndent = " ".repeat(emittedIndentColumns);
    const authoredBulletMarker = kind !== "ordered" &&
        sourcePrefixCompatible &&
        listRunStable[i]
      ? sourceMetrics?.bulletMarker ?? null
      : null;
    const marker = kind === "ordered"
      ? `${entry.markerNumber ?? expectedRunStart}${orderedDelimiter} `
      : authoredBulletMarker
        ? kind === "task"
          ? `${authoredBulletMarker} [${child.attrs.checked ? "x" : " "}] `
          : `${authoredBulletMarker} `
        : computeListMarker(child, doc, i, bullet);
    const markerColumns = bareMarkerWidth(child, doc, i);
    listOverrides[i] = {
      depthIndent,
      marker,
      continuationColumns: emittedIndentColumns + markerColumns,
    };
    emittedListMetrics[i] = {
      indentColumns: emittedIndentColumns,
      markerColumns,
      orderedNumber:
        kind === "ordered" ? entry?.markerNumber ?? expectedRunStart : null,
      orderedDelimiter,
      bulletMarker: kind === "ordered"
        ? null
        : authoredBulletMarker ?? (kind === "task" ? "-" : bullet),
    };
  }

  // Content emission per block: either preserved original bytes (if
  // reference-identical AND has a valid sourceRange AND not an
  // orphan-nested list_item) or synthesized canonical bytes. Content
  // includes the block's own line-ending \n but NOT any inter-block
  // blank lines.
  const contents: string[] = [];
  const contentWasPreserved: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const child = doc.child(i);
    const range = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    const canPreserve = canPreserveContent[i];

    if (canPreserve && range) {
      contents.push(originalBody.slice(range.start, range.end));
      contentWasPreserved.push(true);
    } else {
      contents.push(normalizeBlockSynth(
        serializeBlock(child, blockSynthCtx, options, listOverrides[i]),
      ));
      contentWasPreserved.push(false);
    }
  }

  // Prefix/suffix bytes are document-owned trivia, not properties of the
  // current first/last block. Reference definitions are explicit nodes, so
  // these boundary slices now contain only bytes outside modeled blocks.
  let leading = "";
  if (originalBlocks.length > 0) {
    const r = originalBlocks[0].attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (r && r.start >= 0 && r.start <= originalBody.length) {
      leading = originalBody.slice(0, r.start);
    }
  }

  // Inter-block gaps: for each adjacent pair, preserve the original
  // gap ONLY if the pair was adjacent in the same order in the
  // original doc. Otherwise (reorder, insertion, deletion broke the
  // pairing) emit a default gap - a single blank line, which is the
  // CommonMark minimum for separating two paragraphs and a safe
  // no-merge separator for any block-type pair.
  //
  // Special case: the parser may assign a block's range to ABSORB
  // its trailing blank-line bytes (range.end == next block's
  // range.start ⇒ originalBody.slice between them is `""`). When
  // both endpoints are reference-preserved, the absorbed blank line
  // travels with the preserved bytes and the empty gap is correct.
  // But when EITHER block has been synthesized, the canonical
  // synthesis emits only its own trailing `\n` and does NOT carry
  // the absorbed blank-line bytes - leaving the next block lazy-
  // continuing into the previous one. Inject the default separator
  // in that specific case to keep the structural boundary intact.
  // Multi-blank-line gaps (gapBytes.length > 0) still pass through
  // unchanged, preserving the user-authored whitespace.
  const gaps: string[] = [];
  const trailingBoundaryWhitespace = (
    value: string,
  ): { lineBreaks: number; afterFirstLineBreak: string } => {
    let start = value.length;
    while (start > 0) {
      const code = value.charCodeAt(start - 1);
      if (code !== 9 && code !== 10 && code !== 13 && code !== 32) break;
      start--;
    }
    let lineBreaks = 0;
    let firstLineBreakEnd = -1;
    for (let index = start; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 13) {
        if (value.charCodeAt(index + 1) === 10) index++;
      } else if (code !== 10) {
        continue;
      }
      lineBreaks++;
      if (firstLineBreakEnd < 0) firstLineBreakEnd = index + 1;
    }
    return {
      lineBreaks,
      afterFirstLineBreak: firstLineBreakEnd < 0
        ? ""
        : value.slice(firstLineBreakEnd),
    };
  };
  const continuationLineEnding = (value: string): "\r" | "\n" => {
    let index = value.length - 1;
    while (index >= 0) {
      const code = value.charCodeAt(index);
      if (code !== 9 && code !== 32) break;
      index--;
    }
    return value.charCodeAt(index) === 13 ? "\r" : "\n";
  };
  // A source-backed list gap is reusable only while both endpoints still
  // describe the same structural relationship. This keeps authored marker
  // boundaries byte-local during text edits without letting stale whitespace
  // override an intentional kind, depth, parent, marker, or tightness change.
  const sourceBackedListAdjacencyIsUnchanged = (
    leftIndex: number,
  ): boolean => {
    const rightIndex = leftIndex + 1;
    const leftOriginalIndex = ids[leftIndex]?.origIdx ?? null;
    const rightOriginalIndex = ids[rightIndex]?.origIdx ?? null;
    if (
      leftOriginalIndex === null ||
      rightOriginalIndex !== leftOriginalIndex + 1
    ) {
      return false;
    }
    const leftEntry = currentListLayout[leftIndex];
    const rightEntry = currentListLayout[rightIndex];
    const originalLeftEntry = originalListLayout[leftOriginalIndex];
    const originalRightEntry = originalListLayout[rightOriginalIndex];
    const leftPrefix = emittedListMetrics[leftIndex];
    const rightPrefix = emittedListMetrics[rightIndex];
    const originalLeftPrefix = originalListMetrics[leftOriginalIndex];
    const originalRightPrefix = originalListMetrics[rightOriginalIndex];
    if (
      !leftEntry ||
      !rightEntry ||
      !originalLeftEntry ||
      !originalRightEntry ||
      !leftPrefix ||
      !rightPrefix ||
      !originalLeftPrefix ||
      !originalRightPrefix
    ) {
      return false;
    }
    const endpointIsUnchanged = (
      currentIndex: number,
      originalIndex: number,
      entry: FlatListLayoutEntry,
      originalEntry: FlatListLayoutEntry,
      prefix: ListPrefixMetrics,
      originalPrefix: ListPrefixMetrics,
    ): boolean => {
      const kind = listKind(doc.child(currentIndex));
      if (
        !listSourceShapeIsStable(currentIndex, originalIndex) ||
        entry.effectiveDepth !== originalEntry.effectiveDepth ||
        prefix.indentColumns !== originalPrefix.indentColumns
      ) {
        return false;
      }
      const currentParentOriginalIndex = entry.parentIndex === null
        ? null
        : ids[entry.parentIndex]?.origIdx ?? null;
      if (currentParentOriginalIndex !== originalEntry.parentIndex) {
        return false;
      }
      return kind === "ordered"
        ? prefix.orderedNumber === originalPrefix.orderedNumber &&
          prefix.orderedDelimiter === originalPrefix.orderedDelimiter
        : prefix.bulletMarker === originalPrefix.bulletMarker;
    };
    const endpointsAreStructurallyUnchanged = endpointIsUnchanged(
      leftIndex,
      leftOriginalIndex,
      leftEntry,
      originalLeftEntry,
      leftPrefix,
      originalLeftPrefix,
    ) && endpointIsUnchanged(
      rightIndex,
      rightOriginalIndex,
      rightEntry,
      originalRightEntry,
      rightPrefix,
      originalRightPrefix,
    );
    if (!endpointsAreStructurallyUnchanged) return false;
    const directOwnerEdge =
      rightEntry.parentIndex === leftIndex &&
      originalRightEntry.parentIndex === leftOriginalIndex;
    // Authored whitespace can encode tightness anywhere in one CommonMark
    // list container. Once an edit splits, removes, or reorders that run,
    // a locally unchanged edge may no longer carry the current run's meaning.
    // Require the endpoint runs to retain their original membership and
    // tightness before reusing that edge; otherwise let canonical spacing
    // relocate tightness.
    if (!listAncestryStable[leftIndex] || !listAncestryStable[rightIndex]) {
      return false;
    }
    // The owner controls its edge to the first nested child. Peer-list edges
    // are controlled by both items; distinct sibling runs may legitimately
    // normalize their per-run tightness independently of the separating gap.
    const ownerTightnessIsUnchanged =
      doc.child(leftIndex).attrs.tight ===
        originalBlocks[leftOriginalIndex].attrs.tight;
    const tightnessIsUnchanged = ownerTightnessIsUnchanged &&
      (directOwnerEdge ||
        doc.child(rightIndex).attrs.tight ===
          originalBlocks[rightOriginalIndex].attrs.tight);
    const prefixesProveDistinctRuns = (
      leftNode: PMNode,
      rightNode: PMNode,
      leftLayout: FlatListLayoutEntry,
      rightLayout: FlatListLayoutEntry,
      left: ListPrefixMetrics,
      right: ListPrefixMetrics,
    ): boolean => {
      if (
        leftLayout.effectiveDepth !== rightLayout.effectiveDepth ||
        leftLayout.parentIndex !== rightLayout.parentIndex
      ) {
        return false;
      }
      const leftOrdered = listKind(leftNode) === "ordered";
      const rightOrdered = listKind(rightNode) === "ordered";
      if (leftOrdered !== rightOrdered) return true;
      return leftOrdered
        ? left.orderedDelimiter !== right.orderedDelimiter
        : left.bulletMarker !== right.bulletMarker;
    };
    const authoredDistinctRun = prefixesProveDistinctRuns(
      originalBlocks[leftOriginalIndex],
      originalBlocks[rightOriginalIndex],
      originalLeftEntry,
      originalRightEntry,
      originalLeftPrefix,
      originalRightPrefix,
    );
    const emittedDistinctRun = prefixesProveDistinctRuns(
      doc.child(leftIndex),
      doc.child(rightIndex),
      leftEntry,
      rightEntry,
      leftPrefix,
      rightPrefix,
    );
    return tightnessIsUnchanged ||
      (authoredDistinctRun && emittedDistinctRun);
  };
  const authoredListAdjacencyGap = (
    leftIndex: number,
    candidate: string,
  ): string => {
    if (contentWasPreserved[leftIndex]) return candidate;
    const originalIndex = ids[leftIndex]?.origIdx ?? null;
    const range = originalIndex === null
      ? null
      : originalBlocks[originalIndex].attrs.sourceRange as
        | { start: number; end: number }
        | null;
    if (!range || range.start < 0 || range.end > originalBody.length) {
      return candidate;
    }
    return trailingBoundaryWhitespace(
      originalBody.slice(range.start, range.end) + candidate,
    ).afterFirstLineBreak;
  };
  const gapForChangedPair = (leftIndex: number): string => {
    const rightListLayout = currentListLayout[leftIndex + 1];
    const tightListEdge =
      doc.child(leftIndex).type.name === "list_item" &&
      doc.child(leftIndex + 1).type.name === "list_item" &&
      listItemUsesTightLeadingEdge(
        doc,
        leftIndex + 1,
        rightListLayout,
      );
    return tightListEdge ? "" : defaultGap();
  };
  const ensureStructuralGap = (
    leftIndex: number,
    candidate: string,
  ): string => {
    // Non-whitespace gaps are malformed or otherwise unmodeled source trivia.
    // Preserve them at an unchanged adjacency; changed adjacencies receive
    // the structural fallback supplied by the caller.
    if (/\S/.test(candidate)) return candidate;
    const rightListLayout = currentListLayout[leftIndex + 1];
    const tightListEdge =
      doc.child(leftIndex).type.name === "list_item" &&
      doc.child(leftIndex + 1).type.name === "list_item" &&
      listItemUsesTightLeadingEdge(
        doc,
        leftIndex + 1,
        rightListLayout,
      );
    if (tightListEdge) {
      // A source range may have absorbed the old boundary's blank line. Once
      // either endpoint or adjacency changes, this boundary owns that
      // whitespace and must be able to remove it as well as add it. Retain the
      // content line ending (and any hard-break spaces before it), but collapse
      // structural trailing blank lines to the single tight-list line break.
      contents[leftIndex] = contents[leftIndex].replace(
        /((?:\r\n|\r|\n))(?:[ \t]*(?:\r\n|\r|\n))+[ \t]*$/,
        "$1",
      );
      if (!/[\r\n]$/.test(contents[leftIndex])) {
        contents[leftIndex] += "\n";
      }
      return "";
    }
    const requiredLineBreaks = tightListEdge ? 1 : 2;
    const left = /[\r\n]$/.test(contents[leftIndex])
      ? contents[leftIndex]
      : `${contents[leftIndex]}\n`;
    const boundary = left + candidate;
    const existingLineBreaks = trailingBoundaryWhitespace(boundary).lineBreaks;
    return existingLineBreaks >= requiredLineBreaks
      ? candidate
      : candidate + continuationLineEnding(boundary).repeat(
        requiredLineBreaks - existingLineBreaks,
      );
  };
  for (let i = 0; i < n - 1; i++) {
    const a = ids[i];
    const b = ids[i + 1];
    if (
      a.origIdx !== null &&
      b.origIdx !== null &&
      b.origIdx === a.origIdx + 1
    ) {
      const aOrig = originalBlocks[a.origIdx];
      const bOrig = originalBlocks[b.origIdx];
      const aR = aOrig.attrs.sourceRange as
        | { start: number; end: number }
        | null;
      const bR = bOrig.attrs.sourceRange as
        | { start: number; end: number }
        | null;
      if (
        aR &&
        bR &&
        aR.end >= 0 &&
        bR.start >= aR.end &&
        bR.start <= originalBody.length
      ) {
        const gapBytes = originalBody.slice(aR.end, bR.start);
        const listAdjacencyIsStable =
          currentListLayout[i] !== null &&
          currentListLayout[i + 1] !== null &&
          sourceBackedListAdjacencyIsUnchanged(i);
        // Derive structural separation from the bytes actually emitted on the
        // left. Source ranges may absorb blank lines into that block, so
        // identity-based "either endpoint changed" rules double-insert gaps.
        gaps.push(
          contentWasPreserved[i] && contentWasPreserved[i + 1] &&
              (
                currentListLayout[i] === null ||
                currentListLayout[i + 1] === null ||
                listAdjacencyIsStable
              )
            ? gapBytes
            : listAdjacencyIsStable
              ? authoredListAdjacencyGap(i, gapBytes)
              : ensureStructuralGap(i, gapBytes),
        );
        continue;
      }
    }
    gaps.push(ensureStructuralGap(i, gapForChangedPair(i)));
  }

  let trailing = "";
  if (originalBlocks.length > 0) {
    const r = originalBlocks[originalBlocks.length - 1].attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (r && r.end >= 0 && r.end <= originalBody.length) {
      trailing = originalBody.slice(r.end, originalBody.length);
    }
  }

  // Assemble.
  //
  // Each `contents[i]` is expected to end with `\n` so the gap (a
  // single `\n` for a blank line) sums to two `\n`s - the CommonMark
  // separator for adjacent blocks. The synthesis path normalizes its
  // emit via `normalizeBlockSynth`. For preserved bytes, the parser
  // *usually* includes the block's trailing `\n` in its content range,
  // EXCEPT for the original-last block, whose trailing `\n` is captured
  // in `trailing` (so it survives no-op saves byte-for-byte). When a
  // reorder moves the original-last block out of the last position, its
  // content slice ends without `\n` and the gap that follows can no
  // longer create a proper separator. Force-end every content with `\n`
  // here when the next block follows (or when there's no trailing left
  // to provide the file-ending newline) - idempotent against the
  // already-`\n`-terminated case.
  let out = leading;
  for (let i = 0; i < n; i++) {
    let c = contents[i];
    if (i < n - 1 && !/[\r\n]$/.test(c)) c = c + "\n";
    out += c;
    if (i < n - 1) out += gaps[i];
  }
  out += trailing;
  return out;
}

/** Default inter-block gap: one blank line.
 *
 *  Why one blank and not zero: a paragraph-paragraph pair with zero
 *  blanks between would re-parse as a single soft-broken paragraph
 *  (CommonMark), changing doc structure on round-trip. One blank is
 *  the safe no-merge separator for any block-type pair.
 *
 *  The content bytes of each block always END with their own line-
 *  ending `\n`, so this function returns just the EXTRA `\n` that
 *  creates a blank line between them: emitted output looks like
 *  `content_a` + `\n` + `\n` + `content_b` (two `\n` = one blank
 *  line, per CommonMark).
 */
function defaultGap(): string {
  return "\n";
}

/** Normalize a freshly-synthesized block body to end with exactly one
 *  `\n`. serializeBlock emits the block's content without a consistent
 *  trailing newline (paragraphs emit "text", headings emit "# text",
 *  code fences emit "```lang\n...\n```" - each varies). Callers that
 *  treat content-emission as "content + line-ending \n" rely on this
 *  to keep subsequent gap math deterministic. */
function normalizeBlockSynth(synth: string): string {
  let s = synth;
  while (s.endsWith("\n")) s = s.slice(0, -1);
  return s + "\n";
}
