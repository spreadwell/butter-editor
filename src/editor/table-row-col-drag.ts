/**
 * Row / column drag handles for tables (LP-style).
 *
 * When the cursor lands inside a table cell, this plugin renders a
 * row of small grip widgets in the gutters around the table:
 *
 *   • A row handle at the LEFT edge of each row, vertically centered
 *     on the row. Drag it up/down to reorder rows.
 *   • A column handle at the TOP edge of each column, horizontally
 *     centered on the column. Drag it left/right to reorder columns.
 *
 * The handles are absolute-positioned in a shared layer that lives
 * as a sibling of the editor's content. They re-render on selection
 * change, document change, and viewport scroll. Hover-revealed: the
 * layer's pointer-events are off until the pointer enters the table
 * area, at which point the handles light up and become interactive.
 *
 * Drag engine:
 *   1. pointerdown on a handle stores `srcIdx` + `axis` (row vs col)
 *      and arms drag mode (waits for a >4px move before committing
 *      to a drag - leaves room for click-to-select-row, future).
 *   2. pointermove updates the `dstIdx` derived from the pointer's
 *      position relative to the rest of the table's row/col rects,
 *      and slides a single drop indicator (a thin accent strip)
 *      between the rows/cols at the target.
 *   3. pointerup commits a `replaceWith` transaction that rebuilds
 *      the table with the row / column moved to its new position.
 *
 * Limitations:
 *   • Skips operation when ANY cell in the table has rowspan>1 or
 *     colspan>1 - reordering merged cells is non-trivial and the
 *     existing toolbar's `moveRow` / `moveColumn` already bail in
 *     the same case. UI: handles still appear, but commit is a
 *     no-op with a Notice.
 *   • Handles render only for the table the user's selection is
 *     CURRENTLY in. Other tables in the doc don't get gutter
 *     widgets - same UX scope as block-level drag handles.
 */
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  type Node as PMNode,
} from "prosemirror-model";
import { TableMap, CellSelection } from "prosemirror-tables";
import { Notice } from "obsidian";
import { debug } from "../integration/debug";
import {
  applyColumnMove,
  applyRowMove,
} from "./table-reorder";

// Re-export the pure helpers for any external callers that imported
// them from this module before the split.
export { applyColumnMove, applyRowMove };

const key = new PluginKey("butter-table-row-col-drag");

interface TableContext {
  table: PMNode;
  tablePos: number;
  tableDOM: HTMLElement;
  map: TableMap;
}

function findActiveTable(view: EditorView): TableContext | null {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.spec.tableRole === "table") {
      const tablePos = $from.before(d);
      const dom = view.nodeDOM(tablePos) as HTMLElement | null;
      if (!dom) return null;
      // The PM-side nodeDOM is the wrapper PM creates around the
      // <table>. Walk down to the actual <table>.
      const tableEl =
        dom.tagName === "TABLE"
          ? (dom as HTMLTableElement)
          : (dom.querySelector("table"));
      if (!tableEl) return null;
      return {
        table: node,
        tablePos,
        tableDOM: tableEl,
        map: TableMap.get(node),
      };
    }
  }
  return null;
}

// True when no cell in the table has rowspan>1 or colspan>1. We bail
// on spans because reorder operations on merged cells require fixing
// up adjacent rows/cols and that's out of scope for v1.
function tableHasNoSpans(table: PMNode): boolean {
  let ok = true;
  table.forEach((row) => {
    row.forEach((cell) => {
      const a = cell.attrs as { colspan?: number; rowspan?: number };
      if ((a.colspan ?? 1) !== 1 || (a.rowspan ?? 1) !== 1) ok = false;
    });
  });
  return ok;
}

// ── Reorder commands ──────────────────────────────────────────

// Place the cursor inside cell (row, col) of the table that lives
// at `tablePos` in `tr.doc`. Used after a row/col move to keep the
// selection inside the table (so the table toolbar stays open and
// the user doesn't have to re-find their place).
function setSelectionInCell(
  tr: Transaction,
  tablePos: number,
  rowIdx: number,
  colIdx: number,
) {
  const newTable = tr.doc.nodeAt(tablePos);
  if (!newTable || newTable.type.spec.tableRole !== "table") return;
  const map = TableMap.get(newTable);
  const safeRow = Math.max(0, Math.min(rowIdx, map.height - 1));
  const safeCol = Math.max(0, Math.min(colIdx, map.width - 1));
  const cellOffset = map.map[safeRow * map.width + safeCol];
  if (cellOffset === undefined) return;
  const cellPos = tablePos + 1 + cellOffset;
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)));
  } catch {
    /* selection couldn't resolve into the cell - leave PM's
       default mapping. */
  }
}

