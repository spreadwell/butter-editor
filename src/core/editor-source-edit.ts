import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { parser } from "./parser";
import { isWholeSourceFallback } from "./raw-block-safety";
import { canonicalizeLinkOccurrences, freshenLinkOccurrenceSlice } from "./link-occurrence";
import { splitButterFileSource } from "./file-shell";

export interface EditorSourceSnapshot {
  readonly doc: PMNode;
  /** Full-file Editor coordinates use LF and exclude the physical UTF-8 BOM. */
  readonly text: string;
}

export interface EditorSourceHost {
  snapshot(): EditorSourceSnapshot;
  certify(doc: PMNode): string;
  apply(snapshot: EditorSourceSnapshot, transaction: Transaction): void;
}

export class EditorSourceCursorUnavailable extends Error {}

export function editorSourceText(text: string): string {
  return text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
}

interface PlainSpan { source: number; position: number; length: number }
const plainMaps = new WeakMap<PMNode, { text: string; spans: PlainSpan[] | null }>();

/** Exact linear fast path for plain paragraphs. Validate the COMPLETE source
 * decomposition; never search for a matching word or infer a block ordinal. */
function plainSpans(snapshot: EditorSourceSnapshot): PlainSpan[] | null {
  const cached = plainMaps.get(snapshot.doc);
  if (cached?.text === snapshot.text) return cached.spans;
  const bodyStart = splitButterFileSource(snapshot.text).frontmatter.length;
  const spans: PlainSpan[] = [];
  let source = bodyStart, position = 0, valid = true;
  snapshot.doc.forEach(node => {
    if (!valid) return;
    const gapStart = source;
    while (snapshot.text[source] === "\n") source++;
    if (spans.length && source - gapStart < 2) { valid = false; return; }
    if (node.type.name !== "paragraph" || !node.content.size || node.marks.length ||
      Array.from({ length: node.childCount }, (_, index) => node.child(index))
        .some(child => !child.isText || child.marks.length) ||
      snapshot.text.slice(source, source + node.textContent.length) !== node.textContent) {
      valid = false; return;
    }
    spans.push({ source, position: position + 1, length: node.textContent.length });
    source += node.textContent.length; position += node.nodeSize;
  });
  while (snapshot.text[source] === "\n") source++;
  const result = valid && source === snapshot.text.length ? spans : null;
  plainMaps.set(snapshot.doc, { text: snapshot.text, spans: result });
  return result;
}

/** Comparison only. Never install these metadata-free nodes in the editor. */
function comparison(doc: PMNode, diffOnly = false): PMNode {
  const visit = (node: PMNode): PMNode => {
    const marks = diffOnly ? node.marks.map(mark => mark.type.name === "link_occurrence"
      ? mark.type.create({ ...mark.attrs, id: "diff" }) : mark) : node.marks;
    if (node.isText) return node.mark(marks);
    const attrs = { ...node.attrs };
    if ("sourceRange" in attrs) attrs.sourceRange = null;
    if ("blockId" in attrs) attrs.blockId = null;
    const children: PMNode[] = [];
    node.forEach(child => children.push(visit(child)));
    return node.type.create(attrs, Fragment.fromArray(children), marks);
  };
  const mapped = visit(doc);
  return diffOnly ? mapped : canonicalizeLinkOccurrences(mapped);
}

export function editorSourceDocumentsEqual(left: PMNode, right: PMNode): boolean {
  return comparison(left).eq(comparison(right));
}

/** Incoming parser ranges describe different source bytes, never the baseline. */
function withoutSourceRanges(node: PMNode): PMNode {
  if (node.isText) return node;
  const children: PMNode[] = [];
  node.forEach(child => children.push(withoutSourceRanges(child)));
  return node.type.create("sourceRange" in node.attrs
    ? { ...node.attrs, sourceRange: null } : node.attrs, Fragment.fromArray(children), node.marks);
}

/** A complete source line may begin at Markdown syntax rather than an editable
 * text cursor. Anchor that operation in the FRESH parser's block ranges. The
 * full parsed source has already been proved equivalent to the live document;
 * unchanged prefix/suffix nodes must also agree with the expected parse. This
 * is a certified structural splice, never a search for matching visible text. */
