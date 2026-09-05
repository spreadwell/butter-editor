import type { Node as PMNode } from "prosemirror-model";
import type { PluginKey, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { flatListLayoutFor } from "../../core/list-layout";
import type { DragSceneSnapshot, DragTarget } from "./types";

/** A synchronous post-dispatch DOM read may still expose Chromium's temporary
 * intrinsic placeholder geometry. It is safe to seed visible settlement only
 * when it already agrees with the renderer-owned destination. */
export function committedGeometryIsExact(
  missingBlockKey: string | null,
  maximumErrorPx: number,
  tolerancePx: number,
): boolean {
  return missingBlockKey == null && maximumErrorPx <= tolerancePx;
}

export interface DragSceneCommitInput {
  snapshot: DragSceneSnapshot;
  target: DragTarget;
  draggedPositions: readonly number[];
  draggedNodes: readonly PMNode[];
  sourceListDepth: number | null;
  clearSelectionMetaKey?: PluginKey | string;
  blockAnimatorSkipMetaKey?: string;
}

export function dragSceneCommitIsNoop(input: DragSceneCommitInput): boolean {
  const depthUnchanged = input.sourceListDepth == null ||
    input.target.listDepth == null ||
    input.sourceListDepth === input.target.listDepth;
  return input.target.slotKey === input.snapshot.sourceSlotKey && depthUnchanged;
}

function precedingTargetListItem(
  view: EditorView,
  input: DragSceneCommitInput,
): PMNode | null {
  const slot = input.snapshot.slots.get(input.target.slotKey);
  if (!slot) return null;
  const dragged = new Set(input.snapshot.draggedBlockKeys);
  const preceding = Array.from(input.snapshot.blocks.values())
    .filter((block) =>
      block.laneKey === slot.laneKey &&
      !dragged.has(block.key) &&
      block.indexInLane < slot.indexInLane)
    .sort((left, right) => right.indexInLane - left.indexInLane)[0];
  if (!preceding) return null;
  const node = view.state.doc.nodeAt(preceding.pos);
  return node?.type.name === "list_item" ? node : null;
}

interface OrderedRunReorder {
  memberIds: ReadonlySet<string>;
  start: number | null;
}

/** Preserve numbering as positional metadata when blocks are reordered inside
 * one ordered run. The parser stores the run start on its first item; moving a
 * continuation before that anchor must transfer the start instead of creating
 * two adjacent `1` runs. Explicit starts in neighboring runs remain untouched. */
function orderedRunReorder(
  view: EditorView,
  input: DragSceneCommitInput,
): OrderedRunReorder | null {
  const firstKey = input.snapshot.draggedBlockKeys[0];
  const first = firstKey ? input.snapshot.blocks.get(firstKey) : null;
  const slot = input.snapshot.slots.get(input.target.slotKey);
  if (!first || !slot || slot.laneKey !== first.laneKey ||
      input.target.listDepth !== input.sourceListDepth ||
      input.sourceListDepth == null) return null;
  const lane = input.snapshot.lanes.get(first.laneKey);
  if (!lane) return null;
  const parent = lane.contextPos == null
    ? view.state.doc
    : view.state.doc.nodeAt(lane.contextPos);
  if (!parent || first.indexInLane >= parent.childCount) return null;
  const source = parent.child(first.indexInLane);
  if (source.type.name !== "list_item" || source.attrs.kind !== "ordered") return null;
  const layout = flatListLayoutFor(parent);
  const sourceEntry = layout[first.indexInLane];
  if (!sourceEntry || sourceEntry.markerNumber == null) return null;
  const runStart = sourceEntry.runStartIndex;
  const runDepth = sourceEntry.effectiveDepth;
  let runBoundary = parent.childCount;
  for (let index = runStart + 1; index < parent.childCount; index++) {
    const entry = layout[index];
    if (!entry || entry.effectiveDepth < runDepth ||
        (entry.effectiveDepth === runDepth && entry.runStartIndex !== runStart)) {
      runBoundary = index;
      break;
    }
  }
  if (slot.indexInLane < runStart || slot.indexInLane > runBoundary) return null;
  const memberIds = new Set<string>();
  for (let index = runStart; index < runBoundary; index++) {
    if (layout[index]?.runStartIndex !== runStart) continue;
    const id: unknown = parent.child(index).attrs.blockId;
    if (typeof id !== "string" || id.length === 0) return null;
    memberIds.add(id);
  }
  return {
    memberIds,
    start: parent.child(runStart).attrs.start as number | null,
  };
}

function repairOrderedRunReorder(
  tr: Transaction,
  reorder: OrderedRunReorder | null,
): void {
  if (!reorder) return;
  const ordered: Array<{ node: PMNode; pos: number }> = [];
  tr.doc.descendants((node, pos) => {
    const id: unknown = node.attrs?.blockId;
    if (typeof id === "string" && reorder.memberIds.has(id)) {
      ordered.push({ node, pos });
    }
  });
  for (let index = 0; index < ordered.length; index++) {
    const { node, pos } = ordered[index];
    const start = index === 0 ? reorder.start : null;
    if (node.attrs.start === start) continue;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, start }, node.marks);
  }
}

