/**
 * Editor UX: keymaps, input rules, and context menu.
 */
import {
  Menu,
  Platform,
  setIcon,
} from "obsidian";
import {
  pasteClipboardIntoEditor,
  pastePlainTextIntoEditor,
  runClipboardCommand,
} from "../util/dom-utils";
import { keymap } from "prosemirror-keymap";
import {
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlockKeepMarks,
  exitCode,
  deleteSelection,
  joinBackward,
  selectNodeBackward,
  joinForward,
  selectNodeForward,
  selectAll,
  toggleMark,
  setBlockType,
  wrapIn,
} from "prosemirror-commands";
import {
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  InputRule,
} from "prosemirror-inputrules";
import type { Mark, MarkType } from "prosemirror-model";
import { exitCalloutFromTrailingEmptyParagraph } from "./callout-enter";
import {
  EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Fragment, type Schema } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { enterMovesDown } from "./table-editing";
import { backspaceAtStartOfFlatListItem } from "./flat-list-editing";
import { buildInlineMathInputRule } from "./inline-math-input-rule";
import {
  allMarkdownShortcutSettings,
  type MarkdownShortcutSettings,
} from "./markdown-shortcuts";
import { tx, txKnown } from "../i18n";
import { dismissMenuOnScroll } from "../ui/menu-scroll-dismiss";
import {
  attachMenuSurfaceMotion,
  hideMenuSurfaceImmediately,
} from "../ui/surface-motion";
import { undo, redo } from "prosemirror-history";
import { clearFormatting } from "./formatting-actions";
import { openUnifiedLinkEditor } from "../ui/link-editor";
import {
  emitEditorMenuContributions,
  type GeneralContextMenuHost,
} from "./editor-menu-bridge";
import {
  CONTEXT_MENU_ENTRY_DEFS,
  contextMenuDefaultLayout,
  type ContextMenuEntryId,
} from "./context-menu-layout";
import type { Layout } from "../ui/toolbar-layout";
import {
  createDesktopContextMenuBridge,
  type DesktopContextMenuBridge,
  type DesktopContextMenuParams,
} from "./desktop-context-menu-bridge";
import {
  BUTTON_REGISTRY,
  MAIN_TOOLBAR_BUTTON_DEFS,
  applyToolbarColor,
  execBlockCmd,
  execHistoryCmd,
  execInsertCmd,
  execListCmd,
  execListDepthCmd,
  execMarkCmd,
  insertTable,
  setHeading,
  toolbarColorChoices,
  type BtnDef,
} from "../ui/toolbar";
import {
  buildBlockLifecycleMenuItems,
  buildSingleBlockMenuItems,
  renderBlockMenuItems,
  renderBlockLifecycleMenuItems,
  renderBlockMenuSubItems,
  type BlockMenuItem,
  type BlockSubItem,
} from "./block-menu-spec";
import {
  commandActionIcon,
  commandActionLabel,
  executeObsidianCommand,
  isObsidianCommandAvailable,
} from "../ui/command-actions";

/**
 * Marks that should remain active after an ordinary block continuation.
 *
 * An explicit stored-mark set wins, including the empty set produced when the
 * user toggles formatting off. Otherwise ProseMirror's marks at the caret are
 * the conventional continuation state.
 */
const continuationMarks = (state: EditorState): readonly Mark[] =>
  state.storedMarks ?? state.selection.$from.marks();

/** Restore active marks after a custom transaction moves the caret. */
const restoreContinuationMarks = (
  tr: Transaction,
  marks: readonly Mark[],
): Transaction => {
  if (!(tr.selection instanceof TextSelection) || !tr.selection.empty) return tr;
  const parent = tr.selection.$from.parent;
  if (!parent.type.inlineContent) return tr;
  return tr.setStoredMarks(parent.type.allowedMarks(marks));
};

// ── Task-list Enter command ──
//
// Enter behavior for task list items, per user expectation:
//   • Empty top-level task item → lift out of the list entirely
//   • Empty nested task item → fall through to the flat-list outdent
//   • Non-empty task item → split and carry the task attr over as
//     unchecked, so consecutive Enters produce a new `[ ]` each time
//     without the user retyping.
//
// Chained BEFORE the generic flat-list split so our version wins when
// the caret is inside a task.

const handleEnterInTaskList: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;

  // Find the enclosing list_item.
  let liDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "list_item") {
      liDepth = d;
      break;
    }
  }
  if (liDepth < 0) return false;

  const liNode = $from.node(liDepth);
  if (liNode.attrs.kind !== "task") return false;
  const marks = continuationMarks(state);

  const liPos = $from.before(liDepth);
  const liEnd = liPos + liNode.nodeSize;
  const paraEnd = liPos + 1 + liNode.firstChild!.nodeSize - 1;

  // Empty nested task - let the generic flat-list Enter handler
  // outdent it one level, matching Obsidian Live Preview.
  if (liNode.firstChild && liNode.firstChild.textContent.length === 0) {
    const depth = typeof liNode.attrs.depth === "number" ? liNode.attrs.depth : 0;
    if (depth > 0) return false;

    // Empty top-level task - convert the list_item directly to a
    // paragraph in place. (Flat schema: no parent list to escape
    // from. The item IS a top-level block; we just retype it.)
    if (!dispatch) return true;
    const tr = state.tr;
    const para = state.schema.nodes.paragraph.create();
    tr.replaceWith(liPos, liEnd, para);
    const newSel = TextSelection.near(tr.doc.resolve(liPos + 1));
    tr.setSelection(newSel);
    dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
    return true;
  }

  // Non-empty task - only handle end-of-item Enter here; mid-content
  // Enter falls through to the default split chain.
  if ($from.pos !== paraEnd) return false;

  // Build the new sibling task item directly after the current one,
  // with checked=false (fresh task) and matching kind/depth/tight so
  // it joins the visual run.
  if (!dispatch) return true;
  const schema = state.schema;
  const newPara = schema.nodes.paragraph.create();
  const liAttrs = liNode.attrs as { depth?: number; tight?: boolean };
  const newItem = schema.nodes.list_item.create(
    {
      kind: "task",
      depth: liAttrs.depth,
      tight: liAttrs.tight,
      checked: false,
      start: null,
    },
    newPara,
  );
  const tr = state.tr.insert(liEnd, newItem);
  const newCaret = liEnd + 2; // inside new paragraph
  tr.setSelection(TextSelection.near(tr.doc.resolve(newCaret)));
  dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
  return true;
};

// ── Flat-list Enter command ──

const handleEnterInFlatListItem: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;

  const { $from } = selection;
  let liDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "list_item") {
      liDepth = d;
      break;
    }
  }
  if (liDepth < 0) return false;

  const liNode = $from.node(liDepth);
  const marks = continuationMarks(state);
  const liPos = $from.before(liDepth);
  const liEnd = liPos + liNode.nodeSize;

  if (
    liNode.childCount === 1 &&
    liNode.firstChild?.type.name === "paragraph" &&
    liNode.firstChild.content.size === 0
  ) {
    const depth = typeof liNode.attrs.depth === "number" ? liNode.attrs.depth : 0;
    if (!dispatch) return true;
    if (depth > 0) {
      const tr = state.tr.setNodeMarkup(liPos, undefined, {
        ...liNode.attrs,
        depth: depth - 1,
        sourceRange: null,
      });
      tr.setSelection(TextSelection.near(tr.doc.resolve(liPos + 2)));
      dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
      return true;
    }
    const para = state.schema.nodes.paragraph.create();
    const tr = state.tr.replaceWith(liPos, liEnd, para);
    tr.setSelection(TextSelection.near(tr.doc.resolve(liPos + 1)));
    dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
    return true;
  }

  if ($from.depth !== liDepth + 1 || !$from.parent.type.inlineContent) {
    return false;
  }

  const childIndex = $from.index(liDepth);
  const currentBlock = liNode.child(childIndex);
  const splitOffset = $from.parentOffset;
  const beforeBlock = currentBlock.cut(0, splitOffset);
  const afterBlock = currentBlock.cut(splitOffset);

  if (!dispatch) return true;

  const leftChildren = [];
  for (let i = 0; i < childIndex; i++) leftChildren.push(liNode.child(i));
  leftChildren.push(beforeBlock);

  const rightChildren = [afterBlock];
  for (let i = childIndex + 1; i < liNode.childCount; i++) {
    rightChildren.push(liNode.child(i));
  }

  const liAttrs = liNode.attrs as Record<string, unknown>;
  const rightAttrs = {
    ...liAttrs,
    checked: liAttrs.kind === "task" ? false : liAttrs.checked,
    start: null,
    sourceRange: null,
  };
  const leftItem = liNode.type.create(
    { ...liAttrs, sourceRange: null },
    Fragment.fromArray(leftChildren),
  );
  const rightItem = liNode.type.create(rightAttrs, Fragment.fromArray(rightChildren));

  const tr = state.tr.replaceWith(
    liPos,
    liEnd,
    Fragment.fromArray([leftItem, rightItem]),
  );
  const rightItemPos = liPos + leftItem.nodeSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(rightItemPos + 2)));
  dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
  return true;
};

