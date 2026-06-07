/**
 * Floating table toolbar.
 *
 * Appears when the PM selection is inside a `table` node; hides when
 * the selection leaves. Provides insert/delete row+column, column
 * alignment, move row/column, sort column, transpose, and delete
 * table. Positioned relative to the PM editor's scroller so the
 * toolbar follows the table on scroll without any coordinate math.
 *
 * Buttons dispatch commands via prosemirror-tables where available,
 * and drop to custom transactions for the features prosemirror-tables
 * doesn't cover (move row/col, sort, transpose).
 */
import { App, Modal, Platform, setIcon } from "obsidian";
import { closeMobileInsertDrawer } from "../ui/insert-drawer";
import { installOverscrollRubberBand } from "../ui/toolbar-mobile";
import {
  Plugin as PMPlugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Fragment, type Node as PMNode, type Schema } from "prosemirror-model";
import type { Layout, LayoutItem } from "../ui/toolbar-layout";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  TableMap,
} from "prosemirror-tables";
import { normalizeTableCells } from "./table-normalize";

// ═══════════════════════════════════════════
//  Position helpers
// ═══════════════════════════════════════════

interface TableContext {
  table: PMNode;
  tablePos: number;
  map: TableMap;
  rowIndex: number;
  colIndex: number;
}

function findTableContext(state: EditorState): TableContext | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.spec.tableRole === "table") {
      const tablePos = $from.before(d);
      const map = TableMap.get(node);
      const cellDepth = d + 2;
      let rowIndex = -1;
      let colIndex = -1;
      if ($from.depth >= cellDepth) {
        const cellPos = $from.before(cellDepth) - (tablePos + 1);
        const idx = map.map.indexOf(cellPos);
        if (idx >= 0) {
          rowIndex = Math.floor(idx / map.width);
          colIndex = idx % map.width;
        }
      }
      return { table: node, tablePos, map, rowIndex, colIndex };
    }
  }
  return null;
}

// ═══════════════════════════════════════════
//  Custom commands (move / sort / transpose)
// ═══════════════════════════════════════════

function getRowNodes(table: PMNode): PMNode[] {
  const rows: PMNode[] = [];
  table.forEach((row) => rows.push(row));
  return rows;
}

function rebuildTable(
  tr: Transaction,
  ctx: TableContext,
  rows: PMNode[],
) {
  const newTable = ctx.table.type.create(
    ctx.table.attrs,
    Fragment.fromArray(rows),
    ctx.table.marks,
  );
  // Normalize cell types based on new row positions. Any reorder
  // path (move row, sort, transpose) that lands a former header
  // row in a body position needs its cells re-tagged to keep the
  // save round-trip clean. See `src/table-normalize.ts`.
  const normalized = normalizeTableCells(newTable, ctx.table.type.schema);
  tr.replaceWith(ctx.tablePos, ctx.tablePos + ctx.table.nodeSize, normalized);
}

function moveRow(view: EditorView, dir: -1 | 1) {
  const ctx = findTableContext(view.state);
  if (!ctx || ctx.rowIndex < 0) return;
  const rows = getRowNodes(ctx.table);
  const target = ctx.rowIndex + dir;
  if (target < 0 || target >= rows.length) return;
  [rows[ctx.rowIndex], rows[target]] = [rows[target], rows[ctx.rowIndex]];
  const tr = view.state.tr;
  rebuildTable(tr, ctx, rows);
  view.dispatch(tr.scrollIntoView());
}

function moveColumn(view: EditorView, dir: -1 | 1) {
  const ctx = findTableContext(view.state);
  if (!ctx || ctx.colIndex < 0) return;
  const colCount = ctx.map.width;
  const target = ctx.colIndex + dir;
  if (target < 0 || target >= colCount) return;

  const newRows: PMNode[] = [];
  ctx.table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => cells.push(cell));
    if (cells.length < colCount) {
      // Row is sparse (colspan merge present). Skip safely.
      newRows.push(row);
      return;
    }
    [cells[ctx.colIndex], cells[target]] = [cells[target], cells[ctx.colIndex]];
    newRows.push(row.type.create(row.attrs, Fragment.fromArray(cells), row.marks));
  });

  const tr = view.state.tr;
  rebuildTable(tr, ctx, newRows);
  view.dispatch(tr.scrollIntoView());
}

