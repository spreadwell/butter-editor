/**
 * Tab and Enter in ordinary paragraphs.
 *
 * Lists and tables own Tab and Enter inside their own blocks. Everything here
 * declines there, so it is safe to register ahead of their keymaps.
 */
import type { Command, EditorState } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";

const TAB = "\t";

/** The caret or selection sits in one textblock of this kind that no list or
 * table owns. */
function selectionInFree(state: EditorState, kind: string): boolean {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return false;
  const { $from, $to } = selection;
  if (!$from.sameParent($to) || $from.parent.type.name !== kind) return false;
  for (let depth = $from.depth - 1; depth > 0; depth--) {
    const type = $from.node(depth).type;
    if (type.name === "list_item" || type.spec.tableRole) return false;
  }
  return true;
}

export const selectionInFreeParagraph = (state: EditorState): boolean =>
  selectionInFree(state, "paragraph");

/** Tab types a tab character. Without a handler the browser moves focus to
 * the next control outside the note. A heading keeps the caret but takes no
 * tab: Markdown drops whitespace at the start of a heading. */
export const insertTabInParagraph: Command = (state, dispatch) => {
  if (selectionInFree(state, "heading")) return true;
  if (!selectionInFreeParagraph(state)) return false;
  if (dispatch) dispatch(state.tr.insertText(TAB).scrollIntoView());
  return true;
};

/** Shift+Tab takes back one tab: the one before the caret, else the one that
 * starts the paragraph. It never leaves the note. */
export const removeTabInParagraph: Command = (state, dispatch) => {
  if (selectionInFree(state, "heading")) return true;
  if (!selectionInFreeParagraph(state)) return false;
  const { $from, empty } = state.selection;
  const start = $from.start();
  const before = empty && $from.parentOffset > 0
    ? state.doc.textBetween($from.pos - 1, $from.pos, "", "￼") : "";
  const at = before === TAB ? $from.pos - 1
    : $from.parent.firstChild?.isText && $from.parent.firstChild.text?.startsWith(TAB) ? start : null;
  if (at !== null && dispatch) dispatch(state.tr.delete(at, at + 1).scrollIntoView());
  return true;
};

/** With "Enter makes a new line" on, Enter breaks the line here. An empty
 * paragraph and the very start of one keep the ordinary Enter, so a new
 * paragraph can still be opened above or below. */
export function enterBreaksLineHere(state: EditorState): boolean {
  if (!selectionInFreeParagraph(state)) return false;
  const { $from, empty } = state.selection;
  if ($from.parent.content.size === 0) return false;
  return !(empty && $from.parentOffset === 0);
}

/** The caret sits right after a line break: a second Enter turns that break
 * into a paragraph boundary, as a blank line does in Markdown. */
export function caretAfterLineBreak(state: EditorState): boolean {
  const { $from, empty } = state.selection;
  return empty && $from.nodeBefore?.type.name === "hard_break";
}
