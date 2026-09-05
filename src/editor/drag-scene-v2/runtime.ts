import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { BLOCK_ANIMATOR_SKIP_IDS } from "../block-animator";
import { resolveDragAutoscrollDelta } from "../drag-handles/constants";
import { beginObserverSuppression } from "./dom-observer";
import { multiBlockKey } from "../multi-block-select";
import { scrollHost } from "../../util/dom-utils";
import {
  buildDragSceneMoveTransaction,
  committedGeometryIsExact,
  dragSceneCommitIsNoop,
  type DragSceneCommitInput,
} from "./commit";
import { shouldCompactDragUnit } from "./compaction";
import {
  listDropFillerRect,
  maximumRectEdgeError,
  maximumRectLeadingEdgeError,
  physicalPixelTolerance,
  rectFromDom,
  sceneRect,
  unionVisibleSceneRects,
} from "./geometry";
import { ChromiumDragLayoutOracle } from "./layout-oracle";
import { dragSceneClassMutationIsTransient } from "./invalidation";
import {
  createBrowserSceneClock,
  createBrowserSceneFrameScheduler,
  DragSceneMotionSystem,
  type SceneClock,
  type SceneFrameScheduler,
  type SceneMotionConfig,
  type SceneMotionRetargetOptions,
} from "./motion";
import { DragScenePresentation } from "./presentation";
import {
  canResumePendingMouseRelease,
  createPendingMouseRelease,
  type MouseReleaseProtectionMode,
  type PendingMouseRelease,
} from "./release-resilience";
import { collectDragScene, type CollectedDragScene } from "./scene";
import {
  reachedLandingPosition,
  requestedListDepth,
  selectLaneIntent,
  selectLandingSlotIndex,
  slotsForLane,
} from "./solver";
import type {
  DragSceneLane,
  DragSceneSnapshot,
  DragTarget,
  SceneBlockKey,
  SceneLaneKey,
  SceneLayout,
  SceneRect,
} from "./types";

export type DragSceneMotionPreset = "springy" | "snappy" | "smooth";

export interface DragSceneRuntimeConfig {
  pointerId: number;
  pointerType: string;
  startClientX: number;
  startClientY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  handleRect: SceneRect | null;
  draggedPositions: readonly number[];
  draggedNodes: readonly PMNode[];
  triggerOffsetPx: number;
  containerTriggerOffsetPx: number;
  motionPreset: DragSceneMotionPreset;
  listIndentPx: number;
  compactionTriggerPx: number;
  compactedHeightPx: number;
  mouseReleaseProtection: MouseReleaseProtectionMode;
  onFinish: (result: DragSceneFinishResult) => void;
}

export interface DragSceneFinishResult {
  kind: "drop" | "cancel" | "noop" | "invalidated";
  finishReason: string | null;
  convergenceError: string | null;
  convergenceMaximumErrorPx: number | null;
  convergenceMaximumErrorBlockKey: string | null;
  convergenceMaximumErrorEdge: "left" | "top" | "right" | "bottom" | null;
  oracleMeasurements: number;
  oracleMaximumMeasureMs: number;
  maximumFrameWorkMs: number;
  maximumFrameNonOracleWorkMs: number;
  maximumDraggingFrameWorkMs: number;
  maximumDraggingFrameNonOracleWorkMs: number;
  maximumSettlementFrameWorkMs: number;
  maximumSettlementFrameNonOracleWorkMs: number;
  maximumRetargetWorkMs: number;
  maximumRetargetNonOracleWorkMs: number;
  pointerMoveEvents: number;
  pointerTargetFrames: number;
  coalescedPointerMoves: number;
  compacted: boolean;
  sourceListDepth: number | null;
  targetListDepth: number | null;
  listIndentPx: number;
  horizontalDeltaPx: number;
  convergenceValidatedBlockCount: number;
  convergenceSkippedBlockCount: number;
  finalGhostLandingErrorPx: number | null;
  finalFillerLandingErrorPx: number | null;
}

type RuntimePhase = "dragging" | "settling" | "revealing" | "finished";
type SceneEdge = "left" | "top" | "right" | "bottom";

interface PendingCommitValidation {
  expectedLayout: SceneLayout;
  startedAtMs: number;
  previousActualLayout: SceneLayout | null;
  previousPaintedBlockKeys: ReadonlySet<string> | null;
  stableConfirmations: number;
  unresolvedConfirmations: number;
}

interface CommitConvergenceSample {
  maximumErrorPx: number;
  maximumErrorBlockKey: string | null;
  maximumErrorEdge: SceneEdge | null;
  expectedEdgePx: number | null;
  actualEdgePx: number | null;
  validatedBlockCount: number;
  skippedBlockCount: number;
  missingBlockKey: string | null;
}

// A renderer endpoint is persistent only after three identical frame-bound
// samples (the initial sample plus two confirmations). Transient intrinsic
// placeholders therefore cannot become commit authority.
const COMMIT_STABILITY_CONFIRMATIONS = 2;
const COMMIT_MEDIA_READY_TIMEOUT_MS = 5_000;
const COMMIT_MEDIA_GEOMETRY_GRACE_MS = 180;
const FINAL_REVEAL_DURATION_MS = 90;

const MOTION_CONFIGS: Record<DragSceneMotionPreset, Omit<SceneMotionConfig, "positionTolerance">> = {
  // Preserve the established pre-v2 live-reflow curves while running them on
  // v2's single synchronized scene clock. Ghost-size convergence remains
  // critically damped through omega/velocityTolerance.
  springy: {
    omega: 20,
    velocityTolerance: 1,
    sceneDurationMs: 240,
    sceneEasing: [0.2, 1.2, 0.4, 1],
  },
  snappy: {
    omega: 28,
    velocityTolerance: 1,
    sceneDurationMs: 240,
    sceneEasing: [0.2, 0.8, 0.2, 1],
  },
  smooth: {
    omega: 17,
    velocityTolerance: 0.75,
    sceneDurationMs: 240,
    sceneEasing: [0.4, 0, 0.2, 1],
  },
};

const CONTAINER_HANDOFF_MOTION = {
  sceneDurationMs: 240,
  sceneEasing: [0.2, 0.7, 0.2, 1] as const,
  // A lane change can preserve every numerical block endpoint while changing
  // semantic ownership and filler geometry. Rebase any in-flight Springy
  // curve in that case instead of allowing its subpixel overshoot to leak
  // through the container handoff.
  restartOnEqualTarget: true,
};

const LANE_ENTRY_MIN_SLOP_PX = 4;
const LANE_ENTRY_MAX_SLOP_PX = 24;
const LANE_ENTRY_SEARCH_PADDING_PX = 64;

const GHOST_SETTLEMENT_KEY = "chrome:ghost-settlement";
const ghostContentSettlementKey = (key: SceneBlockKey): string =>
  `chrome:ghost-content:${key}`;

function settlementMotion(
  preset: DragSceneMotionPreset,
  restartOnEqualTarget: boolean,
): SceneMotionRetargetOptions {
  const config = MOTION_CONFIGS[preset];
  return {
    sceneDurationMs: config.sceneDurationMs,
    // Live Springy reflow intentionally has a small overshoot. Once the
    // document is committed, surrounding blocks must approach their renderer
    // positions without crossing them; retain the same timing and x controls
    // while clamping only that overshooting y control.
    sceneEasing: preset === "springy"
      ? [0.2, 1, 0.4, 1]
      : config.sceneEasing,
    restartOnEqualTarget,
  };
}

function translatedLayout(layout: SceneLayout, offsetY: number): SceneLayout {
  const translate = (rect: SceneRect): SceneRect => ({ ...rect, top: rect.top + offsetY });
  return {
    ...layout,
    blockRects: new Map(Array.from(layout.blockRects, ([key, rect]) => [key, translate(rect)])),
    visualRects: new Map(Array.from(layout.visualRects, ([key, rect]) => [key, translate(rect)])),
    containerRects: new Map(Array.from(layout.containerRects, ([key, rect]) => [key, translate(rect)])),
    flowRect: translate(layout.flowRect),
    landingRect: translate(layout.landingRect),
    draggedRect: translate(layout.draggedRect),
    fillerRect: translate(layout.fillerRect),
  };
}

function nearestSlotIndex(slots: readonly { rect: SceneRect }[], documentY: number): number {
  let best = 0;
  let distance = Infinity;
  for (let index = 0; index < slots.length; index++) {
    const candidate = Math.abs(slots[index].rect.top - documentY);
    if (candidate < distance) {
      best = index;
      distance = candidate;
    }
  }
  return best;
}

function naturalSceneLayout(
  scene: CollectedDragScene,
  target: DragTarget,
  listIndentPx: number,
): SceneLayout {
  const blockRects = new Map(Array.from(
    scene.snapshot.blocks,
    ([key, block]) => [key, { ...block.rect }],
  ));
  const visualRects = new Map(Array.from(
    scene.snapshot.blocks,
    ([key, block]) => [
      key,
      rectFromDom((scene.blockVisualDoms.get(key) ?? scene.blockDoms.get(key))
        ?.getBoundingClientRect() ?? block.rect),
    ],
  ));
  const containerRects = new Map<string, SceneRect>();
  for (const [key, block] of scene.snapshot.blocks) {
    if (!block.atomic) containerRects.set(key, { ...block.rect });
  }
  const draggedBlockRects = scene.snapshot.draggedBlockKeys.map((key) => blockRects.get(key)!);
  const flowRect = unionVisibleSceneRects(draggedBlockRects);
  const landingRect = unionVisibleSceneRects(
    scene.snapshot.draggedBlockKeys.map((key) => visualRects.get(key)!),
  );
  if (!flowRect || !landingRect) {
    throw new Error("Drag Scene v2 has no natural flow or landing footprint");
  }
  const firstDraggedDom = scene.blockDoms.get(scene.snapshot.draggedBlockKeys[0]);
  const leadingListPaddingTop = target.listDepth != null && firstDraggedDom
    ? Number.parseFloat(
        firstDraggedDom.ownerDocument.defaultView
          ?.getComputedStyle(firstDraggedDom).paddingTop ?? "",
      )
    : 0;
  return {
    target,
    blockRects,
    visualRects,
    containerRects,
    flowRect,
    landingRect,
    draggedRect: { ...landingRect },
    fillerRect: listDropFillerRect(
      landingRect,
      target.listDepth,
      listIndentPx,
      leadingListPaddingTop,
    ),
  };
}

