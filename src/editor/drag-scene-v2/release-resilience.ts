export type MouseReleaseProtectionMode = "off" | "automatic" | "strong";

export interface MouseReleasePointerSample {
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
}

export interface PendingMouseRelease {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  releasedAtMs: number;
  graceMs: number;
  maximumTravelPx: number;
}

const AUTOMATIC_RELEASE_GRACE_MS = 16;
const STRONG_RELEASE_GRACE_MS = 40;
const AUTOMATIC_MAXIMUM_TRAVEL_PX = 48;
const STRONG_MAXIMUM_TRAVEL_PX = 96;

export function mouseReleaseProtectionGraceMs(
  mode: MouseReleaseProtectionMode,
  pointerType: string,
): number {
  if (pointerType !== "mouse") return 0;
  if (mode === "off") return 0;
  return mode === "strong" ? STRONG_RELEASE_GRACE_MS : AUTOMATIC_RELEASE_GRACE_MS;
}

export function createPendingMouseRelease(
  mode: MouseReleaseProtectionMode,
  sample: MouseReleasePointerSample,
  releasedAtMs: number,
): PendingMouseRelease | null {
  const graceMs = mouseReleaseProtectionGraceMs(mode, sample.pointerType);
  // Block dragging is primary-button only. Never reinterpret another button,
  // touch, or pen release as faulty mouse hardware.
  if (graceMs === 0 || sample.button !== 0) return null;
  return {
    pointerId: sample.pointerId,
    button: sample.button,
    clientX: sample.clientX,
    clientY: sample.clientY,
    releasedAtMs,
    graceMs,
    maximumTravelPx: mode === "strong"
      ? STRONG_MAXIMUM_TRAVEL_PX
      : AUTOMATIC_MAXIMUM_TRAVEL_PX,
  };
}

export function canResumePendingMouseRelease(
  pending: PendingMouseRelease,
  sample: MouseReleasePointerSample,
  nowMs: number,
): boolean {
  if (sample.pointerType !== "mouse" || sample.pointerId !== pending.pointerId ||
      sample.button !== pending.button || (sample.buttons & 1) === 0) return false;
  const elapsedMs = nowMs - pending.releasedAtMs;
  if (elapsedMs < 0 || elapsedMs > pending.graceMs) return false;
  const dx = sample.clientX - pending.clientX;
  const dy = sample.clientY - pending.clientY;
  return dx * dx + dy * dy <= pending.maximumTravelPx * pending.maximumTravelPx;
}
