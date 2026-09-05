import type { Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";

export interface ChangedRange {
  from: number;
  to: number;
}

/**
 * Return the ranges touched by a sequence of transactions, mapped into the
 * final document. Mark-only steps intentionally contribute no range because
 * they cannot create structural normalization work.
 */
export function changedRangesInFinalDoc(
  transactions: readonly Transaction[],
  finalDoc: PMNode,
): ChangedRange[] {
  const ranges: ChangedRange[] = [];

  for (let transactionIndex = 0; transactionIndex < transactions.length; transactionIndex++) {
    const transaction = transactions[transactionIndex];
    if (!transaction.docChanged) continue;

    const maps = transaction.mapping.maps;
    for (let mapIndex = 0; mapIndex < maps.length; mapIndex++) {
      maps[mapIndex].forEach((_oldFrom, _oldTo, newFrom, newTo) => {
        const remaining = transaction.mapping.slice(mapIndex + 1);
        let from = remaining.map(newFrom, -1);
        let to = remaining.map(newTo, 1);

        for (let laterIndex = transactionIndex + 1; laterIndex < transactions.length; laterIndex++) {
          const later = transactions[laterIndex].mapping;
          from = later.map(from, -1);
          to = later.map(to, 1);
        }

        const lower = Math.max(0, Math.min(from, to) - 1);
        const upper = Math.min(finalDoc.content.size, Math.max(from, to) + 1);
        ranges.push({ from: lower, to: Math.max(lower, upper) });
      });
    }
  }

  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: ChangedRange[] = [{ ...ranges[0] }];
  for (let index = 1; index < ranges.length; index++) {
    const range = ranges[index];
    const previous = merged[merged.length - 1];
    if (range.from <= previous.to + 1) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}
