import {
  App,
  Modal,
  Notice,
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