function planLineBlockEdit(
  state: EditorState, snapshot: EditorSourceSnapshot, from: number, to: number,
  expected: string, before: PMNode, parsed: PMNode, certify: (doc: PMNode) => string,
): Transaction {
  const refuse = (): never => { throw new Error("Butter plugin edit: source line has no exact block boundary"); };
  if ((from > 0 && snapshot.text[from - 1] !== "\n") ||
    (to < snapshot.text.length && snapshot.text[to] !== "\n" && snapshot.text[to - 1] !== "\n")) return refuse();
  const bodyStart = splitButterFileSource(snapshot.text).frontmatter.length;
  const spans: Array<{ start: number; end: number; position: number }> = [];
  before.forEach((node, position) => {
    const range = node.attrs.sourceRange as { start?: number; end?: number } | null;
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return;
    spans.push({ start: bodyStart + range.start!, end: bodyStart + range.end!, position });
  });
  if (spans.length !== before.childCount || spans.some((span, i) =>
    span.end <= span.start || (i > 0 && spans[i - 1].end > span.start))) return refuse();
  const first = spans.findIndex(span => span.start <= from && from < span.end);
  if (first < 0) return refuse();
  let last = first;
  const effectiveTo = to > from && snapshot.text[to - 1] === "\n" ? to - 1 : to;
  while (last < spans.length - 1 && spans[last].end < effectiveTo) last++;
  if (spans[last].end < effectiveTo) return refuse();
  const suffix = before.childCount - last - 1, targetEnd = parsed.childCount - suffix;
  if (targetEnd < first || editorSourceDocumentsEqual(before, parsed)) return refuse();
  for (let i = 0; i < first; i++) {
    if (!comparison(before.child(i), true).eq(comparison(parsed.child(i), true))) return refuse();
  }
  for (let i = 0; i < suffix; i++) {
    if (!comparison(before.child(last + 1 + i), true).eq(comparison(parsed.child(targetEnd + i), true))) return refuse();
  }
  const oldStart = spans[first].position;
  const oldEnd = spans[last].position + state.doc.child(last).nodeSize;
  const nodes: PMNode[] = [];
  for (let i = first; i < targetEnd; i++) nodes.push(withoutSourceRanges(parsed.child(i)));
  // A one-block replacement still owns that live block's ORIGINAL provenance.
  // Fresh parser ranges are never installed as baseline ranges. Keep the owner
  // once (and only once) when its type survives, so authored list marker style
  // and runtime identity need not be discarded by a complete-line operation.
  const owner = state.doc.child(first), incoming = nodes[0];
  if (first === last && incoming?.type === owner.type) {
    const provenance = owner.attrs as Readonly<Record<string, unknown>>;
    nodes[0] = incoming.type.create({ ...incoming.attrs,
      sourceRange: provenance.sourceRange, blockId: provenance.blockId }, incoming.content, incoming.marks);
  }
  const slice = freshenLinkOccurrenceSlice(state.doc, new Slice(Fragment.fromArray(nodes), 0, 0));
  const tr = closeHistory(state.tr).setStoredMarks(null).replace(oldStart, oldEnd, slice);
  if (certify(tr.doc) !== expected) throw new Error("Butter plugin edit: exact source preservation is unavailable for this line");
  const replacementLength = expected.length - snapshot.text.length + to - from;
  if (replacementLength > 0 && state.selection instanceof TextSelection &&
    state.selection.to >= oldStart && state.selection.from <= oldEnd) {
    const replacement = expected.slice(from, from + replacementLength);
    const lastLine = replacement.lastIndexOf("\n") + 1;
    const project = (position: number): number => {
      const offset = editorPositionToSource(state, snapshot, position, certify);
      if (offset < from) return offset;
      if (offset > to) return offset + expected.length - snapshot.text.length;
      const column = offset - (snapshot.text.lastIndexOf("\n", offset - 1) + 1);
      return from + lastLine + Math.min(column, replacement.length - lastLine);
    };
    const next = EditorState.create({ doc: tr.doc }), nextSnapshot = { doc: tr.doc, text: expected };
    tr.setSelection(TextSelection.create(tr.doc,
      editorSourceToPosition(next, nextSnapshot, project(state.selection.anchor), certify),
      editorSourceToPosition(next, nextSnapshot, project(state.selection.head), certify)));
  }
  return tr;
}

