/**
 * Extract CM6 atomic ranges from the mirror view and enforce them
 * inside PM.
 *
 * "Atomic" in CM6 means: when the caret lands inside this range
 * during arrow-key navigation or deletion, the whole range is treated
 * as one unit - the caret hops over it, delete removes the entire
 * range.
 *
 * PM has no global facet for this. We approximate by registering a
 * keymap plugin that handles ArrowLeft / ArrowRight / Backspace /
 * Delete by checking if the new caret position would fall inside a
 * known atomic range (translated to PM positions via the source
 * map). If so, we skip past.
 */
import type { EditorView as CMView } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { Plugin as PMPlugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView as PMView } from "prosemirror-view";

import { SourceMap, mdToPM } from "./source-map";

export interface AtomicRange {
  from: number;
  to: number;
}

/** Read the current CM6 atomicRanges from the mirror and translate to PM. */
export function extractAtomicRangesPM(
  cmView: CMView,
  sourceMap: SourceMap,
  docSize: number,
): AtomicRange[] {
  const out: AtomicRange[] = [];
  try {
    const providers = cmView.state.facet(EditorView.atomicRanges);
    for (const p of providers) {
      const set = typeof p === "function" ? p(cmView) : p;
      if (!set) continue;
      const iter = set.iter();
      while (iter.value) {
        const pmFrom = Math.min(
          Math.max(0, mdToPM(sourceMap, iter.from)),
          docSize,
        );
        const pmTo = Math.min(
          Math.max(pmFrom, mdToPM(sourceMap, iter.to)),
          docSize,
        );
        if (pmTo > pmFrom) out.push({ from: pmFrom, to: pmTo });
        iter.next();
      }
    }
  } catch (e) {
    console.error("[butter-cm6-bridge] atomicRanges extraction:", e);
  }
  return out;
}

// ═══════════════════════════════════════════
//  PM enforcement plugin
// ═══════════════════════════════════════════

const atomicKey = new PluginKey<AtomicRange[]>("butter-cm6-atomic");

export function atomicRangesPlugin(
  getRanges: () => AtomicRange[],
): PMPlugin<AtomicRange[]> {
  return new PMPlugin<AtomicRange[]>({
    key: atomicKey,
    props: {
      handleKeyDown(view, event) {
        const ranges = getRanges();
        if (!ranges.length) return false;
        const action = classifyKey(event);
        if (!action) return false;
        return handleAtomic(view, ranges, action, event);
      },
    },
  });
}

type Dir = "left" | "right";
interface KeyAction {
  dir: Dir;
  extend: boolean;   // Shift held - extend selection instead of moving caret
  del: boolean;      // Backspace / Delete
}

function classifyKey(event: KeyboardEvent): KeyAction | null {
  if (event.key === "ArrowLeft")
    return { dir: "left", extend: event.shiftKey, del: false };
  if (event.key === "ArrowRight")
    return { dir: "right", extend: event.shiftKey, del: false };
  if (event.key === "Backspace")
    return { dir: "left", extend: false, del: true };
  if (event.key === "Delete")
    return { dir: "right", extend: false, del: true };
  return null;
}

/**
 * Find an atomic range that the caret/selection edge is about to
 * enter, given the direction of motion.
 */
function rangeAtEdge(
  ranges: AtomicRange[],
  head: number,
  dir: Dir,
): AtomicRange | null {
  const target = dir === "right" ? head : head - 1;
  for (const r of ranges) {
    if (head >= r.from && head < r.to) return r;
    if (dir === "right" && target >= r.from && target < r.to) return r;
    if (dir === "left" && target >= r.from && target < r.to) return r;
  }
  return null;
}

function handleAtomic(
  view: PMView,
  ranges: AtomicRange[],
  action: KeyAction,
  event: KeyboardEvent,
): boolean {
  const sel = view.state.selection;
  const docSize = view.state.doc.content.size;
  const forward = action.dir === "right";

  // Determine the edge that is about to move.
  const movingHead = action.extend ? sel.head : forward ? sel.to : sel.from;

  const hit = rangeAtEdge(ranges, movingHead, action.dir);
  if (!hit) return false;

  event.preventDefault();

  // ── Delete: replace whole atomic range in one atomic edit ──
  if (action.del) {
    // If there's an active selection, let the default delete path
    // handle its content, then follow up with the atomic deletion
    // if the edge still sits on the atomic range.
    const from = sel.empty ? hit.from : Math.min(sel.from, hit.from);
    const to = sel.empty ? hit.to : Math.max(sel.to, hit.to);
    const tr = view.state.tr.delete(from, to);
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  // ── Arrow: jump caret past the range ──
  const dest = forward ? hit.to : hit.from;
  const clamped = Math.max(0, Math.min(dest, docSize));
  const $dest = view.state.doc.resolve(clamped);

  if (action.extend) {
    // Shift held: extend the existing selection up to the far edge
    // of the atomic range.
    const anchor = sel.anchor;
    const newHead = clamped;
    const $anchor = view.state.doc.resolve(anchor);
    const $head = view.state.doc.resolve(newHead);
    const newSel = new TextSelection($anchor, $head);
    view.dispatch(view.state.tr.setSelection(newSel).scrollIntoView());
    return true;
  }

  const near = TextSelection.near($dest, forward ? 1 : -1);
  view.dispatch(view.state.tr.setSelection(near).scrollIntoView());
  return true;
}
