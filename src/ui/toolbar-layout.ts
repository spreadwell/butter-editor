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
  | { type: "button"; id: string; /** Optional per-placement key for layouts that repeat an action. */ instanceId?: string }
  | {
      type: "command";
      id: string;
      commandId: string;
      label: string;
      icon: string;
    }
  | { type: "separator"; id: string }
  | {
      type: "submenu";
      id: string;
      label: string;
      icon: string;
      /** Context-menu-only icon strip. Ordinary toolbar/context submenus omit it. */
      presentation?: "menu" | "quick";
      children: LayoutItem[];
    }
  /** Mobile-only: a "More …" button that opens a bottom sheet
   *  listing every action in the layout. Auto-injected at the end
   *  of the mobile toolbar render if not present in the layout, so
   *  users always have an overflow path even on stock layouts. */
  | { type: "overflow"; id: string };

export type Layout = LayoutItem[];

/** Preserve catalog order while grouping available actions for both layout
 * customizers. Keeping this shared prevents their browsing structures from
 * drifting apart. */
export function groupActionDefinitions<T extends { group: string }>(
  definitions: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const definition of definitions) {
    const entries = groups.get(definition.group) ?? [];
    entries.push(definition);
    groups.set(definition.group, entries);
  }
  return groups;
}

/** Stable row/placement identity. Repeated actions carry a separate instance
 * ID so each placement can be moved or removed independently. */
export function layoutItemKey(item: LayoutItem): string {
  return item.type === "button" ? item.instanceId ?? item.id : item.id;
}

/** The lower edge of chrome that can cover block-level UI at the top
 *  of the editor, including drag handles and selection overlays. */
export function editorTopChromeBottom(
  toolbarPosition: "top" | "bottom",
  headerBottom: number,
  toolbarBottom: number,
  contextToolbarBottom: number,
): number {
  if (toolbarPosition === "bottom") return headerBottom;
  return Math.max(headerBottom, toolbarBottom, contextToolbarBottom);
}

/** Lowest visible contextual toolbar edge. Contextual bars are positioned over
 * the editor in attached/integrated layouts, so their bounds are not reliably
 * represented by the toolbar stack itself. */
export function visibleContextToolbarBottom(
  root: ParentNode | null | undefined,
): number {
  if (!root) return 0;
  let bottom = 0;
  const toolbars = Array.from(root.querySelectorAll<HTMLElement>(
    ".butter-context-toolbar:not(.is-hidden):not(.butter-search-suppressed)",
  ));
  for (const toolbar of toolbars) {
    bottom = Math.max(bottom, toolbar.getBoundingClientRect().bottom);
  }
  return bottom;
}

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

/** Full preset - the canonical "everything available" layout. */
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
    { type: "button", id: "code" },
    { type: "button", id: "link" },
    { type: "button", id: "clear-formatting" },
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
        { type: "button", id: "indent-list" },
        { type: "button", id: "outdent-list" },
      ],
    },
    { type: "button", id: "blockquote" },
    {
      type: "submenu",
      id: newId("sub"),
      label: "Callout",
      icon: "message-square-quote",
      children: [
        { type: "button", id: "callout-note" },
        { type: "button", id: "callout-abstract" },
        { type: "button", id: "callout-info" },
        { type: "button", id: "callout-tip" },
        { type: "button", id: "callout-success" },
        { type: "button", id: "callout-question" },
        { type: "button", id: "callout-warning" },
        { type: "button", id: "callout-failure" },
        { type: "button", id: "callout-danger" },
        { type: "button", id: "callout-bug" },
        { type: "button", id: "callout-example" },
        { type: "button", id: "callout-quote" },
      ],
    },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "hr" },
    { type: "button", id: "table" },
    { type: "button", id: "code-block" },
    { type: "button", id: "image" },
    { type: "button", id: "video" },
    { type: "separator", id: newId("sep") },
    {
      type: "submenu",
      id: newId("sub"),
      label: "Base",
      icon: "database",
      children: [
        { type: "button", id: "insert-base-inline" },
        { type: "button", id: "insert-base-embed" },
      ],
    },
  ];
}

