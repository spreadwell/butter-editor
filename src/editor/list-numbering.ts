/**
 * Ordered-list numbering and accessibility metadata for the flat list schema.
 *
 * Lists in the new schema have no `<ol>` container - each item is a
 * top-level block carrying `kind: "ordered"` and `depth`. The visible
 * number for each item depends on its position in a contiguous run of
 * `kind="ordered"` items at the same depth, anchored at the run's
 * first item's `start` attr (default 1).
 *
 * This plugin walks the doc on every document change, computes ordered markers,
 * and restores the list/listitem accessibility relationship that the flat DOM
 * cannot express structurally. Node and widget decorations keep both concerns
 * inside ProseMirror's owned rendering path. The walk is one pass and stable
 * block IDs let ProseMirror retain unaffected DOM.
 *
 * Same-depth runs are detected by walking back through siblings,
 * skipping deeper-nested items (which are CHILDREN of an earlier
 * shallower item visually, so they don't break the parent's run).
 * This matches how the markdown serializer counts numbers.
 */
import { Plugin as PMPlugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { flatListLayoutFor } from "../core/list-layout";

const key = new PluginKey<DecorationSet>("butter-list-numbering");
let nextAccessibilityScope = 0;

function accessibleIdPart(value: unknown, fallback: number): string {
  const source = typeof value === "string" && value.length > 0
    ? value
    : `pos-${fallback}`;
  return Array.from(source, (character) =>
    /^[A-Za-z0-9_-]$/.test(character)
      ? character
      : `_u${character.codePointAt(0)?.toString(16) ?? "0"}_`
  ).join("");
}

function markerWidget(
  pos: number,
  text: string,
  itemId: string,
): Decoration {
  return Decoration.widget(
    pos,
    (view) => {
      const marker = view.dom.ownerDocument.win.createSpan();
      marker.className = "butter-list-marker";
      marker.contentEditable = "false";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = text;
      return marker;
    },
    {
      side: -1,
      key: `${itemId}-marker-${text}`,
      ignoreSelection: true,
      stopEvent: () => true,
    },
  );
}

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
/**
 * Walk every block-container in the doc (the doc itself, plus
 * blockquotes, callouts, table cells - anything with a `block+` /
 * `block*` content spec that can hold list_items) and collect a
 * decorations for each list_item. Ordered items receive `data-number`; every
 * item receives exact list semantics and belongs to one contiguous-run owner.
 */
function buildDecorations(
  state: EditorState,
  accessibilityScope: string,
): DecorationSet {
  const decos: Decoration[] = [];
  const visit = (parent: PMNode, parentPos: number) => {
    const layout = flatListLayoutFor(parent);
    let runStart: number | null = null;
    let ownedItemIds: string[] = [];

    const flushAccessibleRun = () => {
      if (runStart === null || ownedItemIds.length === 0) return;
      const ownerIds = ownedItemIds.join(" ");
      const ownerKey = `${accessibilityScope}-owner-${ownedItemIds.join("_")}`;
      decos.push(
        Decoration.widget(
          runStart,
          (view) => {
            const owner = view.dom.ownerDocument.win.createSpan();
            owner.className = "butter-list-a11y-owner";
            owner.contentEditable = "false";
            owner.setAttribute("role", "list");
            owner.setAttribute("aria-owns", ownerIds);
            return owner;
          },
          { side: -1, key: ownerKey, ignoreSelection: true },
        ),
      );
      runStart = null;
      ownedItemIds = [];
    };

    parent.forEach((child, offset, index) => {
      const here = parentPos + offset;
      if (child.type.name === "list_item") {
        if (runStart === null) runStart = here;
        const itemId = `${accessibilityScope}-item-${accessibleIdPart(child.attrs.blockId, here)}`;
        ownedItemIds.push(itemId);
        const attrs: Record<string, string> = {
          id: itemId,
          role: "listitem",
          "aria-level": String(
            (layout[index]?.effectiveDepth ??
              Math.max(0, Number(child.attrs.depth) || 0)) + 1,
          ),
        };
        if (child.attrs.kind === "ordered") {
          const n = layout[index]?.markerNumber ?? 1;
          attrs["data-number"] = String(n);
          decos.push(markerWidget(here + 2, `${n}.`, itemId));
        } else if (child.attrs.kind === "bullet") {
          decos.push(markerWidget(here + 2, "•", itemId));
        }
        decos.push(Decoration.node(here, here + child.nodeSize, attrs));
        // list_item content can hold non_list_blocks (callouts, etc.)
        // which themselves can hold more list_items - recurse.
        visit(child, here + 1);
      } else if (child.type.spec.content) {
        flushAccessibleRun();
        // Other block containers: recurse to find nested list_items.
        // We could narrow to specific types, but a generic recursion
        // is robust to extension blocks adding new containers.
        visit(child, here + 1);
      } else {
        flushAccessibleRun();
      }
    });
    flushAccessibleRun();
  };
  visit(state.doc, 0);
  return DecorationSet.create(state.doc, decos);
}

export function listNumberingPlugin(): PMPlugin {
  const accessibilityScope = `butter-list-${++nextAccessibilityScope}`;
  return new PMPlugin<DecorationSet>({
    key,
    state: {
      init(_, state) {
        return buildDecorations(state, accessibilityScope);
      },
      apply(tr, old, _oldState, newState) {
        if (!tr.docChanged) return old;
        // Cheap path: no list_items in the changed ranges → just remap.
        // For now, rebuild on every doc change. Numbering is a global
        // computation anyway (an edit elsewhere can shift numbers in
        // an ordered run via insertion/deletion of items), and the
        // walk is O(N).
        return buildDecorations(newState, accessibilityScope);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
