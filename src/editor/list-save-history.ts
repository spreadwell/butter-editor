import { Plugin, PluginKey } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { normalizeFlatListChildrenForPresentation } from "../core/doc-normalize";
import { changedRangesInFinalDoc } from "./changed-ranges";

const key = new PluginKey("listSaveHistory");

/** Native text edits can change the list attrs required by Markdown. Keep
 * their previous values in the same Undo event, without changing the edit's
 * presentation. A later nonhistorical save may otherwise make an empty
 * nested marker's forced blank line survive Undo of the character deletion.
 */
export function listSaveHistoryPlugin(): Plugin {
  return new Plugin({
    key,
    appendTransaction(transactions, _oldState, newState) {
      if (transactions.some((tr) => tr.getMeta(key))) return null;
      if (!transactions.some((tr) => tr.docChanged && tr.getMeta("addToHistory") !== false)) {
        return null;
      }
      const ranges = changedRangesInFinalDoc(transactions, newState.doc);
      if (!ranges.length) return null;
      const containers = new Map<number, PMNode>();
      for (const range of ranges) {
        for (const position of [range.from, range.to]) {
          const $pos = newState.doc.resolve(position);
          for (let depth = 0; depth <= $pos.depth; depth++) {
            containers.set($pos.start(depth), $pos.node(depth));
          }
        }
        newState.doc.nodesBetween(range.from, range.to, (node, pos) => {
          if (!node.isLeaf) containers.set(pos + 1, node);
        });
      }
      const tr = newState.tr;
      for (const [start, parent] of containers) {
        const normalized = normalizeFlatListChildrenForPresentation(parent, newState.schema);
        if (!normalized) continue;
        let position = start;
        for (let index = 0; index < parent.childCount; index++) {
          const child = parent.child(index);
          const target = normalized.child(index);
          if (child.type.name === "list_item") {
            for (const name of ["depth", "start", "tight"]) {
              if (child.attrs[name] !== target.attrs[name]) {
                // An intentional no-op AttrStep has an empty position map,
                // but its inverse restores this value after save changes it.
                tr.setNodeAttribute(position, name, child.attrs[name]);
              }
            }
          }
          position += child.nodeSize;
        }
      }
      if (!tr.steps.length) return null;
      if (newState.storedMarks !== null) tr.setStoredMarks(newState.storedMarks);
      return tr.setMeta(key, true);
    },
  });
}
