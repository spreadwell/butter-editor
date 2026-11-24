/**
 * Marks the first visible top-level block.
 *
 * The root flow keeps every gap on the following block, so the first block a
 * reader can see has to drop its own. `styles.css` used to find that block
 * with `:nth-child(1 of ...)`, but a positional selector evaluated against the
 * editor root makes Chromium restyle every block of the note whenever a block
 * is inserted or removed (about 170ms per Enter in a 3,000-block note). One
 * node decoration carries the same fact as a class instead.
 *
 * This does not reopen the cost `block-spacing.ts` warns about: that is one
 * root decoration per block, this is one for the whole document, and edits
 * that leave the first block in place keep the mapped set.
 *
 * Hidden source comments create no box, so they are skipped like the
 * selector skipped them.
 */
import { Plugin as PMPlugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
/** Node types that render no box of their own in the root flow. The spacing
 * contract in `block-spacing.ts` skips the same ones. */
export const EXCLUDED_BLOCK_TYPES = new Set([
  "image",
  "hard_break",
  "block_id",
  "obsidian_tag",
  "wikilink",
  "inline_math",
  "inline_footnote",
  "footnote_ref",
  "block_comment",
]);

export const FIRST_VISIBLE_BLOCK_CLASS = "butter-first-block";

const key = new PluginKey<DecorationSet>("butter-first-visible-block");

/** The first top-level block that renders a box, with its position. */
export function firstVisibleBlock(
  doc: PMNode,
): { pos: number; node: PMNode } | null {
  let pos = 0;
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    if (!EXCLUDED_BLOCK_TYPES.has(node.type.name)) return { pos, node };
    pos += node.nodeSize;
  }
  return null;
}

function buildDecorations(doc: PMNode): DecorationSet {
  const first = firstVisibleBlock(doc);
  if (!first) return DecorationSet.empty;
  return DecorationSet.create(doc, [
    Decoration.node(first.pos, first.pos + first.node.nodeSize, {
      class: FIRST_VISIBLE_BLOCK_CLASS,
    }),
  ]);
}

export function firstVisibleBlockPlugin(): PMPlugin {
  return new PMPlugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => buildDecorations(state.doc),
      apply(tr, old, _oldState, newState) {
        if (!tr.docChanged) return old;
        const first = firstVisibleBlock(newState.doc);
        const mapped = old.map(tr.mapping, tr.doc);
        const marked = mapped.find();
        if (
          first &&
          marked.length === 1 &&
          marked[0].from === first.pos &&
          marked[0].to === first.pos + first.node.nodeSize
        ) {
          return mapped;
        }
        return buildDecorations(newState.doc);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
