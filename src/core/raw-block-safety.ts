/**
 * Raw-block deletion safety net.
 *
 * When `parseWithSourceMap` fails on a file (malformed construct,
 * markdown-it internal throw we haven't pinned down yet, etc.), we
 * fall back to wrapping the entire file content in a single
 * `raw_block` node whose `raw` attr holds the original bytes
 * verbatim. The serializer emits that node's bytes byte-for-byte on
 * save, so the user's source survives a parse failure IF they don't
 * modify the doc.
 *
 * The risk: `raw_block` is an atom node, so PM's `NodeSelection` can
 * target it, and Backspace / Delete / Cut / drag-handle-remove can
 * drop the node from the doc. Once it's gone, the next save
 * serializes an empty (or near-empty) doc → writes an empty file
 * → source is GONE. Because raw_block only appears when parse
 * failed, this is a failure mode layered on top of an already-bad
 * day for the user.
 *
 * Zero tolerance for data loss: this plugin installs a
 * `filterTransaction` that REJECTS any transaction which would
 * reduce the raw_block count in the doc, UNLESS the transaction
 * carries the `RAW_BLOCK_SYNC_META` flag. That flag is set by
 * `setViewData` when it replaces the doc because an external change
 * re-synced the file into Butter - at that point a fresh parse
 * either succeeded (legitimate raw_block removal, we want this) or
 * produced another raw_block (still protected).
 *
 * Regular user transactions - keyboard, drag handle, slash command,
 * paste, cut - never carry the meta, so they can't destroy a
 * raw_block. The `onReject` callback surfaces a `Notice` telling
 * the user the source is locked until they fix it externally, so
 * the block isn't a silent brick.
 */

import { Plugin as PMPlugin } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";

/** Meta key carried by trusted transactions (setViewData sync) that
 *  are permitted to remove raw_blocks because a fresh parse already
 *  produced the replacement content. */
export const RAW_BLOCK_SYNC_META = "butter-raw-block-sync";

function isWholeSourceFallback(doc: PMNode): boolean {
  return doc.childCount === 1 && doc.firstChild?.type.name === "raw_block";
}

/**
 * Build the safety plugin. `onReject` is called with a human-
 * readable message whenever a transaction is blocked - wire it to
 * an Obsidian `Notice` so the user sees why their edit didn't stick.
 */
export function rawBlockSafetyPlugin(
  onReject: (msg: string) => void,
): PMPlugin {
  return new PMPlugin({
    filterTransaction(tr, state) {
      if (!tr.docChanged) return true;
      // Trusted replace from setViewData - a fresh parse produced
      // the new doc, so any raw_block drop is legitimate.
      if (tr.getMeta(RAW_BLOCK_SYNC_META)) return true;

      // Parser failure is represented only as one whole-file raw block. Lock
      // that fallback document completely: allowing visible siblings to be
      // inserted beside it would synthesize new bytes around source Butter
      // explicitly could not parse. This check is O(1) on every keystroke.
      if (!isWholeSourceFallback(state.doc)) return true;

      // Any local mutation of the fallback is unsafe. Reject and tell the
      // user why; trusted whole-file synchronization remains the sole exit.
      onReject(
        "Butter can't delete an unparseable block - it holds your " +
          "source bytes verbatim. Open the file in another view " +
          "(Source or Reading) to fix the syntax; the block will " +
          "clear itself on re-parse.",
      );
      return false;
    },
  });
}
