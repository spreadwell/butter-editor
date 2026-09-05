/**
 * List & block operations.
 *
 *   Alt+ArrowUp / Alt+ArrowDown
 *     Move the block containing the caret up/down. Works on any
 *     top-level block - paragraph, heading, list_item, blockquote,
 *     callout, code block - and stays within the same parent node,
 *     so a nested list_item swaps with its sibling rather than
 *     jumping out of the list.
 *
 *   Mod+Enter  (inside a list_item)
 *     Insert a new list_item at the same depth after the current one.
 *
 *   Mod+L
 *     Toggle the GFM task state of the current list line
 *     (empty → `[ ]` → `[x]` → empty).
 */
import { Plugin as PMPlugin, NodeSelection } from "prosemirror-state";
import type {
  EditorState,
  Transaction,
  Command,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { Fragment } from "prosemirror-model";
import { keymap } from "prosemirror-keymap";
import { TextSelection } from "prosemirror-state";
import { getMultiBlockSelection } from "./multi-block-select";
import { shiftListItemDepths } from "./list-depth";

// ═══════════════════════════════════════════
//  Move block up/down
// ═══════════════════════════════════════════

/**
 * Find the innermost top-level-ish block containing the caret whose
 * parent has more than one child. We walk up $from.depth; the first
 * ancestor with a sibling in the requested direction is a candidate
 * to move. That keeps "move up" inside a list when you're in a
 * list_item, but still works on paragraphs at doc level.
 */
interface MovableContext {
  depth: number;
  parentPos: number;
  parent: PMNode;
  childIndex: number;
}

function findMovable(
  state: EditorState,
  dir: -1 | 1,
): MovableContext | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const parent = d === 0 ? state.doc : $from.node(d);
    const childIndex = d === 0 ? $from.index(0) : $from.index(d);
    const target = childIndex + dir;
    if (target >= 0 && target < parent.childCount) {
      const parentPos = d === 0 ? 0 : $from.before(d);
      return { depth: d, parentPos, parent, childIndex };
    }
  }
  return null;
}

function moveBlockCmd(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const ctx = findMovable(state, dir);
    if (!ctx) return false;

    const { parent, parentPos, childIndex } = ctx;
    const target = childIndex + dir;
    const children: PMNode[] = [];
    parent.forEach((child) => children.push(child));
    const [a, b] =
      dir === 1 ? [childIndex, target] : [target, childIndex];
    [children[a], children[b]] = [children[b], children[a]];

    if (!dispatch) return true;

    const tr = state.tr;
    const contentStart = ctx.depth === 0 ? 0 : parentPos + 1;
    const contentEnd =
      ctx.depth === 0 ? state.doc.content.size : parentPos + parent.nodeSize - 1;
    tr.replaceWith(contentStart, contentEnd, Fragment.fromArray(children));

    // Preserve the caret in the moved block.
    let offset = contentStart;
    for (let i = 0; i < target; i++) offset += children[i].nodeSize;
    // Place caret at the start of the moved block's text content.
    const newPos = Math.min(offset + 1, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));

    dispatch(tr.scrollIntoView());
    return true;
  };
}

// ═══════════════════════════════════════════
//  Toggle task on current line
// ═══════════════════════════════════════════

/**
 * Task state cycles:  bullet/ordered → task-unchecked → task-checked → bullet
 *
 * In Butter's flat-list schema, a "task" is a list_item with
 * `kind: "task"` and `checked: true | false`. Toggling cycles the kind
 * + checked attrs in place - no structural change. If the caret is in
 * a paragraph (not a list_item), the paragraph is first converted to
 * a task list_item via `setNodeType` (matching the input-rule
 * conversion path).
 */
