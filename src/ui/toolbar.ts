/**
 * Formatting toolbar for Butter Editor.
 * Desktop: layout-driven button row with sticky bar below properties,
 * heading dropdown, link popover, table grid picker, and user-defined
 * submenus (popups containing arbitrary children).
 * Mobile: native mobile-toolbar above keyboard - flattens submenus
 * (children render inline in the strip).
 *
 * The toolbar layout is a tree of `LayoutItem`s (button/separator/
 * submenu) read via `getLayout()` on construction and on every
 * `rebuild()` call. Settings UI calls rebuild when the user reorders,
 * adds, or removes items.
 */
import { App, FuzzySuggestModal, Modal, Platform, TFile, setIcon } from "obsidian";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Schema, MarkType, NodeType } from "prosemirror-model";
import { toggleMark, setBlockType, wrapIn } from "prosemirror-commands";

/** PM command shape - mirrors `Command` from prosemirror-state, which
 *  isn't exported by name from prosemirror-commands. */
type PMCommand = (
  state: EditorState,
  dispatch?: (tr: import("prosemirror-state").Transaction) => void,
  view?: EditorView,
) => boolean;
import { undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import type { Layout, LayoutItem } from "./toolbar-layout";
import {
  insertCallout,
  insertFlatListItem,
} from "./slash-menu";
import { openRichContextMenu } from "./link-context-menu";
import { renderMobile, installMobileLongPress } from "./toolbar-mobile";

// ── Button definitions ──

export interface BtnDef {
  id: string;
  icon: string;
  label: string;
  kbd?: string;
  kind: "mark" | "block" | "list" | "insert" | "heading" | "history";
  markName?: string;
  nodeName?: string;
  attrs?: Record<string, unknown>;
  /** For kind=heading: 0 = paragraph, 1-6 = heading level. */
  headingLevel?: number;
  /** For kind=history: which direction. */
  historyDir?: "undo" | "redo";
}

const BUTTONS = {
  heading: [
    { id: "paragraph", icon: "pilcrow",   label: "Paragraph", kbd: "Ctrl+Alt+0", kind: "heading" as const, headingLevel: 0 },
    { id: "heading-1", icon: "heading-1", label: "Heading 1", kbd: "Ctrl+Alt+1", kind: "heading" as const, headingLevel: 1 },
    { id: "heading-2", icon: "heading-2", label: "Heading 2", kbd: "Ctrl+Alt+2", kind: "heading" as const, headingLevel: 2 },
    { id: "heading-3", icon: "heading-3", label: "Heading 3", kbd: "Ctrl+Alt+3", kind: "heading" as const, headingLevel: 3 },
    { id: "heading-4", icon: "heading-4", label: "Heading 4", kbd: "Ctrl+Alt+4", kind: "heading" as const, headingLevel: 4 },
    { id: "heading-5", icon: "heading-5", label: "Heading 5", kbd: "Ctrl+Alt+5", kind: "heading" as const, headingLevel: 5 },
    { id: "heading-6", icon: "heading-6", label: "Heading 6", kbd: "Ctrl+Alt+6", kind: "heading" as const, headingLevel: 6 },
  ],
  inline: [
    { id: "bold",          icon: "bold",          label: "Bold",          kbd: "Ctrl+B", kind: "mark" as const, markName: "strong" },
    { id: "italic",        icon: "italic",        label: "Italic",        kbd: "Ctrl+I", kind: "mark" as const, markName: "em" },
    { id: "strikethrough", icon: "strikethrough",  label: "Strikethrough", kbd: "Ctrl+Shift+S", kind: "mark" as const, markName: "strikethrough" },
    { id: "code",          icon: "code-2",        label: "Inline code",   kbd: "Ctrl+E", kind: "mark" as const, markName: "code" },
    // `highlight` is a split button when HTML formatting is enabled:
    // the main face toggles `==text==` (markdown highlight); a small
    // chevron next to it opens the color palette to write `<mark
    // style="background-color: …">…</mark>`. When HTML formatting is
    // off (Behavior → Formatting), only the main face renders so the
    // user can't author HTML inline. See renderRegularButton.
    { id: "highlight",     icon: "highlighter",   label: "Highlight",     kbd: "Ctrl+Shift+H", kind: "mark" as const, markName: "highlight" },
    { id: "text-color",    icon: "palette",       label: "Text color",    kind: "mark" as const, markName: "font" },
    { id: "link",          icon: "link",          label: "Link",          kbd: "Ctrl+K", kind: "mark" as const, markName: "link" },
    { id: "insert-link-md", icon: "link-2",       label: "Insert markdown link", kind: "insert" as const },
    { id: "clear-formatting", icon: "eraser",     label: "Clear formatting", kind: "insert" as const },
  ],
  block: [
    { id: "bullet-list",   icon: "list",          label: "Bullet list",   kind: "list" as const, nodeName: "bullet_list" },
    { id: "ordered-list",  icon: "list-ordered",  label: "Ordered list",  kind: "list" as const, nodeName: "ordered_list" },
    { id: "task-list",     icon: "list-checks",   label: "Task list",     kind: "list" as const, nodeName: "task_list" },
    { id: "blockquote",    icon: "quote",         label: "Blockquote",    kbd: "Ctrl+Shift+B", kind: "block" as const, nodeName: "blockquote" },
    { id: "code-block",    icon: "file-code",     label: "Code block",    kind: "block" as const, nodeName: "code_block" },
    { id: "hr",            icon: "minus",         label: "Horizontal rule", kind: "insert" as const, nodeName: "horizontal_rule" },
  ],
  insert: [
    { id: "table", icon: "table", label: "Insert table", kind: "insert" as const, nodeName: "table" },
    { id: "image", icon: "image", label: "Insert image", kind: "insert" as const, nodeName: "image" },
    { id: "insert-base-inline", icon: "database", label: "Insert Base query", kind: "insert" as const },
    { id: "insert-base-embed",  icon: "file-spreadsheet", label: "Embed a Base file", kind: "insert" as const },
  ],
  // Callout types - one button per Obsidian callout type so the user
  // can drag any subset onto the toolbar. Default layout packages
  // them all in a "Callout" submenu (same pattern as headings).
  callout: [
    { id: "callout-note",     icon: "pencil",          label: "Note callout",     kind: "insert" as const },
    { id: "callout-abstract", icon: "clipboard-list",  label: "Abstract callout", kind: "insert" as const },
    { id: "callout-info",     icon: "info",            label: "Info callout",     kind: "insert" as const },
    { id: "callout-tip",      icon: "lightbulb",       label: "Tip callout",      kind: "insert" as const },
    { id: "callout-success",  icon: "check-circle",    label: "Success callout",  kind: "insert" as const },
    { id: "callout-question", icon: "help-circle",     label: "Question callout", kind: "insert" as const },
    { id: "callout-warning",  icon: "alert-triangle",  label: "Warning callout",  kind: "insert" as const },
    { id: "callout-failure",  icon: "x-circle",        label: "Failure callout",  kind: "insert" as const },
    { id: "callout-danger",   icon: "zap",             label: "Danger callout",   kind: "insert" as const },
    { id: "callout-bug",      icon: "bug",             label: "Bug callout",      kind: "insert" as const },
    { id: "callout-example",  icon: "list",            label: "Example callout",  kind: "insert" as const },
    { id: "callout-quote",    icon: "quote",           label: "Quote callout",    kind: "insert" as const },
  ],
  history: [
    { id: "undo", icon: "undo-2", label: "Undo", kbd: "Ctrl+Z", kind: "history" as const, historyDir: "undo" as const },
    { id: "redo", icon: "redo-2", label: "Redo", kbd: "Ctrl+Shift+Z", kind: "history" as const, historyDir: "redo" as const },
  ],
  // Block-context buttons. Each opens the unified mobile drawer
  // in a different mode, scoped to the block at the current
  // selection. Available in the layout customizer so users can
  // surface whichever they want, in whatever order.
  context: [
    // `insert` opens the mobile insert drawer (slash-menu-as-grid).
    // Customizable like every other button so users can place it
    // wherever they want; default layout puts it first in the
    // context cluster alongside Turn into / Block actions. Desktop
    // doesn't render this button (no insert drawer on desktop —
    // slash menu fills that role and the toolbar-mobile renderer
    // is the only one wired to handle the click).
    { id: "insert",        icon: "plus",         label: "Insert block",  kind: "insert" as const },
    { id: "turn-into",     icon: "shuffle",      label: "Turn into",     kind: "insert" as const },
    { id: "block-actions", icon: "square-menu",  label: "Block actions", kind: "insert" as const },
  ],
};

const ALL_BUTTONS: BtnDef[] = [
  ...BUTTONS.heading,
  ...BUTTONS.inline,
  ...BUTTONS.block,
  ...BUTTONS.insert,
  ...BUTTONS.callout,
  ...BUTTONS.history,
  ...BUTTONS.context,
];

/** Lookup table: button id → BtnDef. */
export const BUTTON_REGISTRY = new Map<string, BtnDef>();
for (const b of ALL_BUTTONS) BUTTON_REGISTRY.set(b.id, b);

/**
 * Public catalog of every customizable button on the main formatting
 * toolbar. The settings tab consumes this to render the layout
 * editor's "Available" list. Headings are individual entries - the
 * old combined "Heading" dropdown was retired so the customizer can
 * place each level wherever the user wants.
 */
export const MAIN_TOOLBAR_BUTTON_DEFS: Array<{
  id: string;
  label: string;
  group: string;
  icon: string;
}> = [
  ...BUTTONS.heading.map((b) => ({
    id: b.id,
    label: b.label,
    group: "Headings",
    icon: b.icon,
  })),
  ...BUTTONS.inline.map((b) => ({
    id: b.id,
    label: b.label,
    group: "Inline marks",
    icon: b.icon,
  })),
  ...BUTTONS.block.map((b) => ({
    id: b.id,
    label: b.label,
    group: "Block types",
    icon: b.icon,
  })),
  ...BUTTONS.insert.map((b) => ({
    id: b.id,
    label: b.label,
    group: "Insert",
    icon: b.icon,
  })),
  ...BUTTONS.callout.map((b) => ({
    id: b.id,
    label: b.label,
    group: "Callouts",
    icon: b.icon,
  })),
  ...BUTTONS.history.map((b) => ({
    id: b.id,
    label: b.label,
    group: "History",
    icon: b.icon,
  })),
  ...BUTTONS.context.map((b) => ({
    id: b.id,
    label: b.label,
    group: "Block context",
    icon: b.icon,
  })),
];

// ── Active state detection ──

export function isMarkActive(state: EditorState, markType: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!markType.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, markType);
}

