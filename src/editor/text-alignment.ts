import type { Node as PMNode } from "prosemirror-model";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { textAlignment, type TextAlignment } from "../core/text-alignment";

/** Collect complete paragraphs without splitting or rebuilding their content.
 * A selection ending at the next paragraph's start does not style that next
 * paragraph. Decorating a native heading changes its reference target, so
 * headings, code, tables and opaque source islands keep their own owners. */
export function textAlignmentTargets(state: EditorState, selectedBlocks: readonly number[] = []): Array<{ pos: number; node: PMNode }> {
  const targets = new Map<number, PMNode>();
  const collect = (node: PMNode, pos: number): boolean => {
    if (node.type.name === "paragraph") {
      targets.set(pos, node);
      return false;
    }
    return !node.isTextblock && !node.isAtom;
  };
  if (selectedBlocks.length) {
    for (const pos of new Set(selectedBlocks)) {
      if (!Number.isInteger(pos) || pos < 0 || pos >= state.doc.content.size || state.doc.resolve(pos).depth !== 0) return [];
      const node = state.doc.nodeAt(pos);
      if (!node) return [];
      if (collect(node, pos)) node.descendants((child, offset) => collect(child, pos + 1 + offset));
    }
  } else {
    const { from, to, $from, $to, empty } = state.selection;
    if (empty) {
      if ($from.depth && $from.parent.type.name === "paragraph") collect($from.parent, $from.before());
    } else {
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (state.selection instanceof TextSelection && $to.parentOffset === 0 &&
            $to.depth && pos === $to.before() && pos !== ($from.depth ? $from.before() : -1)) return false;
        return collect(node, pos);
      });
    }
  }
  return [...targets].map(([pos, node]) => ({ pos, node })).sort((left, right) => left.pos - right.pos);
}

export function selectedTextAlignment(state: EditorState, selectedBlocks: readonly number[] = []): TextAlignment | "mixed" | null {
  const targets = textAlignmentTargets(state, selectedBlocks);
  if (!targets.length) return null;
  const alignment = textAlignment(targets[0].node.attrs.textAlign) ?? "left";
  return targets.every(({ node }) => (textAlignment(node.attrs.textAlign) ?? "left") === alignment) ? alignment : "mixed";
}

export function setTextAlignment(alignment: TextAlignment | null, selectedBlocks: readonly number[] = []): Command {
  return (state, dispatch, view) => {
    if (alignment !== null && !textAlignment(alignment)) return false;
    if (view && (!view.editable || view.state !== state || view.isDestroyed)) return false;
    const targets = textAlignmentTargets(state, selectedBlocks);
    if (!targets.length) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const explicitAlignment = alignment === "left" ? null : alignment;
    for (const { pos, node } of targets) {
      if (node.attrs.textAlign === explicitAlignment) continue;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: explicitAlignment }, node.marks);
    }
    if (!tr.docChanged) return true;
    if (state.storedMarks) tr.setStoredMarks(state.storedMarks);
    dispatch(closeHistory(tr).setMeta("butter-text-alignment", true).scrollIntoView());
    return true;
  };
}
