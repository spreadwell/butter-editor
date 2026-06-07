/**
 * Block ID auto-stamper.
 *
 * Every block-level node has a `blockId` attr in the schema (defaults
 * to null). This plugin walks the doc on every transaction and stamps
 * a unique ID on any block missing one — covers blocks that appear
 * from paste, programmatic edits, or any path that bypasses the
 * markdown parser's own ID generation.
 *
 * IDs are session-local: generated in memory, never serialized to
 * markdown. On file open, the parser stamps IDs at parse time so the
 * doc is fully ID'd from the start. This plugin is the safety net for
 * everything else.
 *
 * Used by the drag engine to correlate blocks across transactions:
 * snapshot positions by blockId pre-dispatch, find each block in the
 * new doc by its blockId post-dispatch, animate the position delta.
 * Stable identity unlocks reliable FLIP animation without fighting
 * PM's DOM reconciliation.
 */
import { Plugin as PMPlugin, PluginKey } from "prosemirror-state";
import { nanoid } from "nanoid";

const key = new PluginKey("butter-block-id-stamper");

export function blockIdStamperPlugin(): PMPlugin {
  return new PMPlugin({
    key,
    appendTransaction(transactions, _oldState, newState) {
      // Only run if something changed
      if (!transactions.some((tr) => tr.docChanged)) return null;
      // Skip if any transaction is itself a stamping pass (avoid loops)
      if (transactions.some((tr) => tr.getMeta(key))) return null;

      const tr = newState.tr;
      let stamped = false;
      newState.doc.descendants((node, pos) => {
        if (!node.type.isBlock) return;
        if (node.attrs.blockId != null) return;
        tr.setNodeAttribute(pos, "blockId", nanoid(10));
        stamped = true;
      });
      if (!stamped) return null;
      tr.setMeta(key, true);
      tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
