export interface ScenePoint {
  x: number;
  y: number;
}

export interface SceneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SceneVelocity {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type SceneBlockKey = string;
export type SceneLaneKey = string;
export type SceneSlotKey = string;

export interface DragSceneBlock {
  key: SceneBlockKey;
  pos: number;
  nodeType: string;
  laneKey: SceneLaneKey;
  indexInLane: number;
  parentBlockKey: SceneBlockKey | null;
  depth: number;
  listDepth: number | null;
  rect: SceneRect;
  visualSelector: "img" | "video" | null;
  atomic: boolean;
}

export interface DragSceneLane {
  key: SceneLaneKey;
  contextPos: number | null;
  ownerBlockKey: SceneBlockKey | null;
  parentLaneKey: SceneLaneKey | null;
  depth: number;
  nestingLeft: number;
  ownerRect: SceneRect;
  slotKeys: SceneSlotKey[];
}

export interface DragSceneSlot {
  key: SceneSlotKey;
  laneKey: SceneLaneKey;
  indexInLane: number;
  /** First non-dragged block after this insertion, or null for lane end. */
  beforeBlockKey: SceneBlockKey | null;
  rect: SceneRect;
}

export interface DragSceneSnapshot {
  blocks: ReadonlyMap<SceneBlockKey, DragSceneBlock>;
  lanes: ReadonlyMap<SceneLaneKey, DragSceneLane>;
  slots: ReadonlyMap<SceneSlotKey, DragSceneSlot>;
  rootLaneKey: SceneLaneKey;
  draggedBlockKeys: readonly SceneBlockKey[];
  sourceSlotKey: SceneSlotKey;
}

export interface DragTarget {
  slotKey: SceneSlotKey;
  listDepth: number | null;
}

export interface SceneLayout {
  target: DragTarget;
  blockRects: ReadonlyMap<SceneBlockKey, SceneRect>;
  visualRects: ReadonlyMap<SceneBlockKey, SceneRect>;
  containerRects: ReadonlyMap<SceneBlockKey, SceneRect>;
  /** Structural border-box union that owns document flow. */
  flowRect: SceneRect;
  /** Visible destination bounds the landed block will occupy. */
  landingRect: SceneRect;
  /** Pointer-attached preview bounds; compact scenes may differ from landing. */
  draggedRect: SceneRect;
  /** Destination indicator bounds. Never inferred from the pointer ghost. */
  fillerRect: SceneRect;
}

export interface ScenePointerSample {
  clientX: number;
  clientY: number;
  documentY: number;
  timeMs: number;
}

export interface SceneMotionSample {
  rect: SceneRect;
  velocity: SceneVelocity;
  settled: boolean;
}
