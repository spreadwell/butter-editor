import { Setting } from "obsidian";
import { ButterSettingTab } from "../settings-tab";

export function renderDragSection(this: ButterSettingTab, root: HTMLElement) {
    new Setting(root)
      .setName("Motion")
      .setDesc("Drag animation feel. Springy bounces; Snappy is direct; Smooth is steady.")
      .addDropdown((d) =>
        d
          .addOptions({
            springy: "Springy",
            snappy: "Snappy",
            smooth: "Smooth",
          })
          .setValue(this.plugin.settings.dragMotion)
          .onChange(async (v) => {
            this.plugin.settings.dragMotion = v as "springy" | "snappy" | "smooth";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Handle visibility")
      .setDesc("When the gutter drag handle appears. Hover: only on the pointed-at block. Always: stays on the nearest block.")
      .addDropdown((d) =>
        d
          .addOptions({
            hover: "On hover",
            always: "Always",
          })
          .setValue(this.plugin.settings.dragHandleVisibility)
          .onChange(async (v) => {
            this.plugin.settings.dragHandleVisibility = v as "hover" | "always";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(root)
      .setName("Drag sensitivity")
      .setDesc("How early a block swaps places while you drag. Higher swaps sooner, with less travel. Zero means the block must fully clear its neighbor first.")
      .addSlider((s) =>
        s
          .setLimits(0, 16, 1)
          .setValue(this.plugin.settings.blockDragSensitivity)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.blockDragSensitivity = v;
            await this.plugin.saveSettings();
          }),
      );
  }