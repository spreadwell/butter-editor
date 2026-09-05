import type { SceneRect } from "./types";

export function sceneRect(
  left: number,
  top: number,
  width: number,
  height: number,
): SceneRect {
  return { left, top, width, height };
}

export function rectRight(rect: SceneRect): number {
  return rect.left + rect.width;
}

export function rectBottom(rect: SceneRect): number {
  return rect.top + rect.height;
}

export function rectCenterY(rect: SceneRect): number {
  return rect.top + rect.height / 2;
}

export function copyRect(rect: SceneRect): SceneRect {
  return { ...rect };
}

export function rectFromDom(rect: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">): SceneRect {
  return sceneRect(rect.left, rect.top, rect.width, rect.height);
}

/** Translate a structural renderer clone into a ghost piece whose origin is
 * already registered to the renderer's visual media rectangle. */
export function mediaGhostContentOffset(
  structuralRect: SceneRect,
  visualRect: SceneRect,
): { x: number; y: number } {
  return {
    x: structuralRect.left - visualRect.left,
    y: structuralRect.top - visualRect.top,
  };
}

export function unionSceneRects(rects: readonly SceneRect[]): SceneRect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    if (!isFiniteSceneRect(rect)) return null;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rectRight(rect));
    bottom = Math.max(bottom, rectBottom(rect));
  }
  return sceneRect(left, top, right - left, bottom - top);
}

/** Union only renderer-visible rectangles. Collapsed heading sections retain
 * semantic member nodes whose DOM boxes are deliberately zero-sized; those
 * nodes move in the commit but must not enlarge the visual drag footprint. */
export function unionVisibleSceneRects(rects: readonly SceneRect[]): SceneRect | null {
  const visible = rects.filter((rect) => rect.width > 0.5 && rect.height > 0.5);
  return unionSceneRects(visible.length > 0 ? visible : rects);
}

export function isFiniteSceneRect(rect: SceneRect): boolean {
  return Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0;
}

export function physicalPixelTolerance(devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  return 0.5 / ratio;
}

export function snapToPhysicalPixel(value: number, devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  return Math.round(value * ratio) / ratio;
}

export function snapRectToPhysicalPixels(
  rect: SceneRect,
  devicePixelRatio: number,
): SceneRect {
  const left = snapToPhysicalPixel(rect.left, devicePixelRatio);
  const top = snapToPhysicalPixel(rect.top, devicePixelRatio);
  const right = snapToPhysicalPixel(rectRight(rect), devicePixelRatio);
  const bottom = snapToPhysicalPixel(rectBottom(rect), devicePixelRatio);
  return sceneRect(left, top, right - left, bottom - top);
}

export function rectWithinTolerance(
  actual: SceneRect,
  expected: SceneRect,
  tolerance: number,
): boolean {
  return Math.abs(actual.left - expected.left) <= tolerance &&
    Math.abs(actual.top - expected.top) <= tolerance &&
    Math.abs(rectRight(actual) - rectRight(expected)) <= tolerance &&
    Math.abs(rectBottom(actual) - rectBottom(expected)) <= tolerance;
}

export function maximumRectEdgeError(actual: SceneRect, expected: SceneRect): number {
  return Math.max(
    Math.abs(actual.left - expected.left),
    Math.abs(actual.top - expected.top),
    Math.abs(rectRight(actual) - rectRight(expected)),
    Math.abs(rectBottom(actual) - rectBottom(expected)),
  );
}

/** Compare the three edges a compact filler shares with its natural landing.
 * Its bottom edge is intentionally different until the compact cue vanishes. */
export function maximumRectLeadingEdgeError(
  actual: SceneRect,
  expected: SceneRect,
): number {
  return Math.max(
    Math.abs(actual.left - expected.left),
    Math.abs(actual.top - expected.top),
    Math.abs(rectRight(actual) - rectRight(expected)),
  );
}

/** List rows keep a full-width structural border box while their visible
 * marker/content rail moves by one rendered indent per depth. The drop filler
 * represents that visible destination, not the invariant structural row. */
export function listDropFillerRect(
  landingRect: SceneRect,
  listDepth: number | null,
  listIndentPx: number,
  leadingPaddingTopPx = 0,
): SceneRect {
  if (listDepth == null || !Number.isFinite(listIndentPx) || listIndentPx <= 0) {
    return copyRect(landingRect);
  }
  const depth = Math.max(0, Math.trunc(listDepth));
  const inset = Math.min(landingRect.width, depth * listIndentPx);
  const leadingPadding = Number.isFinite(leadingPaddingTopPx)
    ? Math.max(0, Math.min(landingRect.height, leadingPaddingTopPx))
    : 0;
  return sceneRect(
    landingRect.left + inset,
    landingRect.top + leadingPadding,
    landingRect.width - inset,
    landingRect.height - leadingPadding,
  );
}
