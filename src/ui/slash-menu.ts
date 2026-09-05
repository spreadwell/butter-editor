/**
 * Slash command menu for Butter PM. Type "/" at the start of an empty
 * block (or after whitespace) to open a block-inserter picker.
 *
 * Replaces the "/" + query with the chosen block via PM transactions.
 * Closes on selection change away from the query, Escape, or pick.
 */
import { App, setIcon } from "obsidian";
import { Plugin as PMPlugin, PluginKey, Selection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { setBlockType, wrapIn } from "prosemirror-commands";
import type { Schema } from "prosemirror-model";

import { bindFloatingSurfaceReposition } from "../util/floating-surface";
import { tx, type MessageKey } from "../i18n";

// ═══════════════════════════════════════════
//  Items
// ═══════════════════════════════════════════

export interface SlashItem {
  id: string;
  label: MessageKey;
  desc: MessageKey;
  icon: string;
  keywords: string[];
  run: (view: EditorView, schema: Schema, app: App) => void;
}

export type SlashCategory =
  | "Headings"
  | "Lists"
  | "Structural"
  | "Code & data"
  | "Callouts";

const SLASH_CATEGORY_ORDER: SlashCategory[] = [
  "Headings",
  "Lists",
  "Structural",
  "Code & data",
  "Callouts",
];

export function slashCategory(item: SlashItem): SlashCategory {
  if (/^h[1-6]$/.test(item.id) || item.id === "paragraph") return "Headings";
  if (["bullet", "ordered", "task"].includes(item.id)) return "Lists";
  if (["quote", "hr", "table"].includes(item.id)) return "Structural";
  if (item.id.startsWith("callout-")) return "Callouts";
  return "Code & data";
}

function normalized(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function subsequenceMatch(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return false;
}

/** Intent-aware match score. Exact and word-prefix matches stay ahead of
 * broad substrings, while conservative subsequence matching catches useful
 * shorthand without flooding the menu with unrelated commands. */
export function scoreSlashItem(
  item: SlashItem,
  query: string,
  localizedLabel: string = item.label,
): number {
  const q = normalized(query);
  if (!q) return 0;
  const terms = q.split(/\s+/).filter(Boolean);
  const label = normalized(localizedLabel);
  const labelWords = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const keywords = item.keywords.map(normalized);
  const fields = [normalized(item.id), label, ...keywords];
  let score = 0;

  for (const term of terms) {
    let termScore = -1;
    if (label === term) termScore = 140;
    else if (label.startsWith(term)) termScore = 120;
    else if (labelWords.some((word) => word.startsWith(term))) termScore = 108;
    if (keywords.some((word) => word === term)) termScore = Math.max(termScore, 125);
    if (keywords.some((word) => word.startsWith(term))) termScore = Math.max(termScore, 105);
    if (fields.some((field) => field.includes(term))) termScore = Math.max(termScore, 72);
    if (
      term.length >= 3 &&
      fields.some((field) => subsequenceMatch(term, field))
    ) {
      termScore = Math.max(termScore, 38);
    }
    if (termScore < 0) return -1;
    score += termScore;
  }
  if (label.includes(q)) score += 24;
  return score;
}

export function filterSlashItems(query: string): SlashItem[] {
  const sourceOrder = new Map(SLASH_ITEMS.map((item, index) => [item.id, index]));
  const scored = SLASH_ITEMS.map((item) => ({
    item,
    score: scoreSlashItem(item, query, tx(item.label)),
  })).filter(({ score }) => score >= 0);

  const items: SlashItem[] = [];
  for (const category of SLASH_CATEGORY_ORDER) {
    items.push(...scored
      .filter(({ item }) => slashCategory(item) === category)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (sourceOrder.get(a.item.id) ?? 0) - (sourceOrder.get(b.item.id) ?? 0),
      )
      .map(({ item }) => item));
  }
  return items;
}

export const SLASH_ITEMS: SlashItem[] = [
  // ── Headings ────────────────────────────────────────────────
  {
    id: "h1",
    label: "Heading 1",
    desc: "Large section heading",
    icon: "heading-1",
    keywords: ["h1", "title", "header", "section"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 1 })(v.state, v.dispatch),
  },
  {
    id: "h2",
    label: "Heading 2",
    desc: "Medium heading",
    icon: "heading-2",
    keywords: ["h2", "header", "section"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 2 })(v.state, v.dispatch),
  },
  {
    id: "h3",
    label: "Heading 3",
    desc: "Smaller heading",
    icon: "heading-3",
    keywords: ["h3", "header", "section"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 3 })(v.state, v.dispatch),
  },
  {
    id: "h4",
    label: "Heading 4",
    desc: "Small heading",
    icon: "heading-4",
    keywords: ["h4", "header", "section"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 4 })(v.state, v.dispatch),
  },
  {
    id: "h5",
    label: "Heading 5",
    desc: "Subsection",
    icon: "heading-5",
    keywords: ["h5", "header", "section"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 5 })(v.state, v.dispatch),
  },
  {
    id: "h6",
    label: "Heading 6",
    desc: "Smallest heading",
    icon: "heading-6",
    keywords: ["h6", "header", "section"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 6 })(v.state, v.dispatch),
  },
  {
    id: "paragraph",
    label: "Paragraph",
    desc: "Plain text block",
    icon: "pilcrow",
    keywords: ["para", "text", "plain", "body"],
    run: (v, s) => setBlockType(s.nodes.paragraph)(v.state, v.dispatch),
  },

  // ── Lists ───────────────────────────────────────────────────
  // In Butter's flat-list schema, each entry inserts one
  // list_item with the appropriate `kind`. Visual list emergence
  // happens automatically when subsequent items are typed below.
  {
    id: "bullet",
    label: "Bullet list",
    desc: "Unordered list",
    icon: "list",
    keywords: ["ul", "list", "bullet", "unordered", "dots"],
    run: (v, s) => insertFlatListItem(v, s, "bullet"),
  },
  {
    id: "ordered",
    label: "Numbered list",
    desc: "Ordered list",
    icon: "list-ordered",
    keywords: ["ol", "numbered", "ordered", "numbers"],
    run: (v, s) => insertFlatListItem(v, s, "ordered"),
  },
  {
    id: "task",
    label: "Task list",
    desc: "Checkable to-do items",
    icon: "list-checks",
    keywords: ["task", "todo", "checkbox", "check", "checklist"],
    run: (v, s) => insertFlatListItem(v, s, "task"),
  },

  // ── Structural ──────────────────────────────────────────────
  {
    id: "quote",
    label: "Blockquote",
    desc: "Indented quotation",
    icon: "quote",
    keywords: ["quote", "blockquote", "citation"],
    run: (v, s) => wrapIn(s.nodes.blockquote)(v.state, v.dispatch),
  },
  {
    id: "hr",
    label: "Divider",
    desc: "Horizontal rule",
    icon: "minus",
    keywords: ["hr", "rule", "divider", "separator", "line", "horizontal", "break"],
    run: (v, s) => {
      const tr = v.state.tr.replaceSelectionWith(
        s.nodes.horizontal_rule.create(),
      );
      v.dispatch(tr);
    },
  },
  {
    id: "table",
    label: "Table",
    desc: "3 × 3 table",
    icon: "table",
    keywords: ["table", "grid", "rows", "columns"],
    run: (v, s) => insertTable(v, s, 3, 3),
  },

  // ── Code + math ─────────────────────────────────────────────
  {
    id: "code",
    label: "Code block",
    desc: "Fenced code",
    icon: "file-code",
    keywords: ["code", "fence", "pre", "snippet"],
    run: (v, s) => setBlockType(s.nodes.code_block)(v.state, v.dispatch),
  },
  {
    id: "math",
    label: "Math block",
    desc: "$$…$$ LaTeX equation",
    icon: "sigma",
    keywords: ["math", "latex", "equation", "tex", "formula"],
    run: (v, s) => {
      const tr = v.state.tr.replaceSelectionWith(
        s.nodes.math_block.create({ value: "" }),
      );
      v.dispatch(tr.scrollIntoView());
      v.focus();
    },
  },
  {
    id: "mermaid",
    label: "Mermaid diagram",
    desc: "```mermaid fence",
    icon: "git-branch",
    keywords: ["mermaid", "diagram", "flowchart", "sequence", "chart"],
    run: (v, s) => insertCodeBlock(v, s, "mermaid"),
  },
  {
    id: "dataview",
    label: "Dataview query",
    desc: "```dataview fence",
    icon: "database",
    keywords: ["dataview", "query", "dql"],
    run: (v, s) => insertCodeBlock(v, s, "dataview"),
  },
  {
    id: "dataviewjs",
    label: "Dataview JS",
    desc: "```dataviewjs fence",
    icon: "terminal",
    keywords: ["dataviewjs", "js", "javascript", "query"],
    run: (v, s) => insertCodeBlock(v, s, "dataviewjs"),
  },
  {
    id: "base",
    label: "Base",
    desc: "```base data-table",
    icon: "table-properties",
    keywords: ["base", "data", "table", "database"],
    run: (v, s) => insertCodeBlock(v, s, "base"),
  },

  // ── Callouts ────────────────────────────────────────────────
  {
    id: "callout-note",
    label: "Note callout",
    desc: "> [!note]",
    icon: "pencil",
    keywords: ["callout", "admonition", "note"],
    run: (v, s) => insertCallout(v, s, "note"),
  },
  {
    id: "callout-info",
    label: "Info callout",
    desc: "> [!info]",
    icon: "info",
    keywords: ["callout", "info", "abstract"],
    run: (v, s) => insertCallout(v, s, "info"),
  },
  {
    id: "callout-tip",
    label: "Tip callout",
    desc: "> [!tip]",
    icon: "lightbulb",
    keywords: ["tip", "callout", "hint"],
    run: (v, s) => insertCallout(v, s, "tip"),
  },
  {
    id: "callout-success",
    label: "Success callout",
    desc: "> [!success]",
    icon: "check",
    keywords: ["success", "callout", "done", "check"],
    run: (v, s) => insertCallout(v, s, "success"),
  },
  {
    id: "callout-question",
    label: "Question callout",
    desc: "> [!question]",
    icon: "help-circle",
    keywords: ["question", "callout", "help", "faq"],
    run: (v, s) => insertCallout(v, s, "question"),
  },
  {
    id: "callout-warn",
    label: "Warning callout",
    desc: "> [!warning]",
    icon: "alert-triangle",
    keywords: ["warning", "callout", "caution"],
    run: (v, s) => insertCallout(v, s, "warning"),
  },
  {
    id: "callout-failure",
    label: "Failure callout",
    desc: "> [!failure]",
    icon: "x-circle",
    keywords: ["failure", "callout", "fail", "error"],
    run: (v, s) => insertCallout(v, s, "failure"),
  },
  {
    id: "callout-danger",
    label: "Danger callout",
    desc: "> [!danger]",
    icon: "alert-octagon",
    keywords: ["danger", "callout", "error"],
    run: (v, s) => insertCallout(v, s, "danger"),
  },
  {
    id: "callout-bug",
    label: "Bug callout",
    desc: "> [!bug]",
    icon: "bug",
    keywords: ["bug", "callout"],
    run: (v, s) => insertCallout(v, s, "bug"),
  },
  {
    id: "callout-example",
    label: "Example callout",
    desc: "> [!example]",
    icon: "list",
    keywords: ["example", "callout"],
    run: (v, s) => insertCallout(v, s, "example"),
  },
  {
    id: "callout-quote",
    label: "Quote callout",
    desc: "> [!quote]",
    icon: "quote",
    keywords: ["quote", "callout", "cite"],
    run: (v, s) => insertCallout(v, s, "quote"),
  },
];

