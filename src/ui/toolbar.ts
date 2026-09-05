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
import { App, FuzzySuggestModal, Modal, Notice, Platform, TFile, setIcon } from "obsidian";
import {
  Plugin,
  PluginKey,
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
  commandActionIcon,
  commandActionLabel,
  executeObsidianCommand,
  isObsidianCommandAvailable,
  type CommandLayoutItem,
} from "./command-actions";
import {
  insertCallout,
} from "./slash-menu";
import { openUnifiedLinkEditor } from "./link-editor";
import { tx, txKnown, tv, type MessageKey } from "../i18n";
import {
  cleanupMobileToolbarOverflowIndicators,
  renderMobile,
  installMobileLongPress,
} from "./toolbar-mobile";
import {
  animateDrawerHeightFromPrevious,
  closeMobileInsertDrawer,
  installDrawerDismissGestures,
  prepareMobileDrawerOpen,
  setMobileDrawerCleanup,
} from "./insert-drawer";
import { bindFixedPopoverToAnchor } from "../util/floating-surface";
import {
  attachSurfaceMotion,
  dismissSurfaceWithMotion,
} from "./surface-motion";
import {
  shiftSelectedListItemDepth,
} from "../editor/list-operations";
import {
  setFlatListKindAtPositions,
  toggleFlatListKind,
} from "../editor/flat-list-editing";
import { getMultiBlockSelection } from "../editor/multi-block-select";
import { saveBlobAsAttachment } from "../editor/paste-drop";
import {
  clearFormatting,
} from "../editor/formatting-actions";
export { clearFormatting, insertMarkdownLink } from "../editor/formatting-actions";

// ── Button definitions ──

export interface BtnDef {
  id: string;
  icon: string;
  label: MessageKey;
  kbd?: string;
  kind: "mark" | "block" | "list" | "list-depth" | "insert" | "heading" | "history";
  markName?: string;
  nodeName?: string;
  attrs?: Record<string, unknown>;
  /** For kind=heading: 0 = paragraph, 1-6 = heading level. */
  headingLevel?: number;
  /** For kind=history: which direction. */
  historyDir?: "undo" | "redo";
  depthDelta?: 1 | -1;
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
    // style="background: …">…</mark>`. When HTML formatting is
    // off (Editor → Formatting), only the main face renders so the
    // user can't author HTML inline. See renderRegularButton.
    { id: "highlight",     icon: "highlighter",   label: "Highlight",     kbd: "Ctrl+Shift+H", kind: "mark" as const, markName: "highlight" },
    { id: "text-color",    icon: "palette",       label: "Text color",    kind: "mark" as const, markName: "font" },
    { id: "link",          icon: "link",          label: "Link",          kbd: "Ctrl+K", kind: "mark" as const, markName: "link" },
    { id: "clear-formatting", icon: "eraser",     label: "Clear formatting", kind: "insert" as const },
  ],
  block: [
    { id: "bullet-list",   icon: "list",          label: "Bullet list",   kind: "list" as const, nodeName: "bullet_list" },
    { id: "ordered-list",  icon: "list-ordered",  label: "Ordered list",  kind: "list" as const, nodeName: "ordered_list" },
    { id: "task-list",     icon: "list-checks",   label: "Task list",     kind: "list" as const, nodeName: "task_list" },
    { id: "indent-list",   icon: "indent-increase", label: "Indent list item", kind: "list-depth" as const, depthDelta: 1 as const },
    { id: "outdent-list",  icon: "indent-decrease", label: "Outdent list item", kind: "list-depth" as const, depthDelta: -1 as const },
    { id: "blockquote",    icon: "quote",         label: "Blockquote",    kbd: "Ctrl+Shift+B", kind: "block" as const, nodeName: "blockquote" },
    { id: "code-block",    icon: "file-code",     label: "Code block",    kind: "block" as const, nodeName: "code_block" },
    { id: "hr",            icon: "minus",         label: "Horizontal rule", kind: "insert" as const, nodeName: "horizontal_rule" },
  ],
  insert: [
    { id: "table", icon: "table", label: "Insert table", kind: "insert" as const, nodeName: "table" },
    { id: "image", icon: "image", label: "Insert image", kind: "insert" as const, nodeName: "image" },
    { id: "video", icon: "video", label: "Insert video", kind: "insert" as const, nodeName: "video" },
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
} satisfies Record<string, BtnDef[]>;

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
  label: MessageKey;
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
  const multi = getMultiBlockSelection(view.state);
  if (
    multi.positions.length >= 2 &&
    setFlatListKindAtPositions(
      view.state,
      view.dispatch.bind(view),
      multi.positions,
      kind,
    )
  ) return;
  toggleFlatListKind(view.state, view.dispatch.bind(view), kind);
}

export function execListDepthCmd(btn: BtnDef, view: EditorView) {
  if (btn.depthDelta === 1 || btn.depthDelta === -1) {
    shiftSelectedListItemDepth(view, btn.depthDelta);
  }
}