function moveRowToIndex(
  view: EditorView,
  ctx: TableContext,
  srcIdx: number,
  dstIdx: number,
) {
  // Drop slot at `srcIdx` (above source) or `srcIdx + 1` (below
  // source) is a natural no-op - the row stays exactly where it is.
  // Skip the dispatch entirely so we don't churn a no-op transaction
  // through the save pipeline.
  if (dstIdx === srcIdx || dstIdx === srcIdx + 1) return;
  // Cell-type re-tag is non-optional here (without it the GFM
  // serializer emits bytes that re-parse with cell types matching the
  // new row positions, the save-guard fingerprint diverges, save is
  // blocked).
  const normalized = applyRowMove(ctx.table, view.state.schema, srcIdx, dstIdx);
  if (!normalized) return;
  const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
  const tr = view.state.tr.replaceWith(
    ctx.tablePos,
    ctx.tablePos + ctx.table.nodeSize,
    normalized,
  );
  // Re-place the cursor inside the moved row's first cell so the
  // table toolbar stays anchored - PM's mapping sometimes lands the
  // selection outside the table after a wholesale table replaceWith.
  setSelectionInCell(tr, ctx.tablePos, insertAt, 0);
  view.dispatch(tr.scrollIntoView());
}

function moveColumnToIndex(
  view: EditorView,
  ctx: TableContext,
  srcIdx: number,
  dstIdx: number,
) {
  // Drop slot at `srcIdx` or `srcIdx + 1` = no-op (column stays put).
  if (dstIdx === srcIdx || dstIdx === srcIdx + 1) return;
  const newTable = applyColumnMove(ctx.table, srcIdx, dstIdx);
  if (!newTable) return;
  const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
  const tr = view.state.tr.replaceWith(
    ctx.tablePos,
    ctx.tablePos + ctx.table.nodeSize,
    newTable,
  );
  setSelectionInCell(tr, ctx.tablePos, 0, insertAt);
  view.dispatch(tr.scrollIntoView());
}

// ── DOM helpers ───────────────────────────────────────────────

// Handle size + position: centered ON the table's outer edge line.
// Half the handle sits outside the table, half overlaps the cell's
// inner padding (cells default to 6-8px padding, so the dots sit
// in the padding zone, never overlapping cell text). Sized to give
// the dots room to breathe - three 3px dots with 4px gaps along the
// drag axis = 17px of grip span centered in an 18px handle.
const HANDLE_SIZE = 18;

function makeGripDot(): HTMLElement {
  // Six tiny dots arranged 2×3 - same visual vocabulary as the
  // block drag handle's grip-dots icon.
  const dot = activeDocument.createElement("span");
  dot.className = "butter-table-handle-dots";
  for (let i = 0; i < 6; i++) {
    const d = activeDocument.createElement("span");
    d.className = "butter-table-handle-dot";
    dot.appendChild(d);
  }
  return dot;
}

// Compact text snapshot of a row's cell contents - used in verbose
// drag logs so the user can correlate "row 2" with the actual data
// they were trying to move ("['cat', 'dog', 'bird']").
function snapshotRow(tr: HTMLElement | undefined): string {
  if (!tr) return "<missing>";
  const cells = Array.from(tr.children) as HTMLElement[];
  return JSON.stringify(
    cells.map((c) => (c.textContent ?? "").trim().slice(0, 24)),
  );
}

function snapshotColumn(
  tableDOM: HTMLElement,
  colIdx: number,
): string {
  const rows = Array.from(tableDOM.querySelectorAll("tr"));
  return JSON.stringify(
    rows.map((row) => {
      const cell = (row.children[colIdx] as HTMLElement | undefined);
      return cell ? (cell.textContent ?? "").trim().slice(0, 24) : "<n/a>";
    }),
  );
}

function makeHandle(axis: "row" | "col", idx: number): HTMLElement {
  // <div> instead of <button> - keeps Obsidian's `button` style
  // cascade (hover background, focus ring, padding, font, etc.) from
  // bleeding through and giving the handle a "bubble" around the
  // dots. We're not relying on native button keyboard behavior here
  // (the drag is pointer-driven, click is handled in the JS), so the
  // accessibility cost of dropping the button element is small
  // role / aria-label / tabindex preserve the rest.
  const h = activeDocument.createElement("div");
  h.className = `butter-table-${axis}-handle`;
  h.dataset.axis = axis;
  h.dataset.idx = String(idx);
  h.setAttribute("role", "button");
  h.setAttribute("tabindex", "-1");
  h.setAttribute(
    "aria-label",
    axis === "row" ? `Drag row ${idx + 1}` : `Drag column ${idx + 1}`,
  );
  h.title = h.getAttribute("aria-label")!;
  h.appendChild(makeGripDot());
  return h;
}

// ── Plugin ────────────────────────────────────────────────────