function isBlockActive(state: EditorState, nodeType: NodeType, attrs?: Record<string, unknown>): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === nodeType) {
      if (!attrs) return true;
      return Object.entries(attrs).every(([k, v]) => node.attrs[k] === v);
    }
  }
  return false;
}

function getActiveHeadingLevel(state: EditorState, schema: Schema): number {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.heading) {
      const level = ($from.node(d).attrs as { level?: unknown }).level;
      return typeof level === "number" ? level : 0;
    }
  }
  return 0;
}

// ── Command execution ──
//
// IMPORTANT: run the command synchronously against view.state/view.dispatch
// WITHOUT wrapping dispatch. A wrapper callback captures the view lazily and
// can misfire across lifecycle changes (setViewData rebuilds the state).
// Calling view.dispatch directly is the pattern that matches the context
// menu and reliably applies the transaction.

function runCommand(view: EditorView, cmd: PMCommand) {
  return cmd(view.state, view.dispatch.bind(view), view);
}

export function execMarkCmd(btn: BtnDef, schema: Schema, view: EditorView) {
  const markType = schema.marks[btn.markName!];
  if (!markType) return;
  toggleMark(markType)(view.state, view.dispatch.bind(view));
}

export function execHistoryCmd(btn: BtnDef, view: EditorView) {
  const cmd = btn.historyDir === "redo" ? redo : undo;
  cmd(view.state, view.dispatch.bind(view));
}

export function execBlockCmd(btn: BtnDef, schema: Schema, view: EditorView) {
  const nodeType = schema.nodes[btn.nodeName!];
  if (!nodeType) return;

  if (btn.nodeName === "blockquote") {
    wrapIn(nodeType)(view.state, view.dispatch.bind(view));
  } else if (btn.nodeName === "code_block") {
    if (isBlockActive(view.state, nodeType)) {
      setBlockType(schema.nodes.paragraph)(view.state, view.dispatch.bind(view));
    } else {
      setBlockType(nodeType)(view.state, view.dispatch.bind(view));
    }
  }
}

export function execListCmd(btn: BtnDef, schema: Schema, view: EditorView) {
  const kind: "bullet" | "ordered" | "task" =
    btn.nodeName === "ordered_list" ? "ordered" :
    btn.nodeName === "task_list" ? "task" : "bullet";
  insertFlatListItem(view, schema, kind);
}

