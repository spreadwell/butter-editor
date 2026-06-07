/**
 * Butter-owned vertical spacing between top-level blocks.
 *
 * Native CSS produces inter-block gaps from a combination of cascade,
 * adjacency rules (`:first-child`, tight-list adjacency, etc.), and
 * margin collapse. All three are pair-dependent — block N's gap-above
 * is a function of block N-1's bottom margin AND surrounding adjacency.
 * That coupling makes layout fragile under any structural change: a
 * drag, a paste, a programmatic move can re-trigger adjacency rules
 * and visibly shift unrelated blocks.
 *
 * This plugin replaces the pair-dependent model with an explicit one.
 * Every top-level block gets a `Decoration.node` whose inline `style`
 * sets `margin-top` to a CSS expression derived from the block's type,
 * its index in the doc, and its previous sibling. Values are
 * `var(--p-spacing)`, `var(--heading-spacing)`, etc. — so theme and
 * Style Settings retunes still flow through at render time. But the
 * structural dependencies are gone.
 *
 * Pairs with the flex-column rule in `styles.css` which forces
 * `margin-bottom: 0` on every top-level child, so each block's
 * gap-above is exactly its own `margin-top` — no `max(prev.mb, next.mt)`
 * collapse, no surprises.
 */
import { Plugin as PMPlugin, PluginKey, EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

const key = new PluginKey<DecorationSet>("butter-block-spacing");

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

/** Compute the `margin-top` CSS expression for one block. Exported so
 *  the drag-handles drop-prediction can resolve the SAME rule to pixels
 *  rather than keeping a hand-mirrored copy that silently drifts. */
export function gapAbove(node: PMNode, prev: PMNode | null, index: number): string {
  if (index === 0) return "0px";

  switch (node.type.name) {
    case "heading":
      return "var(--heading-spacing, 2.5rem)";

    case "list_item":
      // Constant 8px (half of standard p-spacing) regardless of
      // tight/loose OR what came before. Drops the on/off dynamic
      // between tight (0px) and loose (16px) — feels more even
      // and doesn't shift adjacency during edit.
      return "8px";

    case "footnote_def":
      if (prev && prev.type.name === "footnote_def") {
        return "var(--p-spacing, 1em)";
      }
      return "var(--heading-spacing, 2.5rem)";

    default:
      return "var(--p-spacing, 1em)";
  }
}

function buildSpacingDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  let prev: PMNode | null = null;
  let index = 0;
  state.doc.forEach((node, offset) => {
    if (EXCLUDED_BLOCK_TYPES.has(node.type.name)) return;
    const mt = gapAbove(node, prev, index);
    // list_item uses `padding-top` for the gap above (with margin-top
    // forced to 0) so the item's indent-guide background spans the
    // full gap region, not just the content area. `--li-pad-top` is
    // also exposed so the absolutely-positioned marker (::before) can
    // shift down by the same amount and stay aligned with the first
    // line of content rather than floating at the box top. Other
    // block types keep `margin-top`.
    const style = node.type.name === "list_item"
      ? `padding-top: ${mt}; margin-top: 0; --li-pad-top: ${mt};`
      : `margin-top: ${mt};`;
    decos.push(
      Decoration.node(offset, offset + node.nodeSize, { style }),
    );
    prev = node;
    index++;
  });
  return DecorationSet.create(state.doc, decos);
}

export function blockSpacingPlugin(): PMPlugin<DecorationSet> {
  return new PMPlugin<DecorationSet>({
    key,
    state: {
      init(_config, state) {
        return buildSpacingDecorations(state);
      },
      apply(tr, value, _oldState, newState) {
        if (!tr.docChanged) return value;
        return buildSpacingDecorations(newState);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
