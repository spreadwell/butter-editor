/**
 * Cell-range drag-and-drop - Sheets-style.
 *
 * The user drag-selects cells (via prosemirror-tables' built-in
 * mouse handler), then a thick accent FRAME appears around the
 * selection. The frame's border is the drag-pickup affordance:
 * hover the border → `cursor: move`; mousedown the border → drag
 * begins. The frame's interior is `pointer-events: none`, so
 * clicking INSIDE a selected cell still places the text cursor for
 * editing - exactly the muscle memory Sheets / Excel users have.
 *
 * During the drag:
 *   • Source frame becomes dashed (Excel "marching ants" idiom for
 *     cut content) so source vs. destination read distinct.
 *   • A solid destination outline tracks the cursor, snapped to the
 *     cell range that will be overwritten - anchored at the cell
 *     under the cursor, expanded by the source area's width × height,
 *     clipped to the destination table's bounds.
 *
 * Drop semantics - same-table only. The destination cells are
 * overwritten by the source range via pm-tables' internal
 * `__insertCells`. Default is MOVE: source cells' inline content is
 * cleared via `tr.delete` (cells are `inline*` in our schema, so we
 * leave empty - but valid - inline content). Holding Ctrl / Cmd
 * switches to COPY: source kept intact; cursor flips to `cursor:
 * copy` for live feedback. Esc cancels.
 *
 * Autoscroll: when the cursor is within `AUTOSCROLL_EDGE_PX` of the
 * scroll host's top or bottom edge, the host scrolls toward the
 * cursor with proximity-based speed.
 *
 * Out of scope (intentionally): dropping outside the source table,
 * dropping into a different table. The same-table case covers the
 * common "rearrange within a table" intent reliably; the others
 * proved fragile.
 */
import { Plugin as PMPlugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Fragment, Node as PMNode } from "prosemirror-model";
import {
  CellSelection,
  TableMap,
  __pastedCells as pastedCells,
  __insertCells as insertCells,
  type Rect,
} from "prosemirror-tables";

type Area = { width: number; height: number; rows: Fragment[] };
type ViewportRect = { left: number; top: number; width: number; height: number };

const DRAG_THRESHOLD_PX = 3;
const AUTOSCROLL_EDGE_PX = 60;
const AUTOSCROLL_MAX_PX_PER_FRAME = 14;

// ─────────────── Helpers ───────────────

function findContainingTable(
  $pos: ReturnType<EditorView["state"]["doc"]["resolve"]>,
): { tablePos: number; table: PMNode } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.spec.tableRole === "table") {
      return { tablePos: $pos.before(d), table: node };
    }
  }
  return null;
}

function findContainingCell(
  view: EditorView,
  pos: number,
): { cellPos: number; cellNode: PMNode } | null {
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    const role = (node.type.spec as { tableRole?: string }).tableRole;
    if (role === "cell" || role === "header_cell") {
      return { cellPos: $pos.before(d), cellNode: node };
    }
  }
  return null;
}

function selectionRect(sel: CellSelection): { tablePos: number; rect: Rect } | null {
  const $anchor = sel.$anchorCell;
  const tableNode = $anchor.node(-1);
  if (!tableNode || tableNode.type.spec.tableRole !== "table") return null;
  const tableStart = $anchor.start(-1);
  const map = TableMap.get(tableNode);
  const rect = map.rectBetween(
    sel.$anchorCell.pos - tableStart,
    sel.$headCell.pos - tableStart,
  );
  return { tablePos: tableStart - 1, rect };
}

/**
 * Pixel-rect bounding box of a cell range inside a table. Resolves
 * via `view.nodeDOM` to the DOM cell elements at the corners and
 * unions their `getBoundingClientRect()`s. Returns null if the corner
 * cells aren't currently rendered (rare; happens during PM's render
 * cycle).
 */
function cellRangeViewportRect(
  view: EditorView,
  tablePos: number,
  rect: Rect,
  table: PMNode,
): ViewportRect | null {
  const tableStart = tablePos + 1;
  const map = TableMap.get(table);
  const tlPos = tableStart + map.map[rect.top * map.width + rect.left];
  const brPos =
    tableStart + map.map[(rect.bottom - 1) * map.width + (rect.right - 1)];
  const tlDom = view.nodeDOM(tlPos);
  const brDom = view.nodeDOM(brPos);
  if (!(tlDom instanceof HTMLElement) || !(brDom instanceof HTMLElement))
    return null;
  const tl = tlDom.getBoundingClientRect();
  const br = brDom.getBoundingClientRect();
  return {
    left: tl.left,
    top: tl.top,
    width: br.right - tl.left,
    height: br.bottom - tl.top,
  };
}

