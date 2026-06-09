/**
 * Click-to-spawn: clicking in the whitespace between blocks spawns an
 * ephemeral empty paragraph with the cursor in it. Typing populates
 * and commits; blurring or pressing Esc while empty dismisses without
 * writing anything to the doc.
 *
 * Why: Obsidian Live Preview lets you click anywhere and the cursor
 * lands on a line, even a blank one. Butter's block model doesn't have
 * cursor-addressable blank lines (blank lines are inter-block gap
 * bytes, not PM nodes), so a click on empty space between two blocks
 * currently does nothing. This plugin bridges the gap: the inter-block
 * whitespace becomes a clickable "start typing here" target, matching
 * LP's muscle memory without introducing empty-paragraph nodes that
 * would collide with markdown semantics.
 *
 * Ephemerality: the spawned paragraph is a real PM node (so selection,
 * undo, input rules, keyboard all work unmodified), but the plugin
 * tracks it in PluginState. If the user blurs or hits Esc while the
 * paragraph is still empty, a dismiss transaction removes it. Once
 * the user types anything, the plugin clears tracking - the paragraph
 * is confirmed as a permanent doc member.
 *
 * Hit-test model:
 *   - top-level blocks have DOM bounding rects (via view.nodeDOM).
 *   - a click's Y coordinate between `blockN.bottom` and
 *     `block(N+1).top` is an inter-block gap hit → insert at
 *     position-after-blockN.
 *   - clicks below the last block spawn at doc end.
 *   - clicks ABOVE the first block are ignored (no spawn). The first
 *     block of a note is the title-adjacent anchor; spawning a stray
 *     paragraph above it pushes content down and makes the layout
 *     feel unstable. Below the last block is still in - that's the
 *     natural "add a new line at the bottom" affordance.
 *   - clicks inside any block's rect fall through to normal PM
 *     handling (cursor positioning, selection, etc.).
 *
 * Interactions:
 *   - drag handles (class `butter-drag-handle`): click event.target
 *     lands on the handle, not the content container - our rect-based
 *     hit test doesn't trigger.
 *   - modifier keys (ctrl/meta/shift/alt): skip - those are usually
 *     select/extend/multi-cursor gestures.
 *   - right-click / middle-click: skip.
 *   - successive clicks in different gaps while an ephemeral is still
 *     empty: the old empty one is deleted before the new one spawns.
 *
 * Hover affordance:
 *   A subtle horizontal line follows the cursor when hovering an
 *   inter-block gap, signaling "click here to insert a paragraph".
 *   Single shared element on document.body, fixed-positioned so we
 *   don't mutate PM's DOM. Hidden on mouseleave / mousedown / scroll.
 *
 * Auto-dismiss on selection-leave:
 *   appendTransaction watches selection. The moment the selection
 *   moves OUTSIDE an empty ephemeral (e.g., user clicks another
 *   block, presses arrow keys, search jumps the cursor), we delete
 *   the orphan empty paragraph. Complements the blur handler, which
 *   only catches focus-leaves-editor - selection moves within the
 *   editor don't fire blur.
 */