function insertTable(
  view: EditorView,
  schema: Schema,
  rows: number,
  cols: number,
) {
  const { table, table_row, table_header, table_cell } = schema.nodes;
  if (!table || !table_row) return;

  // Cells use `inline*` content (configured in schema.ts:tableNodes).
  // Passing a `paragraph` (block) made `createAndFill` reject and return
  // null, which the `!` masked - crash deferred to `Fragment.fromArray`.
  // Empty content auto-fills correctly for `inline*`.
  const makeCell = (Cell: typeof table_cell) => Cell.createAndFill()!;
  const headerCells = Array.from({ length: cols }, () =>
    makeCell(table_header),
  );
  const headerRow = table_row.create(null, headerCells);

  const bodyRows = Array.from({ length: rows - 1 }, () => {
    const cells = Array.from({ length: cols }, () => makeCell(table_cell));
    return table_row.create(null, cells);
  });

  const node = table.create(null, [headerRow, ...bodyRows]);
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
  view.focus();
}

/** Insert a single flat list_item with the given `kind`. The toolbar
 *  and slash menu both call this. */
export function insertFlatListItem(
  view: EditorView,
  schema: Schema,
  kind: "bullet" | "ordered" | "task",
) {
  const { list_item, paragraph } = schema.nodes;
  if (!list_item || !paragraph) return;
  const para = paragraph.create();
  const item = list_item.create(
    {
      kind,
      depth: 0,
      tight: true,
      checked: kind === "task" ? false : null,
      start: null,
    },
    para,
  );
  const tr = view.state.tr.replaceSelectionWith(item).scrollIntoView();
  // Place caret inside the new item's paragraph (item-open + para-open
  // = +2 from the item's pre-position).
  const from = view.state.selection.from;
  const targetPos = Math.min(from + 2, tr.doc.content.size);
  tr.setSelection(
    Selection.near(
      tr.doc.resolve(targetPos),
    ),
  );
  view.dispatch(tr);
  view.focus();
}