export function tableRowColDragPlugin() {
  return new Plugin({
    key,
    view(editorView) {
      const host = editorView.dom.parentElement;
      if (!host) return { destroy() {} };

      // Ensure host has a positioning context so handles' absolute
      // coordinates are relative to it. Inline `position: relative`
      // instead of a class — class was getting dropped (probably by
      // Obsidian rebuilding the host element across some lifecycle
      // event), leaving handles positioned against whatever ancestor
      // happened to be positioned (the editor-view scroller). That
      // miscalibrated handle Y by the entire scroll-content height
      // so they rendered far below the viewport.
      const positionRelative = "relative";
      host.style.position = positionRelative;

      // Layer that holds all handles + the drop indicator. Sits
      // ABOVE editor content (z-index) but with pointer-events: none
      // by default - children individually re-enable pointer-events
      // so they can be clicked / dragged.
      const layer = activeDocument.createElement("div");
      layer.className = "butter-table-handles-layer";
      host.appendChild(layer);

      // Reusable drop indicator (rendered only during a drag).
      const dropIndicator = activeDocument.createElement("div");
      dropIndicator.className = "butter-table-drop-indicator";
      layer.appendChild(dropIndicator);

      // ── State ────────────────────────────────────────────
      let activeCtx: TableContext | null = null;
      let dragArmed: {
        axis: "row" | "col";
        srcIdx: number;
        startX: number;
        startY: number;
        pointerId: number;
      } | null = null;
      let dragLive: {
        axis: "row" | "col";
        srcIdx: number;
        ctx: TableContext;
      } | null = null;
      let lastDstIdx: number | null = null;

      // Drag-time geometry cache. Layout doesn't change during a
      // drag (source row/column stays in place, just dimmed), so we
      // can capture every rect we need ONCE at drag-start and reuse
      // them for every pointermove. Without this, each move forced a
      // synchronous reflow (`dimSource` mutates classList → BCR read
      // in computeDstFromPointer triggers layout flush → 30-70ms
      // stalls, visible as drag lag). Refreshed on scroll / resize.
      let dragCache: {
        rowRects: DOMRect[];
        colRects: DOMRect[];
        tableRect: DOMRect;
        hostRect: DOMRect;
      } | null = null;
      const refreshDragCache = () => {
        if (!activeCtx) {
          dragCache = null;
          return;
        }
        const tableDOM = activeCtx.tableDOM;
        const rows = Array.from(
          tableDOM.querySelectorAll("tr"),
        ) as HTMLElement[];
        const rowRects = rows.map((r) => r.getBoundingClientRect());
        let colRects: DOMRect[] = [];
        const firstRow = rows[0];
        if (firstRow) {
          const cells = Array.from(firstRow.children) as HTMLElement[];
          colRects = cells.map((c) => c.getBoundingClientRect());
        }
        dragCache = {
          rowRects,
          colRects,
          tableRect: tableDOM.getBoundingClientRect(),
          hostRect: host.getBoundingClientRect(),
        };
      };

      // ── Render handles for the active table ──────────────
      const clearHandles = () => {
        // Keep the drop indicator; remove only handle nodes.
        const oldHandles = layer.querySelectorAll(
          ".butter-table-row-handle, .butter-table-col-handle",
        );
        oldHandles.forEach((h) => h.remove());
      };

      const renderHandles = () => {
        clearHandles();
        if (!activeCtx) return;
        const { tableDOM, map } = activeCtx;
        const hostRect = host.getBoundingClientRect();
        const tableRect = tableDOM.getBoundingClientRect();

        // Walk the actual <tr> and cell DOM rather than the schema
        // map - keeps coordinates in sync with whatever colspan /
        // rowspan layout the browser has already resolved.
        const rows = Array.from(tableDOM.querySelectorAll("tr"));
        rows.forEach((tr, rowIdx) => {
          const r = tr.getBoundingClientRect();
          const h = makeHandle("row", rowIdx);
          // Center the handle ON the table's left edge line.
          h.style.left = `${tableRect.left - hostRect.left - HANDLE_SIZE / 2}px`;
          h.style.top = `${r.top - hostRect.top + (r.height - HANDLE_SIZE) / 2}px`;
          layer.appendChild(h);
        });

        const firstRow = rows[0];
        if (firstRow) {
          const cells = Array.from(firstRow.querySelectorAll("th, td"));
          cells.forEach((cell, colIdx) => {
            // colIdx here is per-row; respect map.width as the
            // canonical column count (in case of edge cases).
            if (colIdx >= map.width) return;
            const c = (cell as HTMLElement).getBoundingClientRect();
            const h = makeHandle("col", colIdx);
            h.style.left = `${c.left - hostRect.left + (c.width - HANDLE_SIZE) / 2}px`;
            // Center the handle ON the table's top edge line.
            h.style.top = `${tableRect.top - hostRect.top - HANDLE_SIZE / 2}px`;
            layer.appendChild(h);
          });
        }
      };

      // Tag handles as `is-active` based on the editor's selection.
      // Row handle for row R is active iff:
      //   - TextSelection's caret is in any cell of row R, OR
      //   - CellSelection covers any cell in row R.
      // Same for column handles. Special-cases row-only / col-only
      // CellSelection so a `rowSelection` doesn't flood every column
      // handle (and vice versa).
      const applyActiveStates = () => {
        if (!activeCtx) return;
        const { selection } = editorView.state;
        const map = activeCtx.map;
        const tablePosBase = activeCtx.tablePos + 1;
        const activeRows = new Set<number>();
        const activeCols = new Set<number>();

        const rowOf = (offset: number): number => {
          const i = map.map.indexOf(offset);
          return i >= 0 ? Math.floor(i / map.width) : -1;
        };
        const colOf = (offset: number): number => {
          const i = map.map.indexOf(offset);
          return i >= 0 ? i % map.width : -1;
        };

        if (selection instanceof CellSelection) {
          if (selection.isRowSelection()) {
            const a = rowOf(selection.$anchorCell.pos - tablePosBase);
            const h = rowOf(selection.$headCell.pos - tablePosBase);
            if (a >= 0 && h >= 0) {
              for (let r = Math.min(a, h); r <= Math.max(a, h); r++) {
                activeRows.add(r);
              }
            }
          } else if (selection.isColSelection()) {
            const a = colOf(selection.$anchorCell.pos - tablePosBase);
            const h = colOf(selection.$headCell.pos - tablePosBase);
            if (a >= 0 && h >= 0) {
              for (let c = Math.min(a, h); c <= Math.max(a, h); c++) {
                activeCols.add(c);
              }
            }
          } else {
            // Rectangular CellSelection - both axes light up for the
            // rows / cols any selected cell sits in.
            selection.forEachCell((_n, pos) => {
              const offset = pos - tablePosBase;
              const i = map.map.indexOf(offset);
              if (i >= 0) {
                activeRows.add(Math.floor(i / map.width));
                activeCols.add(i % map.width);
              }
            });
          }
        } else if (selection instanceof TextSelection) {
          const { $from } = selection;
          let cellPos = -1;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (
              node.type.spec.tableRole === "cell" ||
              node.type.spec.tableRole === "header_cell"
            ) {
              cellPos = $from.before(d);
              break;
            }
          }
          if (cellPos >= 0) {
            const offset = cellPos - tablePosBase;
            const i = map.map.indexOf(offset);
            if (i >= 0) {
              activeRows.add(Math.floor(i / map.width));
              activeCols.add(i % map.width);
            }
          }
        }

        layer.querySelectorAll(".butter-table-row-handle").forEach((el) => {
          const idx = parseInt((el as HTMLElement).dataset.idx ?? "-1", 10);
          el.classList.toggle("is-active", activeRows.has(idx));
        });
        layer.querySelectorAll(".butter-table-col-handle").forEach((el) => {
          const idx = parseInt((el as HTMLElement).dataset.idx ?? "-1", 10);
          el.classList.toggle("is-active", activeCols.has(idx));
        });
      };

      const refresh = () => {
        const ctx = findActiveTable(editorView);
        if (!ctx) {
          activeCtx = null;
          clearHandles();
          dropIndicator.removeClass("butter-drop-indicator-row");
          dropIndicator.removeClass("butter-drop-indicator-col");
          layer.classList.remove("is-active");
          return;
        }
        activeCtx = ctx;
        layer.classList.add("is-active");
        renderHandles();
        applyActiveStates();
      };

      // ── Drag flow ─────────────────────────────────────────

      // Static-layout DOM gathering - the source row/column stays in
      // place during the drag (just dimmed), so we measure ALL rows /
      // cells. The drop slot is in [0, N] (N+1 boundaries for an
      // N-cell axis), and the indicator can sit at any cell edge
      // including immediately to the left or right of the source,
      // which the move logic naturally treats as a no-op.
      const allRowEls = (tableDOM: HTMLElement): HTMLElement[] =>
        Array.from(tableDOM.querySelectorAll("tr"));
      const allColEls = (tableDOM: HTMLElement): HTMLElement[] => {
        const firstRow = tableDOM.querySelector("tr") as HTMLElement | null;
        if (!firstRow) return [];
        return Array.from(firstRow.children) as HTMLElement[];
      };

      const computeDstFromPointer = (
        e: PointerEvent,
        axis: "row" | "col",
      ): number | null => {
        // Use the drag-start geometry cache rather than reading BCR
        // every move - table layout doesn't change during the drag,
        // so cached rects are accurate and we avoid forced reflow.
        if (!dragCache) return null;
        const rects = axis === "row" ? dragCache.rowRects : dragCache.colRects;
        if (!rects.length) return null;
        if (axis === "row") {
          for (let i = 0; i < rects.length; i++) {
            const mid = rects[i].top + rects[i].height / 2;
            if (e.clientY < mid) return i;
          }
        } else {
          for (let i = 0; i < rects.length; i++) {
            const mid = rects[i].left + rects[i].width / 2;
            if (e.clientX < mid) return i;
          }
        }
        return rects.length;
      };

      const showDropIndicator = (
        axis: "row" | "col",
        dstIdx: number,
      ) => {
        if (!dragCache) return;
        const { rowRects, colRects, tableRect, hostRect } = dragCache;
        dropIndicator.dataset.axis = axis;
        if (axis === "row") {
          if (!rowRects.length) return;
          const y = dstIdx >= rowRects.length
            ? rowRects[rowRects.length - 1].bottom
            : rowRects[dstIdx].top;
          dropIndicator.removeClass("butter-drop-indicator-col");
          dropIndicator.addClass("butter-drop-indicator-row");
          dropIndicator.setCssProps({
            "--butter-pos-left": `${tableRect.left - hostRect.left - 4}px`,
            "--butter-pos-top": `${y - hostRect.top - 1}px`,
            "--butter-pos-width": `${tableRect.width + 8}px`,
          });
        } else {
          if (!colRects.length) return;
          const x = dstIdx >= colRects.length
            ? colRects[colRects.length - 1].right
            : colRects[dstIdx].left;
          dropIndicator.removeClass("butter-drop-indicator-row");
          dropIndicator.addClass("butter-drop-indicator-col");
          dropIndicator.setCssProps({
            "--butter-pos-left": `${x - hostRect.left - 1}px`,
            "--butter-pos-top": `${tableRect.top - hostRect.top - 4}px`,
            "--butter-pos-height": `${tableRect.height + 8}px`,
          });
        }
      };

      const hideDropIndicator = () => {
        dropIndicator.removeClass("butter-drop-indicator-row");
        dropIndicator.removeClass("butter-drop-indicator-col");
      };

      const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const handle = target.closest<HTMLElement>(
          ".butter-table-row-handle, .butter-table-col-handle",
        );
        if (!handle) return;
        e.preventDefault();
        e.stopPropagation();
        const axis = handle.dataset.axis as "row" | "col";
        const srcIdx = parseInt(handle.dataset.idx ?? "0", 10);
        // Capture the source row/column's top-left so the ghost
        // appears anchored exactly to where the source was at drag
        // start. After that the ghost translates by (cursor delta)
        // - the ghost stays anchored to the cursor in a natural way.
        if (activeCtx) {
          const tableDOM = activeCtx.tableDOM;
          if (axis === "row") {
            const rows = Array.from(tableDOM.querySelectorAll("tr"));
            const tr = rows[srcIdx] as HTMLElement | undefined;
            if (tr) {
              const r = tr.getBoundingClientRect();
              grabOffsetX = e.clientX - r.left;
              grabOffsetY = e.clientY - r.top;
            }
          } else {
            const firstRow = tableDOM.querySelector("tr");
            if (firstRow) {
              const cells = Array.from(firstRow.children) as HTMLElement[];
              const cell = cells[srcIdx];
              if (cell) {
                const c = cell.getBoundingClientRect();
                // Ghost top-left = first row's top, source col's left.
                const allCells = Array.from(
                  tableDOM.querySelectorAll(`tr > :nth-child(${srcIdx + 1})`),
                );
                const top = Math.min(
                  ...allCells.map((el) => el.getBoundingClientRect().top),
                );
                grabOffsetX = e.clientX - c.left;
                grabOffsetY = e.clientY - top;
              }
            }
          }
        }
        dragArmed = {
          axis,
          srcIdx,
          startX: e.clientX,
          startY: e.clientY,
          pointerId: e.pointerId,
        };
        debug("table-drag", `pointerdown axis=${axis} srcIdx=${srcIdx}`);
        handle.classList.add("is-pressed");
        window.addEventListener("pointermove", onArmMove);
        window.addEventListener("pointerup", onArmUp);
      };

      const onArmMove = (e: PointerEvent) => {
        if (!dragArmed) return;
        const dx = Math.abs(e.clientX - dragArmed.startX);
        const dy = Math.abs(e.clientY - dragArmed.startY);
        if (dx < 4 && dy < 4) return;
        // Promote to live drag.
        if (!activeCtx) {
          dragArmed = null;
          window.removeEventListener("pointermove", onArmMove);
          window.removeEventListener("pointerup", onArmUp);
          return;
        }
        if (!tableHasNoSpans(activeCtx.table)) {
          new Notice("Reorder is unavailable on tables with merged cells.");
          dragArmed = null;
          window.removeEventListener("pointermove", onArmMove);
          window.removeEventListener("pointerup", onArmUp);
          return;
        }
        dragLive = {
          axis: dragArmed.axis,
          srcIdx: dragArmed.srcIdx,
          ctx: activeCtx,
        };
        activeDocument.body.classList.add("butter-table-drag-active");
        layer.classList.add("is-dragging");
        // Pin the layer visible during drag - proximity test would
        // otherwise toggle handles off when the pointer drifts past
        // the table.
        layer.classList.add("is-cursor-near");

        // Build the floating ghost BEFORE hiding the source so the
        // clone captures the source's currently-rendered geometry
        // (cell widths / heights). Then hide the source - the table
        // compresses naturally as the browser reflows around the
        // missing row/column. Drop-target detection runs against the
        // compressed table, then maps the visible-list index back to
        // the original index for the PM commit.
        if (dragArmed.axis === "row") {
          const rows = Array.from(activeCtx.tableDOM.querySelectorAll("tr"));
          const sourceTr = rows[dragArmed.srcIdx] as HTMLElement | undefined;
          if (sourceTr) {
            dragGhost = buildRowGhost(sourceTr);
            activeDocument.body.appendChild(dragGhost);
          }
        } else {
          dragGhost = buildColGhost(activeCtx.tableDOM, dragArmed.srcIdx);
          activeDocument.body.appendChild(dragGhost);
        }
        dimSource(dragArmed.axis, dragArmed.srcIdx);
        updateGhostPosition(e);
        // Capture drag geometry once; reused for every pointermove.
        refreshDragCache();

        if (dragArmed.axis === "row") {
          const rows = Array.from(activeCtx.tableDOM.querySelectorAll("tr"));
          debug(
            "table-drag",
            `live row drag srcIdx=${dragArmed.srcIdx} totalRows=${rows.length} ` +
              `srcRow=${snapshotRow(rows[dragArmed.srcIdx])}`,
          );
        } else {
          const firstRow = activeCtx.tableDOM.querySelector("tr") as HTMLElement | null;
          const colCount = firstRow ? firstRow.children.length : 0;
          debug(
            "table-drag",
            `live col drag srcIdx=${dragArmed.srcIdx} totalCols=${colCount} ` +
              `srcCol=${snapshotColumn(activeCtx.tableDOM, dragArmed.srcIdx)}`,
          );
        }

        window.removeEventListener("pointermove", onArmMove);
        window.removeEventListener("pointerup", onArmUp);
        window.addEventListener("pointermove", onLiveMove);
        window.addEventListener("pointerup", onLiveUp);
        // Mobile: Obsidian's left/right-edge swipe-to-open-sidebar
        // gesture is JS-driven (touch listener at the document level),
        // so `touch-action: none` doesn't reach it. We install a
        // capture-phase touchmove swallower on window that fires
        // before Obsidian's listener and calls `stopImmediatePropag-
        // ation` - the gesture detector never sees the event so the
        // sidebar can't slide open mid table-drag. Removed in liveUp.
        window.addEventListener("touchmove", swallowSidebarSwipe, { capture: true, passive: false });
        window.addEventListener("touchstart", swallowSidebarSwipe, { capture: true, passive: false });
        // Update once for the initial pointer position.
        onLiveMove(e);
      };

      const swallowSidebarSwipe = (e: TouchEvent) => {
        e.stopImmediatePropagation();
      };

      const onLiveMove = (e: PointerEvent) => {
        if (!dragLive) return;
        updateGhostPosition(e);
        const dst = computeDstFromPointer(e, dragLive.axis);
        if (dst == null) return;
        // Only log on dst transitions - every-pointermove logs would
        // flood the console while still giving the user nothing they
        // can't see in the indicator's position.
        if (dst !== lastDstIdx) {
          if (dragLive.axis === "row") {
            const rows = allRowEls(activeCtx?.tableDOM ?? activeDocument.createElement("div"));
            const isNoOp = dst === dragLive.srcIdx || dst === dragLive.srcIdx + 1;
            const targetSnap = dst < rows.length
              ? snapshotRow(rows[dst])
              : "<after-last>";
            debug(
              "table-drag",
              `move axis=row dst=${dst} (totalRows=${rows.length}) ` +
                `target=${targetSnap}${isNoOp ? " [no-op slot]" : ""}`,
            );
          } else if (activeCtx) {
            const cells = allColEls(activeCtx.tableDOM);
            const isNoOp = dst === dragLive.srcIdx || dst === dragLive.srcIdx + 1;
            const targetSnap = dst < cells.length
              ? `"${(cells[dst].textContent ?? "").trim().slice(0, 24)}"`
              : "<after-last>";
            debug(
              "table-drag",
              `move axis=col dst=${dst} (totalCols=${cells.length}) ` +
                `target=${targetSnap}${isNoOp ? " [no-op slot]" : ""}`,
            );
          }
        }
        lastDstIdx = dst;
        showDropIndicator(dragLive.axis, dst);
      };

      const onLiveUp = (_e: PointerEvent) => {
        const live = dragLive;
        const dropDst = lastDstIdx;
        dragLive = null;
        dragArmed = null;
        lastDstIdx = null;
        activeDocument.body.classList.remove("butter-table-drag-active");
        layer.classList.remove("is-dragging");
        // Tear down the ghost and undim the source. The dispatched
        // transaction below (if any) will rebuild the doc with the
        // moved row/column at its new index.
        if (dragGhost) {
          dragGhost.remove();
          dragGhost = null;
        }
        undimSource();
        hideDropIndicator();
        dragCache = null;
        layer
          .querySelectorAll(".is-pressed")
          .forEach((el) => el.classList.remove("is-pressed"));
        window.removeEventListener("pointermove", onLiveMove);
        window.removeEventListener("pointerup", onLiveUp);
        window.removeEventListener("touchmove", swallowSidebarSwipe, { capture: true });
        window.removeEventListener("touchstart", swallowSidebarSwipe, { capture: true });
        if (!live || dropDst == null) return;
        // `dropDst` is in [0, N] - N+1 boundaries on an N-cell axis.
        // Drop at `srcIdx` (left/top of source) or `srcIdx + 1` (right/
        // bottom of source) is a natural no-op: the row/column stays
        // exactly where it is. The pure move functions short-circuit
        // both cases so we don't dispatch a redundant transaction.
        if (live.axis === "row") {
          const rows = Array.from(live.ctx.tableDOM.querySelectorAll("tr"));
          debug(
            "table-drag",
            `drop axis=row srcIdx=${live.srcIdx} dst=${dropDst} ` +
              `srcRow=${snapshotRow(rows[live.srcIdx])} ` +
              `landAfter=${snapshotRow(rows[dropDst - 1])} ` +
              `landBefore=${snapshotRow(rows[dropDst])}`,
          );
          moveRowToIndex(editorView, live.ctx, live.srcIdx, dropDst);
        } else {
          debug(
            "table-drag",
            `drop axis=col srcIdx=${live.srcIdx} dst=${dropDst} ` +
              `srcCol=${snapshotColumn(live.ctx.tableDOM, live.srcIdx)}`,
          );
          moveColumnToIndex(editorView, live.ctx, live.srcIdx, dropDst);
        }
        // refresh fires automatically on the dispatched transaction.
      };

      const onArmUp = () => {
        // Released without enough movement → treat as a click on the
        // handle. Select the entire row / column it belongs to via a
        // CellSelection (covers all cells in that axis), so the user
        // can immediately apply Cut / Copy / Delete / formatting to
        // the whole row or column.
        if (dragArmed && activeCtx) {
          const { axis, srcIdx } = dragArmed;
          const map = activeCtx.map;
          // Pick any cell in the target row (axis=row) or column
          // (axis=col) - `CellSelection.row/colSelection` expands
          // from there to cover the full row/column.
          const cellOffset = axis === "row"
            ? map.map[srcIdx * map.width + 0]
            : map.map[0 * map.width + srcIdx];
          if (cellOffset !== undefined) {
            const cellPos = activeCtx.tablePos + 1 + cellOffset;
            try {
              const $cell = editorView.state.doc.resolve(cellPos);
              const sel = axis === "row"
                ? CellSelection.rowSelection($cell)
                : CellSelection.colSelection($cell);
              const tr = editorView.state.tr.setSelection(sel);
              editorView.dispatch(tr);
            } catch {
              /* fall through silently - selection couldn't resolve */
            }
          }
        }
        if (dragArmed) {
          layer
            .querySelectorAll(".is-pressed")
            .forEach((el) => el.classList.remove("is-pressed"));
          dragArmed = null;
        }
        window.removeEventListener("pointermove", onArmMove);
        window.removeEventListener("pointerup", onArmUp);
      };

      layer.addEventListener("pointerdown", onPointerDown);

      // No proximity / per-row tracking. Each handle is invisible by
      // default and reveals only on its own `:hover`. The handle's
      // 10×10 hit zone sits centered on the table's edge line, so
      // sweeping along the edge naturally hits each row's / column's
      // handle one at a time.

      // ── Source dim / ghost build (Notion-style lift-and-drop) ──
      //
      // Source row / column stays in the layout during the drag
      // just dimmed via the `butter-table-drag-source` class - so
      // the user keeps a stable visual reference of the table's
      // shape. A floating clone (built before any DOM mutation, so
      // it captures the source's rendered geometry) tracks the
      // cursor, and the drop indicator can sit at any cell edge
      // including immediately to the left or right of the source,
      // both of which the move logic treats as a no-op (the row /
      // column "stays where it is").
      const dimmedEls: HTMLElement[] = [];
      let dragGhost: HTMLElement | null = null;
      let grabOffsetX = 0;
      let grabOffsetY = 0;

      const dimSource = (axis: "row" | "col", srcIdx: number) => {
        undimSource();
        if (!activeCtx) return;
        const tableDOM = activeCtx.tableDOM;
        if (axis === "row") {
          const rows = Array.from(tableDOM.querySelectorAll("tr"));
          const tr = rows[srcIdx] as HTMLElement | undefined;
          if (tr) {
            tr.classList.add("butter-table-drag-source");
            dimmedEls.push(tr);
          }
        } else {
          const rows = Array.from(tableDOM.querySelectorAll("tr"));
          for (const row of rows) {
            const cells = Array.from(row.children) as HTMLElement[];
            const cell = cells[srcIdx];
            if (cell) {
              cell.classList.add("butter-table-drag-source");
              dimmedEls.push(cell);
            }
          }
        }
      };
      const undimSource = () => {
        for (const el of dimmedEls) {
          el.classList.remove("butter-table-drag-source");
        }
        dimmedEls.length = 0;
      };

      const buildRowGhost = (tr: HTMLElement): HTMLElement => {
        // Wrap the cloned <tr> in a fresh <table>/<tbody> so browsers
        // accept it outside its original parent. Cell widths get
        // copied from the original source row's cell rects so the
        // ghost looks pixel-identical to the row it lifted from.
        const wrap = activeDocument.createElement("div");
        wrap.className = "butter-table-row-ghost";
        const table = activeDocument.createElement("table");
        const tbody = activeDocument.createElement("tbody");
        table.appendChild(tbody);
        wrap.appendChild(table);
        const clone = tr.cloneNode(true) as HTMLElement;
        const origCells = Array.from(tr.children) as HTMLElement[];
        const cloneCells = Array.from(clone.children) as HTMLElement[];
        for (let i = 0; i < origCells.length; i++) {
          if (cloneCells[i]) {
            cloneCells[i].style.width = `${origCells[i].getBoundingClientRect().width}px`;
            cloneCells[i].style.minWidth = `${origCells[i].getBoundingClientRect().width}px`;
            cloneCells[i].style.maxWidth = `${origCells[i].getBoundingClientRect().width}px`;
          }
        }
        tbody.appendChild(clone);
        return wrap;
      };

      const buildColGhost = (
        tableDOM: HTMLElement,
        colIdx: number,
      ): HTMLElement => {
        // One row per source row, each containing only the source
        // column's cell (cloned, with original width preserved).
        // Heights come naturally from the cloned cells.
        const wrap = activeDocument.createElement("div");
        wrap.className = "butter-table-col-ghost";
        const table = activeDocument.createElement("table");
        const tbody = activeDocument.createElement("tbody");
        table.appendChild(tbody);
        wrap.appendChild(table);
        const rows = Array.from(tableDOM.querySelectorAll("tr"));
        for (const row of rows) {
          const cells = Array.from(row.children) as HTMLElement[];
          const cell = cells[colIdx];
          if (!cell) continue;
          const newTr = activeDocument.createElement("tr");
          const cellClone = cell.cloneNode(true) as HTMLElement;
          const w = cell.getBoundingClientRect().width;
          const h = cell.getBoundingClientRect().height;
          cellClone.style.width = `${w}px`;
          cellClone.style.minWidth = `${w}px`;
          cellClone.style.maxWidth = `${w}px`;
          cellClone.style.height = `${h}px`;
          newTr.appendChild(cellClone);
          tbody.appendChild(newTr);
        }
        return wrap;
      };

      const updateGhostPosition = (e: PointerEvent) => {
        if (!dragGhost) return;
        const x = e.clientX - grabOffsetX;
        const y = e.clientY - grabOffsetY;
        dragGhost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      };

      // Reposition handles on scroll inside the host so they track
      // the table as the document scrolls past.
      const onScroll = () => {
        // While a drag is live, only refresh the geometry cache so
        // the drop indicator stays accurate as the user scrolls. The
        // gutter handles are visible to the user during a drag but
        // they're already in the right spot - the cursor is chasing
        // the indicator, not the handles. Skipping renderHandles
        // saves the O(R+C) BCR loop per scroll event.
        if (dragLive) {
          refreshDragCache();
        } else if (activeCtx) {
          renderHandles();
        }
      };
      const scrollHosts: HTMLElement[] = [];
      let p: HTMLElement | null = host;
      while (p) {
        scrollHosts.push(p);
        p = p.parentElement;
      }
      for (const sh of scrollHosts) {
        sh.addEventListener("scroll", onScroll, { passive: true });
      }
      window.addEventListener("resize", onScroll);

      // ── Mouse-hover preview reveal ───────────────────────
      // Independent of the selection-driven `is-active` reveal, we
      // light up the row + column handles for whatever cell the mouse
      // is currently over with a dim-gray version of the dots. Acts
      // as a "preview" - shows the user where the handle would be if
      // they wanted to grab it, before they've committed by clicking
      // into the row. `is-active` (caret / selection in the cell)
      // takes priority via CSS rule order, so an already-active
      // row/col stays accent-colored even while mouse-hovered.
      //
      // Implementation: mouseover bubbles, so a single delegated
      // listener on `editorView.dom` catches every cell entry
      // without per-cell listeners. We only update on cell entries
      // (closest("th, td") match), and only when the cell is in our
      // currently-active table - otherwise other tables on the page
      // would steal the handle hover state.
      const applyHoverIdx = (rowIdx: number, colIdx: number) => {
        layer.querySelectorAll(".butter-table-row-handle").forEach((el) => {
          const idx = parseInt(
            (el as HTMLElement).dataset.idx ?? "-1",
            10,
          );
          el.classList.toggle("is-hover", idx === rowIdx);
        });
        layer.querySelectorAll(".butter-table-col-handle").forEach((el) => {
          const idx = parseInt(
            (el as HTMLElement).dataset.idx ?? "-1",
            10,
          );
          el.classList.toggle("is-hover", idx === colIdx);
        });
      };
      const clearHoverIdx = () => {
        layer
          .querySelectorAll(".is-hover")
          .forEach((el) => el.classList.remove("is-hover"));
      };
      const onEditorMouseOver = (e: MouseEvent) => {
        if (dragLive || !activeCtx) return;
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const cell = target.closest("th, td");
        if (!cell) {
          // Non-cell element. If we're still inside the active table
          // (e.g., between cells or on the table border), keep the
          // current hover state - `mouseleave` clears on real exit.
          const tableEl = target.closest("table");
          if (tableEl === activeCtx.tableDOM) return;
          clearHoverIdx();
          return;
        }
        if (cell.closest("table") !== activeCtx.tableDOM) {
          clearHoverIdx();
          return;
        }
        const row = cell.parentElement;
        if (!row || !row.parentElement) return;
        const rowIdx = Array.from(row.parentElement.children).indexOf(row);
        const colIdx = Array.from(row.children).indexOf(cell);
        applyHoverIdx(rowIdx, colIdx);
      };
      const onEditorMouseLeave = () => {
        if (dragLive) return;
        clearHoverIdx();
      };
      editorView.dom.addEventListener("mouseover", onEditorMouseOver);
      editorView.dom.addEventListener("mouseleave", onEditorMouseLeave);

      // Initial render.
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
          undimSource();
          if (dragGhost) {
            dragGhost.remove();
            dragGhost = null;
          }
          layer.remove();
          for (const sh of scrollHosts) {
            sh.removeEventListener("scroll", onScroll);
          }
          window.removeEventListener("resize", onScroll);
          editorView.dom.removeEventListener("mouseover", onEditorMouseOver);
          editorView.dom.removeEventListener("mouseleave", onEditorMouseLeave);
          window.removeEventListener("pointermove", onArmMove);
          window.removeEventListener("pointerup", onArmUp);
          window.removeEventListener("pointermove", onLiveMove);
          window.removeEventListener("pointerup", onLiveUp);
          window.removeEventListener("touchmove", swallowSidebarSwipe, { capture: true });
          window.removeEventListener("touchstart", swallowSidebarSwipe, { capture: true });
        },
      };
    },
  });
}