import { Plugin, PluginKey, TextSelection, NodeSelection, Selection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

interface EphemeralState {
  /** PM position of the ephemeral paragraph's NODE START (inclusive).
   *  null = no ephemeral currently tracked. */
  pos: number | null;
  /** "active" while the paragraph is alive (cursor inside, awaiting
   *  user input). "leaving" once the dismiss flow has started - the
   *  node is still in the doc but rendered with a fade-out class so
   *  the CSS animation has time to play before the actual delete tr
   *  is dispatched (scheduled by the view callback). */
  phase: "active" | "leaving";
}

/** Time the OUT animation plays before the actual delete transaction
 *  is dispatched. Must match the `butter-spawn-out` keyframe duration
 *  in styles.css - keep these in lockstep. */
const LEAVE_ANIMATION_MS = 140;

const key = new PluginKey<EphemeralState>("butter-click-to-spawn");

// ─── Hit-test ─────────────────────────────────────────────────────

interface GapHit {
  /** PM position at which to insert the new paragraph (right after
   *  the preceding top-level block, or 0 for "before first block",
   *  or doc.content.size for "after last block"). */
  insertPos: number;
}

function hitTestInterBlockGap(view: EditorView, event: MouseEvent): GapHit | null {
  // Target filter: if the click landed on something that has its own
  // handler semantics (drag handle, existing selection handle,
  // resizable NodeView gripper), bail out and let that handler run.
  // Our affordance is specifically for clicks on editor BACKGROUND /
  // margin areas, not on interactive UI inside the editor.
  const target = event.target;
  if (target instanceof Element) {
    if (target.closest(".butter-drag-handle")) return null;
    if (target.closest("[data-butter-no-click-spawn]")) return null;
    // Click INSIDE a ProseMirror top-level block → let PM handle it.
    // We detect this by checking if any ancestor is a direct child of
    // the editor content DOM (view.dom).
    if (isInsideTopLevelBlock(target, view.dom)) return null;
  }

  const doc = view.state.doc;
  const n = doc.childCount;
  if (n === 0) return null;

  const clickY = event.clientY;

  // Walk top-level blocks, collecting their DOM rects. Skip blocks
  // whose DOM isn't rendered (shouldn't normally happen for top-level
  // children; defensive).
  //
  // PM position math: at the doc root, child[i] starts at the offset
  // equal to the sum of preceding children's nodeSizes. position = 0
  // is "before child[0]" and is a valid insertion slot.
  let posCursor = 0;
  const blocks: Array<{ startPos: number; endPos: number; rect: DOMRect; node: PMNode }> = [];
  for (let i = 0; i < n; i++) {
    const child = doc.child(i);
    const dom = view.nodeDOM(posCursor);
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect();
      // Skip blocks that don't take layout space. `display:none` nodes
      // (e.g., block_comment) return an all-zero rect, and including
      // them would extend "gap between blocks" to "anywhere from the
      // top of the page down to the next visible block" - the gap-
      // detect check below would mis-fire on cursor positions far
      // above the actual visible gap.
      if (rect.width !== 0 || rect.height !== 0) {
        blocks.push({
          startPos: posCursor,
          endPos: posCursor + child.nodeSize,
          rect,
          node: child,
        });
      }
    }
    posCursor += child.nodeSize;
  }

  if (blocks.length === 0) return null;

  // Above the first block: ignored. The note's first block is the
  // anchor; spawning a paragraph above it would push the rest of the
  // doc down on every stray click in the header gutter.
  if (clickY < blocks[0].rect.top) {
    return null;
  }

  // Between two adjacent blocks: clickY ∈ (block[i].bottom, block[i+1].top)
  for (let i = 0; i < blocks.length - 1; i++) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (clickY >= a.rect.bottom && clickY <= b.rect.top) {
      // Suppress the spawn when either neighbor is already an empty
      // paragraph - the user can just click INTO the existing empty
      // rather than stack another one next to it.
      if (isEmptyParagraph(a.node) || isEmptyParagraph(b.node)) return null;
      // Insert right after block a (= right before block b).
      return { insertPos: a.endPos };
    }
  }

  // Below the last block
  const last = blocks[blocks.length - 1];
  if (clickY > last.rect.bottom) {
    return { insertPos: last.endPos };
  }

  // Click fell inside some block's rect → not a gap hit.
  return null;
}

/** True for an empty top-level paragraph - the only kind of "blank
 *  block" we want to treat specially in gap-suppression. Empty
 *  callouts, empty list items, etc. are not the same affordance:
 *  they have meaningful chrome that the user might want to insert
 *  next to. We only suppress around bare empty paragraphs because
 *  the user can already click INTO an empty paragraph and start
 *  typing - no spawn needed. */
function isEmptyParagraph(node: PMNode): boolean {
  return node.type.name === "paragraph" && node.content.size === 0;
}

/** True iff `target` is nested inside one of the editor's top-level
 *  child DOMs (i.e., the click hit content, not editor margin). */
function isInsideTopLevelBlock(target: Element, editorDOM: Element): boolean {
  // Walk from target up. If we find an element whose parent is the
  // editorDOM (making this element a top-level block's DOM), the
  // click was inside a block.
  let el: Element | null = target;
  while (el && el !== editorDOM) {
    if (el.parentElement === editorDOM) return true;
    el = el.parentElement;
  }
  return false;
}

