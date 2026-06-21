import {
  App,
  Modal,
  Notice,
  Platform,
} from "obsidian";

export class ErrorLogModal extends Modal {
  constructor(
    app: App,
    private entries: { timestamp: number; category: string; message: string }[],
    private onClear: () => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    if (Platform.isMobile) this.modalEl.addClass("mod-lg");
    titleEl.setText(`Butter - recent errors (${this.entries.length})`);

    if (this.entries.length === 0) {
      contentEl.createEl("p", {
        text: "No errors recorded since plugin load. Things look good.",
      });
      return;
    }

    const desc = contentEl.createEl("p", {
      cls: "setting-item-description",
    });
    desc.setText(
      "Most recent error first. Long-press to copy for a bug " +
        "report. The log keeps the last 50 entries; older ones are " +
        "discarded.",
    );

    const list = contentEl.createDiv({ cls: "butter-error-log-list" });
    // Newest first.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const row = list.createDiv({ cls: "butter-error-log-entry" });
      const meta = row.createEl("div", {
        cls: "butter-error-log-meta",
      });
      const ts = new Date(e.timestamp);
      meta.setText(
        `[${ts.toLocaleTimeString()}] [${e.category}]`,
      );
      const msg = row.createEl("pre", {
        cls: "butter-error-log-msg",
      });
      msg.setText(e.message);
      // Class-driven styles - see .butter-error-log-* in styles.css.
      row.addClass("butter-error-log-row");
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const closeBtn = btnRow.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());
    const clearBtn = btnRow.createEl("button", {
      text: "Clear log",
      cls: "mod-warning",
    });
    clearBtn.addEventListener("click", () => {
      this.onClear();
      this.close();
      new Notice("Butter error log cleared.");
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}
