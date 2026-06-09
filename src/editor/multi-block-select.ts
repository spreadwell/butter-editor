/**
 * Multi-block selection state - a Set of top-level block positions
 * that are "additionally selected" alongside (or independent of) PM's
 * own TextSelection / NodeSelection. Drives the selection-overlay
 * plugin to render one selection ring per selected block.
 *
 * Driven by the drag-handles plugin's click handling:
 *   • Shift+click on a drag handle → extends the selection RANGE
 *     from the anchor (first click of the gesture) to the clicked
 *     block. All blocks in doc order between them are selected.
 *   • Ctrl/Cmd+click on a drag handle → toggles the clicked block
 *     in/out of the set. Adds an anchor on first toggle.
 *   • Double-click on a drag handle → scope-select via a strategy
 *     determined by the block's type (handled in drag-handles).
 *   • Plain click → clears the set (caller dispatches `clear()`
 *     before opening the context menu).
 *   • Esc → clears.
 *
 * The plugin maintains an `anchor` doc-position (first click of the
 * range gesture) so subsequent shift+clicks extend from a consistent
 * reference point - matching the standard convention of file-explorer
 * shift-click ranges in OS file managers.
 */
import {
  Plugin as PMPlugin,
  PluginKey,
  NodeSelection,
  Selection,
} from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { App, Menu, Notice } from "obsidian";
import { shiftSelectedListItemDepth } from "./list-operations";
import {
  buildSingleBlockMenuItems,
  intersectBlockMenuSpecs,
  renderBlockMenuItems,
  applyBlockContextMenuChrome,
  MERGE_MENU_ITEMS,
} from "./block-menu-spec";

export interface MultiBlockSelection {
  /** Doc positions of the top-level blocks currently selected. Each
   *  position is the position BEFORE the block (same convention as
   *  PM's NodeSelection.from). */
  positions: number[];
  /** First position of the range gesture - used as the "from" end of
   *  shift-click extends. Null when no range is active (e.g., after
   *  a clear). */
  anchor: number | null;
}

export type MultiBlockAction =
  | { kind: "set"; positions: number[]; anchor?: number }
  | { kind: "add"; pos: number }
  | { kind: "remove"; pos: number }
  | { kind: "toggle"; pos: number }
  | { kind: "extendTo"; pos: number; allBlockPositions: number[] }
  | { kind: "setAnchor"; pos: number }
  | { kind: "clear" };

export const multiBlockKey = new PluginKey<MultiBlockSelection>(
  "butter-multi-block-select",
);

const EMPTY: MultiBlockSelection = { positions: [], anchor: null };

function applyAction(
  state: MultiBlockSelection,
  action: MultiBlockAction,
): MultiBlockSelection {
  switch (action.kind) {
    case "set": {
      const positions = [...new Set(action.positions)].sort((a, b) => a - b);
      return {
        positions,
        anchor: action.anchor ?? positions[0] ?? null,
      };
    }
    case "add": {
      if (state.positions.includes(action.pos)) return state;
      const positions = [...state.positions, action.pos].sort((a, b) => a - b);
      return { positions, anchor: state.anchor ?? action.pos };
    }
    case "remove": {
      const positions = state.positions.filter((p) => p !== action.pos);
      return {
        positions,
        anchor: state.anchor === action.pos
          ? positions[0] ?? null
          : state.anchor,
      };
    }
    case "toggle": {
      if (state.positions.includes(action.pos)) {
        return applyAction(state, { kind: "remove", pos: action.pos });
      }
      return applyAction(state, { kind: "add", pos: action.pos });
    }
    case "extendTo": {
      const anchor = state.anchor ?? action.pos;
      // Sort all-block-positions so we can pick the contiguous run
      // between anchor and target inclusive.
      const sorted = [...action.allBlockPositions].sort((a, b) => a - b);
      const lo = Math.min(anchor, action.pos);
      const hi = Math.max(anchor, action.pos);
      const positions = sorted.filter((p) => p >= lo && p <= hi);
      return { positions, anchor };
    }
    case "setAnchor": {
      return { ...state, anchor: action.pos };
    }
    case "clear":
      return EMPTY;
  }
}

