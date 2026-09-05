/**
 * Block ID auto-stamper.
 *
 * Every editor block has a `blockId` attr in the schema (default null).
 * `ensureBlockIds` fills IDs before editable state is created; this plugin is
 * the transaction-time safety net for new or copied blocks.
 *
 * IDs are session-local: generated in memory, never serialized to
 * markdown. The Markdown parser stays deterministic and the editor boundary
 * adds IDs in one pass, so the first keystroke never performs a whole-document
 * attribute transaction.
 *
 * Used by the drag engine to correlate blocks across transactions:
 * snapshot positions by blockId pre-dispatch, find each block in the
 * new doc by its blockId post-dispatch, animate the position delta.
 * Stable identity unlocks reliable FLIP animation without fighting
 * PM's DOM reconciliation.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Fragment } from "prosemirror-model";
import {
  Plugin as PMPlugin,
  PluginKey,
  type Transaction,
} from "prosemirror-state";
import { AttrStep, ReplaceAroundStep, ReplaceStep } from "prosemirror-transform";
import { nanoid } from "nanoid";

const key = new PluginKey("butter-block-id-stamper");

export type BlockIdFactory = () => string;
const defaultBlockIdFactory: BlockIdFactory = () => nanoid(10);

function supportsBlockId(node: PMNode): boolean {
  return Object.prototype.hasOwnProperty.call(
    node.type.spec.attrs ?? {},
    "blockId",
  );
}

function usableBlockId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function freshBlockId(createId: BlockIdFactory, used: Set<string>): string {
  // nanoid collisions are vanishingly unlikely, but copied slices can carry an
  // existing ID and deterministic tests intentionally exercise collisions.
  // Keep generation total without silently accepting an ambiguous identity.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = createId();
    if (usableBlockId(candidate) && !used.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a unique Butter block identity");
}

/**
 * Ordinary text, mark, selection, and non-identity attribute transactions
 * cannot create a block identity. Inspecting their small step payloads lets
 * the safety net return without traversing the document on every keystroke.
 *
 * Structural ProseMirror operations represent inserted/wrapped/split nodes in
 * a ReplaceStep slice. Those are the only routine operations that can copy a
 * blockId or introduce a block whose default ID is null.
 */
function mayIntroduceBlockIdentity(tr: Transaction): boolean {
  for (const step of tr.steps) {
    if (step instanceof AttrStep) {
      if (step.attr === "blockId") return true;
      continue;
    }
    if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) {
      continue;
    }
    let found = false;
    step.slice.content.descendants((node) => {
      if (supportsBlockId(node)) found = true;
      return !found;
    });
    if (found) return true;
  }
  return false;
}

/**
 * Return an editor-ready document in which every identity-bearing block has a
 * unique session-local ID.
 *
 * The Markdown bridge deliberately remains deterministic and source-focused,
 * so it does not generate random runtime attrs. Butter calls this once at the
 * editor boundary, before `EditorState.create`. The one-pass rebuild therefore
 * cannot appear as a user transaction, enter history, or invalidate unaffected
 * DOM on the first keystroke. Existing unique IDs and all text/leaf references
 * are retained.
 */
export function ensureBlockIds(
  doc: PMNode,
  createId: BlockIdFactory = defaultBlockIdFactory,
): PMNode {
  const used = new Set<string>();

  const visit = (node: PMNode): PMNode => {
    let nextAttrs = node.attrs;
    let changed = false;

    if (supportsBlockId(node)) {
      const current = (node.attrs as { blockId?: unknown }).blockId;
      if (usableBlockId(current) && !used.has(current)) {
        used.add(current);
      } else {
        const nextId = freshBlockId(createId, used);
        used.add(nextId);
        nextAttrs = { ...node.attrs, blockId: nextId };
        changed = true;
      }
    }

    if (node.childCount === 0) {
      return changed
        ? node.type.create(nextAttrs, node.content, node.marks)
        : node;
    }

    const children: PMNode[] = [];
    node.forEach((child) => {
      const nextChild = visit(child);
      children.push(nextChild);
      if (nextChild !== child) changed = true;
    });

    return changed
      ? node.type.create(nextAttrs, Fragment.fromArray(children), node.marks)
      : node;
  };

  return visit(doc);
}

export function blockIdStamperPlugin(
  createId: BlockIdFactory = defaultBlockIdFactory,
): PMPlugin {
  return new PMPlugin({
    key,
    appendTransaction(transactions, _oldState, newState) {
      // Skip if any transaction is itself a stamping pass (avoid loops)
      if (transactions.some((tr) => tr.getMeta(key))) return null;
      // Text insertion/deletion, marks, selection, and ordinary attrs cannot
      // introduce an identity. This is the steady typing hot path: O(steps),
      // independent of document size.
      if (!transactions.some(mayIntroduceBlockIdentity)) return null;

      const tr = newState.tr;
      const used = new Set<string>();
      let stamped = false;
      newState.doc.descendants((node, pos) => {
        if (!supportsBlockId(node)) return;
        const current = (node.attrs as { blockId?: unknown }).blockId;
        if (usableBlockId(current) && !used.has(current)) {
          used.add(current);
          return;
        }
        const nextId = freshBlockId(createId, used);
        used.add(nextId);
        tr.setNodeAttribute(pos, "blockId", nextId);
        stamped = true;
      });
      if (!stamped) return null;
      tr.setMeta(key, true);
      tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}
