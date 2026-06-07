/**
 * Mobile drawer (butter-style only).
 *
 * Single drawer surface with two modes:
 *   • "insert"  - 2-column grid of slash-menu items (block insertion).
 *                 Default when opened from the toolbar `+` button.
 *   • "block-actions" - block-context items for a specific block
 *                 (Turn into / Edit source / Language / Callout type
 *                 / List type, plus universal Copy / Duplicate /
 *                 Delete). Default when opened via mobile long-press
 *                 on a block (no drag).
 * A toggle button at the top swaps between modes in place; the
 * drawer chrome (handle + toggle row + close button in the bar's
 * chrome slot) stays put. Mode is per-open - closing and reopening
 * resets to whatever the trigger requested.
 *
 * Tapping the `+` button on the butter-style mobile toolbar swaps
 * the soft keyboard for the drawer. The toolbar stays put - the
 * keyboard area is the only thing that changes. Closing the drawer
 * (tap a tile, tap the close handle, or tap outside) dismisses it
 * and refocuses the editor so the keyboard returns.
 *
 * Mechanics:
 *   1. Read the current `--keyboard-height` from `:root` and
 *      remember it as `--butter-drawer-height`.
 *   2. Blur the editor → keyboard slides away, but the toolbar's
 *      `bottom` is overridden to the saved drawer height by a body
 *      class so it doesn't drop with the keyboard.
 *   3. Mount the drawer at `bottom: 0` with the saved height so
 *      it occupies exactly the space the keyboard just vacated.
 *   4. On dismiss, remove the override + drawer and refocus the
 *      editor; the OS slides the keyboard back in and Obsidian
 *      resets `--keyboard-height` automatically.
 */