/**
 * Public helper: dispatch an action that updates the multi-block
 * selection state. Returns true if a transaction was dispatched
 * (state changed), false otherwise. Skips no-op dispatches so we
 * don't churn the undo stack.
 */
export function dispatchMultiBlock(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  action: MultiBlockAction,
): boolean {
  const current = multiBlockKey.getState(state) ?? EMPTY;
  const next = applyAction(current, action);
  if (
    current.anchor === next.anchor &&
    current.positions.length === next.positions.length &&
    current.positions.every((p, i) => p === next.positions[i])
  ) {
    return false;
  }
  dispatch(state.tr.setMeta(multiBlockKey, action));
  return true;
}

export function getMultiBlockSelection(state: EditorState): MultiBlockSelection {
  return multiBlockKey.getState(state) ?? EMPTY;
}

/**
 * Compute all top-level block positions in the doc. Used by the
 * extendTo action to enumerate positions for range-select. Filters
 * out doc itself (we want CHILDREN of doc).
 */
export function listTopLevelBlockPositions(state: EditorState): number[] {
  const positions: number[] = [];
  let offset = 0;
  state.doc.forEach((node, off) => {
    positions.push(off);
    offset = off + node.nodeSize;
  });
  void offset;
  return positions;
}

/**
 * Compute a list_item's subtree: the item itself plus all subsequent
 * contiguous list_items with depth STRICTLY greater than the source.
 * Returns just `[blockPos]` for non-list_items or list_items that
 * have no nested children. Used by both:
 *   • plain-click handle → auto-select parent+children (so the user
 *     never has to manually fan out a nested list to operate on it)
 *   • drag → carry the whole subtree along (Notion-style move)
 */
export function computeListSubtree(
  state: EditorState,
  blockPos: number,
): number[] {
  const node = state.doc.nodeAt(blockPos);
  if (!node || node.type.name !== "list_item") return [blockPos];
  const sourceDepth = node.attrs.depth as number;
  const positions: number[] = [blockPos];
  let cursor = blockPos + node.nodeSize;
  while (cursor < state.doc.content.size) {
    const next = state.doc.nodeAt(cursor);
    if (!next || next.type.name !== "list_item") break;
    const nextDepth = next.attrs.depth as number;
    if (nextDepth <= sourceDepth) break;
    positions.push(cursor);
    cursor += next.nodeSize;
  }
  return positions;
}

/**
 * Compute the "scope" of blocks to select on a double-click of a
 * drag handle, per block type:
 *   • list_item: all CONTIGUOUS list_items in the doc
 *   • paragraph: all CONTIGUOUS paragraphs
 *   • heading: self + all blocks until the next equal-or-higher-rank
 *     heading (the "section under this heading")
 *   • everything else: just self
 */
export function computeScopeSelection(
  state: EditorState,
  blockPos: number,
  blockNode: PMNode,
): number[] {
  const doc = state.doc;
  const myIdx = doc.resolve(blockPos).index(0);
  const positions: number[] = [];
  const walk = (
    dir: -1 | 1,
    predicate: (n: PMNode, idx: number) => boolean,
  ) => {
    const out: number[] = [];
    let i = myIdx + dir;
    if (dir === -1) {
      let cursor = blockPos;
      while (i >= 0) {
        const child = doc.child(i);
        cursor -= child.nodeSize;
        if (!predicate(child, i)) break;
        out.unshift(cursor);
        i--;
      }
    } else {
      let cursor = blockPos + blockNode.nodeSize;
      while (i < doc.childCount) {
        const child = doc.child(i);
        if (!predicate(child, i)) break;
        out.push(cursor);
        cursor += child.nodeSize;
        i++;
      }
    }
    return out;
  };

  if (blockNode.type.name === "list_item") {
    positions.push(...walk(-1, (n) => n.type.name === "list_item"));
    positions.push(blockPos);
    positions.push(...walk(1, (n) => n.type.name === "list_item"));
    return positions;
  }
  if (blockNode.type.name === "paragraph") {
    positions.push(...walk(-1, (n) => n.type.name === "paragraph"));
    positions.push(blockPos);
    positions.push(...walk(1, (n) => n.type.name === "paragraph"));
    return positions;
  }
  if (blockNode.type.name === "heading") {
    const myLevel = (blockNode.attrs.level as number) ?? 1;
    positions.push(blockPos);
    positions.push(
      ...walk(1, (n) => {
        if (n.type.name !== "heading") return true;
        const lvl = (n.attrs.level as number) ?? 1;
        return lvl > myLevel;
      }),
    );
    return positions;
  }
  return [blockPos];
}

