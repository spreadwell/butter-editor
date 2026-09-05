import type { Menu } from "obsidian";

export type SurfaceMotionKind = "menu" | "submenu" | "popover";

const EXIT_FALLBACK_MS = 140;
const patchedMenus = new WeakSet<Menu>();
const immediateMenuClosers = new WeakMap<Menu, () => void>();

function motionAllowed(element: HTMLElement): boolean {
  if (element.ownerDocument.body.classList.contains("butter-no-anim")) {
    return false;
  }
  return !(element.ownerDocument.defaultView
    ?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/** Mark a Butter-owned desktop surface for the shared entrance treatment. */
export function attachSurfaceMotion(
  element: HTMLElement,
  kind: SurfaceMotionKind,
): void {
  element.classList.add("butter-surface-motion");
  element.dataset.butterSurfaceMotion = kind;
}

/**
 * Start a non-blocking exit and invoke cleanup after its final paint. Event
 * handlers should be detached before calling this; pointer input is disabled
 * immediately, so command execution and focus changes never wait on motion.
 */
export function dismissSurfaceWithMotion(
  element: HTMLElement,
  cleanup: () => void,
): void {
  let complete = false;
  let timer = 0;
  const finish = () => {
    if (complete) return;
    complete = true;
    if (timer) element.ownerDocument.defaultView?.clearTimeout(timer);
    element.removeEventListener("animationend", onAnimationEnd);
    cleanup();
  };
  const onAnimationEnd = (event: AnimationEvent) => {
    if (event.target === element) finish();
  };

  if (!element.isConnected || !motionAllowed(element)) {
    finish();
    return;
  }
  element.classList.add("butter-surface-motion-leaving");
  element.setAttribute("aria-hidden", "true");
  element.addEventListener("animationend", onAnimationEnd);
  timer = element.ownerDocument.defaultView?.setTimeout(
    finish,
    EXIT_FALLBACK_MS,
  ) ?? 0;
}

/** Add shared motion to an Obsidian Menu while retaining its native lifecycle. */
export function attachMenuSurfaceMotion(
  menu: Menu,
  kind: SurfaceMotionKind,
): void {
  const dom = (menu as Menu & { dom?: HTMLElement }).dom;
  if (dom) attachSurfaceMotion(dom, kind);
  if (patchedMenus.has(menu)) return;
  patchedMenus.add(menu);

  const originalHide = menu.hide.bind(menu);
  const originalClose = menu.close.bind(menu);
  let leaving = false;
  let finalized = false;
  let pendingPointerAction = false;
  let pendingPointerTimer = 0;

  const clearPendingPointerAction = () => {
    pendingPointerAction = false;
    if (pendingPointerTimer) dom?.ownerDocument.defaultView?.clearTimeout(pendingPointerTimer);
    pendingPointerTimer = 0;
  };

  const notePointerAction = (event: MouseEvent | PointerEvent) => {
    if (!dom || finalized) return;
    const target = event.target as Element | null;
    const item = target?.closest?.<HTMLElement>(".menu-item");
    if (!item || !dom.contains(item)) return;
    if (item.classList.contains("is-disabled") || item.getAttribute("aria-disabled") === "true") return;
    if (item.classList.contains("has-submenu") || item.querySelector(".mod-submenu")) return;

    pendingPointerAction = true;
    if (pendingPointerTimer) dom.ownerDocument.defaultView?.clearTimeout(pendingPointerTimer);
    pendingPointerTimer = dom.ownerDocument.defaultView?.setTimeout(() => {
      clearPendingPointerAction();
    }, 200) ?? 0;
  };
  dom?.ownerDocument.addEventListener("pointerdown", notePointerAction, true);
  dom?.ownerDocument.addEventListener("mousedown", notePointerAction, true);

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    clearPendingPointerAction();
    immediateMenuClosers.delete(menu);
    dom?.ownerDocument.removeEventListener("pointerdown", notePointerAction, true);
    dom?.ownerDocument.removeEventListener("mousedown", notePointerAction, true);
    // Restore first: Obsidian's hide/close implementations may delegate to
    // each other internally, and must not re-enter the motion wrapper.
    menu.hide = originalHide;
    menu.close = originalClose;
    try {
      originalClose();
    } catch {
      try { originalHide(); } catch { /* already detached */ }
    }
  };
  const requestClose = () => {
    if (leaving || finalized) return;
    leaving = true;
    if (pendingPointerAction) {
      clearPendingPointerAction();
      const ownerWindow = dom?.ownerDocument.defaultView;
      if (ownerWindow) ownerWindow.requestAnimationFrame(finalize);
      else finalize();
      return;
    }
    if (!dom) {
      finalize();
      return;
    }
    // Obsidian can request menu closure during pointerdown while contributed
    // actions run on the subsequent trusted click. Preserve that event pair,
    // then make the already-closing surface non-interactive for its exit.
    const ownerWindow = dom.ownerDocument.defaultView;
    if (!ownerWindow) {
      dismissSurfaceWithMotion(dom, finalize);
      return;
    }
    ownerWindow.requestAnimationFrame(() => {
      if (!finalized) dismissSurfaceWithMotion(dom, finalize);
    });
  };

  menu.hide = function motionHide(): Menu {
    requestClose();
    return menu;
  };
  menu.close = function motionClose(): void {
    requestClose();
  };
  immediateMenuClosers.set(menu, finalize);
  menu.onHide(() => {
    finalized = true;
    clearPendingPointerAction();
    immediateMenuClosers.delete(menu);
    dom?.ownerDocument.removeEventListener("pointerdown", notePointerAction, true);
    dom?.ownerDocument.removeEventListener("mousedown", notePointerAction, true);
  });
}

/** Scroll and replacement dismissals must disappear synchronously. */
export function hideMenuSurfaceImmediately(menu: Menu): void {
  const close = immediateMenuClosers.get(menu);
  if (close) close();
  else {
    try { menu.hide(); } catch { /* already detached */ }
  }
}
