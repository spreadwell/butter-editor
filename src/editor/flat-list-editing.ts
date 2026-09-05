import { Fragment, type Node as PMNode } from "prosemirror-model";
import {
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { flatListLayoutFor } from "../core/list-layout";

export type FlatListKind = "bullet" | "ordered" | "task";

/**
 * Join a newly converted ordered item to the ordered run immediately after it.
 *
 * The parser deliberately stores `start: 1` on the first item of an authored
 * numbered run. When a bullet/paragraph immediately before that run becomes
 * numbered, the old anchor is no longer first and must become a continuation;
 * otherwise both items render as 1. Non-default starts remain deliberate
 * restarts and are never rewritten.
 */
export function joinOrderedRunsAfterConversion(
  tr: Transaction,
  convertedPositions: readonly number[],
): void {
  const visited = new Set<string>();
  for (const originalPos of convertedPositions) {
    const mappedPos = tr.mapping.map(originalPos, -1);
    const $pos = tr.doc.resolve(mappedPos);
    const parent = $pos.parent;
    const index = $pos.index();
    const converted = parent.child(index);
    if (
      converted?.type.name !== "list_item" ||
      converted.attrs.kind !== "ordered"
    ) continue;

    const layout = flatListLayoutFor(parent);
    const convertedLayout = layout[index];
    if (!convertedLayout) continue;
    const depth = convertedLayout.effectiveDepth;
    const parentStart = $pos.start();
    let siblingPos = parentStart;
    for (let i = 0; i < parent.childCount; i++) {
      const sibling = parent.child(i);
      if (i <= index) {
        siblingPos += sibling.nodeSize;
        continue;
      }
      if (sibling.type.name !== "list_item") break;
      const siblingLayout = layout[i];
      if (!siblingLayout) break;
      if (siblingLayout.effectiveDepth > depth) {
        siblingPos += sibling.nodeSize;
        continue;
      }
      if (siblingLayout.effectiveDepth < depth) break;
      if (sibling.attrs.kind !== "ordered") break;
      if (sibling.attrs.start == null) {
        siblingPos += sibling.nodeSize;
        continue;
      }
      if (sibling.attrs.start === 1) {
        const key = `${siblingPos}`;
        if (!visited.has(key)) {
          visited.add(key);
          tr.setNodeMarkup(siblingPos, undefined, {
            ...sibling.attrs,
            start: null,
            sourceRange: null,
          });
        }
      }
      break;
    }
  }
}

/** Apply one list kind to an explicit multi-block list selection. */
export function setFlatListKindAtPositions(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  positions: readonly number[],
  kind: FlatListKind,
): boolean {
  const items = positions
    .map((pos) => ({ pos, node: state.doc.nodeAt(pos) }))
    .filter((item): item is { pos: number; node: PMNode } =>
      item.node?.type.name === "list_item"
    );
  if (items.length === 0) return false;
  const converted = items.filter(({ node }) => node.attrs.kind !== kind);
  if (converted.length === 0) return false;
  if (!dispatch) return true;

  const tr = state.tr;
  for (let i = converted.length - 1; i >= 0; i--) {
    const { pos, node } = converted[i];
    const attrs = node.attrs as Record<string, unknown>;
    tr.setNodeMarkup(pos, undefined, {
      ...attrs,
      kind,
      checked: kind === "task" ? false : null,
      start: kind === "ordered" ? attrs.start : null,
      sourceRange: null,
    });
  }
  if (kind === "ordered") {
    joinOrderedRunsAfterConversion(tr, converted.map(({ pos }) => pos));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

interface CurrentListItem {
  depth: number;
  pos: number;
  node: PMNode;
  parent: PMNode;
  index: number;
}

function currentListItem(state: EditorState): CurrentListItem | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "list_item") continue;
    return {
      depth,
      pos: $from.before(depth),
      node,
      parent: $from.node(depth - 1),
      index: $from.index(depth - 1),
    };
  }
  return null;
}

/** Remove one flat list item's marker without leaving its descendants at an
 * orphan depth. Former children move left one level and the item's editable
 * blocks take its place in the same container. */