export function execInsertCmd(
  btn: BtnDef,
  schema: Schema,
  view: EditorView,
  app: App,
) {
  if (btn.nodeName === "horizontal_rule") {
    view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()));
  } else if (btn.nodeName === "image") {
    new ImageUrlPromptModal(app, (src) => {
      if (!src) return;
      view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.image.create({ src, alt: "" })));
    }).open();
  } else if (btn.id === "insert-link-md") {
    insertMarkdownLink(view, schema);
  } else if (btn.id.startsWith("callout-")) {
    insertCallout(view, schema, btn.id.slice("callout-".length));
  } else if (btn.id === "insert-base-inline") {
    // Convert the current block to a `code_block` with language=base.
    // Obsidian renders inline `base` fences as a live data view; the
    // user types base spec inside (filters / views / formulas).
    const codeBlock = schema.nodes.code_block;
    if (codeBlock) {
      setBlockType(codeBlock, { language: "base" })(
        view.state,
        view.dispatch.bind(view),
      );
    }
  } else if (btn.id === "insert-base-embed") {
    // Open a fuzzy file picker scoped to `.base` files in the vault.
    // On pick, insert an `obsidian_embed` block (`![[name.base]]`)
    // at the current selection.
    const embedType = schema.nodes.obsidian_embed;
    if (!embedType) return;
    const baseFiles = app.vault
      .getFiles()
      .filter((f) => f.extension === "base");
    if (baseFiles.length === 0) {
      // No base files in vault - give the user a hint instead of
      // popping an empty picker.
      const NoticeCtor = (window as { Notice?: new (msg: string) => unknown }).Notice;
      if (NoticeCtor) new NoticeCtor("No `.base` files found in this vault.");
      return;
    }
    const modal = new BaseFilePickerModal(app, baseFiles, (file) => {
      const embed = embedType.create({ src: file.path });
      view.dispatch(view.state.tr.replaceSelectionWith(embed));
      window.setTimeout(() => view.focus(), 0);
    });
    modal.open();
  }
}

/** Fuzzy picker for `.base` files in the vault. Used by the
 *  "Insert existing base" toolbar button. */
class BaseFilePickerModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private files: TFile[],
    private onPick: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Pick a .base file to embed…");
  }
  getItems(): TFile[] {
    return this.files;
  }
  getItemText(file: TFile): string {
    return file.path;
  }
  onChooseItem(file: TFile) {
    this.onPick(file);
  }
}

/** Small modal that asks for an image URL and reports it via callback.
 *  Replaces a previous `prompt()` call that the Obsidian directory
 *  review flags as a UX violation. */
class ImageUrlPromptModal extends Modal {
  private onSubmit: (src: string | null) => void;