const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 6;
let lastClickX = -1;
let lastClickY = -1;
let lastClickTime = 0;

function selectionNearButNotSameNode(
  state: EditorState,
  pos: number,
): Selection {
  const $pos = state.doc.resolve(pos);
  let sel = Selection.near($pos);
  if (sel instanceof NodeSelection && sel.from === pos) {
    sel = Selection.near($pos, -1);
  }
  return sel;
}

/**
 * Open the GROUP context menu for a multi-block selection. Visually
 * matches the single-block menu (`openBlockContextMenu` in
 * drag-handles.ts): same `.butter-block-context-menu` class and
 * same header structure (icon + title + subtext).
 *
 * Anchored to the LEFT of the trigger block's drag handle (or to
 * the right if there's no room) - matching single-block placement.
 *
 * Actions (intentionally limited per spec): Copy, Cut, Duplicate,
 * Combine into paragraph (when all selected blocks are inline-like),
 * Delete. After Cut / Delete / Combine the multi-set is cleared.
 */
export function openMultiBlockContextMenu(
  app: App,
  view: EditorView,
  triggerHandle: HTMLElement,
  triggerBlockPos: number,
  positions: number[],
  serializeNode: (node: PMNode) => string,
): Menu {
  const sortedPositions = [...positions].sort((a, b) => a - b);
  const count = sortedPositions.length;
  // Resolve every position to a node up-front. After any tr mutates
  // the doc those positions shift; the captured nodes survive.
  const nodes = sortedPositions
    .map((pos) => {
      const node = view.state.doc.nodeAt(pos);
      return node ? { pos, node } : null;
    })
    .filter((x): x is { pos: number; node: PMNode } => x != null);

  const menu = new Menu();
  // Shared chrome - adds .butter-block-context-menu class + the
  // header row (icon "layers" for multi-stack, "N blocks" title,
  // total char count subtext). Header DOM is identical to the
  // single-block menu so CSS styles it the same.
  const totalChars = nodes.reduce((s, n) => s + n.node.textContent.length, 0);
  applyBlockContextMenuChrome(menu, {
    icon: "layers",
    title: `${count} block${count === 1 ? "" : "s"}`,
    sub: `Selection · ${totalChars} char${totalChars === 1 ? "" : "s"}`,
  });

  const copyAll = async (): Promise<boolean> => {
    try {
      const md = nodes.map((n) => serializeNode(n.node)).join("\n\n");
      await navigator.clipboard.writeText(md.replace(/\n+$/, ""));
      return true;
    } catch {
      new Notice("Clipboard write failed");
      return false;
    }
  };

  const deleteAll = () => {
    const tr = view.state.tr;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { pos, node } = nodes[i];
      tr.delete(pos, pos + node.nodeSize);
    }
    view.dispatch(tr);
    dispatchMultiBlock(
      view.state,
      view.dispatch.bind(view),
      { kind: "clear" },
    );
  };

  // ── Block-type-specific items shared across the selection ────
  // For each selected block we build its single-block spec, then keep
  // only the items present on EVERY block (intersected by id, with
  // submenu sub-items also intersected). Each surviving item becomes
  // a broadcast: clicking it applies the action to every selected
  // block in one transaction (reverse pos order so earlier positions
  // stay valid). Items marked `singleOnly` (e.g. math Edit source
  // would open N modals) are filtered out.
  const perBlockSpecs = nodes.map(({ pos, node }) =>
    buildSingleBlockMenuItems({ view, pos, node, app }),
  );
  const sharedItems = intersectBlockMenuSpecs(perBlockSpecs);
  if (sharedItems.length > 0) {
    renderBlockMenuItems(menu, sharedItems, (item) => {
      if (item.applyTr) {
        const tr = view.state.tr;
        for (let i = nodes.length - 1; i >= 0; i--) {
          const { pos, node } = nodes[i];
          item.applyTr(tr, pos, node);
        }
        if (tr.docChanged) {
          view.dispatch(tr);
          // Doc changed → captured positions are stale. Clear the
          // multi-set so the user starts a fresh gesture.
          dispatchMultiBlock(
            view.state,
            view.dispatch.bind(view),
            { kind: "clear" },
          );
        }
        view.focus();
      } else if (item.sideEffect) {
        for (const { pos, node } of nodes) {
          item.sideEffect(view, pos, node);
        }
      }
    });
    menu.addSeparator();
  }

  menu.addItem((item) => {
    item.setTitle("Copy");
    item.setIcon("copy");
    item.onClick(async () => {
      if (await copyAll()) new Notice(`Copied ${count} blocks`);
    });
  });

  menu.addItem((item) => {
    item.setTitle("Cut");
    item.setIcon("scissors");
    item.onClick(async () => {
      if (await copyAll()) {
        deleteAll();
        new Notice(`Cut ${count} blocks`);
      }
    });
  });

  menu.addItem((item) => {
    item.setTitle("Duplicate");
    item.setIcon("copy-plus");
    item.onClick(() => {
      const last = nodes[nodes.length - 1];
      const insertAt = last.pos + last.node.nodeSize;
      const clones = nodes.map(({ node }) =>
        node.type.create(node.attrs, node.content, node.marks),
      );
      view.dispatch(view.state.tr.insert(insertAt, clones));
    });
  });

  // Merge items - collapse the selection into a single new block. The
  // catalog (`MERGE_MENU_ITEMS` in block-menu-spec.ts) drives
  // eligibility per item; we just iterate, include any whose
  // predicate passes, and clear the multi-set after the run completes
  // (positions are stale post-merge regardless of which merge ran).
  if (count >= 2) {
    const blockNodes = nodes.map((n) => n.node);
    for (const merge of MERGE_MENU_ITEMS) {
      if (!merge.appliesTo(blockNodes)) continue;
      menu.addItem((item) => {
        item.setTitle(merge.title);
        item.setIcon(merge.icon);
        item.onClick(() => {
          merge.run(view, nodes);
          dispatchMultiBlock(
            view.state,
            view.dispatch.bind(view),
            { kind: "clear" },
          );
        });
      });
    }
  }

  menu.addSeparator();

  menu.addItem((item) => {
    item.setTitle("Delete");
    item.setIcon("trash-2");
    item.setWarning?.(true);
    item.dom?.classList.add("is-warning");
    item.onClick(() => deleteAll());
  });

  // Position to the LEFT of the trigger handle (or right if no room).
  // Constants mirror openBlockContextMenu in drag-handles.ts.
  const HANDLE_OFFSET_LEFT = 30;
  const HANDLE_WIDTH = 22;
  const MENU_GAP = 6;
  const MENU_WIDTH = 240;
  const handleRect = triggerHandle.getBoundingClientRect();
  // The handle's rect is the visible 22×22 button. The block sits to
  // the right of it. Compute the block's effective left from the
  // handle's right + handle-offset-left so positioning matches the
  // single-block menu's math exactly.
  const blockLeftApprox = handleRect.left + HANDLE_OFFSET_LEFT;
  const handleLeft = blockLeftApprox - HANDLE_OFFSET_LEFT;
  const handleRight = handleLeft + HANDLE_WIDTH;
  const leftX = handleLeft - MENU_GAP - MENU_WIDTH;
  const x = leftX >= 8 ? leftX : handleRight + MENU_GAP;
  const y = Math.max(8, handleRect.top);
  menu.showAtPosition({ x, y });
  void triggerBlockPos;
  return menu;
}

