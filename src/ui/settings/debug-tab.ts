import { Setting } from "obsidian";
import { ButterSettingTab } from "../settings-tab";
import { tx } from "../../i18n";

export function renderDebugSection(this: ButterSettingTab, root: HTMLElement) {
    new Setting(root)
      .setName(tx("Verbose debug logging"))
      .setDesc(tx("Log internal events to the browser console (Ctrl+Shift+I on desktop). Lines are prefixed with [butter:] for easy filtering."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseLogging).onChange(async (v) => {
          this.plugin.settings.verboseLogging = v;
          await this.plugin.saveSettings();
        }),
      );
  }
