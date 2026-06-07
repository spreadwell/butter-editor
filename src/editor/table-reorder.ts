/**
 * Pure table reorder primitives.
 *
 * Pulled out of `table-row-col-drag.ts` so they can be unit-tested
 * headless - that module pulls in `obsidian` for `Notice` (used in
 * the live drag pipeline), which would force the test runner to
 * stub the obsidian module. These helpers only depend on PM model
 * and the prosemirror-tables `TableMap`, both of which run cleanly
 * under node.
 *
 * Used by `table-row-col-drag.ts` to actually commit a row/column
 * move once the user releases the drag handle.
 */
import {
  Fragment,
  type Node as PMNode,
  type Schema,
} from "prosemirror-model";
import { TableMap } from "prosemirror-tables";
import { normalizeTableCells } from "./table-normalize";

/**
 * Apply a row move to a table node. Returns the new table node with
 * the row at `srcIdx` moved to `dstIdx` (the drop-slot index in the
 * full row list - `dstIdx ∈ [0, N]`, where `dstIdx = N` means "after
 * the last row"). Cell types are re-tagged via `normalizeTableCells`
 * so row 0 stays headers and rows 1+ stay body.
 *
 * Returns `null` when `srcIdx === dstIdx` (the no-op, src returns to
 * its starting slot) or for invalid indices, so callers can skip the
 * transaction. Note: `dstIdx === srcIdx + 1` is ALSO a no-op in final
 * shape (the moved row lands right back where it started), but the
 * function still returns a fresh table; callers that want to skip
 * the dispatch should check that case themselves.
 */
export function applyRowMove(
  table: PMNode,
  schema: Schema,
  srcIdx: number,
  dstIdx: number,
): PMNode | null {
  if (srcIdx === dstIdx) return null;
  const rows: PMNode[] = [];
  table.forEach((row) => rows.push(row));
  if (
    srcIdx < 0 || srcIdx >= rows.length ||
    dstIdx < 0 || dstIdx > rows.length
  ) return null;
  const [moved] = rows.splice(srcIdx, 1);
  // dstIdx is in ORIGINAL numbering. After splicing out srcIdx, every
  // index above srcIdx has shifted down by 1, so the post-splice
  // insertion slot is dstIdx-1 when dstIdx > srcIdx.
  const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
  rows.splice(insertAt, 0, moved);
  const newTable = table.type.create(
    table.attrs,
    Fragment.fromArray(rows),
    table.marks,
  );
  return normalizeTableCells(newTable, schema);
}

/**
 * Apply a column move to a table node. Symmetric to `applyRowMove`
 * but operates on cells within each row. No cell-type normalization
 * needed: cells stay in their original row, so headers stay headers
 * and body stays body.
 *
 * Returns `null` for invalid indices.
 */
export function applyColumnMove(
  table: PMNode,
  srcIdx: number,
  dstIdx: number,
): PMNode | null {
  if (srcIdx === dstIdx) return null;
  const map = TableMap.get(table);
  const colCount = map.width;
  if (
    srcIdx < 0 || srcIdx >= colCount ||
    dstIdx < 0 || dstIdx > colCount
  ) return null;
  const newRows: PMNode[] = [];
  let allOk = true;
  table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => cells.push(cell));
    if (cells.length < colCount) {
      // Sparse row - span filter should have caught this. Bail safely.
      allOk = false;
      newRows.push(row);
      return;
    }
    const [moved] = cells.splice(srcIdx, 1);
    const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
    cells.splice(insertAt, 0, moved);
    newRows.push(row.type.create(row.attrs, Fragment.fromArray(cells), row.marks));
  });
  if (!allOk) return null;
  return table.type.create(
    table.attrs,
    Fragment.fromArray(newRows),
    table.marks,
  );
}
