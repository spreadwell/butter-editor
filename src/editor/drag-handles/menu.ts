import { MENU_GAP, MENU_WIDTH } from "./constants";


import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { App, Menu } from "obsidian";


import {
  buildSingleBlockMenuItems,
  buildBlockLifecycleMenuItems,
  renderBlockLifecycleMenuItems,
  renderBlockMenuItems,
  applyBlockContextMenuChrome,
  blockMenuLabel,
  blockMenuHeaderIcon,
} from "../block-menu-spec";
import { tx, tv } from "../../i18n";
import { dismissMenuOnScroll } from "../../ui/menu-scroll-dismiss";
import { hideMenuSurfaceImmediately } from "../../ui/surface-motion";

// ── Constants ────────────────────────────────────────────────


export function openBlockContextMenu(
  app: App,
  view: EditorView,
  handle: HTMLElement,
  pos: number,
  node: PMNode,
  serializeNode: (node: PMNode) => string,
): Menu {
  const menu = new Menu();
  menu.setUseNativeMenu(false);
  const charCount = node.textContent.length;
  applyBlockContextMenuChrome(menu, {
    icon: blockMenuHeaderIcon(node),
    title: blockMenuLabel(node),
    sub: tv("{count} {unit}", {
      count: charCount,
      unit: tx(charCount === 1 ? "char" : "chars"),
    }),
  });

  const items = buildSingleBlockMenuItems({ view, pos, node, app });
  if (items.length > 0) {
    renderBlockMenuItems(menu, items, (item, activation) => {
      if ("applyTr" in item && item.applyTr) {
        const tr = view.state.tr;
        item.applyTr(tr, pos, node);
        if (tr.docChanged) view.dispatch(tr);
        view.focus();
      } else if ("sideEffect" in item && item.sideEffect) {
        item.sideEffect(view, pos, node, activation);
      }
      hideMenuSurfaceImmediately(menu);
    });
    menu.addSeparator();
  }

  renderBlockLifecycleMenuItems(
    menu,
    buildBlockLifecycleMenuItems(serializeNode),
    (item, activation) => {
      if (item.applyTr) {
        const tr = view.state.tr;
        item.applyTr(tr, pos, node);
        if (tr.docChanged) view.dispatch(tr);
        view.focus();
      } else if (item.sideEffect) {
        item.sideEffect(view, pos, node, activation);
      }
      hideMenuSurfaceImmediately(menu);
    },
  );

  // Position to the left of the handle (or right if no room).
  const handleRect = handle.getBoundingClientRect();
  const leftX = handleRect.left - MENU_GAP - MENU_WIDTH;
  const x = leftX >= 8 ? leftX : handleRect.right + MENU_GAP;
  const y = Math.max(8, handleRect.top);
  menu.showAtPosition({ x, y });
  dismissMenuOnScroll(menu, view.dom.ownerDocument);
  return menu;
}

// ── Handle layer for "always" mode ───────────────────────────
