/**
 * Keyboard shortcut cheat sheet.
 *
 * Grouped, scrollable modal listing every hotkey Butter binds. Opened
 * via the `butter-editor:show-shortcuts` command (default hotkey
 * Mod+/ or ?). A quick reference so users discover Mod+L, Alt+↑↓,
 * and friends without reading a README.
 */
import { App, Modal, Platform } from "obsidian";

interface ShortcutRow {
  label: string;
  keys: string;
}

interface ShortcutSection {
  title: string;
  rows: ShortcutRow[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: "Formatting",
    rows: [
      { label: "Bold", keys: "Mod+B" },
      { label: "Italic", keys: "Mod+I" },
      { label: "Inline code", keys: "Mod+E" },
      { label: "Strikethrough", keys: "Mod+Shift+S" },
      { label: "Highlight", keys: "Mod+Shift+H" },
    ],
  },
  {
    title: "Headings",
    rows: [
      { label: "Paragraph", keys: "Mod+Alt+0" },
      { label: "Heading 1–6", keys: "Mod+Alt+1 … Mod+Alt+6" },
    ],
  },
  {
    title: "Blocks & lists",
    rows: [
      { label: "Move block up", keys: "Alt+\u2191 (or Mod+Shift+\u2191)" },
      { label: "Move block down", keys: "Alt+\u2193 (or Mod+Shift+\u2193)" },
      { label: "Toggle task on current line", keys: "Mod+L" },
      { label: "Indent list item", keys: "Tab" },
      { label: "Outdent list item", keys: "Shift+Tab" },
      { label: "Blockquote", keys: "Mod+Shift+B" },
      { label: "Exit code block", keys: "Mod+Enter" },
    ],
  },
  {
    title: "Tables",
    rows: [
      { label: "Next cell", keys: "Tab" },
      { label: "Previous cell", keys: "Shift+Tab" },
      { label: "Insert row below", keys: "Mod+Enter" },
      { label: "Insert row above", keys: "Mod+Shift+Enter" },
    ],
  },
  {
    title: "Find",
    rows: [
      { label: "Find in note", keys: "Mod+F" },
      { label: "Replace in note", keys: "Mod+H" },
      { label: "Next / previous match", keys: "Enter / Shift+Enter" },
      { label: "Close search", keys: "Escape" },
    ],
  },
  {
    title: "Editor",
    rows: [
      { label: "Undo", keys: "Mod+Z" },
      { label: "Redo", keys: "Mod+Shift+Z (or Mod+Y)" },
      { label: "Select all", keys: "Mod+A" },
      { label: "Open slash menu", keys: "/" },
    ],
  },
  {
    title: "Butter",
    rows: [
      { label: "Toggle Butter / Markdown view", keys: "Command palette" },
      { label: "Show this help", keys: "? or Mod+/" },
    ],
  },
];

function displayMod(): string {
  return Platform.isMacOS ? "Cmd" : "Ctrl";
}

function formatKey(raw: string): string {
  return raw.replace(/Mod/g, displayMod());
}

export class ShortcutHelpModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("butter-shortcut-modal");
    if (Platform.isMobile) this.modalEl.addClass("mod-lg");

    titleEl.setText("Butter editor keyboard shortcuts");
    contentEl.empty();

    const intro = contentEl.createDiv({ cls: "butter-shortcut-intro" });
    intro.textContent =
      "Most shortcuts work only while editing in a Butter view. Obsidian's own hotkeys still apply in source / live preview.";

    const grid = contentEl.createDiv({ cls: "butter-shortcut-grid" });

    for (const section of SECTIONS) {
      const col = grid.createDiv({ cls: "butter-shortcut-section" });
      col.createDiv({ cls: "butter-shortcut-section-title", text: section.title });
      const list = col.createDiv({ cls: "butter-shortcut-list" });
      for (const row of section.rows) {
        const rowEl = list.createDiv({ cls: "butter-shortcut-row" });
        rowEl.createSpan({ cls: "butter-shortcut-label", text: row.label });
        const keysEl = rowEl.createSpan({ cls: "butter-shortcut-keys" });
        const parts = formatKey(row.keys).split(/\s*(\+|·|…|,|\/| or )\s*/);
        for (const part of parts) {
          if (!part.trim()) continue;
          if (part.trim() === "+" || part.trim() === "or" || part.trim() === "·" || part.trim() === "…") {
            keysEl.createSpan({ cls: "butter-shortcut-sep", text: part.trim() });
          } else {
            keysEl.createEl("kbd", { text: part.trim() });
          }
        }
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
