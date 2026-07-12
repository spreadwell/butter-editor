import { Setting } from "obsidian";
import { ButterSettingTab } from "../settings-tab";
import { tx } from "../../i18n";

export function renderDragSection(this: ButterSettingTab, root: HTMLElement) {
    new Setting(root)
      .setName(tx("Motion"))
      .setDesc(tx("Drag animation feel. Springy bounces; Snappy is direct; Smooth is steady."))
      .addDropdown((d) =>
        d
          .addOptions({
            springy: tx("Springy"),
            snappy: tx("Snappy"),
            smooth: tx("Smooth"),
          })
          .setValue(this.plugin.settings.dragMotion)
          .onChange(async (v) => {
            this.plugin.settings.dragMotion = v as "springy" | "snappy" | "smooth";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName(tx("Handle visibility"))
      .setDesc(tx("When the gutter drag handle appears. Hover: only on the pointed-at block. Always: stays on the nearest block."))
      .addDropdown((d) =>
        d
          .addOptions({
            hover: tx("On hover"),
            always: tx("Always"),
          })
          .setValue(this.plugin.settings.dragHandleVisibility)
          .onChange(async (v) => {
            this.plugin.settings.dragHandleVisibility = v as "hover" | "always";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName(tx("Drag sensitivity"))
      .setDesc(tx("How early a block swaps places while you drag. Higher swaps sooner, with less travel. Zero means the block must fully clear its neighbor first."))
      .addSlider((s) =>
        s
          .setLimits(0, 16, 1)
          .setValue(this.plugin.settings.blockDragSensitivity)
          .onChange(async (v) => {
            this.plugin.settings.blockDragSensitivity = v;
            await this.plugin.saveSettings();
          }),
      );
  }