function sortByColumn(view: EditorView, ascending: boolean) {
  const ctx = findTableContext(view.state);
  if (!ctx || ctx.colIndex < 0) return;
  const rows = getRowNodes(ctx.table);
  if (rows.length < 2) return;

  // Keep the header (first row) where it is; sort the rest.
  const [header, ...body] = rows;
  const colIdx = ctx.colIndex;
  const cellText = (row: PMNode): string => {
    let text = "";
    row.forEach((cell, _, i) => {
      if (i === colIdx) text = cell.textContent;
    });
    return text;
  };
  body.sort((a, b) => {
    const av = cellText(a);
    const bv = cellText(b);
    const numA = parseFloat(av);
    const numB = parseFloat(bv);
    const bothNum = !Number.isNaN(numA) && !Number.isNaN(numB);
    const cmp = bothNum ? numA - numB : av.localeCompare(bv);
    return ascending ? cmp : -cmp;
  });

  const tr = view.state.tr;
  rebuildTable(tr, ctx, [header, ...body]);
  view.dispatch(tr.scrollIntoView());
}

function transposeTable(view: EditorView) {
  const ctx = findTableContext(view.state);
  if (!ctx) return;
  const schema = view.state.schema;
  const tableRowType = schema.nodes.table_row;
  const headerType = schema.nodes.table_header;
  const cellType = schema.nodes.table_cell;
  if (!tableRowType) return;

  const { width, height } = ctx.map;
  const grid: PMNode[][] = [];
  let r = 0;
  ctx.table.forEach((row) => {
    const rowCells: PMNode[] = [];
    row.forEach((cell) => rowCells.push(cell));
    grid[r++] = rowCells;
  });

  // Pad sparse rows.
  for (const row of grid) {
    while (row.length < width) {
      row.push((cellType ?? headerType).createAndFill()!);
    }
  }

  const newRows: PMNode[] = [];
  for (let c = 0; c < width; c++) {
    const cells: PMNode[] = [];
    for (let r2 = 0; r2 < height; r2++) {
      const src = grid[r2][c];
      // First row becomes the new column of headers.
      const wantHeader = r2 === 0 && headerType;
      const targetType = wantHeader ? headerType : cellType ?? headerType;
      cells.push(
        targetType.create(
          src.attrs,
          src.content,
          src.marks,
        ),
      );
    }
    newRows.push(tableRowType.create(null, Fragment.fromArray(cells)));
  }

  const tr = view.state.tr;
  rebuildTable(tr, ctx, newRows);
  view.dispatch(tr.scrollIntoView());
}

function setColumnAlignment(
  view: EditorView,
  alignment: "left" | "center" | "right" | null,
) {
  const ctx = findTableContext(view.state);
  if (!ctx || ctx.colIndex < 0) return;
  const cellAttr = "alignment";
  const tr = view.state.tr;
  const { map, tablePos, colIndex } = ctx;
  for (let r = 0; r < map.height; r++) {
    const cellPos = tablePos + 1 + map.map[r * map.width + colIndex];
    const cell = tr.doc.nodeAt(cellPos);
    if (!cell) continue;
    tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, [cellAttr]: alignment, sourceRange: null });
  }
  view.dispatch(tr);
}

/** Cycle the active column's alignment: null/left → center → right →
 *  left. Used by the mobile-default `align-cycle` button which
 *  collapses three desktop alignment buttons into one. */
function cycleColumnAlignment(view: EditorView) {
  const ctx = findTableContext(view.state);
  if (!ctx || ctx.colIndex < 0) return;
  const cellPos =
    ctx.tablePos + 1 + ctx.map.map[ctx.rowIndex * ctx.map.width + ctx.colIndex];
  const cell = view.state.doc.nodeAt(cellPos);
  const cur = (cell?.attrs as { alignment?: unknown } | undefined)?.alignment ?? null;
  const next: "left" | "center" | "right" =
    cur === "center" ? "right" : cur === "right" ? "left" : "center";
  setColumnAlignment(view, next);
}

// ═══════════════════════════════════════════
//  Toolbar rendering
// ═══════════════════════════════════════════