export function toggleTaskOnCurrentLine(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  cycle = true,
): boolean {
  const { $from } = state.selection;

  let listItemPos = -1;
  let listItemNode: PMNode | null = null;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "list_item") {
      listItemPos = $from.before(d);
      listItemNode = node;
      break;
    }
  }

  const schema = state.schema;

  if (!listItemNode) {
    // Caret is in a bare paragraph - convert to a task list_item.
    if (!dispatch) return true;
    const para = $from.node($from.depth);
    if (para.type.name !== "paragraph") return false;
    const paraPos = $from.before($from.depth);
    const item = schema.nodes.list_item.create(
      {
        kind: "task",
        depth: 0,
        tight: true,
        checked: false,
        start: null,
      },
      para,
    );
    const tr = state.tr.replaceWith(paraPos, paraPos + para.nodeSize, item);
    const newCaret = Math.min(paraPos + 2, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(newCaret)));
    dispatch(tr.scrollIntoView());
    return true;
  }

  if (!dispatch) return true;

  // Cycle kind/checked: non-task → task unchecked → task checked → bullet.
  // Invalidate sourceRange so the preservation pipeline re-serializes
  // the changed item rather than emitting stale original bytes.
  const liAttrs = listItemNode.attrs as { kind?: string; checked?: boolean | null };
  const isTask = liAttrs.kind === "task";
  const checked = liAttrs.checked;
  const nextAttrs: Record<string, unknown> = {
    ...listItemNode.attrs,
    sourceRange: null,
  };
  if (!isTask) {
    nextAttrs.kind = "task";
    nextAttrs.checked = false;
  } else if (checked === false) {
    nextAttrs.kind = "task";
    nextAttrs.checked = true;
  } else if (cycle) {
    // Checked task in cycle mode → bullet (cycle back to start).
    nextAttrs.kind = "bullet";
    nextAttrs.checked = null;
  } else {
    // Obsidian's ordinary checklist-status command toggles done/open without
    // changing the line back into a bullet. Its cycle command passes `true`.
    nextAttrs.kind = "task";
    nextAttrs.checked = false;
  }

  const tr = state.tr.setNodeMarkup(listItemPos, undefined, nextAttrs);
  dispatch(tr.scrollIntoView());
  return true;
}

// ═══════════════════════════════════════════
//  Indent / outdent (Tab / Shift-Tab in lists)
// ═══════════════════════════════════════════
//
// Flat schema: indentation is a `depth` attr, not structural nesting.
// Tab in a list_item: clamp depth+1 so it can't exceed (previous
// sibling's depth + 1) - matches markdown/Notion's "you can only
// indent under something that exists at the parent depth" rule.
// Shift-Tab: depth-1 (clamped at 0).

/**
 * Public entrypoint usable from a non-keymap context (e.g. a document
 * keydown listener that fires even when PM doesn't have focus). Runs
 * the same depth-shift the Tab / Shift-Tab keymap entries do - covers
 * multi-block selection, NodeSelection on a list_item, or cursor in a
 * list_item. Returns true if the doc changed.
 */
export function shiftSelectedListItemDepth(
  view: EditorView,
  delta: 1 | -1,
): boolean {
  return changeListItemDepth(delta)(view.state, view.dispatch.bind(view), view);
}

export function changeListItemDepth(delta: 1 | -1): Command {
  return (state, dispatch) => {
    // Multi-block selection wins - every list_item in the set gets
    // shifted with per-item clamping. Used
    // when the user click-selected a parent that auto-included its
    // subtree, or shift/ctrl-built a custom group.
    const multi = getMultiBlockSelection(state);
    if (multi.positions.length > 0) {
      return shiftListItemDepths(
        state,
        dispatch,
        multi.positions,
        delta,
        false,
        true,
      );
    }

    // Single NodeSelection on a list_item - same as cursor-inside.
    const sel = state.selection;
    if (sel instanceof NodeSelection && sel.node.type.name === "list_item") {
      return shiftListItemDepths(
        state,
        dispatch,
        [sel.from],
        delta,
        true,
      );
    }

    // Cursor-inside-list_item path - find the list_item ancestor.
    const { $from } = sel;
    let liDepth = -1;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "list_item") {
        liDepth = d;
        break;
      }
    }
    if (liDepth < 0) return false;
    const liPos = $from.before(liDepth);
    return shiftListItemDepths(
      state,
      dispatch,
      [liPos],
      delta,
      true,
    );
  };
}

// ═══════════════════════════════════════════
//  Continue list on Enter at end of empty list item
// ═══════════════════════════════════════════
//
// Flat-list Enter handling lives in editor-ux.ts because Butter's
// `list_item` nodes are sibling blocks with a depth attr, not nested
// prosemirror-schema-list wrappers. Empty items become a normal
// paragraph there; nested empty items outdent one level; non-empty
// items split into two flat siblings.

// ═══════════════════════════════════════════
//  Plugin
// ═══════════════════════════════════════════

export function listOperationsPlugin(): PMPlugin {
  return keymap({
    "Alt-ArrowUp": moveBlockCmd(-1),
    "Alt-ArrowDown": moveBlockCmd(1),
    "Mod-Shift-ArrowUp": moveBlockCmd(-1),
    "Mod-Shift-ArrowDown": moveBlockCmd(1),
    "Mod-l": (state, dispatch) =>
      toggleTaskOnCurrentLine(state, dispatch, true),
    Tab: changeListItemDepth(1),
    "Shift-Tab": changeListItemDepth(-1),
  });
}
