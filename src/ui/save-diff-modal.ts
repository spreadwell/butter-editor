/**
 * Save-diff modal.
 *
 * Opens when the user clicks the warning save-status indicator. Shows
 * two side-by-side panes:
 *   • Before - the previous on-disk bytes for this file
 *   • After  - the bytes Butter just wrote
 *
 * Plus a one-line `reason` excerpt from the round-trip guard so the
 * user can see WHY the structure normalized (which path failed and
 * the first divergent block path). No revert button: Obsidian's core
 * File Recovery plugin handles version restoration with the user's
 * regular workflow; we don't reinvent that.
 */

import { App, Modal, Platform } from "obsidian";

export class SaveDiffModal extends Modal {
  constructor(
    app: App,
    private original: string,
    private saved: string,
    private reason: string,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl, modalEl } = this;
    // Mark the host `.modal` so CSS can widen it without a `:has()`
    // query on the diff-wrap child.
    modalEl.classList.add("butter-modal-save-diff");
    if (Platform.isMobile) modalEl.addClass("mod-lg");
    titleEl.setText("Butter - formatting adjusted on save");

    const intro = contentEl.createDiv({ cls: "butter-save-diff-intro" });
    intro.setText(
      "Butter saved your work, but had to adjust some formatting to " +
        "keep the file consistent. Your content is preserved - only the " +
        "layout of certain blocks changed. Compare the previous and new " +
        "versions below. To roll back to a prior save, use Obsidian's " +
        "core File Recovery plugin (Settings > Core plugins > File " +
        "recovery > View recovered files).",
    );

    const reasonEl = contentEl.createDiv({ cls: "butter-save-diff-reason" });
    reasonEl.createSpan({
      cls: "butter-save-diff-reason-label",
      text: "Reason: ",
    });
    reasonEl.createSpan({ text: this.reason });

    const diffWrap = contentEl.createDiv({ cls: "butter-save-diff-wrap" });

    const beforeCol = diffWrap.createDiv({ cls: "butter-save-diff-col" });
    beforeCol.createEl("h4", { text: "Before (previous version)" });
    const beforePre = beforeCol.createEl("pre", {
      cls: "butter-save-diff-pre",
    });
    beforePre.setText(this.original);

    const afterCol = diffWrap.createDiv({ cls: "butter-save-diff-col" });
    afterCol.createEl("h4", { text: "After (current version)" });
    const afterPre = afterCol.createEl("pre", {
      cls: "butter-save-diff-pre",
    });
    afterPre.setText(this.saved);

    const btnRow = contentEl.createDiv({
      cls: "modal-button-container butter-save-diff-buttons",
    });
    const closeBtn = btnRow.createEl("button", {
      text: "Close",
      cls: "mod-cta",
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