// ── Heading exit command ──

const handleEnterInHeading: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;

  const { $head } = selection;
  const parent = $head.parent;
  if (parent.type.name !== "heading") return false;
  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;
  const marks = continuationMarks(state);

  // Empty heading → convert to paragraph
  if (parent.content.size === 0) {
    if (dispatch) {
      const pos = $head.before();
      const tr = state.tr.setNodeMarkup(pos, paragraphType);
      dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
    }
    return true;
  }

  // End of heading → new paragraph after
  if ($head.parentOffset === parent.content.size) {
    if (dispatch) {
      const after = $head.after();
      const tr = state.tr.insert(after, paragraphType.create());
      tr.setSelection(Selection.near(tr.doc.resolve(after + 1)));
      dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
    }
    return true;
  }

  // Middle of heading → split, convert trailing to paragraph
  if (dispatch) {
    let tr = state.tr.split($head.pos);
    const mappedPos = tr.mapping.map($head.pos, 1);
    const $destination = tr.doc.resolve(mappedPos);
    const newBlockPos = $destination.before();
    tr = tr.setNodeMarkup(newBlockPos, paragraphType);
    tr.setSelection(TextSelection.near(tr.doc.resolve(newBlockPos + 1)));
    dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
  }
  return true;
};

// ── Fence-creation Enter command ──
//
// Users expect Obsidian's native behavior: type "```" (optionally
// followed by a language) and hit Enter to drop into a code block.
// The space-triggered `textblockTypeInputRule` below handles the
// "```lang " + space variant, but input rules don't fire on Enter
// (Enter isn't a text-input event), so we need this keymap to cover
// the muscle-memory case. It matches the current paragraph text
// against the fence pattern, converts the paragraph into an empty
// code_block of the requested language, and parks the cursor inside.
const handleEnterToCreateCodeFence: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  const parent = $from.parent;
  if (parent.type.name !== "paragraph") return false;
  // Match the fence marker + optional language. Permissive charset
  // covers c++, c#, vega-lite, obsidian-chart, etc. Deliberately
  // rejects whitespace inside the lang spec - users typing real
  // prose that happens to start with ``` get a normal Enter.
  const match = /^```([\w.+#-]*)$/.exec(parent.textContent);
  if (!match) return false;
  // Cursor must be at end of paragraph (don't trigger mid-line).
  if ($from.parentOffset !== parent.content.size) return false;
  const codeBlockType = state.schema.nodes.code_block;
  if (!codeBlockType) return false;
  if (!dispatch) return true;

  const language = match[1] || "";
  const parentStart = $from.before();
  const parentEnd = $from.after();
  const tr = state.tr.replaceRangeWith(
    parentStart,
    parentEnd,
    codeBlockType.create({ language }),
  );
  // Drop the cursor inside the new code block (parentStart + 1 = just
  // inside the code_block's content).
  tr.setSelection(TextSelection.near(tr.doc.resolve(parentStart + 1)));
  dispatch(tr.scrollIntoView());
  return true;
};

// ── Callout body Backspace ──
//
// When the cursor sits at the start of an empty paragraph that's the
// only child of an obsidian_callout: delete the paragraph (callout
// drops to its `block*` zero-child empty state, which renders as a
// slim title-only row matching Live Preview), AND shift DOM focus
// to the callout's title contenteditable so the user can keep
// editing the title.
//
// Default Backspace chain would either lift the paragraph out
// (destroying the callout) or select the callout for deletion
// neither matches LP's "delete body line, body collapses to slim"
// behavior, so this command intercepts before the chain runs.
const handleBackspaceInEmptyCalloutBody: Command = (state, dispatch, view) => {
  if (!view) return false;
  const { selection } = state;
  if (!selection.empty) return false;
  const $from = selection.$from;
  // Cursor must be at the start of an empty paragraph.
  if ($from.parentOffset !== 0) return false;
  if ($from.parent.type.name !== "paragraph") return false;
  if ($from.parent.content.size !== 0) return false;
  // Parent of paragraph must be an obsidian_callout with no other
  // children - i.e., the body is just this empty paragraph.
  if ($from.depth < 1) return false;
  const grandparent = $from.node($from.depth - 1);
  if (!grandparent || grandparent.type.name !== "obsidian_callout") return false;
  if (grandparent.childCount !== 1) return false;

  // Capture callout position BEFORE the dispatch so we can find its
  // DOM after PM re-renders. activeElement won't help here - by the
  // time we look it up, focus has bubbled to the editor root.
  const calloutPos = $from.before($from.depth - 1);

  if (dispatch) {
    // Delete the empty paragraph - callout drops to zero children.
    const paraStart = $from.before($from.depth);
    const paraEnd = $from.after($from.depth);
    const tr = state.tr.delete(paraStart, paraEnd);
    // Clear the callout's source-preservation key so the next save
    // re-serializes from the new (body-less) PM tree, not the cached
    // body-line bytes from when the body was non-empty.
    const calloutNode = state.doc.nodeAt(calloutPos);
    if (calloutNode?.type.name === "obsidian_callout") {
      tr.setNodeMarkup(calloutPos, undefined, {
        ...calloutNode.attrs,
        sourceRange: null,
      });
    }
    dispatch(tr);
  }

  // Find the callout's DOM via PM (NOT via activeElement, which is
  // already on the editor root by now), then focus its title and
  // place the caret at the end. Wait a frame so the NodeView has
  // re-rendered its slim/no-body state before we focus.
  window.requestAnimationFrame(() => {
    const calloutEl = view.nodeDOM(calloutPos) as HTMLElement | null;
    if (!calloutEl) return;
    const title = calloutEl.querySelector<HTMLElement>(
      ".butter-callout-title.callout-title-inner",
    );
    if (!title) return;
    title.focus();
    const range = title.ownerDocument.createRange();
    range.selectNodeContents(title);
    range.collapse(false);
    const sel = title.ownerDocument.defaultView?.getSelection();
    sel?.removeAllRanges();
    if (sel) sel.addRange(range);
  });
  return true;
};

// ── liftEmptyBlock guarded against callout body ──
//
// PM's stock `liftEmptyBlock` cannot distinguish a deliberate exit from a
// nested or non-terminal empty block. The targeted callout command above the
// standard chain owns the valid trailing-empty exit; this guard keeps every
// other empty block inside its callout and falls through to a normal split.
const liftEmptyBlockGuarded: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let d = $from.depth - 1; d >= 0; d--) {
    if ($from.node(d).type.name === "obsidian_callout") return false;
  }
  return liftEmptyBlock(state, dispatch);
};

// ── Build keymaps ──

export interface ButterKeymapOptions {
  markdownShortcuts?: () => MarkdownShortcutSettings;
}

export function buildKeymap(
  schema: Schema,
  options: ButterKeymapOptions = {},
) {
  const keys: Record<string, Command> = {};
  const codeFenceShortcut: Command = (state, dispatch, view) =>
    options.markdownShortcuts?.().codeBlocks === false
      ? false
      : handleEnterToCreateCodeFence(state, dispatch, view);

  // Enter: heading exit → standard chain. `enterMovesDown` runs FIRST
  // because PM's `liftEmptyBlock` and `splitBlockKeepMarks` would otherwise
  // catch the empty-cell case before us - `liftEmptyBlock` lifts an
  // empty paragraph out of its parent, which produces a malformed
  // doc when the parent is a table cell, and PM auto-corrects by
  // doing weird things (often appearing as "a new row got inserted"
  // to the user). `enterMovesDown` is a no-op outside of cells, so
  // it's safe to put first.
  keys["Enter"] = chainCommands(
    enterMovesDown,
    handleEnterInHeading,
    codeFenceShortcut,
    exitCalloutFromTrailingEmptyParagraph,
    newlineInCode,
    createParagraphNear,
    liftEmptyBlockGuarded,
    splitBlockKeepMarks,
  );

  keys["Mod-Enter"] = exitCode;

  // Backspace/Delete
  keys["Backspace"] = chainCommands(
    handleBackspaceInEmptyCalloutBody,
    deleteSelection,
    backspaceAtStartOfFlatListItem,
    joinBackward,
    selectNodeBackward,
  );
  keys["Mod-Backspace"] = chainCommands(
    handleBackspaceInEmptyCalloutBody,
    deleteSelection,
    backspaceAtStartOfFlatListItem,
    joinBackward,
    selectNodeBackward,
  );
  keys["Delete"] = chainCommands(
    deleteSelection,
    joinForward,
    selectNodeForward,
  );
  keys["Mod-Delete"] = keys["Delete"];
  keys["Mod-a"] = selectAll;

  // List keybindings - task-aware Enter is chained before the generic
  // flat-list split so empty tasks exit the list and non-empty tasks
  // produce a new unchecked task item without user retyping the marker.
  if (schema.nodes.list_item) {
    keys["Enter"] = chainCommands(
      enterMovesDown,
      handleEnterInHeading,
      codeFenceShortcut,
      exitCalloutFromTrailingEmptyParagraph,
      handleEnterInTaskList,
      handleEnterInFlatListItem,
      newlineInCode,
      createParagraphNear,
      liftEmptyBlockGuarded,
      splitBlockKeepMarks,
    );
    // Tab / Shift-Tab are handled by listOperationsPlugin's
    // changeListItemDepth - flat-list schema needs depth-attr
    // mutation, not pm-schema-list's container-aware sinkListItem /
    // liftListItem (which assume bullet_list/ordered_list wrappers
    // that no longer exist).
  }

  // Shift+Enter inserts an explicit Markdown hard break inside the current
  // textblock and keeps the user's active formatting for subsequent input.
  // Source-authored soft line wraps remain represented by `softbreak`; this
  // command represents the deliberate rich-editor line-break action.
  if (schema.nodes.hard_break) {
    keys["Shift-Enter"] = (state, dispatch) => {
      const { $from, $to } = state.selection;
      const hardBreak = schema.nodes.hard_break;
      if (
        !$from.sameParent($to) ||
        !$from.parent.type.inlineContent ||
        !$from.parent.canReplaceWith($from.index(), $to.index(), hardBreak)
      ) {
        return false;
      }
      if (dispatch) {
        const marks = continuationMarks(state);
        const tr = state.tr.replaceSelectionWith(
          hardBreak.create(),
          false,
        );
        dispatch(restoreContinuationMarks(tr, marks).scrollIntoView());
      }
      return true;
    };
  }

  // Heading shortcuts Mod-Alt-1 through Mod-Alt-6
  for (let level = 1; level <= 6; level++) {
    keys[`Mod-Alt-${level}`] = setBlockType(schema.nodes.heading, { level });
  }
  keys["Mod-Alt-0"] = setBlockType(schema.nodes.paragraph);

  // Blockquote
  if (schema.nodes.blockquote) {
    keys["Mod-Shift-b"] = wrapIn(schema.nodes.blockquote);
  }

  return keymap(keys);
}

// ── Build input rules ──

export interface ButterInputRuleOptions {
  markdownShortcuts?: MarkdownShortcutSettings;
  /** Compatibility for older internal callers and extensions. */
  enableMarkdownShortcuts?: boolean;
}

export function buildInputRules(
  schema: Schema,
  options: ButterInputRuleOptions = {},
) {
  const shortcuts = options.markdownShortcuts
    ?? allMarkdownShortcutSettings(options.enableMarkdownShortcuts !== false);

  const rules: InputRule[] = [];

  // Heading input rules: # → h1, ## → h2, etc.
  if (shortcuts.headings) {
    for (let level = 1; level <= 6; level++) {
      const pattern = new RegExp(`^(#{${level}})\\s$`);
      rules.push(textblockTypeInputRule(pattern, schema.nodes.heading, { level }));
    }
  }

  // Blockquote: > at start of line
  if (shortcuts.blockquotes) {
    rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));
  }

  // ── Flat-list input rules ──
  //
  // Butter's flat schema: typing `- `, `* `, `1. ` at the start of
  // a paragraph CONVERTS that paragraph into a `list_item` with the
  // appropriate `kind`/`start` attrs. No `bullet_list`/`ordered_list`
  // wrapper. Subsequent items typed below become flat siblings; their
  // visual grouping into a "list" is emergent (CSS reads `data-kind`
  // + `data-depth` and renders the marker column accordingly).
  //
  // Conversion is two-step: delete the matched prefix from the
  // paragraph, then re-wrap the paragraph (now sans prefix) in a
  // list_item. `replaceRangeWith` would have worked too but the
  // two-step is easier to read and the position math is trivial.
  function makeListItemConversion(
    kind: "bullet" | "ordered",
    extraAttrs?: (match: RegExpMatchArray) => Record<string, unknown>,
  ) {
    return (state: EditorState, match: RegExpMatchArray, start: number, end: number) => {
      const $start = state.doc.resolve(start);
      const parent = $start.parent;
      if (parent.type.name !== "paragraph") return null;
      // Bail if this paragraph is already inside a list_item (no
      // structural nesting in the flat schema; the `- ` would create
      // a list_item whose schema-invalid position breaks the doc).
      // The user can press Tab to indent instead.
      const grandparent = $start.node($start.depth - 1);
      if (grandparent && grandparent.type.name === "list_item") return null;

      const tr = state.tr.delete(start, end);
      const $afterDelete = tr.doc.resolve(start);
      const before = $afterDelete.before();
      const after = $afterDelete.after();
      const para = $afterDelete.parent;
      const itemAttrs: Record<string, unknown> = {
        kind,
        depth: 0,
        tight: true,
        checked: null,
        start: null,
        ...(extraAttrs ? extraAttrs(match) : {}),
      };
      const item = schema.nodes.list_item.create(itemAttrs, [para]);
      tr.replaceWith(before, after, item);
      return tr;
    };
  }

  // Bullet list: `- ` or `* ` at start of paragraph.
  if (shortcuts.bulletLists) {
    rules.push(new InputRule(/^\s*[-*]\s$/, makeListItemConversion("bullet")));
  }

  // Ordered list: `N. ` at start of paragraph. The matched number
  // becomes the item's explicit run-start attr. We retain 1 too: in the flat
  // list model it distinguishes a newly typed ordered run from continuation.
  if (shortcuts.numberedLists) rules.push(
    new InputRule(/^(\d{1,9})\.\s$/, makeListItemConversion("ordered", (m) => ({
      start: +m[1],
    }))),
  );

  // Task list: `- [ ] ` or `- [x] ` typed all at once on a bare
  // paragraph converts straight to a task list_item.
  //
  // For the typing flow `- ` (becomes bullet item) → `[ ] ` (user
  // wants it to become a task), see the second rule below - it
  // matches `[ ] ` at the start of an EXISTING bullet list_item's
  // paragraph and flips the kind in place via setNodeMarkup.
  if (shortcuts.taskLists) rules.push(
    new InputRule(/^\s*[-*]\s\[([ xX])\]\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start);
      const parent = $start.parent;
      if (parent.type.name !== "paragraph") return null;
      const grandparent = $start.node($start.depth - 1);
      if (grandparent && grandparent.type.name === "list_item") return null;
      const tr = state.tr.delete(start, end);
      const $afterDelete = tr.doc.resolve(start);
      const before = $afterDelete.before();
      const after = $afterDelete.after();
      const para = $afterDelete.parent;
      const checked = match[1].toLowerCase() === "x";
      const item = schema.nodes.list_item.create(
        {
          kind: "task",
          depth: 0,
          tight: true,
          checked,
          start: null,
        },
        [para],
      );
      tr.replaceWith(before, after, item);
      return tr;
    }),
  );

  // Bullet → task in-place: `[ ]` or `[x]` typed at the start of an
  // EXISTING bullet list_item's paragraph flips the kind to task
  // without restructuring. Matches the Notion/Linear typing flow:
  // user types `- ` (becomes bullet), then types `[ ] ` (becomes
  // task). Only fires when the parent paragraph is the FIRST child
  // of a bullet list_item (not on subsequent paragraphs in a loose
  // item, where the bracket text is just content).
  if (shortcuts.taskLists) rules.push(
    new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start);
      const parent = $start.parent;
      if (parent.type.name !== "paragraph") return null;
      const grandparent = $start.node($start.depth - 1);
      if (!grandparent || grandparent.type.name !== "list_item") return null;
      if (grandparent.attrs.kind !== "bullet") return null;
      // Only the FIRST paragraph of the list_item - subsequent ones
      // in a loose item shouldn't trigger a kind flip.
      const paraIndex = $start.index($start.depth - 1);
      if (paraIndex !== 0) return null;
      const checked = match[1].toLowerCase() === "x";
      const liPos = $start.before($start.depth - 1);
      const tr = state.tr.delete(start, end);
      tr.setNodeMarkup(liPos, undefined, {
        ...grandparent.attrs,
        kind: "task",
        checked,
        sourceRange: null,
      });
      return tr;
    }),
  );

  // Code block: ``` (optional lang) + whitespace at start of line.
  // Permissive language charset covers c++, c#, vega-lite, ad-note,
  // obsidian-chart, etc. - anything a plugin might register a
  // code-block processor for. The Enter-key variant is handled by
  // `handleEnterToCreateCodeFence` in the keymap above.
  if (shortcuts.codeBlocks) {
    rules.push(textblockTypeInputRule(/^```([\w.+#-]*)\s$/, schema.nodes.code_block, (match) => ({
      language: match[1] || "",
    })));
  }

  // Horizontal rule: --- at start of line.
  //
  // The first replaceWith shrinks the doc (3 chars "---" → 1-node hr),
  // so the original `end` position is past the new doc end. Map it
  // through tr.mapping before using it for the trailing-paragraph
  // insert; otherwise PM throws `Position N out of range` and the
  // input event tears down the editor.
  if (shortcuts.horizontalRules) rules.push(new InputRule(/^---$/, (state, match, start, end) => {
    const tr = state.tr.replaceWith(
      start - 1,
      end,
      schema.nodes.horizontal_rule.create(),
    );
    return tr.insert(tr.mapping.map(end), schema.nodes.paragraph.create());
  }));

  // Tag: #tagname followed by space - converts text to tag node + space
  if (shortcuts.tags && schema.nodes.obsidian_tag) {
    rules.push(new InputRule(
      /(?:^|\s)#([a-zA-Z0-9_/-]*[a-zA-Z_/-][a-zA-Z0-9_/-]*)\s$/,
      (state, match, start, end) => {
        const tag = match[1];
        const hashStart = start + match[0].indexOf("#");
        const tagNode = schema.nodes.obsidian_tag.create({ tag });
        const space = state.schema.text(" ");
        return state.tr.replaceWith(hashStart, end, Fragment.from([tagNode, space]));
      },
    ));
  }

  // Task toggle: typing `[ ] ` or `[x] ` at the start of a list_item's
  // first paragraph sets the list_item's `checked` attr and deletes
  // the typed characters. Lets users create tasks by typing, not just
  // via Mod+L.
  if (shortcuts.taskLists && schema.nodes.list_item) {
    rules.push(
      new InputRule(
        /^\[([ xX])\]\s$/,
        (state, match, start, end) => {
          const $start = state.doc.resolve(start);
          // Find enclosing list_item - must be the direct parent of
          // the paragraph containing the caret, so the input only
          // fires at the *start* of a list item, never mid-doc.
          let liPos = -1;
          let liNode = null;
          for (let d = $start.depth; d > 0; d--) {
            const n = $start.node(d);
            if (n.type.name === "list_item") {
              liPos = $start.before(d);
              liNode = n;
              break;
            }
          }
          if (liPos < 0 || !liNode) return null;

          // Only fire if the typed chars are literally at position 0
          // of the paragraph (paragraph start is liPos + 2 in PM
          // coordinates).
          if (start !== liPos + 2) return null;

          const checked = match[1].toLowerCase() === "x";
          return state.tr
            .delete(start, end)
            .setNodeMarkup(liPos, undefined, {
              ...liNode.attrs,
              checked,
              sourceRange: null,
            });
        },
      ),
    );
  }

  // Wikilink: typing ]] after [[target converts to wikilink node
  if (shortcuts.wikilinks && schema.nodes.wikilink) {
    rules.push(new InputRule(
      /\[\[([^\]]+)\]\]$/,
      (state, match, start, end) => {
        const inner = match[1];
        const pipeIdx = inner.indexOf("|");
        const target = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
        const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : "";
        const node = schema.nodes.wikilink.create({ target, alias });
        return state.tr.replaceWith(start, end, node);
      },
    ));
  }

  // ── Inline mark rules ──
  // Typing `**text**` wraps `text` with the strong mark and removes
  // the delimiters, so markdown shortcuts feel native.

  // Inline math: `$x + 1$` becomes an inline math atom as soon as
  // the closing `$` is typed. Currency-shaped dollars intentionally
  // stay plain text.
  const inlineMathRule = buildInlineMathInputRule(schema);
  if (shortcuts.inlineMath && inlineMathRule) rules.push(inlineMathRule);

  const wrapMark = (
    pattern: RegExp,
    mark: MarkType | undefined,
    contentGroup = 1,
    prefixGroup?: number,
  ): InputRule | null => {
    if (!mark) return null;
    return new InputRule(pattern, (state, match, start, end) => {
      const content = match[contentGroup];
      if (!content) return null;
      const prefix = prefixGroup === undefined ? "" : match[prefixGroup] ?? "";
      const tr = state.tr;
      const marked = state.schema.text(content, [mark.create()]);
      tr.replaceWith(
        start,
        end,
        prefix
          ? Fragment.fromArray([state.schema.text(prefix), marked])
          : marked,
      );
      tr.removeStoredMark(mark);
      return tr;
    });
  };

  const add = (r: InputRule | null) => {
    if (r) rules.push(r);
  };

  // Bold - `**text**` and `__text__`
  if (shortcuts.bold) {
    add(wrapMark(/(^|\s)\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, schema.marks.strong, 2, 1));
    add(wrapMark(/(^|\s)__([^_\s](?:[^_]*[^_\s])?)__$/, schema.marks.strong, 2, 1));
  }

  // Italic - `*text*` and `_text_` (but not inside **...**)
  if (shortcuts.italic) {
    add(wrapMark(/(^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, schema.marks.em, 2, 1));
    add(wrapMark(/(^|[^_])_([^_\s](?:[^_]*[^_\s])?)_$/, schema.marks.em, 2, 1));
  }

  // Strikethrough - `~~text~~`
  if (shortcuts.strikethrough) {
    add(wrapMark(/~~([^~\s](?:[^~]*[^~\s])?)~~$/, schema.marks.strikethrough));
  }

  // Inline code - `` `text` ``
  if (shortcuts.inlineCode) {
    add(wrapMark(/`([^`\s](?:[^`]*[^`\s])?)`$/, schema.marks.code));
  }

  // Highlight - `==text==`
  if (shortcuts.highlight) {
    add(wrapMark(/==([^=\s](?:[^=]*[^=\s])?)==$/, schema.marks.highlight));
  }

  // Link - `[text](url)`
  if (shortcuts.markdownLinks && schema.marks.link) {
    rules.push(
      new InputRule(
        /\[([^\]]+)\]\(([^)\s]+)\)$/,
        (state, match, start, end) => {
          const [, text, href] = match;
          const linkMark = schema.marks.link;
          const tr = state.tr;
          tr.replaceWith(
            start,
            end,
            state.schema.text(text, [linkMark.create({ href })]),
          );
          tr.removeStoredMark(linkMark);
          return tr;
        },
      ),
    );
  }

  return inputRules({ rules });
}

