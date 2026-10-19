import type { Command } from "prosemirror-state";
import { allowsInlineMark } from "../core/inline-mark-policy";

/** Recolor a selection; a selection wholly in that color toggles it off. */
export function toggleNativeHighlight(color: string): Command {
  return (state, dispatch) => {
    const type = state.schema.marks.highlight;
    const { from, to, empty, $from } = state.selection;
    if (!type || empty && !$from.parent.type.allowsMarkType(type)) return false;
    const mark = type.create({ color });
    let eligible = empty, allMarked = true;
    if (empty) allMarked = !!mark.isInSet(state.storedMarks ?? $from.marks());
    else state.doc.nodesBetween(from, to, (node, _pos, parent) => {
      if (node.isInline && parent?.type.allowsMarkType(type) && allowsInlineMark(node, mark)) {
        eligible = true;
        if (!mark.isInSet(node.marks)) allMarked = false;
      }
    });
    if (!eligible) return false;
    if (dispatch) {
      const tr = state.tr;
      if (empty) {
        const marks = (state.storedMarks ?? $from.marks()).filter(mark => mark.type !== type);
        tr.setStoredMarks(allMarked ? marks : [...marks, mark]);
      } else {
        tr.removeMark(from, to, type);
        if (!allMarked) tr.addMark(from, to, mark);
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