/** Plan one local edit; no baseline change, filesystem write or state mutation. */
export function planEditorSourceEdit(
  state: EditorState,
  snapshot: EditorSourceSnapshot,
  from: number,
  to: number,
  insert: string,
  certify: (doc: PMNode) => string,
  cursorProbe = false,
): Transaction | null {
  if (snapshot.doc !== state.doc) throw new Error("Butter plugin edit: source changed");
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > snapshot.text.length) {
    throw new Error("Butter plugin edit: invalid source range");
  }
  const shell = splitButterFileSource(snapshot.text);
  if (from < shell.frontmatter.length) throw new Error("Butter plugin edit: frontmatter edits are not supported");
  const expected = snapshot.text.slice(0, from) + insert.replace(/\r\n?/g, "\n") + snapshot.text.slice(to);
  if (expected === snapshot.text) return null;
  // Do not let a body edit introduce a new YAML header or consume the old one.
  if (splitButterFileSource(expected).frontmatter !== shell.frontmatter) {
    throw new Error("Butter plugin edit: file header changed");
  }
  const before = parser.parseWithSourceMap(shell.body)?.doc;
  const parsed = parser.parseWithSourceMap(expected.slice(shell.frontmatter.length))?.doc;
  if (!before || !parsed || isWholeSourceFallback(state.doc) || isWholeSourceFallback(before) || isWholeSourceFallback(parsed)) {
    throw cursorProbe ? new EditorSourceCursorUnavailable("Butter plugin edit: source cannot be represented safely")
      : new Error("Butter plugin edit: source cannot be represented safely");
  }
  if (!editorSourceDocumentsEqual(state.doc, before)) throw new Error("Butter plugin edit: source does not represent the current editor");
  const spans = plainSpans(snapshot);
  const plainPoint = (offset: number): number | undefined => {
    const span = spans?.find(item => offset >= item.source && offset <= item.source + item.length);
    return span ? span.position + offset - span.source : undefined;
  };
  let fromPoint = plainPoint(from), toPoint = plainPoint(to);
  // A semantic diff can slide an insertion through identical text or blocks.
  // Anchor those cases at certified cursor positions, never at the twin.
  if (!cursorProbe) {
    try {
      fromPoint ??= editorSourceToPosition(state, snapshot, from, certify);
      toPoint ??= from === to ? fromPoint : editorSourceToPosition(state, snapshot, to, certify);
    } catch (error) {
      if (!(error instanceof EditorSourceCursorUnavailable)) throw error;
      return planLineBlockEdit(state, snapshot, from, to, expected, before, parsed, certify);
    }
  }
  if (!cursorProbe && fromPoint !== undefined && toPoint !== undefined) {
    const direct = closeHistory(state.tr).setStoredMarks(null).insertText(insert.replace(/\r\n?/g, "\n"), fromPoint, toPoint);
    // This path retains exact identity/selection through repeated text. Raw
    // Markdown syntax instead falls through to the parsed structural edit.
    if (editorSourceDocumentsEqual(direct.doc, parsed)) {
      try { if (certify(direct.doc) === expected) return direct; } catch { /* Pure refusal; no live mutation. */ }
    }
  }
  const live = comparison(state.doc, true), target = comparison(parsed, true);
  let start = live.content.findDiffStart(target.content);
  const end = live.content.findDiffEnd(target.content);
  if (start === null || end === null) throw cursorProbe
    ? new EditorSourceCursorUnavailable("Butter plugin edit: source-only changes are not supported")
    : new Error("Butter plugin edit: source-only changes are not supported");
  let oldEnd = end.a, newEnd = end.b;
  const overlap = start - Math.min(oldEnd, newEnd);
  if (overlap > 0) { oldEnd += overlap; newEnd += overlap; }
  let projectSelection = false;
  if (!cursorProbe) {
    if (fromPoint === undefined || toPoint === undefined || start < fromPoint) {
      throw new Error("Butter plugin edit: ambiguous source ownership");
    }
    // Extend equal context back to the actual source anchor rather than
    // letting a diff slide into the next identical paragraph.
    projectSelection = start !== fromPoint || toPoint > oldEnd;
    start = fromPoint; oldEnd = Math.max(oldEnd, toPoint);
    newEnd = oldEnd + target.content.size - live.content.size;
    if (newEnd < start || newEnd > target.content.size) throw new Error("Butter plugin edit: invalid structural range");
  }
  const replacement = withoutSourceRanges(parsed).slice(start, newEnd);
  const tr = closeHistory(state.tr).replace(start, oldEnd, freshenLinkOccurrenceSlice(state.doc, replacement));
  if (certify(tr.doc) !== expected) throw cursorProbe
    ? new EditorSourceCursorUnavailable("Butter plugin edit: exact source preservation is unavailable for this range")
    : new Error("Butter plugin edit: exact source preservation is unavailable for this range");
  if (projectSelection && state.selection instanceof TextSelection) {
    const project = (position: number): number => {
      const offset = editorPositionToSource(state, snapshot, position, certify);
      return offset < from ? offset : offset > to ? offset + expected.length - snapshot.text.length
        : from + insert.replace(/\r\n?/g, "\n").length;
    };
    const next = EditorState.create({ doc: tr.doc }), nextSnapshot = { doc: tr.doc, text: expected };
    tr.setSelection(TextSelection.create(tr.doc,
      editorSourceToPosition(next, nextSnapshot, project(state.selection.anchor), certify),
      editorSourceToPosition(next, nextSnapshot, project(state.selection.head), certify)));
  }
  return tr;
}