// ── Context menu ──

export function contextMenuPlugin(
  schema: Schema,
  host?: GeneralContextMenuHost,
) {
  let desktopBridge: DesktopContextMenuBridge | null = null;
  const deferDesktopMenu = (
    view: EditorView,
    event: MouseEvent,
    blockOverride?: ContextBlock,
  ): boolean => desktopBridge?.defer(event, (params) => {
    showContextMenu(
      schema,
      view,
      event,
      host,
      blockOverride,
      buildSpellingMenuContext(view, event, params, desktopBridge),
    );
  }) ?? false;

  return new Plugin({
    key: new PluginKey("butter-context-menu"),
    view(view) {
      // Callout headers are NodeView-owned chrome. Their stopEvent protects
      // title editing, but also prevents PM's bubble-phase contextmenu hook.
      // Capture only that chrome here; custom atom/image menus keep ownership
      // of their own targets.
      const onCalloutHeaderContextMenu = (event: MouseEvent) => {
        if (Platform.isMobile || !view.editable) return;
        const block = contextBlockAtCalloutHeader(view, event.target);
        if (!block) return;
        if (deferDesktopMenu(view, event, block)) {
          // Keep the event out of PM's bubble handler while still allowing
          // Chromium to produce Electron's spelling context-menu payload.
          event.stopPropagation();
          event.stopImmediatePropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        showContextMenu(schema, view, event, host, block);
      };
      desktopBridge = createDesktopContextMenuBridge(view.dom.ownerDocument.defaultView ?? window);
      view.dom.addEventListener("contextmenu", onCalloutHeaderContextMenu, true);
      return {
        destroy: () => {
          desktopBridge?.destroy();
          desktopBridge = null;
          view.dom.removeEventListener(
            "contextmenu",
            onCalloutHeaderContextMenu,
            true,
          );
        },
      };
    },
    props: {
      handleDOMEvents: {
        contextmenu: (view: EditorView, event: MouseEvent) => {
          // On mobile, the touch long-press that begins a text
          // selection fires `contextmenu` - opening our formatting
          // menu mid-selection. Skip and let the platform handle the
          // selection gesture natively.
          if (Platform.isMobile) return false;
          if (!view.editable) return false;
          if (deferDesktopMenu(view, event)) return false;
          event.preventDefault();
          showContextMenu(schema, view, event, host);
          return true;
        },
      },
    },
  });
}

type SpellingRange = { from: number; to: number };

type SpellingMenuContext = {
  word: string;
  suggestions: string[];
  replace: (suggestion: string) => void;
  addToDictionary: () => void;
};

function resolveSpellingRange(
  view: EditorView,
  event: MouseEvent,
  word: string,
): SpellingRange | null {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const $hit = view.state.doc.resolve(hit.pos);
  let depth = $hit.depth;
  while (depth > 0 && !$hit.node(depth).isTextblock) depth -= 1;
  if (!$hit.node(depth).isTextblock) return null;

  const block = $hit.node(depth);
  const blockStart = $hit.start(depth);
  // One replacement character per inline atom keeps string offsets aligned
  // with ProseMirror content positions while preserving marked text runs.
  const text = block.textBetween(0, block.content.size, "", "\uFFFC");
  const clickOffset = Math.max(0, Math.min(text.length, hit.pos - blockStart));
  const candidates: number[] = [];
  for (let index = text.indexOf(word); index >= 0; index = text.indexOf(word, index + 1)) {
    candidates.push(index);
  }
  if (candidates.length === 0) {
    const foldedText = text.toLocaleLowerCase();
    const foldedWord = word.toLocaleLowerCase();
    for (
      let index = foldedText.indexOf(foldedWord);
      index >= 0;
      index = foldedText.indexOf(foldedWord, index + 1)
    ) candidates.push(index);
  }
  if (candidates.length === 0) return null;
  const start = candidates.reduce((best, candidate) => {
    const distance = clickOffset < candidate
      ? candidate - clickOffset
      : clickOffset > candidate + word.length
        ? clickOffset - (candidate + word.length)
        : 0;
    const bestDistance = clickOffset < best
      ? best - clickOffset
      : clickOffset > best + word.length
        ? clickOffset - (best + word.length)
        : 0;
    return distance < bestDistance ? candidate : best;
  });
  return { from: blockStart + start, to: blockStart + start + word.length };
}

function buildSpellingMenuContext(
  view: EditorView,
  event: MouseEvent,
  params: DesktopContextMenuParams,
  bridge: DesktopContextMenuBridge | null,
): SpellingMenuContext | undefined {
  const word = params.misspelledWord;
  if (!word) return undefined;
  const range = resolveSpellingRange(view, event, word);
  const suggestions = Array.from(new Set(params.dictionarySuggestions))
    .filter((suggestion) => suggestion !== word)
    .slice(0, 5);
  return {
    word,
    suggestions,
    replace: (suggestion) => {
      if (!range) return;
      const current = view.state.doc.textBetween(range.from, range.to, "", "\uFFFC");
      if (current !== word) return;
      const tr = view.state.tr.insertText(suggestion, range.from, range.to);
      tr.setSelection(TextSelection.create(tr.doc, range.from + suggestion.length));
      view.dispatch(tr);
      window.setTimeout(() => view.focus(), 0);
    },
    addToDictionary: () => {
      bridge?.addWordToDictionary(word);
      window.setTimeout(() => view.focus(), 0);
    },
  };
}

/**
 * Trim leading + trailing whitespace from the selection produced by a
 * double-click. Chromium's word-segmentation occasionally includes a
 * leading space when double-clicking a word that follows whitespace
 * inside contenteditable - visible in Butter as "select-the-word"
 * highlighting one extra char to the left. Browser-level fix isn't
 * available, so we listen for `dblclick`, wait one rAF for the
 * selection to settle, and narrow it to the non-whitespace span.
 *
 * Skips when the selection straddles inline atoms (textBetween
 * length wouldn't match the position range, so position arithmetic
 * gets unreliable). The common case - double-click in a plain text
 * run - is the case we care about.
 */
export function trimDblClickSelectionPlugin() {
  return new Plugin({
    key: new PluginKey("butter-trim-dblclick-selection"),
    props: {
      handleDOMEvents: {
        dblclick: (view: EditorView) => {
          window.requestAnimationFrame(() => trimDblClickSelection(view));
          return false;
        },
      },
    },
  });
}

function trimDblClickSelection(view: EditorView): void {
  const { state } = view;
  const sel = state.selection;
  if (!(sel instanceof TextSelection)) return;
  if (sel.empty) return;
  const { from, to } = sel;
  const text = state.doc.textBetween(from, to);
  // Atoms / block boundaries make textBetween shorter than `to - from`.
  // Bail rather than mis-map position arithmetic onto something we
  // didn't intend to touch.
  if (text.length !== to - from) return;
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  let j = text.length;
  while (j > i && /\s/.test(text[j - 1])) j--;
  if (i === 0 && j === text.length) return; // nothing to trim
  const newFrom = from + i;
  const newTo = from + j;
  if (newFrom >= newTo) return; // selection was all whitespace; leave it
  view.dispatch(
    state.tr.setSelection(TextSelection.create(state.doc, newFrom, newTo)),
  );
}

function markIsActive(state: EditorState, markType: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    return Boolean(markType.isInSet(state.storedMarks ?? $from.marks()));
  }
  return state.doc.rangeHasMark(from, to, markType);
}