export function execInsertCmd(
  btn: BtnDef,
  schema: Schema,
  view: EditorView,
  app: App,
  getSourcePath: () => string = () => "",
) {
  if (btn.nodeName === "horizontal_rule") {
    view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()));
  } else if (btn.nodeName === "image") {
    new ImageInsertModal(
      app,
      (file) => void insertPickedAttachment(app, schema, view, file, getSourcePath(), "image"),
      (src) => {
        view.dispatch(
          view.state.tr.replaceSelectionWith(
            schema.nodes.image.create({ src, alt: "" }),
          ),
        );
      },
    ).open();
  } else if (btn.nodeName === "video") {
    new AttachmentInsertModal(
      app,
      "Insert video",
      "video/*",
      (file) => void insertPickedAttachment(app, schema, view, file, getSourcePath(), "video"),
    ).open();
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
    this.setPlaceholder(tx("Pick a .base file to embed..."));
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

/** Desktop image insertion dialog: save a picked local image through
 * Obsidian's attachment policy, with a URL insertion fallback. */
class ImageInsertModal extends Modal {
  constructor(
    app: App,
    private readonly onFile: (file: File) => void,
    private readonly onUrl: (src: string) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(tx("Insert image"));
    const wrap = contentEl.createDiv({ cls: "butter-image-insert-options" });
    const pickBtn = wrap.createEl("button", {
      cls: "butter-image-file-option mod-cta",
      text: tx("Pick from device"),
    });
    pickBtn.addEventListener("click", () => {
      const picker = activeWindow.createEl("input");
      picker.type = "file";
      picker.accept = "image/*";
      picker.addClass("butter-image-file-input");
      picker.addEventListener("change", () => {
        const file = picker.files?.[0];
        if (!file) return;
        this.close();
        this.onFile(file);
      }, { once: true });
      activeDocument.body.appendChild(picker);
      picker.click();
      window.setTimeout(() => picker.remove(), 60_000);
    });

    const urlWrap = wrap.createDiv({ cls: "butter-image-url-modal" });
    urlWrap.createDiv({ cls: "butter-image-url-label", text: tx("Image URL") });
    const input = urlWrap.createEl("input", {
      type: "text",
      placeholder: "https://...",
      cls: "butter-image-url-input",
    });
    input.focus();
    const actions = urlWrap.createDiv({ cls: "butter-image-url-actions" });
    const cancelBtn = actions.createEl("button", { text: tx("Cancel") });
    const okBtn = actions.createEl("button", { text: tx("Insert"), cls: "mod-cta" });
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.close();
      this.onUrl(value);
    };
    okBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** File-only attachment picker used for media that is represented by a
 * native Obsidian embed rather than a Butter-specific node. */
class AttachmentInsertModal extends Modal {
  constructor(
    app: App,
    private readonly title: MessageKey,
    private readonly accept: string,
    private readonly onFile: (file: File) => void,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(tx(this.title));
    const pickBtn = this.contentEl.createEl("button", {
      cls: "butter-image-file-option mod-cta",
      text: tx("Pick from device"),
    });
    pickBtn.addEventListener("click", () => {
      const picker = activeWindow.createEl("input");
      picker.type = "file";
      picker.accept = this.accept;
      picker.addClass("butter-image-file-input");
      picker.addEventListener("change", () => {
        const file = picker.files?.[0];
        if (!file) return;
        this.close();
        this.onFile(file);
      }, { once: true });
      activeDocument.body.appendChild(picker);
      picker.click();
      window.setTimeout(() => picker.remove(), 60_000);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export async function insertPickedAttachment(
  app: App,
  schema: Schema,
  view: EditorView,
  file: File,
  sourcePath: string,
  kind: "image" | "video" = "image",
): Promise<void> {
  let saved: TFile | null = null;
  let inserted = false;
  try {
    saved = await saveBlobAsAttachment(
      app,
      file,
      file.name,
      sourcePath,
      true,
    );
    if (!saved) return;
    if (view.isDestroyed) {
      if (app.vault.getAbstractFileByPath(saved.path) === saved) {
        await app.fileManager.trashFile(saved);
      }
      return;
    }

    const { selection } = view.state;
    const { $from } = selection;
    const blockEmbed = schema.nodes.obsidian_embed;
    const inlineEmbed = schema.nodes.obsidian_embed_inline;
    if (
      blockEmbed &&
      selection.empty &&
      $from.depth === 1 &&
      $from.parent.type.name === "paragraph" &&
      $from.parent.content.size === 0
    ) {
      view.dispatch(
        view.state.tr.replaceWith(
          $from.before(),
          $from.after(),
          blockEmbed.create({ src: saved.path }),
        ),
      );
      inserted = true;
    } else if (inlineEmbed) {
      view.dispatch(
        view.state.tr.replaceSelectionWith(
          inlineEmbed.create({ src: saved.path }),
        ),
      );
      inserted = true;
    } else if (kind === "image") {
      view.dispatch(
        view.state.tr.replaceSelectionWith(
          schema.nodes.image.create({ src: saved.path, alt: "" }),
        ),
      );
      inserted = true;
    } else {
      throw new Error("This editor schema cannot insert native attachment embeds.");
    }
    view.focus();
  } catch (error) {
    if (
      saved &&
      !inserted &&
      app.vault.getAbstractFileByPath(saved.path) === saved
    ) {
      try {
        await app.fileManager.trashFile(saved);
      } catch {
        // The original insertion error is the actionable failure. Attachment
        // cleanup is best-effort and must not hide it behind a second notice.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const prefix = kind === "video" ? tx("Failed to save video:") : tx("Failed to save image:");
    new Notice(`${prefix} ${message}`);
  }
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
export type LinkTarget =
  | { kind: "external"; target: string }
  | { kind: "wikilink"; target: string; alias?: string };

export function classifyLinkInput(raw: string): LinkTarget | null {
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
export function applyLink(
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
  const picker = activeWindow.createDiv();
  picker.classList.add("butter-table-picker");
  // Treat the picker itself as the focusable + ARIA-named region so
  // keyboard users can arrow-navigate the grid as a single widget,
  // matching the mouse-hover sizing affordance. Tabindex=0 lets the
  // popover receive focus when setPopover anchors it.
  picker.setAttribute("role", "grid");
  picker.setAttribute("aria-label", tx("Pick table size"));
  picker.tabIndex = 0;

  const grid = activeWindow.createDiv();
  grid.classList.add("grid");
  picker.appendChild(grid);

  const label = activeWindow.createDiv();
  label.classList.add("label");
  label.textContent = tx("Hover or arrow-key to size");
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
      const cr = parseInt(cell.getAttribute("data-r") ?? "-1");
      const cc = parseInt(cell.getAttribute("data-c") ?? "-1");
      cell.classList.toggle("is-hot", cr <= r && cc <= c);
    });
    label.textContent =
      r >= 0 ? `${r + 1} × ${c + 1} ${tx("table")}` : tx("Hover or arrow-key to size");
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = activeWindow.createDiv();
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
const TEXT_SWATCHES: ReadonlyArray<{ name: MessageKey; value: string }> = [
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
const HIGHLIGHT_SWATCHES: ReadonlyArray<{ name: MessageKey; value: string }> = [
  { name: "Yellow",  value: "rgba(255, 234, 0, 0.4)" },
  { name: "Orange",  value: "rgba(255, 140, 0, 0.4)" },
  { name: "Red",     value: "rgba(255, 80, 80, 0.4)" },
  { name: "Pink",    value: "rgba(255, 105, 180, 0.4)" },
  { name: "Purple",  value: "rgba(170, 110, 255, 0.4)" },
  { name: "Blue",    value: "rgba(70, 160, 255, 0.4)" },
  { name: "Teal",    value: "rgba(40, 200, 200, 0.4)" },
  { name: "Green",   value: "rgba(80, 200, 80, 0.4)" },
  { name: "Gray",    value: "rgba(140, 140, 140, 0.4)" },
];

const TEXT_PALETTE_PRESETS = ["Red", "Orange", "Green", "Blue", "Purple"] as const;
const HIGHLIGHT_PALETTE_PRESETS = ["Yellow", "Orange", "Green", "Blue", "Gray"] as const;

type ColorKind = "text" | "highlight";
type RGBColor = { r: number; g: number; b: number };
type RGBAColor = RGBColor & { a: number };
type HSVColor = { h: number; s: number; v: number };

type ColorSnapshot =
  | {
      empty: true;
      marks: readonly import("prosemirror-model").Mark[] | null;
    }
  | {
      empty: false;
      from: number;
      to: number;
      ranges: Array<{
        from: number;
        to: number;
        attrs: Record<string, unknown>;
      }>;
    };

type ColorPaletteElement = HTMLElement & {
  butterColorCleanup?: () => void;
};

type ToolbarPopoverElement = HTMLElement & {
  butterPopoverCleanup?: () => void;
};

const DEFAULT_TEXT_CUSTOM_COLOR = "#e03131";
const DEFAULT_HIGHLIGHT_CUSTOM_COLOR = "#fff3bf";
const CUSTOM_HIGHLIGHT_ALPHA = 0.4;

function runColorPaletteCleanup(el: HTMLElement): void {
  const cleanup = (el as ColorPaletteElement).butterColorCleanup;
  if (!cleanup) return;
  delete (el as ColorPaletteElement).butterColorCleanup;
  cleanup();
}

function runToolbarPopoverCleanup(el: HTMLElement): void {
  runColorPaletteCleanup(el);
  const cleanup = (el as ToolbarPopoverElement).butterPopoverCleanup;
  if (!cleanup) return;
  delete (el as ToolbarPopoverElement).butterPopoverCleanup;
  cleanup();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function hsvToRgb(hsv: HSVColor): RGBColor {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = clamp(hsv.s, 0, 1);
  const v = clamp(hsv.v, 0, 1);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rp = 0, gp = 0, bp = 0;
  if (h < 60) {
    rp = c; gp = x;
  } else if (h < 120) {
    rp = x; gp = c;
  } else if (h < 180) {
    gp = c; bp = x;
  } else if (h < 240) {
    gp = x; bp = c;
  } else if (h < 300) {
    rp = x; bp = c;
  } else {
    rp = c; bp = x;
  }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

function rgbToHsv(rgb: RGBColor): HSVColor {
  const r = clamp(rgb.r, 0, 255) / 255;
  const g = clamp(rgb.g, 0, 255) / 255;
  const b = clamp(rgb.b, 0, 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return {
    h,
    s: max === 0 ? 0 : d / max,
    v: max,
  };
}

function rgbToHex(rgb: RGBColor): string {
  const channel = (n: number) =>
    clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

function hexToRgb(raw: string): RGBColor | null {
  const value = raw.trim();
  const short = value.match(/^#?([0-9a-f]{3})$/i);
  if (short) {
    const [r, g, b] = short[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  const full = value.match(/^#?([0-9a-f]{6})$/i);
  if (!full) return null;
  const hex = full[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function parseCssColor(raw: unknown): RGBAColor | null {
  if (typeof raw !== "string") return null;
  const fromHex = hexToRgb(raw);
  if (fromHex) return { ...fromHex, a: 1 };
  const rgb = raw.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d?(?:\.\d+)?))?\s*\)$/i,
  );
  if (!rgb) return null;
  return {
    r: clamp(Math.round(Number(rgb[1])), 0, 255),
    g: clamp(Math.round(Number(rgb[2])), 0, 255),
    b: clamp(Math.round(Number(rgb[3])), 0, 255),
    a: rgb[4] == null ? 1 : clamp(Number(rgb[4]), 0, 1),
  };
}

function formatAlpha(alpha: number): string {
  return String(Math.round(clamp(alpha, 0, 1) * 100) / 100);
}

function formatPickedColor(kind: ColorKind, rgb: RGBColor, alpha = CUSTOM_HIGHLIGHT_ALPHA): string {
  if (kind === "text") return rgbToHex(rgb);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${formatAlpha(alpha)})`;
}

/** Normalize any CSS colour string Butter understands to #rrggbb (drops
 *  alpha). Falls back to black when unparseable. Used by the settings
 *  preset-colour pickers, which are hex-only. */
export function colorToHex(value: string): string {
  const parsed = parseCssColor(value);
  return parsed ? rgbToHex({ r: parsed.r, g: parsed.g, b: parsed.b }) : "#000000";
}

/** Convert a #rrggbb hex (from a settings colour picker) into Butter's
 *  highlight value: translucent rgba so the underlying text stays
 *  legible, matching the built-in highlight swatches. */
export function toHighlightValue(hex: string): string {
  const parsed = parseCssColor(hex);
  const rgb = parsed
    ? { r: parsed.r, g: parsed.g, b: parsed.b }
    : { r: 0, g: 0, b: 0 };
  return formatPickedColor("highlight", rgb, CUSTOM_HIGHLIGHT_ALPHA);
}

type PresetColorsProvider = (kind: ColorKind) => readonly string[] | null | undefined;
let presetColorsProvider: PresetColorsProvider | null = null;

/** Lets the plugin feed user-customized preset colours into the shared
 *  desktop palette + mobile picker without this layer importing the
 *  plugin module. Registered from main.ts once settings have loaded. */
export function setPresetColorsProvider(provider: PresetColorsProvider | null): void {
  presetColorsProvider = provider;
}

/** Display name for a preset swatch: reuse a built-in colour's name when
 *  the value matches one, otherwise a positional label. Used only for
 *  the swatch's accessible label / tooltip. */
function presetName(kind: ColorKind, value: string, index: number): string {
  const swatches = kind === "text" ? TEXT_SWATCHES : HIGHLIGHT_SWATCHES;
  const known = swatches.find((swatch) => colorsEquivalent(swatch.value, value));
  return known ? tx(known.name) : tv("Color {number}", { number: index + 1 });
}

function palettePresets(kind: ColorKind): ReadonlyArray<{ name: string; value: string }> {
  // User-customized presets (from settings) take precedence; fall back
  // to the built-in five when no provider is registered (e.g. tests).
  const custom = presetColorsProvider?.(kind);
  if (custom && custom.length > 0) {
    return custom.map((value, i) => ({ name: presetName(kind, value, i), value }));
  }
  const swatches = kind === "text" ? TEXT_SWATCHES : HIGHLIGHT_SWATCHES;
  const names = kind === "text" ? TEXT_PALETTE_PRESETS : HIGHLIGHT_PALETTE_PRESETS;
  return names
    .map((name) => swatches.find((swatch) => swatch.name === name))
    .filter((swatch): swatch is { name: MessageKey; value: string } => Boolean(swatch))
    .map((swatch) => ({ name: tx(swatch.name), value: swatch.value }));
}

function colorsEquivalent(a: unknown, b: unknown): boolean {
  const ca = parseCssColor(a);
  const cb = parseCssColor(b);
  if (!ca || !cb) return false;
  return (
    ca.r === cb.r &&
    ca.g === cb.g &&
    ca.b === cb.b &&
    Math.abs(ca.a - cb.a) < 0.01
  );
}

function colorMarkName(kind: ColorKind): "font" | "highlight" {
  return kind === "text" ? "font" : "highlight";
}

function colorAttr(attrs: unknown): string | null {
  if (!attrs || typeof attrs !== "object") return null;
  const color = (attrs as { color?: unknown }).color;
  return typeof color === "string" ? color : null;
}

function captureColorSnapshot(
  schema: Schema,
  view: EditorView,
  kind: ColorKind,
): ColorSnapshot {
  const markType = schema.marks[colorMarkName(kind)];
  const { from, to, empty, $from } = view.state.selection;
  if (empty) {
    return {
      empty: true,
      marks: view.state.storedMarks ?? $from.marks(),
    };
  }
  const ranges: Array<{ from: number; to: number; attrs: Record<string, unknown> }> = [];
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const mark = markType?.isInSet(node.marks);
    if (!mark) return;
    ranges.push({
      from: Math.max(from, pos),
      to: Math.min(to, pos + node.nodeSize),
      attrs: { ...mark.attrs },
    });
  });
  return { empty: false, from, to, ranges };
}

function snapshotFirstColor(snapshot: ColorSnapshot, kind: ColorKind): string | null {
  if (snapshot.empty) {
    const mark = snapshot.marks?.find((m) => m.type.name === colorMarkName(kind));
    return colorAttr(mark?.attrs);
  }
  for (const range of snapshot.ranges) {
    const color = range.attrs.color;
    if (typeof color === "string") return color;
  }
  return null;
}

function restoreColorSnapshot(
  schema: Schema,
  view: EditorView,
  kind: ColorKind,
  snapshot: ColorSnapshot,
  options: { addToHistory?: boolean; refocusEditor?: boolean } = {},
): void {
  const markType = schema.marks[colorMarkName(kind)];
  if (!markType) return;
  const tr = view.state.tr;
  if (snapshot.empty) {
    tr.setStoredMarks(snapshot.marks ? [...snapshot.marks] : null);
  } else {
    tr.removeMark(snapshot.from, snapshot.to, markType);
    for (const range of snapshot.ranges) {
      tr.addMark(range.from, range.to, markType.create(range.attrs));
    }
  }
  if (options.addToHistory === false) tr.setMeta("addToHistory", false);
  view.dispatch(tr);
  if (options.refocusEditor ?? true) view.focus();
}

/** Apply a `font` mark with the given color (or clear when color is
 *  null) to the current selection. When the selection is empty, sets
 *  storedMarks so the color applies to the next-typed text. */
function applyTextColor(
  schema: Schema,
  view: EditorView,
  color: string | null,
  options: { addToHistory?: boolean; refocusEditor?: boolean } = {},
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
  if (options.addToHistory === false) tr.setMeta("addToHistory", false);
  view.dispatch(tr);
  if (options.refocusEditor ?? true) view.focus();
}

/** Apply a `highlight` mark with the given background color (or
 *  clear when color is null). Empty selection sets storedMarks. */
function applyHighlightColor(
  schema: Schema,
  view: EditorView,
  color: string | null,
  options: { addToHistory?: boolean; refocusEditor?: boolean } = {},
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
  if (options.addToHistory === false) tr.setMeta("addToHistory", false);
  view.dispatch(tr);
  if (options.refocusEditor ?? true) view.focus();
}

/** Shared color surface seam for non-toolbar editor controls. */
export function toolbarColorChoices(
  kind: "text" | "highlight",
): ReadonlyArray<{ name: string; value: string }> {
  return palettePresets(kind);
}

export function applyToolbarColor(
  schema: Schema,
  view: EditorView,
  kind: "text" | "highlight",
  color: string | null,
): void {
  const apply = kind === "text" ? applyTextColor : applyHighlightColor;
  apply(schema, view, color);
}

/** Build a compact color palette popover with default/custom slots,
 *  five preset swatches, and a Butter-owned custom picker. */
function createColorPalette(
  schema: Schema,
  view: EditorView,
  kind: ColorKind,
  onClose: () => void,
  activeStyle: string = "filled",
): HTMLElement {
  const wrap = activeWindow.createDiv() as ColorPaletteElement;
  wrap.classList.add("butter-toolbar-submenu-popup", "butter-color-palette");
  wrap.dataset.kind = kind;
  wrap.dataset.activeStyle = activeStyle;

  const swatches = palettePresets(kind);
  const apply = kind === "text" ? applyTextColor : applyHighlightColor;
  const paletteSnapshot = captureColorSnapshot(schema, view, kind);
  const currentColor = snapshotFirstColor(paletteSnapshot, kind);
  const selectedPreset = swatches.find((sw) => colorsEquivalent(currentColor, sw.value));
  const currentIsCustom = Boolean(currentColor && !selectedPreset);
  let committed = false;

  const grid = activeWindow.createDiv();
  grid.classList.add("butter-color-grid");
  wrap.appendChild(grid);

  const makeCell = (label: string, title = label) => {
    const cell = activeWindow.createEl("button");
    cell.type = "button";
    cell.classList.add("butter-color-cell");
    cell.setAttribute("aria-label", label);
    cell.title = title;
    return cell;
  };

  const appendCheck = (cell: HTMLElement) => {
    const selected = activeWindow.createSpan();
    selected.classList.add("butter-color-cell-check");
    setIcon(selected, "check");
    cell.appendChild(selected);
  };

  const defaultBtn = makeCell(
    kind === "text" ? "Default color" : "No highlight",
    kind === "text" ? "Default color" : "No highlight",
  );
  defaultBtn.classList.add("butter-color-default");
  defaultBtn.classList.add("butter-btn", "clickable-icon");
  if (!currentColor) {
    defaultBtn.classList.add("is-active");
    defaultBtn.setAttribute("aria-current", "true");
  }
  setIcon(defaultBtn, "eraser");
  appendCheck(defaultBtn);
  defaultBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    committed = true;
    apply(schema, view, null);
    onClose();
  });
  grid.appendChild(defaultBtn);

  const customBtn = makeCell("Custom color", "Custom color");
  customBtn.classList.add("butter-color-custom");
  customBtn.classList.add("butter-btn", "clickable-icon");
  const customFill = activeWindow.createSpan();
  customFill.classList.add("butter-color-cell-fill");
  if (currentIsCustom && currentColor) {
    customFill.style.backgroundColor = currentColor;
    customBtn.classList.add("is-active");
    customBtn.setAttribute("aria-current", "true");
  } else {
    customBtn.classList.add("is-empty");
  }
  customBtn.appendChild(customFill);
  const customIcon = activeWindow.createSpan();
  customIcon.classList.add("butter-color-cell-icon");
  setIcon(customIcon, "pipette");
  customBtn.appendChild(customIcon);
  appendCheck(customBtn);
  grid.appendChild(customBtn);

  for (const sw of swatches) {
    const swatchName = sw.name;
    const cell = makeCell(swatchName);
    if (colorsEquivalent(currentColor, sw.value)) {
      cell.classList.add("is-selected");
      cell.setAttribute("aria-current", "true");
    }
    cell.setAttribute("aria-label", swatchName);
    cell.title = swatchName;
    const fill = activeWindow.createSpan();
    fill.classList.add("butter-color-cell-fill");
    fill.style.backgroundColor = sw.value;
    cell.appendChild(fill);
    appendCheck(cell);
    cell.addEventListener("mousedown", (e) => {
      e.preventDefault();
      committed = true;
      apply(schema, view, sw.value);
      onClose();
    });
    grid.appendChild(cell);
  }

  let customPicker: HTMLElement | null = null;
  let cleanupCustomPicker: (() => void) | null = null;

  customBtn.addEventListener("mousedown", (e) => e.preventDefault());
  customBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (customPicker) {
      customPicker.querySelector<HTMLInputElement>(".butter-color-hex-input")?.focus();
      return;
    }
    customBtn.classList.add("is-active");
    customBtn.setAttribute("aria-expanded", "true");
    const built = createCustomColorPicker({
      schema,
      view,
      kind,
      apply,
      initialSnapshot: paletteSnapshot,
      onCommit: () => {
        committed = true;
        onClose();
      },
      shouldRestoreOnCleanup: () => !committed,
    });
    customPicker = built.el;
    cleanupCustomPicker = built.cleanup;
    wrap.appendChild(customPicker);
    customPicker.querySelector<HTMLInputElement>(".butter-color-hex-input")?.focus();
  });

  wrap.butterColorCleanup = () => {
    if (cleanupCustomPicker) cleanupCustomPicker();
  };

  return wrap;
}

function createCustomColorPicker(args: {
  schema?: Schema;
  view?: EditorView;
  kind: ColorKind;
  apply?: typeof applyTextColor;
  initialSnapshot?: ColorSnapshot;
  initialColor?: string | null;
  onPreviewColor?: (color: string) => void;
  onCommitColor?: (color: string) => void;
  onRestoreColor?: () => void;
  onCommit: () => void;
  shouldRestoreOnCleanup: () => boolean;
}): { el: HTMLElement; cleanup: () => void } {
  const {
    schema,
    view,
    kind,
    apply,
    initialSnapshot,
    initialColor: initialColorArg,
    onPreviewColor,
    onCommitColor,
    onRestoreColor,
    onCommit,
    shouldRestoreOnCleanup,
  } = args;
  const editorMode = Boolean(schema && view && apply);
  const snapshot = editorMode && schema && view
    ? initialSnapshot ?? captureColorSnapshot(schema, view, kind)
    : null;
  const initialRawColor = initialColorArg ?? (snapshot ? snapshotFirstColor(snapshot, kind) : null);
  const defaultColor = kind === "text"
    ? DEFAULT_TEXT_CUSTOM_COLOR
    : DEFAULT_HIGHLIGHT_CUSTOM_COLOR;
  const initialColor =
    parseCssColor(initialRawColor) ??
    parseCssColor(defaultColor)!;
  const initialRgb: RGBColor = {
    r: initialColor.r,
    g: initialColor.g,
    b: initialColor.b,
  };
  let hsv = rgbToHsv(initialRgb);
  let rgb = initialRgb;
  const hasExplicitAlpha =
    typeof initialRawColor === "string" &&
    /^rgba\(/i.test(initialRawColor.trim());
  let alpha = kind === "highlight"
    ? (hasExplicitAlpha ? initialColor.a : CUSTOM_HIGHLIGHT_ALPHA)
    : 1;
  let restoredOrCommitted = false;

  const picker = activeWindow.createDiv();
  picker.classList.add("butter-color-custom-panel");

  const pickerHeader = activeWindow.createDiv();
  pickerHeader.classList.add("butter-color-custom-header");
  const pickerTitle = activeWindow.createSpan();
  pickerTitle.classList.add("butter-color-custom-title");
  pickerTitle.textContent = tx("Custom");
  pickerHeader.appendChild(pickerTitle);
  const pickerValue = activeWindow.createSpan();
  pickerValue.classList.add("butter-color-custom-value");
  pickerHeader.appendChild(pickerValue);
  picker.appendChild(pickerHeader);

  const sv = activeWindow.createDiv();
  sv.classList.add("butter-color-sv");
  sv.tabIndex = 0;
  sv.setAttribute("role", "slider");
  sv.setAttribute("aria-label", tx("Saturation and brightness"));
  const svThumb = activeWindow.createDiv();
  svThumb.classList.add("butter-color-sv-thumb");
  sv.appendChild(svThumb);
  picker.appendChild(sv);

  const hue = activeWindow.createDiv();
  hue.classList.add("butter-color-hue");
  hue.tabIndex = 0;
  hue.setAttribute("role", "slider");
  hue.setAttribute("aria-label", tx("Hue"));
  hue.setAttribute("aria-valuemin", "0");
  hue.setAttribute("aria-valuemax", "360");
  const hueThumb = activeWindow.createDiv();
  hueThumb.classList.add("butter-color-hue-thumb");
  hue.appendChild(hueThumb);
  picker.appendChild(hue);

  let alphaWrap: HTMLElement | null = null;
  let alphaSlider: HTMLInputElement | null = null;
  let alphaValue: HTMLElement | null = null;
  if (kind === "highlight") {
    alphaWrap = activeWindow.createEl("label");
    alphaWrap.classList.add("butter-color-alpha");
    const alphaLabel = activeWindow.createSpan();
    alphaLabel.classList.add("butter-color-alpha-label");
    alphaLabel.textContent = tx("Opacity");
    alphaWrap.appendChild(alphaLabel);

    alphaSlider = activeWindow.createEl("input");
    alphaSlider.type = "range";
    alphaSlider.min = "0.1";
    alphaSlider.max = "1";
    alphaSlider.step = "0.05";
    alphaSlider.value = String(alpha);
    alphaSlider.classList.add("butter-color-alpha-slider");
    alphaWrap.appendChild(alphaSlider);

    alphaValue = activeWindow.createSpan();
    alphaValue.classList.add("butter-color-alpha-value");
    alphaWrap.appendChild(alphaValue);
    picker.appendChild(alphaWrap);
  }

  const controls = activeWindow.createDiv();
  controls.classList.add("butter-color-custom-controls");
  picker.appendChild(controls);

  const preview = activeWindow.createDiv();
  preview.classList.add("butter-color-preview");
  preview.setAttribute("aria-hidden", "true");
  const previewFill = activeWindow.createDiv();
  previewFill.classList.add("butter-color-preview-fill");
  preview.appendChild(previewFill);
  controls.appendChild(preview);

  const hexInput = activeWindow.createEl("input");
  hexInput.type = "text";
  hexInput.classList.add("butter-color-hex-input");
  hexInput.spellcheck = false;
  hexInput.inputMode = "text";
  hexInput.setAttribute("aria-label", tx("Hex color"));
  controls.appendChild(hexInput);

  const actions = activeWindow.createDiv();
  actions.classList.add("butter-color-custom-actions");
  picker.appendChild(actions);

  const cancelBtn = activeWindow.createEl("button");
  cancelBtn.type = "button";
  cancelBtn.classList.add("butter-btn", "clickable-icon", "butter-color-control");
  cancelBtn.setAttribute("aria-label", tx("Cancel"));
  cancelBtn.title = tx("Cancel");
  setIcon(cancelBtn, "x");
  const cancelLabel = activeWindow.createSpan();
  cancelLabel.classList.add("butter-color-control-label");
  cancelLabel.textContent = tx("Cancel");
  cancelBtn.appendChild(cancelLabel);
  actions.appendChild(cancelBtn);

  const applyBtn = activeWindow.createEl("button");
  applyBtn.type = "button";
  applyBtn.classList.add("butter-btn", "clickable-icon", "butter-color-control", "is-active");
  applyBtn.setAttribute("aria-label", tx("Apply"));
  applyBtn.title = tx("Apply");
  setIcon(applyBtn, "check");
  const applyLabel = activeWindow.createSpan();
  applyLabel.classList.add("butter-color-control-label");
  applyLabel.textContent = tx("Apply");
  applyBtn.appendChild(applyLabel);
  actions.appendChild(applyBtn);

  let dirty = false;

  const setDirty = (next: boolean) => {
    dirty = next;
    applyBtn.disabled = !dirty;
    applyBtn.classList.toggle("is-disabled", !dirty);
  };

  const updateUi = () => {
    rgb = hsvToRgb(hsv);
    const hueRgb = hsvToRgb({ h: hsv.h, s: 1, v: 1 });
    const pickedColor = formatPickedColor(kind, rgb, alpha);
    picker.style.setProperty("--butter-picker-hue", rgbToHex(hueRgb));
    picker.style.setProperty("--butter-picker-s", `${hsv.s * 100}%`);
    picker.style.setProperty("--butter-picker-v", `${(1 - hsv.v) * 100}%`);
    picker.style.setProperty("--butter-picker-h", `${(hsv.h / 360) * 100}%`);
    picker.style.setProperty("--butter-picker-alpha", `${alpha * 100}%`);
    previewFill.style.backgroundColor = pickedColor;
    hexInput.value = rgbToHex(rgb);
    pickerValue.textContent = kind === "highlight"
      ? `${rgbToHex(rgb)} · ${Math.round(alpha * 100)}%`
      : rgbToHex(rgb);
    if (alphaSlider) {
      alphaSlider.value = String(alpha);
      alphaSlider.style.background = `linear-gradient(to right, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.1), rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1))`;
    }
    if (alphaValue) alphaValue.textContent = `${Math.round(alpha * 100)}%`;
    sv.setAttribute("aria-valuenow", String(Math.round(hsv.s * 100)));
    sv.setAttribute(
      "aria-valuetext",
      `${Math.round(hsv.s * 100)}% ${tx("saturation")}, ${Math.round(hsv.v * 100)}% ${tx("brightness")}`,
    );
    hue.setAttribute("aria-valuenow", String(Math.round(hsv.h)));
  };

  const previewColor = () => {
    const color = formatPickedColor(kind, rgb, alpha);
    if (editorMode && schema && view && apply) {
      apply(schema, view, color, {
        addToHistory: false,
        refocusEditor: false,
      });
    } else {
      onPreviewColor?.(color);
    }
    setDirty(true);
  };

  const setFromRgb = (next: RGBColor, previewEditor: boolean) => {
    rgb = next;
    hsv = rgbToHsv(next);
    updateUi();
    if (previewEditor) previewColor();
  };

  const updateSvFromPointer = (event: PointerEvent) => {
    const rect = sv.getBoundingClientRect();
    hsv = {
      ...hsv,
      s: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      v: 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
    updateUi();
    previewColor();
  };

  const updateHueFromPointer = (event: PointerEvent) => {
    const rect = hue.getBoundingClientRect();
    hsv = {
      ...hsv,
      h: clamp((event.clientX - rect.left) / rect.width, 0, 1) * 360,
    };
    updateUi();
    previewColor();
  };

  const wirePointerDrag = (
    el: HTMLElement,
    update: (event: PointerEvent) => void,
  ) => {
    el.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      el.setPointerCapture(event.pointerId);
      update(event);
    });
    el.addEventListener("pointermove", (event) => {
      if (!el.hasPointerCapture(event.pointerId)) return;
      event.preventDefault();
      update(event);
    });
    el.addEventListener("pointerup", (event) => {
      if (el.hasPointerCapture(event.pointerId)) {
        el.releasePointerCapture(event.pointerId);
      }
    });
  };

  wirePointerDrag(sv, updateSvFromPointer);
  wirePointerDrag(hue, updateHueFromPointer);

  sv.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") hsv = { ...hsv, s: clamp(hsv.s - step, 0, 1) };
    else if (e.key === "ArrowRight") hsv = { ...hsv, s: clamp(hsv.s + step, 0, 1) };
    else if (e.key === "ArrowUp") hsv = { ...hsv, v: clamp(hsv.v + step, 0, 1) };
    else if (e.key === "ArrowDown") hsv = { ...hsv, v: clamp(hsv.v - step, 0, 1) };
    else return;
    e.preventDefault();
    updateUi();
    previewColor();
  });

  hue.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 15 : 2;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      hsv = { ...hsv, h: (hsv.h - step + 360) % 360 };
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      hsv = { ...hsv, h: (hsv.h + step) % 360 };
    } else if (e.key === "Home") {
      hsv = { ...hsv, h: 0 };
    } else if (e.key === "End") {
      hsv = { ...hsv, h: 360 };
    } else return;
    e.preventDefault();
    updateUi();
    previewColor();
  });

  hexInput.addEventListener("input", () => {
    const next = hexToRgb(hexInput.value);
    hexInput.classList.toggle("is-invalid", !next && hexInput.value.trim().length > 0);
    applyBtn.disabled = !next;
    applyBtn.classList.toggle("is-disabled", !next);
    if (next) setFromRgb(next, true);
  });

  alphaSlider?.addEventListener("input", () => {
    alpha = clamp(Number(alphaSlider.value), 0.1, 1);
    updateUi();
    previewColor();
  });

  const restore = (refocusEditor: boolean) => {
    if (restoredOrCommitted) return;
    restoredOrCommitted = true;
    if (editorMode && schema && view && snapshot) {
      restoreColorSnapshot(schema, view, kind, snapshot, {
        addToHistory: false,
        refocusEditor,
      });
    } else {
      onRestoreColor?.();
    }
  };

  const commit = () => {
    if (restoredOrCommitted) return;
    const typedRgb = hexToRgb(hexInput.value);
    if (!typedRgb) {
      hexInput.classList.add("is-invalid");
      hexInput.focus();
      return;
    }
    setFromRgb(typedRgb, false);
    restoredOrCommitted = true;
    const color = formatPickedColor(kind, rgb, alpha);
    if (editorMode && schema && view && apply && snapshot) {
      restoreColorSnapshot(schema, view, kind, snapshot, {
        addToHistory: false,
        refocusEditor: false,
      });
      apply(schema, view, color);
    } else {
      onCommitColor?.(color);
    }
    onCommit();
  };

  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const next = hexToRgb(hexInput.value);
      if (next) {
        commit();
      } else {
        hexInput.classList.add("is-invalid");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      restore(true);
      onCommit();
    }
  });

  cancelBtn.addEventListener("mousedown", (e) => e.preventDefault());
  cancelBtn.addEventListener("click", () => {
    restore(true);
    onCommit();
  });

  applyBtn.addEventListener("mousedown", (e) => e.preventDefault());
  applyBtn.addEventListener("click", commit);

  updateUi();
  previewColor();
  setDirty(false);

  return {
    el: picker,
    cleanup: () => {
      if (shouldRestoreOnCleanup()) restore(false);
    },
  };
}

export function createPresetColorPicker(args: {
  kind: ColorKind;
  initial: string;
  preview: (color: string) => void;
  commit: (color: string) => void | Promise<void>;
  close: () => void;
}): { el: HTMLElement; cleanup: () => void } {
  return createCustomColorPicker({
    kind: args.kind,
    initialColor: args.initial,
    onPreviewColor: args.preview,
    onCommitColor: (color) => {
      void args.commit(color);
    },
    onRestoreColor: () => args.preview(args.initial),
    onCommit: args.close,
    shouldRestoreOnCleanup: () => true,
  });
}

const MOBILE_DRAWER_BODY_CLASS = "butter-mobile-drawer-open";
const MOBILE_DRAWER_HEIGHT_VAR = "--butter-mobile-drawer-height";
const MOBILE_DRAWER_FALLBACK_HEIGHT = 320;

function readMobileDrawerHeight(): string {
  const raw = getComputedStyle(activeDocument.documentElement)
    .getPropertyValue("--keyboard-height")
    .trim();
  if (raw && raw !== "0px" && raw !== "0") return raw;
  return `${MOBILE_DRAWER_FALLBACK_HEIGHT}px`;
}

/** Best-effort: lift the selection above the bottom drawer so the live
 *  colour preview is actually visible. The drawer is position:fixed and
 *  doesn't shrink the editor's scroller, so PM's own scrollIntoView
 *  won't clear it - nudge the nearest scrollable ancestor by the
 *  overlap instead. */
function scrollSelectionAboveDrawer(
  view: EditorView,
  drawerHeightPx: number,
): void {
  let coords: { top: number; bottom: number; left: number; right: number };
  try {
    coords = view.coordsAtPos(view.state.selection.head);
  } catch {
    return;
  }
  const MARGIN = 24;
  const limit = window.innerHeight - drawerHeightPx - MARGIN;
  if (coords.bottom <= limit) return;
  const delta = coords.bottom - limit;
  let el: HTMLElement | null = view.dom.parentElement;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
      el.scrollTop += delta;
      return;
    }
    el = el.parentElement;
  }
}

/** Mobile palette drawer. Uses the same color model as the desktop
 *  popover, but hosts it in the keyboard-replacement drawer used by
 *  mobile toolbar actions. */
/** Commit/preview seam so the one mobile colour drawer can drive either
 *  the editor (text/highlight marks) or a settings preset slot. */
interface ColorTarget {
  kind: ColorKind;
  initial: string | null;
  allowDefault: boolean;
  preview(color: string | null): void;
  finalize(color: string | null, changed: boolean): void;
  openPresetSettings?: () => void;
  onMount(): void;
  onClose(): void;
  scrollAfterOpen(px: number): void;
  elevated?: boolean;
  showClose?: boolean;
}

export function openMobileColorSheet(
  app: App,
  schema: Schema,
  view: EditorView,
  kind: "text" | "highlight",
): void {
  const apply = kind === "text" ? applyTextColor : applyHighlightColor;
  const plugin = app.plugins?.plugins["butter-editor"] as
    | { openSettings?: (subtab?: "general" | "editor" | "drag-drop" | "toolbar" | "context-menu" | "advanced" | "license" | "support", section?: string) => void }
    | undefined;
  const snapshot = captureColorSnapshot(schema, view, kind);
  openColorDrawer({
    kind,
    initial: snapshotFirstColor(snapshot, kind),
    allowDefault: true,
    preview: (color) =>
      apply(schema, view, color, { addToHistory: false, refocusEditor: false }),
    finalize: (color, changed) => {
      // Collapse the live previews into a single history entry (or none).
      restoreColorSnapshot(schema, view, kind, snapshot, {
        addToHistory: false,
        refocusEditor: false,
      });
      if (changed) apply(schema, view, color, { refocusEditor: false });
    },
    openPresetSettings: () => plugin?.openSettings?.("toolbar", "preset-colors"),
    onMount: () => {
      view.dom.blur();
      if (activeDocument.activeElement instanceof HTMLElement) {
        activeDocument.activeElement.blur();
      }
    },
    onClose: () => window.setTimeout(() => view.focus(), 0),
    scrollAfterOpen: (px) => scrollSelectionAboveDrawer(view, px),
  });
}

/** Open the mobile colour drawer to edit a single settings preset slot:
 *  the chip is painted live via preview, and the picked value is written
 *  + saved on close. No editor / ProseMirror involvement. */
export function openMobilePresetColorSheet(args: {
  kind: ColorKind;
  initial: string | null;
  preview: (color: string) => void;
  commit: (color: string) => void | Promise<void>;
}): void {
  openColorDrawer({
    kind: args.kind,
    initial: args.initial,
    allowDefault: false,
    preview: (color) => {
      if (color) args.preview(color);
    },
    finalize: (color, changed) => {
      if (changed && color) void args.commit(color);
    },
    onMount: () => {
      if (activeDocument.activeElement instanceof HTMLElement) {
        activeDocument.activeElement.blur();
      }
    },
    onClose: () => {},
    scrollAfterOpen: () => {},
    elevated: true,
    showClose: true,
  });
}

function openColorDrawer(target: ColorTarget): void {
  const drawerPrepare = prepareMobileDrawerOpen();

  const kind = target.kind;
  const presets = palettePresets(kind);
  const initialColor = target.initial;
  const selectedPreset = presets.find((sw) => colorsEquivalent(initialColor, sw.value));
  // activeSource is "default", "custom", or a preset's colour value.
  let activeSource = !initialColor
    ? "default"
    : selectedPreset
      ? selectedPreset.value
      : "custom";
  let selectedColor: string | null = initialColor;
  let committed = false;
  let closed = false;

  // One HSV model backs both pages: page 1 picks a hue (via a preset)
  // plus a shade from this tint->shade ramp; page 2 edits the same colour
  // as H/S/V sliders.
  const SHADE_STOPS: ReadonlyArray<{ s: number; v: number }> = [
    { s: 0.22, v: 1.0 },
    { s: 0.45, v: 0.93 },
    { s: 0.7, v: 0.8 },
    { s: 0.9, v: 0.62 },
    { s: 1.0, v: 0.4 },
  ];
  let hsv = { h: 0, s: 0, v: 0 };
  let alpha = kind === "highlight" ? CUSTOM_HIGHLIGHT_ALPHA : 1;

  // Seed the HSV (+ alpha) model from a css colour (no apply).
  const seedFromColor = (value: string | null): void => {
    const parsed =
      (value ? parseCssColor(value) : null) ??
      parseCssColor(kind === "text" ? DEFAULT_TEXT_CUSTOM_COLOR : DEFAULT_HIGHLIGHT_CUSTOM_COLOR)!;
    hsv = rgbToHsv({ r: parsed.r, g: parsed.g, b: parsed.b });
    if (kind === "highlight" && value && /^rgba\(/i.test(value.trim())) {
      alpha = parsed.a;
    }
  };
  seedFromColor(initialColor);

  const currentColor = (): string => formatPickedColor(kind, hsvToRgb(hsv), alpha);
  const shadeColor = (i: number): string =>
    formatPickedColor(
      kind,
      hsvToRgb({ h: hsv.h, s: SHADE_STOPS[i].s, v: SHADE_STOPS[i].v }),
      alpha,
    );

  const drawerHeightRaw = readMobileDrawerHeight();
  const drawerHeightPx =
    parseInt(drawerHeightRaw, 10) || MOBILE_DRAWER_FALLBACK_HEIGHT;
  activeDocument.body.style.setProperty(MOBILE_DRAWER_HEIGHT_VAR, drawerHeightRaw);
  activeDocument.body.classList.add(MOBILE_DRAWER_BODY_CLASS);

  // ── Drawer shell ──
  const drawer = activeWindow.createDiv();
  drawer.className = "butter-mobile-insert-drawer butter-mobile-color-drawer";
  drawer.dataset.role = "drawer";
  drawer.dataset.kind = kind;
  // Keyboard-height sheet, exactly like the slash/insert drawer: the toolbar
  // anchors to the same height var (set once on open) and never moves. The
  // page-1 grid fills this fixed height (1fr rows) so there's no whitespace.
  // When invoked from the settings modal (preset editing) the drawer must
  // sit above that modal. Obsidian's modal layer is --layer-modal (100);
  // the menu layer (65) is below it, so go one above the modal layer.
  if (target.elevated) drawer.setCssStyles({ zIndex: "calc(var(--layer-modal, 100) + 1)" });

  const shell = activeWindow.createDiv();
  shell.classList.add("butter-mobile-color-shell");
  drawer.appendChild(shell);

  // Bare header: just a back affordance, shown only on the Precise page.
  const header = activeWindow.createDiv();
  header.classList.add("butter-mobile-drawer-header", "butter-mobile-color-header");
  header.hidden = true;
  shell.appendChild(header);
  const backBtn = activeWindow.createEl("button");
  backBtn.type = "button";
  backBtn.classList.add("butter-mobile-color-back", "clickable-icon");
  backBtn.setAttribute("aria-label", tx("Back to presets"));
  setIcon(backBtn, "chevron-left");
  header.appendChild(backBtn);
  const backLabel = activeWindow.createSpan();
  backLabel.classList.add("butter-mobile-color-back-label");
  backLabel.textContent = tx("Presets");
  header.appendChild(backLabel);

  // Explicit close affordance (shown in slot/settings mode, where there's
  // no editor to tap back into). Sits at the top-right of the drawer.
  const closeBtn = activeWindow.createEl("button");
  closeBtn.type = "button";
  closeBtn.classList.add("butter-mobile-color-close", "clickable-icon");
  closeBtn.setAttribute("aria-label", tx("Close"));
  setIcon(closeBtn, "x");
  closeBtn.hidden = !target.showClose;
  closeBtn.addEventListener("click", () => closeAndRefocus());
  header.appendChild(closeBtn);

  const body = activeWindow.createDiv();
  body.classList.add("butter-mobile-color-body");
  shell.appendChild(body);

  // ── Page 1: a true full-bleed colour wall — three equal-height rows that
  //    fill the sheet, each row's cells filling the width. Row 1 = preset
  //    colours, row 2 = shades of the selected preset, row 3 = Clear /
  //    Custom. Pure flexbox (rows flex:1, cells flex:1) so it always fills:
  //    no gaps, no padding, no rounded corners, no whitespace. ──
  const page1 = activeWindow.createDiv();
  page1.classList.add("butter-mobile-color-page", "butter-mobile-color-grid");
  body.appendChild(page1);

  const makeRow = (): HTMLElement => {
    const row = activeWindow.createDiv();
    row.classList.add("butter-mobile-color-row");
    page1.appendChild(row);
    return row;
  };

  const makeCell = (extraClass?: string): { cell: HTMLButtonElement; fill: HTMLElement } => {
    const cell = activeWindow.createEl("button");
    cell.type = "button";
    cell.classList.add("butter-mobile-color-cell");
    if (extraClass) cell.classList.add(extraClass);
    const fill = activeWindow.createSpan();
    fill.classList.add("butter-mobile-color-cell-fill");
    cell.appendChild(fill);
    const check = activeWindow.createSpan();
    check.classList.add("butter-mobile-color-cell-check");
    setIcon(check, "check");
    cell.appendChild(check);
    return { cell, fill };
  };

  const notice = activeWindow.createDiv();
  notice.classList.add("butter-mobile-color-notice");
  notice.textContent = target.allowDefault
    ? kind === "text"
      ? tx("Change selected text color")
      : tx("Change selected text highlight")
    : kind === "text"
      ? tx("Change text preset color")
      : tx("Change highlight preset color");
  page1.appendChild(notice);

  // Row 1: the (editable) preset colours.
  const presetRow = makeRow();
  const swatchButtons = new Map<string, HTMLButtonElement>();
  for (const swatch of presets) {
    const { cell, fill } = makeCell();
    cell.setAttribute("aria-label", swatch.name);
    cell.title = swatch.name;
    fill.style.backgroundColor = swatch.value;
    const value = swatch.value;
    cell.addEventListener("click", () => selectSwatch(value));
    swatchButtons.set(value, cell);
    presetRow.appendChild(cell);
  }

  // Row 2: shades of the currently selected preset (its hue), light -> dark.
  const shadeRow = makeRow();
  const shadeButtons: HTMLButtonElement[] = [];
  const shadeFills: HTMLElement[] = [];
  for (let i = 0; i < SHADE_STOPS.length; i++) {
    const { cell, fill } = makeCell("butter-mobile-color-shade-cell");
    cell.setAttribute("aria-label", `${tx("Shade")} ${i + 1}`);
    const idx = i;
    cell.addEventListener("click", () => selectShade(idx));
    shadeRow.appendChild(cell);
    shadeButtons.push(cell);
    shadeFills.push(fill);
  }

  // Row 3: Clear (editor only) + Custom. Each flexes to fill, so with both
  // present they're half-width; with only Custom (settings preset slots,
  // which must always hold a colour) it fills the row.
  const actionRow = makeRow();
  actionRow.classList.add("butter-mobile-color-action-row");
  let eraser: HTMLButtonElement | null = null;
  if (target.allowDefault) {
    eraser = activeWindow.createEl("button");
    eraser.type = "button";
    eraser.classList.add("butter-mobile-color-action");
    eraser.setAttribute("aria-label", tx(kind === "text" ? "Clear text color" : "Clear highlight"));
    const eraserIcon = activeWindow.createSpan();
    eraserIcon.classList.add("butter-mobile-color-action-icon");
    setIcon(eraserIcon, "eraser");
    eraser.appendChild(eraserIcon);
    const eraserLabel = activeWindow.createSpan();
    eraserLabel.textContent = tx("Clear");
    eraser.appendChild(eraserLabel);
    eraser.addEventListener("click", () => selectDefault());
    actionRow.appendChild(eraser);
  }

  const preciseLink = activeWindow.createEl("button");
  preciseLink.type = "button";
  preciseLink.classList.add("butter-mobile-color-action", "butter-mobile-color-action-custom");
  const preciseIcon = activeWindow.createSpan();
  preciseIcon.classList.add("butter-mobile-color-action-icon");
  setIcon(preciseIcon, "pipette");
  preciseLink.appendChild(preciseIcon);
  const preciseLabel = activeWindow.createSpan();
  preciseLabel.textContent = tx("Custom");
  preciseLink.appendChild(preciseLabel);
  actionRow.appendChild(preciseLink);

  // ── Page 2 (precise): H / S / V sliders (+ opacity) ──
  const page2 = activeWindow.createDiv();
  page2.classList.add("butter-mobile-color-page", "butter-mobile-color-page-custom");
  page2.hidden = true;
  body.appendChild(page2);

  const wireSlider = (
    track: HTMLElement,
    onFraction: (fraction: number) => void,
  ): void => {
    const fromPointer = (event: PointerEvent): void => {
      const rect = track.getBoundingClientRect();
      onFraction(clamp((event.clientX - rect.left) / rect.width, 0, 1));
    };
    track.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      track.setPointerCapture(event.pointerId);
      fromPointer(event);
    });
    track.addEventListener("pointermove", (event) => {
      if (!track.hasPointerCapture(event.pointerId)) return;
      event.preventDefault();
      fromPointer(event);
    });
    track.addEventListener("pointerup", (event) => {
      if (track.hasPointerCapture(event.pointerId)) {
        track.releasePointerCapture(event.pointerId);
      }
    });
  };

  const buildSlider = (
    labelText: string,
    max: number,
    onFraction: (fraction: number) => void,
    onStep: (delta: number) => void,
  ): { track: HTMLElement; thumb: HTMLElement } => {
    const section = activeWindow.createDiv();
    section.classList.add("butter-mobile-color-section");
    const label = activeWindow.createDiv();
    label.classList.add("butter-mobile-color-section-label");
    label.textContent = txKnown(labelText);
    section.appendChild(label);
    const track = activeWindow.createDiv();
    track.classList.add("butter-mobile-color-slider");
    track.tabIndex = 0;
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", txKnown(labelText));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(max));
    const thumb = activeWindow.createDiv();
    thumb.classList.add("butter-mobile-color-slider-thumb");
    track.appendChild(thumb);
    section.appendChild(track);
    wireSlider(track, onFraction);
    track.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") onStep(-1);
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") onStep(1);
      else return;
      e.preventDefault();
    });
    page2.appendChild(section);
    return { track, thumb };
  };

  const hueSlider = buildSlider(
    "Hue",
    360,
    (f) => setHue(f * 360),
    (d) => setHue((hsv.h + d * 6 + 360) % 360),
  );
  hueSlider.track.setCssStyles({
    background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
  });
  const satSlider = buildSlider(
    "Saturation",
    100,
    (f) => setSat(f),
    (d) => setSat(clamp(hsv.s + d * 0.04, 0, 1)),
  );
  const valSlider = buildSlider(
    "Brightness",
    100,
    (f) => setVal(f),
    (d) => setVal(clamp(hsv.v + d * 0.04, 0, 1)),
  );

  // Opacity uses the same slider component as H/S/V (highlight only).
  let opacitySlider: { track: HTMLElement; thumb: HTMLElement } | null = null;
  if (kind === "highlight") {
    opacitySlider = buildSlider(
      "Opacity",
      100,
      (f) => setAlpha(0.1 + f * 0.9),
      (d) => setAlpha(clamp(alpha + d * 0.05, 0.1, 1)),
    );
  }

  const customNavRow = activeWindow.createDiv();
  customNavRow.classList.add(
    "butter-mobile-color-row",
    "butter-mobile-color-action-row",
    "butter-mobile-color-custom-nav-row",
  );
  page2.appendChild(customNavRow);
  const customBackBtn = activeWindow.createEl("button");
  customBackBtn.type = "button";
  customBackBtn.classList.add("butter-mobile-color-action");
  customBackBtn.setAttribute("aria-label", tx("Back to presets"));
  const customBackIcon = activeWindow.createSpan();
  customBackIcon.classList.add("butter-mobile-color-action-icon");
  setIcon(customBackIcon, "palette");
  customBackBtn.appendChild(customBackIcon);
  const customBackLabel = activeWindow.createSpan();
  customBackLabel.textContent = tx("Presets");
  customBackBtn.appendChild(customBackLabel);
  customNavRow.appendChild(customBackBtn);
  let customizePresetsBtn: HTMLButtonElement | null = null;
  if (target.openPresetSettings) {
    customizePresetsBtn = activeWindow.createEl("button");
    customizePresetsBtn.type = "button";
    customizePresetsBtn.classList.add("butter-mobile-color-action");
    customizePresetsBtn.setAttribute("aria-label", tx("Customize presets"));
    const customizePresetsIcon = activeWindow.createSpan();
    customizePresetsIcon.classList.add("butter-mobile-color-action-icon");
    setIcon(customizePresetsIcon, "settings");
    customizePresetsBtn.appendChild(customizePresetsIcon);
    const customizePresetsLabel = activeWindow.createSpan();
    customizePresetsLabel.textContent = tx("Customize presets");
    customizePresetsBtn.appendChild(customizePresetsLabel);
    customNavRow.appendChild(customizePresetsBtn);
  }

  // ── State / UI ──
  function effectiveColor(): string | null {
    return activeSource === "default" ? null : selectedColor;
  }

  function selectedColorMatchesInitial(): boolean {
    if (selectedColor === null || initialColor === null) return selectedColor === initialColor;
    return colorsEquivalent(selectedColor, initialColor);
  }

  function setSliderUi(
    slider: { track: HTMLElement; thumb: HTMLElement },
    fraction: number,
    thumbColor: string,
    valueNow: number,
  ): void {
    slider.thumb.style.left = `${fraction * 100}%`;
    slider.thumb.style.backgroundColor = thumbColor;
    slider.track.setAttribute("aria-valuenow", String(valueNow));
  }

  function refreshUi(): void {
    const curHex = rgbToHex(hsvToRgb(hsv));
    // Page 1: shade ramp follows the hue (+ alpha); a chip is active when
    // it is exactly the live colour.
    for (let i = 0; i < shadeButtons.length; i++) {
      const sc = shadeColor(i);
      shadeFills[i].style.backgroundColor = sc;
      const active = activeSource !== "default" && colorsEquivalent(selectedColor, sc);
      shadeButtons[i].classList.toggle("is-active", active);
      if (active) shadeButtons[i].setAttribute("aria-current", "true");
      else shadeButtons[i].removeAttribute("aria-current");
    }
    // Page 1: preset + clear active states.
    if (eraser) {
      eraser.classList.remove("is-active");
      if (activeSource === "default") eraser.setAttribute("aria-current", "true");
      else eraser.removeAttribute("aria-current");
    }
    for (const [value, button] of swatchButtons) {
      const active = activeSource === value;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    // Page 2: slider thumbs + dynamic S/V tracks.
    setSliderUi(hueSlider, hsv.h / 360, rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 })), Math.round(hsv.h));
    satSlider.track.setCssStyles({
      background: `linear-gradient(to right, ${rgbToHex(hsvToRgb({ h: hsv.h, s: 0, v: hsv.v }))}, ${rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: hsv.v }))})`,
    });
    setSliderUi(satSlider, hsv.s, curHex, Math.round(hsv.s * 100));
    valSlider.track.setCssStyles({
      background: `linear-gradient(to right, #000, ${rgbToHex(hsvToRgb({ h: hsv.h, s: hsv.s, v: 1 }))})`,
    });
    setSliderUi(valSlider, hsv.v, curHex, Math.round(hsv.v * 100));
    // Opacity slider (highlight): same component as H/S/V; the track
    // fades the current colour from transparent to opaque.
    if (opacitySlider) {
      const rgb = hsvToRgb(hsv);
      opacitySlider.track.setCssStyles({
        background: `linear-gradient(to right, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15), rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 1))`,
      });
      setSliderUi(opacitySlider, (alpha - 0.1) / 0.9, curHex, Math.round(alpha * 100));
    }
  }

  function previewApply(): void {
    target.preview(effectiveColor());
  }

  // Auto-apply: every change previews live (no history entry); the final
  // colour is committed once, on close.
  function commitPreview(): void {
    refreshUi();
    previewApply();
  }

  function selectSwatch(value: string): void {
    selectedColor = value;
    activeSource = value;
    // Seed the sliders + shade ramp from the preset so refining continues
    // from this colour.
    seedFromColor(value);
    commitPreview();
  }

  function selectDefault(): void {
    selectedColor = null;
    activeSource = "default";
    commitPreview();
  }

  function selectShade(i: number): void {
    hsv = { h: hsv.h, s: SHADE_STOPS[i].s, v: SHADE_STOPS[i].v };
    activeSource = "custom";
    selectedColor = currentColor();
    commitPreview();
  }

  function setHue(h: number): void {
    hsv = { ...hsv, h };
    activeSource = "custom";
    selectedColor = currentColor();
    commitPreview();
  }

  function setSat(s: number): void {
    hsv = { ...hsv, s };
    activeSource = "custom";
    selectedColor = currentColor();
    commitPreview();
  }

  function setVal(v: number): void {
    hsv = { ...hsv, v };
    activeSource = "custom";
    selectedColor = currentColor();
    commitPreview();
  }

  function setAlpha(a: number): void {
    alpha = clamp(a, 0.1, 1);
    activeSource = "custom";
    selectedColor = currentColor();
    commitPreview();
  }

  function showPage(page: "quick" | "precise"): void {
    const precise = page === "precise";
    page1.hidden = precise;
    page2.hidden = !precise;
    backBtn.hidden = true;
    backLabel.hidden = true;
    closeBtn.hidden = precise || !target.showClose;
    // The custom page owns its Back action in the same bottom row position
    // as the quick page's Clear / Custom controls. The header is only for
    // settings-slot close mode.
    header.hidden = !(target.showClose === true && !precise);
  }

  function closeAndRefocus(): void {
    const closeDelay = closeMobileInsertDrawer({ returningKeyboard: true });
    window.setTimeout(() => target.onClose(), closeDelay);
  }

  // Collapse the live previews into a single history entry (or none) when
  // the tray closes - there's no Cancel, so dismissing keeps the result.
  function finalize(): void {
    if (committed) return;
    committed = true;
    target.finalize(selectedColor, !selectedColorMatchesInitial());
  }

  preciseLink.addEventListener("click", () => showPage("precise"));
  backBtn.addEventListener("click", () => showPage("quick"));
  customBackBtn.addEventListener("click", () => showPage("quick"));
  customizePresetsBtn?.addEventListener("click", () => {
    closeMobileInsertDrawer();
    target.openPresetSettings?.();
  });

  // ── Dismiss: swipe / tap-away / close button / hardware Back / Esc.
  //    All commit the result (no Cancel). ──
  // No grab handle anymore (the toolbar's X closes the drawer); keep
  // tap-away dismissal, so pass no swipe-grab elements.
  const dismissGestures = installDrawerDismissGestures(drawer, [], closeAndRefocus);

  // Android hardware Back: Obsidian routes it natively via Capacitor (not
  // through window history, so a popstate hook doesn't fire), so listen on
  // the Capacitor backButton event to close the drawer.
  const cap = (
    window as unknown as {
      Capacitor?: {
        Plugins?: { App?: { addListener?: (event: string, cb: () => void) => unknown } };
      };
    }
  ).Capacitor;
  let backHandle: { remove?: () => void } | null = null;
  let backHandlePromise: Promise<{ remove?: () => void }> | null = null;
  const appPlugin = cap?.Plugins?.App;
  if (appPlugin?.addListener) {
    try {
      const ret = appPlugin.addListener("backButton", () => closeAndRefocus());
      if (ret && typeof (ret as { then?: unknown }).then === "function") {
        backHandlePromise = ret as Promise<{ remove?: () => void }>;
      } else {
        backHandle = ret as { remove?: () => void };
      }
    } catch {
      /* Capacitor unavailable - the close button / swipe still work */
    }
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAndRefocus();
    }
  };
  activeDocument.addEventListener("keydown", onKeyDown, true);

  setMobileDrawerCleanup(() => {
    if (closed) return;
    closed = true;
    dismissGestures();
    activeDocument.removeEventListener("keydown", onKeyDown, true);
    if (backHandle?.remove) backHandle.remove();
    if (backHandlePromise) {
      backHandlePromise.then((h) => h.remove?.()).catch(() => {});
    }
    finalize();
  });

  showPage("quick");
  refreshUi();
  if (drawerPrepare.replacedDrawer) drawer.classList.add("is-open");
  activeDocument.body.appendChild(drawer);
  if (!drawerPrepare.replacedDrawer) {
    window.requestAnimationFrame(() => drawer.classList.add("is-open"));
  }
  animateDrawerHeightFromPrevious(drawer, drawerPrepare);
  window.setTimeout(() => {
    target.onMount();
    target.scrollAfterOpen(drawerHeightPx);
  }, 0);
  // Re-run after the soft keyboard finishes sliding away (innerHeight
  // grows once it's gone), since the first pass runs before the OS
  // settles the viewport.
  window.setTimeout(() => target.scrollAfterOpen(drawerHeightPx), 300);
}

function openToolbarLinkMenu(
  app: App,
  schema: Schema,
  view: EditorView,
  anchor: HTMLElement,
  sourcePath = "",
): void {
  void schema;
  openUnifiedLinkEditor({
    app,
    view,
    anchor,
    sourcePath,
    autoFocus: true,
  });
}

/** Heuristic for "this input value is clearly a URL, not a note name."
 *  Matches the same shapes `classifyLinkInput` would route external,
 *  used to suppress vault-file suggestions on the toolbar's
 *  dual-purpose Link field. */
export function looksLikeExternalUrl(raw: string): boolean {
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
  buttonMap: Map<string, Set<HTMLElement>>;
  submenuMap: Map<string, HTMLElement>;
  submenuChildMap: Map<string, string[]>;
  commandMap: Map<string, { item: CommandLayoutItem; elements: Set<HTMLElement> }>;
  getView: () => EditorView | null;
  /** Mobile-only keyboard dismissal owned by ButterEditorView. */
  dismissMobileKeyboard?: () => void;
  getSourcePath: () => string;
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
  const s = activeWindow.createDiv();
  s.classList.add("butter-toolbar-separator");
  return s;
}

function registerButtonEl(
  buttonMap: Map<string, Set<HTMLElement>>,
  id: string,
  el: HTMLElement,
): void {
  const existing = buttonMap.get(id);
  if (existing) existing.add(el);
  else buttonMap.set(id, new Set([el]));
}

function registerCommandEl(
  commandMap: RenderCtx["commandMap"],
  item: CommandLayoutItem,
  el: HTMLElement,
): void {
  const existing = commandMap.get(item.id);
  if (existing) existing.elements.add(el);
  else commandMap.set(item.id, { item, elements: new Set([el]) });
}

function collectButtonIds(items: LayoutItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.type === "button") ids.push(item.id);
    else if (item.type === "submenu") ids.push(...collectButtonIds(item.children));
  }
  return ids;
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

  const el = activeWindow.createEl("button");
  el.classList.add("butter-btn", "clickable-icon");
  el.setAttribute(
    "aria-label",
    def.kbd ? `${tx(def.label)} (${def.kbd})` : tx(def.label),
  );
  el.dataset.btnId = def.id;
  setIcon(el, def.icon);
  if (def.id === "text-color" || (def.id === "highlight" && htmlOk)) {
    el.setAttribute("aria-haspopup", "menu");
    const dot = activeWindow.createSpan();
    dot.classList.add("butter-submenu-dot");
    el.appendChild(dot);
  }
  registerButtonEl(ctx.buttonMap, def.id, el);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.closePopover();
    const view = ctx.getView();
    if (!view || !view.editable) return;

    if (def.id === "link" || def.id === "insert-link-md") {
      openToolbarLinkMenu(ctx.app, ctx.schema, view, el, ctx.getSourcePath());
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
        el.closest<HTMLElement>(".butter-toolbar")?.dataset.activeStyle ?? "filled",
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
          el.closest<HTMLElement>(".butter-toolbar")?.dataset.activeStyle ?? "filled",
        );
        ctx.setPopover(palette, el);
      }
      window.setTimeout(() => view.focus(), 0);
      return;
    }

    if (def.kind === "mark") execMarkCmd(def, ctx.schema, view);
    else if (def.kind === "block") execBlockCmd(def, ctx.schema, view);
    else if (def.kind === "list") execListCmd(def, ctx.schema, view);
    else if (def.kind === "list-depth") execListDepthCmd(def, view);
    else if (def.kind === "insert") {
      execInsertCmd(def, ctx.schema, view, ctx.app, ctx.getSourcePath);
    }
    else if (def.kind === "heading") setHeading(ctx.schema, view, def.headingLevel ?? 0);
    else if (def.kind === "history") execHistoryCmd(def, view);

    window.setTimeout(() => view.focus(), 0);
  });

  return el;
}

function renderCommandButton(item: CommandLayoutItem, ctx: RenderCtx): HTMLElement {
  const el = activeWindow.createEl("button");
  el.classList.add("butter-btn", "clickable-icon", "butter-btn-command");
  el.setAttribute("aria-label", commandActionLabel(ctx.app, item));
  el.dataset.commandItemId = item.id;
  el.dataset.commandId = item.commandId;
  setIcon(el, commandActionIcon(ctx.app, item));
  registerCommandEl(ctx.commandMap, item, el);

  el.addEventListener("click", (event) => {
    event.preventDefault();
    ctx.closePopover();
    const view = ctx.getView();
    if (!view?.editable || !isObsidianCommandAvailable(ctx.app, item.commandId)) return;
    executeObsidianCommand(ctx.app, item.commandId);
  });
  return el;
}

function renderSubmenuButton(
  item: Extract<LayoutItem, { type: "submenu" }>,
  ctx: RenderCtx,
): HTMLElement {
  const el = activeWindow.createEl("button");
  el.classList.add("butter-btn", "clickable-icon", "butter-btn-submenu");
  el.setAttribute("aria-label", item.label ? txKnown(item.label) : tx("Submenu"));
  el.setAttribute("aria-haspopup", "menu");
  el.setAttribute("aria-expanded", "false");
  el.dataset.submenuId = item.id;
  setIcon(el, item.icon || "more-horizontal");
  ctx.submenuMap.set(item.id, el);
  ctx.submenuChildMap.set(item.id, collectButtonIds(item.children));
  // Indicator dot
  const dot = activeWindow.createSpan();
  dot.classList.add("butter-submenu-dot");
  el.appendChild(dot);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    ctx.closePopover();

    const popup = activeWindow.createDiv();
    popup.classList.add("butter-toolbar-submenu-popup");
    popup.dataset.activeStyle =
      el.closest<HTMLElement>(".butter-toolbar")?.dataset.activeStyle ?? "filled";
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-label", item.label ? txKnown(item.label) : tx("Submenu"));
    const popupButtons: Array<{ id: string; el: HTMLElement }> = [];
    const popupCommands: Array<{ id: string; el: HTMLElement }> = [];

    for (const child of item.children) {
      const childEl = renderItem(child, ctx, /* nested */ true);
      if (childEl) {
        childEl.setAttribute("role", "menuitem");
        const childId = childEl.dataset.btnId;
        if (childId) popupButtons.push({ id: childId, el: childEl });
        const commandItemId = childEl.dataset.commandItemId;
        if (commandItemId) popupCommands.push({ id: commandItemId, el: childEl });
        popup.appendChild(childEl);
      }
    }
    (popup as ToolbarPopoverElement).butterPopoverCleanup = () => {
      for (const { id, el } of popupButtons) {
        const set = ctx.buttonMap.get(id);
        if (!set) continue;
        set.delete(el);
        if (set.size === 0) ctx.buttonMap.delete(id);
      }
      for (const { id, el } of popupCommands) {
        const entry = ctx.commandMap.get(id);
        if (!entry) continue;
        entry.elements.delete(el);
        if (entry.elements.size === 0) ctx.commandMap.delete(id);
      }
    };
    if (popup.children.length === 0) {
      const empty = activeWindow.createDiv();
      empty.classList.add("butter-toolbar-submenu-empty");
      empty.textContent = tx("Empty");
      popup.appendChild(empty);
    }
    el.setAttribute("aria-expanded", "true");
    ctx.setPopover(popup, el, { closeOnLeave: true });
    const view = ctx.getView();
    if (view) {
      updateActiveStates(
        ctx.app,
        ctx.buttonMap,
        ctx.submenuMap,
        ctx.submenuChildMap,
        ctx.commandMap,
        ctx.schema,
        view,
      );
      const toolbar = el.closest<HTMLElement>(".butter-toolbar");
      if (toolbar) refreshRovingTabindex(toolbar, el);
    }

    // Keyboard-triggered clicks should land on the first item for
    // immediate arrow navigation. Pointer clicks leave focus on the
    // submenu trigger so the first child doesn't show a surprise
    // focus ring when the popup opens.
    if (e.detail === 0) {
      window.requestAnimationFrame(() => {
        const first = popup.querySelector<HTMLElement>(
          '[role="menuitem"]',
        );
        first?.focus();
      });
    }
  });

  return el;
}

