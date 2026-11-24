import type { MarkType, Node as PMNode } from "prosemirror-model";
import { Plugin, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

function isCommentOnlyParagraph(node: PMNode, commentMark: MarkType): boolean {
  if (node.type.name !== "paragraph" || node.childCount === 0) return false;

  // A paragraph of only spaces or tabs holds no comment. Hiding it would take
  // the caret's own line away while the user is typing in it.
  let hasComment = false;
  let hasVisibleContent = false;
  node.forEach((child) => {
    if (child.marks.some((mark) => mark.type === commentMark)) {
      hasComment = true;
      return;
    }
    if (child.isText && !child.text?.trim()) return;
    hasVisibleContent = true;
  });

  return hasComment && !hasVisibleContent;
}

function buildCommentOnlyParagraphDecorations(state: EditorState): DecorationSet {
  const commentMark = state.schema.marks.comment;
  if (!commentMark) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  state.doc.forEach((node, pos) => {
    if (isCommentOnlyParagraph(node, commentMark)) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: "butter-comment-only",
        }),
      );
    }
  });

  return DecorationSet.create(state.doc, decorations);
}

export function commentOnlyParagraphPlugin(): Plugin {
  return new Plugin({
    state: {
      init: (_, state) => buildCommentOnlyParagraphDecorations(state),
      apply: (tr, previous, _, state) =>
        tr.docChanged ? buildCommentOnlyParagraphDecorations(state) : previous,
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