function runCommand(view: EditorView, command: Command): void {
  if (command(view.state, view.dispatch.bind(view), view)) view.focus();
}

function contextBlockAtSelection(view: EditorView): {
  pos: number;
  node: import("prosemirror-model").Node;
} | null {
  const { selection } = view.state;
  if (selection.$from.depth < 1) {
    const node = view.state.doc.nodeAt(selection.from);
    return node?.isBlock ? { pos: selection.from, node } : null;
  }
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.type.name === "list_item") {
      return { pos: selection.$from.before(depth), node };
    }
  }
  const depth = selection.$from.depth;
  const node = selection.$from.node(depth);
  return node.isBlock ? { pos: selection.$from.before(depth), node } : null;
}

type ContextBlock = NonNullable<ReturnType<typeof contextBlockAtSelection>>;

let quickActionLabelId = 0;

function contextBlockAtCalloutHeader(
  view: EditorView,
  eventTarget: EventTarget | null,
): ContextBlock | null {
  if (!(eventTarget instanceof Element)) return null;
  if (!eventTarget.closest(".butter-callout-header")) return null;
  const callout = eventTarget.closest<HTMLElement>(".butter-callout-view");
  if (!callout || !view.dom.contains(callout)) return null;
  try {
    const mapped = view.posAtDOM(callout, 0);
    const direct = view.state.doc.nodeAt(mapped);
    if (direct?.type.name === "obsidian_callout") {
      return { pos: mapped, node: direct };
    }
    const resolved = view.state.doc.resolve(
      Math.max(0, Math.min(mapped, view.state.doc.content.size)),
    );
    for (let depth = resolved.depth; depth > 0; depth--) {
      const node = resolved.node(depth);
      if (node.type.name === "obsidian_callout") {
        return { pos: resolved.before(depth), node };
      }
    }
  } catch { /* detached NodeView */ }
  return null;
}

