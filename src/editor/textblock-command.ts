import { Fragment, type Attrs, type Node as PMNode, type NodeType } from "prosemirror-model";
import { Selection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { projectLiteralCodeContent } from "./code-literal-projection";
import { allowsDeclaredCodeTransaction, notifyCodeConversionRefusal } from "./structural-save-admission";

/** Textblock conversion keeps exact inline nodes, marks and opaque controls.
 * ProseMirror's generic setBlockType clears literal LF from text before its
 * transaction reaches admission, so it cannot express this product intent. */
export function createTextblockWithExactInline(type: NodeType, attrs: Attrs, content: Fragment): PMNode {
  if (!type.validContent(content)) throw new RangeError("Textblock cannot retain this inline content");
  return type.create(attrs, content);
}

/** Apply textblock shape to an existing transaction (input/slash prefix removal
 * included) without clearing or rebuilding any inline payload. */
export function setExactTextblockTypeInTransaction(
  tr: Transaction, type: NodeType, attrs: Attrs,
): Transaction | null {
  const { from, to } = tr.selection;
  const targets: Array<{ pos: number; node: PMNode; leadingPos: number | null }> = [];
  const originalSelection = tr.selection;
  let eligible = false, supported = true;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return;
    eligible = true;
    if (!type.validContent(node.content)) { supported = false; return false; }
    const resolved = tr.doc.resolve(pos);
    const index = resolved.index();
    if (!resolved.parent.canReplaceWith(index, index + 1, type)) { supported = false; return false; }
    if (node.hasMarkup(type, attrs)) return false;
    // A block-first list item requires a leading paragraph. Returning its
    // code to prose consumes that empty carrier in the same edit, including
    // the task's source-backed checkbox paragraph, so no empty prose remains.
    const leading = resolved.parent.firstChild;
    const leadingPos = type.name === "paragraph" && node.type.name === "code_block" &&
      resolved.parent.type.name === "list_item" && index === 1 &&
      leading?.type.name === "paragraph" && leading.content.size === 0
      ? pos - leading.nodeSize : null;
    targets.push({ pos, node, leadingPos });
    return false;
  });
  if (!eligible || !supported) return null;
  for (let index = targets.length - 1; index >= 0; index--) {
    const { pos, node, leadingPos } = targets[index];
    const heading = createTextblockWithExactInline(type,
      { ...node.attrs, ...attrs, sourceRange: null }, node.content);
    if (leadingPos !== null) {
      tr.replaceWith(leadingPos, pos + node.nodeSize, heading);
      if (targets.length === 1 && originalSelection.empty && originalSelection.$from.parent === node) {
        tr.setSelection(Selection.near(tr.doc.resolve(leadingPos + 1 +
          Math.min(originalSelection.$from.parentOffset, heading.content.size))));
      }
    } else tr.setNodeMarkup(pos, heading.type, heading.attrs, node.marks);
  }
  return tr;
}

/** A code-return route must conserve the declared literal bytes before
 * normalization, as well as passing the final prepared save check. */
export function allowsExactTextblockTransaction(state: EditorState, tr: Transaction, notify = true): boolean {
  let convertsCode = false, opaqueCarriageReturn = false;
  state.doc.nodesBetween(state.selection.from, state.selection.to, node => {
    if (node.type.name === "code_block") {
      convertsCode = true;
      if (node.textContent.includes("\r")) opaqueCarriageReturn = true;
    }
  });
  if (opaqueCarriageReturn) {
    if (notify) notifyCodeConversionRefusal(state);
    return false;
  }
  return !convertsCode || allowsDeclaredCodeTransaction(state, tr, notify);
}

/** Shared exact-inline command for headings and return-to-paragraph routes. */
export function setExactTextblockType(type: NodeType, attrs: Attrs = {}): Command {
  return (state, dispatch) => {
    const tr = setExactTextblockTypeInTransaction(state.tr, type, attrs);
    if (!tr) return false;
    if (!allowsExactTextblockTransaction(state, tr, Boolean(dispatch))) return true;
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

export const createHeadingWithExactInline = createTextblockWithExactInline;
export const setHeadingBlockTypeInTransaction = setExactTextblockTypeInTransaction;
export const setHeadingBlockType = setExactTextblockType;
export const setParagraphBlockType = setExactTextblockType;

/** Code is an explicit literal projection. Keep native block metadata in
 * ordered detached paragraphs after the code, where native caches attach it
 * to that block. Reject a container that cannot retain this exact shape. */
export function setLiteralCodeBlockInTransaction(
  tr: Transaction, type: NodeType, attrs: Attrs = {},
): Transaction | null {
  const { from, to } = tr.selection;
  const targets: Array<{ pos: number; node: PMNode; replacement: Fragment; codeOffset: number }> = [];
  let supported = true;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return;
    const inline: PMNode[] = [], ids: PMNode[] = [];
    node.forEach(child => { (child.type.name === "block_id" ? ids : inline).push(child); });
    const content = projectLiteralCodeContent(Fragment.fromArray(inline));
    if (!content) { supported = false; return false; }
    const code = type.create({ ...node.attrs, ...attrs, sourceRange: null }, content);
    let replacement = Fragment.fromArray([code,
      ...ids.map(id => type.schema.nodes.paragraph.create(null, id))]);
    const resolved = tr.doc.resolve(pos), index = resolved.index();
    let codeOffset = 0;
    if (resolved.parent.type.name === "list_item" && index === 0 && node.type.name === "paragraph") {
      // Existing authored block-first list parsing uses this same required
      // empty leading paragraph. It carries the list marker/checkbox while
      // the code retains the original body identity and native ID order.
      const leading = type.schema.nodes.paragraph.create();
      replacement = Fragment.from(leading).append(replacement);
      codeOffset = leading.nodeSize;
    }
    if (!resolved.parent.canReplace(index, index + 1, replacement)) supported = false;
    targets.push({ pos, node, replacement, codeOffset });
    return false;
  });
  if (!supported || !targets.length) return null;
  for (let index = targets.length - 1; index >= 0; index--) {
    const { pos, node, replacement } = targets[index];
    tr.replaceWith(pos, pos + node.nodeSize, replacement);
  }
  tr.setSelection(Selection.near(tr.doc.resolve(targets[0].pos + targets[0].codeOffset + 1)));
  return tr;
}

/** One accepted history event, or a visible atomic refusal. The current save
 * policy and native reference plan certify the final prepared document. */
export function setLiteralCodeBlock(type: NodeType, attrs: Attrs = {}): Command {
  return (state, dispatch) => {
    const tr = setLiteralCodeBlockInTransaction(state.tr, type, attrs);
    if (!tr) {
      if (dispatch) notifyCodeConversionRefusal(state);
      return true;
    }
    if (!allowsDeclaredCodeTransaction(state, tr, Boolean(dispatch))) return true;
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}
