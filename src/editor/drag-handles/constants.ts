
// ── Constants ────────────────────────────────────────────────


export const HANDLE_OFFSET_LEFT = 30;
export const HANDLE_WIDTH = 22;
export const HANDLE_HEIGHT = 22;
export const DRAG_THRESHOLD = 4;
export const TOUCH_LONGPRESS_MS = 400;
export const TOUCH_LONGPRESS_MOVE_PX = 8;
export const MENU_GAP = 6;
export const MENU_WIDTH = 240;
export const AUTOSCROLL_EDGE_PX = 70;
// Time-based so 60Hz, 90Hz, and 144Hz displays scroll at the same
// rate. 600 px/s ≈ the 0.9.9 feel on a 60Hz display (16 px/frame ×
// 60 fps = 960, but 0.9.9 felt fast even there — settled on 600).
export const AUTOSCROLL_MAX_PX_PER_SECOND = 600;
export const COMPACT_THRESHOLD_PX = 240;
export const VIEWPORT_MARGIN_PX = 400;

// ── Types ────────────────────────────────────────────────────

export const DRAG_MOTIONS = {
  springy: {
    spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    soft: "cubic-bezier(0.2, 1.2, 0.4, 1)",
  },
  snappy: {
    spring: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    soft: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  },
  smooth: {
    spring: "cubic-bezier(0.4, 0, 0.2, 1)",
    soft: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
} as const;

const HANDLE_DOT_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [5, 1], [1, 5], [5, 5], [1, 9], [5, 9],
];

/** Build the six-dot drag-handle icon as a real SVG element. Built via
 *  DOM rather than an innerHTML string so it satisfies the Obsidian
 *  plugin-review guideline against writing markup to innerHTML. */
export function buildHandleDotsSvg(): SVGElement {
  const svg = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "butter-drag-handle-svg");
  svg.setAttribute("viewBox", "0 0 6 10");
  svg.setAttribute("aria-hidden", "true");
  for (const [cx, cy] of HANDLE_DOT_POSITIONS) {
    const dot = activeDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "1");
    svg.appendChild(dot);
  }
  return svg;
}

export const SEL = ".ProseMirror [data-butter-drag-idx=";

/** Unified slot-driven reflow. Emits transforms for siblings in the
 *  target slot's container (open gap at target) and the source
 *  container (close gap from dragged blocks). When source and target
 *  share a container, the two contributions superpose into the
 *  closure-aware formula. Otherwise they apply independently.
 *
 *  Source hiding lives in static CSS (.butter-drag-source) so it
 *  survives stylesheet cleanup post-dispatch. */
