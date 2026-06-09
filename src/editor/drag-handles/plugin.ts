import { buildMoveTransaction } from "./transaction";
import { findSourceSlotIdx, applySlotReflow, pickTargetSlotIdx, clearShiftedTransforms } from "./reflow";
import { openBlockContextMenu } from "./menu";
import { DragHandlesConfig, DragPhase, BlockHit, DragContext, LiveDragState, dragVisualTotal } from "./types";
import { HANDLE_OFFSET_LEFT, HANDLE_WIDTH, DRAG_THRESHOLD, TOUCH_LONGPRESS_MOVE_PX, TOUCH_LONGPRESS_MS, COMPACT_THRESHOLD_PX, DRAG_MOTIONS, AUTOSCROLL_MAX_PX_PER_SECOND, AUTOSCROLL_EDGE_PX } from "./constants";
import { collectSiblings, handlePlacementFor, listItemHandleInset, isContainer, findBlockUnderPointer, findContainerContext, collectDropSlots, stampDragIndexes, suppressObserver, clearDragIndexes } from "./utils";
import { createHandleEl, createDragStyleEl, createGhost, positionGhost, createDropFiller, positionDropFiller, predictPostDropDraggedRect } from "./dom";
import {
  Plugin as PMPlugin,
  PluginKey,
  NodeSelection,
  TextSelection,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { Menu, Platform } from "obsidian";
import {
  getMultiBlockSelection,
  dispatchMultiBlock,
  computeListSubtree,
  computeScopeSelection,
  listTopLevelBlockPositions,
  openMultiBlockContextMenu,
} from "../multi-block-select";


import { scrollHost } from "../../util/dom-utils";
import { BLOCK_ANIMATOR_SKIP_IDS } from "../block-animator";
import { EXPLICIT_SELECTION_META } from "../selection-overlay";

function findScrollAnchor(view: EditorView, drag: LiveDragState): HTMLElement | null {
  const draggedSet = new Set(drag.draggedPositions);
  const vp = view.dom.closest(".butter-editor-view");
  if (!vp) return null;
  const vpTop = vp.getBoundingClientRect().top;
  const doc = view.state.doc;
  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  doc.forEach((child, offset) => {
    if (draggedSet.has(offset + 1)) return;
    const dom = view.nodeDOM(offset + 1);
    if (dom instanceof HTMLElement) {
      const dist = Math.abs(dom.getBoundingClientRect().top - vpTop);
      if (dist < bestDist) { bestDist = dist; best = dom; }
    }
  });
  return best;
}

// ── Constants ────────────────────────────────────────────────


export class HandleLayer {
  readonly layer: HTMLElement;
  private pool: HTMLElement[] = [];
  private activeCount = 0;

  constructor() {
    this.layer = activeDocument.createElement("div");
    this.layer.className = "butter-drag-handles-layer";
    activeDocument.body.appendChild(this.layer);
  }

  private acquire(idx: number): HTMLElement {
    while (this.pool.length <= idx) {
      const h = createHandleEl();
      this.layer.appendChild(h);
      this.pool.push(h);
    }
    return this.pool[idx];
  }

  update(view: EditorView, chromeBottom = 0): void {
    const allBlocks: {
      pos: number;
      rect: DOMRect;
      inset: number;
      top: number;
      height: number;
    }[] = [];

    const collectRecursive = (
      parent: PMNode,
      basePos: number,
    ): void => {
      const siblings = collectSiblings(view, parent, basePos);
      const isQuoteParent = parent.type.name === "blockquote";
      for (let i = 0; i < siblings.length; i++) {
        const sib = siblings[i];
        // Notion-style: the first paragraph of a blockquote is
        // INHERENT to the quote — the blockquote's own handle covers
        // it. Don't emit a separate handle for it. We still recurse
        // (in case the paragraph somehow holds nested containers,
        // which shouldn't happen but stays safe).
        const isInherentFirstPara =
          isQuoteParent && i === 0 && sib.node.type.name === "paragraph";
        if (!isInherentFirstPara) {
          const placement = handlePlacementFor(sib.node, sib.dom, sib.rect);
          allBlocks.push({
            pos: sib.pos,
            rect: sib.rect,
            inset: listItemHandleInset(sib.node, sib.dom),
            top: placement.top,
            height: placement.height,
          });
        }
        if (isContainer(sib.node)) {
          collectRecursive(sib.node, sib.pos + 1);
        }
      }
    };

    collectRecursive(view.state.doc, 0);

    let idx = 0;
    for (const block of allBlocks) {
      const handle = this.acquire(idx);
      if (block.top < chromeBottom) {
        handle.hide();
        handle.classList.remove("is-visible");
        idx++;
        continue;
      }
      handle.style.left = `${block.rect.left + block.inset - HANDLE_OFFSET_LEFT}px`;
      handle.style.top = `${block.top}px`;
      handle.style.height = `${block.height}px`;
      handle.dataset.blockPos = String(block.pos);
      handle.classList.add("is-visible");
      handle.show();
      idx++;
    }
    // Hide excess handles
    for (let i = idx; i < this.pool.length; i++) {
      this.pool[i].hide();
      this.pool[i].classList.remove("is-visible");
    }
    this.activeCount = idx;
  }

  hideAll(): void {
    for (let i = 0; i < this.pool.length; i++) {
      this.pool[i].hide();
      this.pool[i].classList.remove("is-visible");
    }
    this.activeCount = 0;
  }

  destroy(): void {
    this.layer.remove();
  }
}

// ── Main plugin ──────────────────────────────────────────────

export const pluginKey = new PluginKey("butter-drag-handles");

export function dragHandlesPlugin(config: DragHandlesConfig): PMPlugin {
  return new PMPlugin({
    key: pluginKey,
    view(editorView) {
      const host = editorView.dom.parentElement!;
      if (!host) return { destroy() {} };

      // ── State ──
      let phase: DragPhase = { kind: "idle" };
      let currentHit: BlockHit | null = null;
      let autoscrollRAF = 0;
      let activeMenu: Menu | null = null;

      const chromeY = () => config.chromeBottom?.() ?? 0;

      // ── Handle elements ──
      // Mounted on document.body for correct position:fixed coords
      // (host ancestors may have transforms that break fixed positioning).
      const hoverHandle = createHandleEl();
      activeDocument.body.appendChild(hoverHandle);
      // Always mode: layer of handles
      let alwaysLayer: HandleLayer | null = null;
      let currentMode = config.dragHandleVisibility();

      function ensureMode(): void {
        const mode = config.dragHandleVisibility();
        if (mode === currentMode) return;
        currentMode = mode;
        if (mode === "always") {
          hoverHandle.hide();
          hoverHandle.classList.remove("is-visible");
          if (!alwaysLayer) {
            alwaysLayer = new HandleLayer();
            alwaysLayer.layer.addEventListener(
              "pointerdown",
              onLayerPointerDown,
            );
          }
          alwaysLayer.update(editorView, chromeY());
        } else {
          alwaysLayer?.hideAll();
          hoverHandle.show();
        }
      }

      if (currentMode === "always") {
        hoverHandle.hide();
        alwaysLayer = new HandleLayer();
        // Defer initial update so the editor has rendered
        window.requestAnimationFrame(() => alwaysLayer?.update(editorView, chromeY()));
      }

      // ── Handle positioning (hover mode) ──
      function showHoverHandle(hit: BlockHit): void {
        const inset = listItemHandleInset(hit.node, hit.dom);
        const placement = handlePlacementFor(hit.node, hit.dom, hit.rect);
        const top = placement.top;
        const chromeY = config.chromeBottom?.() ?? 0;
        if (top < chromeY) { hideHoverHandle(); return; }
        hoverHandle.style.left = `${hit.rect.left + inset - HANDLE_OFFSET_LEFT}px`;
        hoverHandle.style.top = `${top}px`;
        hoverHandle.style.height = `${placement.height}px`;
        hoverHandle.dataset.blockPos = String(hit.pos);
        hoverHandle.classList.add("is-visible");
        hoverHandle.show();
      }

      function hideHoverHandle(): void {
        hoverHandle.classList.remove("is-visible");
      }

      // ── Hover detection ──
      // Listen on the document so the gutter area (where the handle
      // lives, OUTSIDE editorView.dom) gets pointermove events too.
      // Filter to only react when the pointer is within the editor's
      // bounding rect (extended HANDLE_OFFSET_LEFT px to the left
      // for the gutter zone).
      let hoverThrottleRAF = 0;
      const HOVER_GUTTER_PAD = HANDLE_OFFSET_LEFT + HANDLE_WIDTH;
      const onEditorPointerMove = (e: PointerEvent) => {
        if (phase.kind !== "idle") return;
        if (hoverThrottleRAF) return;
        hoverThrottleRAF = window.requestAnimationFrame(() => {
          hoverThrottleRAF = 0;
          if (phase.kind !== "idle") return;
          // Is the pointer near the editor area (incl. gutter)?
          const er = editorView.dom.getBoundingClientRect();
          const inX = e.clientX >= er.left - HOVER_GUTTER_PAD && e.clientX <= er.right;
          const inY = e.clientY >= er.top && e.clientY <= er.bottom;
          if (!inX || !inY) {
            if (currentHit) {
              currentHit = null;
              if (currentMode === "hover") hideHoverHandle();
            }
            return;
          }
          const hit = findBlockUnderPointer(
            editorView,
            e.clientX,
            e.clientY,
          );
          if (hit) {
            currentHit = hit;
            if (currentMode === "hover") showHoverHandle(hit);
          } else {
            currentHit = null;
            if (currentMode === "hover") hideHoverHandle();
          }
        });
      };

      activeDocument.addEventListener("pointermove", onEditorPointerMove);

      // ── Handle interaction (pointerdown) ──
      // Handles all click gestures: plain, Ctrl, Shift, double-click.
      // Modifier/double-click dispatch multi-block actions and return
      // without arming a drag. Plain clicks arm the drag threshold.
      const DBLCLICK_MS = 500;
      const DBLCLICK_PX = 6;
      let lastHandleClickX = -1;
      let lastHandleClickY = -1;
      let lastHandleClickTime = 0;

      const onHandlePointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (phase.kind !== "idle") return;

        const handle = (e.target as Element)?.closest?.<HTMLElement>(
          ".butter-drag-handle",
        );
        if (!handle) return;
        const blockPosStr = handle.dataset.blockPos;
        if (blockPosStr == null) return;
        const blockPos = parseInt(blockPosStr, 10);
        if (Number.isNaN(blockPos)) return;
        const blockNode = editorView.state.doc.nodeAt(blockPos);
        if (!blockNode) return;

        // ── Modifier / double-click gestures ──
        const dispatch = editorView.dispatch.bind(editorView);
        const now = performance.now();
        const dx = e.clientX - lastHandleClickX;
        const dy = e.clientY - lastHandleClickY;
        const isDouble =
          now - lastHandleClickTime < DBLCLICK_MS &&
          dx * dx + dy * dy <= DBLCLICK_PX * DBLCLICK_PX;
        lastHandleClickTime = now;
        lastHandleClickX = e.clientX;
        lastHandleClickY = e.clientY;

        if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
          const multi = getMultiBlockSelection(editorView.state);
          if (multi.anchor == null) {
            const sel = editorView.state.selection;
            if (sel instanceof NodeSelection) {
              dispatchMultiBlock(editorView.state, dispatch, {
                kind: "setAnchor", pos: sel.from,
              });
            }
          }
          const allPositions = listTopLevelBlockPositions(editorView.state);
          dispatchMultiBlock(editorView.state, dispatch, {
            kind: "extendTo", pos: blockPos, allBlockPositions: allPositions,
          });
          e.preventDefault();
          return;
        }

        if (e.ctrlKey || e.metaKey) {
          const multi = getMultiBlockSelection(editorView.state);
          const sel = editorView.state.selection;
          if (
            multi.positions.length === 0 &&
            sel instanceof NodeSelection &&
            sel.from !== blockPos
          ) {
            dispatchMultiBlock(editorView.state, dispatch, {
              kind: "add", pos: sel.from,
            });
          }
          dispatchMultiBlock(editorView.state, dispatch, {
            kind: "toggle", pos: blockPos,
          });
          e.preventDefault();
          return;
        }

        if (isDouble) {
          const scope = computeScopeSelection(editorView.state, blockPos, blockNode);
          if (scope.length > 0) {
            dispatchMultiBlock(editorView.state, dispatch, {
              kind: "set", positions: scope, anchor: blockPos,
            });
          }
          e.preventDefault();
          return;
        }

        // ── Plain click → arm drag ──
        const blockDom = editorView.nodeDOM(blockPos);
        if (!(blockDom instanceof HTMLElement)) return;
        const blockRect = blockDom.getBoundingClientRect();

        // Exclude the block itself from the container search — for a
        // top-level callout the search would otherwise return the
        // callout as its own container; for a nested callout it would
        // stop at the inner one and miss the outer parent, which then
        // makes the cross-context branch never fire when dragging the
        // nested block out (no reflow, drop filler in wrong place).
        const context = findContainerContext(
          editorView,
          blockRect.left + blockRect.width / 2,
          blockRect.top + blockRect.height / 2,
          new Set([blockPos]),
        );

        phase = {
          kind: "armed",
          startX: e.clientX,
          startY: e.clientY,
          pointerId: e.pointerId,
          hitPos: blockPos,
          hitNode: blockNode,
          // Clamp grabOffset so the ghost aligns with the block's
          // left edge even when clicking in the gutter/handle area.
          grabOffsetX: e.clientX - blockRect.left,
          grabOffsetY: e.clientY - blockRect.top,
          context,
        };

        window.addEventListener("pointermove", onArmMove);
        window.addEventListener("pointerup", onArmUp);
        window.addEventListener("pointercancel", onCancel);
        e.preventDefault();
      };

      // Listen on the hoverHandle directly AND on the always-layer via delegation
      hoverHandle.addEventListener("pointerdown", onHandlePointerDown);

      // Delegation for always-mode layer handles
      const onLayerPointerDown = (e: PointerEvent) => {
        onHandlePointerDown(e);
      };

      // ── Armed phase ──
      const onArmMove = (e: PointerEvent) => {
        if (phase.kind !== "armed") return;
        const dx = Math.abs(e.clientX - phase.startX);
        const dy = Math.abs(e.clientY - phase.startY);
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
        promoteToDrag(e);
      };

      const onArmUp = (e: PointerEvent) => {
        if (phase.kind !== "armed") return;
        cleanupArmListeners();

        const { hitPos, hitNode } = phase;
        phase = { kind: "idle" };

        // Close any open menu first
        if (activeMenu) {
          try { activeMenu.hide(); } catch { /* */ }
          activeMenu = null;
        }

        // Check multi-block selection
        const multi = getMultiBlockSelection(editorView.state);
        if (multi.positions.length >= 2 && multi.positions.includes(hitPos)) {
          // Find the handle element for positioning
          const handle = findHandleForPos(hitPos);
          if (handle) {
            activeMenu = openMultiBlockContextMenu(
              config.app,
              editorView,
              handle,
              hitPos,
              multi.positions,
              config.serializeNode,
            );
            activeMenu.onHide(() => {
              if (activeMenu) activeMenu = null;
            });
          }
          return;
        }

        // Single block click
        dispatchMultiBlock(
          editorView.state,
          editorView.dispatch.bind(editorView),
          { kind: "clear" },
        );

        // Set NodeSelection on the block. Mark the dispatch as
        // explicit so the selection-overlay knows this NodeSelection
        // came from a deliberate user action — overrides the
        // "ignore-incidental-embed-selection" defense.
        try {
          const sel = NodeSelection.create(editorView.state.doc, hitPos);
          editorView.dispatch(
            editorView.state.tr
              .setSelection(sel)
              .setMeta(EXPLICIT_SELECTION_META, true),
          );
        } catch { /* position may be invalid */ }

        // For list items, auto-select subtree
        if (hitNode.type.name === "list_item") {
          const subtree = computeListSubtree(editorView.state, hitPos);
          if (subtree.length > 1) {
            dispatchMultiBlock(
              editorView.state,
              editorView.dispatch.bind(editorView),
              { kind: "set", positions: subtree, anchor: hitPos },
            );
          }
        }

        // Open context menu
        const handle = findHandleForPos(hitPos);
        if (handle) {
          activeMenu = openBlockContextMenu(
            config.app,
            editorView,
            handle,
            hitPos,
            hitNode,
            config.serializeNode,
          );
          activeMenu.onHide(() => {
            if (activeMenu) activeMenu = null;
          });
        }
      };

      function findHandleForPos(pos: number): HTMLElement | null {
        if (
          currentMode === "hover" &&
          hoverHandle.dataset.blockPos === String(pos)
        ) {
          return hoverHandle;
        }
        if (alwaysLayer) {
          const el = activeDocument.querySelector<HTMLElement>(
            `.butter-drag-handles-layer .butter-drag-handle[data-block-pos="${pos}"]`,
          );
          if (el) return el;
        }
        return hoverHandle;
      }

      function cleanupArmListeners(): void {
        window.removeEventListener("pointermove", onArmMove);
        window.removeEventListener("pointerup", onArmUp);
        window.removeEventListener("pointercancel", onCancel);
      }

      // Capture-phase TouchEvent swallower installed during active
      // drag on mobile. Stops the browser from scrolling, selecting,
      // or firing synthetic mouse events.
      const swallowTouchEvent = (e: TouchEvent): void => {
        e.preventDefault();
        e.stopPropagation();
      };

      // ── Touch: long-press to start drag ──
      // No hover on touch → handles aren't a useful affordance. Press
      // and hold ANY block to start dragging. A quick tap or any
      // pre-timeout movement falls through to PM (cursor placement /
      // browser scroll).
      let touchPressTimer = 0;
      let touchPressStartX = 0;
      let touchPressStartY = 0;
      let touchPressLastX = 0;
      let touchPressLastY = 0;
      let touchPressPointerId = -1;
      // Tracks the last time a scroll event fired anywhere up the
      // editor's ancestor chain. The unlock-on-tap path consults this
      // so a "tap to stop momentum scroll" gesture (which fires a
      // pointerdown/up with tiny movement, indistinguishable from a
      // real tap) doesn't trip into edit mode. 300ms covers iOS-style
      // momentum tails without being long enough to feel laggy on
      // intentional taps after a brief scroll.
      let lastScrollAtMs = 0;
      const SCROLL_TAP_GUARD_MS = 300;
      const cleanupTouchPressListeners = (): void => {
        window.removeEventListener("pointermove", onTouchPressMove);
        window.removeEventListener("pointerup", onTouchPressEnd);
        window.removeEventListener("pointercancel", onTouchPressEnd);
        if (touchPressTimer) {
          window.clearTimeout(touchPressTimer);
          touchPressTimer = 0;
        }
      };
      const onTouchPressMove = (e: PointerEvent): void => {
        if (e.pointerId !== touchPressPointerId) return;
        touchPressLastX = e.clientX;
        touchPressLastY = e.clientY;
        const dx = Math.abs(e.clientX - touchPressStartX);
        const dy = Math.abs(e.clientY - touchPressStartY);
        if (dx > TOUCH_LONGPRESS_MOVE_PX || dy > TOUCH_LONGPRESS_MOVE_PX) {
          cleanupTouchPressListeners();
        }
      };
      const onTouchPressEnd = (e: PointerEvent): void => {
        if (e.pointerId !== touchPressPointerId) return;
        const wasArmed = touchPressTimer !== 0;
        const dx = Math.abs(touchPressLastX - touchPressStartX);
        const dy = Math.abs(touchPressLastY - touchPressStartY);
        const wasTap = wasArmed &&
          dx <= TOUCH_LONGPRESS_MOVE_PX &&
          dy <= TOUCH_LONGPRESS_MOVE_PX;
        const upX = touchPressLastX;
        const upY = touchPressLastY;
        cleanupTouchPressListeners();

        // Tap-to-stop-momentum-scroll guard: if the page just scrolled,
        // the user almost certainly tapped to halt or reverse the scroll
        // rather than to enter editing. Pointerdown/pointerup during a
        // momentum tail look identical to a deliberate tap (tiny
        // movement, brief duration), so timestamp-gating is the only
        // reliable distinguisher. Skip the unlock and let PM's default
        // behavior (which is "nothing", since the editor is non-
        // editable) hold.
        const sinceScroll = Date.now() - lastScrollAtMs;
        if (sinceScroll < SCROLL_TAP_GUARD_MS) return;

        // Tap with keyboard down: PM's `editable` prop is locked off
        // on mobile (see `installMobileToolbarBehavior` in main.ts).
        // Flip it back on, then manually place the cursor + focus
        // since the browser's tap-to-focus didn't fire on the non-
        // editable host.
        if (wasTap && !editorView.editable) {
          config.unlockMobileEditable?.();
          try {
            const posInfo = editorView.posAtCoords({ left: upX, top: upY });
            if (posInfo) {
              editorView.dispatch(
                editorView.state.tr.setSelection(
                  TextSelection.near(
                    editorView.state.doc.resolve(posInfo.pos),
                  ),
                ),
              );
            }
            editorView.focus();
          } catch { /* selection mapping failed - leave focus alone */ }
        }
      };
      const onEditorTouchDown = (e: PointerEvent): void => {
        if (e.pointerType !== "touch") return;
        if (phase.kind !== "idle") return;
        const targetEl = e.target as Element | null;
        // Callout header / title is the natural "grab here" zone for
        // dragging a callout. Allow long-press arming there even when
        // the editor is focused — the alternative is "callouts are
        // un-draggable on mobile once you've focused anything," which
        // is what the user was hitting.
        const onCalloutChrome =
          targetEl?.closest?.(".butter-callout-header") != null;
        // Don't fight Android's native text-selection long-press
        // when the keyboard is up (editor focused) — unless we're
        // on callout chrome where drag is the user's expectation.
        if (
          !onCalloutChrome &&
          editorView.dom.contains(activeDocument.activeElement)
        ) return;
        // Skip clicks on the handle itself — handle has its own
        // pointerdown listener.
        if (targetEl?.closest?.(".butter-drag-handle")) return;

        // For callout-header touches, target the CALLOUT NODE itself
        // (not a child block inside it). Without this, findBlockUnder-
        // Pointer's nearest-child fallback grabs the first nested
        // block because the header is "above" the children's vertical
        // midpoints — so long-pressing the header would arm a drag on
        // the first child rather than on the callout. Empty callouts
        // worked because there were no children to mis-select.
        let hit: BlockHit | null = null;
        if (onCalloutChrome) {
          const calloutDom = targetEl?.closest?.(".butter-callout-view");
          if (calloutDom instanceof HTMLElement) {
            const rect = calloutDom.getBoundingClientRect();
            const posInfo = editorView.posAtCoords({
              left: rect.left + 5,
              top: rect.top + 5,
            });
            if (posInfo) {
              const $ = editorView.state.doc.resolve(posInfo.pos);
              for (let d = $.depth; d >= 0; d--) {
                const n = $.node(d);
                if (n.type.name === "obsidian_callout") {
                  const calloutPos = d > 0 ? $.before(d) : 0;
                  // Resolve the callout's parent context (it could
                  // itself be inside another callout / blockquote).
                  let outerCtx: DragContext | null = null;
                  if (d > 0) {
                    const parent$ = editorView.state.doc.resolve(calloutPos);
                    if (parent$.depth > 0) {
                      const pNode = parent$.parent;
                      if (
                        pNode.type.name === "obsidian_callout" ||
                        pNode.type.name === "blockquote"
                      ) {
                        outerCtx = {
                          containerPos: parent$.before(),
                          containerNode: pNode,
                        };
                      }
                    }
                  }
                  hit = {
                    pos: calloutPos,
                    node: n,
                    dom: calloutDom,
                    rect,
                    context: outerCtx,
                  };
                  break;
                }
              }
            }
          }
        }
        if (!hit) {
          hit = findBlockUnderPointer(editorView, e.clientX, e.clientY);
        }
        if (!hit) return;

        touchPressStartX = e.clientX;
        touchPressStartY = e.clientY;
        touchPressLastX = e.clientX;
        touchPressLastY = e.clientY;
        touchPressPointerId = e.pointerId;
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const startY = e.clientY;

        window.addEventListener("pointermove", onTouchPressMove);
        window.addEventListener("pointerup", onTouchPressEnd);
        window.addEventListener("pointercancel", onTouchPressEnd);

        touchPressTimer = window.setTimeout(() => {
          touchPressTimer = 0;
          cleanupTouchPressListeners();
          if (phase.kind !== "idle") return;
          // Re-check focus at fire time — user may have tapped into
          // a contenteditable while the timer was running.
          if (editorView.dom.contains(activeDocument.activeElement)) return;
          const blockDom = editorView.nodeDOM(hit.pos);
          if (!(blockDom instanceof HTMLElement)) return;
          const blockRect = blockDom.getBoundingClientRect();
          const context = findContainerContext(
            editorView,
            blockRect.left + blockRect.width / 2,
            blockRect.top + blockRect.height / 2,
            new Set([hit.pos]),
          );
          phase = {
            kind: "armed",
            startX,
            startY,
            pointerId,
            hitPos: hit.pos,
            hitNode: hit.node,
            grabOffsetX: startX - blockRect.left,
            grabOffsetY: startY - blockRect.top,
            context,
          };
          // Haptic confirmation on devices that support it.
          if (typeof navigator !== "undefined" && navigator.vibrate) {
            try { navigator.vibrate(10); } catch { /* */ }
          }
          // Synthesize a PointerEvent for promoteToDrag (it reads
          // clientX/Y to position the ghost initially).
          const fakeEvt = {
            clientX: startX,
            clientY: startY,
            pointerId,
            pointerType: "touch",
          } as unknown as PointerEvent;
          promoteToDrag(fakeEvt);
        }, TOUCH_LONGPRESS_MS);
      };
      editorView.dom.addEventListener("pointerdown", onEditorTouchDown);

      // ── Promote armed → dragging ──
      function promoteToDrag(e: PointerEvent): void {
        if (phase.kind !== "armed") return;
        const armed = phase;
        cleanupArmListeners();

        if (editorView.state.doc.childCount <= 1 && !armed.context) {
          phase = { kind: "idle" };
          return;
        }

        // Determine drag set
        const multi = getMultiBlockSelection(editorView.state);
        let draggedPositions: number[];
        if (
          multi.positions.length >= 2 &&
          multi.positions.includes(armed.hitPos)
        ) {
          draggedPositions = [...multi.positions].sort((a, b) => a - b);
        } else if (armed.hitNode.type.name === "list_item") {
          draggedPositions = computeListSubtree(
            editorView.state,
            armed.hitPos,
          );
        } else {
          draggedPositions = [armed.hitPos];
        }

        const draggedNodes: PMNode[] = [];
        const draggedDoms: HTMLElement[] = [];
        let draggedHeight = 0;
        for (const pos of draggedPositions) {
          const node = editorView.state.doc.nodeAt(pos);
          if (!node) continue;
          draggedNodes.push(node);
          const dom = editorView.nodeDOM(pos);
          if (dom instanceof HTMLElement) {
            draggedDoms.push(dom);
            draggedHeight += dom.getBoundingClientRect().height;
            draggedHeight += parseFloat(getComputedStyle(dom).marginTop) || 0;
          }
        }

        if (draggedNodes.length === 0) {
          phase = { kind: "idle" };
          return;
        }

        // First-block top inset — the "gap above the block" zone
        // that the filler trims off the top so the placeholder
        // shows only the block's visible body. The filler's height
        // (the visual total) folds in each block's margin-top, so the
        // leading margin must be trimmed back off for every block type.
        // Padding-top is ALSO trimmed when
        // the first block is a list item — block-spacing.ts
        // expresses the gap as padding there so the indent guide
        // background spans the gap. For other block types padding-
        // top is real chrome (e.g. callout inner padding) and stays.
        let firstBlockTopInset = 0;
        if (draggedDoms[0]) {
          const cs = getComputedStyle(draggedDoms[0]);
          const isListItem = draggedNodes[0]?.type.name === "list_item";
          firstBlockTopInset =
            (parseFloat(cs.marginTop) || 0) +
            (isListItem ? parseFloat(cs.paddingTop) || 0 : 0);
        }

        // Build the flat slot list + per-container sibling map.
        // The walker emits slots in visual document order; the source
        // container's siblings are pulled from the map for the initial
        // reflow CSS render.
        const draggedSet = new Set(draggedPositions);
        const { slots, siblingsByContainer } = collectDropSlots(
          editorView,
          draggedSet,
        );
        const sourceCtxKey = armed.context?.containerPos ?? -1;
        const siblings = siblingsByContainer.get(sourceCtxKey) ?? [];

        // Find source index (index of the first dragged block)
        const sourceIndex =
          siblings.find((s) => s.pos === draggedPositions[0])?.index ?? 0;

        // List-item depth tracking: if dragging list_items, capture
        // the source's depth attr and resolve --list-indent in px so
        // we can map horizontal pointer movement to depth changes.
        const firstNode = draggedNodes[0];
        const sourceDepth = firstNode?.type.name === "list_item"
          ? (firstNode.attrs.depth as number)
          : null;
        let listIndentPx = 0;
        let contentLeftX = 0;
        if (sourceDepth != null) {
          const pmEl = editorView.dom;
          const cs = getComputedStyle(pmEl);
          // --list-indent is typically `4ch` — resolve to px via a
          // temporary measurement element so we get the real value.
          const probe = activeDocument.createElement("div");
          probe.style.cssText = `position:absolute;visibility:hidden;width:${cs.getPropertyValue("--list-indent") || "4ch"};`;
          pmEl.appendChild(probe);
          listIndentPx = probe.getBoundingClientRect().width || 32;
          probe.remove();
          contentLeftX = pmEl.getBoundingClientRect().left
            + parseFloat(cs.paddingLeft || "0");
        }

        // Height model (single source of truth — see types.ts § Drag
        // height model). layoutHeightByIndex holds each dragged block's
        // REAL flow height (border-box + own margin-top), keyed by
        // source-sibling index. dragScale is the one compact knob:
        // < 1 draws the run scaled down so its on-screen footprint caps
        // at COMPACT_THRESHOLD_PX. Everything visual (ghost, gap, filler)
        // derives from these via the drag* helpers — no separate clamped
        // total, per-index map, or single/multi-select fork.
        const layoutHeightByIndex = new Map<number, number>();
        for (const sib of siblings) {
          if (draggedSet.has(sib.pos)) {
            const fullH = sib.rect.height +
              (parseFloat(getComputedStyle(sib.dom).marginTop) || 0);
            layoutHeightByIndex.set(sib.index, fullH);
          }
        }
        const dragScale = draggedHeight > COMPACT_THRESHOLD_PX
          ? COMPACT_THRESHOLD_PX / draggedHeight
          : 1;
        // Visual total = the size of the ghost, the opened gap, and the
        // filler. Equals draggedHeight when not compact.
        const visualTotal = draggedHeight * dragScale;


        // Stamp data-butter-drag-idx on the source container's siblings
        // (one-time observer suppress). Other containers get stamped
        // lazily as the cascade enters them.
        stampDragIndexes(editorView, siblings);
        const stampedContainerKeys = new Set<number>([sourceCtxKey]);

        // Mark source DOMs with butter-drag-source class so they get
        // hidden via CSS — INDEPENDENT of the data-butter-drag-idx
        // attribute.
        suppressObserver(editorView, () => {
          for (const dom of draggedDoms) {
            dom.classList.add("butter-drag-source");
          }
        });

        // Create injected stylesheet
        const styleEl = createDragStyleEl();

        // Create ghost (clamp height to the visual total in compact mode
        // so the ghost, shadow, and reflow gap all match).
        const ghost = createGhost(draggedDoms, editorView.dom);
        if (dragScale < 1) {
          ghost.classList.add("butter-drag-ghost-clamped");
          ghost.style.height = `${visualTotal}px`;
          ghost.style.maxHeight = `${visualTotal}px`;
        }
        // Trigger geometry follows the ACTUAL ghost. createGhost zeroes
        // the first block's margin-top, so this is the body span without
        // the leading margin (normal drag) or the clamped card height
        // (compact) — no parallel hand-computed number to drift from it.
        const ghostHeight = ghost.getBoundingClientRect().height;
        positionGhost(ghost, e.clientX, e.clientY, armed.grabOffsetX, armed.grabOffsetY);

        const dropFiller = createDropFiller();

        // Initial target slot = source slot. Dropping here is a no-op
        // (delete + reinsert at same spot). Cascade advances from here
        // on first pointer movement.
        const sourceSlotIdx = findSourceSlotIdx(
          slots, armed.context, draggedPositions, siblings,
        );

        const _scroller = scrollHost(editorView.dom);

        const drag: LiveDragState = {
          draggedPositions,
          draggedNodes,
          draggedDoms,
          layoutHeightByIndex,
          dragScale,
          scroller: _scroller,
          scrollerRect: _scroller ? _scroller.getBoundingClientRect() : null,
          // Measured off the ghost (see above) — trigger geometry only.
          ghostHeight,
          triggerBias: config.dragTriggerBias(),
          shiftedDoms: new Set(),
          firstBlockTopInset,
          sourceContext: armed.context,
          sourceIndex,
          sourceSiblings: siblings,
          slots,
          targetSlotIdx: sourceSlotIdx,
          sourceSlotIdx,
          siblingsByContainer,
          stampedContainerKeys,
          ghost,
          grabOffsetX: armed.grabOffsetX,
          grabOffsetY: armed.grabOffsetY,
          lastPointerX: e.clientX,
          lastPointerY: e.clientY,
          prevPointerY: e.clientY,
          startScrollTop: _scroller ? _scroller.scrollTop : 0,
          styleEl,
          paddedContextDom: null,
          dropFiller,
          sourceDepth,
          targetDepth: sourceDepth,
          listIndentPx,
          contentLeftX,
          dragStartX: e.clientX,
        };

        // Initial stylesheet: source-hide via static CSS + compact
        // clamp. No transforms yet (target = source = no opening gap).
        // In compact mode each source block is physically shrunk to its
        // VISUAL height (layout × dragScale, margin folded in) so the
        // sealed source gap matches the ghost and filler exactly.
        let styles = dragScale < 1 ? `.ProseMirror .butter-drag-source{overflow:hidden !important;}\n` : "";
        if (dragScale < 1) {
          for (const sib of siblings) {
            if (draggedSet.has(sib.pos)) {
              const visH = (layoutHeightByIndex.get(sib.index) ?? 0) * dragScale;
              styles += `.ProseMirror [data-butter-drag-idx="${sib.dragIdx}"] { height: ${visH}px !important; margin: 0 !important; padding: 0 !important; }\n`;
            }
          }
        }
        styleEl.textContent = styles;
        applySlotReflow(editorView, drag);

        // Body state. Set motion curve CSS vars so the reflow +
        // drop-filler transitions (defined in styles.css) read the
        // user's chosen dragMotion setting without needing per-
        // element inline styles. Two springs (`spring`, `soft`)
        // mirror 0.9.9; verticals get `soft`, transforms get
        // `spring`. Horizontal/scale/opacity use a constant non-
        // bouncy ease.
        const motion = DRAG_MOTIONS[config.dragMotion()] ?? DRAG_MOTIONS.springy;
        activeDocument.body.style.setProperty(
          "--butter-drag-spring",
          motion.spring,
        );
        activeDocument.body.style.setProperty(
          "--butter-drag-spring-soft",
          motion.soft,
        );
        const dragEase = "cubic-bezier(0.2, 0.7, 0.2, 1)";
        activeDocument.body.style.setProperty(
          "--butter-drag-ease",
          dragEase,
        );
        activeDocument.body.classList.add("butter-is-dragging");

        // Hide handles during drag
        if (currentMode === "hover") {
          hideHoverHandle();
        } else {
          alwaysLayer?.hideAll();
        }

        phase = { kind: "dragging", drag };
        positionDropFiller(dropFiller, drag, editorView);

        window.addEventListener("pointermove", onLiveMove);
        window.addEventListener("pointerup", onLiveUp);
        window.addEventListener("pointercancel", onCancel);
        activeDocument.addEventListener("keydown", onDragKeyDown);
        // Mobile: while drag is live, swallow native touch behavior
        // (scroll, selection, taps on other widgets). PointerEvent's
        // preventDefault doesn't suppress the underlying touch
        // gesture — we need capture-phase non-passive touch listeners
        // calling preventDefault on the actual TouchEvent. CSS
        // touch-action is evaluated at touchstart so changing it
        // mid-gesture has no effect.
        if (Platform.isMobile) {
          window.addEventListener("touchmove", swallowTouchEvent, { passive: false, capture: true });
          window.addEventListener("touchstart", swallowTouchEvent, { passive: false, capture: true });
          window.addEventListener("touchend", swallowTouchEvent, { passive: false, capture: true });
        }
        startAutoscroll();
      }

      // ── Live drag ──
      const onLiveMove = (e: PointerEvent) => {
        if (phase.kind !== "dragging") return;
        const drag = phase.drag;
        drag.lastPointerX = e.clientX;
        drag.lastPointerY = e.clientY;

        positionGhost(
          drag.ghost,
          e.clientX,
          e.clientY,
          drag.grabOffsetX,
          drag.grabOffsetY,
        );

        updateReflow(drag, e.clientX);
      };

      function updateReflow(
        drag: LiveDragState,
        clientX: number,
        directionHint?: number,
      ): void {

        const ghostTop = drag.lastPointerY - drag.grabOffsetY;
        const ghostBottom = ghostTop + drag.ghostHeight;

        const pointerDelta = drag.lastPointerY - drag.prevPointerY;
        drag.prevPointerY = drag.lastPointerY;
        // During autoscroll the pointer may be held still (delta = 0)
        // while the user is moving through the doc — caller passes
          // the scroll direction as a hint so the cascade still fires.
        const effectiveDelta = directionHint != null && directionHint !== 0
          ? directionHint
          : pointerDelta;

        const newSlotIdx = pickTargetSlotIdx(
          editorView,
          ghostTop,
          ghostBottom,
          drag,
          drag.targetSlotIdx,
          effectiveDelta,
        );

        // List-item depth: map pointer X to a depth level. Each
        // --list-indent of horizontal pointer movement = 1 depth
        // level. Snapped to nearest integer, clamped to [0, maxDepth].
        // maxDepth = (depth of prev non-dragged list_item at the
        // target position) + 1 — so the user can't over-indent into
        // an orphan state. If the prev sibling is not a list_item,
        // maxDepth = 0.
        let newTargetDepth = drag.targetDepth;
        if (drag.sourceDepth != null && drag.listIndentPx > 0) {
          // Delta-from-grab model: depth = source + round(delta /
          // indent). User drags right half-an-indent to bump up,
          // left half to bump down. Independent of where the source
          // sits in the indent gutter, which is what made the old
          // absolute-X model feel awful on touch — grabbing a deeply
          // nested item required hauling the pointer far past the
          // left margin just to outdent.
          const dx = clientX - drag.dragStartX;
          const delta = Math.round(dx / drag.listIndentPx);
          const requested = Math.max(0, drag.sourceDepth + delta);
          // Find the prev non-dragged sibling at the target slot.
          const targetSlot = drag.slots[newSlotIdx];
          const tCtxPos = targetSlot?.context?.containerPos ?? -1;
          const tSibs = drag.siblingsByContainer.get(tCtxPos) ?? [];
          const draggedSet = new Set(drag.draggedPositions);
          let prevListDepth = -1;
          for (const sib of tSibs) {
            if (targetSlot && sib.index >= targetSlot.indexInContainer) break;
            if (draggedSet.has(sib.pos)) continue;
            if (sib.node.type.name === "list_item") {
              prevListDepth = sib.node.attrs.depth as number;
            } else {
              prevListDepth = -1;
            }
          }
          const maxDepth = prevListDepth + 1;
          newTargetDepth = Math.min(maxDepth, requested);
        }

        // Even if the slot didn't change, we MUST proceed to applySlotReflow 
        // to heal any asynchronous DOM mutations (like Markdown PostProcessors)
        // that replaced nodes and destroyed their inline CSS transforms.
        const depthChanged = newTargetDepth !== drag.targetDepth;
        drag.targetDepth = newTargetDepth;
        const slotChanged = newSlotIdx !== drag.targetSlotIdx;

        const oldSlot = drag.slots[drag.targetSlotIdx];
        const oldCtxPos = oldSlot?.context?.containerPos ?? -1;
        drag.targetSlotIdx = newSlotIdx;

        const newSlot = drag.slots[newSlotIdx];
        const newCtxPos = newSlot?.context?.containerPos ?? -1;

        // When the target crosses into or out of the source container,
        // source-container layout changes — padding-bottom snaps onto
        // the target container while source-container siblings get
        // close-source-gap transforms. For these to stay visually
        // motionless, the padding (layout) and the transforms (GPU
        // composite) must move in lockstep. Browsers don't reliably
        // sync layout-animated and composite-animated transitions, so
        // we make the cross-container hop INSTANT instead: transitions
        // are briefly disabled on the source-container siblings + the
        // padded container while the snap is applied, then re-enabled
        // on the next frame so within-container cascades animate.
        const srcCtxPos = drag.sourceContext?.containerPos ?? -1;
        const ctxChanged = newCtxPos !== oldCtxPos;
        const sourceInvolved =
          ctxChanged &&
          ((oldCtxPos === srcCtxPos) !== (newCtxPos === srcCtxPos));

        if (ctxChanged) {
          ensureContainerStamped(drag, newCtxPos);
          maybeUnstampContainer(drag, oldCtxPos);
        }

        // Heal dragged DOMs unconditionally so async PostProcessors
        // don't leave visible ghosts behind if they mutate the node.
        for (let i = 0; i < drag.draggedDoms.length; i++) {
          let dom = drag.draggedDoms[i];
          if (!dom.isConnected) {
            const pos = drag.draggedPositions[i];
            const newDom = editorView.nodeDOM(pos);
            if (newDom instanceof HTMLElement) {
              drag.draggedDoms[i] = newDom;
              dom = newDom;
              dom.classList.add("butter-drag-source");
              // If we are currently in a cross-container dragged state,
              // re-apply the collapsed class so the gap stays closed.
              if (drag.targetSlotIdx >= 0) {
                const curCtxPos = drag.slots[drag.targetSlotIdx]?.context?.containerPos ?? -1;
                const srcCtxPos = drag.sourceContext?.containerPos ?? -1;
                if (curCtxPos !== srcCtxPos) {
                  dom.classList.add("butter-drag-source-collapsed");
                }
              }
            }
          }
        }

        const snapEls: HTMLElement[] = [];
        if (sourceInvolved) {
          const addSib = (el: HTMLElement) => {
            if (!snapEls.includes(el)) snapEls.push(el);
          };
          const getDom = (sib: { dom: HTMLElement, pos: number }): HTMLElement => {
            if (!sib.dom.isConnected) {
              const newDom = editorView.nodeDOM(sib.pos);
              if (newDom instanceof HTMLElement) {
                sib.dom = newDom;
              }
            }
            return sib.dom;
          };

          // Source container siblings — their transforms change as
          // closure terms get added/removed.
          const sourceSibs = drag.siblingsByContainer.get(srcCtxPos) ?? [];
          for (const sib of sourceSibs) addSib(getDom(sib));
          // OLD target container siblings — their open-gap transforms
          // disappear when the target leaves their container.
          const oldTargetSibs = drag.siblingsByContainer.get(oldCtxPos) ?? [];
          for (const sib of oldTargetSibs) addSib(getDom(sib));
          // NEW target container siblings — their open-gap transforms
          // appear when the target arrives.
          const newTargetSibs = drag.siblingsByContainer.get(newCtxPos) ?? [];
          for (const sib of newTargetSibs) addSib(getDom(sib));
          // Source DOMs — they get collapsed/uncollapsed here, the
          // size change must be instant for the symmetry to hold.
          for (const dom of drag.draggedDoms) {
            addSib(dom);
          }
          // OLD and NEW padded containers (padding-bottom change).
          if (drag.paddedContextDom) addSib(drag.paddedContextDom);
          const newPadCandidate = newSlot?.context
            ? (drag.siblingsByContainer.get(newCtxPos)?.[0]?.dom.parentElement ?? null)
            : null;
          if (newPadCandidate instanceof HTMLElement) addSib(newPadCandidate);

          suppressObserver(editorView, () => {
            const noTransition = "none";
            for (const el of snapEls) el.style.transition = noTransition;
          });

          // Toggle the source-collapsed class based on the new state.
          // When target is in source container → source uncollapsed
          // (natural height, opacity:0). When target is in a different
          // container → source collapsed (height:0) so the source
          // container visually shrinks to absorb the source's slot.
          const sourceCollapsed = newCtxPos !== srcCtxPos;
          suppressObserver(editorView, () => {
            for (const dom of drag.draggedDoms) {
              dom.classList.toggle("butter-drag-source-collapsed", sourceCollapsed);
            }
          });
        }

        if (slotChanged || depthChanged) {
          updateTargetPadding(drag);
        }
        applySlotReflow(editorView, drag);
        positionDropFiller(drag.dropFiller, drag, editorView);

        if (snapEls.length > 0) {
          // Force layout so the snapped values are committed BEFORE
          // we re-enable transitions on the next frame. Without the
          // forced reflow, the browser may batch the snap + re-enable
          // and end up animating the change after all.
          void snapEls[0].offsetHeight;
          window.requestAnimationFrame(() => {
            suppressObserver(editorView, () => {
              for (const el of snapEls) el.style.removeProperty("transition");
            });
          });
        }
      }

      /** Stamp data-butter-drag-idx on a container's siblings if not
       *  already stamped. Idempotent. Source container is always
       *  stamped (registered at drag start). */
      function ensureContainerStamped(
        drag: LiveDragState,
        ctxKey: number,
      ): void {
        if (drag.stampedContainerKeys.has(ctxKey)) return;
        const sibs = drag.siblingsByContainer.get(ctxKey);
        if (!sibs || sibs.length === 0) return;
        stampDragIndexes(editorView, sibs);
        drag.stampedContainerKeys.add(ctxKey);
      }

      /** Unstamp a container's siblings IF it's neither the source
       *  container nor the current target container. */
      function maybeUnstampContainer(
        drag: LiveDragState,
        ctxKey: number,
      ): void {
        if (ctxKey === (drag.sourceContext?.containerPos ?? -1)) return;
        const targetSlot = drag.slots[drag.targetSlotIdx];
        const targetCtxKey = targetSlot?.context?.containerPos ?? -1;
        if (ctxKey === targetCtxKey) return;
        const sibs = drag.siblingsByContainer.get(ctxKey);
        if (!sibs) return;
        clearDragIndexes(editorView, sibs);
        drag.stampedContainerKeys.delete(ctxKey);
      }

      /** Apply padding-bottom to the target container's content area
       *  when target differs from source. The padding expands the
       *  container's outer box by EXACTLY the visual total, which is
       *  matched by the close-source-gap transforms on source-
       *  container siblings — net visible movement of blocks below
       *  the container = 0.
       *
       *  The transition rule for `padding-bottom` is armed in CSS via
       *  the `body.butter-is-dragging` selector, so we just set the
       *  value inline and the browser animates it. ADD to the natural
       *  padding-bottom (don't override): callouts have ~10px natural
       *  padding-bottom, so a plain `${dh}px` override would only grow
       *  the box by `(dh - natural)` and leave a visible mismatch with
       *  the full-dh transforms below. */
      function updateTargetPadding(drag: LiveDragState): void {
        const targetSlot = drag.slots[drag.targetSlotIdx];
        const sourceCtxPos = drag.sourceContext?.containerPos ?? -1;
        const targetCtxPos = targetSlot?.context?.containerPos ?? -1;
        const needPadding =
          targetSlot != null &&
          targetCtxPos !== sourceCtxPos &&
          targetSlot.context != null;

        const newPad = needPadding
          ? (drag.siblingsByContainer.get(targetCtxPos)?.[0]?.dom.parentElement ?? null)
          : null;

        if (drag.paddedContextDom === newPad) return;

        if (drag.paddedContextDom) {
          // Animate from current padding back to natural by removing
          // the inline override. CSS transition handles the animation.
          const old = drag.paddedContextDom;
          suppressObserver(editorView, () => {
            old.style.removeProperty("padding-bottom");
          });
          drag.paddedContextDom = null;
        }
        if (newPad instanceof HTMLElement) {
          const naturalPadding =
            parseFloat(getComputedStyle(newPad).paddingBottom) || 0;
          suppressObserver(editorView, () => {
            newPad.style.paddingBottom =
              `${naturalPadding + dragVisualTotal(drag)}px`;
          });
          drag.paddedContextDom = newPad;
        }
      }

      // ── Drop (settle, no animation) ──
      // Animations are intentionally OFF for now. The BlockAnimator
      // plugin is still wired in but its WAAPI durations are 0 —
      // re-enable when ready to layer animations back on.

      const onLiveUp = (_e: PointerEvent) => {
        if (phase.kind !== "dragging") return;
        const drag = phase.drag;
        cleanupDragListeners();

        phase = { kind: "settling" };

        // noOp = position AND depth both unchanged. Depth-only changes
        // (drag horizontally without moving Y) still dispatch so the
        // user can indent/outdent in place.
        const depthUnchanged = drag.sourceDepth == null
          || drag.sourceDepth === drag.targetDepth;
        const noOp =
          drag.targetSlotIdx === drag.sourceSlotIdx && depthUnchanged;

        if (noOp) {
          // Drop-in-place: still play the slide animation so the ghost
          // visibly settles back into the source position instead of
          // popping out instantly. No PM dispatch needed.
          //
          // Don't call cleanupDragAttrs here — it strips the
          // `butter-drag-source` class, which would make the source
          // visible immediately and the ghost would slide on top of an
          // already-visible block. Clean up drag-idx attrs only; the
          // source class stays until `finish()` after the slide.
          activeDocument.body.classList.remove("butter-is-dragging");
          activeDocument.body.dataset.butterDragEndedAt = String(Date.now());
          cleanupReflowStyles(drag);
          for (const ctxKey of drag.stampedContainerKeys) {
            const sibs = drag.siblingsByContainer.get(ctxKey);
            if (sibs) clearDragIndexes(editorView, sibs);
          }
          drag.stampedContainerKeys.clear();
          if (drag.paddedContextDom) {
            suppressObserver(editorView, () => {
              drag.paddedContextDom!.style.removeProperty("padding-bottom");
            });
            drag.paddedContextDom = null;
          }

          const ghostStart = drag.ghost.getBoundingClientRect();
          const sourceRect = drag.draggedDoms[0]?.getBoundingClientRect();
          drag.dropFiller.animate(
            [{ opacity: parseFloat(getComputedStyle(drag.dropFiller).opacity) || 0.85 }, { opacity: 0 }],
            { duration: 120, easing: "ease-out", fill: "forwards" },
          ).onfinish = () => drag.dropFiller.remove();

          const finish = () => {
            suppressObserver(editorView, () => {
              for (const dom of drag.draggedDoms) {
                dom.classList.remove("butter-drag-source");
                dom.classList.remove("butter-drag-source-collapsed");
              }
            });
            drag.ghost.remove();
            activeDocument.body.style.removeProperty("--butter-drag-spring");
            activeDocument.body.style.removeProperty("--butter-drag-spring-soft");
            activeDocument.body.style.removeProperty("--butter-drag-ease");
            finishDrag();
          };
          if (sourceRect) {
            const motion = DRAG_MOTIONS[config.dragMotion()] ?? DRAG_MOTIONS.springy;
            const slide = drag.ghost.animate(
              [
                { transform: `translate3d(${ghostStart.left}px,${ghostStart.top}px,0)` },
                { transform: `translate3d(${sourceRect.left}px,${sourceRect.top}px,0)` },
              ],
              { duration: 300, easing: motion.soft, fill: "forwards" },
            );
            slide.onfinish = finish;
            slide.oncancel = finish;
          } else {
            finish();
          }
          return;
        }

        // Dispatch-first drop: commit the move, READ the block's
        // actual landed position from the DOM, animate the ghost
        // there. No prediction math — what gets dispatched is what
        // gets measured.
        const SETTLE_MS = 300;

        activeDocument.body.classList.remove("butter-is-dragging");
        activeDocument.body.dataset.butterDragEndedAt = String(Date.now());

        // Remove the source-collapsed class before dispatch so the
        // source returns to natural size. PM's dispatch will then put
        // the source into its NEW container with the right slot size.
        // Same JS tick → browser renders only the final state, no
        // intermediate paint of the OLD container regrowing.
        suppressObserver(editorView, () => {
          for (const dom of drag.draggedDoms) {
            dom.classList.remove("butter-drag-source-collapsed");
          }
        });

        const ghostStart = drag.ghost.getBoundingClientRect();

        // Simulate the dragged block's FINAL resting rect from the
        // pre-dispatch layout. Measuring it post-dispatch (landRect
        // below) is unreliable: PM hasn't written the block's final
        // margin-top to the DOM by the time we read it, so a block
        // that left idx 0 measures a stale, too-high position. The
        // simulation applies the spacing rule at the NEW index, so it
        // reflects the true landing. Null for cases it can't model
        // (cross-container, multi-block) — those fall back to the
        // measured landRect, where the staleness doesn't bite.
        const predictedLand = predictPostDropDraggedRect(drag);

        const tr = buildMoveTransaction(editorView, drag);
        if (tr) {
          const draggedIds: string[] = [];
          for (const node of drag.draggedNodes) {
            const id = node.attrs.blockId as string | null;
            if (id) draggedIds.push(id);
          }
          if (draggedIds.length > 0) {
            tr.setMeta(BLOCK_ANIMATOR_SKIP_IDS, draggedIds);
          }
          const movingUp = drag.targetSlotIdx < drag.sourceSlotIdx;
          const scroller = movingUp
            ? editorView.dom.closest(".butter-editor-view") : null;
          const anchorDom = scroller ? findScrollAnchor(editorView, drag) : null;
          const anchorTopBefore = anchorDom?.getBoundingClientRect().top ?? 0;
          editorView.dispatch(tr);
          if (scroller && anchorDom) {
            const anchorTopAfter = anchorDom.getBoundingClientRect().top;
            const drift = anchorTopAfter - anchorTopBefore;
            if (Math.abs(drift) > 2) {
              scroller.scrollTop += drift;
            }
          }
        }
        // Cleanup reflow stylesheet + dragIdx attrs now that DOM is
        // in its new order. Source class STAYS — block is invisible
        // at its new position so the ghost can land on it without
        // both being visible simultaneously.
        cleanupReflowStyles(drag);
        for (const ctxKey of drag.stampedContainerKeys) {
          const sibs = drag.siblingsByContainer.get(ctxKey);
          if (sibs) clearDragIndexes(editorView, sibs);
        }
        drag.stampedContainerKeys.clear();
        if (drag.paddedContextDom) {
          suppressObserver(editorView, () => {
            drag.paddedContextDom!.style.removeProperty("padding-bottom");
          });
          drag.paddedContextDom = null;
        }

        // Read where the block ACTUALLY landed AND collect the
        // freshly-mounted DOM nodes for the inserted blocks. Match by
        // blockId — positions in the new doc differ from the old, and
        // the new DOM nodes are different elements than draggedDoms
        // (which may be detached). Apply `butter-drag-source` to the
        // new DOMs immediately so they stay invisible until the ghost
        // finishes its slide.
        //
        // landRect is captured BEFORE the WAAPI margin-settle below
        // starts. While the WAAPI runs it overrides the inline mt
        // back to the OLD value for the duration of the animation,
        // which would otherwise shift the layout and make
        // getBoundingClientRect return a mid-animation position.
        // Capturing here means landRect = the post-animation final
        // resting position, which is what the ghost slide should
        // target.
        const firstId = drag.draggedNodes[0]?.attrs?.blockId as string | null;
        let landRect: DOMRect | null = null;
        const landedDoms: HTMLElement[] = [];
        const draggedIdSet = new Set<string>();
        for (const node of drag.draggedNodes) {
          const id = node.attrs.blockId as string | null;
          if (id) draggedIdSet.add(id);
        }
        editorView.state.doc.descendants((node, pos) => {
          const id = node.attrs?.blockId as string | null;
          if (!id || !draggedIdSet.has(id)) return;
          const dom = editorView.nodeDOM(pos);
          if (dom instanceof HTMLElement) {
            landedDoms.push(dom);
            if (!landRect && id === firstId) {
              landRect = dom.getBoundingClientRect();
            }
          }
        });
        suppressObserver(editorView, () => {
          for (const dom of landedDoms) {
            dom.classList.add("butter-drag-source");
          }
        });

        // Prefer the simulated landing over the (possibly stale)
        // measured landRect. The ghost slide and the drop-filler snap
        // below both read landRect, so this keeps them converging on
        // the same final position — the same one the during-drag
        // filler used, so there's no jump at the drop.
        if (predictedLand) {
          landRect = new DOMRect(
            predictedLand.left,
            predictedLand.top,
            predictedLand.width,
            landRect ? (landRect as DOMRect).height : predictedLand.height,
          );
        }

        // First-block margin settle now happens DURING the drag: the
        // reflow simulation (computeSameContainerShifts) drives the
        // idx-0 boundary blocks to their final margins as the target
        // crosses the top boundary, so by drop time they're already
        // settled. No post-drop margin animation needed.

        // Drop filler fade. Snap the filler to the actual landed
        // rect first — `positionDropFiller` ran during the drag with
        // the old margin values, so for first-block transitions it
        // ends up offset from where the block really lands by the
        // margin delta. Aligning to landRect (which we captured at
        // the post-drop natural position) makes the filler fade out
        // exactly where the block settles.
        const filler = drag.dropFiller;
        if (landRect) {
          filler.style.top = `${(landRect).top}px`;
          filler.style.left = `${(landRect).left}px`;
          filler.style.width = `${(landRect).width}px`;
          filler.style.height = `${(landRect).height}px`;
        }
        filler.animate(
          [{ opacity: parseFloat(getComputedStyle(filler).opacity) || 0.85 }, { opacity: 0 }],
          { duration: 120, easing: "ease-out", fill: "forwards" },
        ).onfinish = () => filler.remove();

        const finishConverge = () => {
          // Source class off both the (possibly stale) old draggedDoms
          // and the freshly-mounted landedDoms — block visible at its
          // landed position, ghost removed. Instant swap on slide end.
          suppressObserver(editorView, () => {
            for (const dom of drag.draggedDoms) {
              dom.classList.remove("butter-drag-source");
              dom.classList.remove("butter-drag-source-collapsed");
            }
            for (const dom of landedDoms) {
              dom.classList.remove("butter-drag-source");
              dom.classList.remove("butter-drag-source-collapsed");
            }
          });
          drag.ghost.remove();
          activeDocument.body.style.removeProperty("--butter-drag-spring");
          activeDocument.body.style.removeProperty("--butter-drag-spring-soft");
          activeDocument.body.style.removeProperty("--butter-drag-ease");
          finishDrag();
        };

        if (landRect) {
          // Ghost slides from release position to landing position
          // at full opacity. On finish, source class comes off and
          // ghost is removed — block pops in, ghost pops out, same
          // frame.
          const startX = ghostStart.left;
          const startY = ghostStart.top;
          // Depth-change shift: the ghost's cloned list_item still
          // carries the SOURCE depth's padding-left. The dropped
          // block has the TARGET depth's padding-left. List-item
          // BCRs sit at the container's left edge regardless of
          // depth (indentation comes from padding-left INSIDE the
          // box), so landRect.left is identical for any depth.
          // Slide the ghost's outer wrapper by `(target-source) *
          // indent` so the clone's content (still at source padding)
          // ends up aligned with where the dropped block's content
          // will render — no horizontal "fall back to old depth"
          // jump at converge.
          const depthShift =
            drag.sourceDepth != null &&
            drag.targetDepth != null &&
            drag.listIndentPx > 0
              ? (drag.targetDepth - drag.sourceDepth) * drag.listIndentPx
              : 0;
          const endX = (landRect).left + depthShift;
          const endY = (landRect).top;
          const motion = DRAG_MOTIONS[config.dragMotion()] ?? DRAG_MOTIONS.springy;
          const slide = drag.ghost.animate(
            [
              { transform: `translate3d(${startX}px,${startY}px,0)` },
              { transform: `translate3d(${endX}px,${endY}px,0)` },
            ],
            { duration: SETTLE_MS, easing: motion.soft, fill: "forwards" },
          );
          slide.onfinish = finishConverge;
          slide.oncancel = finishConverge;
        } else {
          finishConverge();
        }
      };



      function cleanupReflowStyles(drag: LiveDragState): void {
        drag.styleEl.remove();
        clearShiftedTransforms(editorView, drag);
      }

      function cleanupDragAttrs(drag: LiveDragState): void {
        for (const ctxKey of drag.stampedContainerKeys) {
          const sibs = drag.siblingsByContainer.get(ctxKey);
          if (sibs) clearDragIndexes(editorView, sibs);
        }
        drag.stampedContainerKeys.clear();
        suppressObserver(editorView, () => {
          for (const dom of drag.draggedDoms) {
            dom.classList.remove("butter-drag-source");
            dom.classList.remove("butter-drag-source-collapsed");
          }
          if (drag.paddedContextDom) {
            drag.paddedContextDom.style.removeProperty("padding-bottom");
            drag.paddedContextDom = null;
          }
        });
      }

      // ── Cancel (no animation) ──
      function cancelDrag(): void {
        if (phase.kind === "armed") {
          cleanupArmListeners();
          phase = { kind: "idle" };
          return;
        }
        if (phase.kind !== "dragging") return;
        const drag = phase.drag;
        cleanupDragListeners();
        phase = { kind: "settling" };

        // Sibs animate back to natural: cleanupReflowStyles clears
        // their inline transform while butter-is-dragging is still on
        // the body, so the static transition rule fires (translateY(N)
        // to none). The body class comes off below, after this.
        cleanupReflowStyles(drag);
        cleanupDragAttrs(drag);

        // Drop filler fades out instead of vanishing.
        const filler = drag.dropFiller;
        filler.animate(
          [{ opacity: parseFloat(getComputedStyle(filler).opacity) || 0.85 }, { opacity: 0 }],
          { duration: 120, easing: "ease-out", fill: "forwards" },
        ).onfinish = () => filler.remove();

        // Ghost slides back to the source slot (where the user
        // grabbed from) and fades out — settling back into the page.
        activeDocument.body.classList.remove("butter-is-dragging");
        activeDocument.body.dataset.butterDragEndedAt = String(Date.now());
        const ghostStart = drag.ghost.getBoundingClientRect();
        const sourceRect = drag.draggedDoms[0]?.getBoundingClientRect();
        const motion = DRAG_MOTIONS[config.dragMotion()] ?? DRAG_MOTIONS.springy;
        const finishCancel = () => {
          drag.ghost.remove();
          activeDocument.body.style.removeProperty("--butter-drag-spring");
          activeDocument.body.style.removeProperty("--butter-drag-spring-soft");
          activeDocument.body.style.removeProperty("--butter-drag-ease");
          finishDrag();
        };
        if (sourceRect) {
          const anim = drag.ghost.animate(
            [
              { transform: `translate3d(${ghostStart.left}px,${ghostStart.top}px,0)`, opacity: 0.88, offset: 0 },
              { opacity: 0.88, offset: 0.6 },
              { transform: `translate3d(${sourceRect.left}px,${sourceRect.top}px,0)`, opacity: 0, offset: 1 },
            ],
            { duration: 240, easing: motion.soft, fill: "forwards" },
          );
          anim.onfinish = finishCancel;
          anim.oncancel = finishCancel;
        } else {
          finishCancel();
        }
      }

      const onCancel = () => cancelDrag();

      const onDragKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          cancelDrag();
        }
      };

      function cleanupDragListeners(): void {
        window.removeEventListener("pointermove", onLiveMove);
        window.removeEventListener("pointerup", onLiveUp);
        window.removeEventListener("pointercancel", onCancel);
        activeDocument.removeEventListener("keydown", onDragKeyDown);
        if (Platform.isMobile) {
          window.removeEventListener("touchmove", swallowTouchEvent, { capture: true });
          window.removeEventListener("touchstart", swallowTouchEvent, { capture: true });
          window.removeEventListener("touchend", swallowTouchEvent, { capture: true });
        }
        stopAutoscroll();
      }

      function finishDrag(): void {
        activeDocument.body.classList.remove("butter-is-dragging");
        activeDocument.body.dataset.butterDragEndedAt = String(Date.now());
        activeDocument.body.style.removeProperty("--butter-drag-spring");
        activeDocument.body.style.removeProperty("--butter-drag-spring-soft");
        activeDocument.body.style.removeProperty("--butter-drag-ease");
        phase = { kind: "idle" };

        // Re-show handles
        if (currentMode === "always") {
          alwaysLayer?.update(editorView, chromeY());
        }
      }

      // ── Autoscroll ──
      // Grace + ramp: when the pointer enters the edge zone, the
      // first AUTOSCROLL_GRACE_MS yields zero scroll, then velocity
      // ramps to full over AUTOSCROLL_RAMP_MS. This gives the user
      // time to trigger a single-slot swap on a tall block (whose
      // up-trigger condition lives inside the edge zone) and move
      // back out before any scrolling actually fires. Leaving the
      // zone resets the timer — a wiggle out and back in restarts
      // the grace period.
      // 0.9.9-style autoscroll: quadratic distance falloff, no
      // grace, no ramp. Speed = (1 - dist/edge)² × max-per-second
      // — at the edge: max; halfway in: ¼ max; at boundary: 0.
      // Time-based so refresh rate doesn't change the feel.
      function startAutoscroll(): void {
        if (autoscrollRAF) return;
        let lastTickAt = 0;
        const tick = () => {
          if (phase.kind !== "dragging") {
            autoscrollRAF = 0;
            return;
          }
          const drag = phase.drag;
          const scroller = drag.scroller;
          const r = drag.scrollerRect;
          if (scroller && r) {
            const topDist = drag.lastPointerY - r.top;
            const botDist = r.bottom - drag.lastPointerY;
            const now = performance.now();
            const frameMs = lastTickAt > 0 ? Math.min(50, now - lastTickAt) : 16;
            lastTickAt = now;
            const frameMax = AUTOSCROLL_MAX_PX_PER_SECOND * (frameMs / 1000);
            let speed = 0;
            if (topDist < AUTOSCROLL_EDGE_PX) {
              speed = -Math.pow(1 - topDist / AUTOSCROLL_EDGE_PX, 2) * frameMax;
            } else if (botDist < AUTOSCROLL_EDGE_PX) {
              speed = Math.pow(1 - botDist / AUTOSCROLL_EDGE_PX, 2) * frameMax;
            }
            if (speed !== 0) {
              activeDocument.body.classList.add("butter-drag-autoscrolling");
              scroller.scrollTop += speed;
            } else {
              activeDocument.body.classList.remove("butter-drag-autoscrolling");
            }
            // Run reflow every frame even if not scrolling. This continuously
            // monitors for asynchronous DOM mutations from Obsidian's Markdown 
            // PostProcessors (e.g. Prism loaders finishing) and instantly heals 
            // the layout by reapplying transforms to newly mounted DOM nodes.
            updateReflow(drag, drag.lastPointerX, speed !== 0 ? speed : 0);
          }
          autoscrollRAF = window.requestAnimationFrame(tick);
        };
        autoscrollRAF = window.requestAnimationFrame(tick);
      }

      function stopAutoscroll(): void {
        if (autoscrollRAF) {
          cancelAnimationFrame(autoscrollRAF);
          autoscrollRAF = 0;
        }
        activeDocument.body.classList.remove("butter-drag-autoscrolling");
      }

      // ── Scroll/resize reposition (for handles) ──
      const onScroll = () => {
        if (phase.kind === "idle" && currentMode === "always") {
          alwaysLayer?.update(editorView, chromeY());
        } else if (phase.kind === "idle" && currentMode === "hover" && currentHit) {
          const dom = editorView.nodeDOM(currentHit.pos);
          if (dom instanceof HTMLElement) {
            const rect = dom.getBoundingClientRect();
            currentHit = { ...currentHit, rect };
            showHoverHandle(currentHit);
          }
        }
      };

      const scrollHosts: HTMLElement[] = [];
      let p: HTMLElement | null = host;
      while (p) {
        scrollHosts.push(p);
        p = p.parentElement;
      }
      // Cheap separate listener that records the last scroll time
      // for the tap-during-momentum-scroll guard in onTouchPressEnd.
      const onAnyScroll = () => { lastScrollAtMs = Date.now(); };
      for (const sh of scrollHosts) {
        sh.addEventListener("scroll", onScroll, { passive: true });
        sh.addEventListener("scroll", onAnyScroll, { passive: true });
      }
      window.addEventListener("resize", onScroll);

      // Window blur → cancel drag
      const onWindowBlur = () => {
        if (phase.kind === "armed" || phase.kind === "dragging") {
          cancelDrag();
        }
      };
      window.addEventListener("blur", onWindowBlur);

      // ── Always-mode layer event delegation ──
      // The layer intercepts pointerdown on any child handle.
      if (alwaysLayer) {
        alwaysLayer.layer.addEventListener(
          "pointerdown",
          onLayerPointerDown,
        );
      }

      return {
        update(view, prevState) {
          ensureMode();

          // Doc or selection changed → revalidate
          if (phase.kind === "dragging") {
              if (view.state.doc !== prevState.doc) {
                cancelDrag();
                return;
              } else {
                const p = phase;
                window.requestAnimationFrame(() => {
                  if (phase === p) {
                    updateReflow(p.drag, p.drag.lastPointerX, 0);
                  }
                });
              }
            }

          if (phase.kind !== "idle") return;

          if (currentMode === "always") {
            if (
              !view.state.doc.eq(prevState.doc) ||
              !view.state.selection.eq(prevState.selection)
            ) {
              alwaysLayer?.update(view, chromeY());
            }
          } else if (currentHit) {
            const node = view.state.doc.nodeAt(currentHit.pos);
            if (!node || node.type !== currentHit.node.type) {
              currentHit = null;
              hideHoverHandle();
            } else {
              // Block still exists but may have moved (BSP re-applied
              // margins, neighbor edits shifted layout, etc.). Re-read
              // its position so the handle stays attached to the block.
              const dom = view.nodeDOM(currentHit.pos);
              if (dom instanceof HTMLElement) {
                const rect = dom.getBoundingClientRect();
                currentHit = { ...currentHit, node, dom, rect };
                showHoverHandle(currentHit);
              }
            }
          }
        },
        destroy() {
          hoverHandle.remove();
          alwaysLayer?.destroy();
          cleanupArmListeners();
          if (phase.kind === "dragging") {
            cleanupDragListeners();
            phase.drag.ghost.remove();
            phase.drag.dropFiller.remove();
            cleanupReflowStyles(phase.drag);
            cleanupDragAttrs(phase.drag);
          }
          activeDocument.body.classList.remove("butter-is-dragging");
          activeDocument.body.dataset.butterDragEndedAt = String(Date.now());
          activeDocument.body.style.removeProperty("--butter-drag-spring");
          activeDocument.body.style.removeProperty("--butter-drag-spring-soft");
          activeDocument.body.style.removeProperty("--butter-drag-ease");
          for (const sh of scrollHosts) {
            sh.removeEventListener("scroll", onScroll);
            sh.removeEventListener("scroll", onAnyScroll);
          }
          window.removeEventListener("resize", onScroll);
          window.removeEventListener("blur", onWindowBlur);
          if (hoverThrottleRAF) cancelAnimationFrame(hoverThrottleRAF);
          stopAutoscroll();
          if (activeMenu) {
            try { activeMenu.hide(); } catch { /* */ }
          }
          activeDocument.removeEventListener("pointermove", onEditorPointerMove);
          editorView.dom.removeEventListener("pointerdown", onEditorTouchDown);
          cleanupTouchPressListeners();
        },
      };
    },
  });
}

