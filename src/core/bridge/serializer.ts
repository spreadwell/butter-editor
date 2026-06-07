import { Node as PMNode, Fragment, Mark } from "prosemirror-model";
import { schema } from "../schema";
import { CANONICAL_DEFAULTS, type CanonicalFormOptions } from "./common";



// ═══════════════════════════════════════════════
//  SERIALIZER: ProseMirror doc -> markdown
// ═══════════════════════════════════════════════

// ── Mark specs ──

export interface MarkSpec {
  open: string | ((mark: Mark, parent: PMNode, index: number) => string);
  close: string | ((mark: Mark, parent: PMNode, index: number) => string);
  escape?: boolean;  // default true - escape text inside this mark?
  expel?: boolean;   // default false - expel enclosing whitespace?
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
    // background-color survives the round-trip. Plain (no color)
    // highlights honour `html` for the markdown vs HTML shape choice.
    open: (mark) => {
      if (mark.attrs.color) {
        return `<mark style="background-color: ${mark.attrs.color}">`;
      }
      return mark.attrs.html ? "<mark>" : "==";
    },
    close: (mark) =>
      mark.attrs.color || mark.attrs.html ? "</mark>" : "==",
    expel: true,
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
  underline:   { open: "<u>",   close: "</u>",   expel: true, rank: 0 },
  superscript: { open: "<sup>", close: "</sup>", expel: true, rank: 0 },
  subscript:   { open: "<sub>", close: "</sub>", expel: true, rank: 0 },
  kbd:         { open: "<kbd>", close: "</kbd>", expel: true, rank: 0 },
  font: {
    open: (mark) => {
      const parts: string[] = [];
      if (mark.attrs.color) parts.push(`color="${mark.attrs.color}"`);
      if (mark.attrs.face) parts.push(`face="${mark.attrs.face}"`);
      if (mark.attrs.size) parts.push(`size="${mark.attrs.size}"`);
      return parts.length ? `<font ${parts.join(" ")}>` : "<font>";
    },
    close: () => "</font>",
    expel: true,
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
      const rawHref = (mark.attrs.href ?? "") as string;
      const needsAngle = /[\s)<>]/.test(rawHref);
      const href = needsAngle
        ? `<${rawHref.replace(/([<>\\])/g, "\\$1")}>`
        : rawHref;
      // title: `"..."`. Inner `"` and `\` need backslash-escaping so
      // the title parses back as a single string. Without this, a
      // title like `she said "hi"` round-trips as broken markdown.
      const rawTitle = (mark.attrs.title ?? "") as string;
      const t = rawTitle
        ? ` "${rawTitle.replace(/(["\\])/g, "\\$1")}"`
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

function esc(str: string, startOfLine = false): string {
  str = str.replace(/[`*\\~[\]_]/g, "\\$&");
  if (startOfLine)
    str = str.replace(/^[#\-*+>]/, "\\$&").replace(/^(\s*\d+)\./, "$1\\.");
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
  return /^[ \t>]*(?:[-*+]\s+|\d+\.\s+)?(?:\[[ xX]\]\s+)?$/.test(lastLine);
}

// ── Serializer state ──

export type NodeSer = (state: SerState, node: PMNode, parent?: PMNode, index?: number) => void;

/** Compute keys of marks whose ranges interleave (overlap-but-not-nest)
 *  another mark's range within the given inline parent. Returns the
 *  set of "type::JSON(attrs)" keys for marks needing HTML-form emit.
 *
 *  Range = [first child index where mark appears, last child index + 1).
 *  Marks of the same type+attrs across non-contiguous text runs are
 *  collapsed into a single range - rare in practice and harmless even
 *  when it happens (the collapsed range can only be MORE conservatively
 *  flagged as overlapping, not less). */
function computeOverlapKeys(parent: PMNode): Set<string> {
  type Range = { start: number; end: number };
  // Track ALL contiguous ranges per mark key (not a single merged
  // range). When the overlap-resolver plugin smart-splits a previously
  // overlapping mark, both em and strong end up with multiple non-
  // contiguous runs separated by unmarked whitespace. Merging those
  // runs into a single range incorrectly re-flags overlap; the
  // serializer would emit HTML form even though the doc is now
  // pure-markdown-representable.
  const allRanges = new Map<string, Range[]>();
  const open = new Map<string, Range>();
  let i = 0;
  parent.forEach((child) => {
    const childKeys = new Set<string>();
    if (child.isText && child.marks.length) {
      for (const mark of child.marks) {
        childKeys.add(SerState.markKey(mark));
      }
    }
    // Close any open run whose mark isn't present on this child.
    for (const [key, range] of open) {
      if (!childKeys.has(key)) {
        const list = allRanges.get(key) ?? [];
        list.push(range);
        allRanges.set(key, list);
        open.delete(key);
      }
    }
    // Open or extend a run for each mark on this child.
    for (const key of childKeys) {
      const r = open.get(key);
      if (r) r.end = i + 1;
      else open.set(key, { start: i, end: i + 1 });
    }
    i++;
  });
  // Flush remaining open runs.
  for (const [key, range] of open) {
    const list = allRanges.get(key) ?? [];
    list.push(range);
    allRanges.set(key, list);
  }

  const overlap = new Set<string>();

  // CRITERION 1 - non-whitespace-separated non-contiguous runs.
  //
  // A mark with multiple contiguous runs in the same inline parent
  // can be serialized in markdown form ONLY if the gaps between its
  // runs contain whitespace (so the close-delim sits next to a
  // non-letter char, satisfying CommonMark right-flanking). When the
  // gap is just letter-only text (e.g., `[em]45[strong]67[em]89`),
  // emitting markdown produces `*45*67*89*` and markdown-it can't
  // correctly re-pair the alternating `*`s - the inner content's
  // delim becomes unpaired and the outer surface produces `<em>`-
  // less reparse + literal `*` text, breaking round-trip.
  //
  // Flag this mark for HTML form (`<em>` / `<strong>`) so each
  // non-contig run gets a clean tag pair that markdown-it accepts
  // independently.
  for (const [key, runs] of allRanges) {
    if (runs.length < 2) continue;
    let needsHtml = false;
    for (let r = 0; r < runs.length - 1; r++) {
      const gapStart = runs[r].end;
      const gapEnd = runs[r + 1].start;
      let gapHasWhitespace = false;
      for (let j = gapStart; j < gapEnd; j++) {
        const child = parent.maybeChild(j);
        if (!child) continue;
        if (child.isText && /\s/.test(child.text ?? "")) {
          gapHasWhitespace = true;
          break;
        }
      }
      if (!gapHasWhitespace) {
        needsHtml = true;
        break;
      }
    }
    if (needsHtml) overlap.add(key);
  }

  if (allRanges.size < 2) return overlap;

  // CRITERION 2 - strict interleave (the original detection).
  const entries = [...allRanges.entries()];
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const [keyA, listA] = entries[a];
      const [keyB, listB] = entries[b];
      outer: for (const A of listA) {
        for (const B of listB) {
          const interleave =
            (A.start < B.start && B.start < A.end && A.end < B.end) ||
            (B.start < A.start && A.start < B.end && B.end < A.end);
          if (interleave) {
            overlap.add(keyA);
            overlap.add(keyB);
            break outer;
          }
        }
      }
    }
  }

  // CRITERION 4 - close-and-reopen detection.
  //
  // When the renderInline mark stack needs to close a mark M that's
  // BELOW other marks N in the open order, the serializer closes the
  // Ns first (top-down), closes M, then reopens the Ns. If any of
  // the Ns are markdown-form (em/strong), their REOPEN delimiter
  // lands right after M's close - typically against an HTML tag
  // (`</font>**`) where flanking rules say `**` can't open. Re-parse
  // then treats it as literal text.
  //
  // Simulate active stack progression. Any mark that would be in the
  // reopen position (an N above a closing M) gets flagged for HTML
  // form so the reopen delimiter is `<strong>`/`<em>` instead of
  // `**`/`*` - HTML opens have no flanking constraint.
  //
  // Also flag the closing mark M when its close would land between
  // the original close-of-N and the reopen-of-N - same reasoning.
  // Conservatively flagging both sides of the close-and-reopen event
  // produces correct, round-trippable output.
  {
    const stack: string[] = [];
    const childKeySets = ((): Set<string>[] => {
      const sets: Set<string>[] = [];
      parent.forEach((child) => {
        const s = new Set<string>();
        if (child.isText && child.marks.length) {
          // Match the rank-sort renderInline applies. The stack
          // order is determined by open ORDER (rank-sorted within
          // each text-node's mark set), so simulating with rank-sort
          // matches reality.
          const sorted = child.marks.slice().sort((a, b) => {
            const ra = markSpecs[a.type.name]?.rank ?? 100;
            const rb = markSpecs[b.type.name]?.rank ?? 100;
            return ra - rb;
          });
          for (const m of sorted) s.add(SerState.markKey(m));
        }
        sets.push(s);
      });
      return sets;
    })();
    for (const targetSet of childKeySets) {
      // Close pass - mirror renderInline's close-and-reopen logic.
      for (let j = stack.length - 1; j >= 0; j--) {
        if (targetSet.has(stack[j])) continue;
        // Inners above j that should stay (in target) get reopened
        // around the close - flag them and the closing mark.
        for (let k = stack.length - 1; k > j; k--) {
          if (targetSet.has(stack[k])) {
            overlap.add(stack[k]);
            overlap.add(stack[j]);
          }
        }
        stack.splice(j, 1);
        j = stack.length;
      }
      // Open pass - push new marks (in target sort order, matching
      // renderInline's open loop).
      for (const key of targetSet) {
        if (!stack.includes(key)) stack.push(key);
      }
    }
  }

  // CRITERION 3 - flag-propagation. When CRITERION 1 forces a mark
  // (typically em) to HTML form because its non-contig runs aren't
  // whitespace-separated, a sibling mark (typically strong) whose
  // markdown delimiter would land at a non-flanking position
  // ALSO needs HTML form. Concretely: serializing
  // `**<em>45</em>67<em>89</em>**` fails because the outer `**`
  // delims are preceded/followed by punctuation `<`/`>` and a
  // non-ws non-punct char (the `3` and end-of-input edge), which
  // breaks CommonMark right/left-flanking rules. With both marks in
  // HTML form (`<strong><em>45</em>67<em>89</em></strong>`), no
  // flanking concerns apply.
  //
  // Propagation rule: any mark whose ANY contig run overlaps with
  // an already-flagged mark's range gets flagged too. Conservative
  // and idempotent - only marks that ALREADY share boundary issues
  // with a flagged mark get pulled in.
  if (overlap.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const flaggedKey of [...overlap]) {
        const flaggedRuns = allRanges.get(flaggedKey)!;
        for (const [otherKey, otherRuns] of allRanges) {
          if (overlap.has(otherKey)) continue;
          let touches = false;
          for (const fr of flaggedRuns) {
            for (const or of otherRuns) {
              if (or.start < fr.end && fr.start < or.end) {
                touches = true;
                break;
              }
            }
            if (touches) break;
          }
          if (touches) {
            overlap.add(otherKey);
            changed = true;
          }
        }
      }
    }
  }
  return overlap;
}

export class SerState {
  out = "";
  closed: PMNode | false = false;
  delim = "";
  canonicalForm: Required<CanonicalFormOptions>;

  /** Marks (by type+attrs key) whose range overlaps another mark's
   *  range in the current inline-render parent. CommonMark emphasis
   *  pairs require strict nesting, so `**` / `*` can't represent
   *  overlap; for these marks we emit `<strong>` / `<em>` HTML form
   *  instead, which my htmlInlineTagsPlugin handles via any-match
   *  close. Set is repopulated per renderInline() call. */
  overlapKeys: Set<string> = new Set();

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
  markOpen(mark: Mark, parent: PMNode, index: number): string {
    const name = mark.type.name;
    if (this.isOverlap(mark)) {
      if (name === "strong") return "<strong>";
      if (name === "em") return "<em>";
      if (name === "strikethrough") return "<s>";
      if (name === "highlight") {
        return mark.attrs.color
          ? `<mark style="background-color: ${mark.attrs.color}">`
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

  markClose(mark: Mark, parent: PMNode, index: number): string {
    const name = mark.type.name;
    if (this.isOverlap(mark)) {
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

  atBlank(): boolean { return /(^|\n)$/.test(this.out); }

  flushClose(size = 2) {
    if (!this.closed) return;
    if (!this.atBlank()) this.out += "\n";
    for (let i = 1; i < size; i++) this.out += this.delim + "\n";
    this.closed = false;
  }

  /** Write raw content. Prepends delim if at line start. */
  write(s: string) {
    this.flushClose();
    if (this.delim && this.atBlank()) this.out += this.delim;
    this.out += s;
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
        isInnerLineStart(this.out);
      this.flushClose();
      if (i > 0) {
        this.out += "\n";
        if (this.delim) this.out += this.delim;
      } else if (this.delim && this.atBlank()) {
        this.out += this.delim;
      }
      this.out += escape ? esc(lines[i], sol) : lines[i];
    }
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
            const last = this.out[this.out.length - 1];
            if (last && !/\s/.test(last)) this.write(" ");
          }
        }
        this.write(this.sourcePresBody.slice(r.start, r.end));
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

    let active: Mark[] = [];
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
        if (marks.some((m) => markSpecs[m.type.name]?.expel)) {
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
        if (active[j].isInSet(marks)) continue;
        const reopenList = active
          .slice(j + 1)
          .filter((m) => m.isInSet(marks));
        // Close inners (top-down) so the HTML/markdown stack stays
        // well-formed when we close the target below.
        for (let k = active.length - 1; k > j; k--) {
          this.write(this.markClose(active[k], parent, index));
        }
        // Close the unwanted mark.
        this.write(this.markClose(active[j], parent, index));
        // Replace active[j..end] with the kept inners. Marks that
        // were above j and aren't in target are simply gone - they
        // already closed in the inner-pass above.
        active.splice(j, active.length - j, ...reopenList);
        // Reopen the kept inners (preserve original opening order).
        for (const m of reopenList) {
          this.write(this.markOpen(m, parent, index));
        }
        // Restart from new top - `j--` will fire and land at
        // active.length - 1 next iteration.
        j = active.length;
      }

      // Leading whitespace (between close and open)
      if (leading) this.write(leading);

      // Open marks NOT currently active
      for (let j = 0; j < marks.length; j++) {
        if (!marks[j].isInSet(active)) {
          this.write(this.markOpen(marks[j], parent, index));
          active.push(marks[j]);
        }
      }
      if (!child) return;

      if (child.isText) {
        const noEsc = active.some(
          (m) => markSpecs[m.type.name]?.escape === false,
        );
        this.text(child.text!, !noEsc);
      } else {
        this.renderNode(child, parent, index);
      }
    };

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
    if (!lastChild || lastChild.type.name !== "block_id") {
      const tail = this.out.slice(startLen);
      const m = /\^[A-Za-z0-9_-]+$/.exec(tail);
      if (m) {
        const insertAt = startLen + tail.length - m[0].length;
        this.out = this.out.slice(0, insertAt) + "\\" + this.out.slice(insertAt);
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
      this.out += this.delim + "%%list-break%%\n";
      this.out += this.delim + "\n";
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
  node: PMNode,
  parent: PMNode | undefined,
  index: number | undefined,
  bulletChar: string,
): string {
  const depthRaw = (node.attrs as { depth?: unknown }).depth;
  const depth = typeof depthRaw === "number" ? depthRaw : 0;
  if (depth === 0 || !parent || index === undefined) return "";

  // Orphan-nesting guard: if the IMMEDIATE parent (depth-1) is
  // missing, the item has no anchor in the surrounding list flow
  // and any indent ≥ 4 characters reparses as an indented code
  // block. The fallback indent (~2 chars per missing depth) used
  // to push a depth≥2 orphan over the 4-space threshold and turn
  // the user's list item into a code block on save+reload — the
  // edit-sim harness caught this when an edit (wrap-in-callout
  // on the immediate parent) suddenly orphaned a deeper item.
  // Clamp orphan items to depth-0 serialization (no indent). The
  // visible attr changes on reparse from `depth=N` to `depth=0`
  // but the node type stays `list_item`, which is what matters
  // for round-trip safety (and reflects what markdown can faith-
  // fully express — there's no valid CommonMark for a depth-N
  // list item without a preceding depth-(N-1) item).
  let hasImmediateParent = false;
  for (let i = index - 1; i >= 0; i--) {
    const p = parent.child(i);
    if (p.type.name !== "list_item") break;
    if (p.attrs.depth < depth - 1) break;
    if (p.attrs.depth === depth - 1) {
      hasImmediateParent = true;
      break;
    }
  }
  if (!hasImmediateParent) return "";

  let prefix = "";
  for (let d = depth - 1; d >= 0; d--) {
    let ancestor: PMNode | null = null;
    let ancestorIdx = -1;
    for (let i = index - 1; i >= 0; i--) {
      const p = parent.child(i);
      if (p.type.name !== "list_item") break;
      if (p.attrs.depth < d) break;
      if (p.attrs.depth === d) {
        ancestor = p;
        ancestorIdx = i;
        break;
      }
    }
    if (ancestor) {
      // Use the BARE marker width (`- ` or `1. `, etc.) - NOT the
      // full task marker (`- [ ] `). Task brackets are content; the
      // continuation/nesting indent only needs to clear the bullet
      // or number prefix. Without this distinction, a child of a
      // task would get 6-space indent (matching `- [ ] `) and
      // markdown-it would treat the line as a 4+ space-indented
      // code block.
      prefix += " ".repeat(bareMarkerWidth(ancestor, parent, ancestorIdx));
    } else {
      // No ancestor at this depth but immediate parent exists - a
      // partial chain. Use 2 spaces, the bullet-marker width.
      prefix += "  ";
    }
  }
  return prefix;
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
  // Ordered: compute the rendered number and return its serialized width.
  let firstIdx = index ?? 0;
  if (parent && index !== undefined) {
    let i = index - 1;
    while (i >= 0) {
      const p = parent.child(i);
      if (p.type.name !== "list_item") break;
      if (p.attrs.depth > node.attrs.depth) {
        i--;
        continue;
      }
      if (p.attrs.depth < node.attrs.depth) break;
      if (p.attrs.kind !== "ordered") break;
      firstIdx = i;
      i--;
    }
  }
  const firstStart = (parent?.child(firstIdx).attrs.start as number | null) ?? 1;
  let count = 0;
  if (parent && index !== undefined) {
    for (let j = firstIdx; j <= index; j++) {
      const p = parent.child(j);
      if (
        p.type.name === "list_item" &&
        p.attrs.kind === "ordered" &&
        p.attrs.depth === node.attrs.depth
      ) {
        count++;
      }
    }
  } else {
    count = 1;
  }
  const number = firstStart + count - 1;
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
  // Ordered: count my position in the run.
  let firstIdx = index ?? 0;
  if (parent && index !== undefined) {
    let i = index - 1;
    while (i >= 0) {
      const p = parent.child(i);
      if (p.type.name !== "list_item") break;
      if (p.attrs.depth > node.attrs.depth) {
        i--;
        continue;
      }
      if (p.attrs.depth < node.attrs.depth) break;
      if (p.attrs.kind !== "ordered") break;
      firstIdx = i;
      i--;
    }
  }
  const firstStart = (parent?.child(firstIdx).attrs.start as number | null) ?? 1;
  let count = 0;
  if (parent && index !== undefined) {
    for (let j = firstIdx; j <= index; j++) {
      const p = parent.child(j);
      if (
        p.type.name === "list_item" &&
        p.attrs.kind === "ordered" &&
        p.attrs.depth === node.attrs.depth
      ) {
        count++;
      }
    }
  } else {
    count = 1;
  }
  return `${firstStart + count - 1}. `;
}

// ── Node serializer table ──

export const nodeSer: Record<string, NodeSer> = {
  // Standard blocks
  paragraph(state, node) {
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
    const stateAny = state as unknown as { out: string };
    const before = stateAny.out.length;
    state.renderInline(node);
    const after = stateAny.out.length;
    const inline: string = stateAny.out.slice(before, after);
    const collapsed = inline.replace(/[ \t]*\n[ \t]*/g, " ");
    if (collapsed !== inline) {
      stateAny.out = stateAny.out.slice(0, before) + collapsed;
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
  //     depth, possibly with deeper-nested items in between): use the
  //     current item's `tight` attr - tight = single \n, loose = blank
  //     line.
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
    let isContinuation = false;
    let isNested = false;
    if (parent && index !== undefined && index > 0) {
      let i = index - 1;
      while (i >= 0) {
        const p = parent.child(i);
        if (p.type.name !== "list_item") break;
        if (p.attrs.depth > node.attrs.depth) {
          // Deeper-nested children of an earlier sibling - skip past.
          i--;
          continue;
        }
        if (p.attrs.depth < node.attrs.depth) {
          isNested = true;
          break;
        }
        // Same depth - continuation iff same kind.
        if (p.attrs.kind === node.attrs.kind) isContinuation = true;
        break;
      }
    }

    if (state.closed) {
      const tight =
        (isContinuation || isNested) && node.attrs.tight !== false;
      state.flushClose(tight ? 1 : 2);
    }

    // Sum marker widths of ancestor items so the indent matches what
    // CommonMark requires for nesting (≥ parent marker width). For a
    // bullet/task parent that's 2 chars (`- ` / `* `); for an ordered
    // parent it depends on its rendered number ("1. " → 3, "10. " →
    // 4, etc.). Without this an item nested under "1. foo" would
    // serialize with 2-space indent, which markdown-it reads as a
    // sibling at depth 0, not a nested child - breaking round-trip.
    const depthIndent = computeDepthIndent(
      node,
      parent,
      index,
      state.canonicalForm.bullet,
    );
    const marker = computeListMarker(node, parent, index, state.canonicalForm.bullet);
    state.write(depthIndent + marker);

    // Continuation indent = depth indent + BARE marker width (just
    // the bullet/number prefix, not the task brackets). markdown-it
    // accepts task-item continuation at the bullet-marker column
    // the `[ ]` brackets are consumed as content. If we used the
    // full task marker width (6 chars for `- [ ] `), continuation
    // lines would land at column 6+ which markdown-it reads as a
    // 4+ space-indented code block, corrupting any callout / nested
    // markdown content inside the task.
    const contIndent = depthIndent.length + bareMarkerWidth(node, parent, index);
    const old = state.delim;
    state.delim += " ".repeat(contIndent);
    state.renderContent(node);
    state.delim = old;
    state.closeBlock(node);
  },
  code_block(state, node) {
    const lang = (node.attrs.language as string | undefined) ?? "";
    const fence = state.canonicalForm.codeFence;
    state.write(fence + lang);
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
    if (parent && index != null) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    } else {
      state.write("\\\n");
    }
  },
  softbreak(state) { state.write("\n"); },
  image(state, node) {
    const attrs = node.attrs as {
      src?: string;
      title?: string;
      alt?: string;
      width?: number | null;
      height?: number | null;
      displayMode?: string | null;
    };
    const src = attrs.src ?? "";
    const title = attrs.title;
    const width = attrs.width;
    const height = attrs.height;
    const displayMode = attrs.displayMode;
    let alt = esc(attrs.alt ?? "");
    if (displayMode === "full") {
      // Full-column-width sentinel - overrides any pixel size.
      alt = alt ? `${alt}|full` : "|full";
    } else if (width) {
      const sz = height ? `|${width}x${height}` : `|${width}`;
      alt = alt ? `${alt}${sz}` : sz;
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
      const savedOut = state.out;
      const stateAny = state as unknown as { delim: string; closed: boolean };
      const savedDelim = stateAny.delim;
      const savedClosed = stateAny.closed;
      state.out = "x"; // anchor - atBlankLine() returns false
      stateAny.delim = "";
      stateAny.closed = false;
      state.renderInline(c);
      const captured = state.out.slice(1)
        .replace(/\\?\n/g, "<br>")
        .replace(/\|/g, "\\|");
      state.out = savedOut;
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
      if (first && first.type.name === "horizontal_rule") {
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
    const stateAny = state as unknown as { out: string; closed: unknown };
    if (!stateAny.closed && !state.atBlank()) {
      const last = stateAny.out[stateAny.out.length - 1];
      if (last && !/\s/.test(last)) state.write(" ");
    }
    state.write(`#${(node.attrs.tag as string | undefined) ?? ""}`);
  },
  inline_math(state, node) {
    state.write(`$${(node.attrs.value as string | undefined) ?? ""}$`);
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
): string {
  const wrap = schema.nodes.doc.create(null, Fragment.from(block));
  const state = new SerState(options);
  if (context) {
    state.sourcePresBody = context.originalBody;
    state.sourcePresOriginalAtoms = context.originalInlineAtoms;
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

  // A list_item at depth > 0 needs an immediate parent (depth - 1)
  // in the CURRENT doc context for its preserved bytes to remain
  // round-trip-valid. When an edit removes/wraps the parent (e.g.
  // wrap-in-callout on a depth-1 item, leaving a depth-2 follower
  // orphan), the original bytes (`    - text`) still parse as a
  // valid list_item ONLY when preceded by the depth-1 sibling that
  // established the list context. Without that sibling, the 4-space
  // indent crosses CommonMark's code-block threshold and the line
  // reparses as `code_block` — the save guard fires, the user sees
  // their list item become code on reload. Detect this orphan case
  // and force canonical re-emission so `computeDepthIndent`'s
  // missing-immediate-parent clamp kicks in (item serialized at
  // column 0, reparses as `list_item depth=0` — visible attr shift
  // but the node TYPE is preserved, which is what round-trip safety
  // actually requires).
  const isOrphanListItem = (i: number): boolean => {
    const child = doc.child(i);
    if (child.type.name !== "list_item") return false;
    const depth = (child.attrs.depth as number | undefined) ?? 0;
    if (depth === 0) return false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = doc.child(j);
      if (prev.type.name !== "list_item") return true;
      const pd = (prev.attrs.depth as number | undefined) ?? 0;
      if (pd < depth - 1) return true;
      if (pd === depth - 1) return false;
    }
    return true;
  };

  // Content emission per block: either preserved original bytes (if
  // reference-identical AND has a valid sourceRange AND not an
  // orphan-nested list_item) or synthesized canonical bytes. Content
  // includes the block's own line-ending \n but NOT any inter-block
  // blank lines.
  const contents: string[] = [];
  for (let i = 0; i < n; i++) {
    const child = doc.child(i);
    const range = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    const canPreserve =
      ids[i].preserved &&
      !isOrphanListItem(i) &&
      range &&
      typeof range.start === "number" &&
      typeof range.end === "number" &&
      range.start >= 0 &&
      range.end >= range.start &&
      range.end <= originalBody.length;

    if (canPreserve && range) {
      contents.push(originalBody.slice(range.start, range.end));
    } else {
      contents.push(normalizeBlockSynth(serializeBlock(child, blockSynthCtx, options)));
    }
  }

  // Leading whitespace: the bytes before the first block's content.
  // Preserved only if the current first block's origIdx is 0 (same
  // block sits at doc start). Otherwise reordering moved a different
  // block to the top and the original leading whitespace no longer
  // applies.
  let leading = "";
  if (n > 0 && ids[0].origIdx === 0) {
    const r = doc.firstChild!.attrs.sourceRange as
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
        const synthesizedEdge = !a.preserved || !b.preserved;
        if (synthesizedEdge && gapBytes.length === 0) {
          gaps.push(defaultGap());
        } else {
          gaps.push(gapBytes);
        }
        continue;
      }
    }
    gaps.push(defaultGap());
  }

  // Trailing whitespace: bytes after the last block's content.
  // Preserved only if the current last block is the same as the
  // original last block (same origIdx at the end).
  let trailing = "";
  if (n > 0 && ids[n - 1].origIdx === originalBlocks.length - 1) {
    const r = doc.lastChild!.attrs.sourceRange as
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
    if (i < n - 1 && !c.endsWith("\n")) c = c + "\n";
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