function runCanonicalBlockItem(
  view: EditorView,
  block: ContextBlock,
  item: BlockMenuItem | BlockSubItem,
  activation: MouseEvent | KeyboardEvent,
): void {
  if (item.applyTr) {
    const tr = view.state.tr;
    item.applyTr(tr, block.pos, block.node);
    if (tr.docChanged) view.dispatch(tr);
    view.focus();
  } else if (item.sideEffect) {
    item.sideEffect(view, block.pos, block.node, activation);
  }
  dismissActiveGeneralContextMenu();
}

function canonicalBlockMenuContext(
  view: EditorView,
  host: GeneralContextMenuHost | undefined,
  blockOverride?: ContextBlock,
): { block: ContextBlock; items: BlockMenuItem[] } | null {
  const block = blockOverride ?? contextBlockAtSelection(view);
  if (!block || !host) return null;
  return {
    block,
    items: buildSingleBlockMenuItems({
      view,
      pos: block.pos,
      node: block.node,
      app: host.app,
      blockDom: view.nodeDOM(block.pos) as HTMLElement | undefined,
    }),
  };
}

function populateCanonicalTurnIntoMenu(
  menu: Menu,
  view: EditorView,
  host: GeneralContextMenuHost | undefined,
  blockOverride?: ContextBlock,
): boolean {
  const context = canonicalBlockMenuContext(view, host, blockOverride);
  const item = context?.items.find((candidate) => candidate.id === "turn-into");
  if (!context || !item?.submenu) return false;
  renderBlockMenuSubItems(menu, item, (subItem, activation) =>
    runCanonicalBlockItem(view, context.block, subItem, activation));
  return true;
}

function addCanonicalTurnIntoSubmenu(
  menu: Menu,
  view: EditorView,
  host: GeneralContextMenuHost | undefined,
  blockOverride?: ContextBlock,
): boolean {
  const context = canonicalBlockMenuContext(view, host, blockOverride);
  const item = context?.items.find((candidate) => candidate.id === "turn-into");
  if (!context || !item?.submenu) return false;
  menu.addItem((menuItem) => {
    menuItem.setTitle(tx(item.title)).setIcon(item.icon);
    renderBlockMenuSubItems(menuItem.setSubmenu(), item, (subItem, activation) =>
      runCanonicalBlockItem(view, context.block, subItem, activation));
  });
  return true;
}

