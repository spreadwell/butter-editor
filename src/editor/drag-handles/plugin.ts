import { openBlockContextMenu } from "./menu";
import { DragHandlesConfig, DragPhase, BlockHit, DragContext } from "./types";
import {
  HANDLE_OFFSET_LEFT,
  HANDLE_WIDTH,
  DRAG_THRESHOLD,
  TOUCH_LONGPRESS_MOVE_PX,
  TOUCH_LONGPRESS_MS,
} from "./constants";
import {
  collectSiblings,
  handlePlacementFor,
  listItemHandleInset,
  isContainer,
  findBlockUnderPointer,
  findContainerContext,
} from "./utils";
import { createHandleEl } from "./handle-dom";
import {
  Plugin as PMPlugin,
  PluginKey,
  NodeSelection,
  TextSelection,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { Menu } from "obsidian";
import {
  getMultiBlockSelection,
  dispatchMultiBlock,
  computeScopeSelection,
  listTopLevelBlockPositions,
  openMultiBlockContextMenu,
} from "../multi-block-select";
import { computeListSubtree } from "../list-depth";
import { blockSelectionBounds } from "../block-selection-geometry";
import { EXPLICIT_SELECTION_META } from "../selection-overlay";
import {
  getCollapsedHeadingSectionPositions,
  headingFoldKey,
} from "../heading-folding";
import { DragSceneRuntime } from "../drag-scene-v2/runtime";

const INLINE_TAP_TARGET_SELECTOR = [
  ".butter-external-link",
  ".butter-wikilink",
  ".butter-tag",
  ".butter-obsidian-embed",
  ".butter-inline-math-view",
  ".butter-footnote-ref",
].join(", ");

function clampHandleRailLeft(view: EditorView, desiredLeft: number): number {
  const pane = view.dom.closest(".workspace-leaf");
  const paneLeft = pane instanceof HTMLElement
    ? pane.getBoundingClientRect().left
    : 0;
  return Math.max(desiredLeft, paneLeft);
}

function eventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

// Constants


export class HandleLayer {
  readonly layer: HTMLElement;
  private pool: HTMLElement[] = [];
  private activeCount = 0;

  constructor(private readonly ownerDocument: Document) {
    this.layer = ownerDocument.win.createDiv();
    this.layer.className = "butter-drag-handles-layer";
    ownerDocument.body.appendChild(this.layer);
  }

  private acquire(idx: number): HTMLElement {
    while (this.pool.length <= idx) {
      const h = createHandleEl(this.ownerDocument);
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
        // INHERENT to the quote - the blockquote's own handle covers
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
      handle.style.left = `${clampHandleRailLeft(view, block.rect.left + block.inset - HANDLE_OFFSET_LEFT)}px`;
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

// Main plugin

export const pluginKey = new PluginKey("butter-drag-handles");

export function dragHandlesPlugin(config: DragHandlesConfig): PMPlugin {
  return new PMPlugin({
    key: pluginKey,
    view(editorView) {
      const host = editorView.dom.parentElement!;
      if (!host) return { destroy() {} };
      const viewDocument = editorView.dom.ownerDocument;
      const ownerWindow = viewDocument.defaultView;
      if (!ownerWindow) return { destroy() {} };
      const viewWindow = ownerWindow;
      // Obsidian's global activeDocument/activeWindow can change whenever a
      // Settings or popout window receives focus. Pin every drag listener,
      // timer, and presentation surface to this ProseMirror view instead.
      const activeDocument = viewDocument;
      const activeWindow = viewWindow;
      const window = viewWindow;

      // State
      let phase: DragPhase = { kind: "idle" };
      let currentHit: BlockHit | null = null;
      let pointerCaptureTarget: HTMLElement | null = null;
      let capturedPointerId = -1;
      let activeMenu: Menu | null = null;
      let cancelPendingMultiMenu: (() => void) | null = null;
      let v2Runtime: DragSceneRuntime | null = null;

      const chromeY = () => config.chromeBottom?.() ?? 0;

      const capturePointer = (target: HTMLElement, pointerId: number): void => {
        try {
          target.setPointerCapture(pointerId);
          pointerCaptureTarget = target;
          capturedPointerId = pointerId;
        } catch {
          pointerCaptureTarget = null;
          capturedPointerId = -1;
        }
      };

      const releaseCapturedPointer = (): void => {
        const target = pointerCaptureTarget;
        const pointerId = capturedPointerId;
        pointerCaptureTarget = null;
        capturedPointerId = -1;
        if (!target) return;
        try {
          if (target.hasPointerCapture?.(pointerId)) {
            target.releasePointerCapture(pointerId);
          }
        } catch { /* pointer may already have ended */ }
      };

      // Handle elements
      // Mounted on document.body for correct position:fixed coords
      // (host ancestors may have transforms that break fixed positioning).
      const hoverHandle = createHandleEl(viewDocument);
      activeDocument.body.appendChild(hoverHandle);
      const selectorPreview = activeWindow.createDiv({
        cls: "butter-handle-selector-preview",
      });
      selectorPreview.setAttribute("aria-hidden", "true");
      activeDocument.body.appendChild(selectorPreview);
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
            alwaysLayer = new HandleLayer(viewDocument);
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
        alwaysLayer = new HandleLayer(viewDocument);
        // Defer initial update so the editor has rendered
        window.requestAnimationFrame(() => alwaysLayer?.update(editorView, chromeY()));
      }

      function hideSelectorPreview(): void {
        selectorPreview.classList.remove("is-visible");
      }

      function suppressHoverDuringImageManipulation(): boolean {
        if (
          !activeDocument.body.classList.contains("butter-is-image-resizing") &&
          !activeDocument.body.classList.contains("butter-is-image-dragging")
        ) {
          return false;
        }
        currentHit = null;
        if (currentMode === "hover") hideHoverHandle();
        hideSelectorPreview();
        return true;
      }

      function showSelectorPreview(blockPos: number): void {
        if (phase.kind !== "idle") return;
        const node = editorView.state.doc.nodeAt(blockPos);
        const positions = node?.type.name === "list_item"
          ? computeListSubtree(editorView.state, blockPos)
          : [blockPos];
        let minTop = Infinity;
        let maxBottom = -Infinity;
        let minLeft = Infinity;
        let maxRight = -Infinity;
        let firstDom: HTMLElement | null = null;
        for (const pos of positions) {
          const dom = editorView.nodeDOM(pos);
          if (!(dom instanceof viewWindow.HTMLElement)) continue;
          if (!firstDom) firstDom = dom;
          const rect = blockSelectionBounds(dom, viewWindow);
          minTop = Math.min(minTop, rect.top);
          maxBottom = Math.max(maxBottom, rect.bottom);
          minLeft = Math.min(minLeft, rect.left);
          maxRight = Math.max(maxRight, rect.right);
        }
        if (!firstDom || !Number.isFinite(minTop)) return;
        const inset = 9;
        selectorPreview.style.left = `${minLeft - inset}px`;
        selectorPreview.style.top = `${minTop - inset}px`;
        selectorPreview.style.width = `${maxRight - minLeft + inset * 2}px`;
        selectorPreview.style.height = `${maxBottom - minTop + inset * 2}px`;
        selectorPreview.classList.add("is-visible");
      }

      const ownedHandle = (target: EventTarget | null): HTMLElement | null => {
        const handle = target instanceof Element
          ? target.closest<HTMLElement>(".butter-drag-handle")
          : null;
        if (!handle) return null;
        if (handle === hoverHandle || alwaysLayer?.layer.contains(handle)) return handle;
        return null;
      };
      const onHandlePointerOver = (event: PointerEvent) => {
        if (suppressHoverDuringImageManipulation()) return;
        const handle = ownedHandle(event.target);
        if (!handle) return;
        const pos = Number.parseInt(handle.dataset.blockPos ?? "", 10);
        if (Number.isFinite(pos)) showSelectorPreview(pos);
      };
      const onHandlePointerOut = (event: PointerEvent) => {
        const handle = ownedHandle(event.target);
        if (!handle || handle.contains(event.relatedTarget as Node | null)) return;
        hideSelectorPreview();
      };
      activeDocument.addEventListener("pointerover", onHandlePointerOver);
      activeDocument.addEventListener("pointerout", onHandlePointerOut);

      // Handle positioning (hover mode)
      function showHoverHandle(hit: BlockHit): void {
        const inset = listItemHandleInset(hit.node, hit.dom);
        const placement = handlePlacementFor(hit.node, hit.dom, hit.rect);
        const top = placement.top;
        const chromeY = config.chromeBottom?.() ?? 0;
        if (top < chromeY) { hideHoverHandle(); return; }
        hoverHandle.style.left = `${clampHandleRailLeft(editorView, hit.rect.left + inset - HANDLE_OFFSET_LEFT)}px`;
        hoverHandle.style.top = `${top}px`;
        hoverHandle.style.height = `${placement.height}px`;
        hoverHandle.dataset.blockPos = String(hit.pos);
        hoverHandle.classList.add("is-visible");
        hoverHandle.show();
      }

      function hideHoverHandle(): void {
        hoverHandle.classList.remove("is-visible");
      }

      // Hover detection
      // Listen on the document so the gutter area (where the handle
      // lives, OUTSIDE editorView.dom) gets pointermove events too.
      // Filter to only react when the pointer is within the editor's
      // bounding rect (extended HANDLE_OFFSET_LEFT px to the left
      // for the gutter zone).
      let hoverThrottleRAF = 0;
      const HOVER_GUTTER_PAD = HANDLE_OFFSET_LEFT + HANDLE_WIDTH;
      const TOOLBAR_SURFACE_SELECTOR = [
        ".butter-toolbar",
        ".butter-context-toolbar",
        ".butter-toolbar-submenu-popup",
        ".butter-mobile-bar",
      ].join(", ");
      const isToolbarSurfaceTarget = (target: EventTarget | null): boolean =>
        target instanceof viewWindow.Element &&
        Boolean(target.closest(TOOLBAR_SURFACE_SELECTOR));
      const clearHoverChrome = (): void => {
        currentHit = null;
        if (currentMode === "hover") hideHoverHandle();
        hideSelectorPreview();
      };
      const onEditorPointerMove = (e: PointerEvent) => {
        if (phase.kind !== "idle") return;
        if (suppressHoverDuringImageManipulation()) return;
        // Toolbars can overlay the editor's geometric bounds. Suppress before
        // throttling so a queued editor hover cannot repaint under the toolbar.
        if (isToolbarSurfaceTarget(e.target)) {
          if (hoverThrottleRAF) {
            viewWindow.cancelAnimationFrame(hoverThrottleRAF);
            hoverThrottleRAF = 0;
          }
          clearHoverChrome();
          return;
        }
        if (hoverThrottleRAF) return;
        hoverThrottleRAF = viewWindow.requestAnimationFrame(() => {
          hoverThrottleRAF = 0;
          if (phase.kind !== "idle") return;
          if (suppressHoverDuringImageManipulation()) return;
          // Is the pointer near the editor area (incl. gutter)?
          const er = editorView.dom.getBoundingClientRect();
          const inX = e.clientX >= er.left - HOVER_GUTTER_PAD && e.clientX <= er.right;
          const inY = e.clientY >= er.top && e.clientY <= er.bottom;
          if (!inX || !inY) {
            if (currentHit) {
              currentHit = null;
              if (currentMode === "hover") hideHoverHandle();
            }
            if (!ownedHandle(e.target)) hideSelectorPreview();
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
            const target = e.target;
            const imageBody = target instanceof viewWindow.Element
              ? target.closest(".butter-image, .butter-embed-image-resizable")
              : null;
            if (imageBody && editorView.dom.contains(imageBody)) {
              showSelectorPreview(hit.pos);
            } else if (!ownedHandle(target)) {
              hideSelectorPreview();
            }
          } else {
            currentHit = null;
            if (currentMode === "hover") hideHoverHandle();
            if (!ownedHandle(e.target)) hideSelectorPreview();
          }
        });
      };

      activeDocument.addEventListener("pointermove", onEditorPointerMove);

      // Handle interaction (pointerdown)
      // Handles all click gestures: plain, Ctrl, Shift, double-click.
      // Modifier/double-click dispatch multi-block actions and return
      // without arming a drag. Plain clicks arm the drag threshold.
      const DBLCLICK_MS = 500;
      const DBLCLICK_PX = 6;
      let lastHandleClickX = -1;
      let lastHandleClickY = -1;
      let lastHandleClickTime = 0;

      const scheduleMultiMenuOnPointerUp = (
        handle: HTMLElement,
        blockPos: number,
        pointerId: number,
      ): void => {
        cancelPendingMultiMenu?.();
        let frame = 0;
        const cleanup = () => {
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onCancel, true);
          if (frame) window.cancelAnimationFrame(frame);
          if (cancelPendingMultiMenu === cleanup) cancelPendingMultiMenu = null;
        };
        const onCancel = (event: PointerEvent) => {
          if (event.pointerId === pointerId) cleanup();
        };
        const onUp = (event: PointerEvent) => {
          if (event.pointerId !== pointerId) return;
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onCancel, true);
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            if (cancelPendingMultiMenu === cleanup) cancelPendingMultiMenu = null;
            const multi = getMultiBlockSelection(editorView.state);
            if (
              multi.positions.length < 2 ||
              !multi.positions.includes(blockPos)
            ) return;
            if (activeMenu) {
              try { activeMenu.hide(); } catch { /* */ }
              activeMenu = null;
            }
            activeMenu = openMultiBlockContextMenu(
              config.app,
              editorView,
              handle,
              blockPos,
              multi.positions,
              config.serializeNode,
            );
            const menu = activeMenu;
            menu.onHide(() => {
              if (activeMenu === menu) activeMenu = null;
            });
          });
        };
        cancelPendingMultiMenu = cleanup;
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onCancel, true);
      };

      const onHandlePointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (phase.kind !== "idle") return;
        if (suppressHoverDuringImageManipulation()) return;

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

        // Modifier / double-click gestures
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
          scheduleMultiMenuOnPointerUp(handle, blockPos, e.pointerId);
          window.requestAnimationFrame(hideSelectorPreview);
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
          scheduleMultiMenuOnPointerUp(handle, blockPos, e.pointerId);
          window.requestAnimationFrame(hideSelectorPreview);
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
          scheduleMultiMenuOnPointerUp(handle, blockPos, e.pointerId);
          window.requestAnimationFrame(hideSelectorPreview);
          e.preventDefault();
          return;
        }

        // Plain click -> arm drag
        const blockDom = editorView.nodeDOM(blockPos);
        if (!(blockDom instanceof HTMLElement)) return;
        const blockRect = blockDom.getBoundingClientRect();

        // Exclude the block itself from the container search - for a
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

        capturePointer(handle, e.pointerId);

        window.addEventListener("pointermove", onArmMove);
        window.addEventListener("pointerup", onArmUp);
        window.addEventListener("pointercancel", onArmCancel);
        e.preventDefault();
      };

      // Listen on the hoverHandle directly AND on the always-layer via delegation
      hoverHandle.addEventListener("pointerdown", onHandlePointerDown);

      // Delegation for always-mode layer handles
      const onLayerPointerDown = (e: PointerEvent) => {
        onHandlePointerDown(e);
      };

      // Armed phase
      const onArmMove = (e: PointerEvent) => {
        if (phase.kind !== "armed") return;
        if (e.pointerId !== phase.pointerId) return;
        const dx = Math.abs(e.clientX - phase.startX);
        const dy = Math.abs(e.clientY - phase.startY);
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
        promoteToDrag(e);
      };

      const onArmUp = (e: PointerEvent) => {
        if (phase.kind !== "armed") return;
        if (e.pointerId !== phase.pointerId) return;
        cleanupArmListeners();
        releaseCapturedPointer();

        const { hitPos } = phase;
        phase = { kind: "idle" };

        const hitNode = editorView.state.doc.nodeAt(hitPos);
        if (!hitNode) {
          hideSelectorPreview();
          return;
        }

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
            const menu = activeMenu;
            menu.onHide(() => {
              if (activeMenu === menu) activeMenu = null;
            });
          }
          window.requestAnimationFrame(hideSelectorPreview);
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
        // came from a deliberate user action - overrides the
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
        // The selection overlay is painted synchronously by the dispatches
        // above. Keep the one-pixel hover footprint underneath until the
        // next frame so the stronger selection border appears to grow from it.
        window.requestAnimationFrame(hideSelectorPreview);

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
          const menu = activeMenu;
          menu.onHide(() => {
            if (activeMenu === menu) activeMenu = null;
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
          const el = alwaysLayer.layer.querySelector<HTMLElement>(
            `.butter-drag-handles-layer .butter-drag-handle[data-block-pos="${pos}"]`,
          );
          if (el) return el;
        }
        return hoverHandle;
      }

      function cleanupArmListeners(): void {
        window.removeEventListener("pointermove", onArmMove);
        window.removeEventListener("pointerup", onArmUp);
        window.removeEventListener("pointercancel", onArmCancel);
      }

      // Touch: long-press to start drag
      // No hover on touch - handles aren't a useful affordance. Press
      // and hold ANY block to start dragging. A quick tap or any
      // pre-timeout movement falls through to PM (cursor placement /
      // browser scroll).
      let touchPressTimer = 0;
      let touchPressStartX = 0;
      let touchPressStartY = 0;
      let touchPressLastX = 0;
      let touchPressLastY = 0;
      let touchPressPointerId = -1;
      let touchPressPromoting = false;
      // Tracks the last time a scroll event fired anywhere up the
      // editor's ancestor chain. The unlock-on-tap path consults this
      // so a "tap to stop momentum scroll" gesture (which fires a
      // pointerdown/up with tiny movement, indistinguishable from a
      // real tap) doesn't trip into edit mode. 300ms covers iOS-style
      // momentum tails without being long enough to feel laggy on
      // intentional taps after a brief scroll.
      let lastScrollAtMs = 0;
      const SCROLL_TAP_GUARD_MS = 300;
      // A non-passive touch guard must already belong to the active touch
      // sequence before post-long-press movement begins. Installing it only
      // after the timer fires can let iOS hand the first movement to native
      // panning and cancel the pointer before Drag Scene sees it.
      const onTouchPressNativeMove = (event: TouchEvent): void => {
        if (touchPressPromoting || phase.kind === "settling") {
          event.preventDefault();
        }
      };
      // iOS may present its native text/form-control callout after the drag
      // timer has already promoted. Nested list paragraphs and task-checkbox
      // chrome are especially prone to that takeover. Suppress contextmenu
      // only while Butter owns an armed or active drag gesture; normal mobile
      // text selection continues through the editor context-menu bridge.
      const onTouchDragContextMenu = (event: MouseEvent): void => {
        if (
          touchPressTimer === 0 &&
          !touchPressPromoting &&
          phase.kind === "idle"
        ) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const removeTouchPressNativeGuard = (): void => {
        window.removeEventListener("touchmove", onTouchPressNativeMove, true);
      };
      const cleanupTouchPressListeners = (
        keepNativeGuard = false,
      ): void => {
        window.removeEventListener("pointermove", onTouchPressMove);
        window.removeEventListener("pointerup", onTouchPressEnd);
        window.removeEventListener("pointercancel", onTouchPressEnd);
        if (!keepNativeGuard) removeTouchPressNativeGuard();
        if (touchPressTimer) {
          window.clearTimeout(touchPressTimer);
          touchPressTimer = 0;
        }
      };
      // Keep the guard inert during the 400ms intent window, then claim the
      // first post-promotion move. DragSceneRuntime installs its equivalent
      // listener synchronously before this handoff guard leaves.
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
        const targetEl = eventTargetElement(e.target);
        // Callout header / title is the natural "grab here" zone for
        // dragging a callout. Allow long-press arming there even when
        // the editor is focused - the alternative is "callouts are
        // un-draggable on mobile once you've focused anything," which
        // is what the user was hitting.
        const onCalloutChrome =
          targetEl?.closest?.(".butter-callout-header") != null;
        // Don't fight native text selection while the editor is actively
        // editable and focused. iOS may retain a stale activeElement after
        // Butter has synchronously locked the editor for keyboard dismissal;
        // focus alone must not make every block permanently undraggable.
        if (
          !onCalloutChrome &&
          editorView.editable &&
          editorView.dom.contains(activeDocument.activeElement)
        ) return;
        // Skip clicks on the handle itself - handle has its own
        // pointerdown listener.
        if (targetEl?.closest?.(".butter-drag-handle")) return;
        // Inline links/atoms own their mobile tap. Do not let the
        // generic "first tap focuses editor" path unlock editable
        // mode and briefly summon the Android keyboard.
        if (targetEl?.closest?.(INLINE_TAP_TARGET_SELECTOR)) return;

        // For callout-header touches, target the CALLOUT NODE itself
        // (not a child block inside it). Without this, findBlockUnder-
        // Pointer's nearest-child fallback grabs the first nested
        // block because the header is "above" the children's vertical
        // midpoints - so long-pressing the header would arm a drag on
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
        window.addEventListener("touchmove", onTouchPressNativeMove, {
          passive: false,
          capture: true,
        });

        touchPressTimer = window.setTimeout(() => {
          touchPressTimer = 0;
          cleanupTouchPressListeners(true);
          if (phase.kind !== "idle") {
            removeTouchPressNativeGuard();
            return;
          }
          // Re-check focus at fire time - user may have tapped into
          // a contenteditable while the timer was running.
          if (
            editorView.editable &&
            editorView.dom.contains(activeDocument.activeElement)
          ) {
            removeTouchPressNativeGuard();
            return;
          }
          const liveNode = editorView.state.doc.nodeAt(hit.pos);
          if (!liveNode) {
            removeTouchPressNativeGuard();
            return;
          }
          const blockDom = editorView.nodeDOM(hit.pos);
          if (!(blockDom instanceof HTMLElement)) {
            removeTouchPressNativeGuard();
            return;
          }
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
            hitNode: liveNode,
            grabOffsetX: startX - blockRect.left,
            grabOffsetY: startY - blockRect.top,
            context,
          };
          capturePointer(editorView.dom, pointerId);
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
          touchPressPromoting = true;
          try {
            promoteToDrag(fakeEvt);
          } finally {
            touchPressPromoting = false;
            removeTouchPressNativeGuard();
          }
        }, TOUCH_LONGPRESS_MS);
      };
      editorView.dom.addEventListener("pointerdown", onEditorTouchDown);
      editorView.dom.addEventListener(
        "contextmenu",
        onTouchDragContextMenu,
        true,
      );

      // Promote armed pointer to Drag Scene
      function promoteToDrag(e: PointerEvent): void {
        if (phase.kind !== "armed") return;
        if (e.pointerId !== phase.pointerId) return;
        hideSelectorPreview();
        // A click keeps the block menu available, but crossing the drag
        // threshold changes the interaction into direct manipulation. Remove
        // the now-obstructive menu immediately instead of leaving it over the
        // moving selection until pointerup/drop.
        cancelPendingMultiMenu?.();
        if (activeMenu) {
          const menu = activeMenu;
          activeMenu = null;
          try { menu.hide(); } catch { /* */ }
        }
        const armedPhase = phase;
        cleanupArmListeners();

        const liveArmedNode = editorView.state.doc.nodeAt(armedPhase.hitPos);
        if (!liveArmedNode) {
          phase = { kind: "idle" };
          releaseCapturedPointer();
          return;
        }
        const armed = { ...armedPhase, hitNode: liveArmedNode };

        if (editorView.state.doc.childCount <= 1 && !armed.context) {
          phase = { kind: "idle" };
          releaseCapturedPointer();
          return;
        }

        // Determine drag set
        const multi = getMultiBlockSelection(editorView.state);
        let draggedPositions: number[];
        let collapsedHeadingSection = false;
        const multiSelectionDrag =
          multi.positions.length >= 2 &&
          multi.positions.includes(armed.hitPos);
        if (multiSelectionDrag) {
          draggedPositions = [...multi.positions].sort((a, b) => a - b);
        } else if (armed.hitNode.type.name === "list_item") {
          draggedPositions = computeListSubtree(
            editorView.state,
            armed.hitPos,
          );
        } else if (armed.hitNode.type.name === "heading") {
          const section = getCollapsedHeadingSectionPositions(
            editorView.state,
            armed.hitPos,
          );
          collapsedHeadingSection = section.length > 1;
          draggedPositions = collapsedHeadingSection
            ? section
            : [armed.hitPos];
        } else {
          draggedPositions = [armed.hitPos];
        }

        const draggedNodes: PMNode[] = [];
        const draggedDoms: HTMLElement[] = [];
        for (const pos of draggedPositions) {
          const node = editorView.state.doc.nodeAt(pos);
          if (!node) continue;
          draggedNodes.push(node);
          const dom = editorView.nodeDOM(pos);
          if (dom instanceof HTMLElement) {
            draggedDoms.push(dom);
          }
        }

        if (draggedNodes.length === 0) {
          phase = { kind: "idle" };
          releaseCapturedPointer();
          return;
        }
        const dragOriginRect = draggedDoms[0]?.getBoundingClientRect();
        // A multi-selection ghost is rooted at its first selected block, even
        // when the user grabs another selected member. Measure the pointer in
        // that same coordinate space so pickup, hit-testing, filler placement,
        // and a return to the source slot all describe one rigid footprint.
        const dragGrabOffsetX = draggedPositions.length > 1 && dragOriginRect
          ? armed.startX - dragOriginRect.left
          : armed.grabOffsetX;
        const dragGrabOffsetY = draggedPositions.length > 1 && dragOriginRect
          ? armed.startY - dragOriginRect.top
          : armed.grabOffsetY;

        const firstNode = draggedNodes[0];
        let listIndentPx = 0;
        if (firstNode?.type.name === "list_item") {
          const computed = getComputedStyle(editorView.dom);
          const probe = activeWindow.createDiv();
          probe.style.cssText =
            `position:absolute;visibility:hidden;width:${computed.getPropertyValue("--list-indent") || "4ch"};`;
          editorView.dom.appendChild(probe);
          listIndentPx = probe.getBoundingClientRect().width || 32;
          probe.remove();
        }

        const sourceHandle = e.pointerType === "touch"
          ? null
          : findHandleForPos(armed.hitPos);
        const sourceHandleBounds = sourceHandle?.getBoundingClientRect();
        const handleRect = sourceHandleBounds &&
            sourceHandleBounds.width > 0 && sourceHandleBounds.height > 0
          ? {
              left: sourceHandleBounds.left,
              top: sourceHandleBounds.top,
              width: sourceHandleBounds.width,
              height: sourceHandleBounds.height,
            }
          : null;

        if (currentMode === "hover") hideHoverHandle();
        else alwaysLayer?.hideAll();
        phase = { kind: "settling" };
        currentHit = null;
        try {
          v2Runtime = new DragSceneRuntime(editorView, {
            pointerId: armed.pointerId,
            pointerType: e.pointerType,
            startClientX: e.clientX,
            startClientY: e.clientY,
            grabOffsetX: dragGrabOffsetX,
            grabOffsetY: dragGrabOffsetY,
            handleRect,
            draggedPositions,
            draggedNodes,
            triggerOffsetPx: config.dragTriggerOffset(),
            containerTriggerOffsetPx: config.containerDragTriggerOffset(),
            motionPreset: config.dragMotion(),
            listIndentPx,
            compactionTriggerPx: config.dragCompactionTriggerPx(),
            compactedHeightPx: config.dragCompactedHeightPx(),
            mouseReleaseProtection: config.mouseReleaseProtection(),
            onFinish: (result) => {
              v2Runtime = null;
              releaseCapturedPointer();
              phase = { kind: "idle" };
              activeDocument.body.dataset.butterDragEndedAt = String(Date.now());
              activeDocument.body.dataset.butterDragSceneV2Result = result.kind;
              if (result.finishReason) {
                activeDocument.body.dataset.butterDragSceneV2FinishReason =
                  result.finishReason;
              } else {
                delete activeDocument.body.dataset.butterDragSceneV2FinishReason;
              }
              activeDocument.body.dataset.butterDragSceneV2Measurements =
                String(result.oracleMeasurements);
              activeDocument.body.dataset.butterDragSceneV2MaximumOracleMeasureMs =
                String(result.oracleMaximumMeasureMs);
              activeDocument.body.dataset.butterDragSceneV2MaximumFrameWorkMs =
                String(result.maximumFrameWorkMs);
              activeDocument.body.dataset.butterDragSceneV2MaximumFrameNonOracleWorkMs =
                String(result.maximumFrameNonOracleWorkMs);
              activeDocument.body.dataset.butterDragSceneV2MaximumDraggingFrameWorkMs =
                String(result.maximumDraggingFrameWorkMs);
              activeDocument.body.dataset.butterDragSceneV2MaximumDraggingFrameNonOracleWorkMs =
                String(result.maximumDraggingFrameNonOracleWorkMs);
              activeDocument.body.dataset.butterDragSceneV2MaximumSettlementFrameWorkMs =
                String(result.maximumSettlementFrameWorkMs);
              activeDocument.body.dataset.butterDragSceneV2MaximumSettlementFrameNonOracleWorkMs =
                String(result.maximumSettlementFrameNonOracleWorkMs);
              activeDocument.body.dataset.butterDragSceneV2MaximumRetargetWorkMs =
                String(result.maximumRetargetWorkMs);
              activeDocument.body.dataset.butterDragSceneV2MaximumRetargetNonOracleWorkMs =
                String(result.maximumRetargetNonOracleWorkMs);
              activeDocument.body.dataset.butterDragSceneV2PointerMoveEvents =
                String(result.pointerMoveEvents);
              activeDocument.body.dataset.butterDragSceneV2PointerTargetFrames =
                String(result.pointerTargetFrames);
              activeDocument.body.dataset.butterDragSceneV2CoalescedPointerMoves =
                String(result.coalescedPointerMoves);
              activeDocument.body.dataset.butterDragSceneV2Compacted =
                String(result.compacted);
              activeDocument.body.dataset.butterDragSceneV2SourceListDepth =
                String(result.sourceListDepth ?? "");
              activeDocument.body.dataset.butterDragSceneV2TargetListDepth =
                String(result.targetListDepth ?? "");
              activeDocument.body.dataset.butterDragSceneV2ListIndent =
                String(result.listIndentPx);
              activeDocument.body.dataset.butterDragSceneV2HorizontalDelta =
                String(result.horizontalDeltaPx);
              activeDocument.body.dataset.butterDragSceneV2ValidatedBlocks =
                String(result.convergenceValidatedBlockCount);
              activeDocument.body.dataset.butterDragSceneV2SkippedBlocks =
                String(result.convergenceSkippedBlockCount);
              if (result.finalGhostLandingErrorPx != null) {
                activeDocument.body.dataset.butterDragSceneV2FinalGhostLandingError =
                  String(result.finalGhostLandingErrorPx);
              } else {
                delete activeDocument.body.dataset.butterDragSceneV2FinalGhostLandingError;
              }
              if (result.finalFillerLandingErrorPx != null) {
                activeDocument.body.dataset.butterDragSceneV2FinalFillerLandingError =
                  String(result.finalFillerLandingErrorPx);
              } else {
                delete activeDocument.body.dataset.butterDragSceneV2FinalFillerLandingError;
              }
              if (result.convergenceMaximumErrorBlockKey) {
                activeDocument.body.dataset.butterDragSceneV2MaximumErrorBlock =
                  result.convergenceMaximumErrorBlockKey;
              } else {
                delete activeDocument.body.dataset.butterDragSceneV2MaximumErrorBlock;
              }
              if (result.convergenceMaximumErrorEdge) {
                activeDocument.body.dataset.butterDragSceneV2MaximumErrorEdge =
                  result.convergenceMaximumErrorEdge;
              } else {
                delete activeDocument.body.dataset.butterDragSceneV2MaximumErrorEdge;
              }
              if (result.convergenceMaximumErrorPx != null) {
                activeDocument.body.dataset.butterDragSceneV2MaximumError =
                  String(result.convergenceMaximumErrorPx);
              } else {
                delete activeDocument.body.dataset.butterDragSceneV2MaximumError;
              }
              if (result.convergenceError) {
                activeDocument.body.dataset.butterDragSceneV2ConvergenceError =
                  result.convergenceError;
              } else {
                delete activeDocument.body.dataset.butterDragSceneV2ConvergenceError;
              }
              if (currentMode === "always") alwaysLayer?.update(editorView, chromeY());
            },
          });
          return;
        } catch (error) {
          v2Runtime?.destroy();
          v2Runtime = null;
          phase = { kind: "idle" };
          releaseCapturedPointer();
          activeDocument.body.dataset.butterDragSceneV2Result = "startup-error";
          activeDocument.body.dataset.butterDragSceneV2ConvergenceError =
            error instanceof Error ? error.message : String(error);
          return;
        }

      }

      const onArmCancel = (event: PointerEvent): void => {
        if (phase.kind !== "armed" || event.pointerId !== phase.pointerId) return;
        cleanupArmListeners();
        releaseCapturedPointer();
        phase = { kind: "idle" };
        hideSelectorPreview();
      };

      const onScroll = () => {
        hideSelectorPreview();
        if (suppressHoverDuringImageManipulation()) return;
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

      // Window blur cancels an armed pointer; Drag Scene owns active cancellation.
      const onWindowBlur = () => {
        if (phase.kind !== "armed") return;
        cleanupArmListeners();
        releaseCapturedPointer();
        phase = { kind: "idle" };
        hideSelectorPreview();
      };
      window.addEventListener("blur", onWindowBlur);

      // Always-mode layer event delegation
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
          const docChanged = view.state.doc !== prevState.doc;
          const headingFoldChanged =
            headingFoldKey.getState(view.state) !== headingFoldKey.getState(prevState);

          // Revalidate armed and idle handle state after document changes.
          if (phase.kind === "armed" && docChanged) {
            cleanupArmListeners();
            phase = { kind: "idle" };
            currentHit = null;
            hideHoverHandle();
            return;
          }

          if (phase.kind !== "idle") return;

          if (currentMode === "always") {
            if (
              !view.state.doc.eq(prevState.doc) ||
              !view.state.selection.eq(prevState.selection) ||
              headingFoldChanged
            ) {
              alwaysLayer?.update(view, chromeY());
            }
          } else if (currentHit && (docChanged || headingFoldChanged)) {
            currentHit = null;
            hideHoverHandle();
          } else if (currentHit) {
            const node = view.state.doc.nodeAt(currentHit.pos);
            if (
              !node ||
              node.type !== currentHit.node.type
            ) {
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
          v2Runtime?.destroy();
          v2Runtime = null;
          hoverHandle.remove();
          selectorPreview.remove();
          alwaysLayer?.destroy();
          cleanupArmListeners();
          cancelPendingMultiMenu?.();
          releaseCapturedPointer();
          for (const sh of scrollHosts) {
            sh.removeEventListener("scroll", onScroll);
            sh.removeEventListener("scroll", onAnyScroll);
          }
          window.removeEventListener("resize", onScroll);
          window.removeEventListener("blur", onWindowBlur);
          if (hoverThrottleRAF) cancelAnimationFrame(hoverThrottleRAF);
          if (activeMenu) {
            try { activeMenu.hide(); } catch { /* */ }
          }
          activeDocument.removeEventListener("pointermove", onEditorPointerMove);
          activeDocument.removeEventListener("pointerover", onHandlePointerOver);
          activeDocument.removeEventListener("pointerout", onHandlePointerOut);
          editorView.dom.removeEventListener("pointerdown", onEditorTouchDown);
          editorView.dom.removeEventListener(
            "contextmenu",
            onTouchDragContextMenu,
            true,
          );
          cleanupTouchPressListeners();
        },
      };
    },
  });
}
