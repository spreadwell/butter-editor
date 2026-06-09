import {
  App,
  Modal,
  Platform,
} from "obsidian";

// Extensions MUST be registered before schema.ts or obsidian-md-bridge
// evaluate their module bodies - those are where the registry is
// read to build the live schema / token handlers / serializers.
// The internal Extension API exists, but no example extensions are
// activated in shipped builds. The dogfooded `:::spoiler` block +
// `@username` inline atom previously imported from
// `./integration/extensions-examples` are now developer reference
// only (see that file's header). To turn them back on for local
// dev / testing, re-add the side-effect import here ABOVE the
// schema/parser/serializer imports below.



import {
  type LayoutItem as ToolbarLayoutItem,
} from "../../ui/toolbar-layout";
export type { ToolbarLayoutItem };











export const VIEW_TYPE_BUTTER = "butter-editor";
export const VIEW_TYPE_BUTTER_LOCKED = "butter-locked-file";

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