/** @deprecated - use `insertFlatListItem(view, schema, "task")`.
 *  Kept as a thin shim so existing callers (toolbar) keep working
 *  during the flat-list migration. */
export function insertTaskList(view: EditorView, schema: Schema) {
  insertFlatListItem(view, schema, "task");
}

/** Insert a fenced code block with a specific language attribute.
 *  Used by mermaid / dataview / dataviewjs / base slash items so
 *  they render through Obsidian's code-block processors (not as
 *  literal ```lang text). */
function insertCodeBlock(
  view: EditorView,
  schema: Schema,
  language: string,
) {
  const node = schema.nodes.code_block.create({ language });
  const tr = view.state.tr.replaceSelectionWith(node).scrollIntoView();
  // Place caret inside the code block (for editable langs) or
  // just inside the structure (for widgets - doesn't visually
  // matter; the NodeView swaps to view mode anyway).
  const from = view.state.selection.from;
  const targetPos = Math.min(from + 1, tr.doc.content.size);
  tr.setSelection(
    Selection.near(
      tr.doc.resolve(targetPos),
    ),
  );
  view.dispatch(tr);
  view.focus();
}

/** Insert a callout of the given type with an empty body paragraph
 *  and place the caret inside it. Exported for the formatting
 *  toolbar's callout buttons. */