/** Build the sole ProseMirror mutation emitted by Drag Scene v2. */
export function buildDragSceneMoveTransaction(
  view: EditorView,
  input: DragSceneCommitInput,
): Transaction | null {
  const slot = input.snapshot.slots.get(input.target.slotKey);
  if (!slot) return null;
  const runReorder = orderedRunReorder(view, input);
  const tr = view.state.tr;
  const sortedPositions = [...input.draggedPositions].sort((a, b) => b - a);
  for (const originalPos of sortedPositions) {
    const mappedPos = tr.mapping.map(originalPos);
    const node = tr.doc.nodeAt(mappedPos);
    if (node) tr.delete(mappedPos, mappedPos + node.nodeSize);
  }

  let insertPos: number;
  if (slot.beforeBlockKey) {
    const before = input.snapshot.blocks.get(slot.beforeBlockKey);
    if (!before) return null;
    insertPos = tr.mapping.map(before.pos);
  } else {
    const lane = input.snapshot.lanes.get(slot.laneKey);
    if (!lane) return null;
    if (lane.contextPos == null) {
      insertPos = tr.doc.content.size;
    } else {
      const mappedContainerPos = tr.mapping.map(lane.contextPos);
      const container = tr.doc.nodeAt(mappedContainerPos);
      if (!container) return null;
      insertPos = mappedContainerPos + container.nodeSize - 1;
    }
  }

  const depthDelta = input.sourceListDepth != null && input.target.listDepth != null
    ? input.target.listDepth - input.sourceListDepth
    : 0;
  const precedingListItem = depthDelta < 0
    ? precedingTargetListItem(view, input)
    : null;
  for (let index = input.draggedNodes.length - 1; index >= 0; index--) {
    const node = input.draggedNodes[index];
    let attrs = node.attrs;
    if (depthDelta !== 0 && node.type.name === "list_item") {
      attrs = {
        ...node.attrs,
        depth: Math.max(0, Number(node.attrs.depth ?? 0) + depthDelta),
        sourceRange: null,
      };
      // A first nested ordered item reparses with an explicit start=1. When
      // it is outdented immediately after an ordered item at the destination
      // depth, that synthetic run start must become a continuation again;
      // otherwise an indent/outdent round trip silently becomes a separate
      // `1)` run. Deliberate non-default starts remain explicit.
      if (
        index === 0 &&
        node.attrs.kind === "ordered" &&
        node.attrs.start === 1 &&
        precedingListItem?.attrs.kind === "ordered" &&
        Number(precedingListItem.attrs.depth ?? 0) === input.target.listDepth
      ) {
        attrs = { ...attrs, start: null };
      }
    }
    tr.insert(insertPos, node.type.create(attrs, node.content, node.marks));
  }
  repairOrderedRunReorder(tr, runReorder);
  if (!tr.docChanged) return null;
  if (input.clearSelectionMetaKey) {
    tr.setMeta(input.clearSelectionMetaKey, { kind: "clear" });
  }
  const blockIds = input.draggedNodes
    .map((node): unknown => node.attrs?.blockId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (blockIds.length > 0 && input.blockAnimatorSkipMetaKey) {
    tr.setMeta(input.blockAnimatorSkipMetaKey, blockIds);
  }
  return tr;
}