  constructor(app: App, onSubmit: (src: string | null) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Insert image");
    const wrap = contentEl.createDiv({ cls: "butter-image-url-modal" });
    wrap.createDiv({ cls: "butter-image-url-label", text: "Image URL" });
    const input = wrap.createEl("input", {
      type: "text",
      placeholder: "https://...",
      cls: "butter-image-url-input",
    });
    input.focus();
    const actions = wrap.createDiv({ cls: "butter-image-url-actions" });
    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    const okBtn = actions.createEl("button", { text: "Insert", cls: "mod-cta" });
    const submit = () => {
      const value = input.value.trim();
      this.close();
      this.onSubmit(value || null);
    };
    okBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", () => {
      this.close();
      this.onSubmit(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
        this.onSubmit(null);
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Insert a markdown-style link at the current selection. If text is
 *  selected, applies the link mark with an empty href (user edits via
 *  right-click). If selection is empty, inserts a placeholder "link
 *  text" string with the link mark applied + selected, so the user
 *  can immediately type to replace the placeholder. The link's href
 *  starts as `https://` so right-click "Edit link" lands the cursor
 *  in a valid template. */
function insertMarkdownLink(view: EditorView, schema: Schema) {
  const markType = schema.marks.link;
  if (!markType) return;
  const { selection, tr } = view.state;
  if (!selection.empty) {
    // Has selection - just toggle the link mark on it.
    if (toggleMark(markType, { href: "https://" })(view.state, view.dispatch.bind(view))) {
      view.focus();
    }
    return;
  }
  const placeholder = "link text";
  const linkMark = markType.create({ href: "https://" });
  const textNode = schema.text(placeholder, [linkMark]);
  const insertPos = selection.from;
  const inserted = tr.replaceSelectionWith(textNode, false);
  // Select the just-inserted placeholder so the next keystroke
  // replaces it (link mark is preserved as long as the selection
  // stays inside the text node).
  inserted.setSelection(
    TextSelection.create(inserted.doc, insertPos, insertPos + placeholder.length),
  );
  view.dispatch(inserted);
  view.focus();
}

export function insertTable(schema: Schema, view: EditorView, rows: number, cols: number) {
  const { table, table_row, table_header, table_cell } = schema.nodes;
  if (!table || !table_row || !table_cell) return;
  const headerType = table_header || table_cell;
  const makeRow = (cellType: NodeType) => table_row.create(null,
    Array.from({ length: cols }, () => cellType.createAndFill()!));
  const tableNode = table.create(null, [
    makeRow(headerType),
    ...Array.from({ length: rows - 1 }, () => makeRow(table_cell)),
  ]);
  view.dispatch(view.state.tr.replaceSelectionWith(tableNode));
}

export function setHeading(schema: Schema, view: EditorView, level: number) {
  if (level === 0) {
    runCommand(view, setBlockType(schema.nodes.paragraph));
  } else {
    runCommand(view, setBlockType(schema.nodes.heading, { level }));
  }
}

/** Classify a user-typed link target into either an external URL
 *  (markdown-link) or a vault wikilink. The user shouldn't have to
 *  type `[[]]` to mean "internal" or remember the protocol - type
 *  what reads naturally and we route it to the right node type:
 *
 *  - `[[Note]]` / `[[Note|alias]]` → wikilink (brackets respected)
 *  - `https://`, `http://`, `mailto:`, `tel:`, `ftp://`, `obsidian://`
 *    → external, applied as a markdown link mark
 *  - `domain.tld[/path]` (no scheme but has a dot + TLD-shape and
 *    no spaces) → external, auto-prefixed with `https://`
 *  - Anything else → wikilink to a note with that name
 *
 *  Returns `{ kind, target, alias? }`. `target` is the note path or
 *  full URL; `alias` (wikilink only) is the explicit pipe-after text. */
type LinkTarget =
  | { kind: "external"; target: string }
  | { kind: "wikilink"; target: string; alias?: string };

function classifyLinkInput(raw: string): LinkTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Explicit wikilink brackets - strip and parse the alias split.
  const wm = trimmed.match(/^\[\[(.+?)\]\]$/);
  if (wm) {
    const inner = wm[1];
    const pipe = inner.indexOf("|");
    if (pipe >= 0) {
      return {
        kind: "wikilink",
        target: inner.slice(0, pipe).trim(),
        alias: inner.slice(pipe + 1).trim(),
      };
    }
    return { kind: "wikilink", target: inner.trim() };
  }
  // Has a scheme - external as-is.
  if (/^([a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|sms:|obsidian:)/i.test(trimmed)) {
    return { kind: "external", target: trimmed };
  }
  // Domain-shaped (no spaces, ends with a TLD-like `.xy[z]`) - auto-prefix.
  if (/^[^\s]+\.[a-z]{2,}([/?#].*)?$/i.test(trimmed)) {
    return { kind: "external", target: "https://" + trimmed };
  }
  // Otherwise treat as a note name.
  return { kind: "wikilink", target: trimmed };
}

/** Apply a classified link to the editor. Routes external → link
 *  mark on selection (or insert displayText with the mark), and
 *  wikilink → insert a `wikilink` atom node with target + alias.
 *  When selection has text, that text becomes the alias / linked
 *  span; when empty, `displayText` becomes the visible label.  */
function applyLink(
  schema: Schema,
  view: EditorView,
  detected: LinkTarget,
  displayText?: string,
) {
  const sel = view.state.selection;
  const hasSelection = !sel.empty;

  if (detected.kind === "external") {
    const markType = schema.marks.link;
    if (!markType) return;
    if (hasSelection) {
      runCommand(view, toggleMark(markType, { href: detected.target }));
    } else {
      const visible = (displayText ?? "").trim() || detected.target;
      const node = schema.text(visible, [markType.create({ href: detected.target })]);
      view.dispatch(view.state.tr.replaceSelectionWith(node, false));
    }
    return;
  }

  // Wikilink
  const wikiType = schema.nodes.wikilink;
  if (!wikiType) return;
  let alias = detected.alias ?? "";
  if (!alias) {
    if (hasSelection) {
      alias = view.state.doc.textBetween(sel.from, sel.to);
    } else if (displayText?.trim()) {
      alias = displayText.trim();
    }
  }
  const node = wikiType.create({ target: detected.target, alias });
  view.dispatch(view.state.tr.replaceSelectionWith(node));
}

// ── Popover helpers ──

function createTablePicker(
  schema: Schema,
  view: EditorView,
  onClose: () => void,
): HTMLElement {
  const ROWS = 6;
  const COLS = 8;
  const picker = activeDocument.createElement("div");
  picker.classList.add("butter-table-picker");
  // Treat the picker itself as the focusable + ARIA-named region so
  // keyboard users can arrow-navigate the grid as a single widget,
  // matching the mouse-hover sizing affordance. Tabindex=0 lets the
  // popover receive focus when setPopover anchors it.
  picker.setAttribute("role", "grid");
  picker.setAttribute("aria-label", "Pick table size");
  picker.tabIndex = 0;

  const grid = activeDocument.createElement("div");
  grid.classList.add("grid");
  picker.appendChild(grid);

  const label = activeDocument.createElement("div");
  label.classList.add("label");
  label.textContent = "Hover or arrow-key to size";
  picker.appendChild(label);

  let hoverR = -1, hoverC = -1;
  let kbdR = 0, kbdC = 0;
  // Distinguishes "no selection visible" (e.g. before any keyboard
  // navigation has happened and mouse is outside the grid) from
  // "selection at 1×1" (kbdR/kbdC = 0). Without this flag the cells
  // would always show the 1×1 highlight on first paint.
  let kbdActive = false;

  const updateCells = () => {
    const r = hoverR >= 0 ? hoverR : (kbdActive ? kbdR : -1);
    const c = hoverC >= 0 ? hoverC : (kbdActive ? kbdC : -1);
    const cells = grid.querySelectorAll<HTMLElement>(".cell");
    cells.forEach((cell) => {
      const cr = parseInt(cell.getAttribute("data-r")!);
      const cc = parseInt(cell.getAttribute("data-c")!);
      cell.classList.toggle("is-hot", cr <= r && cc <= c);
    });
    label.textContent =
      r >= 0 ? `${r + 1} × ${c + 1} table` : "Hover or arrow-key to size";
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = activeDocument.createElement("div");
      cell.classList.add("cell");
      cell.setAttribute("data-r", String(r));
      cell.setAttribute("data-c", String(c));
      cell.setAttribute("role", "gridcell");
      cell.addEventListener("mouseenter", () => { hoverR = r; hoverC = c; updateCells(); });
      cell.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insertTable(schema, view, r + 1, c + 1);
        view.focus();
        onClose();
      });
      grid.appendChild(cell);
    }
  }

  grid.addEventListener("mouseleave", () => { hoverR = -1; hoverC = -1; updateCells(); });

  picker.addEventListener("keydown", (e: KeyboardEvent) => {
    const key = e.key;
    if (
      key !== "ArrowLeft" &&
      key !== "ArrowRight" &&
      key !== "ArrowUp" &&
      key !== "ArrowDown" &&
      key !== "Home" &&
      key !== "End" &&
      key !== "Enter" &&
      key !== " "
    )
      return;
    e.preventDefault();
    if (key === "Enter" || key === " ") {
      const r = kbdActive ? kbdR : 0;
      const c = kbdActive ? kbdC : 0;
      insertTable(schema, view, r + 1, c + 1);
      view.focus();
      onClose();
      return;
    }
    kbdActive = true;
    if (key === "ArrowLeft") kbdC = Math.max(0, kbdC - 1);
    else if (key === "ArrowRight") kbdC = Math.min(COLS - 1, kbdC + 1);
    else if (key === "ArrowUp") kbdR = Math.max(0, kbdR - 1);
    else if (key === "ArrowDown") kbdR = Math.min(ROWS - 1, kbdR + 1);
    else if (key === "Home") { kbdR = 0; kbdC = 0; }
    else if (key === "End") { kbdR = ROWS - 1; kbdC = COLS - 1; }
    updateCells();
  });

  return picker;
}

// ── Color palette ──

// Swatches chosen for legibility on both light and dark themes.
// Values are CSS color literals (named or hex) so the source written
// to disk renders identically outside Butter / in plain markdown
// preview tools.
const TEXT_SWATCHES: ReadonlyArray<{ name: string; value: string }> = [
  { name: "Red",     value: "#e03131" },
  { name: "Orange",  value: "#e8590c" },
  { name: "Yellow",  value: "#f08c00" },
  { name: "Green",   value: "#2f9e44" },
  { name: "Teal",    value: "#0ca678" },
  { name: "Blue",    value: "#1971c2" },
  { name: "Purple",  value: "#6741d9" },
  { name: "Pink",    value: "#c2255c" },
  { name: "Gray",    value: "#868e96" },
];

// Highlights use semi-transparent rgba so any underlying text color
// (font mark) stays visible THROUGH the highlight tint, the way
// Obsidian's native `==highlight==` does. Solid pastels covered the
// text and made font coloring look like it disappeared. Alpha 0.4
// matches Obsidian's default highlight overlay.
const HIGHLIGHT_SWATCHES: ReadonlyArray<{ name: string; value: string }> = [
  { name: "Yellow",  value: "rgba(255, 234, 0, 0.4)" },
  { name: "Orange",  value: "rgba(255, 140, 0, 0.4)" },
  { name: "Red",     value: "rgba(255, 80, 80, 0.4)" },
  { name: "Pink",    value: "rgba(255, 105, 180, 0.4)" },
  { name: "Purple",  value: "rgba(170, 110, 255, 0.4)" },
  { name: "Blue",    value: "rgba(70, 160, 255, 0.4)" },
  { name: "Teal",    value: "rgba(40, 200, 200, 0.4)" },
  { name: "Green",   value: "rgba(80, 200, 80, 0.4)" },
  { name: "Gray",    value: "rgba(140, 140, 140, 0.35)" },
];

/** Apply a `font` mark with the given color (or clear when color is
 *  null) to the current selection. When the selection is empty, sets
 *  storedMarks so the color applies to the next-typed text. */
function applyTextColor(
  schema: Schema,
  view: EditorView,
  color: string | null,
): void {
  const markType = schema.marks.font;
  if (!markType) return;
  const { from, to, empty } = view.state.selection;
  const tr = view.state.tr;
  if (empty) {
    const marks = view.state.storedMarks ?? view.state.selection.$from.marks();
    const filtered = marks.filter((m) => m.type !== markType);
    if (color) filtered.push(markType.create({ color, face: "", size: "" }));
    tr.setStoredMarks(filtered);
  } else {
    tr.removeMark(from, to, markType);
    if (color) tr.addMark(from, to, markType.create({ color, face: "", size: "" }));
  }
  view.dispatch(tr);
  view.focus();
}

/** Apply a `highlight` mark with the given background color (or
 *  clear when color is null). Empty selection sets storedMarks. */
function applyHighlightColor(
  schema: Schema,
  view: EditorView,
  color: string | null,
): void {
  const markType = schema.marks.highlight;
  if (!markType) return;
  const { from, to, empty } = view.state.selection;
  const tr = view.state.tr;
  if (empty) {
    const marks = view.state.storedMarks ?? view.state.selection.$from.marks();
    const filtered = marks.filter((m) => m.type !== markType);
    if (color) filtered.push(markType.create({ color, html: true }));
    tr.setStoredMarks(filtered);
  } else {
    tr.removeMark(from, to, markType);
    if (color) tr.addMark(from, to, markType.create({ color, html: true }));
  }
  view.dispatch(tr);
  view.focus();
}

/** Build a 9-swatch color palette popover with a clear-color row and
 *  a "Custom…" row that opens a native HTMLInputElement[type=color]
 *  for arbitrary colors. `kind` selects which palette (text vs
 *  highlight) and routes the apply call. */
function createColorPalette(
  schema: Schema,
  view: EditorView,
  kind: "text" | "highlight",
  onClose: () => void,
): HTMLElement {
  const wrap = activeDocument.createElement("div");
  wrap.classList.add("butter-color-palette");
  wrap.dataset.kind = kind;

  const swatches = kind === "text" ? TEXT_SWATCHES : HIGHLIGHT_SWATCHES;
  const apply = kind === "text" ? applyTextColor : applyHighlightColor;

  const grid = activeDocument.createElement("div");
  grid.classList.add("butter-color-grid");
  wrap.appendChild(grid);

  for (const sw of swatches) {
    const cell = activeDocument.createElement("button");
    cell.classList.add("butter-color-cell");
    cell.style.background = sw.value;
    cell.setAttribute("aria-label", sw.name);
    cell.title = sw.name;
    cell.addEventListener("mousedown", (e) => {
      e.preventDefault();
      apply(schema, view, sw.value);
      onClose();
    });
    grid.appendChild(cell);
  }

  const footer = activeDocument.createElement("div");
  footer.classList.add("butter-color-footer");
  wrap.appendChild(footer);

  const clearBtn = activeDocument.createElement("button");
  clearBtn.classList.add("butter-color-clear");
  setIcon(clearBtn, "eraser");
  const clearLabel = activeDocument.createElement("span");
  clearLabel.textContent = kind === "text" ? "Default color" : "No highlight";
  clearBtn.appendChild(clearLabel);
  clearBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    apply(schema, view, null);
    onClose();
  });
  footer.appendChild(clearBtn);