/** Install roving-tabindex + arrow-key navigation on a toolbar
 *  container. Only one focusable button has tabindex=0 at any time;
 *  the rest are tabindex=-1 (still focusable programmatically /
 *  via arrow keys, but skipped by Tab). Arrow keys move focus
 *  across visible buttons; Home/End jump to the ends. Hidden
 *  buttons (display:none) are skipped during navigation. */
function getRovingButtons(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(
    toolbar.querySelectorAll<HTMLElement>(".butter-btn"),
  ).filter(
    (el) =>
      el.offsetParent !== null &&
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute("aria-disabled") !== "true",
  );
}

function refreshRovingTabindex(
  toolbar: HTMLElement,
  preferred: HTMLElement | null = null,
): void {
  const all = Array.from(
    toolbar.querySelectorAll<HTMLElement>(".butter-btn"),
  );
  const focusables = getRovingButtons(toolbar);
  const current =
    (preferred && focusables.includes(preferred) ? preferred : null) ??
    focusables.find((el) => el.tabIndex === 0) ??
    focusables[0] ??
    null;
  for (const button of all) button.tabIndex = button === current ? 0 : -1;
}

function installRovingTabindex(toolbar: HTMLElement): void {

  // Initial state: first focusable button is the tab-stop.
  refreshRovingTabindex(toolbar);

  // On focus inside the toolbar, sync the roving index so Tab returns
  // to whichever button the user last focused.
  toolbar.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("butter-btn")) return;
    refreshRovingTabindex(toolbar, target);
  });

  toolbar.addEventListener("keydown", (e: KeyboardEvent) => {
    if (
      e.key !== "ArrowLeft" &&
      e.key !== "ArrowRight" &&
      e.key !== "Home" &&
      e.key !== "End"
    )
      return;
    const list = getRovingButtons(toolbar);
    if (list.length === 0) return;
    const current = toolbar.ownerDocument.activeElement as HTMLElement | null;
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
  if (item.type === "command") return renderCommandButton(item, ctx);
  if (item.type === "overflow") return null;
  return renderRegularButton(item.id, ctx);
}

// ── State update ──

function updateActiveStates(
  app: App,
  buttonMap: Map<string, Set<HTMLElement>>,
  submenuMap: Map<string, HTMLElement>,
  submenuChildMap: Map<string, string[]>,
  commandMap: RenderCtx["commandMap"],
  schema: Schema,
  view: EditorView,
) {
  const { state } = view;
  const activeHeading = getActiveHeadingLevel(state, schema);
  const editorEditable = view.editable;
  const activeById = new Map<string, boolean>();

  for (const btn of ALL_BUTTONS) {
    const els = buttonMap.get(btn.id);

    let active = false;
    for (const el of els ?? []) {
      el.classList.toggle("is-disabled", !editorEditable);
      (el as HTMLButtonElement).disabled = !editorEditable;
    }
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
      const enabled = editorEditable && typeof depthRaw === "number" && depthRaw > 0;
      for (const el of els ?? []) {
        el.classList.toggle("is-disabled", !enabled);
        (el as HTMLButtonElement).disabled = !enabled;
      }
    }
    activeById.set(btn.id, active);
    for (const el of els ?? []) {
      el.classList.toggle("is-active", active);
    }
  }

  for (const [submenuId, el] of submenuMap) {
    const childIds = submenuChildMap.get(submenuId) ?? [];
    const active = childIds.some((id) => activeById.get(id) === true);
    el.classList.toggle("is-active", active);
    el.classList.toggle("is-disabled", !editorEditable);
    (el as HTMLButtonElement).disabled = !editorEditable;
  }

  for (const { item, elements } of commandMap.values()) {
    const enabled = editorEditable && isObsidianCommandAvailable(app, item.commandId);
    for (const el of elements) {
      el.classList.toggle("is-disabled", !enabled);
      (el as HTMLButtonElement).disabled = !enabled;
      el.setAttribute("aria-label", commandActionLabel(app, item));
    }
  }
}