import { App, Notice, setIcon } from "obsidian";
import type { EditorView } from "prosemirror-view";
import type { Schema, Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { SLASH_ITEMS, type SlashItem } from "./slash-menu";
import {
  buildSingleBlockMenuItems,
  validTurnIntoTargets,
  type BlockMenuItem,
  type BlockSubItem,
} from "../editor/block-menu-spec";

const BODY_CLASS = "butter-mobile-drawer-open";
const HEIGHT_VAR = "--butter-mobile-drawer-height";
const FALLBACK_HEIGHT = 320; // px - typical phone keyboard

export type DrawerMode = "insert" | "turn-into" | "block-actions";

export interface DrawerBlockContext {
  pos: number;
  node: PMNode;
  blockDom?: HTMLElement;
  /** Required for the "Copy" universal action - produces the block's
   *  markdown source so it can be written to the clipboard. The
   *  view doesn't carry a serializer reference, so the call site
   *  (main.ts when wiring long-press) threads it in. */
  serializeNode?: (node: PMNode) => string;
}

export interface DrawerOpenOptions {
  mode: DrawerMode;
  /** Required when `mode === "block-actions"`; ignored otherwise. */
  blockContext?: DrawerBlockContext;
}

/** Cleanup hooks for the active drawer (focusin auto-close,
 *  fake-cursor element). Stashed at module level because
 *  `closeMobileInsertDrawer` is exported and called from multiple
 *  sites (close button, tile tap, focus-in auto-dismiss) without
 *  passing context. */
let activeCleanup: (() => void) | null = null;

/** Categories the drawer groups slash items into, in display
 *  order. Each category's `match` runs against the slash item's
 *  `id` to decide membership. Items that match no category fall
 *  into a final "Other" group at the end so additions to
 *  `SLASH_ITEMS` never silently drop out of the drawer. */
const CATEGORIES: Array<{ name: string; match: (id: string) => boolean }> = [
  {
    name: "Headings",
    match: (id) => /^h[1-6]$/.test(id) || id === "paragraph",
  },
  {
    name: "Lists",
    match: (id) => id === "bullet" || id === "ordered" || id === "task",
  },
  {
    name: "Structural",
    match: (id) => id === "quote" || id === "hr" || id === "table",
  },
  {
    name: "Code & data",
    match: (id) =>
      id === "code" ||
      id === "math" ||
      id === "mermaid" ||
      id === "dataview" ||
      id === "dataviewjs" ||
      id === "base",
  },
  {
    name: "Callouts",
    match: (id) => id.startsWith("callout-"),
  },
];

/** Bucket the live `SLASH_ITEMS` array into category groups in
 *  display order. Anything that matches no category lands in a
 *  final "Other" group so future additions stay visible. */
function groupSlashItems(): Array<{ name: string; items: SlashItem[] }> {
  const groups: Array<{ name: string; items: SlashItem[] }> = CATEGORIES.map(
    (c) => ({ name: c.name, items: [] }),
  );
  const other: SlashItem[] = [];
  for (const item of SLASH_ITEMS) {
    const idx = CATEGORIES.findIndex((c) => c.match(item.id));
    if (idx >= 0) groups[idx].items.push(item);
    else other.push(item);
  }
  if (other.length > 0) groups.push({ name: "Other", items: other });
  return groups.filter((g) => g.items.length > 0);
}

/** Read the current keyboard height from `:root`. Returns a CSS-
 *  ready string with px units, or the fallback if the variable is
 *  unset / 0. */
function readKeyboardHeight(): string {
  const raw = getComputedStyle(activeDocument.documentElement)
    .getPropertyValue("--keyboard-height")
    .trim();
  if (raw && raw !== "0px" && raw !== "0") return raw;
  return `${FALLBACK_HEIGHT}px`;
}

/** Generic drawer entry. Use `openMobileInsertDrawer` for the
 *  toolbar `+` path; long-press routes through here directly with
 *  `mode: "block-actions"`. */
export function openMobileDrawer(
  view: EditorView,
  schema: Schema,
  app: App,
  opts: DrawerOpenOptions,
): void {
  // Don't open twice - close any existing drawer first.
  closeMobileInsertDrawer();

  // Capture keyboard height BEFORE blurring, so the bar stays
  // anchored at the keyboard's old top edge while the keyboard
  // animates away.
  const height = readKeyboardHeight();
  activeDocument.body.style.setProperty(HEIGHT_VAR, height);
  activeDocument.body.classList.add(BODY_CLASS);

  // Fake caret - PM stops drawing the real cursor when the editor
  // blurs (which we do to dismiss the keyboard), so the user
  // would otherwise lose track of WHERE the inserted block will
  // land. Snapshot the selection's screen coords now and draw a
  // blinking vertical line at that spot. Removed on close. */
  let fakeCursor: HTMLElement | null = null;
  try {
    const sel = view.state.selection;
    const coords = view.coordsAtPos(sel.head);
    fakeCursor = activeDocument.createElement("div");
    fakeCursor.className = "butter-mobile-fake-cursor";
    fakeCursor.style.left = `${coords.left}px`;
    fakeCursor.style.top = `${coords.top}px`;
    fakeCursor.style.height = `${Math.max(coords.bottom - coords.top, 16)}px`;
    activeDocument.body.appendChild(fakeCursor);
  } catch {
    // coordsAtPos can throw if selection is in an unusual state;
    // skip the fake cursor - drawer still works without it.
  }

  // Auto-close on editor refocus. If the user taps elsewhere on
  // the note, the editor receives focus and the OS slides the
  // keyboard back up - at that point the drawer's space is taken
  // by the keyboard, so the drawer (and its in-chrome close
  // button) need to dismiss themselves. Listen for focusin on
  // the editor's contenteditable; one shot, removed on close.
  const onEditorFocusIn = () => {
    closeMobileInsertDrawer();
  };
  view.dom.addEventListener("focusin", onEditorFocusIn, { once: true });

  activeCleanup = () => {
    fakeCursor?.remove();
    view.dom.removeEventListener("focusin", onEditorFocusIn);
  };

  // Build the drawer. The close affordance lives in the bar's
  // chrome slot (right side), not inside the drawer - keeps the
  // toolbar-action position predictable. We still render a thin
  // grab handle at the top edge as a visual cue.
  const drawer = activeDocument.createElement("div");
  drawer.className = "butter-mobile-insert-drawer";
  drawer.dataset.role = "drawer";

  const handle = activeDocument.createElement("div");
  handle.className = "butter-mobile-insert-drawer-handle";
  drawer.appendChild(handle);

  // ── Body grid (rendered once per open) ────────────────────
  // The drawer's mode is fixed for the duration of the open. With
  // separate toolbar buttons (Insert / Turn into / Block actions)
  // each opening their own scoped drawer, an in-drawer toggle is
  // redundant - close the drawer and tap the other button.
  const grid = activeDocument.createElement("div");
  grid.className = "butter-mobile-insert-drawer-grid";
  drawer.appendChild(grid);

  const blockCtx = opts.blockContext;

  if (opts.mode === "insert") {
    renderInsertView(grid, view, schema, app);
  } else if (opts.mode === "turn-into") {
    renderTurnIntoView(grid, view, app, blockCtx);
  } else {
    renderBlockActionsView(grid, view, app, blockCtx);
  }

  activeDocument.body.appendChild(drawer);

  // Slide-in animation: append, then next frame add `is-open`.
  window.requestAnimationFrame(() => drawer.classList.add("is-open"));

  // Defer the editor blur until after the drawer is mounted so
  // the bar's bottom override is in effect when the keyboard
  // starts animating away. Otherwise the bar would briefly drop
  // to viewport bottom before the body class lands.
  window.setTimeout(() => {
    view.dom.blur();
    if (activeDocument.activeElement instanceof HTMLElement) {
      activeDocument.activeElement.blur();
    }
  }, 0);
}

/** Back-compat wrapper used by `toolbar-mobile.ts:renderButterMain`
 *  - toolbar `+` always opens in insert mode. */
export function openMobileInsertDrawer(
  view: EditorView,
  schema: Schema,
  app: App,
): void {
  openMobileDrawer(view, schema, app, { mode: "insert" });
}

function renderInsertView(
  grid: HTMLElement,
  view: EditorView,
  schema: Schema,
  app: App,
): void {
  grid.replaceChildren();
  grid.dataset.mode = "insert";
  for (const group of groupSlashItems()) {
    const header = activeDocument.createElement("div");
    header.className = "butter-mobile-insert-drawer-category";
    header.textContent = group.name;
    grid.appendChild(header);
    for (const item of group.items) {
      renderInsertTile(grid, item, view, schema, app);
    }
  }
}

/** Turn-into mode - only the block-type changer, scoped to the
 *  current block. Driven off `buildSingleBlockMenuItems` so the
 *  available targets and the active marker stay in sync with the
 *  desktop block context menu's Turn-into submenu. */
function renderTurnIntoView(
  grid: HTMLElement,
  view: EditorView,
  app: App,
  blockCtx: DrawerBlockContext | undefined,
): void {
  grid.replaceChildren();
  grid.dataset.mode = "turn-into";
  if (!blockCtx) {
    renderEmptyState(grid, "No block selected");
    return;
  }
  if (!validTurnIntoTargets(blockCtx.node)) {
    renderEmptyState(
      grid,
      `Can't transform ${blockCtx.node.type.name} blocks`,
    );
    return;
  }
  const items = buildSingleBlockMenuItems({
    view,
    pos: blockCtx.pos,
    node: blockCtx.node,
    app,
    blockDom: blockCtx.blockDom,
  });
  const turnInto = items.find((i) => i.id === "turn-into");
  if (!turnInto?.submenu) {
    renderEmptyState(grid, "No transform targets available");
    return;
  }
  // Re-bucket targets into the same category rhythm the slash-menu
  // drawer uses (Headings / Lists / Structural). The spec's own
  // groups (5 narrower bins by display order) are good for the
  // desktop menu but feel over-segmented in a 2-col drawer; merging
  // into the slash-menu's three buckets reads cleaner. Anything
  // unmatched falls into a final "Other" bucket so future spec
  // additions stay visible.
  // Manual flatten - `Array.prototype.flat()` requires ES2019 and
  // this module's tsconfig target is older. Tiny and explicit.
  const allSubs: BlockSubItem[] = [];
  for (const group of turnInto.submenu) {
    for (const sub of group) allSubs.push(sub);
  }
  const buckets: Array<{ name: string; items: BlockSubItem[] }> =
    TURN_INTO_CATEGORIES.map((c) => ({ name: c.name, items: [] }));
  const otherSubs: BlockSubItem[] = [];
  for (const sub of allSubs) {
    const idx = TURN_INTO_CATEGORIES.findIndex((c) => c.ids.includes(sub.id));
    if (idx >= 0) buckets[idx].items.push(sub);
    else otherSubs.push(sub);
  }
  if (otherSubs.length > 0) buckets.push({ name: "Other", items: otherSubs });
  for (const bucket of buckets) {
    if (bucket.items.length === 0) continue;
    const header = activeDocument.createElement("div");
    header.className = "butter-mobile-insert-drawer-category";
    header.textContent = bucket.name;
    grid.appendChild(header);
    for (const sub of bucket.items) {
      renderBlockSubTile(grid, sub, view, blockCtx);
    }
  }
}

/** Category buckets for the Turn-into drawer. Defined locally
 *  rather than threading labels through `block-menu-spec.ts` so
 *  the spec module stays neutral on UI grouping. Mirrors the
 *  slash-menu drawer's category rhythm. */
const TURN_INTO_CATEGORIES: Array<{ name: string; ids: string[] }> = [
  { name: "Headings", ids: ["paragraph", "h1", "h2", "h3", "h4", "h5", "h6"] },
  { name: "Lists", ids: ["bullet_list", "ordered_list", "task_list"] },
  {
    name: "Structural",
    ids: [
      "blockquote",
      "obsidian_callout",
      "code_block",
      "math_block",
      "horizontal_rule",
    ],
  },
];

/** Block-actions mode - every block-context action EXCEPT the
 *  Turn-into submenu (Turn into has its own toolbar button +
 *  drawer mode). Includes per-block-type items (Edit source,
 *  Language, Callout type, List type) and universal Copy /
 *  Duplicate / Delete. */
function renderBlockActionsView(
  grid: HTMLElement,
  view: EditorView,
  app: App,
  blockCtx: DrawerBlockContext | undefined,
): void {
  grid.replaceChildren();
  grid.dataset.mode = "block-actions";
  if (!blockCtx) {
    renderEmptyState(grid, "No block selected");
    return;
  }
  const items = buildSingleBlockMenuItems({
    view,
    pos: blockCtx.pos,
    node: blockCtx.node,
    app,
    blockDom: blockCtx.blockDom,
  });
  // Skip the Turn-into entry - it has its own toolbar button.
  // Render remaining spec items (Edit source, Language, Callout
  // type, List type). Submenu items render as section + tiles.
  for (const item of items) {
    if (item.id === "turn-into") continue;
    if (item.submenu) {
      const header = activeDocument.createElement("div");
      header.className = "butter-mobile-insert-drawer-category";
      header.textContent = item.title;
      grid.appendChild(header);
      for (const group of item.submenu) {
        for (const sub of group) {
          renderBlockSubTile(grid, sub, view, blockCtx);
        }
      }
    } else {
      renderBlockTile(grid, item, view, blockCtx);
    }
  }
  // Universal lifecycle actions - same set as the desktop block
  // context menu (`drag-handles.ts:openBlockContextMenu`), shaped
  // as `BlockMenuItem`s so the renderer treats them identically.
  const headerUniversal = activeDocument.createElement("div");
  headerUniversal.className = "butter-mobile-insert-drawer-category";
  headerUniversal.textContent = "Block";
  grid.appendChild(headerUniversal);
  if (blockCtx.serializeNode) {
    const serialize = blockCtx.serializeNode;
    renderBlockTile(
      grid,
      {
        id: "block-copy",
        title: "Copy",
        icon: "copy",
        sideEffect: (_v, _p, n) => {
          const md = serialize(n);
          void navigator.clipboard.writeText(md.replace(/\n+$/, "")).then(
            () => new Notice("Copied block"),
            () => new Notice("Clipboard write failed"),
          );
        },
      },
      view,
      blockCtx,
    );
  }
  renderBlockTile(
    grid,
    {
      id: "block-duplicate",
      title: "Duplicate",
      icon: "copy-plus",
      sideEffect: (v, p, n) => {
        const after = p + n.nodeSize;
        const clone = n.type.create(n.attrs, n.content, n.marks);
        v.dispatch(v.state.tr.insert(after, clone));
      },
    },
    view,
    blockCtx,
  );
  renderBlockTile(
    grid,
    {
      id: "block-delete",
      title: "Delete",
      icon: "trash-2",
      warning: true,
      sideEffect: (v, p, n) => {
        v.dispatch(v.state.tr.delete(p, p + n.nodeSize));
      },
    },
    view,
    blockCtx,
  );
}

function renderEmptyState(grid: HTMLElement, message: string): void {
  const empty = activeDocument.createElement("div");
  empty.className = "butter-mobile-insert-drawer-empty";
  empty.textContent = message;
  grid.appendChild(empty);
}

function renderInsertTile(
  grid: HTMLElement,
  item: SlashItem,
  view: EditorView,
  schema: Schema,
  app: App,
): void {
  const tile = activeDocument.createElement("button");
  tile.className = "butter-mobile-insert-drawer-tile clickable-icon";
  tile.setAttribute("aria-label", item.label);
  const iconEl = activeDocument.createElement("span");
  iconEl.className = "butter-mobile-insert-drawer-tile-icon";
  setIcon(iconEl, item.icon);
  const labelEl = activeDocument.createElement("span");
  labelEl.className = "butter-mobile-insert-drawer-tile-label";
  labelEl.textContent = item.label;
  tile.appendChild(iconEl);
  tile.appendChild(labelEl);
  tile.addEventListener("click", (e) => {
    e.preventDefault();
    // Close FIRST so the keyboard reappears alongside the
    // inserted block - the user expects to keep typing.
    closeMobileInsertDrawer();
    try {
      // Insert vs convert: if the active text block is non-empty,
      // open a fresh empty paragraph after it and move the cursor
      // there before running the item — so slash-menu items that
      // setBlockType (headings, code, etc.) convert the NEW empty
      // paragraph instead of replacing the user's existing block.
      // If the active block is empty, run as-is — current behavior
      // matches "Turn into," converting the empty block to the
      // chosen type.
      ensureInsertCursorBelow(view, schema);
      item.run(view, schema, app);
    } catch (err) {
      console.error("[butter-insert-drawer]", item.id, err);
    }
    // Refocus on next tick so the editor has the keyboard back
    // before the cursor lands inside the new block.
    window.setTimeout(() => view.focus(), 0);
  });
  grid.appendChild(tile);
}

/** If the cursor is inside a non-empty text block, insert an empty
 *  paragraph after it and move the cursor into that new paragraph.
 *  No-op when the active block is already empty (the slash-item
 *  conversion logic targets the current block as-is) or when the
 *  selection isn't inside a text block (atom NodeSelection — the
 *  item's run() handles its own placement). */
function ensureInsertCursorBelow(view: EditorView, schema: Schema): void {
  const sel = view.state.selection;
  const $ = sel.$from;
  const parent = $.parent;
  if (!parent.isTextblock) return;
  if (parent.content.size === 0) return;
  if (!schema.nodes.paragraph) return;
  const insertAt = $.after($.depth);
  const newPara = schema.nodes.paragraph.create();
  const tr = view.state.tr.insert(insertAt, newPara);
  // Cursor lands one position inside the new paragraph
  // (insertAt + 1 = after the para's opening token).
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)));
  } catch {
    // Selection-resolve fails are extremely rare here; if it does,
    // bail without dispatching — the user gets the old turn-into
    // behavior, which is at least functional.
    return;
  }
  view.dispatch(tr);
}