/** A cursor probe is accepted only if removing it restores the exact source. */
export function editorPositionToSource(
  state: EditorState, snapshot: EditorSourceSnapshot, position: number, certify: (doc: PMNode) => string,
): number {
  if (state.doc !== snapshot.doc) throw new Error("Butter plugin edit: source changed");
  const plain = plainSpans(snapshot)?.find(span => position >= span.position && position <= span.position + span.length);
  if (plain) return plain.source + position - plain.position;
  const marker = cursorMarker(snapshot.text);
  // Pending toolbar marks describe future typing, not this existing position.
  const probed = certify(state.tr.insert(position,
    state.schema.text(marker, state.doc.resolve(position).marks())).doc);
  const offset = probed.indexOf(marker);
  if (offset < 0 || probed.indexOf(marker, offset + marker.length) >= 0 ||
    probed.slice(0, offset) + probed.slice(offset + marker.length) !== snapshot.text) {
    throw new EditorSourceCursorUnavailable("Butter plugin edit: cursor has no exact source position");
  }
  return offset;
}

export function editorSourceToPosition(
  state: EditorState, snapshot: EditorSourceSnapshot, offset: number, certify: (doc: PMNode) => string,
): number {
  if (state.doc !== snapshot.doc) throw new Error("Butter plugin edit: source changed");
  const plain = plainSpans(snapshot)?.find(span => offset >= span.source && offset <= span.source + span.length);
  if (plain) return plain.position + offset - plain.source;
  const marker = cursorMarker(snapshot.text);
  const tr = planEditorSourceEdit(state, snapshot, offset, offset, marker, certify, true);
  const step = tr?.steps[0] as { from?: number; to?: number; slice?: { openStart: number; openEnd: number; content: Fragment } } | undefined;
  if (!tr || tr.steps.length !== 1 || step?.from !== step?.to || typeof step?.from !== "number" ||
    !step.slice || step.slice.openStart !== 0 || step.slice.openEnd !== 0 || step.slice.content.childCount !== 1 ||
    step.slice.content.firstChild?.text !== marker) {
    throw new EditorSourceCursorUnavailable("Butter plugin edit: source position is not an editable cursor");
  }
  return step.from;
}

function cursorMarker(text: string): string {
  let marker = "ButterCursor";
  while (text.includes(marker)) marker += "";
  return marker;
}

/**
 * Live Preview shows a new empty line as an empty source line, but an empty
 * Butter paragraph has no source until it holds text. While the cursor sits in
 * one, plugins read the source with that empty line in place, and text they
 * insert there fills the paragraph. Every edit is still certified exactly.
 */
export interface EditorSourceProjection {
  /** The source as plugins read it, including the cursor's empty line. */
  readonly text: string;
  /** Start of the cursor's empty line in `text`. */
  readonly offset: number;
  /** The live document and cursor this projection describes. */
  readonly doc: PMNode;
  readonly position: number;
  /** The live document with `marker` at the cursor, and its exact source. */
  readonly marker: string;
  readonly state: EditorState;
  readonly snapshot: EditorSourceSnapshot;
}

/** `presented` is `source` plus blank lines only, with `offset` on an empty line. */
function addsOnlyBlankLines(presented: string, source: string, offset: number): boolean {
  if ((offset > 0 && presented[offset - 1] !== "\n") || (offset < presented.length && presented[offset] !== "\n")) return false;
  const left = presented.slice(0, offset).replace(/\n+$/, ""), right = presented.slice(offset).replace(/^\n+/, "");
  return left.length + right.length <= source.length && source.startsWith(left) && source.endsWith(right) &&
    /^\n*$/.test(source.slice(left.length, source.length - right.length));
}

const projections = new WeakMap<PMNode, { head: number; text: string; projection: EditorSourceProjection | null }>();