// ── Factory ──

function installToolbarOverflowIndicators(
  toolbar: HTMLElement,
  scrollEl: HTMLElement,
): () => void {
  const doc = scrollEl.ownerDocument;
  const leftInd = doc.win.createDiv();
  leftInd.classList.add("butter-toolbar-overflow-indicator", "is-left");
  leftInd.setAttribute("role", "button");
  leftInd.setAttribute("tabindex", "0");
  leftInd.setAttribute("aria-label", tx("Scroll toolbar left"));
  setIcon(leftInd, "chevron-left");

  const rightInd = doc.win.createDiv();
  rightInd.classList.add("butter-toolbar-overflow-indicator", "is-right");
  rightInd.setAttribute("role", "button");
  rightInd.setAttribute("tabindex", "0");
  rightInd.setAttribute("aria-label", tx("Scroll toolbar right"));
  setIcon(rightInd, "chevron-right");

  const getToolbarItems = () =>
    Array.from(scrollEl.children).filter(
      (el): el is HTMLElement =>
        el.instanceOf(HTMLElement) &&
        !el.classList.contains("butter-toolbar-overflow-indicator") &&
        el.offsetParent !== null,
    );

  const hasHorizontalOverflow = () =>
    scrollEl.scrollWidth > scrollEl.clientWidth + 1;

  const updateIndicators = () => {
    if (!hasHorizontalOverflow()) {
      leftInd.removeClass("is-visible");
      rightInd.removeClass("is-visible");
      return;
    }
    const canLeft = scrollEl.scrollLeft > 1;
    const canRight =
      scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth - 1;
    leftInd.toggleClass("is-visible", canLeft);
    rightInd.toggleClass("is-visible", canRight);
  };

  let scheduledUpdate: number | null = null;
  const scheduleUpdateIndicators = () => {
    if (scheduledUpdate !== null) return;
    scheduledUpdate = doc.defaultView?.requestAnimationFrame(() => {
      scheduledUpdate = null;
      updateIndicators();
    }) ?? null;
    if (scheduledUpdate === null) updateIndicators();
  };

  const scrollByOneItem = (dir: -1 | 1) => {
    const items = getToolbarItems();
    if (dir === 1) {
      const visibleRight = scrollEl.scrollLeft + scrollEl.clientWidth;
      const next = items.find(
        (item) => item.offsetLeft + item.offsetWidth > visibleRight + 1,
      );
      if (next) {
        scrollEl.scrollTo({ left: next.offsetLeft - 4, behavior: "smooth" });
        return;
      }
    } else {
      const visibleLeft = scrollEl.scrollLeft;
      let prev: HTMLElement | undefined;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].offsetLeft < visibleLeft - 1) {
          prev = items[i];
          break;
        }
      }
      if (prev) {
        scrollEl.scrollTo({
          left: Math.max(0, prev.offsetLeft - 4),
          behavior: "smooth",
        });
        return;
      }
    }

    scrollEl.scrollBy({
      left: dir * Math.max(60, scrollEl.clientWidth * 0.5),
      behavior: "smooth",
    });
  };

  const onWheel = (e: WheelEvent) => {
    if (!hasHorizontalOverflow()) return;
    const horizontalIntent = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horizontalIntent) return;
    const delta = e.deltaY;
    if (delta === 0) return;
    const max = scrollEl.scrollWidth - scrollEl.clientWidth;
    const atLeft = scrollEl.scrollLeft <= 1;
    const atRight = scrollEl.scrollLeft >= max - 1;
    if ((delta < 0 && atLeft) || (delta > 0 && atRight)) return;
    e.preventDefault();
    scrollEl.scrollLeft = clamp(scrollEl.scrollLeft + delta, 0, max);
    updateIndicators();
  };

  const wireIndicator = (el: HTMLElement, dir: -1 | 1) => {
    const onClick = () => scrollByOneItem(dir);
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        scrollByOneItem(dir);
      }
    };
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKeydown);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("keydown", onKeydown);
    };
  };

  const cleanupLeft = wireIndicator(leftInd, -1);
  const cleanupRight = wireIndicator(rightInd, 1);
  toolbar.appendChild(leftInd);
  toolbar.appendChild(rightInd);
  scrollEl.addEventListener("scroll", scheduleUpdateIndicators, { passive: true });
  toolbar.addEventListener("wheel", onWheel, { passive: false });

  const resizeObserver = new ResizeObserver(scheduleUpdateIndicators);
  const observed = new Set<Element>([scrollEl, toolbar]);
  const stack = toolbar.closest(".butter-toolbar-stack");
  if (stack) observed.add(stack);
  if (toolbar.parentElement) observed.add(toolbar.parentElement);
  observed.forEach((el) => resizeObserver.observe(el));
  const win = doc.defaultView ?? window;
  win.addEventListener("resize", scheduleUpdateIndicators);
  win.visualViewport?.addEventListener("resize", scheduleUpdateIndicators);
  scheduleUpdateIndicators();

  return () => {
    if (scheduledUpdate !== null) {
      win.cancelAnimationFrame(scheduledUpdate);
      scheduledUpdate = null;
    }
    cleanupLeft();
    cleanupRight();
    scrollEl.removeEventListener("scroll", scheduleUpdateIndicators);
    toolbar.removeEventListener("wheel", onWheel);
    win.removeEventListener("resize", scheduleUpdateIndicators);
    win.visualViewport?.removeEventListener("resize", scheduleUpdateIndicators);
    resizeObserver.disconnect();
    leftInd.remove();
    rightInd.remove();
  };
}

