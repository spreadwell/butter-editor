/**
 * Logical viewport state passed between Obsidian's Markdown views and Butter.
 *
 * A raw scrollTop is not portable between renderers: Source, Live Preview,
 * Reading, and Butter can give the same Markdown different total heights.
 * The source line identifies the content under a stable viewport probe while
 * the element fraction preserves the position inside a wrapped/multiline row.
 * Progress is deliberately only a fallback for content without usable source
 * geometry.
 */
export interface ButterViewportAnchor {
  version: 1;
  /** Absolute UTF-16 source offset, including frontmatter when present. */
  sourceOffset?: number;
  line: number;
  fraction: number;
  probeOffset: number;
  progress: number;
}

export const BUTTER_VIEWPORT_STATE_KEY = "butterViewportAnchor";
export const VIEWPORT_PROBE_OFFSET_PX = 32;

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function viewportProgress(host: HTMLElement): number {
  const max = Math.max(0, host.scrollHeight - host.clientHeight);
  return max > 0 ? clampUnit(host.scrollTop / max) : 0;
}

export function viewportProbeOffset(host: HTMLElement): number {
  return Math.max(
    0,
    Math.min(VIEWPORT_PROBE_OFFSET_PX, Math.max(0, host.clientHeight - 1)),
  );
}

export function elementViewportFraction(
  host: HTMLElement,
  element: HTMLElement,
  probeOffset = viewportProbeOffset(host),
): number {
  const hostTop = host.getBoundingClientRect().top;
  const rect = element.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  return clampUnit((hostTop + probeOffset - rect.top) / rect.height);
}

export function restoreElementViewport(
  host: HTMLElement,
  element: HTMLElement,
  anchor: ButterViewportAnchor,
): void {
  const hostTop = host.getBoundingClientRect().top;
  const rect = element.getBoundingClientRect();
  const targetPoint = rect.top + clampUnit(anchor.fraction) * rect.height;
  const max = Math.max(0, host.scrollHeight - host.clientHeight);
  host.scrollTop = Math.max(
    0,
    Math.min(max, host.scrollTop + targetPoint - hostTop - anchor.probeOffset),
  );
}

export function restoreViewportProgress(
  host: HTMLElement,
  progress: number,
): void {
  const max = Math.max(0, host.scrollHeight - host.clientHeight);
  host.scrollTop = max * clampUnit(progress);
}

export function isButterViewportAnchor(
  value: unknown,
): value is ButterViewportAnchor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ButterViewportAnchor>;
  return candidate.version === 1 &&
    (candidate.sourceOffset == null || Number.isFinite(candidate.sourceOffset)) &&
    Number.isFinite(candidate.line) &&
    Number.isFinite(candidate.fraction) &&
    Number.isFinite(candidate.probeOffset) &&
    Number.isFinite(candidate.progress);
}