// ─── Spawn / dismiss (transaction builders) ──────────────────────

/** Build (but do not dispatch) the transaction that spawns an
 *  ephemeral empty paragraph at `insertPos`. Exported pure for
 *  testability - callers that have a view should use
 *  `spawnEphemeralParagraph` which also handles dispatch + focus. */
export function buildSpawnTransaction(
  state: EditorState,
  insertPos: number,
): Transaction {
  const paragraph = state.schema.nodes.paragraph.create();
  let tr = state.tr;
  let targetPos = insertPos;

  // If we already have an untyped ephemeral paragraph elsewhere, clean
  // it up first so we never leave orphan empties lying around.
  const prev = key.getState(state);
  if (prev && prev.pos !== null) {
    const existing = tryResolveEmptyEphemeral(state, prev.pos);
    if (existing) {
      tr = tr.delete(existing.from, existing.to);
      if (targetPos > existing.from) {
        targetPos -= existing.to - existing.from;
      }
    }
  }

  tr = tr.insert(targetPos, paragraph);
  const cursorAt = targetPos + 1;
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(cursorAt)));
  tr = tr.setMeta(key, { kind: "set", pos: targetPos });
  tr = tr.scrollIntoView();
  return tr;
}

function spawnEphemeralParagraph(
  view: EditorView,
  insertPos: number,
  onMobileUnlock: (() => void) | null,
): void {
  // On mobile the editor starts non-editable (set by main.ts on
  // keyboardWillHide and at view-open) so taps don't pop the
  // keyboard until the user explicitly signals "I want to type".
  // A click-to-spawn IS that signal - the user clicked into a
  // gap intending to write. Flip editable BEFORE dispatching so
  // PM renders the new paragraph with `contenteditable=true` from
  // the start (otherwise the caret never appears, even though the
  // selection is correctly placed in PM state). */
  onMobileUnlock?.();
  const tr = buildSpawnTransaction(view.state, insertPos);
  view.dispatch(tr);
  view.focus();
}

interface ResolvedEphemeral {
  from: number;
  to: number;
  node: PMNode;
}

function tryResolveEmptyEphemeral(state: EditorState, pos: number): ResolvedEphemeral | null {
  if (pos < 0 || pos >= state.doc.content.size) return null;
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  if (node.type.name !== "paragraph") return null;
  if (node.content.size !== 0) return null;
  return { from: pos, to: pos + node.nodeSize, node };
}

/** Build (but do not dispatch) the transaction that dismisses the
 *  currently-tracked ephemeral paragraph if it's still empty.
 *  Returns null if there's nothing to dismiss (no ephemeral, or the
 *  paragraph has been typed into / already removed). Exported pure
 *  for testability. */
export function buildDismissTransaction(state: EditorState): Transaction | null {
  const ephemeral = key.getState(state);
  if (!ephemeral || ephemeral.pos === null) return null;
  const resolved = tryResolveEmptyEphemeral(state, ephemeral.pos);
  if (!resolved) {
    // Tracked pos no longer points to an empty paragraph (confirmed
    // or already removed). Clear tracking metadata without touching
    // the doc.
    return state.tr.setMeta(key, { kind: "clear" });
  }
  return state.tr
    .delete(resolved.from, resolved.to)
    .setMeta(key, { kind: "clear" });
}

/** Start the OUT animation. Sets phase=leaving via meta - the view
 *  callback picks up the phase transition, lets the CSS keyframe
 *  play for LEAVE_ANIMATION_MS, then dispatches the actual delete.
 *  No-op when there's nothing to dismiss or already leaving. */
function beginLeavingPhase(view: EditorView): boolean {
  const ephemeral = key.getState(view.state);
  if (!ephemeral || ephemeral.pos === null) return false;
  if (ephemeral.phase === "leaving") return false; // already in flight
  const resolved = tryResolveEmptyEphemeral(view.state, ephemeral.pos);
  if (!resolved) {
    // Tracked but not empty - clear tracking without animation.
    view.dispatch(view.state.tr.setMeta(key, { kind: "clear" }));
    return true;
  }
  view.dispatch(view.state.tr.setMeta(key, { kind: "leave" }));
  return true;
}