const toolbarPluginKey = new PluginKey("butter-toolbar");

export function createToolbar(
  app: App,
  schema: Schema,
  getLayout: () => Layout,
  getMobileStyle: () => "detached" | "attached" = () => "attached",
  serializeNode?: (node: import("prosemirror-model").Node) => string,
  getSourcePath: () => string = () => "",
  dismissMobileKeyboard?: () => void,
): { dom: HTMLElement; plugin: Plugin; rebuild: () => void } {
  const buttonMap = new Map<string, Set<HTMLElement>>();
  const submenuMap = new Map<string, HTMLElement>();
  const submenuChildMap = new Map<string, string[]>();
  const commandMap: RenderCtx["commandMap"] = new Map();
  const isMobile = Platform.isMobile ?? false;

  let editorViewRef: EditorView | null = null;
  let activePopover: HTMLElement | null = null;
  let activePopoverAnchor: HTMLElement | null = null;
  let popoverCleanup: (() => void) | null = null;

  const closePopover = () => {
    const closingPopover = activePopover;
    activePopover = null;
    if (closingPopover) {
      runToolbarPopoverCleanup(closingPopover);
      dismissSurfaceWithMotion(closingPopover, () => closingPopover.remove());
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
    const shouldPlace = !popup.style.position && !popup.classList.contains("butter-pos-fixed")
      && !popup.classList.contains("butter-pos-fixed-popover")
      && !popup.classList.contains("butter-mobile-popup-placed");
    attachSurfaceMotion(
      popup,
      popup.classList.contains("butter-toolbar-submenu-popup")
        ? "submenu"
        : "popover",
    );
    activeDocument.body.appendChild(popup);
    const positionCleanup = shouldPlace
      ? bindFixedPopoverToAnchor(popup, anchor)
      : null;
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
      if (positionCleanup) positionCleanup();
      activeDocument.removeEventListener("mousedown", downHandler);
      if (moveHandler) activeDocument.removeEventListener("mousemove", moveHandler);
    };
  };

  const ctx: RenderCtx = {
    app,
    schema,
    buttonMap,
    submenuMap,
    submenuChildMap,
    commandMap,
    getView: () => editorViewRef,
    dismissMobileKeyboard,
    getSourcePath,
    getLayout,
    closePopover,
    setPopover,
    serializeNode,
  };

  // Outer wrapper is stable - rebuilds replace its children only.
  // This way main.ts's `this.toolbarDom` reference stays valid.
  const dom = activeWindow.createDiv();
  let toolbarOverflowCleanup: (() => void) | null = null;

  const renderDesktop = () => {
    closePopover();
    toolbarOverflowCleanup?.();
    toolbarOverflowCleanup = null;
    const activeStyle = dom.getAttribute("data-active-style") ?? "filled";
    dom.innerHTML = "";
    buttonMap.clear();
    submenuMap.clear();
    submenuChildMap.clear();
    commandMap.clear();
    dom.classList.add("butter-toolbar");
    dom.setAttribute("role", "toolbar");
    dom.setAttribute("data-active-style", activeStyle);
    dom.setAttribute("data-bg", "chrome");
    dom.setAttribute("data-grouping", "separators");
    const scrollEl = activeWindow.createDiv();
    scrollEl.classList.add("butter-toolbar-scroll");
    dom.appendChild(scrollEl);
    for (const item of getLayout()) {
      const el = renderItem(item, ctx);
      if (el) scrollEl.appendChild(el);
    }
    installRovingTabindex(scrollEl);
    toolbarOverflowCleanup = installToolbarOverflowIndicators(dom, scrollEl);
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
    if (editorViewRef) {
      updateActiveStates(app, buttonMap, submenuMap, submenuChildMap, commandMap, schema, editorViewRef);
      refreshRovingTabindex(dom);
    }
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
      updateActiveStates(app, buttonMap, submenuMap, submenuChildMap, commandMap, schema, editorView);
      refreshRovingTabindex(dom);

      return {
        update(view, prevState) {
          if (
            view.state.selection.eq(prevState.selection) &&
            view.state.storedMarks === prevState.storedMarks &&
            view.state.doc.eq(prevState.doc)
          )
            return;
          updateActiveStates(app, buttonMap, submenuMap, submenuChildMap, commandMap, schema, view);
          refreshRovingTabindex(dom);
        },
        destroy() {
          closePopover();
          toolbarOverflowCleanup?.();
          toolbarOverflowCleanup = null;
          if (isMobile) {
            cleanupMobileToolbarOverflowIndicators(dom);
            if (dom.parentNode) dom.remove();
          }
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