export interface MultiBlockSelectConfig {
  app: App;
  serializeNode: (node: PMNode) => string;
}

export function multiBlockSelectPlugin(
  config: MultiBlockSelectConfig,
): PMPlugin<MultiBlockSelection> {
  return new PMPlugin<MultiBlockSelection>({
    key: multiBlockKey,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const action = tr.getMeta(multiBlockKey) as
          | MultiBlockAction
          | undefined;
        let next = action ? applyAction(value, action) : value;
        // If the doc changed, remap positions through the mapping
        // so they continue to point at the same blocks. Drop any
        // position that was deleted by the change.
        if (tr.docChanged && next.positions.length > 0) {
          const remappedPositions: number[] = [];
          for (const p of next.positions) {
            const r = tr.mapping.mapResult(p);
            if (!r.deleted) remappedPositions.push(r.pos);
          }
          const remappedAnchor = next.anchor != null
            ? (() => {
                const r = tr.mapping.mapResult(next.anchor);
                return r.deleted ? null : r.pos;
              })()
            : null;
          next = { positions: remappedPositions, anchor: remappedAnchor };
        }
        return next;
      },
    },
    props: {
      handleKeyDown(view, event) {
        // Esc clears the multi-block selection.
        if (event.key === "Escape") {
          const sel = getMultiBlockSelection(view.state);
          if (sel.positions.length > 0) {
            dispatchMultiBlock(view.state, view.dispatch, { kind: "clear" });
            return true;
          }
        }
        return false;
      },
    },
    view(editorView) {
      // Track an open group menu so subsequent multi-select actions
      // can dismiss it cleanly before opening a new one (otherwise
      // we'd stack menus when the user shift/ctrl-clicks several
      // handles in succession).
      let activeGroupMenu: Menu | null = null;
      const mountGroupMenu = (handle: HTMLElement, blockPos: number) => {
        if (activeGroupMenu) {
          try { activeGroupMenu.hide(); } catch { /* */ }
          activeGroupMenu = null;
        }
        const sel = getMultiBlockSelection(editorView.state);
        if (sel.positions.length < 2) return;
        const menu = openMultiBlockContextMenu(
          config.app,
          editorView,
          handle,
          blockPos,
          sel.positions,
          config.serializeNode,
        );
        activeGroupMenu = menu;
        menu.onHide(() => {
          if (activeGroupMenu === menu) activeGroupMenu = null;
        });
      };
      /**
       * Open the group menu after the current click sequence settles.
       *
       * If we open the menu inside pointerdown, two bad things happen:
       *   1. The same click's subsequent mousedown is "outside" the
       *      just-opened menu, so Obsidian's outside-click handler
       *      dismisses it.
       *   2. The same click's subsequent click event likewise dismisses
       *      it via Obsidian's click-outside listener.
       *
       * Even setTimeout(0) wasn't enough - Obsidian's listeners fire on
       * the same macrotask boundary or are registered with similar
       * timing. The fix that mirrors the working single-click path
       * (which opens the menu in onArmUp / pointerup): wait for the
       * next pointerup, then mount. By then the entire click sequence
       * has fired and any "outside-click" listener registered AFTER
       * mount is past the dangerous window.
       */
      const scheduleGroupMenuOnNextUp = (
        handle: HTMLElement,
        blockPos: number,
      ) => {
        const onUp = () => {
          window.removeEventListener("pointerup", onUp, true);
          // One more rAF so the click event (which fires after pointerup)
          // also passes before we mount.
          window.requestAnimationFrame(() => mountGroupMenu(handle, blockPos));
        };
        window.addEventListener("pointerup", onUp, true);
      };

      // Document-level mousedown to clear the multi-set on any click
      // OUTSIDE a drag handle. Without this, clicking in the margin
      // / on text / on another block area leaves the highlight
      // strewn across the doc until the user finds a handle to
      // re-click or hits Esc.
      //
      // Skip clears when:
      //   • click target is inside a drag handle (the handle's own
      //     click handler manages the multi-set)
      //   • click is inside a selection overlay (those have
      //     pointer-events: none anyway, but defensive)
      //   • the multi-set is already empty (no-op churn avoided)
      const onPointerDown = (e: PointerEvent) => {
        const target = e.target as Element | null;
        if (!target) return;

        // Scope this handler to events relevant to THIS view's host.
        // Drag handles live on document.body (position:fixed), so
        // they're outside the host. For handle clicks, skip entirely
        // — the drag-handles plugin owns all handle interactions
        // including modifier gestures.
        const host = editorView.dom.parentElement;
        if (host && !host.contains(target)) {
          if (target.closest?.(".butter-drag-handle")) return;
          const multi = getMultiBlockSelection(editorView.state);
          if (multi.positions.length > 0) {
            dispatchMultiBlock(
              editorView.state,
              editorView.dispatch.bind(editorView),
              { kind: "clear" },
            );
          }
          return;
        }

        // ── Drag-handle modifier/double-click handling ──
        //
        // Listen on `pointerdown` capture phase - fires BEFORE the
        // handle's own pointerdown listener (which is bubble-phase
        // on the handle target). When a modifier or double-click
        // click is detected, we dispatch the multi-block action
        // and call `stopImmediatePropagation` to prevent the
        // handle's listener from arming a pendingDrag (which would
        // otherwise open the context menu on pointerup).
        //
        // We read the block's doc position directly from the handle's
        // `data-block-pos` attribute, which drag-handles stamps in
        // showHandleAt every time the handle moves - so we don't
        // depend on currentHit (which can be stale or cleared by an
        // open menu's onHide).
        const handle = target.closest<HTMLElement>(
          ".butter-drag-handle",
        );
        if (handle && e.button === 0) {
          const blockPosStr = handle.dataset.blockPos;
          if (blockPosStr == null) return;
          const blockPos = parseInt(blockPosStr, 10);
          if (Number.isNaN(blockPos)) return;
          const blockNode = editorView.state.doc.nodeAt(blockPos);
          if (!blockNode) return;

          // Double-click detection by SPATIAL proximity (not blockPos)
          // because the handle is hover-driven - between clicks, hover
          // detection can re-point it to a different block, mutating
          // `dataset.blockPos` even though the user is clicking the
          // same visual handle. Compare cursor positions instead, like
          // the browser's native dblclick.
          const now = performance.now();
          const dx = e.clientX - lastClickX;
          const dy = e.clientY - lastClickY;
          const isDouble =
            now - lastClickTime < DOUBLE_CLICK_MS &&
            dx * dx + dy * dy <= DOUBLE_CLICK_PX * DOUBLE_CLICK_PX;
          lastClickTime = now;
          lastClickX = e.clientX;
          lastClickY = e.clientY;

          const dispatch = editorView.dispatch.bind(editorView);

          if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
            const currentSel = editorView.state.selection;
            const multi = getMultiBlockSelection(editorView.state);
            if (
              multi.anchor == null &&
              currentSel instanceof NodeSelection
            ) {
              dispatchMultiBlock(editorView.state, dispatch, {
                kind: "setAnchor",
                pos: currentSel.from,
              });
            }
            const allBlockPositions = listTopLevelBlockPositions(
              editorView.state,
            );
            dispatchMultiBlock(editorView.state, dispatch, {
              kind: "extendTo",
              pos: blockPos,
              allBlockPositions,
            });
            scheduleGroupMenuOnNextUp(handle, blockPos);
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          if (e.ctrlKey || e.metaKey) {
            // If the user single-block-selected a different block first
            // (NodeSelection from a plain handle click) and the multi
            // set is still empty, fold that prior block into the set
            // before toggling the clicked one - mirrors how shift-click
            // promotes the prior NodeSelection into the range anchor.
            const currentSel = editorView.state.selection;
            const multi = getMultiBlockSelection(editorView.state);
            if (
              multi.positions.length === 0 &&
              currentSel instanceof NodeSelection &&
              currentSel.from !== blockPos
            ) {
              dispatchMultiBlock(editorView.state, dispatch, {
                kind: "add",
                pos: currentSel.from,
              });
            }
            dispatchMultiBlock(editorView.state, dispatch, {
              kind: "toggle",
              pos: blockPos,
            });
            scheduleGroupMenuOnNextUp(handle, blockPos);
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          if (isDouble) {
            const scope = computeScopeSelection(
              editorView.state,
              blockPos,
              blockNode,
            );
            if (scope.length > 0) {
              dispatchMultiBlock(editorView.state, dispatch, {
                kind: "set",
                positions: scope,
                anchor: blockPos,
              });
              scheduleGroupMenuOnNextUp(handle, blockPos);
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          // Plain click - fall through; handle's own pointerdown
          // listener will fire and open the menu (or the group menu
          // if this block is in a >1 multi-set).
          return;
        }
      };

      const onMouseDown = (e: MouseEvent) => {
        // Outside-click clear. Mousedown (not pointerdown) - Obsidian
        // and PM both wire selection / focus changes off mousedown,
        // so dispatching the clear here keeps the timing in sync.
        const target = e.target as Element | null;
        if (!target) return;
        if (target.closest(".butter-drag-handle")) return;
        if (target.closest(".butter-selection-overlay")) return;

        const multi = getMultiBlockSelection(editorView.state);
        const pmSel = editorView.state.selection;
        const hasMulti = multi.positions.length > 0;
        const hasNodeSel = pmSel instanceof NodeSelection;
        if (!hasMulti && !hasNodeSel) return;

        // In-node leaf clicks are handled by click-to-spawn first.
        let skipNodeSelClear = false;
        if (hasNodeSel) {
          const selDom = editorView.nodeDOM(pmSel.from);
          if (selDom instanceof HTMLElement && selDom.contains(target)) {
            skipNodeSelClear = true;
          }
        }

        const nodeSelFrom = hasNodeSel ? pmSel.from : null;
        const clearNodeSelection = () => {
          const liveSel = editorView.state.selection;
          if (!(liveSel instanceof NodeSelection)) return;
          if (nodeSelFrom != null && liveSel.from !== nodeSelFrom) return;
          try {
            editorView.dispatch(
              editorView.state.tr.setSelection(
                selectionNearButNotSameNode(editorView.state, liveSel.from),
              ),
            );
          } catch {
            /* doc shifted under us - leave selection alone. */
          }
        };

        let tr = editorView.state.tr;
        if (hasMulti) tr = tr.setMeta(multiBlockKey, { kind: "clear" });
        if (hasNodeSel && !skipNodeSelClear) {
          try {
            tr = tr.setSelection(
              selectionNearButNotSameNode(editorView.state, pmSel.from),
            );
          } catch {
            /* doc shifted under us - leave selection alone. */
          }
        }
        if (hasMulti || (hasNodeSel && !skipNodeSelClear)) {
          editorView.dispatch(tr);
        }
        if (hasNodeSel && !skipNodeSelClear) {
          window.setTimeout(clearNodeSelection, 0);
        }
      };
      // Document-level Tab / Shift-Tab. PM's keymap only fires when
      // the editor has focus, but click-selecting via a drag handle
      // (or opening the group menu) often moves focus out - so PM
      // never sees the keydown and Tab routes to the next focusable
      // Obsidian button instead. This listener fires regardless of
      // focus, scoped to when there's a multi-block selection or a
      // NodeSelection on a list_item, and routes the keydown into the
      // shared depth-shift command.
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Tab") return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const state = editorView.state;
        const multi = getMultiBlockSelection(state);
        const nodeSelOnListItem =
          state.selection instanceof NodeSelection &&
          state.doc.nodeAt(state.selection.from)?.type.name === "list_item";
        if (multi.positions.length === 0 && !nodeSelOnListItem) return;
        // Make sure we own the editor's window - not a different
        // editor instance attached to the same document.
        const ownerWin = editorView.dom.ownerDocument.defaultView;
        if (ownerWin && e.view && e.view !== ownerWin) return;
        const handled = shiftSelectedListItemDepth(
          editorView,
          e.shiftKey ? -1 : 1,
        );
        if (handled) {
          e.preventDefault();
          e.stopImmediatePropagation();
          editorView.focus();
        }
      };
      activeDocument.addEventListener("pointerdown", onPointerDown, true);
      activeDocument.addEventListener("mousedown", onMouseDown, true);
      activeDocument.addEventListener("keydown", onKeyDown, true);
      return {
        destroy() {
          activeDocument.removeEventListener("pointerdown", onPointerDown, true);
          activeDocument.removeEventListener("mousedown", onMouseDown, true);
          activeDocument.removeEventListener("keydown", onKeyDown, true);
          if (activeGroupMenu) {
            try { activeGroupMenu.hide(); } catch { /* */ }
            activeGroupMenu = null;
          }
        },
      };
    },
  });
}