export function insertCallout(
  view: EditorView,
  schema: Schema,
  type: string,
) {
  const callout = schema.nodes.obsidian_callout;
  if (!callout) return;
  const para = schema.nodes.paragraph.create();
  const node = callout.create({ calloutType: type }, para);
  const tr = view.state.tr.replaceSelectionWith(node).scrollIntoView();
  // Place caret inside the callout's first paragraph.
  const from = view.state.selection.from;
  const targetPos = Math.min(from + 2, tr.doc.content.size);
  tr.setSelection(
    Selection.near(
      tr.doc.resolve(targetPos),
    ),
  );
  view.dispatch(tr);
  view.focus();
}

// ═══════════════════════════════════════════
//  Menu + plugin
// ═══════════════════════════════════════════

export function resolveSlashPlacement(
  current: "above" | "below" | null,
  anchorTop: number,
  anchorBottom: number,
  menuHeight: number,
  viewportHeight: number,
  margin = 12,
): "above" | "below" {
  if (current) return current;
  const spaceBelow = viewportHeight - margin - anchorBottom;
  const spaceAbove = anchorTop - margin;
  return spaceBelow >= menuHeight || spaceBelow >= spaceAbove
    ? "below"
    : "above";
}

class SlashMenuPopover {
  dom: HTMLElement;
  private items: SlashItem[] = [];
  private selected = 0;
  private itemEls: HTMLElement[] = [];
  private unbindReposition: (() => void) | null = null;
  private placement: "above" | "below" | null = null;

