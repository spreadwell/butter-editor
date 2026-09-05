import { toggleMark } from "prosemirror-commands";
import type { Schema } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { tx } from "../i18n";

/** Apply a Markdown link to the selection or insert a selected placeholder. */
export function insertMarkdownLink(view: EditorView, schema: Schema): void {
  const markType = schema.marks.link;
  if (!markType) return;
  const { selection, tr } = view.state;
  if (!selection.empty) {
    if (
      toggleMark(markType, { href: "https://" })(
        view.state,
        view.dispatch.bind(view),
      )
    ) {
      view.focus();
    }
    return;
  }

  const placeholder = tx("link text");
  const linkMark = markType.create({ href: "https://" });
  const textNode = schema.text(placeholder, [linkMark]);
  const insertPos = selection.from;
  const inserted = tr.replaceSelectionWith(textNode, false);
  inserted.setSelection(
    TextSelection.create(inserted.doc, insertPos, insertPos + placeholder.length),
  );
  view.dispatch(inserted);
  view.focus();
}

/** Remove styling marks while preserving semantic links and block shape. */
export function clearFormatting(view: EditorView, schema: Schema): void {
  const { from, to, empty } = view.state.selection;
  const tr = view.state.tr;
  if (empty) {
    tr.setStoredMarks([]);
  } else {
    for (const name of Object.keys(schema.marks)) {
      if (name === "link") continue;
      tr.removeMark(from, to, schema.marks[name]);
    }
  }
  view.dispatch(tr);
}