function populateInsertMenu(
  menu: Menu,
  schema: Schema,
  view: EditorView,
  host?: GeneralContextMenuHost,
): void {
  menu.setUseNativeMenu(false);
  attachMenuSurfaceMotion(menu, "submenu");
  if (host) {
    menu.addItem((item) =>
      item.setTitle(tx("Add link")).setIcon("link").onClick(() => {
        const coords = view.coordsAtPos(view.state.selection.head);
        openUnifiedLinkEditor({
          app: host.app,
          view,
          anchor: view.dom,
          sourcePath: host.getInfo().file?.path ?? "",
          event: { clientX: coords.left, clientY: coords.bottom } as MouseEvent,
          autoFocus: true,
        });
      }),
    );
    const image = BUTTON_REGISTRY.get("image");
    if (image) {
      menu.addItem((item) =>
        item.setTitle(tx(image.label)).setIcon(image.icon).onClick(() => {
          execInsertCmd(
            image,
            schema,
            view,
            host.app,
            () => host.getInfo().file?.path ?? "",
          );
        }),
      );
    }
    menu.addSeparator();
  }
  if (schema.nodes.horizontal_rule) {
    menu.addItem((item) =>
      item.setTitle(tx("Horizontal rule")).setIcon("minus").onClick(() => {
        view.dispatch(view.state.tr.replaceSelectionWith(
          schema.nodes.horizontal_rule.create(),
        ));
        view.focus();
      }),
    );
  }
  const { table, table_row, table_header, table_cell } = schema.nodes;
  if (table && table_row && table_header && table_cell) {
    menu.addItem((item) =>
      item.setTitle(tx("Table")).setIcon("table").onClick(() => {
        const header = table_row.create(null, Array.from(
          { length: 3 },
          () => table_header.createAndFill()!,
        ));
        const body = Array.from({ length: 2 }, () => table_row.create(
          null,
          Array.from({ length: 3 }, () => table_cell.createAndFill()!),
        ));
        view.dispatch(view.state.tr.replaceSelectionWith(
          table.create(null, [header, ...body]),
        ).scrollIntoView());
        view.focus();
      }),
    );
  }
  if (schema.nodes.math_block) {
    menu.addItem((item) =>
      item.setTitle(tx("Math block")).setIcon("sigma").onClick(() => {
        view.dispatch(view.state.tr.replaceSelectionWith(
          schema.nodes.math_block.create({ value: "" }),
        ).scrollIntoView());
        view.focus();
      }),
    );
  }
  if (schema.nodes.obsidian_callout && schema.nodes.paragraph) {
    menu.addItem((item) =>
      item.setTitle(tx("Note callout")).setIcon("pencil").onClick(() => {
        const from = view.state.selection.from;
        const tr = view.state.tr.replaceSelectionWith(
          schema.nodes.obsidian_callout.create(
            { calloutType: "note" },
            schema.nodes.paragraph.create(),
          ),
        ).scrollIntoView();
        tr.setSelection(Selection.near(tr.doc.resolve(
          Math.min(from + 2, tr.doc.content.size),
        )));
        view.dispatch(tr);
        view.focus();
      }),
    );
  }
}

function addInsertSubmenu(
  menu: Menu,
  schema: Schema,
  view: EditorView,
  host?: GeneralContextMenuHost,
): void {
  menu.addItem((item) => {
    item.setTitle(tx("Insert")).setIcon("plus");
    populateInsertMenu(item.setSubmenu(), schema, view, host);
  });
}

