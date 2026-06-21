import {
  App,
  Modal,
  Platform,
} from "obsidian";

export class CanonicalizeVaultModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private fileCount: number,
    private resolve: (ok: boolean) => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    if (Platform.isMobile) this.modalEl.addClass("mod-lg");
    titleEl.setText("Reformat entire vault?");
    contentEl.createEl("p", {
      text:
        `This will reformat every markdown file in the vault (${this.fileCount} files) using your current marker preferences. Each file is opened, reformatted, and saved.`,
    });
    contentEl.createEl("p", {
      text:
        "This is not undoable from inside Butter. Strongly recommended: commit your vault to Git first, so you have a recovery point if a file's new formatting turns out to be unexpected.",
    });
    contentEl.createEl("p", {
      text:
        "Files that can't be read will be skipped and reported. Files already matching your preferences won't be touched.",
    });
    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const okBtn = btnRow.createEl("button", {
      text: "Reformat all files",
      cls: "mod-warning",
    });
    cancelBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolve(false);
      this.close();
    });
    okBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolve(true);
      this.close();
    });
  }
  onClose() {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}
