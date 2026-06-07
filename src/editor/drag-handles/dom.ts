import { LiveDragState, dragVisualTotal, dragVisualAt, dragIsCompact } from "./types";
import { buildHandleDotsSvg } from "./constants";


import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";




import { gapAbove, EXCLUDED_BLOCK_TYPES } from "../block-spacing";

// ── Constants ────────────────────────────────────────────────


export function createHandleEl(): HTMLElement {
  const el = activeDocument.createElement("div");
  el.className = "butter-drag-handle";
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "-1");
  el.setAttribute("aria-label", "Drag block");
  el.appendChild(buildHandleDotsSvg());
  return el;
}

// ── Block detection ──────────────────────────────────────────

/** Horizontal inset for a nested list_item's drag handle, so the
 *  handle sits beside the item's marker instead of in the doc-root
 *  gutter. Reads the already-computed `padding-left` from the live
 *  element — no DOM probe, no `--list-indent` resolution needed.
 *
 *  Formula: padding-left = (depth + 1) * indent → the marker column
 *  width is `indent = padding-left / (depth + 1)`. The handle sits
 *  just left of the marker, at `padding-left - indent`, which simplifies
 *  to `padding-left * depth / (depth + 1)`.
 *
 *  Returns 0 for non-list blocks and for depth-0 list items. */
export function createDropFiller(): HTMLElement {
  const el = activeDocument.createElement("div");
  el.className = "butter-drop-filler";
  activeDocument.body.appendChild(el);
  return el;
}

/** Pixel gap a block contributes ABOVE itself at `idx`, derived from the
 *  single source of truth (`block-spacing.ts#gapAbove`) rather than a
 *  hand-copied switch. Returns 0 for index 0 (no gap) and for excluded
 *  types (which the spacing plugin never decorates, so they keep native
 *  margin — approximated as 0 here; they don't appear as managed
 *  top-level blocks in practice).
 *
 *  NOTE: `list_item` expresses its gap as `padding-top`, not `margin-top`
 *  (see `block-spacing.ts`). That padding is already inside the element's
 *  `offsetHeight`, so the caller must NOT add this value on top of
 *  offsetHeight for list items — doing so double-counts the gap. */
function computeMtPx(
  node: PMNode,
  prev: PMNode | null,
  idx: number,
  resolve: (css: string) => number,
): number {
  if (idx === 0) return 0;
  if (EXCLUDED_BLOCK_TYPES.has(node.type.name)) return 0;
  return resolve(gapAbove(node, prev, idx));
}

/** True when a block's inter-block gap lives in `padding-top` (inside
 *  `offsetHeight`) rather than `margin-top`. Mirrors the list_item
 *  branch in `block-spacing.ts#buildSpacingDecorations`. */
function gapIsPadding(node: PMNode): boolean {
  return node.type.name === "list_item";
}

/** Predict where the dragged block will land post-drop by simulating
 *  the spacing plugin's layout against the current doc + target slot.
 *  Only handles the top-level doc-body case (same-container, source
 *  and target both at the root), which is where first-block margin
 *  transitions happen. Returns null for other cases — the caller
 *  should fall back to the during-drag-layout formula.
 *
 *  The during-drag formula uses each block's CURRENT margin, which is
 *  wrong when first-block status changes across the drop. This
 *  simulation walks the NEW sibling order, applies the spacing rule
 *  to each block at its NEW index, and returns the position the
 *  dragged block will actually occupy. */
