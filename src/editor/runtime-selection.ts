import type { Node as PMNode } from "prosemirror-model";
import { Selection } from "prosemirror-state";
import { Mapping as PositionMapping } from "prosemirror-transform";

type Mapping = Parameters<Selection["map"]>[1];
const unchangedMapping = new PositionMapping();

type BlockPosition = {
  blockId: string;
  relative: number;
};

function usableBlockId(node: PMNode): string | null {
  const value = (node.attrs as { blockId?: unknown }).blockId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function retainedBlockPosition(
  doc: PMNode,
  position: number,
  association: -1 | 1,
): BlockPosition | null {
  let start = 0;
  let previous: { node: PMNode; start: number } | null = null;
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    const end = start + node.nodeSize;
    const inside = position > start && position < end;
    const atStart = position === start && association > 0;
    const atEnd = position === end && association < 0;
    if (inside || atStart || atEnd) {
      const blockId = usableBlockId(node);
      return blockId ? { blockId, relative: position - start } : null;
    }
    if (position === start && association < 0 && previous) {
      const blockId = usableBlockId(previous.node);
      return blockId
        ? { blockId, relative: previous.node.nodeSize }
        : null;
    }
    previous = { node, start };
    start = end;
  }
  if (position === start && previous) {
    const blockId = usableBlockId(previous.node);
    return blockId
      ? { blockId, relative: previous.node.nodeSize }
      : null;
  }
  return null;
}

function positionOfRetainedBlock(
  doc: PMNode,
  anchor: BlockPosition,
): number | null {
  let start = 0;
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (usableBlockId(node) === anchor.blockId) {
      return start + Math.max(0, Math.min(anchor.relative, node.nodeSize));
    }
    start += node.nodeSize;
  }
  return null;
}

/**
 * Keep a selection inside an unchanged runtime-identified block while a new
 * source generation replaces the document. Changed/deleted blocks fall back
 * to ProseMirror's transaction mapping. No source offsets or DOM are owned
 * here; this only supplies a more precise selection to the canonical PM state.
 */
export function selectionThroughRetainedBlocks(
  previousDoc: PMNode,
  nextDoc: PMNode,
  selection: Selection,
  fallbackMapping: Mapping,
): Selection {
  const retainedPosition = (position: number, association = 1): number | null => {
    const block = retainedBlockPosition(previousDoc, position, association < 0 ? -1 : 1);
    return block ? positionOfRetainedBlock(nextDoc, block) : null;
  };

  // Let each selection class validate its endpoints and preserve its own
  // semantics. Reconstructing mapped JSON can silently create a TextSelection
  // at a document boundary, or retain a deleted node/cell selection.
  const mapping: Mapping = {
    map(position, association = 1) {
      return retainedPosition(position, association) ??
        fallbackMapping.map(position, association);
    },
    mapResult(position, association = 1) {
      const retained = retainedPosition(position, association);
      return retained === null
        ? fallbackMapping.mapResult(position, association)
        : unchangedMapping.mapResult(retained, association);
    },
  };

  try {
    return selection.map(nextDoc, mapping);
  } catch {
    return selection.map(nextDoc, fallbackMapping);
  }
}