/**
 * Walk up from the editor DOM to the nearest scrolling ancestor.
 * Used by the autoscroll loop to scroll the right container when
 * the cursor approaches a viewport edge.
 */
function findScrollHost(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * Clear every source cell's INLINE content. The cell nodes themselves
 * are preserved (deleting them would corrupt the surviving source
 * table's grid). Butter's cells are `inline*` per schema, so we use
 * `tr.delete` to drop the inline nodes - `tr.replaceWith(...,
 * paragraph)` would be a schema violation (block in inline-only
 * context) and would corrupt the table on the next normalize.
 */
function clearSourceCells(view: EditorView, sourceCellPositions: number[]): void {
  let tr = view.state.tr;
  const positions = [...sourceCellPositions].sort((a, b) => a - b);
  for (const cellPos of positions) {
    const mappedPos = tr.mapping.map(cellPos);
    const cellNode = tr.doc.nodeAt(mappedPos);
    if (!cellNode) continue;
    const role = (cellNode.type.spec as { tableRole?: string }).tableRole;
    if (role !== "cell" && role !== "header_cell") continue;
    const contentStart = mappedPos + 1;
    const contentEnd = mappedPos + cellNode.nodeSize - 1;
    if (contentEnd > contentStart) tr = tr.delete(contentStart, contentEnd);
  }
  if (tr.docChanged) view.dispatch(tr);
}

function commitCellDrop(
  view: EditorView,
  tablePos: number,
  clipRect: Rect,
  area: Area,
  sourceCellPositions: number[],
  isCopy: boolean,
): void {
  const tableStart = tablePos + 1;
  // insertCells expects a single-cell anchor rect; it expands using
  // the area's own width × height.
  const insertRect: Rect = {
    top: clipRect.top,
    left: clipRect.left,
    bottom: clipRect.top + 1,
    right: clipRect.left + 1,
  };
  // MOVE: clear source first. clear-then-insert is correct even when
  // source / dest overlap - insertCells overwrites whatever's at the
  // dest, so cells in the overlap zone end up with the dragged
  // content while non-overlapping source cells remain empty.
  if (!isCopy) clearSourceCells(view, sourceCellPositions);
  insertCells(view.state, view.dispatch, tableStart, insertRect, area);
}

// ─────────────── Selection frame (PluginView) ───────────────

/**
 * Renders the persistent frame around any active CellSelection.
 * Lives in `document.body` (fixed-position, viewport coords) so it
 * sits above the editor without participating in PM's DOM. Updated
 * on every selection change AND on scroll/resize (since fixed-pos
 * coords drift when the underlying cells move).
 *
 * Owns two DOM elements:
 *   • `sourceFrame` - the thick accent border around the selection,
 *     with 4 grabbable edges that start the drag. Always shown when
 *     a CellSelection is active. Adds `--dragging` class during a
 *     live drag → CSS swaps the solid border for the dashed
 *     marching-ants idiom.
 *   • `destFrame` - single solid outline shown only during a live
 *     drag, snapped to the destination cell range. Pixel-positioned
 *     by `recomputeTarget`.
 */
class SelectionFrameView {
  view: EditorView;
  sourceFrame: HTMLElement;
  destFrame: HTMLElement;
  edges: HTMLElement[] = [];
  currentSel: CellSelection | null = null;
  scrollListener: () => void;
  resizeListener: () => void;

  constructor(view: EditorView) {
    this.view = view;

    this.sourceFrame = activeDocument.createElement("div");
    this.sourceFrame.className = "butter-cell-selection-frame";

    for (const side of ["top", "right", "bottom", "left"] as const) {
      const edge = activeDocument.createElement("div");
      edge.className = `butter-cell-frame-edge butter-cell-frame-edge-${side}`;
      edge.addEventListener("mousedown", (e) => this.onEdgeMouseDown(e));
      this.sourceFrame.appendChild(edge);
      this.edges.push(edge);
    }

    this.destFrame = activeDocument.createElement("div");
    this.destFrame.className = "butter-cell-dest-outline";

    activeDocument.body.appendChild(this.sourceFrame);
    activeDocument.body.appendChild(this.destFrame);

    // Reposition frame on any scroll bubbling through the document
    // (capture phase so we catch internal scrollers too) or window
    // resize. Without this the frame visibly lags behind the cells
    // when the user scrolls mid-selection.
    this.scrollListener = () => this.repositionSourceFrame();
    this.resizeListener = () => this.repositionSourceFrame();
    window.addEventListener("scroll", this.scrollListener, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", this.resizeListener);

    // Track this as the module-level active drag frame. Routed through a
    // setter so `this` is passed as an argument rather than aliased to a
    // variable.
    setActiveFrame(this);
    this.update();
  }

  update(): void {
    const sel = this.view.state.selection;
    if (sel instanceof CellSelection) {
      this.currentSel = sel;
      this.repositionSourceFrame();
    } else {
      this.currentSel = null;
      this.sourceFrame.removeClass("butter-cell-frame-positioned");
    }
  }

  repositionSourceFrame(): void {
    if (!this.currentSel) {
      this.sourceFrame.removeClass("butter-cell-frame-positioned");
      return;
    }
    const sr = selectionRect(this.currentSel);
    if (!sr) {
      this.sourceFrame.removeClass("butter-cell-frame-positioned");
      return;
    }
    const vr = cellRangeViewportRect(
      this.view,
      sr.tablePos,
      sr.rect,
      this.currentSel.$anchorCell.node(-1),
    );
    if (!vr) {
      this.sourceFrame.removeClass("butter-cell-frame-positioned");
      return;
    }
    const leaf = this.view.dom.closest(".workspace-leaf-content");
    const header = leaf?.querySelector<HTMLElement>(".view-header");
    const stack = leaf?.querySelector<HTMLElement>(".butter-toolbar-stack");
    const tableBar = stack?.querySelector<HTMLElement>(".butter-table-toolbar:not(.is-hidden)");
    const hb = header?.getBoundingClientRect().bottom ?? 0;
    const sb = stack?.getBoundingClientRect().bottom ?? 0;
    const tb = tableBar?.getBoundingClientRect().bottom ?? 0;
    const chromeBottom = Math.max(hb, sb, tb);
    const clippedTop = Math.max(vr.top, chromeBottom);
    const clippedHeight = vr.height - (clippedTop - vr.top);
    if (clippedHeight <= 0) {
      this.sourceFrame.removeClass("butter-cell-frame-positioned");
      return;
    }
    this.sourceFrame.addClass("butter-cell-frame-positioned");
    this.sourceFrame.setCssProps({
      "--butter-pos-left": `${vr.left}px`,
      "--butter-pos-top": `${clippedTop}px`,
      "--butter-pos-width": `${vr.width}px`,
      "--butter-pos-height": `${clippedHeight}px`,
    });
  }

  showDestOutline(vr: ViewportRect): void {
    this.destFrame.addClass("butter-cell-frame-positioned");
    this.destFrame.setCssProps({
      "--butter-pos-left": `${vr.left}px`,
      "--butter-pos-top": `${vr.top}px`,
      "--butter-pos-width": `${vr.width}px`,
      "--butter-pos-height": `${vr.height}px`,
    });
  }

  hideDestOutline(): void {
    this.destFrame.removeClass("butter-cell-frame-positioned");
  }

  setDragMode(active: boolean): void {
    this.sourceFrame.classList.toggle(
      "butter-cell-selection-frame--dragging",
      active,
    );
  }

  onEdgeMouseDown(e: MouseEvent): void {
    if (!this.currentSel) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    startArmed(this.view, this.currentSel, e);
  }

  destroy(): void {
    this.sourceFrame.remove();
    this.destFrame.remove();
    window.removeEventListener("scroll", this.scrollListener, {
      capture: true,
    });
    window.removeEventListener("resize", this.resizeListener);
    if (activeFrame === this) activeFrame = null;
  }
}

let activeFrame: SelectionFrameView | null = null;
function setActiveFrame(frame: SelectionFrameView | null): void {
  activeFrame = frame;
}

// ─────────────── Drag lifecycle ───────────────

type Armed = {
  view: EditorView;
  startX: number;
  startY: number;
  area: Area;
  sourceCellPositions: number[];
  sourceTablePos: number;
  sourceRect: Rect;
  originalSelectionAnchor: number;
  originalSelectionHead: number;
};

type LiveDrag = Armed & {
  currentTarget: { tablePos: number; clipRect: Rect } | null;
};

let armed: Armed | null = null;
let drag: LiveDrag | null = null;
let lastPointerX = 0;
let lastPointerY = 0;
let autoscrollRAF = 0;

function setCopyCursor(copy: boolean): void {
  activeDocument.body.classList.toggle("butter-cell-drag-copy", copy);
}

function startArmed(view: EditorView, sel: CellSelection, e: MouseEvent): void {
  const slice = sel.content();
  const area = pastedCells(slice);
  if (!area) return;
  const selRect = selectionRect(sel);
  if (!selRect) return;

  const sourceCellPositions: number[] = [];
  sel.forEachCell((_cell, pos) => sourceCellPositions.push(pos));

  armed = {
    view,
    startX: e.clientX,
    startY: e.clientY,
    area,
    sourceCellPositions,
    sourceTablePos: selRect.tablePos,
    sourceRect: selRect.rect,
    originalSelectionAnchor: sel.$anchorCell.pos,
    originalSelectionHead: sel.$headCell.pos,
  };

  const root = view.root as Document;
  root.addEventListener("mousemove", onArmedMove);
  root.addEventListener("mouseup", onArmedEnd);
  root.addEventListener("keydown", onArmedKey);
}

function onArmedMove(e: MouseEvent): void {
  if (!armed) return;
  const dx = e.clientX - armed.startX;
  const dy = e.clientY - armed.startY;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
  promoteToLiveDrag(e);
}

function onArmedEnd(): void {
  teardownArmed();
}

function onArmedKey(e: KeyboardEvent): void {
  if (e.key === "Escape") teardownArmed();
}

function teardownArmed(): void {
  if (!armed) return;
  const root = armed.view.root as Document;
  root.removeEventListener("mousemove", onArmedMove);
  root.removeEventListener("mouseup", onArmedEnd);
  root.removeEventListener("keydown", onArmedKey);
  armed = null;
}

function promoteToLiveDrag(e: MouseEvent): void {
  if (!armed) return;
  const view = armed.view;

  // Defensive: re-establish the original CellSelection in case any
  // handler clobbered it between mousedown and the threshold-
  // crossing move. (Less critical now that pickup is via the frame
  // edge - pm-tables' mousedown never fires there - but harmless.)
  const sel = view.state.selection;
  if (
    !(sel instanceof CellSelection) ||
    sel.$anchorCell.pos !== armed.originalSelectionAnchor ||
    sel.$headCell.pos !== armed.originalSelectionHead
  ) {
    try {
      const restored = new CellSelection(
        view.state.doc.resolve(armed.originalSelectionAnchor),
        view.state.doc.resolve(armed.originalSelectionHead),
      );
      view.dispatch(view.state.tr.setSelection(restored));
    } catch {
      teardownArmed();
      return;
    }
  }
  const liveSel = view.state.selection;
  if (!(liveSel instanceof CellSelection)) {
    teardownArmed();
    return;
  }

  drag = { ...armed, currentTarget: null };

  // Switch listener set: armed → live.
  const root = view.root as Document;
  root.removeEventListener("mousemove", onArmedMove);
  root.removeEventListener("mouseup", onArmedEnd);
  root.removeEventListener("keydown", onArmedKey);
  armed = null;

  root.addEventListener("mousemove", onLiveMove);
  root.addEventListener("mouseup", onLiveUp);
  root.addEventListener("keydown", onLiveKey, true);

  activeDocument.body.classList.add("butter-cell-drag-active");
  activeFrame?.setDragMode(true);

  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  setCopyCursor(e.ctrlKey || e.metaKey);
  recomputeTarget(drag, e.clientX, e.clientY);
  startAutoscroll(view);
}

function recomputeTarget(d: LiveDrag, x: number, y: number): void {
  const drop = d.view.posAtCoords({ left: x, top: y });
  if (!drop) {
    activeFrame?.hideDestOutline();
    d.currentTarget = null;
    return;
  }
  const $drop = d.view.state.doc.resolve(drop.pos);
  const dest = findContainingTable($drop);
  // Same-table-only.
  if (!dest || dest.tablePos !== d.sourceTablePos) {
    activeFrame?.hideDestOutline();
    d.currentTarget = null;
    return;
  }

  const tableStart = dest.tablePos + 1;
  const map = TableMap.get(dest.table);
  const cellInfo = findContainingCell(d.view, drop.pos);
  if (!cellInfo) {
    activeFrame?.hideDestOutline();
    d.currentTarget = null;
    return;
  }
  let destCellRect: Rect;
  try {
    destCellRect = map.findCell(cellInfo.cellPos - tableStart);
  } catch {
    activeFrame?.hideDestOutline();
    d.currentTarget = null;
    return;
  }
  // Anchor at hovered cell, expand by source area, clip to table.
  const right = Math.min(destCellRect.left + d.area.width, map.width);
  const bottom = Math.min(destCellRect.top + d.area.height, map.height);
  const clipRect: Rect = {
    top: destCellRect.top,
    left: destCellRect.left,
    right,
    bottom,
  };

  const vr = cellRangeViewportRect(d.view, dest.tablePos, clipRect, dest.table);
  if (!vr) {
    activeFrame?.hideDestOutline();
    d.currentTarget = null;
    return;
  }
  activeFrame?.showDestOutline(vr);
  d.currentTarget = { tablePos: dest.tablePos, clipRect };
}

// ─────────────── Autoscroll ───────────────

function startAutoscroll(view: EditorView): void {
  if (autoscrollRAF) return;
  const tick = () => {
    if (!drag) {
      autoscrollRAF = 0;
      return;
    }
    const scroller = findScrollHost(view.dom);
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      const distTop = lastPointerY - sr.top;
      const distBottom = sr.bottom - lastPointerY;
      let delta = 0;
      if (distTop < AUTOSCROLL_EDGE_PX && distTop > -200) {
        // Scroll UP, scaling speed by proximity to the edge.
        delta = -((AUTOSCROLL_EDGE_PX - distTop) / AUTOSCROLL_EDGE_PX) *
          AUTOSCROLL_MAX_PX_PER_FRAME;
      } else if (distBottom < AUTOSCROLL_EDGE_PX && distBottom > -200) {
        delta = ((AUTOSCROLL_EDGE_PX - distBottom) / AUTOSCROLL_EDGE_PX) *
          AUTOSCROLL_MAX_PX_PER_FRAME;
      }
      if (delta !== 0) {
        scroller.scrollTop += delta;
        // Re-recompute target since the cells under the cursor have
        // moved relative to the (unchanged) cursor coords.
        recomputeTarget(drag, lastPointerX, lastPointerY);
        // Also reposition the source frame (its underlying cells
        // moved with the scroll).
        activeFrame?.repositionSourceFrame();
      }
    }
    autoscrollRAF = window.requestAnimationFrame(tick);
  };
  autoscrollRAF = window.requestAnimationFrame(tick);
}

function stopAutoscroll(): void {
  if (autoscrollRAF) cancelAnimationFrame(autoscrollRAF);
  autoscrollRAF = 0;
}

// ─────────────── Live drag handlers ───────────────

function onLiveMove(e: MouseEvent): void {
  if (!drag) return;
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  setCopyCursor(e.ctrlKey || e.metaKey);
  recomputeTarget(drag, e.clientX, e.clientY);
}

function onLiveUp(e: MouseEvent): void {
  if (!drag) return;
  const isCopy = e.ctrlKey || e.metaKey;
  const target = drag.currentTarget;
  const view = drag.view;
  const area = drag.area;
  const sourceCellPositions = drag.sourceCellPositions;
  const isSelf = target ? isSelfDrop(drag, target) : false;
  teardownLive();
  if (!target || isSelf) return;
  commitCellDrop(view, target.tablePos, target.clipRect, area, sourceCellPositions, isCopy);
}

function onLiveKey(e: KeyboardEvent): void {
  if (!drag) return;
  if (e.key === "Escape") {
    teardownLive();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (
    e.key === "Control" ||
    e.key === "Meta" ||
    e.key === "OS" ||
    e.key === "Win"
  ) {
    setCopyCursor(e.ctrlKey || e.metaKey);
  }
}

function teardownLive(): void {
  if (!drag) return;
  stopAutoscroll();
  activeFrame?.hideDestOutline();
  activeFrame?.setDragMode(false);
  const root = drag.view.root as Document;
  root.removeEventListener("mousemove", onLiveMove);
  root.removeEventListener("mouseup", onLiveUp);
  root.removeEventListener("keydown", onLiveKey, true);
  activeDocument.body.classList.remove("butter-cell-drag-active");
  activeDocument.body.classList.remove("butter-cell-drag-copy");
  drag = null;
}

function isSelfDrop(
  d: Armed | LiveDrag,
  target: NonNullable<LiveDrag["currentTarget"]>,
): boolean {
  if (target.tablePos !== d.sourceTablePos) return false;
  const s = d.sourceRect;
  const t = target.clipRect;
  return (
    s.top === t.top &&
    s.left === t.left &&
    s.bottom === t.bottom &&
    s.right === t.right
  );
}

// ─────────────── Plugin ───────────────

export function tableCellDragPlugin(): PMPlugin {
  return new PMPlugin({
    key: new PluginKey("butter-table-cell-drag"),
    view(view) {
      return new SelectionFrameView(view);
    },
  });
}