  constructor(
    private view: EditorView,
    private schema: Schema,
    private app: App,
    private triggerPos: number,
    private onDismiss: () => void,
  ) {
    this.dom = activeWindow.createDiv();
    this.dom.className =
      "butter-surface butter-surface--command butter-slash-menu";
    // ARIA listbox pattern. Editor focus stays in the document so
    // typing keeps flowing through to the slash query; the menu
    // tracks its highlighted item via aria-activedescendant on the
    // listbox container, which screen readers announce as the
    // "virtual focus" without our needing to actually move DOM focus.
    this.dom.setAttribute("role", "listbox");
    this.dom.setAttribute("aria-label", tx("Slash menu"));
    this.dom.id = `butter-slash-${Math.random().toString(36).slice(2, 9)}`;
    this.dom.addEventListener("butter-dismiss", () => this.onDismiss());
    activeDocument.body.appendChild(this.dom);
    this.filter("");
    this.unbindReposition = bindFloatingSurfaceReposition(() => {
      this.position();
    });
  }

  private position() {
    const coords = this.view.coordsAtPos(this.triggerPos);
    if (!coords) return;
    const gap = 4;
    const margin = 12;
    this.dom.addClass("butter-pos-fixed-popover");
    const rect = this.dom.getBoundingClientRect();
    if (!this.placement) {
      this.placement = resolveSlashPlacement(
        this.placement,
        coords.top,
        coords.bottom,
        rect.height,
        window.innerHeight,
        margin,
      );
      this.dom.dataset.placement = this.placement;
    }
    const requestedTop = this.placement === "above"
      ? coords.top - rect.height - gap
      : coords.bottom + gap;
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    this.dom.setCssProps({
      "--butter-pos-left": `${Math.max(margin, Math.min(coords.left, maxLeft))}px`,
      "--butter-pos-top": `${Math.max(margin, Math.min(requestedTop, maxTop))}px`,
    });
  }

  filter(query: string) {
    this.items = filterSlashItems(query);
    this.selected = 0;
    this.render();
    this.position();
  }

  private render() {
    this.dom.empty();
    this.itemEls = [];
    if (!this.items.length) {
      const empty = this.dom.createDiv({
        cls: "butter-surface-empty butter-slash-empty",
      });
      empty.textContent = tx("No matches");
      return;
    }
    let previousCategory: SlashCategory | null = null;
    for (const [i, item] of this.items.entries()) {
      const category = slashCategory(item);
      if (category !== previousCategory) {
        const heading = this.dom.createDiv({
          cls: "butter-slash-category",
          text: tx(category),
        });
        heading.setAttribute("role", "presentation");
        previousCategory = category;
      }
      const el = this.dom.createDiv({
        cls: "butter-surface-row butter-surface-row--command butter-slash-item",
      });
      el.setAttribute("role", "option");
      el.id = `${this.dom.id}-opt-${i}`;
      if (i === this.selected) {
        el.addClass("is-selected");
        el.setAttribute("aria-selected", "true");
      } else {
        el.setAttribute("aria-selected", "false");
      }
      const iconEl = el.createDiv({
        cls: "butter-surface-icon butter-slash-icon",
      });
      setIcon(iconEl, item.icon);
      const meta = el.createDiv({
        cls: "butter-surface-meta butter-slash-meta",
      });
      meta.createDiv({
        cls: "butter-surface-label butter-slash-label",
        text: tx(item.label),
      });
      meta.createDiv({
        cls: "butter-surface-detail butter-slash-desc",
        text: tx(item.desc),
      });
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.choose(i);
      });
      el.addEventListener("mouseenter", () => {
        this.selected = i;
        this.sync();
      });
      this.itemEls.push(el);
    }
    this.syncActiveDescendant();
  }

  private sync() {
    for (const [i, el] of this.itemEls.entries()) {
      const active = i === this.selected;
      el.toggleClass("is-selected", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
    }
    this.syncActiveDescendant();
  }

  private syncActiveDescendant() {
    const el = this.itemEls[this.selected];
    if (el?.id) {
      this.dom.setAttribute("aria-activedescendant", el.id);
    } else {
      this.dom.removeAttribute("aria-activedescendant");
    }
  }

  move(delta: number) {
    if (!this.items.length) return;
    this.selected =
      (this.selected + delta + this.items.length) % this.items.length;
    this.sync();
    this.itemEls[this.selected]?.scrollIntoView({ block: "nearest" });
  }

  choose(idx = this.selected) {
    const item = this.items[idx];
    if (!item) return;
    const { view } = this;
    const head = view.state.selection.head;
    view.dispatch(view.state.tr.delete(this.triggerPos, head));
    try {
      item.run(view, this.schema, this.app);
    } catch (e) {
      console.error("[butter-editor] slash command failed:", e);
    }
    this.onDismiss();
  }

  destroy() {
    this.unbindReposition?.();
    this.unbindReposition = null;
    this.dom.remove();
  }
}