/** Complete pointer-to-commit coordinator for the live v2 drag scene. */
export class DragSceneRuntime {
  private phase: RuntimePhase = "dragging";
  private readonly ownerWindow: Window & typeof window;
  private readonly ownerDocument: Document;
  private readonly clock: SceneClock;
  private readonly frameScheduler: SceneFrameScheduler;
  private readonly scene: CollectedDragScene;
  private readonly oracle: ChromiumDragLayoutOracle;
  private readonly naturalSourceLayout: SceneLayout;
  private readonly pickupGhostSize: { width: number; height: number };
  private readonly compacted: boolean;
  private readonly mediaCompacted: boolean;
  private readonly flowRegistrationOffsetY: number;
  private snapshot: DragSceneSnapshot;
  private readonly presentation: DragScenePresentation;
  private readonly scroller: HTMLElement | null;
  private readonly scrollerHadDragClass: boolean;
  private readonly startScrollTop: number;
  private currentScrollOffset = 0;
  private lastFrameTimeMs: number;
  private lastClientX: number;
  private lastClientY: number;
  private previousDocumentY: number;
  private activeLaneKey: SceneLaneKey;
  private activeSlotIndex: number;
  private target: DragTarget;
  private currentLayout: SceneLayout;
  private sourceListDepth: number | null;
  private targetListDepth: number | null;
  private ghostMotion: DragSceneMotionSystem<string> | null = null;
  private pendingCommitValidation: PendingCommitValidation | null = null;
  private settleKind: DragSceneFinishResult["kind"] = "cancel";
  private finishReason: string | null = null;
  private convergenceError: string | null = null;
  private convergenceMaximumErrorPx: number | null = null;
  private convergenceMaximumErrorBlockKey: string | null = null;
  private convergenceMaximumErrorEdge: SceneEdge | null = null;
  private convergenceExpectedEdgePx: number | null = null;
  private convergenceActualEdgePx: number | null = null;
  private convergenceValidatedBlockCount = 0;
  private convergenceSkippedBlockCount = 0;
  private maximumFrameWorkMs = 0;
  private maximumFrameNonOracleWorkMs = 0;
  private maximumDraggingFrameWorkMs = 0;
  private maximumDraggingFrameNonOracleWorkMs = 0;
  private maximumSettlementFrameWorkMs = 0;
  private maximumSettlementFrameNonOracleWorkMs = 0;
  private maximumRetargetWorkMs = 0;
  private maximumRetargetNonOracleWorkMs = 0;
  private pointerMoveEvents = 0;
  private pointerTargetFrames = 0;
  private coalescedPointerMoves = 0;
  private pointerTargetPending = false;
  private pendingPointerMoveCount = 0;
  private activeFrameStartedAt: number | null = null;
  private activeFrameOracleStartedAt: number | null = null;
  private mutationObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observedEditorWidth = 0;
  private observedEditorHeight = 0;
  private resizeObserverPrimed = false;
  private targetMeasurementPending = false;
  private targetMeasurementUsesContainerHandoffCurve = false;
  private targetMeasurementSnapsFiller = false;
  private containerHandoffMotionActive = false;
  private verticalExitGuard: { laneKey: SceneLaneKey; direction: -1 | 1 } | null = null;
  private horizontalBoundaryLaneKey: SceneLaneKey | null = null;
  private previousGhostLeft: number;
  private settlementMotionStarted = false;
  private finalRevealEndsAtMs: number | null = null;
  private releasePmObserver: (() => void) | null = null;
  private activePointerId: number;
  private pendingMouseRelease: PendingMouseRelease | null = null;
  private pendingMouseReleaseTimer: number | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly config: DragSceneRuntimeConfig,
  ) {
    this.ownerDocument = view.dom.ownerDocument;
    const ownerWindow = this.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("Drag Scene v2 requires an owning window");
    this.ownerWindow = ownerWindow;
    const initialEditorRect = view.dom.getBoundingClientRect();
    this.observedEditorWidth = initialEditorRect.width;
    this.observedEditorHeight = initialEditorRect.height;
    this.clock = createBrowserSceneClock(ownerWindow);
    this.frameScheduler = createBrowserSceneFrameScheduler(ownerWindow, this.clock);
    this.lastClientX = config.startClientX;
    this.lastClientY = config.startClientY;
    this.previousGhostLeft = config.startClientX - config.grabOffsetX;
    this.activePointerId = config.pointerId;
    this.scene = collectDragScene(view, config.draggedPositions);
    const firstDragged = this.scene.snapshot.blocks.get(
      this.scene.snapshot.draggedBlockKeys[0],
    );
    if (!firstDragged) throw new Error("Drag Scene v2 has no first dragged block");
    this.sourceListDepth = firstDragged.listDepth;
    this.targetListDepth = this.sourceListDepth;
    this.naturalSourceLayout = naturalSceneLayout(this.scene, {
      slotKey: this.scene.snapshot.sourceSlotKey,
      listDepth: this.sourceListDepth,
    }, config.listIndentPx);
    // Pointer pickup is measured from the first structural block while target
    // ownership is measured from the complete dragged flow. Preserve that
    // renderer-derived registration offset instead of assuming both tops are
    // identical for every adapter and multi-block unit.
    this.flowRegistrationOffsetY =
      this.naturalSourceLayout.flowRect.top - firstDragged.rect.top;
    const trigger = Math.max(1, config.compactionTriggerPx);
    const compactedHeight = Math.max(1, Math.min(
      config.compactedHeightPx,
      this.naturalSourceLayout.draggedRect.height,
    ));
    this.compacted = shouldCompactDragUnit(
      this.naturalSourceLayout.draggedRect.height,
      trigger,
      compactedHeight,
    );
    this.mediaCompacted = this.compacted &&
      this.scene.snapshot.draggedBlockKeys.length === 1 &&
      firstDragged.visualSelector != null;
    this.oracle = new ChromiumDragLayoutOracle(this.scene, {
      compactHeightPx: this.compacted ? compactedHeight : null,
      listIndentPx: config.listIndentPx,
    });
    this.snapshot = this.oracle.measureSlotSnapshot(this.targetListDepth);
    this.activeLaneKey = firstDragged.laneKey;
    const sourceLane = this.snapshot.lanes.get(this.activeLaneKey);
    if (!sourceLane) throw new Error("Drag Scene v2 source lane is missing");
    this.activeSlotIndex = sourceLane.slotKeys.indexOf(this.snapshot.sourceSlotKey);
    if (this.activeSlotIndex < 0) throw new Error("Drag Scene v2 source slot is missing");
    this.target = {
      slotKey: this.snapshot.sourceSlotKey,
      listDepth: this.targetListDepth,
    };
    this.currentLayout = this.oracle.measure(this.target);
    // The lifted object is a rigid pointer-owned preview. Destination lanes can
    // be narrower (callouts/quotes) or wider (the root), but resizing only the
    // outer ghost while its faithful cloned pieces retain pickup geometry clips
    // list markers/text and makes the preview appear to drift. Keep pickup size
    // for the active gesture; settlement owns the one coherent size transition
    // to the committed renderer after release.
    this.pickupGhostSize = {
      width: this.currentLayout.draggedRect.width,
      height: this.currentLayout.draggedRect.height,
    };
    this.scroller = scrollHost(view.dom);
    this.scrollerHadDragClass = this.scroller?.classList.contains(
      "butter-drag-scene-scroll-host",
    ) ?? false;
    this.scroller?.classList.add("butter-drag-scene-scroll-host");
    this.startScrollTop = this.scroller?.scrollTop ?? 0;
    const viewport = this.scroller?.getBoundingClientRect() ?? view.dom.getBoundingClientRect();
    const ratio = ownerWindow.devicePixelRatio || 1;
    const motionConfig: SceneMotionConfig = {
      ...MOTION_CONFIGS[config.motionPreset],
      positionTolerance: physicalPixelTolerance(ratio),
    };
    const now = this.clock.now();
    this.lastFrameTimeMs = now;
    this.releasePmObserver = beginObserverSuppression(view);
    // Activate the presentation CSS before the first live sample. The source
    // vacancy and its compensating transforms must enter the cascade together;
    // adding this class afterward exposes one paint where following blocks jump
    // by the removed source height.
    this.ownerDocument.body.classList.add("butter-is-drag-scene-v2");
    try {
      this.presentation = new DragScenePresentation(
        this.scene,
        this.currentLayout,
        rectFromDom(viewport),
        now,
        motionConfig,
        this.compacted,
        config.handleRect,
        this.mediaCompacted,
        this.naturalSourceLayout,
        settlementMotion(config.motionPreset, false),
      );
    } catch (error) {
      this.ownerDocument.body.classList.remove("butter-is-drag-scene-v2");
      this.restoreScrollerOverflowAnchor();
      this.releaseHeldPmObserver();
      throw error;
    }
    this.presentation.retarget(this.currentLayout, now);
    const sourceGhost = this.currentLayout.draggedRect;
    this.presentation.positionGhost(sceneRect(
      config.startClientX - config.grabOffsetX,
      config.startClientY - config.grabOffsetY,
      sourceGhost.width,
      sourceGhost.height,
    ), now);
    this.previousDocumentY = config.startClientY - config.grabOffsetY +
      this.flowRegistrationOffsetY;
    this.installListeners();
    this.installInvalidationObservers();
    this.frameScheduler.request(this.onFrame);
  }

  private installListeners(): void {
    this.ownerWindow.addEventListener("pointerdown", this.onPointerDown, true);
    this.ownerWindow.addEventListener("pointermove", this.onPointerMove);
    this.ownerWindow.addEventListener("pointerup", this.onPointerUp);
    this.ownerWindow.addEventListener("pointercancel", this.onPointerCancel);
    this.ownerWindow.addEventListener("blur", this.onWindowBlur);
    this.ownerDocument.addEventListener("keydown", this.onKeyDown);
    this.scroller?.addEventListener("scroll", this.onScroll, { passive: true });
    if (this.config.pointerType === "touch") {
      this.ownerWindow.addEventListener("touchmove", this.onTouchEvent, {
        passive: false,
        capture: true,
      });
      this.ownerWindow.addEventListener("touchstart", this.onTouchEvent, {
        passive: false,
        capture: true,
      });
      this.ownerWindow.addEventListener("touchend", this.onTouchEvent, {
        passive: false,
        capture: true,
      });
    }
  }

  private removeListeners(keepScroll = false): void {
    this.clearPendingMouseRelease();
    this.ownerWindow.removeEventListener("pointerdown", this.onPointerDown, true);
    this.ownerWindow.removeEventListener("pointermove", this.onPointerMove);
    this.ownerWindow.removeEventListener("pointerup", this.onPointerUp);
    this.ownerWindow.removeEventListener("pointercancel", this.onPointerCancel);
    this.ownerWindow.removeEventListener("blur", this.onWindowBlur);
    this.ownerDocument.removeEventListener("keydown", this.onKeyDown);
    if (!keepScroll) this.scroller?.removeEventListener("scroll", this.onScroll);
    this.ownerWindow.removeEventListener("touchmove", this.onTouchEvent, true);
    this.ownerWindow.removeEventListener("touchstart", this.onTouchEvent, true);
    this.ownerWindow.removeEventListener("touchend", this.onTouchEvent, true);
  }

  private installInvalidationObservers(): void {
    const editorRoot = this.view.dom;
    const HTMLElementCtor = this.ownerWindow.HTMLElement;
    const isTransientHostMutation = (mutation: MutationRecord): boolean => {
      if (mutation.type !== "attributes" || mutation.attributeName !== "class" ||
          mutation.oldValue == null ||
          !mutation.target.instanceOf(HTMLElementCtor)) return false;
      return dragSceneClassMutationIsTransient(
        mutation.oldValue,
        Array.from(mutation.target.classList),
        mutation.target === editorRoot,
      );
    };
    const mutationObserver = new this.ownerWindow.MutationObserver((mutations) => {
      if (this.phase !== "dragging") return;
      const invalidatingMutation = mutations.find((mutation) =>
        !isTransientHostMutation(mutation) && !this.presentation.ownsMutation(mutation)
      );
      if (invalidatingMutation) {
        const target = invalidatingMutation.target;
        const targetName = target.instanceOf(this.ownerWindow.Element)
          ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}`
          : target.nodeName.toLowerCase();
        const detail = invalidatingMutation.type === "attributes"
          ? `${invalidatingMutation.attributeName ?? "unknown"}`
          : `children:+${invalidatingMutation.addedNodes.length}/-${invalidatingMutation.removedNodes.length}`;
        this.cancel("invalidated", `dom-mutation:${targetName}:${detail}`);
      }
    });
    mutationObserver.observe(this.view.dom, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class", "style", "src"],
    });
    this.mutationObserver = mutationObserver;
    if (typeof this.ownerWindow.ResizeObserver === "function") {
      const resizeObserver = new this.ownerWindow.ResizeObserver((entries) => {
        const entry = entries.find((candidate) => candidate.target === this.view.dom);
        if (!entry) return;
        const nextWidth = entry.contentRect.width;
        const nextHeight = entry.contentRect.height;
        if (!this.resizeObserverPrimed) {
          this.resizeObserverPrimed = true;
          this.observedEditorWidth = nextWidth;
          this.observedEditorHeight = nextHeight;
          return;
        }
        const tolerance = physicalPixelTolerance(this.ownerWindow.devicePixelRatio || 1);
        const previousWidth = this.observedEditorWidth;
        const changed = Math.abs(nextWidth - this.observedEditorWidth) > tolerance;
        this.observedEditorWidth = nextWidth;
        this.observedEditorHeight = nextHeight;
        // ResizeObserver always delivers an initial observation. Only a real
        // width change invalidates wrapping and the immutable scene snapshot.
        // Height changes are expected because the hidden live placeholder
        // makes callouts and root flow use their real target geometry.
        if (changed && this.phase === "dragging") {
          this.cancel(
            "invalidated",
            `editor-width:${previousWidth.toFixed(2)}->${nextWidth.toFixed(2)}`,
          );
        }
      });
      resizeObserver.observe(this.view.dom);
      this.resizeObserver = resizeObserver;
    }
  }

  private stopInvalidationObservers(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.phase !== "dragging" || event.pointerId !== this.activePointerId ||
        this.pendingMouseRelease) return;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.pointerMoveEvents++;
    this.pendingPointerMoveCount++;
    this.pointerTargetPending = true;
    event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    const pending = this.pendingMouseRelease;
    if (this.phase !== "dragging" || !pending) return;
    if (!canResumePendingMouseRelease(pending, event, this.clock.now())) {
      // A different pointer action is genuine user input. Commit the waiting
      // release before allowing that new action to continue normally.
      this.confirmPendingMouseRelease();
      return;
    }
    this.clearPendingMouseRelease();
    this.activePointerId = event.pointerId;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.pointerTargetPending = true;
    try { this.view.dom.setPointerCapture(event.pointerId); } catch { /* window listeners remain */ }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.phase !== "dragging" || event.pointerId !== this.activePointerId) return;
    event.preventDefault();
    if (this.pendingMouseRelease) return;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.pointerTargetPending = true;
    const pending = createPendingMouseRelease(
      this.config.mouseReleaseProtection,
      event,
      this.clock.now(),
    );
    if (pending) {
      this.pendingMouseRelease = pending;
      this.pendingMouseReleaseTimer = this.ownerWindow.setTimeout(
        this.confirmPendingMouseRelease,
        pending.graceMs,
      );
      return;
    }
    this.finishReason = "pointer-up";
    this.drop();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.cancel("cancel", `pointer-cancel:${event.pointerType || "unknown"}`);
  };

  private readonly confirmPendingMouseRelease = (): void => {
    if (!this.pendingMouseRelease || this.phase !== "dragging") return;
    this.clearPendingMouseRelease();
    this.finishReason = "protected-pointer-up";
    this.drop();
  };

  private clearPendingMouseRelease(): void {
    if (this.pendingMouseReleaseTimer != null) {
      this.ownerWindow.clearTimeout(this.pendingMouseReleaseTimer);
    }
    this.pendingMouseReleaseTimer = null;
    this.pendingMouseRelease = null;
  }

  private readonly onWindowBlur = (): void => this.cancel("cancel", "window-blur");

  private readonly onTouchEvent = (event: TouchEvent): void => {
    if (this.phase === "dragging") event.preventDefault();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.cancel("cancel", "escape");
  };

  private readonly onScroll = (): void => {
    this.syncScrollOffset();
    if (this.phase === "dragging" && !this.pendingMouseRelease) {
      this.pointerTargetPending = true;
    }
  };

  /** Consume the latest pointer/scroll state once per rendered frame. Raw
   * mobile pointer streams can arrive faster than WebView can paint; solving
   * every intermediate sample only burns the next frame's budget and cannot
   * produce a visible state. Release calls this synchronously so the committed
   * target still represents the exact final pointer position. */
  private flushPointerTarget(): void {
    if (this.phase !== "dragging" || !this.pointerTargetPending) return;
    const pointerMoves = this.pendingPointerMoveCount;
    this.pointerTargetPending = false;
    this.pendingPointerMoveCount = 0;
    this.pointerTargetFrames++;
    this.coalescedPointerMoves += Math.max(0, pointerMoves - 1);
    const startedAt = this.ownerWindow.performance.now();
    const oracleStartedAt = this.oracle.metrics.totalMeasureMs;
    try {
      this.updatePointerTarget();
    } finally {
      const endedAt = this.ownerWindow.performance.now();
      this.maximumRetargetWorkMs = Math.max(
        this.maximumRetargetWorkMs,
        endedAt - startedAt,
      );
      this.maximumRetargetNonOracleWorkMs = Math.max(
        this.maximumRetargetNonOracleWorkMs,
        Math.max(
          0,
          endedAt - startedAt -
            (this.oracle.metrics.totalMeasureMs - oracleStartedAt),
        ),
      );
    }
  }

  private syncScrollOffset(): void {
    this.currentScrollOffset = -((this.scroller?.scrollTop ?? 0) - this.startScrollTop);
    this.presentation.setScrollOffsetY(this.currentScrollOffset);
  }

  private updatePointerTarget(directionHint = 0, deferTargetMeasurement = false): void {
    if (this.phase !== "dragging") return;
    const ghostLeft = this.lastClientX - this.config.grabOffsetX;
    const ghostTop = this.lastClientY - this.config.grabOffsetY;
    const previousGhostLeft = this.previousGhostLeft;
    this.previousGhostLeft = ghostLeft;
    const draggedTop = ghostTop - this.currentScrollOffset +
      this.flowRegistrationOffsetY;
    const direction = directionHint || draggedTop - this.previousDocumentY;
    this.previousDocumentY = draggedTop;
    const laneIntent = this.pointerLaneIntentGeometry(ghostLeft, draggedTop);
    const directionSign = Math.sign(direction) as -1 | 0 | 1;
    if (this.verticalExitGuard && directionSign !== 0 &&
        directionSign !== this.verticalExitGuard.direction) {
      this.verticalExitGuard = null;
    }
    const previousLaneKey = this.activeLaneKey;
    const laneKey = selectLaneIntent(
      laneIntent.lanes,
      this.snapshot.rootLaneKey,
      this.activeLaneKey,
      ghostLeft,
      draggedTop,
      {
        exitInsetPx: 16,
        entryOwnerRects: laneIntent.entryOwnerRects,
        entryLandings: laneIntent.entryLandings,
        exitLandings: laneIntent.exitLandings,
        direction,
        triggerOffsetPx: this.config.triggerOffsetPx,
        triggerOffsetPxForLane: (candidateLaneKey) =>
          this.triggerOffsetForLane(candidateLaneKey),
        excludedEntryLaneKey: this.verticalExitGuard?.laneKey,
        horizontalBoundaryLaneKey: this.horizontalBoundaryLaneKey,
      },
    );
    const previousLane = laneIntent.lanes.get(previousLaneKey);
    const previousExit = laneIntent.exitLandings.get(previousLaneKey);
    if (previousLaneKey !== laneKey && previousLane?.parentLaneKey === laneKey &&
        previousExit && directionSign !== 0) {
      const exitTop = directionSign < 0 ? previousExit.beforeTop : previousExit.afterTop;
      if (reachedLandingPosition(
        draggedTop,
        exitTop,
        direction,
        this.triggerOffsetForLane(previousLaneKey),
      )) {
        this.verticalExitGuard = { laneKey: previousLaneKey, direction: directionSign };
      }
    }
    const lane = this.snapshot.lanes.get(laneKey);
    if (!lane) return;
    const laneSlots = slotsForLane(lane, this.snapshot.slots);
    if (laneSlots.length === 0) return;
    const laneChanged = laneKey !== this.activeLaneKey;
    if (laneChanged) {
      // A lane handoff is a motion sequence, not just one retarget. Pointer
      // movement can select another slot in the destination lane before the
      // first handoff animation settles; keep every retarget in that sequence
      // on the same monotonic curve so the in-flight scene cannot reverse.
      this.containerHandoffMotionActive = true;
      const enteredLane = this.snapshot.lanes.get(laneKey);
      const enteredFromParent = enteredLane?.parentLaneKey === previousLaneKey;
      const crossedChildRail = enteredLane != null &&
        previousGhostLeft < enteredLane.nestingLeft &&
        ghostLeft >= enteredLane.nestingLeft;
      this.horizontalBoundaryLaneKey = enteredFromParent && crossedChildRail
        ? laneKey
        : null;
      this.activeLaneKey = laneKey;
      this.activeSlotIndex = this.nearestLandingSlotIndex(lane, laneSlots, draggedTop);
    } else {
      this.activeSlotIndex = selectLandingSlotIndex(
        draggedTop,
        direction,
        this.activeSlotIndex,
        laneSlots.length,
        (index) => this.landingTopFor(lane, laneSlots[index].key),
        (fromIndex, toIndex) => this.triggerOffsetForSlotTransition(
          laneSlots,
          fromIndex,
          toIndex,
        ),
      );
    }
    if (this.horizontalBoundaryLaneKey === laneKey &&
        this.activeSlotIndex > 0 &&
        this.activeSlotIndex < laneSlots.length - 1) {
      // Once the gesture reaches an unambiguous interior slot, ordinary exact
      // vertical entry/exit geometry resumes.
      this.horizontalBoundaryLaneKey = null;
    }
    this.targetListDepth = this.listDepthFor(lane, laneSlots[this.activeSlotIndex].key);
    const nextTarget: DragTarget = {
      slotKey: laneSlots[this.activeSlotIndex].key,
      listDepth: this.targetListDepth,
    };
    const targetChanged = nextTarget.slotKey !== this.target.slotKey ||
      nextTarget.listDepth !== this.target.listDepth;
    if (targetChanged) {
      this.target = nextTarget;
      this.targetMeasurementUsesContainerHandoffCurve ||=
        laneChanged || this.containerHandoffMotionActive;
      this.targetMeasurementSnapsFiller ||= laneChanged;
      if (deferTargetMeasurement) {
        this.targetMeasurementPending = true;
      } else {
        this.measureCurrentTarget();
      }
    }
    this.presentation.positionGhost(sceneRect(
      ghostLeft,
      ghostTop,
      this.pickupGhostSize.width,
      this.pickupGhostSize.height,
    ), this.clock.now());
  }

  private listDepthFor(lane: DragSceneLane, slotKey: string): number | null {
    if (this.sourceListDepth == null || this.config.listIndentPx <= 0) {
      return this.sourceListDepth;
    }
    const requested = requestedListDepth(
      this.sourceListDepth,
      this.lastClientX - this.config.startClientX,
      this.config.listIndentPx,
    );
    const dragged = new Set(this.snapshot.draggedBlockKeys);
    const remaining = Array.from(this.snapshot.blocks.values())
      .filter((block) => block.laneKey === lane.key && !dragged.has(block.key))
      .sort((a, b) => a.indexInLane - b.indexInLane);
    const insertion = lane.slotKeys.indexOf(slotKey);
    const prior = insertion > 0 ? remaining[insertion - 1] : null;
    const maximum = prior?.nodeType === "list_item"
      ? (prior.listDepth ?? 0) + 1
      : 0;
    return Math.min(maximum, requested);
  }

  private targetLayoutFor(lane: DragSceneLane, slotKey: string): SceneLayout {
    return this.oracle.measure({
      slotKey,
      listDepth: this.listDepthFor(lane, slotKey),
    });
  }

  private landingTopFor(lane: DragSceneLane, slotKey: string): number {
    const layout = this.targetLayoutFor(lane, slotKey);
    const ownerKey = lane.ownerBlockKey;
    if (!ownerKey) return layout.flowRect.top;
    const currentOwner = this.presentation.sampledBlockRect(ownerKey);
    const targetOwner = layout.containerRects.get(ownerKey);
    if (!currentOwner || !targetOwner) return layout.flowRect.top;
    return layout.flowRect.top + currentOwner.top - targetOwner.top;
  }

  private isContainerBlock(blockKey: SceneBlockKey | null | undefined): boolean {
    if (!blockKey) return false;
    const nodeType = this.snapshot.blocks.get(blockKey)?.nodeType;
    return nodeType === "obsidian_callout" || nodeType === "blockquote";
  }

  /** A child-lane handoff represents entering or leaving its owner container. */
  private triggerOffsetForLane(laneKey: SceneLaneKey): number {
    const ownerBlockKey = this.snapshot.lanes.get(laneKey)?.ownerBlockKey;
    return this.isContainerBlock(ownerBlockKey)
      ? this.config.containerTriggerOffsetPx
      : this.config.triggerOffsetPx;
  }

  /** Moving between adjacent insertion slots crosses the remaining block
   * between them. Only callout/quote crossings use the container offset;
   * ordinary children inside those lanes keep normal block semantics. */
  private triggerOffsetForSlotTransition(
    slots: readonly { beforeBlockKey: SceneBlockKey | null }[],
    fromIndex: number,
    toIndex: number,
  ): number {
    const crossedIndex = toIndex > fromIndex ? fromIndex : toIndex;
    return this.isContainerBlock(slots[crossedIndex]?.beforeBlockKey)
      ? this.config.containerTriggerOffsetPx
      : this.config.triggerOffsetPx;
  }

  /** Build lane hit geometry from two deliberate coordinate frames. Eligibility
   * follows the currently painted container, while entry thresholds use the
   * oracle's final document coordinate—the same coordinate immediately painted
   * by the destination filler. This keeps offset zero aligned to the pointer
   * ghost even when removing the source moves the entire container. */
  private pointerLaneIntentGeometry(
    draggedLeft: number,
    draggedTop: number,
  ): {
    lanes: ReadonlyMap<SceneLaneKey, DragSceneLane>;
    entryOwnerRects: ReadonlyMap<SceneLaneKey, SceneRect>;
    entryLandings: ReadonlyMap<SceneLaneKey, { firstTop: number; lastTop: number }>;
    exitLandings: ReadonlyMap<SceneLaneKey, { beforeTop: number; afterTop: number }>;
  } {
    const lanes = new Map<SceneLaneKey, DragSceneLane>();
    const entryOwnerRects = new Map<SceneLaneKey, SceneRect>();
    const entryLandings = new Map<
      SceneLaneKey,
      { firstTop: number; lastTop: number }
    >();
    const exitLandings = new Map<
      SceneLaneKey,
      { beforeTop: number; afterTop: number }
    >();
    const draggedHeight = Math.max(0, this.currentLayout.flowRect.height);
    const naturalEntrySlop = Math.min(
      LANE_ENTRY_MAX_SLOP_PX,
      Math.max(LANE_ENTRY_MIN_SLOP_PX, draggedHeight / 2),
    );
    const entrySlop = Math.max(
      naturalEntrySlop,
      Math.abs(this.config.triggerOffsetPx),
      Math.abs(this.config.containerTriggerOffsetPx),
    );
    const searchPadding = Math.max(LANE_ENTRY_SEARCH_PADDING_PX, draggedHeight);
    for (const [key, lane] of this.snapshot.lanes) {
      if (!lane.ownerBlockKey) {
        lanes.set(key, lane);
        continue;
      }
      const currentOwner = this.presentation.sampledBlockRect(lane.ownerBlockKey) ??
        lane.ownerRect;
      const visibleLane = {
        ...lane,
        nestingLeft: lane.nestingLeft + currentOwner.left - lane.ownerRect.left,
        ownerRect: currentOwner,
      };
      lanes.set(key, visibleLane);
      if (draggedLeft < visibleLane.nestingLeft ||
          draggedTop < currentOwner.top - searchPadding ||
          draggedTop > currentOwner.top + currentOwner.height + searchPadding) {
        continue;
      }
      const slots = slotsForLane(lane, this.snapshot.slots);
      if (slots.length === 0) continue;
      const firstLandingTop = this.targetLayoutFor(lane, slots[0].key).flowRect.top;
      const lastLandingTop = this.targetLayoutFor(
        lane,
        slots[slots.length - 1].key,
      ).flowRect.top;
      entryLandings.set(key, {
        firstTop: firstLandingTop,
        lastTop: lastLandingTop,
      });
      const top = Math.min(currentOwner.top, firstLandingTop, lastLandingTop) - entrySlop;
      const bottom = Math.max(
        currentOwner.top + currentOwner.height,
        firstLandingTop,
        lastLandingTop,
      ) + entrySlop;
      entryOwnerRects.set(key, {
        ...currentOwner,
        top,
        height: bottom - top,
      });

      const parentLane = lane.parentLaneKey
        ? this.snapshot.lanes.get(lane.parentLaneKey)
        : null;
      const ownerBlock = this.snapshot.blocks.get(lane.ownerBlockKey);
      if (!parentLane || !ownerBlock) continue;
      const parentBlocks = Array.from(this.snapshot.blocks.values())
        .filter((block) => block.laneKey === parentLane.key &&
          !this.snapshot.draggedBlockKeys.includes(block.key))
        .sort((a, b) => a.indexInLane - b.indexInLane);
      const ownerIndex = parentBlocks.findIndex((block) => block.key === ownerBlock.key);
      const parentSlots = slotsForLane(parentLane, this.snapshot.slots);
      if (ownerIndex < 0 || ownerIndex + 1 >= parentSlots.length) continue;
      exitLandings.set(key, {
        beforeTop: this.landingTopFor(parentLane, parentSlots[ownerIndex].key),
        afterTop: this.landingTopFor(parentLane, parentSlots[ownerIndex + 1].key),
      });
    }
    return { lanes, entryOwnerRects, entryLandings, exitLandings };
  }

  /** A horizontal lane transition has no adjacent slot history in the new
   * lane. Hill-climb exact renderer destinations after translating them into
   * the destination container's current analytic frame. Source removal may
   * move that entire container; targeting must remain attached to the visible
   * first/last child rail rather than its future document coordinate. */
  private nearestLandingSlotIndex(
    lane: DragSceneLane,
    slots: readonly { key: string; rect: SceneRect }[],
    draggedTop: number,
  ): number {
    let index = nearestSlotIndex(slots, draggedTop);
    let distance = Math.abs(this.landingTopFor(lane, slots[index].key) - draggedTop);
    while (true) {
      let nextIndex = index;
      let nextDistance = distance;
      for (const candidate of [index - 1, index + 1]) {
        if (candidate < 0 || candidate >= slots.length) continue;
        const candidateDistance = Math.abs(
          this.landingTopFor(lane, slots[candidate].key) - draggedTop,
        );
        if (candidateDistance < nextDistance) {
          nextIndex = candidate;
          nextDistance = candidateDistance;
        }
      }
      if (nextIndex === index) return index;
      index = nextIndex;
      distance = nextDistance;
    }
  }

  private readonly onFrame = (timeMs: number): void => {
    const startedAt = this.ownerWindow.performance.now();
    const framePhase = this.phase;
    this.activeFrameStartedAt = startedAt;
    this.activeFrameOracleStartedAt = this.oracle.metrics.totalMeasureMs;
    try {
      this.advanceFrame(timeMs);
    } catch (error) {
      this.convergenceError = `Drag scene frame failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.finishReason = "frame-error";
      this.settleKind = "invalidated";
      this.finish();
    } finally {
      const frameWorkMs = this.ownerWindow.performance.now() - startedAt;
      const frameNonOracleWorkMs = Math.max(
        0,
        frameWorkMs -
          (this.oracle.metrics.totalMeasureMs -
            (this.activeFrameOracleStartedAt ?? this.oracle.metrics.totalMeasureMs)),
      );
      this.maximumFrameWorkMs = Math.max(
        this.maximumFrameWorkMs,
        frameWorkMs,
      );
      this.maximumFrameNonOracleWorkMs = Math.max(
        this.maximumFrameNonOracleWorkMs,
        frameNonOracleWorkMs,
      );
      if (framePhase === "dragging") {
        this.maximumDraggingFrameWorkMs = Math.max(
          this.maximumDraggingFrameWorkMs,
          frameWorkMs,
        );
        this.maximumDraggingFrameNonOracleWorkMs = Math.max(
          this.maximumDraggingFrameNonOracleWorkMs,
          frameNonOracleWorkMs,
        );
      } else if (framePhase === "settling") {
        this.maximumSettlementFrameWorkMs = Math.max(
          this.maximumSettlementFrameWorkMs,
          frameWorkMs,
        );
        this.maximumSettlementFrameNonOracleWorkMs = Math.max(
          this.maximumSettlementFrameNonOracleWorkMs,
          frameNonOracleWorkMs,
        );
      }
      this.activeFrameStartedAt = null;
      this.activeFrameOracleStartedAt = null;
    }
  };

  private advanceFrame(timeMs: number): void {
    if (this.phase === "finished") return;
    if (this.phase === "revealing") {
      if (this.finalRevealEndsAtMs != null && timeMs >= this.finalRevealEndsAtMs) {
        this.finish();
        return;
      }
      this.frameScheduler.request(this.onFrame);
      return;
    }
    const frameMs = Math.min(50, Math.max(0, timeMs - this.lastFrameTimeMs));
    this.lastFrameTimeMs = timeMs;
    if (this.phase === "dragging" && !this.pendingMouseRelease && this.scroller) {
      const viewport = this.scroller.getBoundingClientRect();
      const delta = resolveDragAutoscrollDelta(
        this.lastClientY,
        viewport.top,
        viewport.bottom,
        frameMs,
      );
      this.applyAutoscrollDelta(delta);
    }
    if (this.phase === "dragging") {
      this.flushPointerTarget();
      if (this.targetMeasurementPending) this.measureCurrentTarget();
    }
    const frame = this.presentation.sample(timeMs);
    if (this.phase === "dragging" && frame.settled) {
      this.containerHandoffMotionActive = false;
    }
    let ghostSettled = true;
    if (this.ghostMotion) {
      const ghostSamples = this.ghostMotion.sample(timeMs);
      const ghost = ghostSamples.get(GHOST_SETTLEMENT_KEY);
      if (ghost) {
        this.presentation.positionGhost(ghost.rect, timeMs, false);
        ghostSettled = ghost.settled;
      }
      for (const key of this.snapshot.draggedBlockKeys) {
        const content = ghostSamples.get(ghostContentSettlementKey(key));
        if (!content) continue;
        this.presentation.positionCommittedGhostContent(
          key,
          content.rect.left,
          content.rect.top,
        );
        ghostSettled = ghostSettled && content.settled;
      }
    }
    if (this.phase === "settling" && this.pendingCommitValidation && frame.settled) {
      this.sampleCommittedConvergence(timeMs);
    }
    if (this.phase === "settling" && !this.pendingCommitValidation &&
        frame.settled && ghostSettled) {
      if (this.presentation.beginFinalReveal()) {
        this.phase = "revealing";
        this.finalRevealEndsAtMs = timeMs + FINAL_REVEAL_DURATION_MS;
        this.frameScheduler.request(this.onFrame);
        return;
      }
      this.finish();
      return;
    }
    this.frameScheduler.request(this.onFrame);
  }

  private applyAutoscrollDelta(delta: number): boolean {
    if (!this.scroller) return false;
    if (delta === 0) {
      return false;
    }
    const before = this.scroller.scrollTop;
    this.scroller.scrollTop += delta;
    const consumed = this.scroller.scrollTop - before;
    if (consumed === 0) return false;
    this.currentScrollOffset = -(this.scroller.scrollTop - this.startScrollTop);
    this.presentation.setScrollOffsetY(this.currentScrollOffset);
    this.pointerTargetPending = true;
    return true;
  }

  private measureCurrentTarget(): void {
    this.targetMeasurementPending = false;
    const containerHandoff = this.targetMeasurementUsesContainerHandoffCurve;
    const snapFiller = this.targetMeasurementSnapsFiller;
    this.targetMeasurementUsesContainerHandoffCurve = false;
    this.targetMeasurementSnapsFiller = false;
    this.currentLayout = this.oracle.measure(this.target);
    this.presentation.retarget(
      this.currentLayout,
      this.clock.now(),
      containerHandoff ? CONTAINER_HANDOFF_MOTION : undefined,
      snapFiller,
    );
  }

  private commitInput(): DragSceneCommitInput {
    return {
      snapshot: this.snapshot,
      target: this.target,
      draggedPositions: this.config.draggedPositions,
      draggedNodes: this.config.draggedNodes,
      sourceListDepth: this.sourceListDepth,
      clearSelectionMetaKey: multiBlockKey,
      blockAnimatorSkipMetaKey: BLOCK_ANIMATOR_SKIP_IDS,
    };
  }

  private nextSettlementMotion(): SceneMotionRetargetOptions {
    const options = settlementMotion(
      this.config.motionPreset,
      !this.settlementMotionStarted,
    );
    this.settlementMotionStarted = true;
    return options;
  }

  private restartGhostSettlement(
    landingRect: SceneRect,
    contentOffsets: ReadonlyMap<SceneBlockKey, SceneRect>,
    timeMs: number,
  ): void {
    this.ghostMotion ??= new DragSceneMotionSystem({
      ...MOTION_CONFIGS[this.config.motionPreset],
      positionTolerance: physicalPixelTolerance(this.ownerWindow.devicePixelRatio || 1),
    });
    const starts = new Map<string, SceneRect>([[
      GHOST_SETTLEMENT_KEY,
      rectFromDom(this.presentation.ghost.getBoundingClientRect()),
    ]]);
    const targets = new Map<string, SceneRect>([[GHOST_SETTLEMENT_KEY, landingRect]]);
    for (const [key, offset] of contentOffsets) {
      starts.set(ghostContentSettlementKey(key), offset);
      targets.set(ghostContentSettlementKey(key), sceneRect(0, 0, 0, 0));
    }
    this.ghostMotion.seed(starts, timeMs);
    this.ghostMotion.retarget(targets, timeMs);
  }

  private drop(): void {
    if (this.phase !== "dragging") return;
    // A release can arrive between display frames. Resolve the latest pointer
    // exactly once before commit so fast input coalescing never makes the drop
    // lag one candidate behind the user's final position.
    this.flushPointerTarget();
    if (this.targetMeasurementPending) {
      this.measureCurrentTarget();
    }
    this.targetMeasurementPending = false;
    this.targetMeasurementUsesContainerHandoffCurve = false;
    this.targetMeasurementSnapsFiller = false;
    this.containerHandoffMotionActive = false;
    this.phase = "settling";
    this.removeListeners(true);
    this.stopInvalidationObservers();
    // The filler communicates the live candidate, not the committed landing.
    // Begin dismissing it at release; ghost and block settlement continue on
    // their independent motion clock.
    this.presentation.beginFillerExit();
    this.presentation.beginGhostShadowExit();
    const input = this.commitInput();
    const noOp = dragSceneCommitIsNoop(input);
    this.settleKind = noOp ? "noop" : "drop";
    if (this.compacted && !this.mediaCompacted) {
      // Keep the compact filler's geometry stable while the committed
      // selection expands behind the now-fading cue to natural geometry.
      this.presentation.holdSettlementFiller(this.currentLayout.fillerRect);
    }
    const compactHandoffPrepared = this.compacted &&
      this.presentation.beginCompactHandoff(
        settlementMotion(this.config.motionPreset, false),
      );
    this.presentation.setCompacted(false);
    const now = this.clock.now();
    const expectedFinalLayout = noOp
      ? this.naturalSourceLayout
      : this.oracle.measureNatural(this.target);
    let committedGhostContentOffsets = new Map<SceneBlockKey, SceneRect>();
    let settleRect = translatedLayout(
      expectedFinalLayout,
      this.currentScrollOffset,
    ).landingRect;
    if (noOp) {
      this.currentLayout = this.naturalSourceLayout;
      this.presentation.retarget(
        this.naturalSourceLayout,
        now,
        this.nextSettlementMotion(),
      );
      if (compactHandoffPrepared) this.presentation.activateCompactHandoff();
    }
    if (!noOp) {
      const transaction = buildDragSceneMoveTransaction(this.view, input);
      if (!transaction) {
        this.convergenceError = "Drag transaction could not be built";
        this.finishReason = "transaction-unavailable";
        this.settleKind = "invalidated";
        this.currentLayout = this.naturalSourceLayout;
        this.presentation.retarget(
          this.naturalSourceLayout,
          now,
          this.nextSettlementMotion(),
        );
        settleRect = translatedLayout(
          this.naturalSourceLayout,
          this.currentScrollOffset,
        ).landingRect;
        if (compactHandoffPrepared) this.presentation.activateCompactHandoff();
      } else {
        this.currentLayout = expectedFinalLayout;
        let dispatched = false;
        try {
          // Restore the source DOM before dispatch so ProseMirror reconciles a
          // clean tree. There is no paint between this restoration, the one
          // document transaction, and the live-scene rebind.
          this.presentation.prepareForCommit(now);
          this.releaseHeldPmObserver();
          this.view.dispatch(transaction);
          dispatched = true;
          // Read the clean committed renderer before binding presentation
          // transforms to it. A synchronous post-dispatch read can still be a
          // one-line intrinsic placeholder, so only exact renderer geometry
          // may replace the oracle-owned settlement endpoint immediately.
          const initialCommitted = this.measureCommittedLayout();
          const draggedKeys = this.snapshot.draggedBlockKeys;
          const initialDraggedBlocksMeasurable = initialCommitted != null &&
            draggedKeys.every((key) => !initialCommitted.unmeasurableBlockKeys.has(key));
          const initialDraggedVisualsReady = initialCommitted != null &&
            draggedKeys.every((key) => !initialCommitted.unreadyVisualBlockKeys.has(key));
          const draggedHasVisualRenderer = draggedKeys.some(
            (key) => this.snapshot.blocks.get(key)?.visualSelector != null,
          );
          const initialCommittedReady = initialCommitted != null &&
            initialDraggedBlocksMeasurable && initialDraggedVisualsReady;
          const expectedViewport = translatedLayout(
            expectedFinalLayout,
            this.currentScrollOffset,
          );
          const initialSample = initialCommittedReady
            ? this.convergenceSample(
                expectedViewport,
                initialCommitted.layout,
                initialCommitted.paintedBlockKeys,
              )
            : null;
          const tolerance = physicalPixelTolerance(
            this.ownerWindow.devicePixelRatio || 1,
          );
          const initialCommittedExact = initialSample != null &&
            committedGeometryIsExact(
              initialSample.missingBlockKey,
              initialSample.maximumErrorPx,
              tolerance,
            );
          this.releasePmObserver = beginObserverSuppression(this.view);
          const committedBindingLayout = initialCommittedExact && initialCommitted
            ? initialCommitted.layout
            : expectedViewport;
          committedGhostContentOffsets = new Map(this.presentation.bindCommittedDom(
            this.view,
            committedBindingLayout,
            now,
            initialCommitted?.layout ?? null,
          ));
          if (initialCommittedExact && initialCommitted) {
            this.handoffCommittedLayout(initialCommitted.layout, now);
            settleRect = initialCommitted.layout.landingRect;
          } else {
            this.presentation.handoffCommittedLayout(
              expectedFinalLayout,
              now,
              this.nextSettlementMotion(),
            );
          }
          let requiresFrameValidation = true;
          if (initialCommittedExact && initialCommitted && initialSample) {
            this.recordConvergenceSample(initialSample);
            requiresFrameValidation = false;
          } else if (initialCommitted && !initialDraggedBlocksMeasurable &&
              !draggedHasVisualRenderer) {
            // A zero-sized content-visibility placeholder has no physical
            // endpoint to validate in this frame. It must not keep a completed
            // drag alive; final chrome is still checked against the fully
            // revealed DOM during teardown.
            this.convergenceValidatedBlockCount = initialCommitted.paintedBlockKeys.size;
            this.convergenceSkippedBlockCount = Math.max(
              0,
              this.snapshot.blocks.size - initialCommitted.paintedBlockKeys.size,
            );
            requiresFrameValidation = false;
          }
          this.pendingCommitValidation = requiresFrameValidation
            ? {
                expectedLayout: expectedFinalLayout,
                startedAtMs: now,
                previousActualLayout: initialCommittedReady ? initialCommitted.layout : null,
                previousPaintedBlockKeys: initialCommittedReady
                  ? initialCommitted.paintedBlockKeys
                  : null,
                stableConfirmations: 0,
                unresolvedConfirmations: 0,
              }
            : null;
        } catch (error) {
          if (!this.releasePmObserver) {
            this.releasePmObserver = beginObserverSuppression(this.view);
          }
          this.convergenceError = `Drag commit handoff failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          this.finishReason = dispatched ? "post-dispatch-handoff-error" : "commit-handoff-error";
          // A successful dispatch cannot be described as a cancellation even
          // if presentation rebinding fails. Fail closed and reveal the real
          // committed DOM immediately; before dispatch, the exact source DOM
          // has already been restored and the result remains an invalidation.
          this.settleKind = dispatched ? "drop" : "invalidated";
          this.finish();
          return;
        }
      }
    }
    const ghostStartTime = this.clock.now();
    this.restartGhostSettlement(settleRect, committedGhostContentOffsets, ghostStartTime);
  }

  private convergenceSample(
    expected: SceneLayout,
    actual: SceneLayout,
    paintedBlockKeys: ReadonlySet<string>,
  ): CommitConvergenceSample {
    const sample: CommitConvergenceSample = {
      maximumErrorPx: 0,
      maximumErrorBlockKey: null,
      maximumErrorEdge: null,
      expectedEdgePx: null,
      actualEdgePx: null,
      validatedBlockCount: 0,
      skippedBlockCount: 0,
      missingBlockKey: null,
    };
    for (const [key, expectedRect] of expected.blockRects) {
      const measured = actual.blockRects.get(key);
      if (!measured) {
        sample.missingBlockKey = key;
        continue;
      }
      // Offscreen intrinsic placeholders have no painted edge in this frame.
      // Dragged members remain mandatory even during view-only folding.
      if (!paintedBlockKeys.has(key) &&
          !this.snapshot.draggedBlockKeys.includes(key)) {
        sample.skippedBlockCount++;
        continue;
      }
      sample.validatedBlockCount++;
      const expectedEdges = {
        left: expectedRect.left,
        top: expectedRect.top,
        right: expectedRect.left + expectedRect.width,
        bottom: expectedRect.top + expectedRect.height,
      } as const;
      const actualEdges = {
        left: measured.left,
        top: measured.top,
        right: measured.left + measured.width,
        bottom: measured.top + measured.height,
      } as const;
      for (const edge of Object.keys(expectedEdges) as SceneEdge[]) {
        const error = Math.abs(actualEdges[edge] - expectedEdges[edge]);
        if (error <= sample.maximumErrorPx) continue;
        sample.maximumErrorPx = error;
        sample.maximumErrorBlockKey = key;
        sample.maximumErrorEdge = edge;
        sample.expectedEdgePx = expectedEdges[edge];
        sample.actualEdgePx = actualEdges[edge];
      }
    }
    const draggedVisualEdges = {
      left: [expected.draggedRect.left, actual.draggedRect.left],
      top: [expected.draggedRect.top, actual.draggedRect.top],
      right: [
        expected.draggedRect.left + expected.draggedRect.width,
        actual.draggedRect.left + actual.draggedRect.width,
      ],
      bottom: [
        expected.draggedRect.top + expected.draggedRect.height,
        actual.draggedRect.top + actual.draggedRect.height,
      ],
    } as const;
    for (const edge of Object.keys(draggedVisualEdges) as SceneEdge[]) {
      const [expectedEdge, actualEdge] = draggedVisualEdges[edge];
      const error = Math.abs(actualEdge - expectedEdge);
      if (error <= sample.maximumErrorPx) continue;
      sample.maximumErrorPx = error;
      sample.maximumErrorBlockKey = "chrome:dragged-visual";
      sample.maximumErrorEdge = edge;
      sample.expectedEdgePx = expectedEdge;
      sample.actualEdgePx = actualEdge;
    }
    return sample;
  }

  private layoutsMatch(
    first: SceneLayout,
    second: SceneLayout,
    blockKeys: ReadonlySet<string>,
    tolerance: number,
  ): boolean {
    for (const key of blockKeys) {
      const firstRect = first.blockRects.get(key);
      const secondRect = second.blockRects.get(key);
      if (!firstRect || !secondRect) return false;
      const errors = [
        Math.abs(firstRect.left - secondRect.left),
        Math.abs(firstRect.top - secondRect.top),
        Math.abs(firstRect.left + firstRect.width - secondRect.left - secondRect.width),
        Math.abs(firstRect.top + firstRect.height - secondRect.top - secondRect.height),
      ];
      if (errors.some((error) => error > tolerance)) return false;
    }
    for (const key of blockKeys) {
      const firstRect = first.visualRects.get(key);
      const secondRect = second.visualRects.get(key);
      if (!firstRect || !secondRect) return false;
      const errors = [
        Math.abs(firstRect.left - secondRect.left),
        Math.abs(firstRect.top - secondRect.top),
        Math.abs(firstRect.left + firstRect.width - secondRect.left - secondRect.width),
        Math.abs(firstRect.top + firstRect.height - secondRect.top - secondRect.height),
      ];
      if (errors.some((error) => error > tolerance)) return false;
    }
    return true;
  }

  private sampleCommittedConvergence(timeMs: number): void {
    const pending = this.pendingCommitValidation;
    if (!pending) return;
    this.syncScrollOffset();
    const committed = this.presentation.measureNaturalCommittedDom(
      () => this.measureCommittedLayout(),
    );
    if (!committed) {
      pending.unresolvedConfirmations++;
      if (pending.unresolvedConfirmations <= COMMIT_STABILITY_CONFIRMATIONS) return;
      this.convergenceError = "Committed scene DOM could not be resolved across renderer frames";
      this.pendingCommitValidation = null;
      return;
    }
    const expectedViewport = translatedLayout(
      pending.expectedLayout,
      this.currentScrollOffset,
    );
    const tolerance = physicalPixelTolerance(this.ownerWindow.devicePixelRatio || 1);
    const unmeasurableDraggedBlock = this.snapshot.draggedBlockKeys.some(
      (key) => committed.unmeasurableBlockKeys.has(key),
    );
    if (unmeasurableDraggedBlock) {
      // Chromium may deliberately substitute a zero-sized
      // content-visibility placeholder for an offscreen committed block. That
      // is not a renderer endpoint and must neither delay teardown nor replace
      // the already-measured oracle geometry.
      this.convergenceValidatedBlockCount = committed.paintedBlockKeys.size;
      this.convergenceSkippedBlockCount = Math.max(
        0,
        this.snapshot.blocks.size - committed.paintedBlockKeys.size,
      );
      this.pendingCommitValidation = null;
      return;
    }
    const unreadyDraggedMediaKeys = new Set<string>();
    const mismatchedDraggedMediaKeys = new Set<string>();
    for (const key of this.snapshot.draggedBlockKeys) {
      if (!this.snapshot.blocks.get(key)?.visualSelector) continue;
      const expectedVisual = expectedViewport.visualRects.get(key);
      const actualVisual = committed.layout.visualRects.get(key);
      if (committed.unreadyVisualBlockKeys.has(key) ||
          !expectedVisual || !actualVisual) {
        unreadyDraggedMediaKeys.add(key);
      } else if (
          Math.abs(expectedVisual.width - actualVisual.width) > tolerance ||
          Math.abs(expectedVisual.height - actualVisual.height) > tolerance
      ) {
        mismatchedDraggedMediaKeys.add(key);
      }
    }
    if (unreadyDraggedMediaKeys.size > 0) {
      pending.previousActualLayout = null;
      pending.previousPaintedBlockKeys = null;
      pending.stableConfirmations = 0;
      if (timeMs - pending.startedAtMs >= COMMIT_MEDIA_READY_TIMEOUT_MS) {
        const sample = this.convergenceSample(
          expectedViewport,
          committed.layout,
          committed.paintedBlockKeys,
        );
        this.recordConvergenceSample(sample);
        this.convergenceError =
          `Committed media geometry did not resolve within ` +
          `${COMMIT_MEDIA_READY_TIMEOUT_MS}ms (${Array.from(unreadyDraggedMediaKeys).join(", ")})`;
        this.handoffCommittedLayout(committed.layout, timeMs);
        this.pendingCommitValidation = null;
      }
      return;
    }
    // A decoded renderer can legitimately settle at geometry different from
    // the oracle (theme/plugin CSS, late native wrapper enhancement). Give it
    // a short frame-bounded grace period, then let the ordinary stable-layout
    // proof adopt the real renderer. Never hold the entire live reflow scene
    // for the five-second media-load timeout when the media is already ready.
    if (mismatchedDraggedMediaKeys.size > 0 &&
        timeMs - pending.startedAtMs < COMMIT_MEDIA_GEOMETRY_GRACE_MS) {
      const stableKeys = new Set(this.snapshot.draggedBlockKeys);
      const stable = pending.previousActualLayout != null &&
        this.layoutsMatch(
          pending.previousActualLayout,
          committed.layout,
          stableKeys,
          tolerance,
        );
      pending.stableConfirmations = stable ? pending.stableConfirmations + 1 : 0;
      pending.previousActualLayout = committed.layout;
      pending.previousPaintedBlockKeys = committed.paintedBlockKeys;
      return;
    }
    pending.unresolvedConfirmations = 0;
    const sample = this.convergenceSample(
      expectedViewport,
      committed.layout,
      committed.paintedBlockKeys,
    );
    const exact = sample.missingBlockKey == null && sample.maximumErrorPx <= tolerance;
    const stableBlockKeys = new Set(this.snapshot.draggedBlockKeys);
    if (pending.previousPaintedBlockKeys) {
      for (const key of committed.paintedBlockKeys) {
        if (pending.previousPaintedBlockKeys.has(key)) stableBlockKeys.add(key);
      }
    }
    if (sample.maximumErrorBlockKey &&
        this.snapshot.blocks.has(sample.maximumErrorBlockKey)) {
      stableBlockKeys.add(sample.maximumErrorBlockKey);
    }
    const stable = pending.previousActualLayout != null &&
      this.layoutsMatch(
        pending.previousActualLayout,
        committed.layout,
        stableBlockKeys,
        tolerance,
      );
    pending.stableConfirmations = stable ? pending.stableConfirmations + 1 : 0;
    pending.previousActualLayout = committed.layout;
    pending.previousPaintedBlockKeys = committed.paintedBlockKeys;
    if (!exact && pending.stableConfirmations < COMMIT_STABILITY_CONFIRMATIONS) return;

    this.recordConvergenceSample(sample);
    if (sample.missingBlockKey) {
      this.convergenceError = `Committed scene lost renderer block ${sample.missingBlockKey}`;
    } else if (!exact) {
      this.convergenceError =
        `Committed scene geometry diverged by ${sample.maximumErrorPx.toFixed(3)}px ` +
        `at ${sample.maximumErrorBlockKey ?? "unknown"}.` +
        `${sample.maximumErrorEdge ?? "edge"} ` +
        `(expected ${sample.expectedEdgePx?.toFixed(3) ?? "unknown"}, ` +
        `actual ${sample.actualEdgePx?.toFixed(3) ?? "unknown"}; ` +
        `tolerance ${tolerance.toFixed(3)}px)`;
    }

    // Whether exact or persistently divergent, the presentation hands off at
    // the last real renderer geometry; no reported mismatch can cause a jump.
    this.handoffCommittedLayout(committed.layout, timeMs);
    this.pendingCommitValidation = null;
  }

  private recordConvergenceSample(sample: CommitConvergenceSample): void {
    this.convergenceMaximumErrorPx = sample.maximumErrorPx;
    this.convergenceMaximumErrorBlockKey = sample.maximumErrorBlockKey;
    this.convergenceMaximumErrorEdge = sample.maximumErrorEdge;
    this.convergenceExpectedEdgePx = sample.expectedEdgePx;
    this.convergenceActualEdgePx = sample.actualEdgePx;
    this.convergenceValidatedBlockCount = sample.validatedBlockCount;
    this.convergenceSkippedBlockCount = sample.skippedBlockCount;
  }

  private handoffCommittedLayout(layout: SceneLayout, timeMs: number): void {
    const actualDocument = translatedLayout(layout, -this.currentScrollOffset);
    this.currentLayout = actualDocument;
    this.presentation.handoffCommittedLayout(
      actualDocument,
      timeMs,
      this.nextSettlementMotion(),
    );
    if (this.ghostMotion) {
      const contentOffsets = this.presentation.refreshCommittedGhost(layout);
      this.restartGhostSettlement(layout.landingRect, contentOffsets, timeMs);
    }
  }

  private measureCommittedLayout(): {
    layout: SceneLayout;
    paintedBlockKeys: ReadonlySet<string>;
    unreadyVisualBlockKeys: ReadonlySet<string>;
    unmeasurableBlockKeys: ReadonlySet<string>;
  } | null {
    const expectedKeys = new Set(this.snapshot.blocks.keys());
    const blockRects = new Map<string, SceneRect>();
    const visualRects = new Map<string, SceneRect>();
    const measuredDoms = new Map<string, HTMLElement>();
    const containerRects = new Map<string, SceneRect>();
    const paintedBlockKeys = new Set<string>();
    const unreadyVisualBlockKeys = new Set<string>();
    const unmeasurableBlockKeys = new Set<string>();
    const viewport = rectFromDom(
      this.scroller?.getBoundingClientRect() ?? this.ownerDocument.documentElement.getBoundingClientRect(),
    );
    this.view.state.doc.descendants((node, pos) => {
      const blockId: unknown = node.attrs?.blockId;
      const stableKey = typeof blockId === "string" && blockId.length > 0
        ? `block:${blockId}`
        : `pos:${pos}:${node.type.name}`;
      if (!expectedKeys.has(stableKey)) return;
      const dom = this.view.nodeDOM(pos);
      if (dom instanceof this.ownerWindow.HTMLElement) {
        measuredDoms.set(stableKey, dom);
        const rect = rectFromDom(dom.getBoundingClientRect());
        blockRects.set(stableKey, rect);
        const visualSelector = this.snapshot.blocks.get(stableKey)?.visualSelector;
        const visualDom = visualSelector
          ? dom.querySelector<HTMLElement>(visualSelector) ?? dom
          : dom;
        const visualRect = visualDom === dom
          ? rect
          : rectFromDom(visualDom.getBoundingClientRect());
        visualRects.set(stableKey, visualRect);
        const originalRect = this.snapshot.blocks.get(stableKey)?.rect;
        if (originalRect && originalRect.width > 0.5 && originalRect.height > 0.5 &&
            (rect.width <= 0.5 || rect.height <= 0.5 ||
              visualRect.width <= 0.5 || visualRect.height <= 0.5)) {
          unmeasurableBlockKeys.add(stableKey);
        }
        if (visualSelector === "img") {
          const image = visualDom as HTMLImageElement;
          if (!image.complete || image.naturalWidth <= 0) {
            unreadyVisualBlockKeys.add(stableKey);
          }
        } else if (visualSelector === "video") {
          const video = visualDom as HTMLVideoElement;
          if (video.readyState < 1 || video.videoWidth <= 0) {
            unreadyVisualBlockKeys.add(stableKey);
          }
        }
        const intersectsViewport = rect.left + rect.width > viewport.left &&
          rect.left < viewport.left + viewport.width &&
          rect.top + rect.height > viewport.top &&
          rect.top < viewport.top + viewport.height;
        if (intersectsViewport &&
            (typeof dom.checkVisibility !== "function" || dom.checkVisibility({
              contentVisibilityAuto: true,
            }))) {
          paintedBlockKeys.add(stableKey);
        }
        if (!this.snapshot.blocks.get(stableKey)?.atomic) {
          containerRects.set(stableKey, rect);
        }
      }
    });
    if (blockRects.size !== expectedKeys.size) return null;
    const draggedRect = unionVisibleSceneRects(
      this.snapshot.draggedBlockKeys.map((key) => visualRects.get(key)!),
    );
    const flowRect = unionVisibleSceneRects(
      this.snapshot.draggedBlockKeys.map((key) => blockRects.get(key)!),
    );
    if (!draggedRect || !flowRect) return null;
    const committedFirst = this.scene.snapshot.draggedBlockKeys[0];
    const committedFirstDom = committedFirst ? measuredDoms.get(committedFirst) : null;
    const leadingListPaddingTop = this.target.listDepth != null && committedFirstDom
      ? Number.parseFloat(
          committedFirstDom.ownerDocument.defaultView
            ?.getComputedStyle(committedFirstDom).paddingTop ?? "",
        )
      : 0;
    return {
      layout: {
        target: this.target,
        blockRects,
        visualRects,
        containerRects,
        flowRect,
        landingRect: draggedRect,
        draggedRect,
        fillerRect: listDropFillerRect(
          draggedRect,
          this.target.listDepth,
          this.config.listIndentPx,
          leadingListPaddingTop,
        ),
      },
      paintedBlockKeys,
      unreadyVisualBlockKeys,
      unmeasurableBlockKeys,
    };
  }

  cancel(
    kind: "cancel" | "invalidated" = "cancel",
    reason: string = kind,
  ): void {
    if (this.phase !== "dragging") return;
    this.finishReason = reason;
    this.phase = "settling";
    this.settleKind = kind;
    this.removeListeners(true);
    this.stopInvalidationObservers();
    this.target = {
      slotKey: this.snapshot.sourceSlotKey,
      listDepth: this.sourceListDepth,
    };
    this.targetMeasurementPending = false;
    this.targetMeasurementUsesContainerHandoffCurve = false;
    this.targetMeasurementSnapsFiller = false;
    this.containerHandoffMotionActive = false;
    this.currentLayout = this.naturalSourceLayout;
    const translated = translatedLayout(this.currentLayout, this.currentScrollOffset);
    const now = this.clock.now();
    this.presentation.setCompacted(false);
    this.presentation.retarget(
      this.currentLayout,
      now,
      this.nextSettlementMotion(),
    );
    this.ghostMotion = new DragSceneMotionSystem({
      ...MOTION_CONFIGS[this.config.motionPreset],
      positionTolerance: physicalPixelTolerance(this.ownerWindow.devicePixelRatio || 1),
    });
    this.ghostMotion.seed(new Map([[
      GHOST_SETTLEMENT_KEY,
      rectFromDom(this.presentation.ghost.getBoundingClientRect()),
    ]]), now);
    this.ghostMotion.retarget(
      new Map([[GHOST_SETTLEMENT_KEY, translated.landingRect]]),
      now,
    );
  }

  private finish(): void {
    if (this.phase === "finished") return;
    const maximumFrameWorkMs = this.activeFrameStartedAt == null
      ? this.maximumFrameWorkMs
      : Math.max(
        this.maximumFrameWorkMs,
        this.ownerWindow.performance.now() - this.activeFrameStartedAt,
      );
    const maximumFrameNonOracleWorkMs = this.activeFrameStartedAt == null
      ? this.maximumFrameNonOracleWorkMs
      : Math.max(
        this.maximumFrameNonOracleWorkMs,
        Math.max(
          0,
          this.ownerWindow.performance.now() - this.activeFrameStartedAt -
            (this.oracle.metrics.totalMeasureMs -
              (this.activeFrameOracleStartedAt ?? this.oracle.metrics.totalMeasureMs)),
        ),
      );
    const activeSettlementFrameWorkMs = this.activeFrameStartedAt == null
      ? 0
      : this.ownerWindow.performance.now() - this.activeFrameStartedAt;
    const activeSettlementFrameNonOracleWorkMs = this.activeFrameStartedAt == null
      ? 0
      : Math.max(
          0,
          activeSettlementFrameWorkMs -
            (this.oracle.metrics.totalMeasureMs -
              (this.activeFrameOracleStartedAt ?? this.oracle.metrics.totalMeasureMs)),
        );
    const maximumSettlementFrameWorkMs = Math.max(
      this.maximumSettlementFrameWorkMs,
      activeSettlementFrameWorkMs,
    );
    const maximumSettlementFrameNonOracleWorkMs = Math.max(
      this.maximumSettlementFrameNonOracleWorkMs,
      activeSettlementFrameNonOracleWorkMs,
    );
    const overlayRects = this.presentation.overlayRects();
    this.phase = "finished";
    this.removeListeners();
    this.stopInvalidationObservers();
    this.frameScheduler.cancel();
    this.presentation.destroy();
    this.ownerDocument.body.classList.remove("butter-is-drag-scene-v2");
    const finalCommitted = this.settleKind === "drop"
      ? this.measureCommittedLayout()
      : null;
    const finalDraggedMeasurable = finalCommitted != null &&
      this.snapshot.draggedBlockKeys.every(
        (key) => !finalCommitted.unmeasurableBlockKeys.has(key),
      );
    const finalLanding = finalDraggedMeasurable
      ? finalCommitted.layout.landingRect
      : null;
    const finalGhostLandingErrorPx = overlayRects && finalLanding
      ? maximumRectEdgeError(overlayRects.ghost, finalLanding)
      : null;
    const finalFillerLandingErrorPx = overlayRects && finalCommitted
      ? (this.compacted ? maximumRectLeadingEdgeError : maximumRectEdgeError)(
          overlayRects.filler,
          finalCommitted.layout.fillerRect,
        )
      : null;
    this.releaseHeldPmObserver();
    this.oracle.destroy();
    this.restoreScrollerOverflowAnchor();
    this.config.onFinish({
      kind: this.settleKind,
      finishReason: this.finishReason,
      convergenceError: this.convergenceError,
      convergenceMaximumErrorPx: this.convergenceMaximumErrorPx,
      convergenceMaximumErrorBlockKey: this.convergenceMaximumErrorBlockKey,
      convergenceMaximumErrorEdge: this.convergenceMaximumErrorEdge,
      oracleMeasurements: this.oracle.metrics.measurements,
      oracleMaximumMeasureMs: this.oracle.metrics.maximumMeasureMs,
      maximumFrameWorkMs,
      maximumFrameNonOracleWorkMs,
      maximumDraggingFrameWorkMs: this.maximumDraggingFrameWorkMs,
      maximumDraggingFrameNonOracleWorkMs: this.maximumDraggingFrameNonOracleWorkMs,
      maximumSettlementFrameWorkMs,
      maximumSettlementFrameNonOracleWorkMs,
      maximumRetargetWorkMs: this.maximumRetargetWorkMs,
      maximumRetargetNonOracleWorkMs: this.maximumRetargetNonOracleWorkMs,
      pointerMoveEvents: this.pointerMoveEvents,
      pointerTargetFrames: this.pointerTargetFrames,
      coalescedPointerMoves: this.coalescedPointerMoves,
      compacted: this.compacted,
      sourceListDepth: this.sourceListDepth,
      targetListDepth: this.targetListDepth,
      listIndentPx: this.config.listIndentPx,
      horizontalDeltaPx: this.lastClientX - this.config.startClientX,
      convergenceValidatedBlockCount: this.convergenceValidatedBlockCount,
      convergenceSkippedBlockCount: this.convergenceSkippedBlockCount,
      finalGhostLandingErrorPx,
      finalFillerLandingErrorPx,
    });
  }

  destroy(): void {
    if (this.phase === "finished") return;
    this.phase = "finished";
    this.removeListeners();
    this.stopInvalidationObservers();
    this.frameScheduler.cancel();
    this.presentation.destroy();
    this.releaseHeldPmObserver();
    this.oracle.destroy();
    this.restoreScrollerOverflowAnchor();
    this.ownerDocument.body.classList.remove("butter-is-drag-scene-v2");
  }

  private restoreScrollerOverflowAnchor(): void {
    if (!this.scroller || this.scrollerHadDragClass) return;
    this.scroller.classList.remove("butter-drag-scene-scroll-host");
  }

  private releaseHeldPmObserver(): void {
    const release = this.releasePmObserver;
    this.releasePmObserver = null;
    release?.();
  }
}