export function populateGeneralContextMenu(
  menu: Menu,
  schema: Schema,
  view: EditorView,
  host?: GeneralContextMenuHost,
  blockOverride?: ContextBlock,
  spelling?: SpellingMenuContext,
): void {
  const hasSelection = !view.state.selection.empty;
  type ActionSpec = {
    id: ContextMenuEntryId;
    title: Parameters<typeof tx>[0];
    icon: string;
    enabled: () => boolean;
    checked?: () => boolean;
    run: () => void;
  };

  const markAction = (
    id: ContextMenuEntryId,
    title: Parameters<typeof tx>[0],
    icon: string,
    mark: MarkType | undefined,
  ): ActionSpec => ({
    id,
    title,
    icon,
    enabled: () => Boolean(mark),
    checked: () => Boolean(mark && markIsActive(view.state, mark)),
    run: () => {
      if (mark) runCommand(view, toggleMark(mark));
    },
  });

  const actions = new Map<ContextMenuEntryId, ActionSpec>([
    ["undo", { id: "undo", title: "Undo", icon: "undo-2", enabled: () => undo(view.state), run: () => runCommand(view, undo) }],
    ["redo", { id: "redo", title: "Redo", icon: "redo-2", enabled: () => redo(view.state), run: () => runCommand(view, redo) }],
    ["cut", { id: "cut", title: "Cut", icon: "scissors", enabled: () => hasSelection, run: () => runClipboardCommand(view.dom.ownerDocument, "cut") }],
    ["copy", { id: "copy", title: "Copy", icon: "copy", enabled: () => hasSelection, run: () => runClipboardCommand(view.dom.ownerDocument, "copy") }],
    ["paste", { id: "paste", title: "Paste", icon: "clipboard-check", enabled: () => true, run: () => { void pasteClipboardIntoEditor(view); } }],
    ["paste-plain", { id: "paste-plain", title: "Paste as plain text", icon: "clipboard-type", enabled: () => true, run: () => { void pastePlainTextIntoEditor(view); } }],
    ["select-all", { id: "select-all", title: "Select all", icon: "text-select", enabled: () => true, run: () => runCommand(view, selectAll) }],
    ["bold", markAction("bold", "Bold", "bold", schema.marks.strong)],
    ["italic", markAction("italic", "Italic", "italic", schema.marks.em)],
    ["strikethrough", markAction("strikethrough", "Strikethrough", "strikethrough", schema.marks.strikethrough)],
    ["highlight", markAction("highlight", "Highlight", "highlighter", schema.marks.highlight)],
    ["inline-code", markAction("inline-code", "Inline code", "code-2", schema.marks.code)],
    ["add-link", {
      id: "add-link",
      title: "Add link",
      icon: "link",
      enabled: () => Boolean(schema.marks.link),
      checked: () => Boolean(schema.marks.link && markIsActive(view.state, schema.marks.link)),
      run: () => {
        if (!schema.marks.link || !host) return;
        const coords = view.coordsAtPos(view.state.selection.head);
        openUnifiedLinkEditor({
          app: host.app,
          view,
          anchor: view.dom,
          sourcePath: host.getInfo().file?.path ?? "",
          event: { clientX: coords.left, clientY: coords.bottom } as MouseEvent,
          autoFocus: true,
        });
      },
    }],
    ["clear-formatting", {
      id: "clear-formatting",
      title: "Clear formatting",
      icon: "remove-formatting",
      enabled: () => true,
      run: () => {
        clearFormatting(view, schema);
        view.focus();
      },
    }],
  ]);

  const sourcePath = (): string => host?.getInfo().file?.path ?? "";
  const toolbarAction = (definition: BtnDef): ActionSpec | null => {
    if (["insert", "turn-into", "block-actions", "text-color"].includes(definition.id)) {
      return null;
    }
    const mark = definition.markName ? schema.marks[definition.markName] : undefined;
    const nodeName = definition.nodeName === "bullet_list"
      || definition.nodeName === "ordered_list"
      || definition.nodeName === "task_list"
      ? "list_item"
      : definition.nodeName;
    const enabled = (): boolean => {
      if (definition.markName) return Boolean(mark);
      if (nodeName) return Boolean(schema.nodes[nodeName]);
      return true;
    };
    return {
      id: definition.id,
      title: definition.label,
      icon: definition.icon,
      enabled,
      checked: definition.kind === "mark" && mark
        ? () => markIsActive(view.state, mark)
        : undefined,
      run: () => {
        if (definition.id === "link") {
          if (!host) return;
          const coords = view.coordsAtPos(view.state.selection.head);
          openUnifiedLinkEditor({
            app: host.app,
            view,
            anchor: view.dom,
            sourcePath: host.getInfo().file?.path ?? "",
            event: { clientX: coords.left, clientY: coords.bottom } as MouseEvent,
            autoFocus: true,
          });
        } else if (definition.id === "table") {
          insertTable(schema, view, 3, 3);
        } else if (definition.kind === "mark") {
          execMarkCmd(definition, schema, view);
        } else if (definition.kind === "block") {
          execBlockCmd(definition, schema, view);
        } else if (definition.kind === "list") {
          execListCmd(definition, schema, view);
        } else if (definition.kind === "list-depth") {
          execListDepthCmd(definition, view);
        } else if (definition.kind === "insert" && host) {
          execInsertCmd(definition, schema, view, host.app, sourcePath);
        } else if (definition.kind === "heading") {
          setHeading(schema, view, definition.headingLevel ?? 0);
        } else if (definition.kind === "history") {
          execHistoryCmd(definition, view);
        }
        window.setTimeout(() => view.focus(), 0);
      },
    };
  };
  for (const definition of BUTTON_REGISTRY.values()) {
    if (actions.has(definition.id)) continue;
    const action = toolbarAction(definition);
    if (action) actions.set(definition.id, action);
  }

  const addAction = (target: Menu, action: ActionSpec): void => {
    target.addItem((item) => {
      item
        .setTitle(tx(action.title))
        .setIcon(action.icon)
        .setDisabled(!action.enabled())
        .onClick(action.run);
      if (action.checked) item.setChecked(action.checked());
    });
  };

  const addFormattingSubmenu = (target: Menu): void => {
    target.addItem((item) => {
      item.setTitle(tx("Formatting")).setIcon("paintbrush");
      const submenu = item.setSubmenu();
      submenu.setUseNativeMenu(false);
      attachMenuSurfaceMotion(submenu, "submenu");
      for (const id of ["bold", "italic", "strikethrough", "highlight", "inline-code"] as const) {
        addAction(submenu, actions.get(id)!);
      }
      submenu.addSeparator();
      addAction(submenu, actions.get("add-link")!);
      addAction(submenu, actions.get("clear-formatting")!);
    });
  };

  const populateTextColorMenu = (target: Menu): void => {
    target.setUseNativeMenu(false);
    attachMenuSurfaceMotion(target, "submenu");
    target.addItem((subItem) => subItem
      .setTitle(txKnown("Default color"))
      .setIcon("eraser")
      .onClick(() => applyToolbarColor(schema, view, "text", null)));
    target.addSeparator();
    for (const choice of toolbarColorChoices("text")) {
      target.addItem((subItem) => subItem
        .setTitle(choice.name)
        .setIcon("circle")
        .onClick(() => applyToolbarColor(schema, view, "text", choice.value)));
    }
  };

  const addTextColorSubmenu = (target: Menu): void => {
    target.addItem((item) => {
      item.setTitle(txKnown("Text color")).setIcon("palette");
      populateTextColorMenu(item.setSubmenu());
    });
  };

  const populateBlockActionsMenu = (target: Menu): boolean => {
    const context = canonicalBlockMenuContext(view, host, blockOverride);
    if (!context) return false;
    target.setUseNativeMenu(false);
    attachMenuSurfaceMotion(target, "submenu");
    const specificItems = context.items.filter((item) => item.id !== "turn-into");
    const lifecycleItems = buildBlockLifecycleMenuItems(host?.serializeNode);
    const runItem = (
      item: BlockMenuItem | BlockSubItem,
      activation: MouseEvent | KeyboardEvent,
    ) => runCanonicalBlockItem(view, context.block, item, activation);
    if (specificItems.length > 0) {
      renderBlockMenuItems(target, specificItems, runItem);
    }
    if (specificItems.length > 0 && lifecycleItems.length > 0) {
      target.addSeparator();
    }
    if (lifecycleItems.length > 0) {
      renderBlockLifecycleMenuItems(target, lifecycleItems, runItem);
    }
    return specificItems.length > 0 || lifecycleItems.length > 0;
  };

  const addBlockActionsSubmenu = (target: Menu): boolean => {
    if (!canonicalBlockMenuContext(view, host, blockOverride)) return false;
    target.addItem((item) => {
      item.setTitle(txKnown("Block actions")).setIcon("square-menu");
      populateBlockActionsMenu(item.setSubmenu());
    });
    return true;
  };

  const openQuickSurface = (id: string, anchor: HTMLElement): boolean => {
    if (!["insert", "turn-into", "block-actions", "text-color"].includes(id)) return false;
    const surface = new Menu();
    let populated = true;
    if (id === "insert") populateInsertMenu(surface, schema, view, host);
    else if (id === "turn-into") populated = populateCanonicalTurnIntoMenu(surface, view, host, blockOverride);
    else if (id === "block-actions") populated = populateBlockActionsMenu(surface);
    else populateTextColorMenu(surface);
    if (!populated) return false;
    attachMenuSurfaceMotion(surface, "menu");
    const rect = anchor.getBoundingClientRect();
    surface.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    return true;
  };

  const addQuickActions = (
    target: Menu,
    configured: Extract<Layout[number], { type: "submenu" }>["children"],
  ): boolean => {
    const children = configured
      .filter((item) => item.type === "button" || item.type === "command")
      .slice(0, 5);
    if (children.length === 0) return false;
    target.addItem((item) => {
      item.setTitle(txKnown("Quick actions"));
      const row = item.dom;
      if (!row) return;
      row.empty();
      row.removeAttribute("title");
      row.removeAttribute("aria-label");
      row.removeAttribute("data-tooltip-position");
      row.classList.add("butter-context-quick-actions-item");
      const toolbar = row.createDiv({
        cls: "butter-context-quick-actions",
        attr: { role: "toolbar" },
      });
      const toolbarLabel = toolbar.createSpan({
        cls: "butter-visually-hidden",
        text: txKnown("Quick actions"),
      });
      toolbarLabel.id = `butter-context-quick-action-label-${++quickActionLabelId}`;
      toolbar.setAttribute("aria-labelledby", toolbarLabel.id);
      toolbar.style.setProperty(
        "--butter-context-quick-count",
        String(children.length),
      );
      const buttons: HTMLButtonElement[] = [];
      for (const child of children) {
        const action = child.type === "button"
          ? actions.get(child.id)
          : undefined;
        const definition = child.type === "button"
          ? BUTTON_REGISTRY.get(child.id)
          : undefined;
        const special = child.type === "button"
          && ["insert", "turn-into", "block-actions", "text-color"].includes(child.id);
        const label = child.type === "command"
          ? host ? commandActionLabel(host.app, child) : child.label
          : action ? tx(action.title) : definition ? tx(definition.label) : child.id;
        const button = toolbar.createEl("button", {
          cls: "butter-context-quick-action clickable-icon",
          attr: {
            type: "button",
            "aria-pressed": action?.checked?.() ? "true" : "false",
          },
        });
        if (child.type === "command" && host) {
          setIcon(button, commandActionIcon(host.app, child));
          button.disabled = !isObsidianCommandAvailable(host.app, child.commandId);
        } else if (action) {
          setIcon(button, action.icon);
          button.disabled = !action.enabled();
          button.classList.toggle("is-active", action.checked?.() === true);
        } else if (special && definition) {
          setIcon(button, definition.icon);
        } else {
          setIcon(button, "circle-help");
          button.disabled = true;
        }
        const accessibleLabel = button.createSpan({
          cls: "butter-visually-hidden",
          text: label,
        });
        accessibleLabel.id = `butter-context-quick-action-label-${++quickActionLabelId}`;
        button.setAttribute("aria-labelledby", accessibleLabel.id);
        button.tabIndex = -1;
        button.addEventListener("pointerdown", (event) => event.preventDefault());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!button.disabled) {
            if (child.type === "command" && host) {
              executeObsidianCommand(host.app, child.commandId);
            } else if (child.type === "button" && openQuickSurface(child.id, button)) {
              menu.close();
              return;
            } else action?.run();
          }
          menu.close();
        });
        buttons.push(button);
      }
      const enabledButtons = () => buttons.filter((button) => !button.disabled);
      const initial = enabledButtons()[0];
      if (initial) initial.tabIndex = 0;
      toolbar.addEventListener("keydown", (event: KeyboardEvent) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const available = enabledButtons();
        if (available.length === 0) return;
        const current = toolbar.ownerDocument.activeElement as HTMLButtonElement | null;
        let index = Math.max(0, available.indexOf(current ?? available[0]));
        if (event.key === "ArrowLeft") index = (index - 1 + available.length) % available.length;
        else if (event.key === "ArrowRight") index = (index + 1) % available.length;
        else if (event.key === "Home") index = 0;
        else index = available.length - 1;
        event.preventDefault();
        for (const button of buttons) button.tabIndex = -1;
        available[index].tabIndex = 0;
        available[index].focus();
      });
    });
    return true;
  };

  const layout = host?.getContextMenuLayout?.() ?? contextMenuDefaultLayout();
  const knownEntryIds = new Set([
    ...CONTEXT_MENU_ENTRY_DEFS.map((entry) => entry.id),
    ...MAIN_TOOLBAR_BUTTON_DEFS.map((entry) => entry.id),
  ]);
  const renderItems = (target: Menu, items: Layout): boolean => {
    let rendered = false;
    let pendingSeparator = false;
    for (const item of items) {
      if (item.type === "separator") {
        if (rendered) pendingSeparator = true;
        continue;
      }
      if (item.type === "overflow") continue;

      if (item.type === "button" && item.id === "plugin-actions") {
        const contributed = emitEditorMenuContributions(target, host, {
          separatorBefore: rendered && pendingSeparator,
        });
        if (contributed) {
          rendered = true;
          pendingSeparator = false;
        }
        continue;
      }

      if (item.type === "button" && item.id === "spelling-actions") {
        if (!spelling) continue;
        if (rendered && pendingSeparator) target.addSeparator();
        pendingSeparator = false;
        for (const suggestion of spelling.suggestions) {
          target.addItem((menuItem) => menuItem
            .setTitle(suggestion)
            .setIcon("spell-check-2")
            .onClick(() => spelling.replace(suggestion)));
        }
        if (spelling.suggestions.length > 0) target.addSeparator();
        target.addItem((menuItem) => menuItem
          .setTitle(txKnown("Add to dictionary"))
          .setIcon("book-plus")
          .onClick(spelling.addToDictionary));
        rendered = true;
        continue;
      }

      if (item.type === "button" && item.id === "obsidian-actions") {
        if (rendered && pendingSeparator) target.addSeparator();
        pendingSeparator = false;
        target.addItem((menuItem) => {
          menuItem.setTitle(txKnown("Obsidian actions")).setIcon("app-window");
          menuItem.dom?.classList.add("butter-context-obsidian-actions-marker");
        });
        rendered = true;
        continue;
      }

      if (rendered && pendingSeparator) target.addSeparator();
      pendingSeparator = false;

      if (item.type === "command") {
        target.addItem((menuItem) => menuItem
          .setTitle(host ? commandActionLabel(host.app, item) : item.label)
          .setIcon(host ? commandActionIcon(host.app, item) : item.icon)
          .setDisabled(!host || !isObsidianCommandAvailable(host.app, item.commandId))
          .onClick(() => {
            if (host) executeObsidianCommand(host.app, item.commandId);
          }));
        rendered = true;
        continue;
      }

      if (item.type === "submenu") {
        if (item.presentation === "quick") {
          rendered = addQuickActions(target, item.children) || rendered;
          continue;
        }
        target.addItem((menuItem) => {
          menuItem.setTitle(item.label || txKnown("Submenu")).setIcon(item.icon || "more-horizontal");
          const submenu = menuItem.setSubmenu();
          submenu.setUseNativeMenu(false);
          attachMenuSurfaceMotion(submenu, "submenu");
          renderItems(submenu, item.children);
        });
        rendered = true;
        continue;
      }

      if (item.type !== "button" || !knownEntryIds.has(item.id)) continue;
      const id = item.id;
      const action = actions.get(id);
      let added = true;
      if (action) addAction(target, action);
      else if (id === "formatting") addFormattingSubmenu(target);
      else if (id === "turn-into") added = addCanonicalTurnIntoSubmenu(target, view, host, blockOverride);
      else if (id === "insert") addInsertSubmenu(target, schema, view, host);
      else if (id === "text-color") addTextColorSubmenu(target);
      else if (id === "block-actions") added = addBlockActionsSubmenu(target);
      else added = false;
      rendered = added || rendered;
    }
    return rendered;
  };

  renderItems(menu, layout);
}

