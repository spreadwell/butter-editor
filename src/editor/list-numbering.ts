/**
 * Ordered-list numbering for the flat list_item schema.
 *
 * Lists in the new schema have no `<ol>` container - each item is a
 * top-level block carrying `kind: "ordered"` and `depth`. The visible
 * number for each item depends on its position in a contiguous run of
 * `kind="ordered"` items at the same depth, anchored at the run's
 * first item's `start` attr (default 1).
 *
 * This plugin walks the doc on every state change, computes the
 * number for every ordered list_item, and stamps it on the DOM via
 * a `Decoration.node` with `data-number`. CSS reads it back via
 * `content: attr(data-number) "."` on the `::before`. Cheap walk
 * (one pass) and the decorations are diffed by PM, so we don't
 * thrash the DOM.
 *
 * Same-depth runs are detected by walking back through siblings,
 * skipping deeper-nested items (which are CHILDREN of an earlier
 * shallower item visually, so they don't break the parent's run).
 * This matches how the markdown serializer counts numbers.
 */
import { Plugin as PMPlugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

const key = new PluginKey<DecorationSet>("butter-list-numbering");

/**
 * Compute the rendered number for the ordered list_item at `node`,
 * positioned at index `index` in its `parent` (typically the doc, or
 * any container with `block+` content).
 *
 * Walks back through `parent`'s children, skipping items at greater
 * depth (those are nested under an earlier sibling and don't
 * participate in this depth's run). Stops at a non-list-item, a
 * shallower item, or an item of a different kind at the same depth
 * - that boundary defines the start of this item's run. Number =
 * run-start's `start` attr + offset within the run.
 */
function computeNumber(
  node: PMNode,
  parent: PMNode,
  index: number,
): number {
  let firstIdx = index;
  let i = index - 1;
  while (i >= 0) {
    const p = parent.child(i);
    if (p.type.name !== "list_item") break;
    if (p.attrs.depth > node.attrs.depth) {
      i--;
      continue;
    }
    if (p.attrs.depth < node.attrs.depth) break;
    if (p.attrs.kind !== "ordered") break;
    firstIdx = i;
    i--;
  }
  const firstStart =
    (parent.child(firstIdx).attrs.start as number | null) ?? 1;
  let count = 0;
  for (let j = firstIdx; j <= index; j++) {
    const p = parent.child(j);
    if (
      p.type.name === "list_item" &&
      p.attrs.kind === "ordered" &&
      p.attrs.depth === node.attrs.depth
    ) {
      count++;
    }
  }
  return firstStart + count - 1;
}

/**
 * Walk every block-container in the doc (the doc itself, plus
 * blockquotes, callouts, table cells - anything with a `block+` /
 * `block*` content spec that can hold list_items) and collect a
 * decoration per ordered list_item. Each decoration just sets the
 * `data-number` attr on the item's outer DOM; CSS does the rest.
 */
function buildDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  const visit = (parent: PMNode, parentPos: number) => {
    parent.forEach((child, offset, index) => {
      const here = parentPos + offset;
      if (child.type.name === "list_item") {
        if (child.attrs.kind === "ordered") {
          const n = computeNumber(child, parent, index);
          decos.push(
            Decoration.node(here, here + child.nodeSize, {
              "data-number": String(n),
            }),
          );
        }
        // list_item content can hold non_list_blocks (callouts, etc.)
        // which themselves can hold more list_items - recurse.
        visit(child, here + 1);
      } else if (child.type.spec.content) {
        // Other block containers: recurse to find nested list_items.
        // We could narrow to specific types, but a generic recursion
        // is robust to extension blocks adding new containers.
        visit(child, here + 1);
      }
    });
  };
  visit(state.doc, 0);
  return DecorationSet.create(state.doc, decos);
}

export function listNumberingPlugin(): PMPlugin {
  return new PMPlugin<DecorationSet>({
    key,
    state: {
      init(_, state) {
        return buildDecorations(state);
      },
      apply(tr, old, _oldState, newState) {
        if (!tr.docChanged) return old;
        // Cheap path: no list_items in the changed ranges → just remap.
        // For now, rebuild on every doc change. Numbering is a global
        // computation anyway (an edit elsewhere can shift numbers in
        // an ordered run via insertion/deletion of items), and the
        // walk is O(N).
        return buildDecorations(newState);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
