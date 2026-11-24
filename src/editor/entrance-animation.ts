/**
 * Staggered entrance for the first blocks of a freshly loaded note.
 *
 * The inline title keeps its `butter-anim-prepped` / `butter-just-loaded`
 * rules in `styles.css`. The blocks are animated here with WAAPI because a
 * CSS stagger needs one `:nth-child()` rule per block, and any positional
 * selector evaluated against the editor root makes Chromium restyle every
 * block of the note on each later block insertion or removal. WAAPI also
 * leaves the ProseMirror-owned DOM unmutated.
 */
import { EASE_OUT, MOTION_BEAT_MS, MOTION_EMPHASIS_MS } from "../ui/motion-tokens";

const ENTRANCE_BLOCKS = 15;
const ENTRANCE_DURATION_MS = MOTION_EMPHASIS_MS;
const ENTRANCE_STAGGER_MS = MOTION_BEAT_MS;
const ENTRANCE_EASING = EASE_OUT;
const ENTRANCE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateY(8px)" },
  { opacity: 1, transform: "translateY(0)" },
];

export interface BlockEntrance {
  /** Start the reveal. Blocks rendered since staging join in their slot. */
  play(): void;
  /** Drop the entrance and show the blocks as they are. */
  cancel(): void;
}

function reducedMotion(element: HTMLElement): boolean {
  return element.ownerDocument.defaultView
    ?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** The leading blocks in visual order. The list owner spans create no box. */
function entranceBlocks(root: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  for (
    let child = root.firstElementChild;
    child && blocks.length < ENTRANCE_BLOCKS;
    child = child.nextElementSibling
  ) {
    if (child.classList.contains("butter-list-a11y-owner")) continue;
    blocks.push(child as HTMLElement);
  }
  return blocks;
}

function animateBlock(element: HTMLElement, slot: number): Animation {
  // Backwards fill holds the hidden first frame through the stagger delay
  // and releases the block to its own styles the moment it lands.
  return element.animate(ENTRANCE_KEYFRAMES, {
    duration: ENTRANCE_DURATION_MS,
    delay: ENTRANCE_STAGGER_MS * (slot + 1),
    easing: ENTRANCE_EASING,
    fill: "backwards",
  });
}

/**
 * Hide the leading blocks of `root` at the entrance's first frame and return
 * the handle that reveals them. Call it right after the document renders so
 * no frame paints the blocks at full opacity first. Returns null when motion
 * is unwanted or there is no rendered editor to animate.
 */
export function stageBlockEntrance(
  root: HTMLElement | null | undefined,
): BlockEntrance | null {
  if (!root || typeof root.animate !== "function" || reducedMotion(root)) {
    return null;
  }

  let staged = new Map<HTMLElement, { slot: number; animation: Animation }>();
  let settled = false;
  entranceBlocks(root).forEach((element, slot) => {
    const animation = animateBlock(element, slot);
    animation.pause();
    staged.set(element, { slot, animation });
  });

  return {
    play() {
      if (settled) return;
      settled = true;
      const waiting = staged;
      staged = new Map();
      entranceBlocks(root).forEach((element, slot) => {
        const held = waiting.get(element);
        if (held?.slot === slot) {
          waiting.delete(element);
          held.animation.play();
        } else {
          animateBlock(element, slot);
        }
      });
      // Whatever is left was re-rendered or moved out of the leading blocks.
      for (const { animation } of waiting.values()) animation.cancel();
    },
    cancel() {
      if (settled) return;
      settled = true;
      for (const { animation } of staged.values()) animation.cancel();
      staged = new Map();
    },
  };
}
