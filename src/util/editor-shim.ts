/**
 * Editor shim - exposes a ProseMirror editor view as an Obsidian
 * `Editor` so plugins that use the EditorSuggest system (natural-
 * language dates, file/tag/heading suggestions, custom completions)
 * can operate against our view.
 *
 * The shim translates Obsidian's line/ch coordinates to PM positions
 * by serializing the current document to markdown, then maps back on
 * replaceRange. Round-trip accuracy is good enough for suggest-style
 * integrations (local inserts/replacements), not arbitrary tool use.
 */
import type { EditorView } from "prosemirror-view";
import { Selection } from "prosemirror-state";
import type { Serializer } from "../core/serializer-types";

export interface EditorPosition {
  line: number;
  ch: number;
}

interface LineMap {
  text: string;
  lines: string[];
  /** Cumulative markdown offsets at start of each line (length = lines.length + 1). */
  lineStarts: number[];
}

function buildLineMap(text: string): LineMap {
  const lines = text.split("\n");
  const lineStarts: number[] = [0];
  let offset = 0;
  for (const line of lines) {
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

  constructor(
    private pm: EditorView,
    private serialize: Serializer,
    private fallbackReplace?: (newMarkdown: string) => void,
  ) {
    this.lineMap = buildLineMap(this.currentMarkdown());
  }

  /** Recompute when the PM doc changes. */
  refresh() {
    this.lineMap = buildLineMap(this.currentMarkdown());
  }

  private currentMarkdown(): string {
    try {
      return this.serialize(this.pm.state.doc);
    } catch {
      return "";
    }
  }

  // ── Position translation ──

  private posToLineCh(offset: number): EditorPosition {
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
    const { lineStarts, lines } = this.lineMap;
    const line = Math.max(0, Math.min(p.line, lines.length - 1));
    const ch = Math.max(0, Math.min(p.ch, lines[line].length));
    return lineStarts[line] + ch;
  }

  // ── PM selection → markdown offset ──

  private pmSelectionToOffset(): number {
    // The mapping between PM positions and markdown offsets is not
    // 1:1. We approximate by serializing the doc up to the selection
    // by slicing the PM doc and running serialize on the slice.
    // For the typical EditorSuggest use case (tracking the cursor on
    // a fresh input) this is accurate enough.
    const { head } = this.pm.state.selection;
    try {
      const slice = this.pm.state.doc.cut(0, head);
      const md = this.serialize(slice);
      return md.length;
    } catch {
      return 0;
    }
  }

  // ── Public API (subset of Obsidian Editor) ──

  getValue(): string {
    return this.lineMap.text;
  }

  setValue(_: string): void {
    // Intentionally no-op: plugins shouldn't overwrite the whole doc.
  }

  getLine(n: number): string {
    return this.lineMap.lines[n] ?? "";
  }

  lineCount(): number {
    return this.lineMap.lines.length;
  }

  lastLine(): number {
    return this.lineMap.lines.length - 1;
  }

  getCursor(_string?: string): EditorPosition {
    this.refresh();
    return this.posToLineCh(this.pmSelectionToOffset());
  }

  getClickableTokenAt(_pos: EditorPosition): unknown {
    return null;
  }

  setCursor(pos: EditorPosition | number): void {
    const off =
      typeof pos === "number" ? pos : this.lineChToPos(pos);
    // Find a PM position near `off`. This is approximate - use it
    // sparingly. We anchor by placing the caret at the end of the
    // matching text on the relevant line.
    const targetLine = typeof pos === "number"
      ? this.posToLineCh(off).line
      : pos.line;
    const pmPos = this.findPMPosForLine(targetLine, typeof pos === "number" ? off - this.lineMap.lineStarts[targetLine] : pos.ch);
    if (pmPos < 0) return;
    const sel = Selection.near(this.pm.state.doc.resolve(pmPos));
    this.pm.dispatch(this.pm.state.tr.setSelection(sel));
  }

  getSelection(): string {
    const { from, to } = this.pm.state.selection;
    return this.pm.state.doc.textBetween(from, to, "\n");
  }

  somethingSelected(): boolean {
    return !this.pm.state.selection.empty;
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    const fromOff = this.lineChToPos(from);
    const toOff = this.lineChToPos(to);
    return this.lineMap.text.slice(fromOff, toOff);
  }

  replaceRange(
    replacement: string,
    from: EditorPosition,
    to?: EditorPosition,
  ): void {
    const end = to ?? from;
    const pmFrom = this.findPMPosForLine(from.line, from.ch);
    const pmTo = this.findPMPosForLine(end.line, end.ch);
    if (pmFrom < 0 || pmTo < 0) {
      if (this.fallbackReplace) {
        const fromOff = this.lineChToPos(from);
        const toOff = this.lineChToPos(end);
        const newText = this.lineMap.text.slice(0, fromOff) + replacement + this.lineMap.text.slice(toOff);
        this.fallbackReplace(newText);
        this.refresh();
      }
      return;
    }
    this.pm.dispatch(
      this.pm.state.tr.insertText(replacement, pmFrom, pmTo),
    );
    this.refresh();
  }

  replaceSelection(replacement: string): void {
    this.pm.dispatch(this.pm.state.tr.insertText(replacement));
    this.refresh();
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
    return this.lineChToPos(p);
  }

  offsetToPos(offset: number): EditorPosition {
    return this.posToLineCh(offset);
  }

  // ── Internal: rough line-to-PM-pos mapping ──

  /**
   * For the given markdown line + column, find a PM doc position whose
   * text content corresponds. Works for paragraph / heading / list
   * content; for structured nodes it snaps to the nearest text node.
   */
  private findPMPosForLine(line: number, ch: number): number {
    const { doc } = this.pm.state;
    const lineText = this.lineMap.lines[line] ?? "";
    const prefix = lineText.slice(0, ch);

    let best = -1;
    let bestDistance = Infinity;

    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      const blockText = node.textContent;
      if (!blockText && !prefix) {
        // Empty block matches empty-prefix searches
        if (line === 0 && best < 0) best = pos + 1;
        return true;
      }
      const idx = blockText.indexOf(prefix);
      if (idx >= 0) {
        const candidate = pos + 1 + idx + prefix.length;
        const distance = Math.abs(line - this.estimateLineFromPos(pos));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      return false;
    });

    return best;
  }

  private estimateLineFromPos(pos: number): number {
    // Rough: count how many block boundaries precede this pos.
    let line = 0;
    this.pm.state.doc.descendants((node, p) => {
      if (p >= pos) return false;
      if (node.isBlock && node.isTextblock) line++;
      return true;
    });
    return line;
  }
}
