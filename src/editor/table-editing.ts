/**
 * Table editing plugin bundle. Wires prosemirror-tables' native
 * editing plugin + keymap so Tab / Shift-Tab move between cells,
 * Enter moves down (Sheets/Word convention), and column resize works.
 */
import {
  Plugin as PMPlugin,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { chainCommands } from "prosemirror-commands";
import { buildSpawnTransaction } from "./click-to-spawn";
import {
  tableEditing,
  goToNextCell,
  deleteTable,
  addRowBefore,
  addRowAfter,
  deleteRow,
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  TableMap,
  CellSelection,
} from "prosemirror-tables";
import { tableCellTypeFixer } from "./table-normalize";

/**
 * Enter inside a table cell: move the cursor straight down into
 * the cell below in the same column. Matches Sheets / Word / LP
 * convention, where Enter "advances to the next row" rather than
 * splitting the current cell into two paragraphs (which is what
 * PM's default `splitBlock` would do - and which GFM can't carry
 * through round-trip, since cells are inline-only).
 *
 * When the cursor is already in the last row, fall through to
 * `addRowAfter` so the user gets the "type, Enter, type, Enter…"
 * spreadsheet flow without having to reach for Mod+Enter.
 *
 * Shift+Enter still inserts a softbreak (the cell serializer turns
 * it into `<br>` for GFM-compliant cell line breaks).
 */
export function enterMovesDown(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const { $from } = state.selection;
  // Walk the cursor's parent chain looking for a cell + its table.
  let tablePos = -1;
  let table = null as ReturnType<typeof $from.node> | null;
  let cellPos = -1;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (
      node.type.spec.tableRole === "cell" ||
      node.type.spec.tableRole === "header_cell"
    ) {
      cellPos = $from.before(d);
    }
    if (node.type.spec.tableRole === "table") {
      tablePos = $from.before(d);
      table = node;
      break;
    }
  }
  if (!table || tablePos < 0 || cellPos < 0) return false;

  const map = TableMap.get(table);
  // `map.map[i]` is the byte-offset of cell `i` relative to
  // `tablePos + 1` (one byte past the table-open token). Find the
  // current cell's grid index by reverse lookup.
  const cellOffset = cellPos - (tablePos + 1);
  const cellIdx = map.map.indexOf(cellOffset);
  if (cellIdx < 0) return false;
  const col = cellIdx % map.width;
  const row = Math.floor(cellIdx / map.width);

  // Last row → build a new row + position cursor in the same column,
  // both in one transaction so the cursor lands cleanly without a
  // post-dispatch chase. (Calling `addRowAfter` and then issuing a
  // separate selection tr doesn't compose well - addRowAfter
  // dispatches synchronously and we'd be racing the view's render.)
  if (row >= map.height - 1) {
    if (!dispatch) return true;
    const cellType = state.schema.nodes.table_cell;
    const rowType = state.schema.nodes.table_row;
    if (!cellType || !rowType) return false;
    const cells = [];
    for (let c = 0; c < map.width; c++) {
      const cell = cellType.createAndFill();
      if (!cell) return false;
      cells.push(cell);
    }
    const newRow = rowType.create(null, cells);
    // Insert just before the table's close token.
    const insertPos = tablePos + table.nodeSize - 1;
    let tr = state.tr.insert(insertPos, newRow);
    // Position math against the JUST-inserted row: newRow starts at
    // `insertPos`; its cell N starts at insertPos+1 plus the size of
    // each prior cell. +1 again lands inside the open of that cell;
    // TextSelection.near walks to the first valid cursor position
    // inside the cell's empty paragraph.
    let target = insertPos + 1;
    for (let c = 0; c < col; c++) {
      target += newRow.child(c).nodeSize;
    }
    tr = tr.setSelection(
      TextSelection.near(tr.doc.resolve(target + 1)),
    );
    dispatch(tr.scrollIntoView());
    return true;
  }

  // Not last row - move cursor to the same-column cell in the row
  // below. `targetCellPos + 1` is the position right inside the
  // cell (after its open token); TextSelection.near walks to the
  // nearest valid cursor position from there, which lands inside
  // the cell's first textblock.
  const targetIdx = (row + 1) * map.width + col;
  const targetCellOffset = map.map[targetIdx];
  const targetCellPos = tablePos + 1 + targetCellOffset;
  if (dispatch) {
    const tr = state.tr.setSelection(
      TextSelection.near(state.doc.resolve(targetCellPos + 1)),
    );
    dispatch(tr.scrollIntoView());
  }
  return true;
}