interface Btn {
  id: string;
  icon: string;
  label: string;
  run: (view: EditorView) => void;
}

/**
 * Public catalog of every customizable button on the table toolbar.
 * Settings tab consumes this to render per-button visibility toggles.
 * Order drives the settings-UI order; `group` heads each cluster.
 */
export const TABLE_TOOLBAR_BUTTON_DEFS: Array<{
  id: string;
  label: string;
  group: string;
  icon: string;
}> = [
  { id: "add-row-above", label: "Insert row above", group: "Rows", icon: "arrow-up-from-line" },
  { id: "add-row-below", label: "Insert row below", group: "Rows", icon: "arrow-down-from-line" },
  { id: "del-row", label: "Delete row", group: "Rows", icon: "butter-delete-row" },
  { id: "add-col-left", label: "Insert column left", group: "Columns", icon: "arrow-left-from-line" },
  { id: "add-col-right", label: "Insert column right", group: "Columns", icon: "arrow-right-from-line" },
  { id: "del-col", label: "Delete column", group: "Columns", icon: "butter-delete-column" },
  { id: "align-left", label: "Align column left", group: "Alignment", icon: "align-left" },
  { id: "align-center", label: "Align column center", group: "Alignment", icon: "align-center" },
  { id: "align-right", label: "Align column right", group: "Alignment", icon: "align-right" },
  { id: "align-cycle", label: "Cycle alignment", group: "Alignment", icon: "align-center" },
  { id: "move-row-up", label: "Move row up", group: "Move", icon: "chevron-up" },
  { id: "move-row-down", label: "Move row down", group: "Move", icon: "chevron-down" },
  { id: "move-col-left", label: "Move column left", group: "Move", icon: "chevron-left" },
  { id: "move-col-right", label: "Move column right", group: "Move", icon: "chevron-right" },
  { id: "sort-asc", label: "Sort column ascending", group: "Sort", icon: "arrow-up-narrow-wide" },
  { id: "sort-desc", label: "Sort column descending", group: "Sort", icon: "arrow-down-wide-narrow" },
  { id: "transpose", label: "Transpose table", group: "Sort", icon: "replace" },
  { id: "del-table", label: "Delete table", group: "Delete", icon: "trash-2" },
];

const ITEMS: Btn[] = [
  { id: "add-row-above", icon: "arrow-up-from-line", label: "Insert row above", run: (v) => addRowBefore(v.state, v.dispatch) },
  { id: "add-row-below", icon: "arrow-down-from-line", label: "Insert row below", run: (v) => addRowAfter(v.state, v.dispatch) },
  // Custom icons (registered in main.ts onload) - row / column
  // shapes with a diagonal strike-through, reading as "this is
  // being deleted" by the same idiom as a struck-out line of text.
  { id: "del-row", icon: "butter-delete-row", label: "Delete row", run: (v) => deleteRow(v.state, v.dispatch) },
  { id: "add-col-left", icon: "arrow-left-from-line", label: "Insert column left", run: (v) => addColumnBefore(v.state, v.dispatch) },
  { id: "add-col-right", icon: "arrow-right-from-line", label: "Insert column right", run: (v) => addColumnAfter(v.state, v.dispatch) },
  { id: "del-col", icon: "butter-delete-column", label: "Delete column", run: (v) => deleteColumn(v.state, v.dispatch) },
  { id: "align-left", icon: "align-left", label: "Align column left", run: (v) => setColumnAlignment(v, "left") },
  { id: "align-center", icon: "align-center", label: "Align column center", run: (v) => setColumnAlignment(v, "center") },
  { id: "align-right", icon: "align-right", label: "Align column right", run: (v) => setColumnAlignment(v, "right") },
  // Mobile-friendly: one button cycles l → c → r. Icon swaps in
  // the render path to reflect the current column's alignment so
  // the user knows what state they're in.
  { id: "align-cycle", icon: "align-center", label: "Cycle alignment", run: (v) => cycleColumnAlignment(v) },
  { id: "move-row-up", icon: "chevron-up", label: "Move row up", run: (v) => moveRow(v, -1) },
  { id: "move-row-down", icon: "chevron-down", label: "Move row down", run: (v) => moveRow(v, 1) },
  { id: "move-col-left", icon: "chevron-left", label: "Move column left", run: (v) => moveColumn(v, -1) },
  { id: "move-col-right", icon: "chevron-right", label: "Move column right", run: (v) => moveColumn(v, 1) },
  // `arrow-up-narrow-wide` / `arrow-down-wide-narrow` are universally
  // bundled in Obsidian's Lucide registry. The newer `arrow-up-a-z`
  // / `arrow-up-z-a` aliases aren't present in older Obsidian builds
  // (including current mobile), so the icons would render empty.
  { id: "sort-asc", icon: "arrow-up-narrow-wide", label: "Sort column ascending", run: (v) => sortByColumn(v, true) },
  { id: "sort-desc", icon: "arrow-down-wide-narrow", label: "Sort column descending", run: (v) => sortByColumn(v, false) },
  { id: "transpose", icon: "replace", label: "Transpose table", run: (v) => transposeTable(v) },
  { id: "del-table", icon: "trash-2", label: "Delete table", run: (v) => runDeleteTable(v) },
];

