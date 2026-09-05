/** Stable outer gutter rail shared by blocks at the same nesting depth. */
export const HANDLE_OFFSET_LEFT = 39;
export const HANDLE_WIDTH = 22;
export const HANDLE_HEIGHT = 22;
export const HANDLE_OFFSET_TOP = 1;
export const DRAG_THRESHOLD = 4;
export const TOUCH_LONGPRESS_MS = 400;
export const TOUCH_LONGPRESS_MOVE_PX = 8;
export const MENU_GAP = 6;
export const MENU_WIDTH = 240;

export const AUTOSCROLL_EDGE_PX = 70;
export const AUTOSCROLL_MAX_PX_PER_SECOND = 600;
export const DEFAULT_DRAG_TRIGGER_OFFSET_PX = 18;
export const DEFAULT_CONTAINER_DRAG_TRIGGER_OFFSET_PX = 0;
export const DRAG_TRIGGER_OFFSET_MIN_PX = -32;
export const DRAG_TRIGGER_OFFSET_MAX_PX = 32;

export function resolveDragTriggerOffsetPx(
  value: number,
  fallback = DEFAULT_DRAG_TRIGGER_OFFSET_PX,
): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.min(
    DRAG_TRIGGER_OFFSET_MAX_PX,
    Math.max(DRAG_TRIGGER_OFFSET_MIN_PX, finite),
  );
}

/** Resolve one refresh-rate-independent autoscroll step. */
export function resolveDragAutoscrollDelta(
  pointerY: number,
  viewportTop: number,
  viewportBottom: number,
  frameMs: number,
): number {
  const boundedFrameMs = Math.max(0, Math.min(50, frameMs));
  const frameMax = AUTOSCROLL_MAX_PX_PER_SECOND * (boundedFrameMs / 1000);
  const topPenetration = Math.max(
    0,
    Math.min(
      1,
      (viewportTop + AUTOSCROLL_EDGE_PX - pointerY) / AUTOSCROLL_EDGE_PX,
    ),
  );
  if (topPenetration > 0) return -(topPenetration ** 2) * frameMax;
  const bottomPenetration = Math.max(
    0,
    Math.min(
      1,
      (pointerY - (viewportBottom - AUTOSCROLL_EDGE_PX)) / AUTOSCROLL_EDGE_PX,
    ),
  );
  return bottomPenetration > 0 ? (bottomPenetration ** 2) * frameMax : 0;
}

export const DEFAULT_DRAG_COMPACTION_TRIGGER_PX = 180;
export const DEFAULT_DRAG_COMPACTED_HEIGHT_PX = 100;
export const DRAG_COMPACTION_TRIGGER_MIN_PX = 160;
export const DRAG_COMPACTION_TRIGGER_MAX_PX = 800;
export const DRAG_COMPACTED_HEIGHT_MIN_PX = 80;
export const DRAG_COMPACTED_HEIGHT_MAX_PX = 800;

export interface DragCompactionGeometry {
  triggerHeight: number;
  compactedHeight: number;
}

export function resolveDragCompactionGeometry(
  triggerHeight: number,
  compactedHeight: number,
): DragCompactionGeometry {
  const finiteTrigger = Number.isFinite(triggerHeight)
    ? triggerHeight
    : DEFAULT_DRAG_COMPACTION_TRIGGER_PX;
  const normalizedTrigger = Math.min(
    DRAG_COMPACTION_TRIGGER_MAX_PX,
    Math.max(DRAG_COMPACTION_TRIGGER_MIN_PX, finiteTrigger),
  );
  const finiteCompacted = Number.isFinite(compactedHeight)
    ? compactedHeight
    : DEFAULT_DRAG_COMPACTED_HEIGHT_PX;
  const normalizedCompacted = Math.min(
    DRAG_COMPACTED_HEIGHT_MAX_PX,
    Math.max(DRAG_COMPACTED_HEIGHT_MIN_PX, finiteCompacted),
  );
  return {
    triggerHeight: normalizedTrigger,
    compactedHeight: Math.min(normalizedTrigger, normalizedCompacted),
  };
}

const HANDLE_DOT_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [5, 1], [1, 5], [5, 5], [1, 9], [5, 9],
];

export function buildHandleDotsSvg(ownerDocument: Document): SVGElement {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = ownerDocument.createElementNS(svgNamespace, "svg");
  svg.setAttribute("class", "butter-drag-handle-svg");
  svg.setAttribute("viewBox", "0 0 6 10");
  svg.setAttribute("aria-hidden", "true");
  for (const [cx, cy] of HANDLE_DOT_POSITIONS) {
    const dot = ownerDocument.createElementNS(svgNamespace, "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "1");
    svg.appendChild(dot);
  }
  return svg;
}
