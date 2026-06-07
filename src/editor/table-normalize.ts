/**
 * Table cell-type normalization.
 *
 * GFM tables encode "header-ness" by row position: row 0 cells are
 * headers, rows 1+ cells are body. Our PM schema has two distinct
 * cell node types (`table_header` and `table_cell`), and any
 * operation that moves a row between positions has to update the
 * cell types to match the new position - otherwise the serializer
 * emits GFM that re-parses to a doc where the cell types match
 * position, the structural fingerprint diverges, and the save
 * round-trip guard refuses the write.
 *
 * Affected operations:
 *   • Row drag-reorder (`src/table-row-col-drag.ts`).
 *   • Chevron-button row move (`src/table-toolbar.ts`).
 *   • Transpose (the original header row becomes the first column,
 *     so cell types need a different remap - handle separately).
 *
 * Column reorder is safe: cells move within their original row, so
 * the cell type stays consistent with the row's position.
 */
import { Fragment, type Node as PMNode, type Schema } from "prosemirror-model";
import { Plugin as PMPlugin } from "prosemirror-state";

/**
 * Returns a normalized copy of `table` where row 0's cells are
 * `table_header` and all other rows' cells are `table_cell`. If no
 * cells need conversion, returns the original `table` unchanged.
 */
export function normalizeTableCells(
  table: PMNode,
  schema: Schema,
): PMNode {
  const headerType = schema.nodes.table_header;
  const cellType = schema.nodes.table_cell;
  if (!headerType || !cellType) return table;
  const newRows: PMNode[] = [];
  let tableMutated = false;
  table.forEach((row, _offset, rowIdx) => {
    const expected = rowIdx === 0 ? headerType : cellType;
    let rowMutated = false;
    const newCells: PMNode[] = [];
    row.forEach((cell) => {
      if (cell.type === expected) {
        newCells.push(cell);
      } else {
        // Convert: keep attrs, content, marks. Only the schema
        // type changes. Both types share the same attrs (colspan,
        // rowspan, alignment, sourceRange) so this is a clean
        // re-tagging.
        newCells.push(expected.create(cell.attrs, cell.content, cell.marks));
        rowMutated = true;
      }
    });
    if (rowMutated) {
      newRows.push(
        row.type.create(row.attrs, Fragment.fromArray(newCells), row.marks),
      );
      tableMutated = true;
    } else {
      newRows.push(row);
    }
  });
  if (!tableMutated) return table;
  return table.type.create(
    table.attrs,
    Fragment.fromArray(newRows),
    table.marks,
  );
}

/**
 * Walk the entire document and normalize every top-level table's
 * cell types. Returns a new doc only if at least one table needed
 * fixing; otherwise returns the same instance. Used as a defensive
 * pre-serialize transform so that even if some upstream code path
 * drifts on cell-type bookkeeping (e.g. an external paste, a
 * historical doc that has the bug baked in), the save round-trip
 * still passes.
 */
export function normalizeTablesInDoc(
  doc: PMNode,
  schema: Schema,
): PMNode {
  if (!schema.nodes.table) return doc;
  const newChildren: PMNode[] = [];
  let mutated = false;
  doc.forEach((child) => {
    if (child.type.spec.tableRole === "table") {
      const normalized = normalizeTableCells(child, schema);
      if (normalized !== child) mutated = true;
      newChildren.push(normalized);
    } else {
      newChildren.push(child);
    }
  });
  if (!mutated) return doc;
  return doc.type.create(doc.attrs, Fragment.fromArray(newChildren));
}

/**
 * Plugin: after every doc-changing transaction, retag any table cell
 * whose type doesn't match its row position (row 0 = header, rows 1+
 * = body). Runs as `appendTransaction`, so PM applies the fix in the
 * same step as the user's action - visible as one selection move,
 * undo collapses to a single entry.
 *
 * Why we need this: PM-tables' built-in paste handler fills cells
 * from the clipboard fragment WITHOUT retagging - `<th>` cells
 * pasted into body rows stay `table_header`, which renders bold via
 * the user-agent's default `<th>` styles, until the next save+reload
 * normalizes the source on serialize. Same drift can happen on any
 * future code path that splices cells without going through our
 * existing reorder / move helpers (which do call `normalizeTableCells`
 * directly). Centralizing the fix in an `appendTransaction` makes it
 * defensive against any such drift.
 *
 * Targets each mismatched cell with a `setNodeMarkup` step rather
 * than rebuilding the whole table. Cheaper, doesn't disturb selection
 * or any other table-level state, and preserves cell `attrs` (colspan,
 * rowspan, alignment, sourceRange).
 */
export function tableCellTypeFixer(): PMPlugin {
  return new PMPlugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const headerType = newState.schema.nodes.table_header;
      const cellType = newState.schema.nodes.table_cell;
      if (!headerType || !cellType) return null;

      type Fix = { pos: number; expected: typeof headerType };
      const fixes: Fix[] = [];

      newState.doc.descendants((node, pos) => {
        if (node.type.spec.tableRole !== "table") return undefined;
        // Walk the table's rows + cells, computing each cell's
        // absolute position. `pos` is the position of the table-
        // open token; `pos + 1` is just inside the table; each row
        // contributes `nodeSize` to the running offset; same for
        // each cell within a row.
        let rowOffset = 0;
        for (let ri = 0; ri < node.childCount; ri++) {
          const row = node.child(ri);
          const expected = ri === 0 ? headerType : cellType;
          let cellOffset = 0;
          for (let ci = 0; ci < row.childCount; ci++) {
            const cell = row.child(ci);
            if (cell.type !== expected) {
              fixes.push({
                pos: pos + 1 + rowOffset + 1 + cellOffset,
                expected,
              });
            }
            cellOffset += cell.nodeSize;
          }
          rowOffset += row.nodeSize;
        }
        // Don't recurse into the table's structural innards (rows /
        // cells / paragraphs) - descendants() would still walk the
        // cell content (text, marks) which is wasted work for this
        // fixer, but won't produce false positives. Returning false
        // skips the descent.
        return false;
      });

      if (!fixes.length) return null;
      const tr = newState.tr;
      for (const { pos, expected } of fixes) {
        const cell = tr.doc.nodeAt(pos);
        if (cell) tr.setNodeMarkup(pos, expected, cell.attrs);
      }
      return tr;
    },
  });
}