/** Null when the cursor has an exact source position, or its empty block
 * would be more than a blank line (a quote or list marker, for example). */
export function projectEmptyLineCursor(
  state: EditorState, snapshot: EditorSourceSnapshot, certify: (doc: PMNode) => string,
): EditorSourceProjection | null {
  if (state.doc !== snapshot.doc) throw new Error("Butter plugin edit: source changed");
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty ||
    !selection.$head.parent.isTextblock || selection.$head.parent.content.size) return null;
  const head = selection.head, cached = projections.get(state.doc);
  if (cached?.head === head && cached.text === snapshot.text) return cached.projection;
  const marker = cursorMarker(snapshot.text);
  const doc = state.tr.insert(head, state.schema.text(marker)).doc;
  let projection: EditorSourceProjection | null = null;
  try {
    const text = certify(doc), offset = text.indexOf(marker);
    const presented = text.slice(0, offset) + text.slice(offset + marker.length);
    if (offset >= 0 && text.indexOf(marker, offset + marker.length) < 0 &&
      presented !== snapshot.text && addsOnlyBlankLines(presented, snapshot.text, offset)) {
      projection = { text: presented, offset, doc: state.doc, position: head, marker, snapshot: { doc, text },
        state: EditorState.create({ doc, selection: TextSelection.create(doc, head) }) };
    }
  } catch { /* No projection; exact cursor reads keep refusing. */ }
  projections.set(state.doc, { head, text: snapshot.text, projection });
  return projection;
}

export function projectedSourceToPosition(
  projection: EditorSourceProjection, offset: number, certify: (doc: PMNode) => string,
): number {
  const { marker, position } = projection;
  const at = editorSourceToPosition(projection.state, projection.snapshot,
    offset <= projection.offset ? offset : offset + marker.length, certify);
  return at <= position ? at : Math.max(position, at - marker.length);
}

/** Plan an edit in projected coordinates. Text inserted on the cursor's empty
 * line fills its paragraph; other edits leave that paragraph empty. */
export function planProjectedSourceEdit(
  state: EditorState, projection: EditorSourceProjection, from: number, to: number,
  insert: string, certify: (doc: PMNode) => string,
): Transaction | null {
  if (state.doc !== projection.doc) throw new Error("Butter plugin edit: source changed");
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > projection.text.length) {
    throw new Error("Butter plugin edit: invalid source range");
  }
  const { marker, offset, position } = projection, text = insert.replace(/\r\n?/g, "\n");
  const shift = (value: number) => value <= offset ? value : value + marker.length;
  // Text ending in a line break, inserted on the empty line, stays above it,
  // as in Live Preview: a paragraph break keeps the empty paragraph below.
  const placed = from === offset && to === offset && text.endsWith("\n") ? text.replace(/\n+$/, "\n\n") : text;
  const planned = planEditorSourceEdit(projection.state, projection.snapshot, shift(from), shift(to), placed, certify);
  if (!planned) return null;
  // Replay the plan on the live document around the same marker, then remove it.
  const tr = closeHistory(state.tr).setStoredMarks(null).insert(position, state.schema.text(marker));
  for (const step of planned.steps) {
    if (tr.maybeStep(step).failed) throw new Error("Butter plugin edit: projected edit does not apply");
  }
  if (planned.selectionSet) tr.setSelection(TextSelection.create(tr.doc, planned.selection.anchor, planned.selection.head));
  const found: number[] = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (let i = node.text!.indexOf(marker); i >= 0; i = node.text!.indexOf(marker, i + 1)) found.push(pos + i);
    return false;
  });
  if (found.length > 1) throw new Error("Butter plugin edit: projected edit is ambiguous");
  const expected = projection.text.slice(0, from) + text + projection.text.slice(to);
  let blankAt = -1;
  if (found.length) {
    // A paragraph the edit left empty keeps its line only in the projection.
    if (tr.doc.resolve(found[0]).parent.content.size === marker.length) {
      const source = projection.snapshot.text;
      blankAt = (source.slice(0, shift(from)) + placed + source.slice(shift(to))).indexOf(marker);
    }
    tr.delete(found[0], found[0] + marker.length);
  }
  const result = certify(tr.doc);
  if (blankAt >= 0 ? !addsOnlyBlankLines(expected, result, blankAt) : result !== expected) {
    throw new Error("Butter plugin edit: exact source preservation is unavailable for this range");
  }
  return tr;
}
