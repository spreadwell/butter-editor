import type { EditorState, Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { StepMap } from "prosemirror-transform";

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

/** Text ranges move each selected subtree as a unit. Root outdent removes
 * the selected marker, while its descendants move up exactly one level. */
export function shiftTextSelectedListItemDepths(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  positions: readonly number[],
  delta: 1 | -1,
): boolean {
  const planned = new Map<number, { depth: number; unwrap: boolean }>();
  const postDepth = new Map<number, number>();
  for (const pos of [...new Set(positions)].sort((a, b) => a - b)) {
    if (planned.has(pos)) continue;
    const item = state.doc.nodeAt(pos);
    if (item?.type.name !== "list_item") continue;
    const current = item.attrs.depth as number;
    let target = Math.max(0, current - 1);
    if (delta === 1) {
      const $pos = state.doc.resolve(pos);
      const index = $pos.index();
      const previous = index > 0 ? $pos.parent.child(index - 1) : null;
      const previousDepth = previous?.type.name === "list_item"
        ? postDepth.get(pos - previous.nodeSize) ?? (previous.attrs.depth as number)
        : -1;
      target = previousDepth < 0 ? current : Math.min(current + 1, previousDepth + 1);
    }
    const amount = target - current;
    for (const subtreePos of computeListSubtree(state, pos)) {
      const child = state.doc.nodeAt(subtreePos)!;
      const depth = (child.attrs.depth as number) + (delta === -1 && current === 0 ? -1 : amount);
      const unwrap = subtreePos === pos && delta === -1 && current === 0;
      planned.set(subtreePos, { depth: Math.max(0, depth), unwrap });
      postDepth.set(subtreePos, Math.max(0, depth));
    }
  }
  const changes = [...planned].filter(([pos, plan]) =>
    plan.unwrap || state.doc.nodeAt(pos)!.attrs.depth !== plan.depth);
  if (changes.length === 0) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  const removedBoundaries: number[] = [];
  for (const [pos, plan] of changes.sort(([a], [b]) => b - a)) {
    const original = state.doc.nodeAt(pos)!;
    const item = tr.doc.nodeAt(pos)!;
    if (plan.unwrap) {
      tr.replaceWith(pos, pos + item.nodeSize, item.content);
      removedBoundaries.push(pos, original.nodeSize + pos - 1);
    } else {
      tr.setNodeMarkup(pos, undefined, { ...item.attrs, depth: plan.depth, sourceRange: null });
    }
  }
  const boundaryMap: number[] = [];
  for (const pos of removedBoundaries.sort((a, b) => a - b)) {
    boundaryMap.push(pos, 1, 0);
  }
  tr.setSelection(state.selection.map(tr.doc, new StepMap(boundaryMap)));
  if (state.storedMarks !== null) tr.setStoredMarks(state.storedMarks);
  dispatch(tr.scrollIntoView());
  return true;
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
          tr.setSelection(state.selection.map(tr.doc, new StepMap([
            item.pos, 1, 0,
            item.pos + item.node.nodeSize - 1, 1, 0,
          ])));
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
  if (state.storedMarks !== null) tr.setStoredMarks(state.storedMarks);
  if (preserveMultiSelection) {
    tr.setMeta(LIST_DEPTH_MULTI_SELECTION_META, [...positions]);
  }
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}