function renderBlockTile(
  grid: HTMLElement,
  item: BlockMenuItem,
  view: EditorView,
  ctx: DrawerBlockContext,
): void {
  const tile = activeDocument.createElement("button");
  tile.className = "butter-mobile-insert-drawer-tile clickable-icon";
  tile.setAttribute("aria-label", item.title);
  if (item.warning) tile.dataset.warning = "true";
  const iconEl = activeDocument.createElement("span");
  iconEl.className = "butter-mobile-insert-drawer-tile-icon";
  setIcon(iconEl, item.icon);
  const labelEl = activeDocument.createElement("span");
  labelEl.className = "butter-mobile-insert-drawer-tile-label";
  labelEl.textContent = item.title;
  tile.appendChild(iconEl);
  tile.appendChild(labelEl);
  tile.addEventListener("click", (e) => {
    e.preventDefault();
    closeMobileInsertDrawer();
    try {
      if (item.applyTr) {
        const tr = view.state.tr;
        item.applyTr(tr, ctx.pos, ctx.node);
        if (tr.docChanged) view.dispatch(tr);
      } else if (item.sideEffect) {
        item.sideEffect(view, ctx.pos, ctx.node);
      }
    } catch (err) {
      console.error("[butter-insert-drawer]", item.id, err);
    }
    window.setTimeout(() => view.focus(), 0);
  });
  grid.appendChild(tile);
}