/** Default preset - balanced everyday tools with low toolbar density. */
export function mainLayoutDefault(): Layout {
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
    { type: "button", id: "link" },
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
        { type: "button", id: "indent-list" },
        { type: "button", id: "outdent-list" },
      ],
    },
    { type: "button", id: "blockquote" },
    {
      type: "submenu",
      id: newId("sub"),
      label: "Insert",
      icon: "plus",
      children: [
        { type: "button", id: "image" },
        { type: "button", id: "video" },
        { type: "button", id: "table" },
      ],
    },
  ];
}

/** Simple preset - compact essentials for a quiet desktop toolbar. */
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
    { type: "button", id: "link" },
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
    { type: "button", id: "image" },
  ];
}

/** New users get the balanced Default preset on first load. */
export function defaultMainLayout(): Layout {
  return mainLayoutDefault();
}

/** Mobile Simple preset - the smallest useful one-handed strip. */
export function mobileLayoutSimple(): Layout {
  return [
    { type: "button", id: "undo" },
    { type: "button", id: "redo" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "insert" },
    { type: "button", id: "turn-into" },
    { type: "button", id: "block-actions" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "bold" },
    { type: "button", id: "italic" },
    { type: "button", id: "link" },
    { type: "separator", id: newId("sep") },
    { type: "button", id: "bullet-list" },
    { type: "button", id: "task-list" },
  ];
}

/** Mobile preset - flat, scrollable strip tuned for thumb-typing on a
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
    { type: "button", id: "image" },
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
    { type: "button", id: "indent-list" },
    { type: "button", id: "outdent-list" },
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

/** Count every built-in action placement across the root and its submenus. */
export function countButtonPlacements(layout: Layout): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (items: Layout) => {
    for (const item of items) {
      if (item.type === "button") counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
      else if (item.type === "submenu") walk(item.children);
    }
  };
  walk(layout);
  return counts;
}

export function collectCommandItems(
  layout: Layout,
): Array<Extract<LayoutItem, { type: "command" }>> {
  const commands: Array<Extract<LayoutItem, { type: "command" }>> = [];
  const walk = (items: Layout) => {
    for (const item of items) {
      if (item.type === "command") commands.push(item);
      else if (item.type === "submenu") walk(item.children);
    }
  };
  walk(layout);
  return commands;
}

/** Remove retired button ids from a saved layout, including submenus. */
export function removeButtonsById(
  layout: Layout,
  retiredIds: ReadonlySet<string>,
): number {
  let removed = 0;
  for (let index = layout.length - 1; index >= 0; index--) {
    const item = layout[index];
    if (item.type === "button" && retiredIds.has(item.id)) {
      layout.splice(index, 1);
      removed += 1;
    } else if (item.type === "submenu") {
      removed += removeButtonsById(item.children, retiredIds);
    }
  }
  return removed;
}

/** Rename saved button placements recursively while preserving their instance IDs. */
export function replaceButtonId(layout: Layout, fromId: string, toId: string): number {
  let replaced = 0;
  for (const item of layout) {
    if (item.type === "button" && item.id === fromId) {
      item.id = toId;
      replaced += 1;
    } else if (item.type === "submenu") {
      replaced += replaceButtonId(item.children, fromId, toId);
    }
  }
  return replaced;
}

/** Find an item by id anywhere in the layout, returning its parent
 *  array + index so the caller can splice. Returns null if not found. */
export function locate(
  layout: Layout,
  id: string,
): { parent: Layout; index: number } | null {
  for (let i = 0; i < layout.length; i++) {
    if (layoutItemKey(layout[i]) === id) return { parent: layout, index: i };
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

/** Shared visible viewport for selection and search reveal, scoped to its pane. */
export function visibleEditorBounds(host: HTMLElement): { top: number; bottom: number } {
  const bounds = host.getBoundingClientRect();
  let top = bounds.top + 8;
  let bottom = bounds.bottom - 8;
  const doc = host.ownerDocument;
  const root = doc.body.classList.contains("is-mobile") ? doc.body : host.closest(".butter-view-root") ?? host;
  for (const toolbar of Array.from(root.querySelectorAll<HTMLElement>(
    ".butter-toolbar, .butter-context-toolbar:not(.is-hidden):not(.butter-search-suppressed)",
  ))) {
    const style = doc.defaultView?.getComputedStyle(toolbar);
    if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") < 0.05) continue;
    const rect = toolbar.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) continue;
    if (rect.top + rect.height / 2 < bounds.top + bounds.height / 2) top = Math.max(top, rect.bottom + 8);
    else bottom = Math.min(bottom, rect.top - 8);
  }
  return { top, bottom };
}