export function predictPostDropDraggedRect(
  drag: LiveDragState,
): { top: number; left: number; width: number; height: number } | null {
  // Compact drags keep using the manual filler path + measured-DOM
  // landing (both already clamp correctly); this single-block layout
  // predictor stays real-space-only.
  if (dragIsCompact(drag)) return null;
  const targetSlot = drag.slots[drag.targetSlotIdx];
  if (!targetSlot) return null;
  const targetCtxPos = targetSlot.context?.containerPos ?? -1;
  const sourceCtxPos = drag.sourceContext?.containerPos ?? -1;
  if (targetCtxPos !== -1 || sourceCtxPos !== -1) return null;

  const siblings = drag.siblingsByContainer.get(-1) ?? [];
  const draggedSet = new Set(drag.draggedPositions);
  const sourceIndex = siblings.findIndex(s => draggedSet.has(s.pos));
  if (sourceIndex < 0) return null;
  if (drag.draggedNodes.length !== 1) return null;
  const draggedNode = drag.draggedNodes[0];

  const nonDragged = siblings.filter(s => !draggedSet.has(s.pos));
  let newIdx = targetSlot.indexInContainer;
  if (sourceIndex < newIdx) newIdx -= 1;
  newIdx = Math.max(0, Math.min(newIdx, nonDragged.length));

  // Anchor: use a non-dragged sibling's offsetParent. The dragged
  // block is source-collapsed during drag and its offsetParent may
  // be detached, so prefer a stable sibling.
  const anchorSib = siblings.find(s => !draggedSet.has(s.pos));
  if (!anchorSib || !anchorSib.dom.isConnected) return null;
  const parent = anchorSib.dom.offsetParent;
  if (!(parent instanceof HTMLElement)) return null;
  const parentRect = parent.getBoundingClientRect();
  const parentPadTop = parseFloat(getComputedStyle(parent).paddingTop) || 0;

  // Cached resolver — no per-frame DOM probe. makeMarginResolver's
  // probe writes + getComputedStyle reads forced a synchronous reflow
  // on every frame (this runs per pointermove via positionDropFiller);
  // resolveGapPx memoises per drag, so after the first frame it does
  // zero layout work.
  const resolve = (css: string) => resolveGapPx(css, parent, drag);

  // Y0 = where idx 0 begins in the new layout. The spacing plugin
  // forces mt = 0 on idx 0 so the new idx 0 block starts exactly at
  // parent's content-box top.
  let y = parentRect.top + parentPadTop;
  // Walk nonDragged up to newIdx, summing each block's gap + height.
  // For list items the gap lives in padding-top (already inside
  // offsetHeight), so only margin-gapped blocks add the gap on top.
  let prev: PMNode | null = null;
  for (let i = 0; i < newIdx; i++) {
    const sib = nonDragged[i];
    if (!gapIsPadding(sib.node)) y += computeMtPx(sib.node, prev, i, resolve);
    y += sib.dom.isConnected ? sib.dom.offsetHeight : sib.rect.height;
    prev = sib.node;
  }
  // Add dragged block's gap at its new idx (skip if the gap is
  // padding — it's inside the filler's height, not above it).
  if (!gapIsPadding(draggedNode)) {
    y += computeMtPx(draggedNode, prev, newIdx, resolve);
  }

  // Width comes from blockAfter (block at newIdx in new order) or the
  // last sibling if dropping at the end.
  const refSib = newIdx < nonDragged.length
    ? nonDragged[newIdx]
    : nonDragged[nonDragged.length - 1];
  if (!refSib) return null;
  const refRect = refSib.rect;

  // Height: dragged block's body height (BCR height without margin).
  const firstDraggedSib = siblings.find(s => draggedSet.has(s.pos));
  let height = dragVisualTotal(drag) - drag.firstBlockTopInset;
  if (firstDraggedSib?.dom?.isConnected) {
    height = firstDraggedSib.dom.offsetHeight;
  }

  return { top: y, left: refRect.left, width: refRect.width, height };
}

// Per-drag memo of resolved gap CSS expressions → px. Theme values are
// constant for a drag's lifetime, so we resolve each distinct
// expression once instead of probing every frame.
const gapPxCache = new WeakMap<LiveDragState, Map<string, number>>();

function resolveGapPx(
  css: string,
  parent: HTMLElement,
  drag: LiveDragState,
): number {
  let cache = gapPxCache.get(drag);
  if (!cache) {
    cache = new Map();
    gapPxCache.set(drag, cache);
  }
  const hit = cache.get(css);
  if (hit != null) return hit;
  const probe = parent.ownerDocument.createElement("div");
  probe.className = "butter-gap-probe";
  parent.appendChild(probe);
  probe.style.marginTop = css;
  const px = parseFloat(getComputedStyle(probe).marginTop) || 0;
  probe.remove();
  cache.set(css, px);
  return px;
}