// ─── Hover hint ───────────────────────────────────────────────────
//
// A subtle horizontal line that follows the cursor when hovering an
// inter-block gap. Single shared element on document.body, fixed-
// positioned so it doesn't mutate PM's DOM (which would confuse
// PM's own input/coords logic). Recomputes on every mousemove
// cheap because it's just N getBoundingClientRect calls on the
// already-laid-out top-level blocks.
//
// Why only between two adjacent blocks (not above-first or below-
// last): those edge zones are unbounded, the hint would float in
// dead space far from the cursor and lose its "click HERE" meaning.
// The click-to-spawn hit-test still accepts those clicks; the hint
// just doesn't advertise them.

// Mirrors HANDLE_OFFSET_LEFT in drag-handles.ts. Kept as a local
// constant rather than imported because the drag-handles module
// scopes it inside a function - duplicating the value here is
// cheaper than restructuring that module just to share one number.
// If the gutter offset moves, update both.
const HANDLE_GUTTER = 30;

// Dwell time before the spawn hint actually appears. The cursor has
// to settle inside the same gap for this long; a quick scan past
// gaps while reading does nothing. Jitter within one gap doesn't
// reset the timer (we key on the gap index, not the move event), so
// staying put for `DWELL_MS` reliably triggers a show.
const DWELL_MS = 115;

