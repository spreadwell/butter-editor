import { Setting } from "obsidian";
import { ButterSettingTab } from "../settings-tab";
import { tx } from "../../i18n";

export function renderOutlineSection(this: ButterSettingTab, root: HTMLElement) {
    new Setting(root)
      .setName(tx("Use Butter outline"))
      .setDesc(tx("Replace Obsidian's built-in outline sidebar with Butter's version. The built-in outline is disabled while this is on and restored when off."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useButterOutline).onChange(async (v) => {
          this.plugin.settings.useButterOutline = v;
          await this.plugin.saveSettings();
          await this.plugin.applyOutlineMode();
        }),
      );
  }
