/**
 * Toolbar layout types + helpers.
 *
 * The layout is an ordered tree: each entry is a `button` (reference
 * to a built-in toolbar action by id), a `separator` (visual divider),
 * or a `submenu` (a parent button that opens a popup containing its
 * own ordered children - depth-1 nesting only). The user customizes
 * this via the settings tab; the toolbar render code walks the tree
 * and produces matching DOM.
 *
 * Hidden buttons are simply absent from the layout. There's no
 * separate "hidden" array - if it's not in the tree, it doesn't show.
 * The legacy `toolbarHiddenButtons` setting migrates into a default
 * layout minus the hidden ids on first load.
 */

export type LayoutItem =
  | { type: "button"; id: string }
  | { type: "separator"; id: string }
  | {
      type: "submenu";
      id: string;
      label: string;
      icon: string;
      children: LayoutItem[];
    }
  /** Mobile-only: a "More …" button that opens a bottom sheet
   *  listing every action in the layout. Auto-injected at the end
   *  of the mobile toolbar render if not present in the layout, so
   *  users always have an overflow path even on stock layouts. */
  | { type: "overflow"; id: string };

export type Layout = LayoutItem[];

// ── ID generation ──────────────────────────────────────────────
//
// Separator + submenu items need unique ids so the settings UI
// can drag/edit/remove specific entries. Built-in button ids
// already collide-proof since they come from a closed catalog.
let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

// ── Default layouts ────────────────────────────────────────────
//
// Mirror the previous hard-coded toolbar order with separators
// between groups. These are what the user sees if they've never
// customized + on Reset.

/** Full preset - the canonical "everything available" layout shipped
 *  as the default for new users. Equivalent to what the Reset button
 *  in the customizer's section header restores. */
export function mainLayoutFull(): Layout {
  return [
    { type: "button", id: "undo" },
    { type: "button", id: "redo" },
    { type: "separator", id: newId("sep") },
    {
      type: "submenu",
      id: newId("sub"),
      label: "Heading",
      icon: "heading",
      children: [
        { type: "button", id: "heading-1" },
        { type: "button", id: "heading-2" },
        { type: "button", id: "heading-3" },
        { type: "button", id: "heading-4" },
        { type: "button", id: "heading-5" },
        { type: "button", id: "heading-6" },
      ],
    },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "bold" },
    { type: "button", id: "italic" },
    { type: "button", id: "strikethrough" },
    { type: "button", id: "highlight" },
    { type: "button", id: "text-color" },
    { type: "separator", id: newId("sep") },
    {
      type: "submenu",
      id: newId("sub"),
      label: "Lists",
      icon: "list",
      children: [
        { type: "button", id: "bullet-list" },
        { type: "button", id: "ordered-list" },
        { type: "button", id: "task-list" },
      ],
    },
    { type: "button", id: "code" },
    { type: "button", id: "link" },
    { type: "button", id: "clear-formatting" },
    { type: "button", id: "blockquote" },
    {
      type: "submenu",
      id: newId("sub"),
      label: "Callout",
      icon: "message-square-quote",
      children: [
        { type: "button", id: "callout-quote" },
        { type: "button", id: "callout-example" },
        { type: "button", id: "callout-bug" },
        { type: "button", id: "callout-danger" },
        { type: "button", id: "callout-warning" },
        { type: "button", id: "callout-failure" },
        { type: "button", id: "callout-question" },
        { type: "button", id: "callout-success" },
        { type: "button", id: "callout-tip" },
        { type: "button", id: "callout-info" },
        { type: "button", id: "callout-abstract" },
        { type: "button", id: "callout-note" },
      ],
    },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "hr" },
    { type: "button", id: "table" },
    { type: "button", id: "insert-base-embed" },
    { type: "button", id: "code-block" },
    { type: "button", id: "image" },
    { type: "separator", id: newId("sep") },
    {
      type: "submenu",
      id: newId("sub"),
      label: "Other",
      icon: "more-horizontal",
      children: [{ type: "button", id: "insert-base-inline" }],
    },
  ];
}

/** Simple preset - pared-down "essentials" layout for users who
 *  don't need the full feature surface. H1-H3 headings, basic
 *  inline marks, lists, link, blockquote, image. */
export function mainLayoutSimple(): Layout {
  return [
    { type: "button", id: "undo" },
    { type: "button", id: "redo" },
    { type: "separator", id: newId("sep") },
    {
      type: "submenu",
      id: newId("sub"),
      label: "Heading",
      icon: "heading",
      children: [
        { type: "button", id: "heading-1" },
        { type: "button", id: "heading-2" },
        { type: "button", id: "heading-3" },
      ],
    },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "bold" },
    { type: "button", id: "italic" },
    { type: "button", id: "highlight" },
    { type: "button", id: "text-color" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "bullet-list" },
    { type: "button", id: "ordered-list" },
    { type: "button", id: "task-list" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "link" },
    { type: "button", id: "clear-formatting" },
    { type: "button", id: "blockquote" },
    { type: "button", id: "image" },
  ];
}

/** New users get the Full preset on first load. */
export function defaultMainLayout(): Layout {
  return mainLayoutFull();
}

/** Mobile preset - flat 14-button strip tuned for thumb-typing on a
 *  phone. No submenus (mobile flattens them anyway, so there's no
 *  point nesting), and the set is curated to the buttons users
 *  actually reach for one-handed: typography (3 headings + paragraph
 *  marks), structure (lists + checkbox), inserts they care about
 *  mid-typing (link, code, blockquote), and history. Anything else
 *  the user wants on mobile they can drag in via the mobile-layout
 *  customizer in settings. */
