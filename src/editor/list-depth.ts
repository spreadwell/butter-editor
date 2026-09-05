import type { EditorState, Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";

export const LIST_DEPTH_MULTI_SELECTION_META =
  "butter-list-depth-multi-selection";

/** Return a flat list item's complete descendant run. */
export function computeListSubtree(
  state: EditorState,
  blockPos: number,
): number[] {
  const node = state.doc.nodeAt(blockPos);
  if (!node || node.type.name !== "list_item") return [blockPos];
  const sourceDepth = node.attrs.depth as number;
  const positions: number[] = [blockPos];
  let cursor = blockPos + node.nodeSize;
  while (cursor < state.doc.content.size) {
    const next = state.doc.nodeAt(cursor);
    if (!next || next.type.name !== "list_item") break;
    if ((next.attrs.depth as number) <= sourceDepth) break;
    positions.push(cursor);
    cursor += next.nodeSize;
  }
  return positions;
}

/** Expand explicit list-item selections to complete flat-list subtrees. */
export function listItemsWithSelectedSubtrees(
  state: EditorState,
  positions: readonly number[],
): { pos: number; node: PMNode }[] {
  const expanded = new Set<number>();
  for (const pos of positions) {
    const node = state.doc.nodeAt(pos);
    if (node?.type.name !== "list_item") continue;
    for (const subtreePos of computeListSubtree(state, pos)) {
      expanded.add(subtreePos);
    }
  }
  const items: { pos: number; node: PMNode }[] = [];
  for (const pos of [...expanded].sort((a, b) => a - b)) {
    const node = state.doc.nodeAt(pos);
    if (node?.type.name === "list_item") items.push({ pos, node });
  }
  return items;
}

/** Shift selected list subtrees in one transaction. Each parent and its
 * descendants retain their relative depths, including inside containers. */
export function shiftListItemDepths(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  positions: readonly number[],
  delta: 1 | -1,
  convertSingleRootOnOutdent: boolean,
  preserveMultiSelection = false,
): boolean {
  const items = listItemsWithSelectedSubtrees(state, positions);
  if (items.length === 0) return false;
  const tr = state.tr;
  let modified = false;
  const postDepth = new Map<number, number>();

  for (const item of items) {
    const $pos = state.doc.resolve(item.pos);
    const parent = $pos.parent;
    const index = $pos.index();
    const current = item.node.attrs.depth as number;

    if (delta === 1) {
      let previousDepth = -1;
      if (index > 0) {
        const previous = parent.child(index - 1);
        if (previous.type.name === "list_item") {
          const previousPos = item.pos - previous.nodeSize;
          previousDepth = postDepth.get(previousPos) ?? (previous.attrs.depth as number);
        }
      }
      if (previousDepth < 0) continue;
      const target = Math.min(current + 1, previousDepth + 1);
      if (target === current) continue;
      postDepth.set(item.pos, target);
      tr.setNodeMarkup(item.pos, undefined, {
        ...item.node.attrs,
        depth: target,
        sourceRange: null,
      });
      modified = true;
      continue;
    }

    const target = Math.max(0, current - 1);
    if (target === current) {
      if (convertSingleRootOnOutdent && items.length === 1) {
        const replacement: PMNode[] = [];
        item.node.forEach((child) => replacement.push(child));
        if (replacement.length > 0) {
          tr.replaceWith(item.pos, item.pos + item.node.nodeSize, replacement);
          modified = true;
        }
      }
      continue;
    }
    postDepth.set(item.pos, target);
    tr.setNodeMarkup(item.pos, undefined, {
      ...item.node.attrs,
      depth: target,
      sourceRange: null,
    });
    modified = true;
  }

  if (!modified) return false;
  if (preserveMultiSelection) {
    tr.setMeta(LIST_DEPTH_MULTI_SELECTION_META, [...positions]);
  }
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}