function removeCurrentListFormatting(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  current: CurrentListItem,
): boolean {
  if (!dispatch) return true;
  const { $from } = state.selection;
  const marks = state.storedMarks ?? $from.marks();
  const ownDepth = Number(current.node.attrs.depth) || 0;
  const descendantPositions: Array<{
    pos: number;
    attrs: Record<string, unknown>;
  }> = [];
  let siblingPos = current.pos + current.node.nodeSize;
  for (let index = current.index + 1; index < current.parent.childCount; index++) {
    const sibling = current.parent.child(index);
    if (sibling.type.name !== "list_item") break;
    const siblingDepth = Number(sibling.attrs.depth) || 0;
    if (siblingDepth <= ownDepth) break;
    descendantPositions.push({
      pos: siblingPos,
      attrs: {
        ...sibling.attrs,
        depth: siblingDepth - 1,
        sourceRange: null,
      },
    });
    siblingPos += sibling.nodeSize;
  }

  const replacement: PMNode[] = [];
  current.node.forEach((child) => replacement.push(child));
  const first = replacement[0];
  const selection = state.selection;
  const preserveTextSelection =
    selection instanceof TextSelection &&
    selection.$anchor.sameParent(selection.$head) &&
    selection.$anchor.depth === current.depth + 1 &&
    selection.$anchor.parent === first;
  const anchorOffset = preserveTextSelection ? selection.$anchor.parentOffset : 0;
  const headOffset = preserveTextSelection ? selection.$head.parentOffset : anchorOffset;
  const tr = state.tr.replaceWith(
    current.pos,
    current.pos + current.node.nodeSize,
    Fragment.fromArray(replacement),
  );
  for (const descendant of descendantPositions) {
    const mapped = tr.mapping.map(descendant.pos);
    const mappedNode = tr.doc.nodeAt(mapped);
    if (mappedNode?.type.name === "list_item") {
      tr.setNodeMarkup(mapped, undefined, descendant.attrs);
    }
  }
  if (first?.type.inlineContent) {
    const start = current.pos + 1;
    tr.setSelection(
      TextSelection.create(
        tr.doc,
        start + Math.min(anchorOffset, first.content.size),
        start + Math.min(headOffset, first.content.size),
      ),
    );
  }
  tr.setStoredMarks(marks);
  dispatch(tr.scrollIntoView());
  return true;
}

/** Conventional toolbar list toggle: preserve the current text while adding,
 * changing, or removing exactly one flat-list marker. */
export function toggleFlatListKind(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  kind: FlatListKind,
): boolean {
  const current = currentListItem(state);
  if (current) {
    if (current.node.attrs.kind === kind) {
      return removeCurrentListFormatting(state, dispatch, current);
    }
    if (!dispatch) return true;
    const currentAttrs = current.node.attrs as Record<string, unknown>;
    const tr = state.tr.setNodeMarkup(current.pos, undefined, {
        ...currentAttrs,
        kind,
        checked: kind === "task" ? false : null,
        start: kind === "ordered" ? currentAttrs.start : null,
        sourceRange: null,
      });
    if (kind === "ordered") joinOrderedRunsAfterConversion(tr, [current.pos]);
    dispatch(tr.scrollIntoView());
    return true;
  }

  const { $from } = state.selection;
  if (!$from.parent.type.inlineContent || $from.parent.type.name === "code_block") {
    return false;
  }
  const blockDepth = $from.depth;
  if (blockDepth <= 0) return false;
  const block = $from.node(blockDepth);
  const listItem = state.schema.nodes.list_item;
  const paragraph = state.schema.nodes.paragraph;
  if (!listItem || !paragraph) return false;
  const content = paragraph.create(
    { ...block.attrs, sourceRange: null },
    block.content,
  );
  const item = listItem.create(
    {
      kind,
      depth: 0,
      tight: true,
      checked: kind === "task" ? false : null,
      start: null,
      sourceRange: null,
    },
    content,
  );
  if (!dispatch) return true;
  const blockPos = $from.before(blockDepth);
  const selection = state.selection;
  const preserveTextSelection =
    selection instanceof TextSelection &&
    selection.$anchor.sameParent(selection.$head);
  const anchorOffset = preserveTextSelection ? selection.$anchor.parentOffset : $from.parentOffset;
  const headOffset = preserveTextSelection ? selection.$head.parentOffset : anchorOffset;
  const tr = state.tr.replaceWith(blockPos, blockPos + block.nodeSize, item);
  tr.setSelection(
    TextSelection.create(
      tr.doc,
      blockPos + 2 + Math.min(anchorOffset, content.content.size),
      blockPos + 2 + Math.min(headOffset, content.content.size),
    ),
  );
  dispatch(tr.scrollIntoView());
  return true;
}

/** At the start of a list item, Backspace first outdents a nested item and
 * then removes a top-level marker. Elsewhere it declines ownership so the
 * ordinary ProseMirror deletion chain remains authoritative. */
export const backspaceAtStartOfFlatListItem: Command = (state, dispatch) => {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const current = currentListItem(state);
  if (!current) return false;
  const { $from } = selection;
  if ($from.depth !== current.depth + 1 || $from.parentOffset !== 0) return false;
  const depth = Number(current.node.attrs.depth) || 0;
  if (depth > 0) {
    if (!dispatch) return true;
    dispatch(
      state.tr.setNodeMarkup(current.pos, undefined, {
        ...current.node.attrs,
        depth: depth - 1,
        sourceRange: null,
      }).scrollIntoView(),
    );
    return true;
  }
  return removeCurrentListFormatting(state, dispatch, current);
};
