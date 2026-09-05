import type { Menu } from "obsidian";
import { hideMenuSurfaceImmediately } from "./surface-motion";

/** Close an editor-owned Obsidian menu when its surrounding document scrolls.
 * Scrolls inside the menu remain usable for long action lists. */
export function dismissMenuOnScroll(
  menu: Menu,
  ownerDocument: Document,
): () => void {
  const menuDom = (menu as unknown as { dom?: HTMLElement }).dom;
  let listening = true;

  const cleanup = () => {
    if (!listening) return;
    listening = false;
    ownerDocument.removeEventListener("scroll", onScroll, true);
  };
  const onScroll = (event: Event) => {
    const ownerWindow = ownerDocument.defaultView;
    const target = event.target as Node | null;
    if (ownerWindow && target?.instanceOf(ownerWindow.Node)) {
      const targetElement = target.instanceOf(ownerWindow.Element)
        ? target
        : target.parentElement;
      // Obsidian mounts submenus as sibling `.menu` elements rather than
      // descendants of the parent menu. Treat every menu-local scroll as
      // internal so a long submenu remains open while its list scrolls.
      if (targetElement?.closest(".menu") || menuDom?.contains(target)) return;
    }
    cleanup();
    hideMenuSurfaceImmediately(menu);
  };

  ownerDocument.addEventListener("scroll", onScroll, {
    capture: true,
    passive: true,
  });
  menu.onHide(cleanup);
  return cleanup;
}