// ═══════════════════════════════════════════
//  Plugin
// ═══════════════════════════════════════════

export function slashMenuPlugin(app: App, schema: Schema) {
  interface SlashPluginState {
    active: { triggerPos: number; head: number; query: string } | null;
    dismissedTriggerPos: number | null;
  }
  const key = new PluginKey<SlashPluginState>("butter-slash-menu");
  const dismissMeta = "dismiss";

  const findActiveQuery = (state: Parameters<typeof key.getState>[0]) => {
    const { selection } = state;
    if (!selection.empty || !selection.$head.parent.isTextblock) return null;
    const { head, $head } = selection;
    const text = $head.parent.textBetween(0, $head.parentOffset, "", "");
    const match = /(?:^|\s)\/([^\n/]*)$/.exec(text);
    if (!match || match[1].length > 64) return null;
    const slashOffset = match.index + match[0].indexOf("/");
    return {
      triggerPos: head - text.length + slashOffset,
      head,
      query: match[1],
    };
  };

  return new PMPlugin({
    key,
    state: {
      init: (): SlashPluginState => ({ active: null, dismissedTriggerPos: null }),
      apply(tr, previous, _oldState, newState): SlashPluginState {
        const found = findActiveQuery(newState);
        if (!found) return { active: null, dismissedTriggerPos: null };
        if (tr.getMeta(key) === dismissMeta) {
          return { active: null, dismissedTriggerPos: found.triggerPos };
        }
        if (previous.dismissedTriggerPos === found.triggerPos) {
          return { active: null, dismissedTriggerPos: found.triggerPos };
        }
        return { active: found, dismissedTriggerPos: null };
      },
    },
    view(view) {
      let menu: SlashMenuPopover | null = null;
      let triggerPos = -1;

      const close = (dismiss = false) => {
        menu?.destroy();
        menu = null;
        triggerPos = -1;
        if (dismiss) view.dispatch(view.state.tr.setMeta(key, dismissMeta));
      };

      return {
        update: (v) => {
          const pluginState = key.getState(v.state);
          const active = v.editable ? pluginState?.active : null;
          if (!active) {
            if (menu) close();
            return;
          }
          if (!menu || triggerPos !== active.triggerPos) {
            if (menu) close();
            triggerPos = active.triggerPos;
            menu = new SlashMenuPopover(
              v,
              schema,
              app,
              triggerPos,
              () => close(true),
            );
          }
          menu.filter(active.query);
        },
        destroy: close,
      };
    },
    props: {
      decorations(state) {
        const active = key.getState(state)?.active;
        if (!active) return null;
        const decorations = [
          Decoration.inline(active.triggerPos, active.triggerPos + 1, {
            class: "butter-slash-trigger",
          }),
        ];
        if (active.head > active.triggerPos + 1) {
          decorations.push(
            Decoration.inline(active.triggerPos + 1, active.head, {
              class: "butter-slash-query",
            }),
          );
        }
        return DecorationSet.create(state.doc, decorations);
      },
      handleKeyDown(_view, event) {
        const pop = activeDocument.querySelector(
          ".butter-slash-menu",
        );
        if (!pop) return false;

        const items = pop.querySelectorAll(".butter-slash-item");
        const current = Array.from(items).findIndex((el) =>
          el.classList.contains("is-selected"),
        );

        if (event.key === "ArrowDown") {
          event.preventDefault();
          items[(current + 1) % items.length]?.dispatchEvent(
            new MouseEvent("mouseenter", { bubbles: true }),
          );
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          items[
            (current - 1 + items.length) % items.length
          ]?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
          return true;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          items[current]?.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true }),
          );
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          pop.dispatchEvent(new Event("butter-dismiss"));
          return true;
        }
        return false;
      },
    },
  });
}