const OBSIDIAN_CONTEXT_SECTIONS = new Set(["action", "selection"]);

/**
 * Obsidian injects its own context-sensitive `action` and `selection`
 * sections while `showAtMouseEvent` opens the menu. Move those already-wired
 * DOM items to Butter's configurable marker, or remove them when that slot is
 * hidden. Event handlers remain attached because the item nodes are moved,
 * not cloned.
 */
function placeObsidianContextActions(menu: Menu): void {
  const root = menu.dom;
  if (!root) return;
  const marker = root.querySelector<HTMLElement>(
    ".butter-context-obsidian-actions-marker",
  );
  const nativeItems = Array.from(
    root.querySelectorAll<HTMLElement>(".menu-item[data-section]"),
  )
    .filter((item) => OBSIDIAN_CONTEXT_SECTIONS.has(item.dataset.section ?? ""));

  if (marker) {
    const targetGroup = marker.closest<HTMLElement>(".menu-group") ?? marker.parentElement;
    if (targetGroup) {
      for (const item of nativeItems) targetGroup.insertBefore(item, marker);
    }
    marker.remove();
  } else {
    for (const item of nativeItems) item.remove();
  }

  for (const group of Array.from(root.querySelectorAll<HTMLElement>(".menu-group"))) {
    if (!group.querySelector(".menu-item")) group.remove();
  }
}

function isOrdinaryContextMenuTarget(
  event: MouseEvent,
  blockOverride?: ContextBlock,
): boolean {
  if (blockOverride) return false;
  const target = event.target as { closest?: (selector: string) => Element | null } | null;
  return !target?.closest?.(
    "table, img, video, audio, a, .butter-drag-handle, " +
    ".butter-image-edit-button, .butter-inline-atom",
  );
}

function appendContextMenuCoachmark(
  menu: Menu,
  event: MouseEvent,
  host: GeneralContextMenuHost | undefined,
  blockOverride?: ContextBlock,
): void {
  if (!host || !isOrdinaryContextMenuTarget(event, blockOverride)) return;
  const surface = Platform.isMobile
    ? "mobile-context-menu"
    : "desktop-context-menu";
  const announcement = host.getPendingFeatureAnnouncement?.(surface);
  const root = menu.dom;
  if (!announcement || !root) return;
  const establishedWidth = root.getBoundingClientRect().width;
  if (establishedWidth > 0) {
    root.style.setProperty(
      "--butter-context-menu-established-width",
      `${establishedWidth}px`,
    );
  }
  root.addClass("has-feature-coachmark");

  const group = root.createDiv({
    cls: "menu-group butter-context-menu-coachmark-group",
  });
  const coachmark = group.createDiv({
    cls: "butter-context-menu-coachmark",
    attr: { role: "note", "aria-label": txKnown(announcement.title) },
  });
  const header = coachmark.createDiv({ cls: "butter-context-menu-coachmark-header" });
  const icon = header.createSpan({ cls: "butter-context-menu-coachmark-icon" });
  setIcon(icon, "party-popper");
  header.createSpan({
    cls: "butter-context-menu-coachmark-title",
    text: txKnown(announcement.title),
  });
  coachmark.createDiv({
    cls: "butter-context-menu-coachmark-description",
    text: txKnown(announcement.description),
  });
  const actions = coachmark.createDiv({
    cls: "butter-context-menu-coachmark-actions",
  });
  const customize = actions.createEl("button", {
    cls: "butter-context-menu-coachmark-action is-primary",
    text: txKnown("Customize"),
    attr: { type: "button" },
  });
  const dismiss = actions.createEl("button", {
    cls: "butter-context-menu-coachmark-action",
    text: txKnown("Got it"),
    attr: { type: "button" },
  });

  const acknowledge = () => {
    void host.acknowledgeFeatureAnnouncement?.(announcement.id);
  };
  const containPointer = (pointerEvent: Event) => pointerEvent.stopPropagation();
  customize.addEventListener("pointerdown", containPointer);
  dismiss.addEventListener("pointerdown", containPointer);
  customize.addEventListener("click", (clickEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    acknowledge();
    menu.hide();
    host.openContextMenuSettings?.();
  });
  dismiss.addEventListener("click", (clickEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    acknowledge();
    group.remove();
    root.removeClass("has-feature-coachmark");
  });
}

function clampContextMenuToViewport(menu: Menu): void {
  const root = menu.dom;
  const ownerWindow = root?.ownerDocument.defaultView;
  if (!root || !ownerWindow) return;
  const margin = 8;
  const rect = root.getBoundingClientRect();
  const left = Math.min(
    Math.max(rect.left, margin),
    Math.max(margin, ownerWindow.innerWidth - rect.width - margin),
  );
  const top = Math.min(
    Math.max(rect.top, margin),
    Math.max(margin, ownerWindow.innerHeight - rect.height - margin),
  );
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
}

/** Obsidian mounts submenus beside their root menu, so a submenu leaf may
 * close only its own surface. Observe the complete active Butter menu chain
 * and dismiss its root after the trusted leaf click has finished. */
function dismissGeneralMenuAfterLeafActivation(
  menu: Menu,
  ownerDocument: Document,
): void {
  const onClick = (event: MouseEvent) => {
    if (activeGeneralContextMenu !== menu) return;
    const target = event.target as Element | null;
    const item = target?.closest<HTMLElement>(".menu-item");
    if (!item || item.classList.contains("is-disabled") ||
        item.getAttribute("aria-disabled") === "true" ||
        item.classList.contains("has-submenu") || item.querySelector(".mod-submenu")) {
      return;
    }
    const surface = item.closest<HTMLElement>(".menu");
    const root = menu.dom;
    if (!surface || !root ||
        (surface !== root && surface.dataset.butterSurfaceMotion !== "submenu")) {
      return;
    }
    ownerDocument.defaultView?.setTimeout(() => {
      if (activeGeneralContextMenu === menu) dismissActiveGeneralContextMenu();
    }, 0);
  };
  ownerDocument.addEventListener("click", onClick, true);
  menu.onHide(() => ownerDocument.removeEventListener("click", onClick, true));
}

function showContextMenu(
  schema: Schema,
  view: EditorView,
  event: MouseEvent,
  host?: GeneralContextMenuHost,
  blockOverride?: ContextBlock,
  spelling?: SpellingMenuContext,
) {
  if (activeGeneralContextMenu) {
    dismissActiveGeneralContextMenu();
  }
  const menu = new Menu();
  activeGeneralContextMenu = menu;
  menu.onHide(() => {
    if (activeGeneralContextMenu === menu) activeGeneralContextMenu = null;
  });
  menu.dom?.classList.add("butter-general-context-menu");
  attachMenuSurfaceMotion(menu, "menu");
  populateGeneralContextMenu(menu, schema, view, host, blockOverride, spelling);
  dismissGeneralMenuAfterLeafActivation(menu, view.dom.ownerDocument);

  menu.showAtMouseEvent(event);
  placeObsidianContextActions(menu);
  appendContextMenuCoachmark(menu, event, host, blockOverride);
  clampContextMenuToViewport(menu);
  dismissMenuOnScroll(menu, view.dom.ownerDocument);
}

let activeGeneralContextMenu: Menu | null = null;

function dismissActiveGeneralContextMenu(): void {
  const active = activeGeneralContextMenu;
  if (!active) return;
  activeGeneralContextMenu = null;
  hideMenuSurfaceImmediately(active);
}
