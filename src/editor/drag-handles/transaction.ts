import { LiveDragState } from "./types";


import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  multiBlockKey,
} from "../multi-block-select";



// ── Constants ────────────────────────────────────────────────


export function buildMoveTransaction(
  view: EditorView,
  drag: LiveDragState,
): Transaction | null {
  const { draggedPositions, draggedNodes } = drag;
  const targetSlot = drag.slots[drag.targetSlotIdx];
  if (!targetSlot) return null;

  const targetCtxPos = targetSlot.context?.containerPos ?? -1;
  const targetSiblings = drag.siblingsByContainer.get(targetCtxPos) ?? [];
  const draggedSet = new Set(draggedPositions);

  const tr = view.state.tr;

  // Delete dragged blocks in reverse doc order so earlier positions
  // stay valid.
  const sorted = [...draggedPositions].sort((a, b) => b - a);
  for (const pos of sorted) {
    const node = tr.doc.nodeAt(tr.mapping.map(pos));
    if (!node) continue;
    const mappedPos = tr.mapping.map(pos);
    tr.delete(mappedPos, mappedPos + node.nodeSize);
  }

  // Insert at the first non-dragged sibling at/after the slot's index.
  // If none, insert at the end of the target container.
  let insertPos: number;
  const after = targetSiblings.find(
    (s) => s.index >= targetSlot.indexInContainer && !draggedSet.has(s.pos),
  );
  if (after) {
    insertPos = tr.mapping.map(after.pos);
  } else if (targetSlot.context) {
    insertPos = tr.mapping.map(
      targetSlot.context.containerPos +
        targetSlot.context.containerNode.nodeSize - 1,
    );
  } else {
    insertPos = tr.doc.content.size;
  }

  // Compute per-node depth delta when dragging list_items. Preserves
  // relative depth across the dragged subtree (a child two levels
  // deeper than the source stays two levels deeper at the new depth).
  const depthDelta =
    drag.sourceDepth != null && drag.targetDepth != null
      ? drag.targetDepth - drag.sourceDepth
      : 0;

  for (let i = draggedNodes.length - 1; i >= 0; i--) {
    const node = draggedNodes[i];
    const attrs = depthDelta !== 0 && node.type.name === "list_item"
      ? { ...node.attrs, depth: Math.max(0, (node.attrs.depth as number) + depthDelta) }
      : node.attrs;
    tr.insert(insertPos, node.type.create(attrs, node.content, node.marks));
  }

  if (!tr.docChanged) return null;

  tr.setMeta(multiBlockKey, { kind: "clear" });
  return tr;
}

// ── Context menu ─────────────────────────────────────────────

