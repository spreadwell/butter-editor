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

import { App, Modal, Platform } from "obsidian";

export class MathEditModal extends Modal {
  private text = "";
  private saved = false;
  constructor(
    app: App,
    private initial: string,
    private onSave: (next: string) => void,
  ) {
    super(app);
    this.text = initial;
  }
  onOpen() {
    if (Platform.isMobile) this.modalEl.addClass("mod-lg");
    const { contentEl, titleEl } = this;
    titleEl.setText("Edit math source");
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
    window.setTimeout(() => ta.focus(), 0);

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const saveBtn = btnRow.createEl("button", {
      text: "Save",
      cls: "mod-cta",
    });
    cancelBtn.addEventListener("click", () => this.close());
    saveBtn.addEventListener("click", () => this.commit());
  }
  private commit() {
    this.saved = true;
    this.onSave(this.text);
    this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}