function mountClickToSpawnView(editorView: EditorView): { update(): void; destroy(): void } {
  const hint = activeDocument.createElement("div");
  hint.className = "butter-spawn-hint";
  hint.setAttribute("aria-hidden", "true");
  activeDocument.body.appendChild(hint);

  let visible = false;
  // Leaving-phase orchestration: when state.phase flips to "leaving",
  // start a timer matching the CSS OUT animation duration. On fire,
  // dispatch the actual delete tr. Tracked-pos guards guarantee we
  // only delete the paragraph that actually entered leaving - if a
  // new spawn happens mid-leave, phase resets to "active" and the
  // cleanup branch cancels the pending timer.
  let leaveTimer: number | null = null;
  let leavingPos: number | null = null;

  // Dwell timer state. `dwellTimer` is the scheduled show; `dwellGapIdx`
  // is the gap the cursor was in when the timer was armed, used to
  // distinguish "still in same gap, leave timer alone" from "moved to
  // a new gap, restart". -1 means no active dwell.
  let dwellTimer: number | null = null;
  let dwellGapIdx = -1;

  function cancelDwell(): void {
    if (dwellTimer !== null) {
      window.clearTimeout(dwellTimer);
      dwellTimer = null;
    }
    dwellGapIdx = -1;
  }

  function show(midY: number, left: number, width: number): void {
    hint.style.top = `${midY}px`;
    hint.style.left = `${left}px`;
    hint.style.width = `${width}px`;
    if (!visible) {
      hint.classList.add("is-visible");
      visible = true;
    }
  }

  function hide(): void {
    // Any path that hides the hint also abandons a pending dwell -
    // scroll, resize, mousedown, mouseleave all mean "the user moved
    // on, don't surprise them with a show after the fact".
    cancelDwell();
    if (visible) {
      hint.classList.remove("is-visible");
      visible = false;
    }
  }

  function compute(event: MouseEvent): { midY: number; left: number; width: number; gapIdx: number } | null {
    // No spawn affordance while a block drag is in progress. The cursor
    // sits in the gutter during a drag, so the cheap early-exits below
    // don't catch it and compute would scan every block
    // (getBoundingClientRect each) on every mousemove - heavy in large
    // notes.
    if (activeDocument.body.classList.contains("butter-is-dragging")) return null;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest(".butter-drag-handle")) return null;
      if (target.closest("[data-butter-no-click-spawn]")) return null;
      if (isInsideTopLevelBlock(target, editorView.dom)) return null;
    }

    const doc = editorView.state.doc;
    const n = doc.childCount;
    if (n < 2) return null;

    const y = event.clientY;
    let posCursor = 0;
    const rects: DOMRect[] = [];
    const visualLefts: number[] = [];
    const nodes: PMNode[] = [];
    for (let i = 0; i < n; i++) {
      const child = doc.child(i);
      const dom = editorView.nodeDOM(posCursor);
      if (dom instanceof HTMLElement) {
        const rect = dom.getBoundingClientRect();
        // Skip blocks that don't take layout space. `display:none`
        // nodes (e.g., block_comment) return an all-zero rect, and
        // a 0-rect block would extend its "gap" with neighbors all
        // the way up to the page top - the hint would anchor far
        // above the actual visible gap. Same fix as in
        // hitTestInterBlockGap above; the two paths must stay in
        // lockstep so the visual hint and the click target match.
        if (rect.width !== 0 || rect.height !== 0) {
          rects.push(rect);
          const ml = parseFloat(getComputedStyle(dom).marginLeft) || 0;
          visualLefts.push(rect.left - Math.min(0, ml));
          nodes.push(child);
        }
      }
      posCursor += child.nodeSize;
    }
    if (rects.length < 2) return null;

    for (let i = 0; i < rects.length - 1; i++) {
      const a = rects[i];
      const b = rects[i + 1];
      if (y >= a.bottom && y <= b.top) {
        // Suppress the affordance when either neighbor is an empty
        // paragraph - clicking would just stack another empty next
        // to one that already exists. Mirrors hitTestInterBlockGap
        // so the visual hint and the click target stay in sync.
        if (isEmptyParagraph(nodes[i]) || isEmptyParagraph(nodes[i + 1]))
          return null;
        const midY = (a.bottom + b.top) / 2;
        // Extend left into the drag-handle gutter so the hint's `+`
        // icon lands in the same visual column as the per-block drag
        // handles (HANDLE_OFFSET_LEFT = 30px in drag-handles.ts).
        // Mirror that module's negative-margin compensation: on
        // lists `margin-left` is `-var(--list-indent)` to keep their
        // LI content flush with paragraphs while the marker column
        // sits in the gutter - without compensating, a hint between
        // a paragraph and a list would land 30px further left than
        // the per-block handle would for either block.
        const left =
          Math.min(visualLefts[i], visualLefts[i + 1]) - HANDLE_GUTTER;
        const right = Math.max(a.right, b.right);
        return { midY, left, width: right - left, gapIdx: i };
      }
    }
    return null;
  }

  function onMove(event: MouseEvent): void {
    const hit = compute(event);
    if (!hit) {
      // Out of any gap. Clear pending dwell + hide if visible.
      hide();
      return;
    }
    if (hit.gapIdx === dwellGapIdx) {
      // Same gap the dwell is already running for. Don't reschedule -
      // restarting the timer on every mousemove would mean the user
      // can never finish dwelling. The original `show` (if it fired)
      // already captured the geometry, which is constant within one
      // gap, so there's nothing to update.
      return;
    }
    // Different gap (or first hit). If the previous gap's hint is
    // showing, hide it; the user moved on. Then arm a fresh dwell.
    if (visible) {
      hint.classList.remove("is-visible");
      visible = false;
    }
    cancelDwell();
    dwellGapIdx = hit.gapIdx;
    const armed = hit; // capture for the closure
    dwellTimer = window.setTimeout(() => {
      dwellTimer = null;
      show(armed.midY, armed.left, armed.width);
    }, DWELL_MS);
  }

  editorView.dom.addEventListener("mousemove", onMove);
  editorView.dom.addEventListener("mouseleave", hide);
  // Capture-phase mousedown so we hide before PM's own mousedown
  // handlers run - avoids a one-frame flash of the hint over the
  // newly-spawned paragraph.
  editorView.dom.addEventListener("mousedown", hide, true);
  // Scroll events do not bubble, but they propagate in the capture
  // phase. Listening at the document level with capture catches any
  // scroll anywhere on the page (the editor's scroll container, the
  // workspace, a nested scrolling block, the window) without having
  // to guess which ancestor is the actual scroller. The hint is
  // fixed-positioned, so any scroll invalidates its anchor and we
  // hide unconditionally; the next mousemove re-shows it at the
  // correct location.
  activeDocument.addEventListener("scroll", hide, { capture: true, passive: true });
  window.addEventListener("resize", hide, { passive: true });

  function cancelLeaveTimer(): void {
    if (leaveTimer !== null) {
      window.clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    leavingPos = null;
  }

  function syncLeavingPhase(): void {
    const eph = key.getState(editorView.state);
    if (!eph || eph.pos === null) {
      // No ephemeral - clear any in-flight timer (e.g., the timer's
      // own dispatch just landed and cleared state).
      cancelLeaveTimer();
      return;
    }
    if (eph.phase !== "leaving") {
      // Phase reverted to "active" (e.g., a new spawn replaced the
      // leaving one). Don't let the stale timer delete the new para.
      cancelLeaveTimer();
      return;
    }
    // phase === "leaving"
    if (leaveTimer !== null && leavingPos === eph.pos) return; // already scheduled
    cancelLeaveTimer();
    leavingPos = eph.pos;
    leaveTimer = window.setTimeout(() => {
      leaveTimer = null;
      leavingPos = null;
      const tr = buildDismissTransaction(editorView.state);
      if (tr) editorView.dispatch(tr);
    }, LEAVE_ANIMATION_MS);
  }

  return {
    update() {
      syncLeavingPhase();
    },
    destroy() {
      editorView.dom.removeEventListener("mousemove", onMove);
      editorView.dom.removeEventListener("mouseleave", hide);
      editorView.dom.removeEventListener("mousedown", hide, true);
      activeDocument.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
      hint.remove();
      cancelLeaveTimer();
      cancelDwell();
    },
  };
}

