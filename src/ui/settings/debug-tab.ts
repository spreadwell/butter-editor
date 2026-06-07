import { Setting } from "obsidian";
import { ButterSettingTab } from "../settings-tab";

export function renderDebugSection(this: ButterSettingTab, root: HTMLElement) {
    new Setting(root)
      .setName("Verbose debug logging")
      .setDesc("Log internal events to the dev-tools console with a `[butter:...]` prefix. Filter by `butter:` in the console filter box.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseLogging).onChange(async (v) => {
          this.plugin.settings.verboseLogging = v;
          await this.plugin.saveSettings();
        }),
      );
  }