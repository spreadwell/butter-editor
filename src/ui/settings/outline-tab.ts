import { Setting } from "obsidian";
import { ButterSettingTab } from "../settings-tab";

export function renderOutlineSection(this: ButterSettingTab, root: HTMLElement) {
    new Setting(root)
      .setName("Use Butter outline")
      .setDesc("Use Butter's outline sidebar instead of the core outline plugin. The core plugin is disabled while this is on and restored when off.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useButterOutline).onChange(async (v) => {
          this.plugin.settings.useButterOutline = v;
          await this.plugin.saveSettings();
          await this.plugin.applyOutlineMode();
        }),
      );
  }