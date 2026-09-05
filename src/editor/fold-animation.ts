const FOLD_DURATION_MS = 150;
const FOLD_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export type VerticalFoldDirection = "expand" | "collapse";

const activeAnimations = new WeakMap<HTMLElement, Animation>();

function reducedMotion(element: HTMLElement): boolean {
  return element.ownerDocument.defaultView
    ?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function frameFor(
  computed: CSSStyleDeclaration,
  height: number,
  collapsed: boolean,
): Keyframe {
  return {
    display: computed.display === "none" ? "block" : computed.display,
    boxSizing: "border-box",
    height: collapsed ? "0px" : `${height}px`,
    marginTop: collapsed ? "0px" : computed.marginTop,
    marginBottom: collapsed ? "0px" : computed.marginBottom,
    paddingTop: collapsed ? "0px" : computed.paddingTop,
    paddingBottom: collapsed ? "0px" : computed.paddingBottom,
    borderTopWidth: collapsed ? "0px" : computed.borderTopWidth,
    borderBottomWidth: collapsed ? "0px" : computed.borderBottomWidth,
    opacity: collapsed ? "0" : computed.opacity,
    overflow: "clip",
  };
}

/**
 * Animate one or more already-rendered vertical boxes without introducing a
 * second layout model. Collapse animations are started before the owning view
 * applies `display:none`; WAAPI's filled display keyframe keeps the real DOM
 * visible until its measured box reaches zero. Expansion runs immediately
 * after the owner reveals the same DOM. Reduced-motion users get the semantic
 * state change with no transition.
 */
export function animateVerticalFold(
  elements: readonly HTMLElement[],
  direction: VerticalFoldDirection,
): void {
  for (const element of elements) {
    const previous = activeAnimations.get(element);
    previous?.cancel();
    activeAnimations.delete(element);

    if (!element.isConnected || reducedMotion(element)) continue;
    const rect = element.getBoundingClientRect();
    if (direction === "expand" && rect.height <= 0) continue;

    const computed = element.ownerDocument.defaultView!.getComputedStyle(element);
    const expanded = frameFor(computed, rect.height, false);
    const collapsed = frameFor(computed, rect.height, true);
    const animation = element.animate(
      direction === "collapse"
        ? [expanded, collapsed]
        : [collapsed, expanded],
      {
        duration: FOLD_DURATION_MS,
        easing: FOLD_EASING,
        fill: "both",
      },
    );
    activeAnimations.set(element, animation);

    const release = () => {
      if (activeAnimations.get(element) !== animation) return;
      activeAnimations.delete(element);
      animation.cancel();
    };
    void animation.finished.then(release, release);
  }
}
