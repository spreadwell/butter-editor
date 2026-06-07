/**
 * Overlap-resolver plugin.
 *
 * CommonMark / GFM cannot represent overlapping inline marks where
 * neither range fully nests inside the other. The serializer has a
 * close-and-reopen path that handles many cross-tag cases, but
 * source-purity-first users prefer the doc never enter a state that
 * would force HTML wrappers for naturally markdown-form marks.
 *
 * This plugin keeps the doc overlap-free at transaction-end, across
 * the FULL set of resolvable inline marks (not just em / strong):
 *
 *   1. Detect interleaving ranges across every pair of mark types
 *      in the schema (em, strong, strikethrough, highlight, font,
 *      underline, superscript, subscript, kbd).
 *   2. If whitespace exists adjacent to the overlap boundaries on
 *      BOTH sides, eject those whitespace chars from the marks
 *      (smart-split). No visible formatting is lost - the marks
 *      naturally split into two adjacent runs separated by an
 *      unmarked space, which renders identically.
 *   3. If no whitespace boundary exists (mid-word overlap), clear
 *      the OLDER mark from the overlap region. The new action
 *      (whichever mark was just toggled) keeps its full range; the
 *      pre-existing mark shrinks to not overlap. Some user-authored
 *      formatting is lost, but the source stays markdown-pure.
 *
 * Runs as `appendTransaction`. A meta key prevents re-entry. Single-
 * pass resolution suffices because conflicts are independent - we
 * only REMOVE marks (smart-split or hard-drop), never add - so
 * resolving one pair can't create a new interleave between others.
 *
 * Marks excluded from resolution:
 *   - code      atomic; never overlaps anything
 *   - link      wraps content; bold-inside-link etc. is normal nesting
 *   - comment   hidden inline; user is opting in to a non-renderable mark
 */

import { Plugin, PluginKey } from "prosemirror-state";
import type {
  MarkType,
  Node as PMNode,
  Schema,
} from "prosemirror-model";
import { AddMarkStep, RemoveMarkStep } from "prosemirror-transform";
import type { Transaction } from "prosemirror-state";

const META_KEY = "butterOverlapResolved";

interface Range {
  start: number;
  end: number;
}

// ─────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────

/** All contiguous ranges of `markType` in the doc. */
function getMarkRanges(doc: PMNode, markType: MarkType): Range[] {
  const ranges: Range[] = [];
  let current: Range | null = null;
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const has = markType.isInSet(node.marks) != null;
    if (has) {
      if (current && current.end === pos) {
        current.end = pos + node.nodeSize;
      } else {
        if (current) ranges.push(current);
        current = { start: pos, end: pos + node.nodeSize };
      }
    } else if (current) {
      ranges.push(current);
      current = null;
    }
    // Atoms (wikilink, math, etc.) are inline but isText=false.
    // Their `isInSet` check above still applies. Recurse only into
    // text-bearing block containers (default true return).
    return !node.isText;
  });
  if (current) ranges.push(current);
  return ranges;
}

/** Strict interleave: starts on opposite sides, ends on opposite sides.
 *  Equal or fully-contained ranges are NOT interleave (they're nesting). */
function rangesInterleave(a: Range, b: Range): boolean {
  return (
    (a.start < b.start && b.start < a.end && a.end < b.end) ||
    (b.start < a.start && a.start < b.end && b.end < a.end)
  );
}

/** Find the LAST whitespace character position in `[from, to)` in the
 *  doc's text content, or -1 if none. */
function findLastWhitespacePos(doc: PMNode, from: number, to: number): number {
  let result = -1;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const text = node.text || "";
    const localStart = Math.max(0, from - pos);
    const localEnd = Math.min(text.length, to - pos);
    for (let i = localStart; i < localEnd; i++) {
      if (/\s/.test(text[i])) result = pos + i;
    }
    return false;
  });
  return result;
}

/** Find the FIRST whitespace character position in `[from, to)`, or -1. */
function findFirstWhitespacePos(doc: PMNode, from: number, to: number): number {
  let result = -1;
  doc.nodesBetween(from, to, (node, pos) => {
    if (result >= 0) return false; // already found - stop
    if (!node.isText) return true; // recurse into containers (paragraph, etc.)
    const text = node.text || "";
    const localStart = Math.max(0, from - pos);
    const localEnd = Math.min(text.length, to - pos);
    for (let i = localStart; i < localEnd; i++) {
      if (/\s/.test(text[i])) {
        result = pos + i;
        return false;
      }
    }
    return false;
  });
  return result;
}

/** Mark ranges added by AddMarkStep instances in the given
 *  transactions, keyed by mark type. Used to identify which mark in
 *  a conflict is the "newer" one (preserve) vs "older" (yield). */
function getAddedRangesByType(
  transactions: readonly Transaction[],
  types: MarkType[],
): Map<MarkType, Range[]> {
  const result = new Map<MarkType, Range[]>();
  for (const t of types) result.set(t, []);
  for (const tr of transactions) {
    for (const step of tr.steps) {
      if (step instanceof AddMarkStep) {
        const list = result.get(step.mark.type);
        if (list) list.push({ start: step.from, end: step.to });
      }
    }
  }
  return result;
}