/** Wrap delete-table with a confirmation modal on mobile. Desktop
 *  keeps the immediate dispatch - Ctrl+Z is one keystroke and the
 *  destructive cost is low when the user can undo at the keyboard.
 *  Mobile lacks that fast-undo affordance and the toolbar's small
 *  hit areas make accidental delete-table taps too likely. */
function runDeleteTable(view: EditorView) {
  if (!Platform.isMobile) {
    deleteTable(view.state, view.dispatch);
    return;
  }
  const app = ((view as unknown as { _butterApp?: App })._butterApp);
  // The view doesn't carry an `app` reference; fall back to the
  // global Obsidian app object Obsidian itself stashes on window
  // for plugin convenience.
  const resolved =
    app ?? ((window as unknown as { app?: App }).app);
  if (!resolved) {
    deleteTable(view.state, view.dispatch);
    return;
  }
  const modal = new (class extends Modal {
    onOpen() {
      this.titleEl.setText("Delete this table?");
      this.contentEl.createDiv({
        cls: "butter-mobile-confirm-message",
        text: "This will remove the entire table. You can undo this with Ctrl+Z.",
      });
      const actions = this.contentEl.createDiv({ cls: "butter-mobile-modal-actions" });
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => this.close());
      const del = actions.createEl("button", {
        cls: "mod-warning",
        text: "Delete",
      });
      del.addEventListener("click", () => {
        this.close();
        deleteTable(view.state, view.dispatch);
        view.focus();
      });
    }
  })(resolved);
  modal.open();
}

const TABLE_BUTTON_REGISTRY = new Map<string, Btn>();
for (const b of ITEMS) TABLE_BUTTON_REGISTRY.set(b.id, b);

/** Build the outer + inner shell once. Items are rendered into the
 *  inner via `renderItems(layout, ...)` and re-rendered on rebuild.
 *  Outer keeps `overflow: hidden` for the slide-in animation;
 *  horizontal scroll happens on the inner. */
function buildShell(): { dom: HTMLElement; inner: HTMLElement } {
  const dom = activeDocument.createElement("div");
  // Class set in the platform branch below - desktop wears
  // `.butter-table-toolbar` (+ `-inner` on the inner row); mobile
  // wears `.butter-mobile-table-toolbar` (+ `.butter-mobile-bar`
  // on the outer, `.mobile-toolbar-options-list` on the inner).
  // Keeping the class names disjoint means desktop CSS rules
  // physically can't leak into the mobile bar.
  dom.setAttribute("role", "toolbar");
  // No `aria-label` here - Obsidian's tooltip system pops on any
  // element carrying aria-label, which made hovering the empty
  // toolbar background show a "Table controls" tooltip the user
  // didn't ask for. Tooltips should fire only on the buttons.
  const inner = activeDocument.createElement("div");
  dom.appendChild(inner);
  return { dom, inner };
}

interface TableRenderCtx {
  getView: () => EditorView | null;
  closePopover: () => void;
  setPopover: (
    popup: HTMLElement,
    anchor: HTMLElement,
    options?: { closeOnLeave?: boolean },
  ) => void;
}

