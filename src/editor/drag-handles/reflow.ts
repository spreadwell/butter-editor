import { computeSameContainerShifts } from "./dom";
import { LiveDragState, SiblingInfo, DropSlot, DragContext, dragVisualTotal, dragVisualAt } from "./types";


import type { EditorView } from "prosemirror-view";





// ── Constants ────────────────────────────────────────────────

import { suppressObserver } from "./utils";


export function applySlotReflow(
  editorView: EditorView,
  drag: LiveDragState,
): void {
  // If compact mode, the source clamp is applied once statically, 
  // so we don't need to reapply it every frame.

  const targetSlot = drag.slots[drag.targetSlotIdx];
  if (!targetSlot) return;

  const sourceCtxPos = drag.sourceContext?.containerPos ?? -1;
  const targetCtxPos = targetSlot.context?.containerPos ?? -1;
  const sameContainer = sourceCtxPos === targetCtxPos;
  const draggedSet = new Set(drag.draggedPositions);

  const targetSiblings = drag.siblingsByContainer.get(targetCtxPos) ?? [];
  const newShiftedDoms = new Set<HTMLElement>();
  const updates = new Map<HTMLElement, string>();

  if (sameContainer) {
    // Layout-simulation shifts (capture the idx-0 margin flip so blocks
    // settle to their final spots during the drag). The simulation is
    // scale-aware, so this now runs for compact drags too; it only
    // returns null for cross-container drops, where we fall back to the
    // index-only closure+gap math (which the simulation reduces to for
    // non-flip drags anyway).
    const simShifts = computeSameContainerShifts(drag, editorView);
    let cum = 0;
    const closureAt = new Map<number, number>();
    for (const sib of targetSiblings) {
      closureAt.set(sib.index, cum);
      if (draggedSet.has(sib.pos)) {
        cum += dragVisualAt(drag, sib.index);
      }
    }
    for (const sib of targetSiblings) {
      if (draggedSet.has(sib.pos)) continue;
      let dom = sib.dom;
      if (!dom.isConnected) {
        const newDom = editorView.nodeDOM(sib.pos);
        if (newDom instanceof HTMLElement) {
          sib.dom = newDom;
          dom = newDom;
        } else {
          continue;
        }
      }
      let shift: number;
      if (simShifts) {
        shift = simShifts.get(sib.pos) ?? 0;
      } else {
        shift = -(closureAt.get(sib.index) ?? 0);
        if (sib.index >= targetSlot.indexInContainer) shift += dragVisualTotal(drag);
      }
      if (Math.abs(shift) > 0.5) {
        updates.set(dom, `translateY(${shift}px)`);
        newShiftedDoms.add(dom);
      }
    }
  } else {
    for (const sib of targetSiblings) {
      
      let dom = sib.dom;
      if (!dom.isConnected) {
        const newDom = editorView.nodeDOM(sib.pos);
        if (newDom instanceof HTMLElement) {
          sib.dom = newDom;
          dom = newDom;
        } else {
          continue;
        }
      }
      if (sib.index >= targetSlot.indexInContainer) {
        updates.set(dom, `translateY(${dragVisualTotal(drag)}px)`);
        newShiftedDoms.add(dom);
      }
    }
  }

  suppressObserver(editorView, () => {
    // Clear old transforms
    for (const dom of drag.shiftedDoms) {
      if (!newShiftedDoms.has(dom)) {
        dom.style.removeProperty("transform");
      }
    }
    // Apply new transforms
    for (const [dom, transform] of updates.entries()) {
      dom.style.transform = transform;
    }
  });

  drag.shiftedDoms = newShiftedDoms;
}

// Neighbor shifts are inline transforms set by applySlotReflow, not
// rules in drag.styleEl, so removing the stylesheet never cleared
// them. This is the only thing that does. Skip it on any drag-exit
// path and shifted neighbors stay stuck until a reload re-renders the
// DOM from the doc. With butter-is-dragging still on the body the
// static transition animates them back to natural; once it is removed
// they snap.
export function clearShiftedTransforms(
  editorView: EditorView,
  drag: LiveDragState,
): void {
  suppressObserver(editorView, () => {
    for (const dom of drag.shiftedDoms) {
      dom.style.removeProperty("transform");
    }
  });
  drag.shiftedDoms = new Set();
}

// ── Reflow computation ───────────────────────────────────────

