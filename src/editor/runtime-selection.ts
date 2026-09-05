import type { Node as PMNode } from "prosemirror-model";
import { Selection } from "prosemirror-state";

type Mapping = Parameters<Selection["map"]>[1];

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
  const json = selection.toJSON() as Record<string, unknown>;
  const mapped: Record<string, unknown> = { ...json };
  const anchor = typeof json.anchor === "number" ? json.anchor : null;
  const head = typeof json.head === "number" ? json.head : null;
  const collapsed = anchor !== null && head !== null && anchor === head;

  for (const key of ["anchor", "head", "pos"] as const) {
    const position = json[key];
    if (typeof position !== "number") continue;
    const association: -1 | 1 = collapsed || key !== "anchor" ? 1 : -1;
    const block = retainedBlockPosition(previousDoc, position, association);
    const retained = block ? positionOfRetainedBlock(nextDoc, block) : null;
    mapped[key] = retained ?? fallbackMapping.map(position, association);
  }

  try {
    return Selection.fromJSON(nextDoc, mapped);
  } catch {
    return selection.map(nextDoc, fallbackMapping);
  }
}