/** Did `addedRanges` include an addition that fully covers `range`? */
function wasAdded(addedRanges: Range[], range: Range): boolean {
  return addedRanges.some(
    (a) => a.start <= range.start && a.end >= range.end,
  );
}

// Mark types we resolve overlaps for. Excludes:
//   - `code`     atomic, never overlaps
//   - `link`     wrapper; nested marks inside are normal
//   - `comment`  hidden, user opted in
const RESOLVABLE_MARK_NAMES = [
  "em",
  "strong",
  "strikethrough",
  "highlight",
  "font",
  "underline",
  "superscript",
  "subscript",
  "kbd",
];

// ─────────────────────────────────────────────────────────────────
//  Plugin
// ─────────────────────────────────────────────────────────────────

export function overlapResolverPlugin(schema: Schema): Plugin {
  // Resolve to actual MarkType objects. Some of the names above may
  // not exist in this schema; just skip those.
  const types: MarkType[] = [];
  for (const name of RESOLVABLE_MARK_NAMES) {
    const t = schema.marks[name];
    if (t) types.push(t);
  }
  if (types.length < 2) {
    return new Plugin({ key: new PluginKey("butter-overlap-resolver-noop") });
  }

  return new Plugin({
    key: new PluginKey("butter-overlap-resolver"),
    appendTransaction(transactions, oldState, newState) {
      // Loop guard - skip if our own remediation re-fires.
      if (transactions.some((tr) => tr.getMeta(META_KEY))) return null;
      // Doc must have changed.
      if (newState.doc === oldState.doc) return null;
      // Must have touched marks (else no possible overlap creation).
      const touchedMarks = transactions.some((tr) =>
        tr.steps.some(
          (s) => s instanceof AddMarkStep || s instanceof RemoveMarkStep,
        ),
      );
      if (!touchedMarks) return null;

      // Per-type ranges. Computed once; reused across all pairs.
      const ranges = new Map<MarkType, Range[]>();
      for (const t of types) ranges.set(t, getMarkRanges(newState.doc, t));

      // Per-type added ranges (this transaction batch).
      const added = getAddedRangesByType(transactions, types);

      // Find every interleave across every pair of types.
      type Conflict = {
        aType: MarkType;
        aRange: Range;
        bType: MarkType;
        bRange: Range;
      };
      const conflicts: Conflict[] = [];
      for (let i = 0; i < types.length; i++) {
        for (let j = i + 1; j < types.length; j++) {
          const aType = types[i];
          const bType = types[j];
          const aList = ranges.get(aType)!;
          const bList = ranges.get(bType)!;
          for (const aRange of aList) {
            for (const bRange of bList) {
              if (rangesInterleave(aRange, bRange)) {
                conflicts.push({ aType, aRange, bType, bRange });
              }
            }
          }
        }
      }
      if (conflicts.length === 0) return null;

      const tr = newState.tr;
      let modified = false;

      for (const { aType, aRange, bType, bRange } of conflicts) {
        const aAdded = wasAdded(added.get(aType) ?? [], aRange);
        const bAdded = wasAdded(added.get(bType) ?? [], bRange);
        // Older mark yields. If both or neither were just added,
        // default to a deterministic tie-break (alphabetical by
        // type name) so behavior is reproducible across sessions.
        let olderType: MarkType;
        if (bAdded && !aAdded) olderType = aType;
        else if (aAdded && !bAdded) olderType = bType;
        else olderType = aType.name < bType.name ? aType : bType;

        // Overlap region - where both marks apply.
        const overlapStart = Math.max(aRange.start, bRange.start);
        const overlapEnd = Math.min(aRange.end, bRange.end);

        // Whichever range extends BEFORE the overlap has its tail
        // inside the other mark's lead - try to trim it at the last
        // whitespace before the overlap. Same logic on the AFTER
        // side: the range extending past the overlap has its head
        // inside the other mark's tail.
        const beforeRange =
          aRange.start < bRange.start ? aRange : bRange;
        const afterRange =
          aRange.end > bRange.end ? aRange : bRange;
        const beforeType =
          aRange.start < bRange.start ? aType : bType;
        const afterType =
          aRange.end > bRange.end ? aType : bType;

        const wsBefore = findLastWhitespacePos(
          newState.doc,
          beforeRange.start,
          overlapStart,
        );
        const wsAfter = findFirstWhitespacePos(
          newState.doc,
          overlapEnd,
          afterRange.end,
        );

        if (wsBefore >= 0 && wsAfter >= 0) {
          // Smart-split: clear the trim points on each side. The
          // marks naturally split into adjacent runs separated by
          // an unmarked space - no visible formatting loss.
          tr.removeMark(wsBefore, wsBefore + 1, beforeType);
          tr.removeMark(wsAfter, wsAfter + 1, afterType);
          modified = true;
        } else {
          // No clean whitespace boundary - clear the older mark
          // from the overlap region. The newer mark keeps its full
          // range; the older one shrinks. User-authored formatting
          // is lost in the overlap, but the source stays markdown-
          // pure.
          tr.removeMark(overlapStart, overlapEnd, olderType);
          modified = true;
        }
      }

      if (!modified) return null;
      tr.setMeta(META_KEY, true);
      return tr;
    },
  });
}