function renderTableButton(
  id: string,
  ctx: TableRenderCtx,
): HTMLElement | null {
  const def = TABLE_BUTTON_REGISTRY.get(id);
  if (!def) return null;
  const isMobile = Platform.isMobile;
  // Mobile: render with the SAME tag + classes as the main mobile
  // toolbar's buttons (`<div class="mobile-toolbar-option clickable-
  // icon">`) so the two bars share one CSS code path and can never
  // visually drift in height, padding, or chrome. Desktop keeps the
  // dedicated `.butter-table-toolbar-btn` chrome.
  const el = isMobile
    ? activeDocument.createElement("div")
    : activeDocument.createElement("button");
  el.className = isMobile
    ? "mobile-toolbar-option clickable-icon"
    : "butter-table-toolbar-btn clickable-icon";
  el.setAttribute("aria-label", def.label);
  el.dataset.btnId = def.id;
  setIcon(el, def.icon);
  el.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.closePopover();
    const view = ctx.getView();
    if (!view) return;
    try {
      def.run(view);
    } catch (err) {
      console.error("[butter-table-toolbar]", def.id, err);
    }
    view.focus();
  });
  return el;
}

function renderTableSubmenu(
  item: Extract<LayoutItem, { type: "submenu" }>,
  ctx: TableRenderCtx,
): HTMLElement {
  const isMobile = Platform.isMobile;
  const el = isMobile
    ? activeDocument.createElement("div")
    : activeDocument.createElement("button");
  el.className = isMobile
    ? "mobile-toolbar-option clickable-icon butter-btn-submenu"
    : "butter-table-toolbar-btn clickable-icon butter-btn-submenu";
  el.setAttribute("aria-label", item.label || "Submenu");
  el.dataset.submenuId = item.id;
  setIcon(el, item.icon || "more-horizontal");
  const dot = activeDocument.createElement("span");
  dot.classList.add("butter-submenu-dot");
  el.appendChild(dot);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.closePopover();
    const popup = activeDocument.createElement("div");
    popup.classList.add("butter-toolbar-submenu-popup");
    for (const child of item.children) {
      const childEl = renderTableItem(child, ctx, /* nested */ true);
      if (childEl) popup.appendChild(childEl);
    }
    if (popup.children.length === 0) {
      const empty = activeDocument.createElement("div");
      empty.classList.add("butter-toolbar-submenu-empty");
      empty.textContent = "Empty";
      popup.appendChild(empty);
    }
    ctx.setPopover(popup, el, { closeOnLeave: true });
  });

  return el;
}

function renderTableItem(
  item: LayoutItem,
  ctx: TableRenderCtx,
  nested = false,
): HTMLElement | null {
  if (item.type === "separator") {
    const d = activeDocument.createElement("div");
    // Mobile reuses the main mobile bar's separator class so the
    // shared `.butter-mobile-bar .mobile-toolbar-separator` rule
    // applies; desktop keeps `.butter-table-toolbar-divider` for
    // its own chrome.
    d.className = Platform.isMobile
      ? "mobile-toolbar-separator"
      : "butter-table-toolbar-divider";
    return d;
  }
  if (item.type === "submenu") {
    if (nested) return null;
    return renderTableSubmenu(item, ctx);
  }
  return renderTableButton(item.id, ctx);
}

// ═══════════════════════════════════════════
//  PM plugin
// ═══════════════════════════════════════════

const toolbarKey = new PluginKey("butter-table-toolbar");