/** Per-sibling reflow shifts for a same-container drop, computed by
 *  simulating the spacing-plugin layout in BOTH the current and the
 *  post-drop sibling order and returning `finalTop - currentTop` for
 *  each non-dragged block.
 *
 *  This is the during-drag equivalent of `predictPostDropDraggedRect`,
 *  generalised to every block. Unlike the index-only closure+gap math
 *  it also captures the idx-0 margin flip — the block that gains or
 *  loses its first-block margin when the dragged block crosses the
 *  top boundary — so blocks settle into their FINAL positions during
 *  the drag and the drop-filler never overlaps them. (For non-flip
 *  drags the non-dragged heights cancel and this reduces exactly to
 *  the closure+gap result, so the common-case feel is unchanged.)
 *
 *  Compact drags are modelled too: the dragged run's footprint (gap +
 *  body) is scaled by `dragScale`, matching the clamped card the source
 *  blocks are physically shrunk to, so the non-dragged shifts come out
 *  in visual space. Non-dragged blocks always keep their real heights.
 *
 *  Returns null only for cross-container drops — the caller falls back
 *  to the index math there.
 *
 *  Keyed/returned by sibling `pos`. */
export function computeSameContainerShifts(
  drag: LiveDragState,
  editorView: EditorView,
): Map<number, number> | null {
  const targetSlot = drag.slots[drag.targetSlotIdx];
  if (!targetSlot) return null;
  const targetCtxPos = targetSlot.context?.containerPos ?? -1;
  const sourceCtxPos = drag.sourceContext?.containerPos ?? -1;
  if (targetCtxPos !== sourceCtxPos) return null;

  const siblings = drag.siblingsByContainer.get(targetCtxPos) ?? [];
  if (siblings.length === 0) return null;
  const draggedSet = new Set(drag.draggedPositions);
  const probeParent = editorView.dom;

  // Current order = siblings as-is. Final order = non-dragged blocks
  // with the dragged run spliced in at the target index.
  const nonDragged = siblings.filter((s) => !draggedSet.has(s.pos));
  const draggedSibs = siblings.filter((s) => draggedSet.has(s.pos));
  const splice = nonDragged.filter(
    (s) => s.index < targetSlot.indexInContainer,
  ).length;
  const finalOrder = [
    ...nonDragged.slice(0, splice),
    ...draggedSibs,
    ...nonDragged.slice(splice),
  ];

  // Walk an order, summing each block's gap-above + body height, and
  // record every block's top offset from the container content-top.
  // gap is 0 at index 0 (first-block rule) and 0 for padding-gapped
  // blocks (list items — the gap is inside the body height). Body
  // height uses the start-of-drag rect (stable; the live DOM may be
  // source-collapsed or transformed mid-drag).
  //
  // Dragged blocks contribute their VISUAL footprint: both gap and body
  // scale by dragScale (1 in normal drags, so this is a no-op there;
  // < 1 in compact drags, matching the shrunk source card). Non-dragged
  // blocks always use their real height.
  const walk = (order: import("./types").SiblingInfo[]): Map<number, number> => {
    const tops = new Map<number, number>();
    let y = 0;
    let prev: PMNode | null = null;
    for (let i = 0; i < order.length; i++) {
      const sib = order[i];
      const scale = draggedSet.has(sib.pos) ? drag.dragScale : 1;
      const gap =
        (i === 0 || gapIsPadding(sib.node)
          ? 0
          : resolveGapPx(gapAbove(sib.node, prev, i), probeParent, drag)) * scale;
      y += gap;
      tops.set(sib.pos, y);
      y += sib.rect.height * scale;
      prev = sib.node;
    }
    return tops;
  };

  const curTops = walk(siblings);
  const finTops = walk(finalOrder);

  const shifts = new Map<number, number>();
  for (const sib of nonDragged) {
    const cur = curTops.get(sib.pos) ?? 0;
    const fin = finTops.get(sib.pos) ?? 0;
    shifts.set(sib.pos, fin - cur);
  }
  return shifts;
}

/** Position the filler at the live target gap, sized to match the
 *  dragged block's BORDER-BOX (not including margins). Position is
 *  computed so the filler's bottom sits exactly where the block's
 *  bottom will be after commit. */
