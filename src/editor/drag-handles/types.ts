

import type { Node as PMNode } from "prosemirror-model";
import { App } from "obsidian";





// ── Constants ────────────────────────────────────────────────


export interface DragHandlesConfig {
  app: App;
  serializeNode: (node: PMNode) => string;
  dragHandleVisibility: () => "hover" | "always";
  dragMotion: () => "springy" | "snappy" | "smooth";
  /** Px of "earliness" for the slot swap: the cascade commits this far
   *  before the ghost edge fully reaches the neighbor edge. 0 = must
   *  fully clear. Read live from settings (the sensitivity slider). */
  dragTriggerBias: () => number;
  /** Reserved for future use by the BlockAnimator. Currently unused
   *  because all animations are stripped — kept on the interface so
   *  re-enabling won't require a config change at the call site. */
  disableAnimations: () => boolean;
  /** Mobile-only: called when the user taps the editor with the
   *  keyboard down. The view starts with PM's `editable` prop locked
   *  off (see `installMobileToolbarBehavior`); the first tap needs
   *  to flip it back on so contenteditable accepts focus + typing.
   *  No-op on desktop. */
  unlockMobileEditable?: () => void;
  chromeBottom?: () => number;
}

/** Motion curves per dragMotion setting. Drag engine sets these as
 *  CSS vars on body when a drag starts, so the reflow + drop-filler
 *  transitions (in styles.css) pick up whichever curve the user
 *  chose. Two springs per setting:
 *   - `spring`: bouncier (used for transform / sibling slide)
 *   - `soft`:   gentler overshoot (used for top-position glide)
 *  Matches 0.9.9's preset table. */
export interface BlockHit {
  pos: number;
  node: PMNode;
  dom: HTMLElement;
  rect: DOMRect;
  /** null = doc root; otherwise the container this block lives in. */
  context: DragContext | null;
}

export interface DragContext {
  containerPos: number;
  containerNode: PMNode;
  containerDom?: HTMLElement;
}

export interface SiblingInfo {
  pos: number;
  node: PMNode;
  dom: HTMLElement;
  rect: DOMRect;
  index: number;
  /** Stable drag index stamped as data-butter-drag-idx on drag start. */
  dragIdx: number;
}

/** One drop target in the unified flat slot list. Each slot represents
 *  "insert the dragged block(s) at indexInContainer of context". Slots
 *  are emitted in visual document order; pointer Y picks one via
 *  direction-gated cascade. There's no separate "context switch" — the
 *  current container is just `slot.context`. */
export interface DropSlot {
  /** null = doc root; otherwise the container holding the insertion. */
  context: DragContext | null;
  /** Where in the container's children the insertion goes (0..N). */
  indexInContainer: number;
  /** DOM element whose live rect supplies the slot's trigger Y. Read
   *  live on every cascade — rects shift as reflow transforms apply. */
  triggerEl: HTMLElement;
  triggerRect: DOMRect;
  /** Which edge of `triggerEl` is the trigger. "top" = top of the next
   *  visual block (insert BEFORE it). "bottom" = bottom of the
   *  container's content (insert at end). */
  triggerEdge: "top" | "bottom";
  /** True when this slot is "before a container" (e.g. before a callout
   *  with children). DOWN cascade uses `triggerEl.top` for these slots
   *  so the cascade can step INTO the container's interior as ghost.
   *  bottom crosses the container's near edge — symmetric to the UP
   *  cascade's behavior for "after-last in container" slots, which use
   *  `container.bottom` (the container's near edge from below). For
   *  regular "before block" slots the DOWN trigger stays at
   *  `triggerEl.bottom` so the "drag-past-the-whole-block-to-commit"
   *  feel is preserved for block-to-block dragging. */
  isContainerEntry: boolean;
}


export type DragPhase =
  | { kind: "idle" }
  | {
      kind: "armed";
      startX: number;
      startY: number;
      pointerId: number;
      hitPos: number;
      hitNode: PMNode;
      grabOffsetX: number;
      grabOffsetY: number;
      context: DragContext | null;
    }
  | { kind: "dragging"; drag: LiveDragState }
  | { kind: "settling" };

