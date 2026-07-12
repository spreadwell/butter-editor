import {
  ItemView,
  setIcon,
  Notice,
  TFile,
  WorkspaceLeaf,
  ViewStateResult,
} from "obsidian";

// Extension registration must happen before schema.ts or obsidian-md-bridge
// evaluate their module bodies. Example extensions are not activated in
// shipped builds.


import {
  type LayoutItem as ToolbarLayoutItem,
} from "../ui/toolbar-layout";
export type { ToolbarLayoutItem };











export const VIEW_TYPE_BUTTER = "butter-editor";
export const VIEW_TYPE_BUTTER_LOCKED = "butter-locked-file";
import type ButterEditorPlugin from "../main";
import { tx } from "../i18n";

export /**
 * Replacement view for a leaf whose file failed to load with a
 * file-system permission error (EPERM / EBUSY / EACCES) - typically
 * because another process (VS Code, antivirus, another Obsidian
 * window) is holding the file open exclusively. Instead of leaving
 * the user with a silent failure + cryptic console error, this view
 * takes over the leaf and explains what's happening with native-
 * styled action buttons. The leaf can flip back to a normal markdown/
 * Butter view at any time via the "Try again" button.
 */
class ButterLockedFileView extends ItemView {
  private lockedPath = "";
  private lockedName = "";

  constructor(leaf: WorkspaceLeaf, private plugin: ButterEditorPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BUTTER_LOCKED;
  }

  getDisplayText(): string {
    return this.lockedName || tx("Locked file");
  }

  getIcon(): string {
    return "lock";
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as { lockedPath?: string; lockedName?: string } | null;
    this.lockedPath = s?.lockedPath ?? "";
    this.lockedName =
      s?.lockedName ??
      (this.lockedPath.split(/[\\/]/).pop() || this.lockedPath);
    this.render();
    await super.setState(state, result);
  }

  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      lockedPath: this.lockedPath,
      lockedName: this.lockedName,
    };
  }

  async onOpen() {
    this.render();
  }

  private render() {
    const c = this.contentEl;
    c.empty();
    // Use native `.empty-state` so the layout, title styling, and
    // action-button treatment (pill on mobile, plain link on
    // desktop) match Obsidian's new-tab page exactly. A Butter-
    // specific wrapper class is added too for our message + footer
    // styling, scoped so we don't bleed into other empty states.
    c.addClass("empty-state");
    c.addClass("butter-locked-state");

    const container = c.createDiv({ cls: "empty-state-container" });

    const iconEl = container.createDiv({ cls: "butter-locked-icon" });
    setIcon(iconEl, "file-lock-2");

    container.createEl("h1", {
      text: tx("Another app is using this file"),
      cls: "empty-state-title",
    });

    const desc = container.createDiv({ cls: "butter-locked-message" });
    desc.createEl("code", {
      text: this.lockedName,
      cls: "butter-locked-filename",
    });
    desc.appendText(
      tx(" can't be opened because another app is using it. Common causes: VS Code with the file open, antivirus scanning, or another Obsidian window."),
    );

    const actions = container.createDiv({ cls: "empty-state-action-list" });

    const retryBtn = actions.createDiv({
      cls: "empty-state-action",
      text: tx("Try again"),
    });
    retryBtn.addEventListener("click", () => {
      void (async () => {
        const file = this.app.vault.getAbstractFileByPath(this.lockedPath);
        if (file instanceof TFile) {
          await this.leaf.openFile(file);
        } else {
          new Notice(tx("File no longer exists in vault."));
        }
      })();
    });

    const switcherBtn = actions.createDiv({
      cls: "empty-state-action",
      text: tx("Open another note"),
    });
    switcherBtn.addEventListener("click", () => {
      this.app.commands?.executeCommandById("switcher:open");
    });

    const newBtn = actions.createDiv({
      cls: "empty-state-action",
      text: tx("New note"),
    });
    newBtn.addEventListener("click", () => {
      this.app.commands?.executeCommandById("file-explorer:new-file");
    });
  }
}