// ─── Plugin ───────────────────────────────────────────────────────

type Meta =
  | { kind: "set"; pos: number }
  | { kind: "clear" }
  | { kind: "leave" };

export function clickToSpawnPlugin(
  onMobileUnlock: (() => void) | null = null,
): Plugin<EphemeralState> {
  return new Plugin<EphemeralState>({
    key,
    state: {
      init(): EphemeralState {
        return { pos: null, phase: "active" };
      },
      apply(tr: Transaction, prev: EphemeralState): EphemeralState {
        const meta = tr.getMeta(key) as Meta | undefined;
        if (meta) {
          if (meta.kind === "clear") return { pos: null, phase: "active" };
          if (meta.kind === "set") return { pos: meta.pos, phase: "active" };
          if (meta.kind === "leave") return { pos: prev.pos, phase: "leaving" };
        }

        // No explicit meta - track existing ephemeral through document
        // changes if any. If the doc didn't change, state is stable.
        if (prev.pos === null) return prev;
        if (!tr.docChanged) return prev;

        // Map the tracked position through the transaction.
        const mapped = tr.mapping.map(prev.pos, 1);
        // Check whether the tracked paragraph still exists AND is
        // still empty at its new position. If not, the user has typed
        // into it (confirmed) or it's gone (e.g., wiped by another
        // operation) - either way, we stop tracking.
        if (mapped < 0 || mapped >= tr.doc.content.size)
          return { pos: null, phase: "active" };
        const node = tr.doc.nodeAt(mapped);
        if (!node) return { pos: null, phase: "active" };
        if (node.type.name !== "paragraph") return { pos: null, phase: "active" };
        if (node.content.size > 0) return { pos: null, phase: "active" };
        return { pos: mapped, phase: prev.phase };
      },
    },
    appendTransaction(_transactions, _oldState, newState): Transaction | null {
      // Auto-dismiss: if the selection has moved OUTSIDE an empty
      // ephemeral, mark it as leaving (NOT delete it yet). The view
      // callback sees the phase transition, lets the CSS OUT
      // animation play, then dispatches the actual delete after
      // LEAVE_ANIMATION_MS. This decouples the visual fade from the
      // transaction batch so we get a smooth exit.
      const ephemeral = key.getState(newState);
      if (!ephemeral || ephemeral.pos === null) return null;
      if (ephemeral.phase === "leaving") return null; // already in flight
      const resolved = tryResolveEmptyEphemeral(newState, ephemeral.pos);
      if (!resolved) return null;
      const sel = newState.selection;
      // Inside means selection range fully contained within the empty
      // paragraph's node-span. Empty paragraph spans [pos, pos+2]; a
      // collapsed cursor at pos+1 is inside.
      if (sel.from >= resolved.from && sel.to <= resolved.to) return null;
      return newState.tr.setMeta(key, { kind: "leave" });
    },
    view(editorView: EditorView) {
      return mountClickToSpawnView(editorView);
    },
    props: {
      decorations(state: EditorState): DecorationSet | null {
        // Mark the empty ephemeral paragraph with an animation class
        // so CSS keyframes drive the IN (active) and OUT (leaving)
        // transitions. The decoration is a node-level attribute add,
        // so it composes with whatever other classes the paragraph
        // already has from PM's default rendering.
        const ephemeral = key.getState(state);
        if (!ephemeral || ephemeral.pos === null) return null;
        const resolved = tryResolveEmptyEphemeral(state, ephemeral.pos);
        if (!resolved) return null;
        const cls =
          ephemeral.phase === "leaving"
            ? "butter-spawn-leaving"
            : "butter-spawn-ephemeral";
        return DecorationSet.create(state.doc, [
          Decoration.node(resolved.from, resolved.to, { class: cls }),
        ]);
      },
      handleDOMEvents: {
        mousedown(view: EditorView, event: MouseEvent): boolean {
          // Clear selected leaf blocks before PM can re-select them.
          if (
            event.button === 0 &&
            !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey &&
            view.state.selection instanceof NodeSelection &&
            (view.state.selection.node.isAtom || view.state.selection.node.isLeaf)
          ) {
            const selDom = view.nodeDOM(view.state.selection.from);
            if (selDom instanceof HTMLElement && selDom.contains(event.target as Node)) {
              event.preventDefault();
              const $pos = view.state.doc.resolve(view.state.selection.from);
              let textSel = Selection.near($pos);
              if (textSel instanceof NodeSelection && textSel.from === view.state.selection.from) {
                textSel = Selection.near($pos, -1);
              }
              view.dispatch(view.state.tr.setSelection(textSel));
              view.focus();
              return true;
            }
          }

          // Only left-button, unmodified clicks.
          if (event.button !== 0) return false;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return false;

          const hit = hitTestInterBlockGap(view, event);
          if (!hit) return false;

          event.preventDefault();
          spawnEphemeralParagraph(view, hit.insertPos, onMobileUnlock);
          return true;
        },

        keydown(view: EditorView, event: KeyboardEvent): boolean {
          if (event.key !== "Escape") return false;
          const ephemeral = key.getState(view.state);
          if (!ephemeral || ephemeral.pos === null) return false;
          const resolved = tryResolveEmptyEphemeral(view.state, ephemeral.pos);
          if (!resolved) return false;
          event.preventDefault();
          beginLeavingPhase(view);
          return true;
        },

        blur(view: EditorView): boolean {
          const ephemeral = key.getState(view.state);
          if (!ephemeral || ephemeral.pos === null) return false;

          // Delay the dismiss check: transient focus loss (clicking a
          // toolbar button, a drag handle, etc.) can fire blur even
          // though the user is still interacting with Butter. Re-check
          // in a microtask - if focus has returned inside the editor
          // DOM, skip.
          window.setTimeout(() => {
            // View torn down between blur and microtask - bail out.
            if (!view.dom.isConnected) return;
            // Focus returned inside editor (e.g., transient blur from
            // clicking a floating toolbar) - keep ephemeral alive.
            if (view.dom.contains(activeDocument.activeElement)) return;
            // Mobile insert drawer is open - the user tapped `+`
            // intending to insert AT the ephemeral position. The
            // drawer blurs the editor to dismiss the keyboard, but
            // dismissing the ephemeral here would yank the insertion
            // target out from under the upcoming tile-tap. Keep it
            // alive until the drawer closes and selection moves.
            if (activeDocument.body.classList.contains("butter-mobile-drawer-open"))
              return;
            beginLeavingPhase(view);
          }, 0);

          return false; // don't consume blur - other handlers may care
        },
      },
    },
  });
}

// Re-export the plugin key so external code (tests, debug inspectors)
// can introspect ephemeral state if needed.
export const clickToSpawnKey = key;
