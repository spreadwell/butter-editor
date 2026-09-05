/** Any dragged unit taller than the configured threshold receives the same
 * normalized presentation footprint. Semantic membership remains unchanged. */
export function shouldCompactDragUnit(
  naturalHeight: number,
  triggerHeight: number,
  compactedHeight: number,
): boolean {
  return naturalHeight > triggerHeight &&
    compactedHeight < naturalHeight;
}

/** Fit a media preview to the configured compact height without ever
 * enlarging it or changing its renderer-resolved aspect ratio. */
export function compactMediaSize(
  naturalWidth: number,
  naturalHeight: number,
  compactedHeight: number,
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0 || compactedHeight <= 0) {
    return {
      width: Math.max(0, naturalWidth),
      height: Math.max(0, naturalHeight),
    };
  }
  const scale = Math.min(1, compactedHeight / naturalHeight);
  return {
    width: naturalWidth * scale,
    height: naturalHeight * scale,
  };
}
