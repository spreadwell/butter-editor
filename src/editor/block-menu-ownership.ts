import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import type { Menu } from "obsidian";
import { markBlockConversionRefusal } from "./native-block-id-conservation";

interface MenuInteractionOwner {
  readonly view: EditorView;
  readonly document: PMNode;
  readonly editorDOM: HTMLElement;
  active: boolean;
}

interface OwnedMenu {
  readonly menu: Menu;
  readonly dom: HTMLElement;
  readonly owner: MenuInteractionOwner;
  readonly parent?: OwnedMenu;
  active: boolean;
}

type MenuWithLifecycle = Menu & {
  dom?: HTMLElement;
  unloading?: boolean;
  hideCallback?: (() => unknown) | null;
  parentMenu?: Menu | null;
  currentSubmenu?: Menu | null;
};

interface HideRegistration {
  callback?: () => unknown;
  installed?: () => unknown;
  readonly set: Menu["onHide"];
}

const editorMenus = new WeakMap<EditorView, MenuInteractionOwner>();
const ownedMenus = new WeakMap<Menu, OwnedMenu>();
const ownerMenus = new WeakMap<MenuInteractionOwner, Set<OwnedMenu>>();
const hideRegistrations = new WeakMap<Menu, HideRegistration>();

function trackMenuHide(record: OwnedMenu): void {
  const { menu } = record;
  let registration = hideRegistrations.get(menu);
  if (!registration) {
    const nativeSet = menu.onHide.bind(menu);
    const existing = (menu as MenuWithLifecycle).hideCallback;
    const set: Menu["onHide"] = (callback) => {
      registration!.callback = callback;
      const current = ownedMenus.get(menu);
      const installed = () => {
        // Native hide clears its callback before delivery. A callback may
        // register its successor, so retire only this exact registration.
        if (registration!.installed === installed) {
          registration!.callback = undefined;
          registration!.installed = undefined;
        }
        if (current) {
          current.active = false;
          if (!current.parent) current.owner.active = false;
        }
        callback();
      };
      registration!.installed = installed;
      nativeSet(installed);
    };
    registration = { set, callback: typeof existing === "function" ? existing : undefined };
    hideRegistrations.set(menu, registration);
    menu.onHide = set;
  }
  // Obsidian onHide is a setter. Retain its last consumer callback while
  // composing the exact ownership revocation, including in-place drawers.
  registration.set(registration.callback ?? (() => {}));
}

/** Selection belongs to this editor's exact native menu lifetime. Menu chrome
 * classes alone confer no authority, and mutation admission stays separate. */
export function bindEditorMenuInteraction(menu: Menu, view: EditorView): void {
  const dom = (menu as MenuWithLifecycle).dom;
  if (!dom || (menu as MenuWithLifecycle).unloading) return;
  const previous = editorMenus.get(view);
  if (previous) previous.active = false;
  const owner: MenuInteractionOwner = {
    view, document: view.state.doc, editorDOM: view.dom, active: true,
  };
  const record: OwnedMenu = { menu, dom, owner, active: true };
  editorMenus.set(view, owner);
  ownedMenus.set(menu, record);
  ownerMenus.set(owner, new Set([record]));
  trackMenuHide(record);
}

/** Native submenus are body-mounted siblings. Register only the exact object
 * returned by this owned parent's setSubmenu call. */
export function inheritEditorMenuInteraction(parent: Menu, child: Menu): Menu {
  const source = ownedMenus.get(parent);
  const dom = (child as MenuWithLifecycle).dom;
  if (source && dom && source.active && source.owner.active && !(child as MenuWithLifecycle).unloading) {
    const record: OwnedMenu = { menu: child, dom, owner: source.owner, parent: source, active: true };
    ownedMenus.set(child, record);
    ownerMenus.get(source.owner)?.add(record);
    trackMenuHide(record);
  }
  return child;
}

function menuIsCurrent(record: OwnedMenu, ownerDocument: Document): boolean {
  const { menu, dom, parent } = record;
  if ((!record.active && !parent) || ownedMenus.get(menu) !== record || (menu as MenuWithLifecycle).dom !== dom ||
    (menu as MenuWithLifecycle).unloading || menu.onHide !== hideRegistrations.get(menu)?.set ||
    dom.ownerDocument !== ownerDocument || !dom.isConnected || dom.hidden ||
    dom.getClientRects().length === 0) return false;
  const style = ownerDocument.defaultView?.getComputedStyle(dom);
  if (!style || style.display === "none" || style.visibility === "hidden" ||
    style.visibility === "collapse" || style.pointerEvents === "none") return false;
  // Obsidian reuses a cached submenu after hide, restoring both native links
  // before showing it. Only that exact live parent can renew its child; mere
  // DOM reattachment cannot revive a retired menu or its root owner.
  return !parent || ((menu as MenuWithLifecycle).parentMenu === parent.menu &&
    (parent.menu as MenuWithLifecycle).currentSubmenu === menu && menuIsCurrent(parent, ownerDocument));
}

export function isEditorMenuInteraction(view: EditorView, target: EventTarget | null): boolean {
  const owner = editorMenus.get(view);
  if (!owner?.active || owner.view !== view || view.isDestroyed ||
    view.dom !== owner.editorDOM || !owner.editorDOM.isConnected ||
    view.state.doc !== owner.document) return false;
  const document = owner.editorDOM.ownerDocument;
  const Node = document.defaultView?.Node;
  if (!Node || !(target instanceof Node)) return false;
  for (const record of ownerMenus.get(owner) ?? []) {
    if (record.dom.contains(target) && menuIsCurrent(record, document)) return true;
  }
  return false;
}

/** Menus target the reviewed occurrences, not whatever later occupies their
 * positions. A stale or read-only menu must not create an edit/history event. */
export function captureBlockMenuMutation(
  view: EditorView,
  occurrences: readonly { readonly pos: number; readonly node: PMNode }[],
): () => boolean {
  const document = view.state.doc;
  return () => {
    if (view.isDestroyed) return false;
    if (view.editable !== false && view.state.doc === document && occurrences.length > 0 &&
      occurrences.every(({ pos, node }) => view.state.doc.nodeAt(pos) === node)) return true;
    const refused = view.state.tr;
    markBlockConversionRefusal(refused);
    view.dispatch(refused);
    return false;
  };
}
