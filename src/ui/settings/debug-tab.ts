import { Setting } from "obsidian";
import { ButterSettingTab } from "../settings-tab";

export function renderDebugSection(this: ButterSettingTab, root: HTMLElement) {
    new Setting(root)
      .setName("Verbose debug logging")
      .setDesc("Log internal events to the browser console (Ctrl+Shift+I on desktop). Lines are prefixed with [butter:] for easy filtering.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseLogging).onChange(async (v) => {
          this.plugin.settings.verboseLogging = v;
          await this.plugin.saveSettings();
        }),
      );
  }