/**
 * Tab inside a table cell: move to the next cell. PM-tables'
 * `goToNextCell(1)` handles end-of-row wrap to the next row's first
 * cell natively, but RETURNS FALSE when the cursor is in the very
 * last cell of the table (last col of last row). Without this
 * wrapper the false return falls through to Obsidian's default Tab
 * handler and focus escapes the editor entirely (lands on a chrome
 * button) - LP-incompatible. Append a new row instead and land in
 * its leftmost cell so the user can keep typing.
 *
 * Shift-Tab at the very first cell still falls through (no wrap-up,
 * no row prepend) - matches Sheets / LP and avoids surprising the
 * user with a row insert from a backwards motion.
 */
export function tabMovesNext(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (goToNextCell(1)(state, dispatch)) return true;

  const { $from } = state.selection;
  let tablePos = -1;
  let table = null as ReturnType<typeof $from.node> | null;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.spec.tableRole === "table") {
      tablePos = $from.before(d);
      table = node;
      break;
    }
  }
  if (!table || tablePos < 0) return false;

  if (!dispatch) return true;
  const cellType = state.schema.nodes.table_cell;
  const rowType = state.schema.nodes.table_row;
  if (!cellType || !rowType) return false;
  const map = TableMap.get(table);
  const cells = [];
  for (let c = 0; c < map.width; c++) {
    const cell = cellType.createAndFill();
    if (!cell) return false;
    cells.push(cell);
  }
  const newRow = rowType.create(null, cells);
  const insertPos = tablePos + table.nodeSize - 1;
  let tr = state.tr.insert(insertPos, newRow);
  // Cursor lands inside the new row's leftmost cell. `insertPos +
  // 1` skips the row's open token; `+ 1` again skips the cell's
  // open token; TextSelection.near walks to the first valid
  // cursor position inside the cell's empty paragraph.
  tr = tr.setSelection(
    TextSelection.near(tr.doc.resolve(insertPos + 2)),
  );
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Arrow-key navigation inside a table cell.
 *
 * Without this, PM's default arrow handling falls back to a pixel-
 * based heuristic ("find the textblock directly above/below the
 * cursor's x-coordinate") which is brittle inside grids - cells with
 * different content widths cause Up/Down to land in the wrong column,
 * Left/Right at cell boundaries can drop the cursor outside the
 * table, and multi-line cells trap the cursor entirely. Spreadsheet
 * users expect deterministic, structure-based motion: Up/Down step
 * through the same column, Left/Right step through cells in document
 * order.
 *
 * The `view.endOfTextblock(dir)` guard is the standard PM idiom for
 * "would this arrow press move me OUT of the current textblock?"
 *   - In-cell text move (cursor not at the cell's boundary line) →
 *     return false, let PM's default handle line-by-line / char-by-
 *     char motion within the cell.
 *   - At cell boundary → take over and jump to the structural
 *     neighbor cell.
 *   - At table edge (no neighbor cell in the requested direction) →
 *     return false, let PM escape the table normally.
 */
function arrowInTable(dir: "up" | "down" | "left" | "right"): Command {
  return (state, dispatch, view) => {
    if (!view) return false;
    const { $from } = state.selection;
    let tablePos = -1;
    let tableNode = null as ReturnType<typeof $from.node> | null;
    let cellPos = -1;
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (
        node.type.spec.tableRole === "cell" ||
        node.type.spec.tableRole === "header_cell"
      ) {
        cellPos = $from.before(d);
      }
      if (node.type.spec.tableRole === "table") {
        tablePos = $from.before(d);
        tableNode = node;
        break;
      }
    }
    if (!tableNode || cellPos < 0) return false;
    if (!view.endOfTextblock(dir)) return false;

    const map = TableMap.get(tableNode);
    const cellOffset = cellPos - (tablePos + 1);
    const cellIdx = map.map.indexOf(cellOffset);
    if (cellIdx < 0) return false;
    const col = cellIdx % map.width;
    const row = Math.floor(cellIdx / map.width);

    // Helper: escape the table cleanly. PM's default fallback for
    // arrow-out-of-table uses a pixel-based heuristic that often
    // lands on a NodeSelection over the table row (visible as a 3px
    // outline through `.ProseMirror-selectednode` that reads as the
    // row "shifting") or fails to move at all when the table is the
    // first/last block in the doc.
    //
    // Strategy: prefer a TextSelection in the adjacent textblock
    // OUTSIDE the table; if none exists in the requested direction
    // (table is at the doc edge), spawn an ephemeral paragraph at
    // the boundary - same UX shape as clicking in inter-block
    // whitespace. Auto-dismisses on blur if the user doesn't type.
    const escape = (boundary: number, bias: 1 | -1): boolean => {
      if (dispatch) {
        const $boundary = state.doc.resolve(boundary);
        let sel: Selection | null = TextSelection.findFrom($boundary, bias);
        // `findFrom` walks both directions on a miss - if it landed
        // back inside the table, treat as "no textblock found."
        if (sel) {
          let stillInTable = false;
          for (let d = sel.$from.depth; d > 0; d--) {
            if (sel.$from.node(d).type.spec.tableRole === "table") {
              stillInTable = true;
              break;
            }
          }
          if (stillInTable) sel = null;
        }
        if (sel) {
          const tr = state.tr.setSelection(sel);
          dispatch(tr.scrollIntoView());
        } else {
          // Table is at the doc edge in this direction - spawn an
          // ephemeral paragraph so the user lands in writable space.
          dispatch(buildSpawnTransaction(state, boundary));
        }
      }
      return true;
    };

    let targetRow = row;
    let targetCol = col;
    let placeAt: "start" | "end" = "start";

    if (dir === "up") {
      if (row === 0) return escape(tablePos, -1);
      targetRow = row - 1;
      placeAt = "end";
    } else if (dir === "down") {
      if (row === map.height - 1) {
        return escape(tablePos + tableNode.nodeSize, 1);
      }
      targetRow = row + 1;
      placeAt = "start";
    } else if (dir === "left") {
      if (col > 0) {
        targetCol = col - 1;
        placeAt = "end";
      } else if (row > 0) {
        targetRow = row - 1;
        targetCol = map.width - 1;
        placeAt = "end";
      } else {
        return escape(tablePos, -1);
      }
    } else {
      // right
      if (col < map.width - 1) {
        targetCol = col + 1;
        placeAt = "start";
      } else if (row < map.height - 1) {
        targetRow = row + 1;
        targetCol = 0;
        placeAt = "start";
      } else {
        return escape(tablePos + tableNode.nodeSize, 1);
      }
    }

    const targetIdx = targetRow * map.width + targetCol;
    const targetCellOffset = map.map[targetIdx];
    if (targetCellOffset === undefined) return false;
    // Same-row colspan / rowspan merges can produce duplicate cell
    // offsets - if the target idx points at the same cell we're in,
    // bail rather than no-op-loop.
    if (targetCellOffset === cellOffset) return false;
    const targetCellPos = tablePos + 1 + targetCellOffset;
    const targetCellNode = state.doc.nodeAt(targetCellPos);
    if (!targetCellNode) return false;
    if (dispatch) {
      const cellEnd = targetCellPos + targetCellNode.nodeSize - 1;
      const targetPos = placeAt === "end" ? cellEnd : targetCellPos + 1;
      const tr = state.tr.setSelection(
        TextSelection.near(state.doc.resolve(targetPos), placeAt === "end" ? -1 : 1),
      );
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * Arrow-key handler for ENTERING a table from an adjacent textblock.
 *
 * Why: PM's default vertical-arrow fallback when the cursor is in a
 * paragraph immediately above (Down) or below (Up) a table uses a
 * pixel-based heuristic that frequently lands on a `NodeSelection`
 * over the first / last row instead of placing a `TextSelection`
 * inside a cell. Butter's `.ProseMirror-selectednode` rule then
 * draws a 3px outline at 6px offset around the row, which the user
 * sees as the row "shifting right one cell width."
 *
 * Fix: explicitly recognize the "cursor in textblock adjacent to a
 * table, arrow points toward the table, cursor is at the edge of
 * its current textblock" pattern and place the selection cleanly in
 * the appropriate cell. Column 0 by default - column-matching by
 * cursor x is a polish item we can add later if the muscle memory
 * matters.
 */
function arrowEnterTable(dir: "up" | "down"): Command {
  return (state, dispatch, view) => {
    if (!view) return false;
    const { $from } = state.selection;
    if (!$from.parent.isTextblock) return false;
    // Already inside a table cell - `arrowInTable` handles motion.
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.spec.tableRole === "table") return false;
    }
    if (!view.endOfTextblock(dir)) return false;

    // Find the adjacent block at the same depth as the textblock's
    // parent (top-level blocks for plain paragraphs, inner blocks
    // for paragraphs inside callouts, list items, etc).
    const blockDepth = $from.depth;
    if (blockDepth < 1) return false;
    const parent = $from.node(blockDepth - 1);
    const idx = $from.index(blockDepth - 1);
    const targetIdx = dir === "down" ? idx + 1 : idx - 1;
    if (targetIdx < 0 || targetIdx >= parent.childCount) return false;
    const neighbor = parent.child(targetIdx);
    if (neighbor.type.spec.tableRole !== "table") return false;

    // Compute the neighbor's absolute position. `parent.start` is
    // the position right after the parent's open token; sum sibling
    // sizes up to targetIdx.
    const parentStart = $from.start(blockDepth - 1);
    let neighborPos = parentStart;
    for (let i = 0; i < targetIdx; i++) {
      neighborPos += parent.child(i).nodeSize;
    }

    // For Down: land in row 0, col 0 (first cell). For Up: land in
    // last row, col 0.
    const map = TableMap.get(neighbor);
    const targetRow = dir === "down" ? 0 : map.height - 1;
    const cellOffset = map.map[targetRow * map.width + 0];
    const cellPos = neighborPos + 1 + cellOffset;
    const cellNode = state.doc.nodeAt(cellPos);
    if (!cellNode) return false;
    if (dispatch) {
      // For Down land at start of cell content; for Up land at end.
      const targetPos = dir === "down"
        ? cellPos + 1
        : cellPos + cellNode.nodeSize - 1;
      const tr = state.tr.setSelection(
        TextSelection.near(state.doc.resolve(targetPos), dir === "down" ? 1 : -1),
      );
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * Shift+Arrow to extend a cell selection (or convert a per-cell
 * TextSelection at a cell boundary into one).
 *
 * Two entry paths:
 *
 *   1. Already in a `CellSelection` (from a drag-select or a prior
 *      Shift+Arrow extension): move the head cell one step in `dir`,
 *      keep the anchor cell, dispatch a new `CellSelection`.
 *
 *   2. In a `TextSelection` inside a cell: only fire when the cursor
 *      is at the cell's boundary in `dir` (via `view.endOfTextblock`)
 *      - otherwise PM's default text-extension within the cell is
 *      what the user wants. At the boundary, convert to a 2-cell
 *      `CellSelection` spanning the current cell to the neighbor in
 *      `dir`. Falls through at the table edge so PM defaults still
 *      escape (or rather, our `arrowInTable` escape handlers - though
 *      they don't fire on Shift+arrow, so PM defaults take over there).
 *
 * Cell rectangles in `prosemirror-tables` are spec'd as resolved
 * positions where `$pos.nodeAfter === cellNode`, i.e., the position
 * AT the cell's open token. `tablePos + 1 + map.map[idx]` matches
 * that contract - same convention `arrowInTable` already uses.
 */
function extendCellSelection(dir: "up" | "down" | "left" | "right"): Command {
  return (state, dispatch, view) => {
    if (!view) return false;
    const { selection, doc } = state;

    type DocNode = ReturnType<typeof doc.resolve>;
    let anchorCellPos = -1;
    let headRow = -1;
    let headCol = -1;
    let tableNode = null as ReturnType<DocNode["node"]> | null;
    let tablePos = -1;
    let map = null as TableMap | null;

    if (selection instanceof CellSelection) {
      tableNode = selection.$anchorCell.node(-1);
      tablePos = selection.$anchorCell.before(-1);
      map = TableMap.get(tableNode);
      anchorCellPos = selection.$anchorCell.pos;
      const headCellOffset = selection.$headCell.pos - (tablePos + 1);
      const headCellIdx = map.map.indexOf(headCellOffset);
      if (headCellIdx < 0) return false;
      headCol = headCellIdx % map.width;
      headRow = Math.floor(headCellIdx / map.width);
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
        }
        if (node.type.spec.tableRole === "table") {
          tablePos = $from.before(d);
          tableNode = node;
          break;
        }
      }
      if (!tableNode || cellPos < 0) return false;
      if (!view.endOfTextblock(dir)) return false;
      map = TableMap.get(tableNode);
      const cellOffset = cellPos - (tablePos + 1);
      const cellIdx = map.map.indexOf(cellOffset);
      if (cellIdx < 0) return false;
      headCol = cellIdx % map.width;
      headRow = Math.floor(cellIdx / map.width);
      anchorCellPos = cellPos;
    } else {
      return false;
    }

    let newRow = headRow;
    let newCol = headCol;
    if (dir === "up") newRow = headRow - 1;
    else if (dir === "down") newRow = headRow + 1;
    else if (dir === "left") newCol = headCol - 1;
    else newCol = headCol + 1;

    if (
      !map ||
      newRow < 0 ||
      newRow >= map.height ||
      newCol < 0 ||
      newCol >= map.width
    ) {
      return false;
    }

    const newHeadOffset = map.map[newRow * map.width + newCol];
    if (newHeadOffset === undefined) return false;
    const newHeadCellPos = tablePos + 1 + newHeadOffset;
    // Span guard: if the new-head offset equals the anchor's offset
    // (rowspan / colspan merged a span back to the anchor cell), no
    // extension to make.
    if (newHeadCellPos === anchorCellPos && !(selection instanceof TextSelection)) {
      return false;
    }

    if (dispatch) {
      const newSel = new CellSelection(
        doc.resolve(anchorCellPos),
        doc.resolve(newHeadCellPos),
      );
      const tr = state.tr.setSelection(newSel);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function tableEditingPlugins(): PMPlugin[] {
  // No `columnResizing()` - GFM source can't carry column widths,
  // so a resize handle would set up an expectation we can't honor
  // (drag the column wider, save, reload, the width is gone). The
  // schema doesn't carry `colwidth` either; even session-only
  // persistence would require schema changes that complicate the
  // markdown round-trip. Cleaner to just not surface the affordance.
  return [
    tableEditing(),
    // Re-tag cells whose type drifted from their row position (e.g.,
    // a `<th>` pasted into a body row keeping `table_header`, which
    // renders bold until save+reload). Runs as `appendTransaction` so
    // the fix lands in the same step as the user's paste / drop.
    tableCellTypeFixer(),
    keymap({
      Tab: tabMovesNext,
      "Shift-Tab": goToNextCell(-1),
      // Plain Enter inside a cell: move down. Cursor falls through
      // `enterMovesDown` for non-table contexts so paragraphs and
      // headings still split normally.
      Enter: enterMovesDown,
      // Row insertion shortcuts - match common Notion / Sheets conventions.
      "Mod-Enter": addRowAfter,
      "Mod-Shift-Enter": addRowBefore,
      // Arrow keys for tables. Two stages:
      //   1. `arrowInTable` - fires when cursor is inside a cell, at a
      //      cell boundary. Jumps structurally rather than via PM's
      //      pixel heuristic.
      //   2. `arrowEnterTable` - fires when cursor is in a textblock
      //      adjacent to a table and pressing Up/Down toward it.
      //      Replaces PM's default pixel-based fallback (which can
      //      land on a NodeSelection over the row, rendering as the
      //      row visually shifting).
      // `chainCommands` runs them in order; first to return true wins.
      ArrowUp: chainCommands(arrowInTable("up"), arrowEnterTable("up")),
      ArrowDown: chainCommands(arrowInTable("down"), arrowEnterTable("down")),
      ArrowLeft: arrowInTable("left"),
      ArrowRight: arrowInTable("right"),
      // Shift+Arrow extends a cell selection in tables. From a regular
      // TextSelection inside a cell, only fires at the cell boundary
      // (so within-cell text-range extension still works). From a
      // CellSelection (drag-select or prior Shift+arrow), always fires.
      "Shift-ArrowUp": extendCellSelection("up"),
      "Shift-ArrowDown": extendCellSelection("down"),
      "Shift-ArrowLeft": extendCellSelection("left"),
      "Shift-ArrowRight": extendCellSelection("right"),
    }),
  ];
}

// Re-export the table manipulation commands so the toolbar / slash
// menu / context menu can reach them without importing
// prosemirror-tables directly everywhere.
export {
  addRowBefore,
  addRowAfter,
  deleteRow,
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  deleteTable,
};