function renderBlockSubTile(
  grid: HTMLElement,
  sub: BlockSubItem,
  view: EditorView,
  ctx: DrawerBlockContext,
): void {
  const tile = activeDocument.createElement("button");
  tile.className = "butter-mobile-insert-drawer-tile clickable-icon";
  tile.setAttribute("aria-label", sub.title);
  if (sub.isCurrent) tile.dataset.current = "true";
  const iconEl = activeDocument.createElement("span");
  iconEl.className = "butter-mobile-insert-drawer-tile-icon";
  if (sub.icon) setIcon(iconEl, sub.icon);
  const labelEl = activeDocument.createElement("span");
  labelEl.className = "butter-mobile-insert-drawer-tile-label";
  labelEl.textContent = sub.title;
  tile.appendChild(iconEl);
  tile.appendChild(labelEl);
  tile.addEventListener("click", (e) => {
    e.preventDefault();
    closeMobileInsertDrawer();
    try {
      if (sub.applyTr) {
        const tr = view.state.tr;
        sub.applyTr(tr, ctx.pos, ctx.node);
        if (tr.docChanged) view.dispatch(tr);
      } else if (sub.sideEffect) {
        sub.sideEffect(view, ctx.pos, ctx.node);
      }
    } catch (err) {
      console.error("[butter-insert-drawer]", sub.id, err);
    }
    window.setTimeout(() => view.focus(), 0);
  });
  grid.appendChild(tile);
}

/** Dismiss the drawer if it's open. Safe to call when no drawer
 *  exists. Caller is responsible for refocusing the editor if a
 *  keyboard return is desired (we don't refocus here because the
 *  trigger sites - close button, tile click, editor refocus
 *  have different refocus needs). */
export function closeMobileInsertDrawer(): void {
  activeDocument.body.classList.remove(BODY_CLASS);
  activeDocument.body.style.removeProperty(HEIGHT_VAR);
  // Run open-time cleanup (removes fake cursor + focusin listener)
  // BEFORE removing the drawer dom, so a synchronous focus event
  // can't double-fire close.
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  const existing = activeDocument.body.querySelector<HTMLElement>(
    ".butter-mobile-insert-drawer",
  );
  if (!existing) return;
  existing.classList.remove("is-open");
  // Match the CSS slide-out duration before removing.
  window.setTimeout(() => existing.remove(), 200);
}
