/**
 * Editor shim - exposes a ProseMirror editor view as an Obsidian
 * `Editor` so plugins that use the EditorSuggest system (natural-
 * language dates, file/tag/heading suggestions, custom completions)
 * can operate against our view.
 *
 * Source edits are diffed and certified before dispatch. Unsupported source
 * ranges fail explicitly; visible-text matching must never choose a target.
 */
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection, type Transaction } from "prosemirror-state";
import { toggleMark } from "prosemirror-commands";
import { closeHistory } from "prosemirror-history";
import type { Serializer } from "../core/serializer-types";
import {
  editorSourceText, editorPositionToSource, editorSourceToPosition,
  planEditorSourceEdit, planProjectedSourceEdit, projectEmptyLineCursor, projectedSourceToPosition,
  type EditorSourceHost, type EditorSourceProjection, type EditorSourceSnapshot,
} from "../core/editor-source-edit";

export interface EditorPosition {
  line: number;
  ch: number;
}

interface LineMap {
  text: string;
  lines: string[];
  /** UTF-16 source offsets at the start of each line. */
  lineStarts: number[];
}

/** Install an already certified plugin edit through the normal host and history. */
export function applyEditorSourceTransaction(
  pm: EditorView, snapshot: EditorSourceSnapshot, tr: Transaction, sourceHost?: EditorSourceHost,
): void {
  if (pm.isDestroyed || pm.composing || !pm.editable || snapshot.doc !== pm.state.doc) {
    throw new Error("Butter plugin edit: editor is unavailable");
  }
  const previousDoc = pm.state.doc;
  try {
    if (sourceHost) sourceHost.apply(snapshot, tr);
    else pm.dispatch(tr);
  } finally {
    if (!pm.isDestroyed && pm.state.doc !== previousDoc) pm.dispatch(closeHistory(pm.state.tr));
  }
}

function buildLineMap(text: string): LineMap {
  const lines = text.split("\n");
  const lineStarts: number[] = [0];
  let offset = 0;
  for (const line of lines.slice(0, -1)) {
    offset += line.length + 1;
    lineStarts.push(offset);
  }
  return { text, lines, lineStarts };
}

/**
 * Minimal subset of Obsidian's Editor interface that covers
 * EditorSuggest usage and common plugin probes.
 */
export class PMEditorShim {
  private lineMap: LineMap;
  private snapshot: EditorSourceSnapshot | null = null;
  /** The cursor's empty line, while the cursor sits in an empty paragraph. */
  private projection: EditorSourceProjection | null = null;

  constructor(
    private pm: EditorView,
    private serialize: Serializer,
    private sourceHost?: EditorSourceHost,
    private toggleChecklist?: (cycle: boolean) => void,
  ) {
    // Plugin views are constructed before the owning file view finishes mount.
    // Read the authoritative source only when an Editor method is invoked.
    this.lineMap = buildLineMap("");
  }

  /** Recompute when the PM doc changes. */
  refresh() {
    this.snapshot = null;
    this.projection = null;
  }

  private readSource(): EditorSourceSnapshot {
    this.snapshot = this.currentSource();
    this.projection = projectEmptyLineCursor(this.pm.state, this.snapshot, this.certify);
    this.lineMap = buildLineMap(this.projection?.text ?? this.snapshot.text);
    return this.snapshot;
  }

  private currentSource(): EditorSourceSnapshot {
    if (this.pm.isDestroyed) throw new Error("Butter plugin edit: editor is closed");
    return this.sourceHost?.snapshot() ?? { doc: this.pm.state.doc, text: editorSourceText(this.serialize(this.pm.state.doc)) };
  }

  private certify = (doc: PMNode): string => {
    return this.sourceHost?.certify(doc) ?? editorSourceText(this.serialize(doc));
  };

  private applySourceRange(replacement: string, from: number, to: number): void {
    if (this.pm.isDestroyed || this.pm.composing) throw new Error("Butter plugin edit: editor is unavailable");
    if (!this.snapshot) throw new Error("Butter plugin edit: source is unavailable");
    const start = Math.min(from, to), end = Math.max(from, to);
    const tr = this.projection
      ? planProjectedSourceEdit(this.pm.state, this.projection, start, end, replacement, this.certify)
      : planEditorSourceEdit(this.pm.state, this.snapshot, start, end, replacement, this.certify);
    if (!tr) return;
    try {
      applyEditorSourceTransaction(this.pm, this.snapshot, tr, this.sourceHost);
    } finally {
      this.refresh();
    }
  }

  // ── Position translation ──

