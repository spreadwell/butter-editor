/**
 * Script-side mirror of the motion scale declared on `body` at the top of
 * `styles.css`. Animations driven from script (Web Animations, timers that
 * wait for a CSS transition) take their timing from here so they move with
 * the stylesheet; `test-motion-layer-contract.mjs` keeps the two in step.
 */

/** Press and hover feedback, and anything leaving. */
export const MOTION_INSTANT_MS = 80;
/** State changes and menus. */
export const MOTION_QUICK_MS = 120;
/** Surfaces that slide, fold or resize. */
export const MOTION_STANDARD_MS = 160;
/** Layout moves: drag, drawers, a note arriving. */
export const MOTION_EMPHASIS_MS = 240;
/** Delays and staggers are whole beats. */
export const MOTION_BEAT_MS = 30;

/** Anything arriving or settling. */
export const EASE_OUT = "cubic-bezier(0.2, 0.85, 0.3, 1)";
/** Anything leaving. */
export const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
/** A state change in place. */
export const EASE_STANDARD = "ease";

/** `EASE_OUT` as control points, for clocks that evaluate the curve themselves. */
export const EASE_OUT_POINTS = [0.2, 0.85, 0.3, 1] as const;
