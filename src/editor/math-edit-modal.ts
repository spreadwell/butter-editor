/**
 * Math block edit-source modal.
 *
 * Math blocks render through Obsidian's `MarkdownRenderer`, so they
 * have no in-place edit affordance. The drag-handle "Edit source"
 * item and the NodeView's double-click handler both open this modal;
 * the user edits the raw TeX and Save commits a `setNodeMarkup` with
 * the new `value` attr (clearing `sourceRange` so preservation
 * refreshes against the canonical synthesis path).
 *
 * Lives in its own module so it can be imported by both
 * `drag-handles.ts` (the right-click menu) and `nodeviews.ts` (the
 * double-click handler) without creating a circular dependency.
 */

import { App, Modal, Notice, Platform } from "obsidian";
import { tx } from "../i18n";
import type { EditorView } from "prosemirror-view";
import { bindEditorModalInteraction } from "./modal-selection-ownership";

export class MathEditModal extends Modal {
  private text = "";
  private closed = false;
  private focusTimer: number | null = null;
  constructor(
    app: App,
    private initial: string,
    private onSave: (next: string) => boolean | void,
    view: EditorView,
  ) {
    super(app);
    this.text = initial;
    bindEditorModalInteraction(this, view);
  }
  onOpen() {
    this.closed = false;
    if (Platform.isMobile) this.modalEl.addClass("mod-lg");
    const { contentEl, titleEl } = this;
    titleEl.setText(tx("Edit math source"));
    const ta = contentEl.createEl("textarea", { cls: "butter-math-edit-textarea" });
    ta.value = this.initial;
    ta.rows = 8;
    ta.spellcheck = false;
    ta.addEventListener("input", () => { this.text = ta.value; });
    ta.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        this.commit();
      }
    });
    this.focusTimer = window.setTimeout(() => {
      this.focusTimer = null;
      if (!this.closed && this.contentEl.contains(ta)) ta.focus();
    }, 0);

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: tx("Cancel") });
    const saveBtn = btnRow.createEl("button", {
      text: tx("Save"),
      cls: "mod-cta",
    });
    cancelBtn.addEventListener("click", () => this.close());
    saveBtn.addEventListener("click", () => this.commit());
  }
  private commit() {
    if (this.closed) return;
    try {
      if (this.onSave(this.text) === false) return;
    } catch {
      // A host/plugin callback can throw. Keep the editable draft without
      // exposing its formula through an exception message or discarding it.
      new Notice(tx("Something went wrong. Try again in a moment."));
      return;
    }
    this.close();
  }
  onClose() {
    this.closed = true;
    if (this.focusTimer !== null) {
      window.clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    this.contentEl.empty();
  }
}