/** Direction-gated cascade over the flat slot list.
 *
 *  Hysteresis-aware:
 *    DOWN — leave slot N when ghost.bottom passes the BOTTOM of its
 *           anchor block (= ghost has fully cleared the current block
 *           going down).
 *    UP   — retreat from slot N to N-1 when ghost.top passes the TOP
 *           of slot N-1's anchor (= ghost has fully cleared the
 *           previous block going up).
 *
 *  This matches the old engine's feel: you have to drag past the
 *  whole adjacent block to commit a swap, not just brush its edge.
 *  The dead zone between exit-down and re-enter-from-up keeps the
 *  cascade from flip-flopping on a thin boundary.
 *
 *  Crossing a container boundary is just another slot transition —
 *  no separate "context switch" logic. */
export function pickTargetSlotIdx(
  editorView: EditorView,
  ghostTop: number,
  ghostBottom: number,
  drag: LiveDragState,
  currentIdx: number,
  pointerDelta: number,
): number {
  const slots = drag.slots;
  if (slots.length === 0) return -1;
  let idx = Math.max(0, Math.min(currentIdx, slots.length - 1));

  const getRect = (slot: DropSlot): { top: number; bottom: number; height: number; y: number } => {
    let dom = slot.triggerEl;
    if (!dom.isConnected) {
      // Recover detached triggerEl!
      let newDom: Node | null = null;
      if (slot.context && slot.triggerEl === slot.context.containerDom) {
        newDom = editorView.nodeDOM(slot.context.containerPos);
        if (newDom instanceof HTMLElement) {
          slot.context.containerDom = newDom;
          slot.triggerEl = newDom;
          dom = newDom;
        }
      } else {
        // It's a sibling. We don't have pos in DropSlot, but we have indexInContainer and context!
        const ctxPos = slot.context?.containerPos ?? -1;
        const sibs = drag.siblingsByContainer.get(ctxPos);
        if (sibs) {
          let sib = sibs.find(s => s.dom === slot.triggerEl);
          // If we can't find by strict equality, find by indexInContainer
          if (!sib) {
            sib = sibs.find(s => s.index === slot.indexInContainer);
          }
          if (sib) {
            const freshDom = editorView.nodeDOM(sib.pos);
            if (freshDom instanceof HTMLElement) {
              sib.dom = freshDom;
              slot.triggerEl = freshDom;
              dom = freshDom;
            }
          }
        }
      }
    }
    
    if (!slot.triggerEl.isConnected) {
      // STILL detached (e.g. temporarily unmounted by Obsidian/React).
      // Return a mocked DOMRect based on the initial cached triggerRect
      // adjusted for the current scroll position, so we don't return 0s
      // and cause catastrophic cascade failure.
      const currentScrollTop = drag.scroller ? drag.scroller.scrollTop : 0;
      const deltaY = currentScrollTop - drag.startScrollTop;
      const r = slot.triggerRect;
      return {
        top: r.top - deltaY,
        bottom: r.bottom - deltaY,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        x: r.x,
        y: r.y - deltaY,
        toJSON: () => {}
      } as DOMRect;
    }

    return slot.triggerEl.getBoundingClientRect();
  };

  if (pointerDelta > 0) {
    while (idx + 1 < slots.length) {
      const cur = slots[idx];
      const r = getRect(cur);
      const downTrigger = cur.isContainerEntry ? r.top : r.bottom;
      if (ghostBottom > downTrigger - drag.triggerBias) idx++;
      else break;
    }
  } else if (pointerDelta < 0) {
    while (idx > 0) {
      const prev = slots[idx - 1];
      const r = getRect(prev);
      const upTrigger = prev.triggerEdge === "top" ? r.top : r.bottom;
      if (ghostTop < upTrigger + drag.triggerBias) idx--;
      else break;
    }
  }
  return idx;
}

/** Find the slot that represents "drop at source position" — landing
 *  here is a no-op (delete + reinsert leaves doc unchanged). For
 *  contiguous source: the slot in source container with
 *  indexInContainer just past the last dragged child. For empty/
 *  non-contiguous source: best-effort first slot in source context. */
export function findSourceSlotIdx(
  slots: DropSlot[],
  sourceContext: DragContext | null,
  draggedPositions: number[],
  sourceSiblings: SiblingInfo[],
): number {
  const srcCtxPos = sourceContext?.containerPos ?? -1;
  const draggedSet = new Set(draggedPositions);
  let lastDraggedIdx = -1;
  for (const sib of sourceSiblings) {
    if (draggedSet.has(sib.pos) && sib.index > lastDraggedIdx) {
      lastDraggedIdx = sib.index;
    }
  }
  const target = lastDraggedIdx + 1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const sPos = s.context?.containerPos ?? -1;
    if (sPos !== srcCtxPos) continue;
    if (s.indexInContainer >= target) return i;
  }
  return slots.length > 0 ? slots.length - 1 : -1;
}

// ── Transaction construction ─────────────────────────────────