  // Native color picker for arbitrary values. The input is invisible
  // but takes the click, so we drive it via a styled button wrapper.
  const customWrap = activeDocument.createElement("label");
  customWrap.classList.add("butter-color-custom");
  setIcon(customWrap, "pipette");
  const customLabel = activeDocument.createElement("span");
  customLabel.textContent = "Custom";
  customWrap.appendChild(customLabel);

  const customInput = activeDocument.createElement("input");
  customInput.type = "color";
  customInput.classList.add("butter-color-custom-input");
  customInput.value = kind === "text" ? "#e03131" : "#fff3bf";
  customInput.addEventListener("input", () => {
    apply(schema, view, customInput.value);
  });
  customInput.addEventListener("change", () => {
    // Commit on `change` (native picker dismiss) so the popover
    // doesn't close while the user is still scrubbing colors.
    onClose();
  });
  customWrap.appendChild(customInput);

  footer.appendChild(customWrap);

  return wrap;
}

/** Mobile palette sheet. Opens the same swatch + clear + custom-input
 *  UI as the desktop popover, hosted in an Obsidian Modal so the
 *  bottom-of-keyboard toolbar doesn't have to deal with positioning a
 *  free-floating popover above its own row. */
export function openMobileColorSheet(
  app: App,
  schema: Schema,
  view: EditorView,
  kind: "text" | "highlight",
): void {
  const modal = new (class extends Modal {
    onOpen() {
      this.titleEl.setText(kind === "text" ? "Text color" : "Highlight color");
      const palette = createColorPalette(schema, view, kind, () => this.close());
      // The desktop popover chrome (border, shadow, padding) is
      // redundant inside a Modal which provides its own framing.
      palette.classList.add("butter-color-palette-in-modal");
      this.contentEl.appendChild(palette);
    }
    onClose() {
      this.contentEl.empty();
    }
  })(app);
  modal.open();
}

