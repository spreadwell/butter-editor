import type { Command } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";

/** Exit a callout when Enter is pressed on its trailing empty paragraph.
 *
 * The first Enter after body text creates this empty paragraph through the
 * ordinary split command. The second Enter removes it, keeps the callout
 * (title-only when it had no other body), and creates a root paragraph after
 * the callout. This mirrors the familiar blockquote exit gesture without
 * allowing a non-terminal or nested empty block to escape accidentally. */
export const exitCalloutFromTrailingEmptyParagraph: Command = (
  state,
  dispatch,
) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  if (
    $from.parent.type.name !== "paragraph" ||
    $from.parent.content.size !== 0 ||
    $from.parentOffset !== 0 ||
    $from.depth < 2
  ) {
    return false;
  }

  const calloutDepth = $from.depth - 1;
  const callout = $from.node(calloutDepth);
  if (callout.type.name !== "obsidian_callout") return false;
  if ($from.index(calloutDepth) !== callout.childCount - 1) return false;
  if (!dispatch) return true;

  const calloutPos = $from.before(calloutDepth);
  const originalCalloutEnd = calloutPos + callout.nodeSize;
  const emptyFrom = $from.before($from.depth);
  const emptyTo = $from.after($from.depth);
  const paragraph = state.schema.nodes.paragraph.create();
  const continuationMarks = state.storedMarks ?? $from.marks();

  const tr = state.tr.delete(emptyFrom, emptyTo);
  tr.setNodeMarkup(calloutPos, undefined, {
    ...callout.attrs,
    sourceRange: null,
  });
  const insertPos = tr.mapping.map(originalCalloutEnd, -1);
  tr.insert(insertPos, paragraph);
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
  tr.setStoredMarks(continuationMarks);
  dispatch(tr.scrollIntoView());
  return true;
};
