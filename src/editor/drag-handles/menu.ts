import { MENU_GAP, MENU_WIDTH } from "./constants";


import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { App, Menu } from "obsidian";


import {
  buildSingleBlockMenuItems,
  renderBlockMenuItems,
  applyBlockContextMenuChrome,
  blockMenuLabel,
  blockMenuHeaderIcon,
} from "../block-menu-spec";

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
    sub: `${charCount} char${charCount === 1 ? "" : "s"}`,
  });

  const items = buildSingleBlockMenuItems({ view, pos, node, app });
  if (items.length > 0) {
    renderBlockMenuItems(menu, items, (item) => {
      if ("applyTr" in item && item.applyTr) {
        const tr = view.state.tr;
        item.applyTr(tr, pos, node);
        if (tr.docChanged) view.dispatch(tr);
        view.focus();
      } else if ("sideEffect" in item && item.sideEffect) {
        item.sideEffect(view, pos, node);
      }
    });
    menu.addSeparator();
  }

  // Universal items: Copy, Cut, Duplicate, Delete
  menu.addItem((mi) => {
    mi.setTitle("Copy");
    mi.setIcon("copy");
    mi.onClick(async () => {
      try {
        await navigator.clipboard.writeText(serializeNode(node));
      } catch { /* */ }
    });
  });

  menu.addItem((mi) => {
    mi.setTitle("Cut");
    mi.setIcon("scissors");
    mi.onClick(async () => {
      try {
        await navigator.clipboard.writeText(serializeNode(node));
        view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
        view.focus();
      } catch { /* */ }
    });
  });

  menu.addItem((mi) => {
    mi.setTitle("Duplicate");
    mi.setIcon("copy-plus");
    mi.onClick(() => {
      const insertAt = pos + node.nodeSize;
      const clone = node.type.create(node.attrs, node.content, node.marks);
      view.dispatch(view.state.tr.insert(insertAt, clone));
    });
  });

  menu.addSeparator();

  menu.addItem((mi) => {
    mi.setTitle("Delete");
    mi.setIcon("trash-2");
    mi.setWarning?.(true);
    mi.dom?.classList.add("is-warning");
    mi.onClick(() => {
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
      view.focus();
    });
  });

  // Position to the left of the handle (or right if no room).
  const handleRect = handle.getBoundingClientRect();
  const leftX = handleRect.left - MENU_GAP - MENU_WIDTH;
  const x = leftX >= 8 ? leftX : handleRect.right + MENU_GAP;
  const y = Math.max(8, handleRect.top);
  menu.showAtPosition({ x, y });
  return menu;
}

// ── Handle layer for "always" mode ───────────────────────────

