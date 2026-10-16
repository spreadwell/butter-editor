import type { EditorView } from "prosemirror-view";

/** Browser layout can change without a ProseMirror transaction. Keep only a
 * pending invalidation: every refresh reads the latest live editor DOM, and
 * an active pointer gesture owns its geometry until it finishes. */
export class HandleLayoutInvalidation {
  private readonly dom: HTMLElement;
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window & typeof window;
  private frame = 0;
  private dirty = false;
  private followup = false;
  private discoverMotion = false;
  private stopped = false;
  private readonly motion = new Map<Animation, KeyframeEffect>();
  private readonly resizeObserver: ResizeObserver | null;
  private readonly mutationObserver: MutationObserver | null;

  constructor(
    private readonly view: EditorView,
    private readonly canRefresh: () => boolean,
    private readonly refresh: () => void,
  ) {
    this.dom = view.dom;
    this.ownerDocument = this.dom.ownerDocument;
    this.ownerWindow = this.ownerDocument.defaultView!;
    const win = this.ownerWindow;
    this.dom.addEventListener("contentvisibilityautostatechange", this.invalidate, true);
    this.dom.addEventListener("load", this.invalidate, true);
    this.dom.addEventListener("error", this.invalidate, true);
    for (const name of this.motionEvents) {
      this.ownerDocument.addEventListener(name, this.onMotion, true);
    }
    this.ownerDocument.fonts?.addEventListener("loadingdone", this.invalidate);
    this.ownerDocument.fonts?.addEventListener("loadingerror", this.invalidate);
    void this.ownerDocument.fonts?.ready.then(this.invalidate, this.invalidate);

    this.resizeObserver = typeof win.ResizeObserver === "function"
      ? new win.ResizeObserver(this.invalidate)
      : null;
    this.resizeObserver?.observe(this.dom);
    if (this.dom.parentElement) this.resizeObserver?.observe(this.dom.parentElement);

    // Watch the editor and its style ancestors, not the body-mounted handles,
    // selection chrome, ghost or oracle. Handle style writes cannot feed back.
    this.mutationObserver = typeof win.MutationObserver === "function"
      ? new win.MutationObserver(this.invalidate)
      : null;
    this.mutationObserver?.observe(this.dom, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "src", "width", "height", "hidden", "open"],
    });
    for (let parent = this.dom.parentElement; parent; parent = parent.parentElement) {
      this.mutationObserver?.observe(parent, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
    }
  }

  private ownsView(): boolean {
    return !this.stopped && !this.view.isDestroyed && this.view.dom === this.dom &&
      this.dom.isConnected && this.dom.ownerDocument === this.ownerDocument &&
      this.ownerDocument.defaultView === this.ownerWindow;
  }

  private readonly motionEvents = [
    "animationstart", "animationend", "animationcancel",
    "transitionrun", "transitionend", "transitioncancel",
  ];

  private ownsMotionTarget(target: unknown): target is Element {
    return target instanceof this.ownerWindow.Element &&
      target.ownerDocument === this.ownerDocument && target.isConnected &&
      (target === this.dom || this.dom.contains(target) || target.contains(this.dom));
  }

  private readonly onMotion = (event: Event): void => {
    if (this.ownsMotionTarget(event.target)) this.invalidate();
  };

  /** Transform-only entrance animations change glyph coordinates without a
   * resize or DOM mutation. Discover their native objects at an invalidation,
   * then follow those objects rather than scanning the note on every frame. */
  private collectMotion(): void {
    this.motion.clear();
    const candidates = new Set(this.dom.getAnimations?.({ subtree: true }) ?? []);
    for (let parent = this.dom.parentElement; parent; parent = parent.parentElement) {
      for (const animation of parent.getAnimations?.() ?? []) candidates.add(animation);
    }
    for (const animation of candidates) {
      const effect = animation.effect as KeyframeEffect | null;
      if (!effect || typeof effect.getKeyframes !== "function" ||
          !this.ownsMotionTarget(effect.target)) continue;
      const end = effect.getComputedTiming().endTime;
      if (typeof end !== "number" || !Number.isFinite(end) || end <= 0) continue;
      // Opacity/color pulses do not move the handle. Infinite or paused theme
      // effects must not turn an idle editor into a permanent frame stream.
      const changesGeometry = effect.getKeyframes().some(frame =>
        Object.keys(frame).some(property => property.startsWith("--") ||
          /^(?:transform|translate|rotate|scale|offset(?:Path|Distance|Position|Anchor|Rotate)|perspective|zoom|(?:min|max)?(?:Width|Height)|width|height|margin|padding|border.*Width|font|lineHeight|letterSpacing|wordSpacing|textIndent|verticalAlign|flex|grid|gap|column|row|inset|top|right|bottom|left|position|writingMode|direction)/.test(property)));
      if (changesGeometry && this.isRunning(animation, effect)) this.motion.set(animation, effect);
    }
  }

  private isRunning(animation: Animation, effect: KeyframeEffect): boolean {
    const end = effect.getComputedTiming().endTime;
    return animation.effect === effect && animation.playState === "running" &&
      animation.playbackRate !== 0 && typeof end === "number" &&
      Number.isFinite(end) && end > 0 && this.ownsMotionTarget(effect.target);
  }

  readonly invalidate = (): void => {
    if (!this.ownsView()) return;
    this.dirty = true;
    this.resume();
  };

  /** One additional paint after mount allows skipped content to materialize.
   * Active finite geometry effects own any further paint followups. */
  initialPaint(): void {
    this.followup = true;
    this.invalidate();
  }

  resume(): void {
    this.discoverMotion = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame || !this.dirty || !this.ownsView() || !this.canRefresh()) return;
    this.frame = this.ownerWindow.requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.ownsView() || !this.canRefresh()) return;
      if (this.discoverMotion) {
        this.discoverMotion = false;
        this.collectMotion();
      }
      this.dirty = false;
      this.refresh();
      for (const [animation, effect] of this.motion) {
        if (!this.isRunning(animation, effect)) this.motion.delete(animation);
      }
      if (this.followup) {
        this.followup = false;
        this.dirty = true;
      }
      if (this.motion.size) this.dirty = true;
      this.schedule();
    });
  }

  destroy(): void {
    this.stopped = true;
    if (this.frame) this.ownerWindow.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.dirty = false;
    this.followup = false;
    this.discoverMotion = false;
    this.motion.clear();
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.dom.removeEventListener("contentvisibilityautostatechange", this.invalidate, true);
    this.dom.removeEventListener("load", this.invalidate, true);
    this.dom.removeEventListener("error", this.invalidate, true);
    for (const name of this.motionEvents) {
      this.ownerDocument.removeEventListener(name, this.onMotion, true);
    }
    this.ownerDocument.fonts?.removeEventListener("loadingdone", this.invalidate);
    this.ownerDocument.fonts?.removeEventListener("loadingerror", this.invalidate);
  }
}