  private posToLineCh(offset: number): EditorPosition {
    offset = Math.max(0, Math.min(offset, this.lineMap.text.length));
    const { lineStarts } = this.lineMap;
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid + 1] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return { line: lo, ch: offset - lineStarts[lo] };
  }

  private lineChToPos(p: EditorPosition): number {
    if (!Number.isSafeInteger(p.line) || !Number.isSafeInteger(p.ch)) throw new Error("Butter plugin edit: invalid source position");
    const { lineStarts, lines } = this.lineMap;
    const line = Math.max(0, Math.min(p.line, lines.length - 1));
    const ch = Math.max(0, Math.min(p.ch, lines[line].length));
    return lineStarts[line] + ch;
  }

  // ── Public API (subset of Obsidian Editor) ──

  getValue(): string {
    this.readSource();
    return this.lineMap.text;
  }

  setValue(_: string): void {
    throw new Error("Butter plugin edit: whole-file replacement is not supported");
  }

  getLine(n: number): string {
    this.readSource();
    return this.lineMap.lines[n] ?? "";
  }

  setLine(n: number, text: string): void {
    if (!this.pm.editable) return;
    this.readSource();
    if (!Number.isSafeInteger(n) || n < 0 || n >= this.lineMap.lines.length) {
      throw new Error("Butter plugin edit: invalid source line");
    }
    const start = this.lineMap.lineStarts[n];
    this.applySourceRange(text, start, start + this.lineMap.lines[n].length);
  }

  lineCount(): number {
    this.readSource();
    return this.lineMap.lines.length;
  }

  lastLine(): number {
    this.readSource();
    return this.lineMap.lines.length - 1;
  }

  getCursor(side = "head"): EditorPosition {
    const snapshot = this.readSource();
    // A projection exists only for a collapsed cursor, so every side is on its line.
    if (this.projection) return this.posToLineCh(this.projection.offset);
    const selection = this.pm.state.selection;
    const position = side === "from" ? selection.from : side === "to" ? selection.to
      : side === "anchor" ? selection.anchor : selection.head;
    return this.posToLineCh(editorPositionToSource(this.pm.state, snapshot, position, this.certify));
  }

  getClickableTokenAt(_pos: EditorPosition): unknown {
    return null;
  }

  setCursor(pos: EditorPosition | number, ch = 0): void {
    this.setSelection(typeof pos === "number" ? { line: pos, ch } : pos);
  }

  listSelections(): Array<{ anchor: EditorPosition; head: EditorPosition }> {
    return [{ anchor: this.getCursor("anchor"), head: this.getCursor("head") }];
  }

  setSelections(ranges: Array<{ anchor: EditorPosition; head?: EditorPosition }>, main = 0): void {
    // ProseMirror has one authoritative selection. Never silently drop cursors.
    if (ranges.length !== 1 || main !== 0) throw new Error("Butter plugin edit: multiple selections are not supported");
    this.setSelection(ranges[0].anchor, ranges[0].head);
  }

  setSelection(anchor: EditorPosition, head = anchor): void {
    const snapshot = this.readSource(), projection = this.projection;
    const state = this.pm.state;
    const position = (p: EditorPosition) => projection
      ? projectedSourceToPosition(projection, this.lineChToPos(p), this.certify)
      : editorSourceToPosition(state, snapshot, this.lineChToPos(p), this.certify);
    const a = position(anchor), h = position(head);
    if (!state.doc.resolve(a).parent.inlineContent || !state.doc.resolve(h).parent.inlineContent) {
      throw new Error("Butter plugin edit: selection is not an editable text range");
    }
    this.pm.dispatch(state.tr.setSelection(TextSelection.create(state.doc, a, h)));
  }

  getSelection(): string {
    return this.getRange(this.getCursor("from"), this.getCursor("to"));
  }

  somethingSelected(): boolean {
    return !this.pm.state.selection.empty;
  }

  toggleMarkdownFormatting(format?: unknown, ...rest: unknown[]): void {
    // Obsidian's native formatting commands can fall back to the active
    // Editor shim when Butter declines its direct command bridge. Honor the
    // EditorView's canonical editable state here as well so a read-only
    // license state cannot mutate stored marks through that fallback.
    if (!this.pm.editable) return;
    const normalized = [format, ...rest]
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          return [
            record.type,
            record.mark,
            record.name,
            record.format,
            record.syntax,
            record.token,
          ]
            .filter((value) => typeof value === "string")
            .join(" ");
        }
        return "";
      })
      .join(" ")
      .toLowerCase();
    const markName =
      /\b(bold|strong)\b|\*\*|__/.test(normalized)
        ? "strong"
        : /\b(italic|italics|em)\b|(^|\s)[*_](\s|$)/.test(normalized)
          ? "em"
          : /\b(strikethrough|strike)\b|~~/.test(normalized)
            ? "strikethrough"
            : /\b(inline-code|code)\b|`/.test(normalized)
              ? "code"
              : /\bhighlight\b|==/.test(normalized)
                ? "highlight"
                : "";
    const mark = markName ? this.pm.state.schema.marks[markName] : null;
    if (!mark) return;
    toggleMark(mark)(this.pm.state, this.pm.dispatch.bind(this.pm));
    this.refresh();
  }

  /** Obsidian's native checklist commands call this Editor method directly. */
  toggleCheckList(cycle = false): void {
    if (!this.pm.editable) return;
    this.toggleChecklist?.(cycle);
    this.refresh();
  }

  /** Host commands use this probe to avoid list actions inside table cells. */
  get inTableCell(): boolean {
    const { $from } = this.pm.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const role = ($from.node(depth).type.spec as { tableRole?: string }).tableRole;
      if (role === "cell" || role === "header_cell") return true;
    }
    return false;
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    this.readSource();
    const fromOff = this.lineChToPos(from);
    const toOff = this.lineChToPos(to);
    return this.lineMap.text.slice(fromOff, toOff);
  }

  replaceRange(
    replacement: string,
    from: EditorPosition,
    to?: EditorPosition,
  ): void {
    if (!this.pm.editable) return;
    this.readSource();
    const end = to ?? from;
    this.applySourceRange(replacement, this.lineChToPos(from), this.lineChToPos(end));
  }

  replaceSelection(replacement: string): void {
    if (!this.pm.editable) return;
    const from = this.getCursor("from"), to = this.getCursor("to");
    this.replaceRange(replacement, from, to);
  }

  getDoc(): PMEditorShim {
    return this;
  }

  focus(): void {
    this.pm.focus();
  }

  blur(): void {
    (this.pm.dom).blur();
  }

  hasFocus(): boolean {
    return this.pm.hasFocus();
  }

  posToOffset(p: EditorPosition): number {
    this.readSource();
    return this.lineChToPos(p);
  }

  offsetToPos(offset: number): EditorPosition {
    this.readSource();
    if (!Number.isFinite(offset)) throw new Error("Butter plugin edit: invalid source offset");
    return this.posToLineCh(offset);
  }
}
