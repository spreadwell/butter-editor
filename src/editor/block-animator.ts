/**
 * Block animator — engine for smooth transitions on doc changes.
 *
 * INFRASTRUCTURE ONLY. No animations are implemented yet. The
 * pieces in place:
 *
 *   1. dispatchTransaction wrap — every doc-changing transaction
 *      runs through here.
 *   2. Pre-dispatch hook — captures the visual state about to be
 *      replaced. The default `snapshotPositions` collects every
 *      block's viewport top keyed by blockId.
 *   3. Post-dispatch hook — runs after PM has updated the DOM,
 *      BSP has recomputed margins, etc. The new doc is in place.
 *      This is where animation code lives, but it's currently empty.
 *
 * To add an animation, edit the empty `runAnimations` function
 * below. You have:
 *   - the EditorView (for nodeDOM lookups)
 *   - the pre-dispatch position snapshot (Map<blockId, top>)
 *   - a set of blockIds to skip (from the BLOCK_ANIMATOR_SKIP_IDS
 *     transaction meta — the drag engine uses this to skip blocks
 *     that the ghost is covering)
 *
 * Why blockIds (and not element identity, not doc position):
 *   PM may recycle, recreate, or move DOM elements during
 *   reconciliation — element identity is unreliable. Position
 *   mapping has edge cases for delete+insert. blockId attrs survive
 *   every transaction because the move transaction clones
 *   node.attrs, and the auto-stamper plugin fills in any block
 *   missing an ID.
 *
 * Markdown source purity: untouched. blockIds are session-only,
 * never serialized.
 */
import { Plugin as PMPlugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

const key = new PluginKey("butter-block-animator");

/** Transaction meta key: caller passes `string[]` of blockIds to
 *  EXCLUDE from animation on this transaction. */
export const BLOCK_ANIMATOR_SKIP_IDS = "blockAnimator.skipIds";

/** Walk all block-level descendants (including those inside callouts,
 *  blockquotes, list-item content) and call `visit(node, pos)` on
 *  each one that has a blockId. */
function walkBlocks(
  doc: PMNode,
  visit: (node: PMNode, pos: number) => void,
): void {
  doc.descendants((node, pos) => {
    if (!node.type.isBlock) return;
    const id = node.attrs.blockId as string | null;
    if (id) visit(node, pos);
  });
}

/** Snapshot every block's current viewport top by blockId. */
function snapshotPositions(view: EditorView): Map<string, number> {
  const out = new Map<string, number>();
  walkBlocks(view.state.doc, (node, pos) => {
    const id = node.attrs.blockId as string;
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      out.set(id, dom.getBoundingClientRect().top);
    }
  });
  return out;
}

/** This is where animations go. Currently empty — clean slate.
 *
 *  Inputs:
 *    - `view`: the editor (for DOM lookups via `view.nodeDOM(pos)`)
 *    - `oldPositions`: each block's viewport top from BEFORE the
 *      dispatch, keyed by blockId
 *    - `skipIds`: blockIds to skip (e.g. dragged blocks covered by
 *      a ghost)
 *
 *  To compare old vs new positions:
 *    walkBlocks(view.state.doc, (node, pos) => {
 *      const id = node.attrs.blockId as string;
 *      if (skipIds.has(id)) return;
 *      const oldTop = oldPositions.get(id);
 *      if (oldTop == null) return;            // new block
 *      const dom = view.nodeDOM(pos);
 *      if (!(dom instanceof HTMLElement)) return;
 *      const newTop = dom.getBoundingClientRect().top;
 *      const dy = oldTop - newTop;
 *      if (Math.abs(dy) < 1) return;           // didn't move
 *      // ... do something here ...
 *    });
 */
function runAnimations(
  view: EditorView,
  oldPositions: Map<string, number>,
  skipIds: Set<string>,
): void {
  void view; void oldPositions; void skipIds;
  // empty
}

// runAnimations is currently a no-op (animations are disabled). While
// it stays empty, skip snapshotPositions entirely. snapshotPositions
// runs getBoundingClientRect over every block on each doc change, which
// is hundreds of ms of forced layout in large notes (it dominated the
// drag-drop freeze) for an animation that never plays. Flip this to
// true when runAnimations is implemented.
const ANIMATIONS_ENABLED = false;

export function blockAnimatorPlugin(): PMPlugin {
  return new PMPlugin({
    key,
    view(editorView) {
      const originalDispatch = editorView.dispatch.bind(editorView);
      editorView.dispatch = (tr) => {
        if (!ANIMATIONS_ENABLED || !tr.docChanged) {
          originalDispatch(tr);
          return;
        }
        const skipIdsArr = tr.getMeta(BLOCK_ANIMATOR_SKIP_IDS) as
          | string[]
          | undefined;
        const skipIds = new Set(skipIdsArr ?? []);
        const snapshot = snapshotPositions(editorView);
        originalDispatch(tr);
        runAnimations(editorView, snapshot, skipIds);
      };
      return {
        destroy() {
          editorView.dispatch = originalDispatch;
        },
      };
    },
  });
}