export interface LiveDragState {
  draggedPositions: number[];
  draggedNodes: PMNode[];
  draggedDoms: HTMLElement[];
  /** The scroller element for the editor. Cached to prevent layout thrashing. */
  scroller: HTMLElement | null;
  /** The bounding rect of the scroller at drag start. Cached to prevent layout thrashing. */
  scrollerRect: DOMRect | null;
  /** On-screen height of the ghost element, MEASURED off the ghost
   *  once at drag start (after the compact clamp is applied). Used for
   *  trigger geometry (ghostBottom hit-testing). Because createGhost
   *  zeroes the first block's margin-top, this is the body span without
   *  the leading margin in normal drags, and the clamped card height in
   *  compact drags — no separate hand-computed number needed. */
  ghostHeight: number;
  /** Px of "earliness" for the slot-swap triggers, snapshot at drag
   *  start from the sensitivity setting. Applied symmetrically up/down. */
  triggerBias: number;
  /** Set of DOM elements currently shifted by inline styles. Used to clear styles when no longer shifted. */
  shiftedDoms: Set<HTMLElement>;
  /** REAL flow height of each dragged block (border-box + its own
   *  margin-top), keyed by source-sibling index. The single measured
   *  input to the height model — every other drag height derives from
   *  this and `dragScale`. Use the `drag*` helpers below rather than
   *  reading the map directly:
   *    layout (real)  = dragLayoutAt / dragLayoutTotal
   *    visual (drawn) = dragVisualAt / dragVisualTotal  (× dragScale) */
  layoutHeightByIndex: Map<number, number>;
  /** The single compact knob. 1 = normal drag (visual === layout).
   *  < 1 = long-block "compact" drag: the dragged run is drawn scaled
   *  down so its on-screen footprint (ghost, opened gap, filler) caps
   *  at COMPACT_THRESHOLD_PX. Everything visual = layout × dragScale;
   *  `dragIsCompact(drag)` is just `dragScale < 1`. */
  dragScale: number;
  sourceContext: DragContext | null;
  sourceIndex: number;
  sourceSiblings: SiblingInfo[];
  /** All drop targets in visual document order. Rebuilt at drag
   *  start; slot trigger Y is read live from each slot's triggerEl.
   *  There is no separate "context switch" — the current container is
   *  just `slots[targetSlotIdx].context`. */
  slots: DropSlot[];
  /** Idx into `slots` for the current drop target. -1 before the first
   *  cascade resolves (initial CSS render uses sourceSlotIdx instead). */
  targetSlotIdx: number;
  /** Slot equivalent to "drop at source position" — landing here =
   *  no-op (delete + reinsert at same spot). Initial targetSlotIdx
   *  starts at this value so the initial reflow shows no shifts. */
  sourceSlotIdx: number;
  /** Per-container siblings, keyed by containerPos (-1 = doc root).
   *  Built once at drag start; dragIdx stamps stick across updates. */
  siblingsByContainer: Map<number, SiblingInfo[]>;
  /** Container keys whose siblings currently have dragIdx stamped.
   *  Source container is stamped at drag start; target containers are
   *  stamped lazily as the cascade enters them. */
  stampedContainerKeys: Set<number>;
  ghost: HTMLElement;
  grabOffsetX: number;
  grabOffsetY: number;
  lastPointerX: number;
  lastPointerY: number;
  /** When dragging list_items, the source's original depth attr.
   *  null when dragging non-list blocks. */
  sourceDepth: number | null;
  /** When dragging list_items, the current target depth derived from
   *  pointer X. Updated each frame. null when not dragging list_items. */
  targetDepth: number | null;
  /** Resolved `--list-indent` in px, captured at drag start. Used for
   *  both target-depth-from-pointer-X math and drop-filler indent. */
  listIndentPx: number;
  /** X coordinate of the editor's content-area left edge (= where
   *  depth-0 list_items' left lives). Captured at drag start. */
  contentLeftX: number;
  /** Pointer X at drag-promotion time. The depth calculation works
   *  off DELTA from this, not absolute pointer-X — so the gesture
   *  feels like "drag right to indent, left to outdent" relative to
   *  where the user grabbed, not "drag to the absolute screen column
   *  that matches your target depth." Especially important on touch:
   *  the user shouldn't have to traverse the whole indent gutter
   *  just to bump one level. */
  dragStartX: number;
  /** Pointer Y from the previous updateReflow call. Used to derive
   *  the cascade direction (down vs up) for the trigger. */
  prevPointerY: number;
  startScrollTop: number;
  styleEl: HTMLStyleElement;
  /** Top "gap zone" of the first dragged block — sum of its
   *  computed `margin-top` and `padding-top`. The drop filler trims
   *  this off the top so the placeholder represents the visible
   *  block, not the inter-block gap above it. block-spacing.ts
   *  expresses that gap as `margin-top` on most block types and
   *  `padding-top` on list items (so the indent-guide background
   *  spans the gap), so both contribute. */
  firstBlockTopInset: number;
  /** When dragging INTO a foreign context, the container's content
   *  area gets temporary padding-bottom to make room for the opened
   *  gap (otherwise children overflow the container's natural box and
   *  trigger scroll). Tracked so the padding can be removed when
   *  switching context or on cleanup. */
  paddedContextDom: HTMLElement | null;
  /** Drop-filler element shown in the opening gap so the user has a
   *  visible indication of where the block will land (not just empty
   *  space). Mounted on document.body, position:fixed. */
  dropFiller: HTMLElement;
}

// ── Drag height model ────────────────────────────────────────
// Two coordinate spaces share one source of truth:
//   • LAYOUT space — what the document does post-drop (real heights).
//   • VISUAL space — what's drawn mid-drag (layout × dragScale; the
//     compact clamp lives here and ONLY here).
// In a normal drag dragScale === 1 and the two spaces coincide, which
// is why regular block logic reads off a single number. Compact mode
// just sets dragScale < 1; every consumer keeps reading these helpers,
// so there is no separate "long block" or "multi-select" code path —
// per-block scaling falls out of the map × the scalar.

/** Real (unscaled) flow height of one dragged block at its source index. */
export function dragLayoutAt(drag: LiveDragState, index: number): number {
  return drag.layoutHeightByIndex.get(index) ?? 0;
}

/** Real (unscaled) total flow height of the whole dragged run. */
export function dragLayoutTotal(drag: LiveDragState): number {
  let total = 0;
  for (const h of drag.layoutHeightByIndex.values()) total += h;
  return total;
}

/** On-screen (drawn) height of one dragged block during the drag. */
export function dragVisualAt(drag: LiveDragState, index: number): number {
  return dragLayoutAt(drag, index) * drag.dragScale;
}

/** On-screen (drawn) total height of the dragged run — the size of the
 *  ghost, the opened reflow gap, and the drop filler. */
export function dragVisualTotal(drag: LiveDragState): number {
  return dragLayoutTotal(drag) * drag.dragScale;
}

/** True when the drag is compact (long block drawn scaled-down). */
export function dragIsCompact(drag: LiveDragState): boolean {
  return drag.dragScale < 1;
}

// ── Handle DOM factory ───────────────────────────────────────

// 2×3 grid of dots rendered as an inline SVG so the spacing is
// pixel-perfect at any zoom (CSS grid + gap had subpixel rounding
// inconsistencies that made the dots look uneven).
