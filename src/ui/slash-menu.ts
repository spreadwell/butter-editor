/**
 * Slash command menu for Butter PM. Type "/" at the start of an empty
 * block (or after whitespace) to open a block-inserter picker.
 *
 * Replaces the "/" + query with the chosen block via PM transactions.
 * Closes on selection change away from the query, Escape, or pick.
 */
import { App, setIcon } from "obsidian";
import { Plugin as PMPlugin, PluginKey, Selection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { setBlockType, wrapIn } from "prosemirror-commands";
import type { Schema } from "prosemirror-model";

// ═══════════════════════════════════════════
//  Items
// ═══════════════════════════════════════════

export interface SlashItem {
  id: string;
  label: string;
  desc: string;
  icon: string;
  keywords: string[];
  run: (view: EditorView, schema: Schema, app: App) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  // ── Headings ────────────────────────────────────────────────
  {
    id: "h1",
    label: "Heading 1",
    desc: "Large section heading",
    icon: "heading-1",
    keywords: ["h1", "title"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 1 })(v.state, v.dispatch),
  },
  {
    id: "h2",
    label: "Heading 2",
    desc: "Medium heading",
    icon: "heading-2",
    keywords: ["h2"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 2 })(v.state, v.dispatch),
  },
  {
    id: "h3",
    label: "Heading 3",
    desc: "Smaller heading",
    icon: "heading-3",
    keywords: ["h3"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 3 })(v.state, v.dispatch),
  },
  {
    id: "h4",
    label: "Heading 4",
    desc: "Small heading",
    icon: "heading-4",
    keywords: ["h4"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 4 })(v.state, v.dispatch),
  },
  {
    id: "h5",
    label: "Heading 5",
    desc: "Subsection",
    icon: "heading-5",
    keywords: ["h5"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 5 })(v.state, v.dispatch),
  },
  {
    id: "h6",
    label: "Heading 6",
    desc: "Smallest heading",
    icon: "heading-6",
    keywords: ["h6"],
    run: (v, s) => setBlockType(s.nodes.heading, { level: 6 })(v.state, v.dispatch),
  },
  {
    id: "paragraph",
    label: "Paragraph",
    desc: "Plain text block",
    icon: "pilcrow",
    keywords: ["para", "text"],
    run: (v, s) => setBlockType(s.nodes.paragraph)(v.state, v.dispatch),
  },

  // ── Lists ───────────────────────────────────────────────────
  // Flat-list schema (PMX 0.18.37+): each entry inserts ONE
  // list_item with the appropriate `kind`. Visual list emergence
  // happens automatically when subsequent items are typed below.
  {
    id: "bullet",
    label: "Bullet list",
    desc: "Unordered list",
    icon: "list",
    keywords: ["ul", "list", "bullet"],
    run: (v, s) => insertFlatListItem(v, s, "bullet"),
  },
  {
    id: "ordered",
    label: "Numbered list",
    desc: "Ordered list",
    icon: "list-ordered",
    keywords: ["ol", "numbered", "ordered"],
    run: (v, s) => insertFlatListItem(v, s, "ordered"),
  },
  {
    id: "task",
    label: "Task list",
    desc: "Checkable to-do items",
    icon: "list-checks",
    keywords: ["task", "todo", "checkbox", "check"],
    run: (v, s) => insertFlatListItem(v, s, "task"),
  },

  // ── Structural ──────────────────────────────────────────────
  {
    id: "quote",
    label: "Blockquote",
    desc: "Indented quotation",
    icon: "quote",
    keywords: ["quote", "blockquote"],
    run: (v, s) => wrapIn(s.nodes.blockquote)(v.state, v.dispatch),
  },
  {
    id: "hr",
    label: "Divider",
    desc: "Horizontal rule",
    icon: "minus",
    keywords: ["hr", "rule", "divider", "separator"],
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
    keywords: ["table", "grid"],
    run: (v, s) => insertTable(v, s, 3, 3),
  },

  // ── Code + math ─────────────────────────────────────────────
  {
    id: "code",
    label: "Code block",
    desc: "Fenced code",
    icon: "file-code",
    keywords: ["code", "fence", "pre"],
    run: (v, s) => setBlockType(s.nodes.code_block)(v.state, v.dispatch),
  },
  {
    id: "math",
    label: "Math block",
    desc: "$$…$$ LaTeX equation",
    icon: "sigma",
    keywords: ["math", "latex", "equation", "tex"],
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
    keywords: ["mermaid", "diagram", "flowchart", "sequence"],
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
    keywords: ["base", "data", "table"],
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

class SlashMenuPopover {
  dom: HTMLElement;
  private items: SlashItem[] = [];
  private selected = 0;
  private itemEls: HTMLElement[] = [];

  constructor(
    private view: EditorView,
    private schema: Schema,
    private app: App,
    private triggerPos: number,
    private onDismiss: () => void,
  ) {
    this.dom = activeDocument.createElement("div");
    this.dom.className = "butter-slash-menu";
    // ARIA listbox pattern. Editor focus stays in the document so
    // typing keeps flowing through to the slash query; the menu
    // tracks its highlighted item via aria-activedescendant on the
    // listbox container, which screen readers announce as the
    // "virtual focus" without our needing to actually move DOM focus.
    this.dom.setAttribute("role", "listbox");
    this.dom.setAttribute("aria-label", "Slash menu");
    this.dom.id = `butter-slash-${Math.random().toString(36).slice(2, 9)}`;
    activeDocument.body.appendChild(this.dom);
    this.filter("");
    this.position();
  }

  private position() {
    const coords = this.view.coordsAtPos(this.triggerPos);
    if (!coords) return;
    this.dom.addClass("butter-pos-fixed-popover");
    this.dom.setCssProps({
      "--butter-pos-left": `${coords.left}px`,
      "--butter-pos-top": `${coords.bottom + 4}px`,
    });
    window.requestAnimationFrame(() => {
      const rect = this.dom.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 12) {
        this.dom.setCssProps({
          "--butter-pos-top": `${coords.top - rect.height - 4}px`,
        });
      }
    });
  }

  filter(query: string) {
    const q = query.toLowerCase().trim();
    this.items = q
      ? SLASH_ITEMS.filter(
          (it) =>
            it.label.toLowerCase().includes(q) ||
            it.keywords.some((k) => k.startsWith(q)) ||
            it.id.includes(q),
        )
      : SLASH_ITEMS.slice();
    this.selected = 0;
    this.render();
  }

  private render() {
    this.dom.empty();
    this.itemEls = [];
    if (!this.items.length) {
      const empty = this.dom.createDiv({ cls: "butter-slash-empty" });
      empty.textContent = "No matches";
      return;
    }
    for (const [i, item] of this.items.entries()) {
      const el = this.dom.createDiv({ cls: "butter-slash-item" });
      el.setAttribute("role", "option");
      el.id = `${this.dom.id}-opt-${i}`;
      if (i === this.selected) {
        el.addClass("is-selected");
        el.setAttribute("aria-selected", "true");
      } else {
        el.setAttribute("aria-selected", "false");
      }
      const iconEl = el.createDiv({ cls: "butter-slash-icon" });
      setIcon(iconEl, item.icon);
      const meta = el.createDiv({ cls: "butter-slash-meta" });
      meta.createDiv({ cls: "butter-slash-label", text: item.label });
      meta.createDiv({ cls: "butter-slash-desc", text: item.desc });
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
    this.dom.remove();
  }
}

// ═══════════════════════════════════════════
//  Plugin
// ═══════════════════════════════════════════

export function slashMenuPlugin(app: App, schema: Schema) {
  const key = new PluginKey("butter-slash-menu");

  return new PMPlugin({
    key,
    view(view) {
      let menu: SlashMenuPopover | null = null;
      let triggerPos = -1;

      const close = () => {
        menu?.destroy();
        menu = null;
        triggerPos = -1;
      };

      const maybeOpen = (v: EditorView) => {
        // Read-only license gate. PM's `editable: false` already
        // blocks the keystroke that would type `/`, so this is
        // mostly defensive - but if a future code path ever inserts
        // `/` programmatically (e.g. paste), we don't want the menu
        // to pop up over a non-editable doc.
        if (!v.editable) return;
        const { head } = v.state.selection;
        const prev = v.state.doc.textBetween(Math.max(0, head - 1), head);
        if (prev !== "/") return;
        const line = v.state.doc.resolve(head);
        const atStart = line.parentOffset === 1;
        const before = v.state.doc.textBetween(Math.max(0, head - 2), head - 1);
        if (!atStart && before && !/\s/.test(before)) return;
        triggerPos = head - 1;
        menu = new SlashMenuPopover(v, schema, app, triggerPos, close);
      };

      const updateFilter = (v: EditorView) => {
        if (!menu) return;
        const head = v.state.selection.head;
        if (head < triggerPos) return close();
        const query = v.state.doc.textBetween(triggerPos + 1, head);
        if (/\s/.test(query)) return close();
        menu.filter(query);
      };

      return {
        update: (v, prev) => {
          if (v.state.doc.eq(prev.doc) && v.state.selection.eq(prev.selection))
            return;
          if (menu) updateFilter(v);
          else maybeOpen(v);
        },
        destroy: close,
      };
    },
    props: {
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
          pop.remove();
          return true;
        }
        return false;
      },
    },
  });
}