export function mobileLayoutDefault(): Layout {
  return [
    { type: "button", id: "undo" },
    { type: "button", id: "redo" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "insert" },
    { type: "button", id: "turn-into" },
    { type: "button", id: "block-actions" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "heading-1" },
    { type: "button", id: "heading-2" },
    { type: "button", id: "heading-3" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "bold" },
    { type: "button", id: "italic" },
    { type: "button", id: "highlight" },
    { type: "button", id: "text-color" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "bullet-list" },
    { type: "button", id: "ordered-list" },
    { type: "button", id: "task-list" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "link" },
    { type: "button", id: "code" },
    { type: "button", id: "blockquote" },
  ];
}

/** Migration: replace any `{type:"button",id:"heading"}` (legacy
 *  combined-dropdown id) with the seven individual heading buttons,
 *  packaged into a submenu so existing users see the same UX as
 *  before the split. Walks both top-level + submenu children. */
export function migrateLegacyHeadingButton(layout: Layout): Layout {
  const replace = (items: Layout): Layout => {
    const out: Layout = [];
    for (const item of items) {
      if (item.type === "button" && item.id === "heading") {
        out.push({
          type: "submenu",
          id: newId("sub"),
          label: "Heading",
          icon: "heading",
          children: [
            { type: "button", id: "paragraph" },
            { type: "button", id: "heading-1" },
            { type: "button", id: "heading-2" },
            { type: "button", id: "heading-3" },
            { type: "button", id: "heading-4" },
            { type: "button", id: "heading-5" },
            { type: "button", id: "heading-6" },
          ],
        });
      } else if (item.type === "submenu") {
        out.push({ ...item, children: replace(item.children) });
      } else {
        out.push(item);
      }
    }
    return out;
  };
  return replace(layout);
}

/** Mobile-only table toolbar preset. ~7 buttons, sized to fit on
 *  a phone in portrait without horizontal scrolling. Three column-
 *  alignment buttons collapse into a single `align-cycle` button
 *  that rotates left → center → right on tap; sort-desc, transpose,
 *  delete-row/col, and move buttons live in the overflow sheet for
 *  thumb-friendly access without crowding the bar. */
export function mobileTableLayoutDefault(): Layout {
  return [
    { type: "button", id: "add-row-above" },
    { type: "button", id: "add-row-below" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "add-col-left" },
    { type: "button", id: "add-col-right" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "align-cycle" },
    { type: "button", id: "sort-asc" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "del-table" },
  ];
}

/** Default table toolbar - streamlined to the essentials. Row /
 *  column delete + the move-row/move-col buttons are intentionally
 *  not in the default; users who want them can drag them in via
 *  the customizer (they're still in the catalog). */
export function defaultTableLayout(): Layout {
  return [
    { type: "button", id: "add-row-above" },
    { type: "button", id: "add-row-below" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "add-col-left" },
    { type: "button", id: "add-col-right" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "align-left" },
    { type: "button", id: "align-center" },
    { type: "button", id: "align-right" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "sort-asc" },
    { type: "button", id: "sort-desc" },
    { type: "button", id: "transpose" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "del-table" },
  ];
}

// ── Tree walks ─────────────────────────────────────────────────

export function collectButtonIds(layout: Layout): Set<string> {
  const ids = new Set<string>();
  const walk = (items: Layout) => {
    for (const item of items) {
      if (item.type === "button") ids.add(item.id);
      else if (item.type === "submenu") walk(item.children);
    }
  };
  walk(layout);
  return ids;
}

/** Backfill buttons that exist in `defaults` but are missing from
 *  `layout`. Appends them at the end so existing user ordering is
 *  untouched. Returns the layout (mutated in place). */
export function backfillMissingButtons(layout: Layout, defaults: Layout): Layout {
  const existing = collectButtonIds(layout);
  for (const item of defaults) {
    if (item.type === "button" && !existing.has(item.id)) {
      layout.push({ type: "button", id: item.id });
    }
  }
  return layout;
}

/** Find an item by id anywhere in the layout, returning its parent
 *  array + index so the caller can splice. Returns null if not found. */
export function locate(
  layout: Layout,
  id: string,
): { parent: Layout; index: number } | null {
  for (let i = 0; i < layout.length; i++) {
    if (layout[i].id === id) return { parent: layout, index: i };
    if (layout[i].type === "submenu") {
      const sub = layout[i] as Extract<LayoutItem, { type: "submenu" }>;
      const inner = locate(sub.children, id);
      if (inner) return inner;
    }
  }
  return null;
}

/** Remove the item with the given id. Returns the removed item or
 *  null if not found. Mutates the layout. */
export function removeItem(layout: Layout, id: string): LayoutItem | null {
  const found = locate(layout, id);
  if (!found) return null;
  const [removed] = found.parent.splice(found.index, 1);
  return removed;
}

/** Migration from the legacy `toolbarHiddenButtons` array. Builds
 *  the appropriate default layout, then drops any button items
 *  whose id is in the hidden list. Items inside submenus are also
 *  filtered (forward-compatible if defaults ever ship submenus). */
export function migrateFromHiddenList(
  defaultLayout: Layout,
  hiddenIds: string[],
): Layout {
  if (hiddenIds.length === 0) return defaultLayout;
  const hidden = new Set(hiddenIds);
  const filter = (items: Layout): Layout =>
    items
      .filter((item) => !(item.type === "button" && hidden.has(item.id)))
      .map((item) =>
        item.type === "submenu"
          ? { ...item, children: filter(item.children) }
          : item,
      );
  return filter(defaultLayout);
}

/** Deep-clone a layout (so user edits don't mutate the default
 *  reference). Plain JSON round-trip is fine since LayoutItems are
 *  serializable. */
export function cloneLayout(layout: Layout): Layout {
  return JSON.parse(JSON.stringify(layout)) as Layout;
}