function openToolbarLinkMenu(
  app: App,
  schema: Schema,
  view: EditorView,
  anchor: HTMLElement,
): void {
  // Match the right-click link menu UX - same chrome (header tile,
  // 240px width, animation), same field rows. Differences vs. that
  // menu: this one is for INSERTING a fresh link, so the action set
  // is just "Insert" + "Cancel" rather than nav / Clear, and the
  // sub-text shows a contextual hint for what the user typed.
  const sel = view.state.selection;
  const selectedText = sel.empty
    ? ""
    : view.state.doc.textBetween(sel.from, sel.to);

  const insert = (values: Record<string, string>): void => {
    const detected = classifyLinkInput(values.target || "");
    if (!detected) return;
    applyLink(schema, view, detected, values.text || undefined);
    view.focus();
  };

  openRichContextMenu({
    app,
    anchor,
    chrome: {
      icon: "link",
      title: "Add link",
      sub: "URL or note name",
    },
    fields: [
      {
        id: "target",
        label: "Link",
        icon: "link-2",
        placeholder: "https://… or note name",
        // Dual-purpose field - attach the vault-files suggester but
        // suppress its dropdown when the typed value clearly looks
        // like a URL (has a scheme, or a domain-shaped TLD). That
        // way "https://example" doesn't pop a "no results" panel,
        // while "MyNote" still gets fuzzy note suggestions.
        autocomplete: "vault-files",
        suggestSkipWhen: (raw) => looksLikeExternalUrl(raw),
      },
      {
        id: "text",
        label: "Display text",
        icon: "type",
        initial: selectedText,
        placeholder: "Optional",
      },
    ],
    actions: [
      {
        label: "Insert",
        icon: "check",
        onClick: (v) => insert(v),
      },
    ],
    onCommit: (values) => insert(values),
  });
}

/** Heuristic for "this input value is clearly a URL, not a note name."
 *  Matches the same shapes `classifyLinkInput` would route external,
 *  used to suppress vault-file suggestions on the toolbar's
 *  dual-purpose Link field. */
function looksLikeExternalUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^([a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|sms:|obsidian:)/i.test(trimmed)) {
    return true;
  }
  // domain-shaped: no spaces + ends with a TLD-like `.xy[z]`
  if (/^\S+\.[a-z]{2,}([/?#].*)?$/i.test(trimmed)) return true;
  return false;
}


// ── Render context (passed through layout walk) ──

export interface RenderCtx {
  app: App;
  schema: Schema;
  buttonMap: Map<string, HTMLElement>;
  getView: () => EditorView | null;
  /** Resolves the live layout. Used by mobile-only renderers
   *  (variants popover, overflow sheet) which need to walk the
   *  current layout to populate their UI. */
  getLayout: () => Layout;
  closePopover: () => void;
  setPopover: (
    popup: HTMLElement,
    anchor: HTMLElement,
    options?: { closeOnLeave?: boolean },
  ) => void;
  /** Single-block markdown serializer. Threaded in from main.ts so
   *  mobile-only block-context buttons (Block actions / Turn into)
   *  can hand it to the drawer for the "Copy" tile, matching the
   *  desktop block context menu's serializer-based copy. Optional:
   *  when absent, the drawer skips the Copy action. */
  serializeNode?: (node: import("prosemirror-model").Node) => string;
}

function makeSep(): HTMLElement {
  const s = activeDocument.createElement("div");
  s.classList.add("butter-toolbar-separator");
  return s;
}

/** Strip every styling mark off the current selection. Mirrors the
 *  Word / Google Docs "Clear formatting" semantic: removes bold,
 *  italic, color, highlight, underline, sub/sup, kbd, etc., but keeps
 *  `link` (semantic content, not styling). On a collapsed selection
 *  it clears storedMarks so the next-typed character starts fresh.
 *
 *  Touches inline marks only - block-level types (heading, blockquote,
 *  code_block, callout) are content shape, not formatting, and a
 *  separate command handles those. */
export function clearFormatting(view: EditorView, schema: Schema): void {
  const { from, to, empty } = view.state.selection;
  const tr = view.state.tr;
  if (empty) {
    tr.setStoredMarks([]);
  } else {
    for (const name of Object.keys(schema.marks)) {
      if (name === "link") continue;
      tr.removeMark(from, to, schema.marks[name]);
    }
  }
  view.dispatch(tr);
}

/** Read `enableHtmlFormatting` off the plugin without taking a direct
 *  dependency on the plugin module from this layer. Defaults to true
 *  when the plugin isn't found (the toolbar can be rendered in test
 *  harnesses that don't register a plugin instance). */
function isHtmlFormattingEnabled(ctx: RenderCtx): boolean {
  const plugin = ctx.app.plugins?.plugins["butter-editor"] as
    | { settings?: { enableHtmlFormatting?: boolean } }
    | undefined;
  return plugin?.settings?.enableHtmlFormatting !== false;
}

/** Button ids that author inline HTML in the markdown source. Hidden
 *  from the rendered toolbar when the user turns off HTML formatting
 *  in settings. */
const HTML_ONLY_BUTTON_IDS = new Set(["text-color"]);

function renderRegularButton(id: string, ctx: RenderCtx): HTMLElement | null {
  const def = BUTTON_REGISTRY.get(id);
  if (!def) return null;
  if (def.markName && !ctx.schema.marks[def.markName]) return null;
  
  let renderNodeName = def.nodeName;
  if (renderNodeName === "bullet_list" || renderNodeName === "ordered_list" || renderNodeName === "task_list") {
    renderNodeName = "list_item";
  }
  if (renderNodeName && !ctx.schema.nodes[renderNodeName]) return null;

  const htmlOk = isHtmlFormattingEnabled(ctx);
  if (HTML_ONLY_BUTTON_IDS.has(id) && !htmlOk) return null;

  const el = activeDocument.createElement("button");
  el.classList.add("butter-btn", "clickable-icon");
  el.setAttribute(
    "aria-label",
    def.kbd ? `${def.label} (${def.kbd})` : def.label,
  );
  el.dataset.btnId = def.id;
  setIcon(el, def.icon);
  ctx.buttonMap.set(def.id, el);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.closePopover();
    const view = ctx.getView();
    if (!view) return;

    if (def.id === "link") {
      openToolbarLinkMenu(ctx.app, ctx.schema, view, el);
      return;
    }
    if (def.id === "clear-formatting") {
      clearFormatting(view, ctx.schema);
      window.setTimeout(() => view.focus(), 0);
      return;
    }
    if (def.id === "table") {
      const picker = createTablePicker(ctx.schema, view, ctx.closePopover);
      ctx.setPopover(picker, el);
      // Move focus to the grid so arrow-key + Enter work without
      // requiring a click first. RAF so the popup is in the DOM by
      // the time .focus() fires.
      window.requestAnimationFrame(() => picker.focus());
      return;
    }
    if (def.id === "text-color") {
      const palette = createColorPalette(
        ctx.schema,
        view,
        "text",
        ctx.closePopover,
      );
      ctx.setPopover(palette, el);
      return;
    }

    // Highlight does double-duty when HTML formatting is on: the
    // click toggles `==text==` AND opens the color swatch popover so
    // the user can refine to a custom colour without a second click.
    // On toggle-OFF (the click is removing a highlight already in the
    // selection) we skip the popover - opening swatches right after
    // the user cleared a highlight would be noise.
    if (def.id === "highlight") {
      const highlightMark = ctx.schema.marks.highlight;
      const wasActive = highlightMark
        ? isMarkActive(view.state, highlightMark)
        : false;
      execMarkCmd(def, ctx.schema, view);
      if (!wasActive && htmlOk) {
        const palette = createColorPalette(
          ctx.schema,
          view,
          "highlight",
          ctx.closePopover,
        );
        ctx.setPopover(palette, el);
      }
      window.setTimeout(() => view.focus(), 0);
      return;
    }

    if (def.kind === "mark") execMarkCmd(def, ctx.schema, view);
    else if (def.kind === "block") execBlockCmd(def, ctx.schema, view);
    else if (def.kind === "list") execListCmd(def, ctx.schema, view);
    else if (def.kind === "insert") execInsertCmd(def, ctx.schema, view, ctx.app);
    else if (def.kind === "heading") setHeading(ctx.schema, view, def.headingLevel ?? 0);
    else if (def.kind === "history") execHistoryCmd(def, view);

    window.setTimeout(() => view.focus(), 0);
  });

  return el;
}