export function tableToolbarPlugin(
  _app: App,
  _schema: Schema,
  // Returns the main formatting toolbar's DOM element. The table
  // toolbar docks itself as a sibling immediately adjacent to the
  // main toolbar (Option B: stacked second layer) rather than
  // floating above the active table. We re-resolve the main toolbar
  // on every show because its parent changes with the user's
  // toolbarStyle / toolbarPosition setting (attached vs detached vs
  // integrated, top vs bottom).
  getMainToolbarDom: () => HTMLElement | null,
  // Returns the user's table toolbar layout. Re-read on every
  // rebuild - settings-tab edits trigger rebuild via a custom
  // method stashed on the dom (see __butterRebuild below).
  getLayout: () => Layout,
  // Mobile-only: visual style for the toolbars ("detached" vs
  // "attached"). Same setting drives the main toolbar - the two
  // toolbars stay in visual lockstep.
  getMobileStyle: () => "detached" | "attached" = () => "attached",
) {
  const isMobile = Platform.isMobile;

  // Mirror the toolbar's hidden state up to its `.butter-view-root` and
  // `.butter-toolbar-stack` ancestors so CSS rules can target the
  // "table toolbar is showing" state without a `:has()` query. Modern
  // Chromium handles :has() fine, but the Obsidian directory's CSS
  // linter flags any :has() use; the class-toggle path is equivalent
  // and lint-clean. Mobile path doesn't need it (mobile rules don't
  // use `:has()`; the toolbar is body-attached and doesn't have these
  // ancestors).
  const setAncestorState = (dom: HTMLElement, visible: boolean) => {
    if (isMobile) return;
    const root = dom.closest(".butter-view-root");
    const stack = dom.closest(".butter-toolbar-stack");
    if (root) root.classList.toggle("butter-has-table-toolbar", visible);
    if (stack) stack.classList.toggle("butter-has-table-toolbar", visible);
  };

  return new PMPlugin({
    key: toolbarKey,
    view(editorView) {
      const { dom, inner } = buildShell();
      dom.classList.add("is-hidden");
      setAncestorState(dom, false);
      if (isMobile) {
        // Mobile: render as a keyboard-accessory bar, body-attached.
        // CSS positions it where the main toolbar sits (above the
        // soft keyboard); the body class `butter-mobile-table-active`
        // hides the main toolbar so this one takes its place.
        //
        // `.butter-mobile-bar` is the shared chrome class - same
        // class is stamped on the main toolbar (see `toolbar.ts`).
        // All sizing / padding / button-geometry / detached vs attached
        // styling lives under that class so the two bars are CSS-
        // identical. Drift between them is structurally impossible
        // because both run through the same selector.
        //
        // The mobile bar deliberately does NOT carry
        // `.butter-table-toolbar` / `.butter-table-toolbar-inner`
        // those classes mark the desktop variant only. Keeping the
        // class namespaces disjoint means desktop chrome rules
        // can't leak into the mobile bar even if they're written
        // without `body:not(.is-mobile)` scoping.
        dom.classList.add("butter-mobile-table-toolbar", "butter-mobile-bar");
        inner.classList.add("mobile-toolbar-options-list");
        const style = getMobileStyle();
        dom.dataset.mobileStyle = style;

        // Re-parent `inner` into the style-appropriate container.
        // Both styles place the chrome (swap-to-main toggle) on
        // the RIGHT - predictable-position policy means toolbar
        // actions never switch sides between bars or states.
        // Both styles also include a close-drawer button in the
        // chrome (drawer-open priority), even though the table bar
        // can't itself open a drawer - keeps the chrome shape
        // identical between main and table bars.
        inner.remove();
        const swap = activeDocument.createElement("button");
        swap.className =
          "mobile-toolbar-option clickable-icon butter-mobile-swap-btn";
        swap.setAttribute("aria-label", "Switch to main toolbar");
        setIcon(swap, "type");
        swap.addEventListener("click", (e) => {
          e.preventDefault();
          activeDocument.body.classList.add("butter-mobile-prefer-main");
        });
        const closeBtn = activeDocument.createElement("button");
        closeBtn.className =
          "mobile-toolbar-option clickable-icon butter-mobile-close-btn";
        closeBtn.setAttribute("aria-label", "Close insert drawer");
        setIcon(closeBtn, "x");
        closeBtn.addEventListener("click", (e) => {
          e.preventDefault();
          closeMobileInsertDrawer();
          window.setTimeout(() => editorView.focus(), 0);
        });

        if (style === "attached") {
          // Solid full-width row: [main list] [right chrome]
          const row = activeDocument.createElement("div");
          row.classList.add("butter-mobile-bar-row");
          inner.classList.add("butter-mobile-bar-list");
          row.appendChild(inner);
          const chrome = activeDocument.createElement("div");
          chrome.classList.add("butter-mobile-bar-chrome");
          chrome.appendChild(swap);
          chrome.appendChild(closeBtn);
          row.appendChild(chrome);
          dom.appendChild(row);
        } else {
          // Native two-pill: [main list pill] [right chrome pill]
          const container = activeDocument.createElement("div");
          container.classList.add("mobile-toolbar-options-container");
          const listWrap = activeDocument.createElement("div");
          listWrap.classList.add("mobile-toolbar-options-list-container");
          listWrap.appendChild(inner);
          container.appendChild(listWrap);
          const rightFloat = activeDocument.createElement("div");
          rightFloat.classList.add(
            "mobile-toolbar-floating-options",
            "butter-mobile-chrome-pill",
          );
          rightFloat.appendChild(swap);
          rightFloat.appendChild(closeBtn);
          container.appendChild(rightFloat);
          dom.appendChild(container);
        }
        // Springy rubber-band overscroll on the inner button list,
        // matching the main bar's behaviour.
        installOverscrollRubberBand(inner);
      } else {
        // Desktop chrome lives on `.butter-table-toolbar` (outer)
        // and `.butter-table-toolbar-inner` (row). All desktop
        // rules in styles.css are body-scoped to `body:not(.is-mobile)`
        // so an accidental mount in a mobile context wouldn't pick
        // up these styles.
        dom.classList.add("butter-table-toolbar");
        inner.classList.add("butter-table-toolbar-inner");
      }
      // Don't blur the editor on toolbar click.
      dom.addEventListener("mousedown", (e) => e.preventDefault());

      let activePopover: HTMLElement | null = null;
      let popoverCleanup: (() => void) | null = null;
      const closePopover = () => {
        if (activePopover) {
          activePopover.remove();
          activePopover = null;
        }
        if (popoverCleanup) {
          popoverCleanup();
          popoverCleanup = null;
        }
      };
      const setPopover = (
        popup: HTMLElement,
        anchor: HTMLElement,
        options: { closeOnLeave?: boolean } = {},
      ) => {
        const rect = anchor.getBoundingClientRect();
        popup.addClass("butter-pos-fixed");
        popup.setCssProps({
          "--butter-pos-top": `${rect.bottom + 6}px`,
          "--butter-pos-left": `${rect.left}px`,
        });
        activeDocument.body.appendChild(popup);
        activePopover = popup;
        const downHandler = (ev: MouseEvent) => {
          if (!popup.contains(ev.target as Node) && ev.target !== anchor) {
            closePopover();
          }
        };
        window.setTimeout(() => activeDocument.addEventListener("mousedown", downHandler), 0);

        let moveHandler: ((ev: MouseEvent) => void) | null = null;
        if (options.closeOnLeave) {
          // Forgiving hit-area: cursor must leave the combined
          // (popup + anchor + 32px buffer) box before close fires.
          // Same UX pattern as the main toolbar's submenu popovers.
          const BUFFER_PX = 32;
          moveHandler = (ev: MouseEvent) => {
            const pRect = popup.getBoundingClientRect();
            const aRect = anchor.getBoundingClientRect();
            const inside =
              ev.clientX >= Math.min(pRect.left, aRect.left) - BUFFER_PX &&
              ev.clientX <= Math.max(pRect.right, aRect.right) + BUFFER_PX &&
              ev.clientY >= Math.min(pRect.top, aRect.top) - BUFFER_PX &&
              ev.clientY <= Math.max(pRect.bottom, aRect.bottom) + BUFFER_PX;
            if (!inside) closePopover();
          };
          window.setTimeout(
            () => activeDocument.addEventListener("mousemove", moveHandler!),
            120,
          );
        }

        popoverCleanup = () => {
          activeDocument.removeEventListener("mousedown", downHandler);
          if (moveHandler) {
            activeDocument.removeEventListener("mousemove", moveHandler);
          }
        };
      };

      const ctx: TableRenderCtx = {
        getView: () => editorView,
        closePopover,
        setPopover,
      };

      const renderItems = () => {
        closePopover();
        inner.innerHTML = "";
        // On mobile the swap-to-main button is rendered ONCE at
        // construction as a sibling pill (see the dual-pill setup
        // above) - renderItems only writes layout buttons into the
        // main pill so settings rebuilds don't have to recreate the
        // swap control.
        for (const item of getLayout()) {
          const el = renderTableItem(item, ctx);
          if (el) inner.appendChild(el);
        }
      };
      renderItems();

      // Stash rebuild on the dom so the plugin's owner (main.ts)
      // can re-render after a settings change without needing a
      // direct reference to this closure.
      (dom as unknown as { __butterRebuild?: () => void }).__butterRebuild = renderItems;

      // Insert the table toolbar adjacent to the main toolbar in
      // its parent. Position depends on toolbarPosition: when the
      // main toolbar is at the TOP of its parent, dock the table
      // toolbar AFTER it (so visual order top→bottom is: main →
      // table → content); when at the BOTTOM, dock BEFORE it
      // (visual order: content → table → main). That keeps the
      // table toolbar always BETWEEN the main toolbar and the
      // content, regardless of which side the main toolbar is on.
      const ensureMounted = () => {
        if (isMobile) {
          // Body-attached, fixed-position via CSS. No relative
          // mounting needed - it lives independently of the main
          // toolbar's parent chain.
          if (dom.parentElement !== activeDocument.body) {
            activeDocument.body.appendChild(dom);
          }
          return true;
        }
        const main = getMainToolbarDom();
        if (!main || !main.parentElement) return false;
        const parent = main.parentElement;
        // Detect main toolbar's relative position. `data-toolbar-pos`
        // is the authoritative attribute (set by applyToolbarPosition).
        // Fall back to sibling position if the attr is missing.
        const pos = main.getAttribute("data-toolbar-pos");
        const wantBefore =
          pos === "bottom" ||
          (pos === null && main.previousElementSibling != null && main.nextElementSibling == null);
        if (wantBefore) {
          // Main is at the bottom - table toolbar goes BEFORE it.
          if (dom.parentElement !== parent || dom.nextElementSibling !== main) {
            parent.insertBefore(dom, main);
          }
        } else {
          // Main is at the top - table toolbar goes AFTER it.
          if (dom.parentElement !== parent || dom.previousElementSibling !== main) {
            parent.insertBefore(dom, main.nextSibling);
          }
        }
        // Mirror the main toolbar's pos/style on the table toolbar
        // for CSS-level styling parity (chrome row vs detached card,
        // top vs bottom border treatment, etc).
        const style = main.getAttribute("data-toolbar-style");
        if (pos) dom.setAttribute("data-toolbar-pos", pos);
        if (style) dom.setAttribute("data-toolbar-style", style);
        return true;
      };

      const refresh = () => {
        if (isMobile) dom.dataset.mobileStyle = getMobileStyle();
        const ctx = findTableContext(editorView.state);
        if (!ctx) {
          dom.classList.add("is-hidden");
          setAncestorState(dom, false);
          if (isMobile) {
            // Caret left the table - clear both the active flag
            // AND the user's manual prefer-main override so the
            // next cell-entry swaps fresh.
            activeDocument.body.classList.remove("butter-mobile-table-active");
            activeDocument.body.classList.remove("butter-mobile-prefer-main");
          }
          return;
        }
        if (!ensureMounted()) {
          dom.classList.add("is-hidden");
          setAncestorState(dom, false);
          if (isMobile) {
            activeDocument.body.classList.remove("butter-mobile-table-active");
            activeDocument.body.classList.remove("butter-mobile-prefer-main");
          }
          return;
        }
        dom.classList.remove("is-hidden");
        setAncestorState(dom, true);
        if (isMobile) activeDocument.body.classList.add("butter-mobile-table-active");
      };

      refresh();

      return {
        update: (v, prevState) => {
          if (
            v.state.selection.eq(prevState.selection) &&
            v.state.doc.eq(prevState.doc)
          )
            return;
          refresh();
        },
        destroy: () => {
          // Tear down any open color-picker popover BEFORE removing
          // the host so its document mousedown/mousemove listeners
          // get unbound. Otherwise they leak past view close and fire
          // on every body click for the rest of the session.
          closePopover();
          setAncestorState(dom, false);
          dom.remove();
          if (isMobile) {
            activeDocument.body.classList.remove("butter-mobile-table-active");
            activeDocument.body.classList.remove("butter-mobile-prefer-main");
          }
        },
      };
    },
  });
}