export function positionDropFiller(
  filler: HTMLElement,
  drag: LiveDragState,
  editorView: EditorView,
): void {
  const targetSlot = drag.slots[drag.targetSlotIdx];
  if (!targetSlot) {
    filler.hide();
    return;
  }

  // First-block-aware prediction. For top-level doc-body drops where
  // the source was at idx 0 or the target is idx 0, the during-drag
  // layout (used by the formula below) doesn't reflect post-drop
  // margins. Use a layout simulation that applies the spacing rule
  // to each block at its NEW index. Falls back to the formula for
  // cases the simulation doesn't cover (cross-container, multi-block
  // drag, etc.).
  const predicted = predictPostDropDraggedRect(drag);
  if (predicted) {
    let left = predicted.left;
    let width = predicted.width;
    if (drag.sourceDepth != null && drag.targetDepth != null && drag.listIndentPx > 0) {
      const xShift = drag.targetDepth * drag.listIndentPx;
      left += xShift;
      width -= xShift;
    }
    filler.show();
    filler.style.left = `${left}px`;
    filler.style.top = `${predicted.top}px`;
    filler.style.width = `${width}px`;
    filler.style.height = `${predicted.height}px`;
    return;
  }

  const draggedSet = new Set(drag.draggedPositions);
  const targetCtxPos = targetSlot.context?.containerPos ?? -1;
  const siblings = drag.siblingsByContainer.get(targetCtxPos) ?? [];
  const nonDragged = siblings.filter(s => !draggedSet.has(s.pos));

  // Filler height = the visual total: the height the reflow gap opens.
  // Clamped to the compact card for long blocks (dragScale < 1), so the
  // filler matches both the ghost and the opened gap exactly.
  const blockHeight = dragVisualTotal(drag);

  // Find the block that will be DIRECTLY below the dropped block.
  const blockAfter = nonDragged.find(s => s.index >= targetSlot.indexInContainer);

  let top: number;
  let left: number;
  let width: number;

  // Natural (transform-free) viewport top: parent's BCR + el's
  // offsetTop. offsetTop is layout-only — never includes CSS
  // transforms — so this stays stable even while siblings are
  // mid-reflow-transition.
  const naturalViewportTop = (sib: import("./types").SiblingInfo): number => {
    const el = sib.dom;
    if (!el.isConnected) {
      const currentScrollTop = drag.scroller ? drag.scroller.scrollTop : 0;
      const deltaY = currentScrollTop - drag.startScrollTop;
      return sib.rect.top - deltaY;
    }
    const parent = el.offsetParent;
    if (parent instanceof HTMLElement) {
      // offsetTop is layout-only and never includes transforms, so this
      // is already the natural top. Subtracting the live transform here
      // too would double-count and throw the filler off by one block
      // height on upward drags, where blockAfter carries a +translateY.
      return parent.getBoundingClientRect().top + el.offsetTop;
    }
    // No offsetParent: BCR includes the live reflow transform, so strip
    // it to recover the natural top.
    let rawTop = el.getBoundingClientRect().top;
    const match = el.style.transform.match(/translateY\(([-\d.]+)px\)/);
    if (match) rawTop -= parseFloat(match[1]);
    return rawTop;
  };

  // Final shift the sib will have after the new reflow CSS settles —
  // the filler sits where the sib visually ends up, not its natural top.
  //
  // Prefer the SAME layout simulation the reflow uses
  // (computeSameContainerShifts): it captures the idx-0 margin flip,
  // which the index-only closure+gap formula below does not. Without
  // this, a compact block dragged from/to idx 0 puts the filler a
  // first-block-margin too low and it overlaps the blocks beneath
  // (the formula path is the non-compact filler's job, which uses
  // predictPostDropDraggedRect above and never reaches here). simShifts
  // is null for cross-container drops, where the formula is correct
  // (target siblings have no dragged blocks above them).
  const sourceCtxPos = drag.sourceContext?.containerPos ?? -1;
  const sameContainer = sourceCtxPos === targetCtxPos;
  const simShifts = sameContainer
    ? computeSameContainerShifts(drag, editorView)
    : null;
  const finalShiftFor = (sibIndex: number): number => {
    let closure = 0;
    if (sameContainer) {
      for (const s of siblings) {
        if (s.index >= sibIndex) break;
        if (draggedSet.has(s.pos)) {
          closure += dragVisualAt(drag, s.index);
        }
      }
    }
    return -closure + (sibIndex >= targetSlot.indexInContainer ? dragVisualTotal(drag) : 0);
  };
  // Shift for a sibling: simulation when available (matches reflow),
  // else the index-only formula.
  const shiftFor = (sib: import("./types").SiblingInfo): number =>
    simShifts?.get(sib.pos) ?? finalShiftFor(sib.index);

  if (blockAfter) {
    const visualTop = naturalViewportTop(blockAfter) + shiftFor(blockAfter);
    const r = blockAfter.rect;
    const afterMargin = blockAfter.dom.isConnected ? (parseFloat(getComputedStyle(blockAfter.dom).marginTop) || 0) : 0;
    const bottom = visualTop - afterMargin;
    top = bottom - blockHeight;
    left = r.left;
    width = r.width;
  } else {
    // Dropping at the end of the container — filler starts after
    // the last block, separated by approximately one paragraph margin.
    const last = nonDragged[nonDragged.length - 1];
    if (!last) {
      filler.hide();
      return;
    }
    const lastVisualTop = naturalViewportTop(last) + shiftFor(last);
    const r = last.rect;
    const gap = last.dom.isConnected ? (parseFloat(getComputedStyle(last.dom).marginTop) || 0) : 0;
    const dynamicHeight = last.dom.isConnected ? last.dom.getBoundingClientRect().height : r.height;
    top = lastVisualTop + dynamicHeight + gap;
    left = r.left;
    width = r.width;
  }

  // List-item depth feedback: shift the filler RIGHT by
  // `targetDepth * indent` so it sits at the visual indent column the
  // dropped item will land at. Uses ABSOLUTE positioning (not delta
  // from source), because list_item BCR.left is the same for every
  // depth (padding-left does the indenting INSIDE the box, not
  // outside it) — so the natural `blockAfter.left` is always the
  // doc-content edge.
  if (drag.sourceDepth != null && drag.targetDepth != null && drag.listIndentPx > 0) {
    const xShift = drag.targetDepth * drag.listIndentPx;
    left += xShift;
    width -= xShift;
  }

  // Trim the source's top inset (margin + padding combined) off
  // the top of the filler: both are empty gap-above zones, not
  // block content. After this the filler represents the visible
  // block only — the user sees "this is where the block lands,"
  // not "this is where the block + its surrounding gap lands."
  const inset = drag.firstBlockTopInset;
  const visibleTop = top + inset;
  const visibleHeight = Math.max(0, blockHeight - inset);

  filler.show();
  filler.style.left = `${left}px`;
  filler.style.top = `${visibleTop}px`;
  filler.style.width = `${width}px`;
  filler.style.height = `${visibleHeight}px`;
}