function renderSubmenuButton(
  item: Extract<LayoutItem, { type: "submenu" }>,
  ctx: RenderCtx,
): HTMLElement {
  const el = activeDocument.createElement("button");
  el.classList.add("butter-btn", "clickable-icon", "butter-btn-submenu");
  el.setAttribute("aria-label", item.label || "Submenu");
  el.setAttribute("aria-haspopup", "menu");
  el.setAttribute("aria-expanded", "false");
  el.dataset.submenuId = item.id;
  setIcon(el, item.icon || "more-horizontal");
  // Indicator dot
  const dot = activeDocument.createElement("span");
  dot.classList.add("butter-submenu-dot");
  el.appendChild(dot);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.closePopover();

    const popup = activeDocument.createElement("div");
    popup.classList.add("butter-toolbar-submenu-popup");
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-label", item.label || "Submenu");

    for (const child of item.children) {
      const childEl = renderItem(child, ctx, /* nested */ true);
      if (childEl) {
        childEl.setAttribute("role", "menuitem");
        popup.appendChild(childEl);
      }
    }
    if (popup.children.length === 0) {
      const empty = activeDocument.createElement("div");
      empty.classList.add("butter-toolbar-submenu-empty");
      empty.textContent = "Empty";
      popup.appendChild(empty);
    }
    el.setAttribute("aria-expanded", "true");
    ctx.setPopover(popup, el, { closeOnLeave: true });

    // Focus the first menuitem so keyboard users can immediately
    // arrow-navigate the submenu without having to click first.
    window.requestAnimationFrame(() => {
      const first = popup.querySelector<HTMLElement>(
        '[role="menuitem"]',
      );
      first?.focus();
    });
  });

  return el;
}

/** Install roving-tabindex + arrow-key navigation on a toolbar
 *  container. Only one focusable button has tabindex=0 at any time;
 *  the rest are tabindex=-1 (still focusable programmatically /
 *  via arrow keys, but skipped by Tab). Arrow keys move focus
 *  across visible buttons; Home/End jump to the ends. Hidden
 *  buttons (display:none) are skipped during navigation. */
function installRovingTabindex(toolbar: HTMLElement): void {
  const getFocusable = (): HTMLElement[] => {
    const all = Array.from(
      toolbar.querySelectorAll<HTMLElement>(".butter-btn"),
    );
    return all.filter((el) => el.offsetParent !== null);
  };

  // Initial state: first focusable button is the tab-stop.
  const focusables = getFocusable();
  for (let i = 0; i < focusables.length; i++) {
    focusables[i].tabIndex = i === 0 ? 0 : -1;
  }

  // On focus inside the toolbar, sync the roving index so Tab returns
  // to whichever button the user last focused.
  toolbar.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("butter-btn")) return;
    for (const btn of getFocusable()) {
      btn.tabIndex = btn === target ? 0 : -1;
    }
  });

  toolbar.addEventListener("keydown", (e: KeyboardEvent) => {
    if (
      e.key !== "ArrowLeft" &&
      e.key !== "ArrowRight" &&
      e.key !== "Home" &&
      e.key !== "End"
    )
      return;
    const list = getFocusable();
    if (list.length === 0) return;
    const current = activeDocument.activeElement as HTMLElement | null;
    let idx = current ? list.indexOf(current) : -1;
    if (idx === -1) idx = 0;
    let next = idx;
    if (e.key === "ArrowLeft") next = (idx - 1 + list.length) % list.length;
    else if (e.key === "ArrowRight") next = (idx + 1) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next === idx) return;
    e.preventDefault();
    list[next].focus();
  });
}

function renderItem(
  item: LayoutItem,
  ctx: RenderCtx,
  nested = false,
): HTMLElement | null {
  if (item.type === "separator") return makeSep();
  if (item.type === "submenu") {
    // Single-level nesting cap: a submenu inside a submenu just
    // flattens to render its children inline (avoids stacked popups).
    if (nested) return null;
    return renderSubmenuButton(item, ctx);
  }
  return renderRegularButton(item.id, ctx);
}

// ── State update ──

function updateActiveStates(
  buttonMap: Map<string, HTMLElement>,
  schema: Schema,
  view: EditorView,
) {
  const { state } = view;
  const activeHeading = getActiveHeadingLevel(state, schema);

  for (const btn of ALL_BUTTONS) {
    const el = buttonMap.get(btn.id);
    if (!el) continue;

    let active = false;
    if (btn.kind === "mark" && btn.markName) {
      const mt = schema.marks[btn.markName];
      if (mt) active = isMarkActive(state, mt);
    } else if ((btn.kind === "block" || btn.kind === "list") && btn.nodeName) {
      if (btn.nodeName === "bullet_list" || btn.nodeName === "ordered_list" || btn.nodeName === "task_list") {
        const nt = schema.nodes["list_item"];
        if (nt) {
          const kind = btn.nodeName === "ordered_list" ? "ordered" : btn.nodeName === "task_list" ? "task" : "bullet";
          active = isBlockActive(state, nt, { kind });
        }
      } else {
        const nt = schema.nodes[btn.nodeName];
        if (nt) active = isBlockActive(state, nt, btn.attrs);
      }
    } else if (btn.kind === "heading") {
      active = (btn.headingLevel ?? 0) === activeHeading;
    } else if (btn.kind === "history") {
      // Disable when there's nothing to undo / redo so the buttons
      // visually lose their click affordance instead of inviting a
      // dead click. `undoDepth` / `redoDepth` come from
      // `prosemirror-history` and reflect the live history stack.
      const depthRaw: unknown =
        btn.historyDir === "redo" ? redoDepth(state) : undoDepth(state);
      const enabled = typeof depthRaw === "number" && depthRaw > 0;
      el.classList.toggle("is-disabled", !enabled);
      (el as HTMLButtonElement).disabled = !enabled;
    }
    el.classList.toggle("is-active", active);
  }
}

