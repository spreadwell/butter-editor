import { rectBottom } from "./geometry";
import type {
  DragSceneLane,
  DragSceneSlot,
  SceneLaneKey,
  SceneRect,
  SceneSlotKey,
} from "./types";

export interface LaneIntentConfig {
  /** Horizontal distance allowed back outside the active child rail. */
  exitInsetPx: number;
  /** Optional pointer-entry bounds derived from exact renderer landing
   * positions. Vertical departure is resolved separately from the exact
   * parent-lane exits, so larger endpoint targets cannot make a container
   * sticky. */
  entryOwnerRects?: ReadonlyMap<SceneLaneKey, SceneRect>;
  /** Exact first/last child landing positions used for directional entry. */
  entryLandings?: ReadonlyMap<SceneLaneKey, LaneEntryLandings>;
  /** Exact parent-lane landing positions immediately before and after each
   * container. These let a child leave at the position it will actually own
   * after the structural move, rather than at the container's stale border. */
  exitLandings?: ReadonlyMap<SceneLaneKey, LaneExitLandings>;
  direction?: number;
  triggerOffsetPx?: number;
  /** Optional per-lane override for container entry and exit thresholds. */
  triggerOffsetPxForLane?: (laneKey: SceneLaneKey) => number;
  /** A lane just left vertically stays unavailable while the pointer keeps
   * travelling outward. This prevents boundary noise from reacquiring it. */
  excludedEntryLaneKey?: SceneLaneKey | null;
  /** A child lane acquired by crossing its horizontal rail owns an ambiguous
   * first/last boundary until the gesture deliberately crosses back out. */
  horizontalBoundaryLaneKey?: SceneLaneKey | null;
}

export interface LaneExitLandings {
  beforeTop: number;
  afterTop: number;
}

export interface LaneEntryLandings {
  firstTop: number;
  lastTop: number;
}

/** Return whether the dragged flow has reached an adjacent slot's exact
 * renderer-owned landing position. Positive offsets trigger early and negative
 * offsets require passing the destination. Direction normalization gives the
 * setting identical semantics while moving upward or downward. */
export function reachedLandingPosition(
  draggedTop: number,
  landingTop: number,
  direction: number,
  triggerOffsetPx: number,
): boolean {
  if (direction === 0) return false;
  if (![
    draggedTop,
    landingTop,
    triggerOffsetPx,
  ].every(Number.isFinite)) {
    throw new Error("Landing trigger geometry must be finite");
  }
  const normalizedDistance = Math.sign(direction) * (landingTop - draggedTop);
  return normalizedDistance <= triggerOffsetPx;
}

/** Convert horizontal block-body movement into a stable list-depth request.
 * The first depth change activates after 35% of one rendered indent, then each
 * additional depth requires one complete indent. Destination validity is
 * applied separately by the semantic slot owner. */
export function requestedListDepth(
  sourceDepth: number,
  horizontalDeltaPx: number,
  indentPx: number,
): number {
  const source = Math.max(0, Math.trunc(sourceDepth));
  if (!Number.isFinite(horizontalDeltaPx) || !Number.isFinite(indentPx) || indentPx <= 0) {
    return source;
  }
  const magnitude = Math.abs(horizontalDeltaPx);
  const activation = indentPx * 0.35;
  if (magnitude < activation) return source;
  const steps = 1 + Math.floor((magnitude - activation) / indentPx);
  return Math.max(0, source + Math.sign(horizontalDeltaPx) * steps);
}

/** Directional cascade over exact hypothetical landing positions. The resolver
 * is lazy so a fast gesture measures only the destinations it actually reaches.
 * Reversal naturally waits for the prior slot's real landing position rather
 * than relying on a midpoint-sized or block-height-sized artificial band. */
export function selectLandingSlotIndex(
  draggedTop: number,
  direction: number,
  currentIndex: number,
  slotCount: number,
  landingTopAt: (index: number) => number,
  triggerOffsetPx: number | ((fromIndex: number, toIndex: number) => number),
): number {
  if (slotCount <= 0) return -1;
  let index = Math.max(0, Math.min(slotCount - 1, currentIndex));
  if (direction > 0) {
    while (index + 1 < slotCount) {
      const offset = typeof triggerOffsetPx === "function"
        ? triggerOffsetPx(index, index + 1)
        : triggerOffsetPx;
      if (!reachedLandingPosition(
        draggedTop,
        landingTopAt(index + 1),
        direction,
        offset,
      )) break;
      index++;
    }
  } else if (direction < 0) {
    while (index > 0) {
      const offset = typeof triggerOffsetPx === "function"
        ? triggerOffsetPx(index, index - 1)
        : triggerOffsetPx;
      if (!reachedLandingPosition(
        draggedTop,
        landingTopAt(index - 1),
        direction,
        offset,
      )) break;
      index--;
    }
  }
  return index;
}

