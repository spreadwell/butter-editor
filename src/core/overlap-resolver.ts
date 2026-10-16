import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { allowsInlineMark } from "./inline-mark-policy";

const META_KEY = "butterOverlapResolved";

/** Final changed ranges, including zero-map mark/attribute steps. Ordinary
 * typing checks its insertion seam rather than rescanning a long note. */
function changedRanges(transactions: readonly Transaction[], size: number): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  transactions.forEach((tr, transactionIndex) => {
    tr.steps.forEach((step, stepIndex) => {
      const later = tr.mapping.slice(stepIndex + 1);
      const map = (position: number, association: number): number => {
        let result = later.map(position, association);
        for (let index = transactionIndex + 1; index < transactions.length; index++) result = transactions[index].mapping.map(result, association);
        return Math.max(0, Math.min(size, result));
      };
      const add = (from: number, to: number): void => {
        const start = map(from, -1);
        ranges.push({ from: start, to: Math.max(start, map(to, 1)) });
      };
      let mapped = false;
      step.getMap().forEach((_oldFrom, _oldTo, from, to) => { mapped = true; add(from, to); });
      if (mapped) return;
      const range = step as unknown as { from?: number; to?: number; pos?: number };
      if (typeof range.from === "number" && typeof range.to === "number") add(range.from, range.to);
      else if (typeof range.pos === "number") add(range.pos, range.pos + 1);
      else add(0, size);
    });
  });
  return ranges;
}

/** Compatibility entry point for the inline mark policy. Interleaved authored
 * mark ranges are valid live content: the serializer owns their exact native
 * representation. Adding a mark must not shrink an older mark or eject its
 * spaces merely to prefer Markdown delimiters over supported HTML.
 *
 * Only atom-specific mark restrictions are reconciled here. UI commands and
 * exact clipboard import enforce those same restrictions before dispatch. */
export function overlapResolverPlugin(_schema: Schema): Plugin {
  return new Plugin({
    key: new PluginKey("butter-overlap-resolver"),
    appendTransaction(transactions, oldState, newState) {
      if (transactions.some(tr => tr.getMeta(META_KEY)) || newState.doc === oldState.doc) return null;
      const tr = newState.tr;
      const inspected = new Set<number>();
      const inspect = (node: PMNode, pos: number): boolean => {
        if (!node.isInline) return true;
        if (inspected.has(pos)) return false;
        inspected.add(pos);
        for (const mark of node.marks) if (!allowsInlineMark(node, mark)) tr.removeMark(pos, pos + node.nodeSize, mark);
        return false;
      };
      for (const { from, to } of changedRanges(transactions, newState.doc.content.size)) {
        if (from < to) newState.doc.nodesBetween(from, to, inspect);
        else { const node = newState.doc.nodeAt(from); if (node) inspect(node, from); }
      }
      return tr.docChanged ? tr.setMeta(META_KEY, true) : null;
    },
  });
}