// ── Factory ──

const toolbarPluginKey = new PluginKey("butter-toolbar");

export function createToolbar(
  app: App,
  schema: Schema,
  getLayout: () => Layout,
  getMobileStyle: () => "detached" | "attached" = () => "attached",
  serializeNode?: (node: import("prosemirror-model").Node) => string,
): { dom: HTMLElement; plugin: Plugin; rebuild: () => void } {
  const buttonMap = new Map<string, HTMLElement>();
  const isMobile = Platform.isMobile ?? false;

  let editorViewRef: EditorView | null = null;
  let activePopover: HTMLElement | null = null;
  let activePopoverAnchor: HTMLElement | null = null;
  let popoverCleanup: (() => void) | null = null;

  const closePopover = () => {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    if (activePopoverAnchor) {
      // Reset aria-expanded so screen readers no longer announce the
      // submenu button as expanded once its popup is gone.
      if (activePopoverAnchor.hasAttribute("aria-expanded")) {
        activePopoverAnchor.setAttribute("aria-expanded", "false");
      }
      activePopoverAnchor = null;
    }
    if (popoverCleanup) {
      popoverCleanup();
      popoverCleanup = null;
    }
  };

  const setPopover = (
    popup: HTMLElement,
    anchor: HTMLElement,
    options: { closeOnLeave?: boolean } = {},
  ) => {
    if (!popup.style.position && !popup.classList.contains("butter-pos-fixed")
      && !popup.classList.contains("butter-pos-fixed-popover")
      && !popup.classList.contains("butter-mobile-popup-placed")) {
      const rect = anchor.getBoundingClientRect();
      popup.addClass("butter-pos-fixed");
      popup.setCssProps({
        "--butter-pos-top": `${rect.bottom + 6}px`,
        "--butter-pos-left": `${rect.left}px`,
      });
    }
    activeDocument.body.appendChild(popup);
    activePopover = popup;
    activePopoverAnchor = anchor;

    const downHandler = (ev: MouseEvent) => {
      if (!popup.contains(ev.target as Node) && ev.target !== anchor) {
        closePopover();
      }
    };
    window.setTimeout(() => activeDocument.addEventListener("mousedown", downHandler), 0);

    let moveHandler: ((ev: MouseEvent) => void) | null = null;
    if (options.closeOnLeave) {
      // Forgiving hit-area: extend the popup + anchor combined
      // bounds outward by `BUFFER_PX`. The cursor has to leave that
      // entire region before the popup dismisses, so brief over-
      // shoots when reaching for a button at the edge don't kill
      // the popup. The combined bounds also cover the gap between
      // anchor and popup so dragging across it doesn't trigger
      // close. Activation is delayed slightly so the popup doesn't
      // immediately close if the cursor was already past the edge
      // when the click landed.
      const BUFFER_PX = 32;
      moveHandler = (ev: MouseEvent) => {
        const pRect = popup.getBoundingClientRect();
        const aRect = anchor.getBoundingClientRect();
        const inside =
          ev.clientX >= Math.min(pRect.left, aRect.left) - BUFFER_PX &&
          ev.clientX <= Math.max(pRect.right, aRect.right) + BUFFER_PX &&
          ev.clientY >= Math.min(pRect.top, aRect.top) - BUFFER_PX &&
          ev.clientY <= Math.max(pRect.bottom, aRect.bottom) + BUFFER_PX;
        if (!inside) closePopover();
      };
      window.setTimeout(
        () => activeDocument.addEventListener("mousemove", moveHandler!),
        120,
      );
    }

    popoverCleanup = () => {
      activeDocument.removeEventListener("mousedown", downHandler);
      if (moveHandler) activeDocument.removeEventListener("mousemove", moveHandler);
    };
  };

  const ctx: RenderCtx = {
    app,
    schema,
    buttonMap,
    getView: () => editorViewRef,
    getLayout,
    closePopover,
    setPopover,
    serializeNode,
  };

  // Outer wrapper is stable - rebuilds replace its children only.
  // This way main.ts's `this.toolbarDom` reference stays valid.
  const dom = activeDocument.createElement("div");

  const renderDesktop = () => {
    closePopover();
    dom.innerHTML = "";
    buttonMap.clear();
    dom.classList.add("butter-toolbar");
    dom.setAttribute("role", "toolbar");
    dom.setAttribute("data-active-style", "filled");
    dom.setAttribute("data-bg", "chrome");
    dom.setAttribute("data-grouping", "separators");
    for (const item of getLayout()) {
      const el = renderItem(item, ctx);
      if (el) dom.appendChild(el);
    }
    installRovingTabindex(dom);
  };

  const render = isMobile
    ? () => renderMobile(dom, ctx, getMobileStyle, getLayout)
    : renderDesktop;
  render();

  if (isMobile) installMobileLongPress(dom, app);

  // Re-apply active states after a rebuild (the buttons are new DOM
  // nodes, so the previous .is-active classes are gone).
  const rebuild = () => {
    render();
    if (editorViewRef) updateActiveStates(buttonMap, schema, editorViewRef);
  };

  // Prevent toolbar from stealing focus on mousedown
  dom.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".butter-link-popover")) return;
    e.preventDefault();
  });

  const plugin = new Plugin({
    key: toolbarPluginKey,
    view(editorView) {
      editorViewRef = editorView;
      updateActiveStates(buttonMap, schema, editorView);

      return {
        update(view, prevState) {
          if (
            view.state.selection.eq(prevState.selection) &&
            view.state.storedMarks === prevState.storedMarks &&
            view.state.doc.eq(prevState.doc)
          )
            return;
          updateActiveStates(buttonMap, schema, view);
        },
        destroy() {
          closePopover();
          if (isMobile && dom.parentNode) dom.remove();
        },
      };
    },
  });

  return { dom, plugin, rebuild };
}

/** Toggle the visibility of buttons on a toolbar dom by id. Buttons
 *  are tagged with `data-btn-id` at construction; this helper sets
 *  `display: none` on any whose id is in the hidden set, restores
 *  default display for the rest. Kept for the migration path
 *  the layout-driven toolbar handles visibility by including or
 *  omitting items, not by toggling display. */
export function applyButtonVisibility(
  toolbarDom: HTMLElement,
  hiddenIds: Set<string>,
): void {
  toolbarDom.querySelectorAll<HTMLElement>("[data-btn-id]").forEach((el) => {
    const id = el.dataset.btnId!;
    el.style.display = hiddenIds.has(id) ? "none" : "";
  });
}