function laneContainsY(lane: DragSceneLane, documentY: number): boolean {
  return documentY >= lane.ownerRect.top && documentY <= rectBottom(lane.ownerRect);
}

function laneDepth(lane: DragSceneLane | null): number {
  return lane?.depth ?? 0;
}

/** Select the deepest vertically eligible lane whose child rail has been
 * crossed. The active lane retains a symmetric outward hold. */
export function selectLaneIntent(
  lanes: ReadonlyMap<SceneLaneKey, DragSceneLane>,
  rootLaneKey: SceneLaneKey,
  activeLaneKey: SceneLaneKey,
  draggedLeft: number,
  documentY: number,
  config: LaneIntentConfig,
): SceneLaneKey {
  const root = lanes.get(rootLaneKey);
  if (!root) throw new Error("Drag scene is missing its root lane");
  const active = lanes.get(activeLaneKey) ?? root;
  const offsetForLane = (laneKey: SceneLaneKey): number =>
    config.triggerOffsetPxForLane?.(laneKey) ?? config.triggerOffsetPx ?? 0;
  const exitLandings = config.exitLandings?.get(active.key);
  const activeHasExactExit = exitLandings != null;
  const direction = config.direction ?? 0;
  const parentNestingLeft =
    lanes.get(active.parentLaneKey ?? rootLaneKey)?.nestingLeft ?? root.nestingLeft;
  const activeExitLeft = Math.max(
    parentNestingLeft,
    active.nestingLeft - Math.max(0, config.exitInsetPx),
  );
  if (active.key !== rootLaneKey &&
      config.horizontalBoundaryLaneKey === active.key &&
      draggedLeft > activeExitLeft) {
    return active.key;
  }
  if (active.key !== rootLaneKey && exitLandings) {
    const offset = offsetForLane(active.key);
    const reachedDirectionalExit = direction !== 0 && reachedLandingPosition(
      documentY,
      direction < 0 ? exitLandings.beforeTop : exitLandings.afterTop,
      direction,
      offset,
    );
    if (reachedDirectionalExit) {
      return active.parentLaneKey ?? rootLaneKey;
    }
  }
  const candidates = Array.from(lanes.values())
    .filter((lane) => lane.key !== rootLaneKey &&
      lane.key !== config.excludedEntryLaneKey && (
        (lane.key === active.key && activeHasExactExit) || laneContainsY({
          ...lane,
          ownerRect: config.entryOwnerRects?.get(lane.key) ?? lane.ownerRect,
        }, documentY)
      ))
    .filter((lane) => {
      // Entry landings authorize acquiring a different lane. Once a lane owns
      // the drag, only its explicit exit landing (or horizontal rail exit)
      // may release it; reapplying the opposite entry gate makes small pointer
      // reversals alternate between the child and parent lanes.
      if (lane.key === active.key && activeHasExactExit) return true;
      const landing = config.entryLandings?.get(lane.key);
      if (!landing || direction === 0) return true;
      return reachedLandingPosition(
        documentY,
        direction < 0 ? landing.lastTop : landing.firstTop,
        direction,
        offsetForLane(lane.key),
      );
    })
    .sort((a, b) => b.depth - a.depth || b.nestingLeft - a.nestingLeft);
  const entered = candidates.find((lane) => draggedLeft >= lane.nestingLeft);
  if (entered && laneDepth(entered) >= laneDepth(active)) return entered.key;
  if (
    active.key !== rootLaneKey &&
    (activeHasExactExit || laneContainsY(active, documentY)) &&
    draggedLeft > activeExitLeft
  ) {
    return active.key;
  }
  return rootLaneKey;
}

export function slotsForLane(
  lane: DragSceneLane,
  slots: ReadonlyMap<SceneSlotKey, DragSceneSlot>,
): DragSceneSlot[] {
  return lane.slotKeys.map((key) => {
    const slot = slots.get(key);
    if (!slot) throw new Error(`Lane ${lane.key} references missing slot ${key}`);
    return slot;
  });
}