// ── Ghost ────────────────────────────────────────────────────

export function createGhost(
  doms: HTMLElement[],
  editorDom: HTMLElement,
): HTMLElement {
  const ghost = activeDocument.createElement("div");
  ghost.className = "butter-drag-ghost";
  const inner = activeDocument.createElement("div");
  inner.className = "butter-drag-ghost-inner";

  // Replicate the editor's class chain so cloned blocks get the
  // same CSS cascade (line-height, padding, fonts, theme styling).
  const resetBox = (el: HTMLElement) => {
    const s = el.style;
    s.setProperty("padding", "0", "important");
    s.setProperty("margin", "0", "important");
    s.setProperty("max-width", "none", "important");
    s.setProperty("max-height", "none", "important");
    s.setProperty("height", "auto", "important");
    s.setProperty("width", "100%", "important");
    s.setProperty("overflow", "visible", "important");
    s.setProperty("background", "transparent", "important");
    s.setProperty("border", "none", "important");
    s.setProperty("box-shadow", "none", "important");
    s.setProperty("display", "block", "important");
  };
  const viewWrap = activeDocument.createElement("div");
  viewWrap.className = "butter-editor-view";
  resetBox(viewWrap);
  const pmWrap = activeDocument.createElement("div");
  pmWrap.className = "ProseMirror";
  resetBox(pmWrap);
  for (const c of ["markdown-rendered", "markdown-preview-view"]) {
    if (editorDom.classList.contains(c)) pmWrap.classList.add(c);
  }

  const firstRect = doms[0]?.getBoundingClientRect();
  if (firstRect) inner.style.width = `${firstRect.width}px`;

  for (let i = 0; i < doms.length; i++) {
    const dom = doms[i];
    const computed = getComputedStyle(dom);
    const clone = dom.cloneNode(true) as HTMLElement;
    clone.removeAttribute("contenteditable");
    clone.removeAttribute("data-butter-drag-idx");
    clone.classList.remove("butter-drag-source");
    clone.classList.remove("butter-drag-source-collapsed");
    clone.style.removeProperty("opacity");
    clone.style.removeProperty("height");
    clone.style.removeProperty("margin");
    clone.style.removeProperty("padding");
    clone.style.removeProperty("max-height");
    clone.style.removeProperty("overflow");
    clone.style.removeProperty("transition");
    // First block flush with ghost top; subsequent blocks keep their
    // source margin so multi-block spacing matches the original layout.
    const noMargin = "0";
    clone.style.marginTop = i === 0 ? noMargin : computed.marginTop;
    clone.style.marginBottom = noMargin;
    clone.style.marginLeft = noMargin;
    clone.style.marginRight = noMargin;
    // List items get a decoration-applied `padding-top` and a
    // `--li-pad-top` custom property (drives the marker's vertical
    // alignment via `::before { top: var(--li-pad-top) }`). Stripping
    // padding above wipes both. Restore from the source's resolved
    // values so the ghost matches 1:1.
    if (dom.classList.contains("butter-list-item")) {
      // Always preserve the source's padding-top. Zeroing it (which we
      // do for non-list first blocks to keep them flush with the ghost
      // top) shifts the marker up by `--li-pad-top` since the marker
      // uses `top: var(--li-pad-top)` against a padding-less box —
      // visible as a few-px pop at drag start.
      clone.style.paddingTop = computed.paddingTop;
      clone.style.setProperty("--li-pad-top", computed.paddingTop);
    }
    // Pin table column widths
    if (dom.tagName === "TABLE" || dom.querySelector("table")) {
      const srcCells = dom.querySelectorAll("th, td");
      const cloneCells = clone.querySelectorAll("th, td");
      for (let j = 0; j < srcCells.length && j < cloneCells.length; j++) {
        const w = (srcCells[j] as HTMLElement).getBoundingClientRect().width;
        (cloneCells[j] as HTMLElement).style.width = `${w}px`;
        (cloneCells[j] as HTMLElement).style.minWidth = `${w}px`;
        (cloneCells[j] as HTMLElement).style.maxWidth = `${w}px`;
      }
    }
    pmWrap.appendChild(clone);
  }

  viewWrap.appendChild(pmWrap);
  inner.appendChild(viewWrap);
  ghost.appendChild(inner);

  // Pass the source block's border-radius to the ghost
  try {
    const cs = getComputedStyle(doms[0]);
    ghost.style.setProperty(
      "--butter-ghost-radius",
      `${cs.borderTopLeftRadius} ${cs.borderTopRightRadius} ${cs.borderBottomRightRadius} ${cs.borderBottomLeftRadius}`,
    );
  } catch { /* */ }

  activeDocument.body.appendChild(ghost);
  return ghost;
}

export function positionGhost(
  ghost: HTMLElement,
  x: number,
  y: number,
  grabOffsetX: number,
  grabOffsetY: number,
): void {
  ghost.style.transform = `translate3d(${x - grabOffsetX}px, ${y - grabOffsetY}px, 0)`;
}

// ── PM observer suppression ──────────────────────────────────
// Used sparingly at drag start/end for one-time DOM writes (data
// attributes, classes). The hot-path reflow uses an injected
// stylesheet instead, which PM's observer can't see.

export function createDragStyleEl(): HTMLStyleElement {
  const el = activeDocument.createElement("style");
  el.id = "butter-drag-transforms";
  activeDocument.head.appendChild(el);
  return el;
}

// All injected rules are scoped to .ProseMirror so they never
// match the ghost's cloned children (which inherit the data attr).
