/**
 * Editor UX: keymaps, input rules, and context menu.
 */
import { Menu, Platform } from "obsidian";
import { runClipboardCommand } from "../util/dom-utils";
import { keymap } from "prosemirror-keymap";
import {
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlock,
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
  splitListItem,
} from "prosemirror-schema-list";
import {
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  InputRule,
} from "prosemirror-inputrules";
import type { MarkType } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Fragment, type Schema } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { enterMovesDown } from "./table-editing";

// ── Task-list Enter command ──
//
// Enter behavior for task list items, per user expectation:
//   • Empty task item → lift out of the list entirely
//   • Non-empty task item → split and carry the task attr over as
//     unchecked, so consecutive Enters produce a new `[ ]` each time
//     without the user retyping.
//
// Chained BEFORE the generic splitListItem so our version wins when
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

  const liPos = $from.before(liDepth);
  const liEnd = liPos + liNode.nodeSize;
  const paraEnd = liPos + 1 + liNode.firstChild!.nodeSize - 1;

  // Empty task - convert the list_item directly to a paragraph in
  // place. (Flat schema: no parent list to escape from. The item IS
  // a top-level block; we just retype it.)
  if (liNode.firstChild && liNode.firstChild.textContent.length === 0) {
    if (!dispatch) return true;
    const tr = state.tr;
    const para = state.schema.nodes.paragraph.create();
    tr.replaceWith(liPos, liEnd, para);
    const newSel = TextSelection.near(tr.doc.resolve(liPos + 1));
    tr.setSelection(newSel);
    dispatch(tr.scrollIntoView());
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
  dispatch(tr.scrollIntoView());
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

  // Empty heading → convert to paragraph
  if (parent.content.size === 0) {
    if (dispatch) {
      const pos = $head.before();
      dispatch(state.tr.setNodeMarkup(pos, paragraphType).scrollIntoView());
    }
    return true;
  }

  // End of heading → new paragraph after
  if ($head.parentOffset === parent.content.size) {
    if (dispatch) {
      const after = $head.after();
      const tr = state.tr.insert(after, paragraphType.create());
      tr.setSelection(Selection.near(tr.doc.resolve(after + 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  // Middle of heading → split, convert trailing to paragraph
  if (dispatch) {
    let tr = state.tr.split($head.pos);
    const mappedPos = tr.mapping.map($head.pos);
    try {
      const newBlockPos = tr.doc.resolve(mappedPos).after();
      tr = tr.setNodeMarkup(newBlockPos, paragraphType);
    } catch { /* split without converting */ }
    dispatch(tr.scrollIntoView());
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
// PM's stock `liftEmptyBlock` will lift an empty paragraph out of
// its parent - useful at the doc top level for "press Enter on an
// empty line to escape a list" muscle memory, but unwanted inside
// an `obsidian_callout` where lifting would dump the paragraph
// below the callout (and effectively close it). We wrap it with a
// pre-check that returns false when the empty block's parent is a
// callout, falling through to `splitBlock` (which keeps the user
// inside the callout body).
const liftEmptyBlockGuarded: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let d = $from.depth - 1; d >= 0; d--) {
    if ($from.node(d).type.name === "obsidian_callout") return false;
  }
  return liftEmptyBlock(state, dispatch);
};

// ── Build keymaps ──

export function buildKeymap(schema: Schema) {
  const keys: Record<string, Command> = {};

  // Enter: heading exit → standard chain. `enterMovesDown` runs FIRST
  // because PM's `liftEmptyBlock` and `splitBlock` would otherwise
  // catch the empty-cell case before us - `liftEmptyBlock` lifts an
  // empty paragraph out of its parent, which produces a malformed
  // doc when the parent is a table cell, and PM auto-corrects by
  // doing weird things (often appearing as "a new row got inserted"
  // to the user). `enterMovesDown` is a no-op outside of cells, so
  // it's safe to put first.
  keys["Enter"] = chainCommands(
    enterMovesDown,
    handleEnterInHeading,
    handleEnterToCreateCodeFence,
    newlineInCode,
    createParagraphNear,
    liftEmptyBlockGuarded,
    splitBlock,
  );

  keys["Mod-Enter"] = exitCode;

  // Backspace/Delete
  keys["Backspace"] = chainCommands(
    handleBackspaceInEmptyCalloutBody,
    deleteSelection,
    joinBackward,
    selectNodeBackward,
  );
  keys["Mod-Backspace"] = chainCommands(
    handleBackspaceInEmptyCalloutBody,
    deleteSelection,
    joinBackward,
    selectNodeBackward,
  );
  keys["Delete"] = chainCommands(deleteSelection, joinForward, selectNodeForward);
  keys["Mod-Delete"] = chainCommands(deleteSelection, joinForward, selectNodeForward);
  keys["Mod-a"] = selectAll;

  // NOTE: formatting shortcuts (Mod+B, Mod+I, Mod+E, Mod+Shift+S,
  // Mod+Shift+H) are registered as Obsidian commands in main.ts with
  // `checkCallback` gated on Butter being the active view. That routes
  // through Obsidian's dispatcher so our commands win over Obsidian's
  // default `editor:toggle-bold` / etc., which would otherwise fire
  // against our editor shim in unwanted ways. We deliberately DO NOT
  // bind these keys here to avoid double-firing when the Obsidian
  // command dispatches and also the event bubbles to PM's keymap.

  // List keybindings - task-aware Enter is chained before the generic
  // splitListItem so empty tasks exit the list and non-empty tasks
  // produce a new unchecked task item without user retyping the marker.
  if (schema.nodes.list_item) {
    keys["Enter"] = chainCommands(
      enterMovesDown,
      handleEnterInHeading,
      handleEnterToCreateCodeFence,
      handleEnterInTaskList,
      splitListItem(schema.nodes.list_item),
      newlineInCode,
      createParagraphNear,
      liftEmptyBlockGuarded,
      splitBlock,
    );
    // Tab / Shift-Tab are handled by listOperationsPlugin's
    // changeListItemDepth - flat-list schema needs depth-attr
    // mutation, not pm-schema-list's container-aware sinkListItem /
    // liftListItem (which assume bullet_list/ordered_list wrappers
    // that no longer exist).
  }

  // Shift+Enter inserts a soft line break inside the current block.
  // Matches Obsidian Live Preview behavior: Enter = new block,
  // Shift+Enter = new line within the same paragraph. Uses the
  // softbreak schema node (not hard_break), so source round-trips
  // as a plain `\n` rather than a `\` + newline.
  if (schema.nodes.softbreak) {
    keys["Shift-Enter"] = (state, dispatch) => {
      const { $from } = state.selection;
      // Only inside textblock contexts where inline softbreak is
      // a valid child. Paragraphs, headings (for multi-line
      // headings - rare but allowed), and similar.
      if (!$from.parent.type.inlineContent) return false;
      if (dispatch) {
        const tr = state.tr.replaceSelectionWith(
          schema.nodes.softbreak.create(),
          false,
        );
        dispatch(tr.scrollIntoView());
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

export function buildInputRules(schema: Schema) {
  const rules: InputRule[] = [];

  // Heading input rules: # → h1, ## → h2, etc.
  for (let level = 1; level <= 6; level++) {
    const pattern = new RegExp(`^(#{${level}})\\s$`);
    rules.push(textblockTypeInputRule(pattern, schema.nodes.heading, { level }));
  }

  // Blockquote: > at start of line
  rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));

  // ── Flat-list input rules ──
  //
  // PMX 0.18.37+ flat schema: typing `- `, `* `, `1. ` at the start of
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
  rules.push(new InputRule(/^\s*[-*]\s$/, makeListItemConversion("bullet")));

  // Ordered list: `N. ` at start of paragraph. The matched number
  // becomes the item's `start` attr (null when N === 1, since 1 is
  // the implicit default and storing null avoids serializer noise).
  rules.push(
    new InputRule(/^(\d+)\.\s$/, makeListItemConversion("ordered", (m) => ({
      start: +m[1] === 1 ? null : +m[1],
    }))),
  );

  // Task list: `- [ ] ` or `- [x] ` typed all at once on a bare
  // paragraph converts straight to a task list_item.
  //
  // For the typing flow `- ` (becomes bullet item) → `[ ] ` (user
  // wants it to become a task), see the second rule below - it
  // matches `[ ] ` at the start of an EXISTING bullet list_item's
  // paragraph and flips the kind in place via setNodeMarkup.
  rules.push(
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
  rules.push(
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
  rules.push(textblockTypeInputRule(/^```([\w.+#-]*)\s$/, schema.nodes.code_block, (match) => ({
    language: match[1] || "",
  })));

  // Horizontal rule: --- at start of line.
  //
  // The first replaceWith shrinks the doc (3 chars "---" → 1-node hr),
  // so the original `end` position is past the new doc end. Map it
  // through tr.mapping before using it for the trailing-paragraph
  // insert; otherwise PM throws `Position N out of range` and the
  // input event tears down the editor.
  rules.push(new InputRule(/^---$/, (state, match, start, end) => {
    const tr = state.tr.replaceWith(
      start - 1,
      end,
      schema.nodes.horizontal_rule.create(),
    );
    return tr.insert(tr.mapping.map(end), schema.nodes.paragraph.create());
  }));

  // Tag: #tagname followed by space - converts text to tag node + space
  if (schema.nodes.obsidian_tag) {
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
  if (schema.nodes.list_item) {
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
  if (schema.nodes.wikilink) {
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

  const wrapMark = (
    pattern: RegExp,
    mark: MarkType | undefined,
  ): InputRule | null => {
    if (!mark) return null;
    return new InputRule(pattern, (state, match, start, end) => {
      const content = match[1];
      if (!content) return null;
      const tr = state.tr;
      tr.replaceWith(start, end, state.schema.text(content, [mark.create()]));
      tr.removeStoredMark(mark);
      return tr;
    });
  };

  const add = (r: InputRule | null) => {
    if (r) rules.push(r);
  };

  // Bold - `**text**` and `__text__`
  add(wrapMark(/(?:^|\s)\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, schema.marks.strong));
  add(wrapMark(/(?:^|\s)__([^_\s](?:[^_]*[^_\s])?)__$/, schema.marks.strong));

  // Italic - `*text*` and `_text_` (but not inside **...**)
  add(wrapMark(/(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, schema.marks.em));
  add(wrapMark(/(?:^|[^_])_([^_\s](?:[^_]*[^_\s])?)_$/, schema.marks.em));

  // Strikethrough - `~~text~~`
  add(wrapMark(/~~([^~\s](?:[^~]*[^~\s])?)~~$/, schema.marks.strikethrough));

  // Inline code - `` `text` ``
  add(wrapMark(/`([^`\s](?:[^`]*[^`\s])?)`$/, schema.marks.code));

  // Highlight - `==text==`
  add(wrapMark(/==([^=\s](?:[^=]*[^=\s])?)==$/, schema.marks.highlight));

  // Link - `[text](url)`
  if (schema.marks.link) {
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

export function contextMenuPlugin(schema: Schema) {
  return new Plugin({
    key: new PluginKey("butter-context-menu"),
    props: {
      handleDOMEvents: {
        contextmenu: (view: EditorView, event: MouseEvent) => {
          // On mobile, the touch long-press that begins a text
          // selection fires `contextmenu` - opening our formatting
          // menu mid-selection. Skip and let the platform handle the
          // selection gesture natively.
          if (Platform.isMobile) return false;
          event.preventDefault();
          showContextMenu(schema, view, event);
          return true;
        },
      },
    },
  });
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

function showContextMenu(schema: Schema, view: EditorView, event: MouseEvent) {
  const menu = new Menu();
  const hasSelection = !view.state.selection.empty;

  if (hasSelection) {
    if (schema.marks.strong) {
      menu.addItem((item) =>
        item.setTitle("Bold").setIcon("bold")
          .onClick(() => toggleMark(schema.marks.strong)(view.state, view.dispatch)),
      );
    }
    if (schema.marks.em) {
      menu.addItem((item) =>
        item.setTitle("Italic").setIcon("italic")
          .onClick(() => toggleMark(schema.marks.em)(view.state, view.dispatch)),
      );
    }
    if (schema.marks.strikethrough) {
      menu.addItem((item) =>
        item.setTitle("Strikethrough").setIcon("strikethrough")
          .onClick(() => toggleMark(schema.marks.strikethrough)(view.state, view.dispatch)),
      );
    }
    if (schema.marks.code) {
      menu.addItem((item) =>
        item.setTitle("Inline code").setIcon("code-2")
          .onClick(() => toggleMark(schema.marks.code)(view.state, view.dispatch)),
      );
    }
    menu.addSeparator();
  }

  menu.addItem((item) =>
    item.setTitle("Blockquote").setIcon("quote")
      .onClick(() => wrapIn(schema.nodes.blockquote)(view.state, view.dispatch)),
  );
  menu.addItem((item) =>
    item.setTitle("Horizontal rule").setIcon("minus")
      .onClick(() => {
        const tr = view.state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create());
        view.dispatch(tr);
      }),
  );

  menu.addSeparator();
  menu.addItem((item) =>
    item.setTitle("Cut").setIcon("scissors")
      .onClick(() => runClipboardCommand(activeDocument, "cut")),
  );
  menu.addItem((item) =>
    item.setTitle("Copy").setIcon("copy")
      .onClick(() => runClipboardCommand(activeDocument, "copy")),
  );
  menu.addItem((item) =>
    item.setTitle("Paste").setIcon("clipboard-check")
      .onClick(() => {
        void navigator.clipboard.readText().then((text) => {
          view.dispatch(view.state.tr.insertText(text));
        });
      }),
  );

  menu.showAtMouseEvent(event);
}
