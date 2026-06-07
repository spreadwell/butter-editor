import { Setting } from "obsidian";
import { ButterSettingTab, NormalizeWarningModal } from "../settings-tab";
import { PresetDriftConfirmModal } from "../welcome-modal";
import type { SourcePurityMode } from "../welcome-modal";

export function renderSourceSection(this: ButterSettingTab, root: HTMLElement) {
    const formSection = this.createSettingGroup(root, "Canonical form");

    new Setting(formSection)
      .setName("Bullet marker")
      .setDesc("Character used for unordered list items.")
      .addDropdown((d) =>
        d
          .addOptions({
            "-": "- hyphen (default)",
            "*": "* asterisk",
            "+": "+ plus",
          })
          .setValue(this.plugin.settings.canonicalBullet)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalBullet",
              v,
              "Bullet marker",
            ))) return;
            this.plugin.settings.canonicalBullet = v as "*" | "-" | "+";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName("Italic marker")
      .setDesc("Wrapper for emphasized text.")
      .addDropdown((d) =>
        d
          .addOptions({
            "*": "*text* (default)",
            _: "_text_",
          })
          .setValue(this.plugin.settings.canonicalItalic)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalItalic",
              v,
              "Italic marker",
            ))) return;
            this.plugin.settings.canonicalItalic = v as "*" | "_";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName("Bold marker")
      .setDesc("Wrapper for strong text.")
      .addDropdown((d) =>
        d
          .addOptions({
            "**": "**text** (default)",
            __: "__text__",
          })
          .setValue(this.plugin.settings.canonicalBold)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalBold",
              v,
              "Bold marker",
            ))) return;
            this.plugin.settings.canonicalBold = v as "**" | "__";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName("Code fence character")
      .setDesc("Triple-backtick is the convention; tildes are valid CommonMark too.")
      .addDropdown((d) =>
        d
          .addOptions({
            "```": "``` backtick (default)",
            "~~~": "~~~ tilde",
          })
          .setValue(this.plugin.settings.canonicalCodeFence)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalCodeFence",
              v,
              "Code fence character",
            ))) return;
            this.plugin.settings.canonicalCodeFence = v as "```" | "~~~";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName("Horizontal rule")
      .setDesc("Marker for thematic breaks (`<hr>`).")
      .addDropdown((d) =>
        d
          .addOptions({
            "---": "--- (default)",
            "***": "***",
            ___: "___",
          })
          .setValue(this.plugin.settings.canonicalHorizontalRule)
          .onChange(async (v) => {
            if (!(await this.gateBundledChoice(
              d,
              "canonicalHorizontalRule",
              v,
              "Horizontal rule",
            ))) return;
            this.plugin.settings.canonicalHorizontalRule = v as "---" | "***" | "___";
            await this.plugin.saveSettings();
          }),
      );

    const presSection = this.createSettingGroup(root, "Source preservation");

    const preserveSetting = new Setting(presSection)
      .setName("Preserve original source byte-for-byte")
      .setDesc(
        "Untouched blocks are written back verbatim from the file you opened: whitespace, marker style, indentation, and blank-line counts all preserved. Edited blocks are still re-serialized canonically.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.preserveOriginalSource)
          .onChange(async (v) => {
            if (!(await this.gateBundledToggle(
              t,
              "preserveOriginalSource",
              v,
              "Preserve original source byte-for-byte",
            ))) return;
            this.plugin.settings.preserveOriginalSource = v;
            await this.plugin.saveSettings();
          }),
      );
    preserveSetting.nameEl.createSpan({
      cls: "butter-preset-tag is-experimental",
      text: "Experimental",
    });

    const normSection = this.createSettingGroup(root, "Source normalizers");

    new Setting(normSection)
      .setName("Normalize heading gap to 1 blank line")
      .setDesc("Adds a blank line between a heading and the next block if they're touching. Existing gaps are left alone. Respects fenced code blocks.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.normalizeHeadingGap).onChange(async (v) => {
          if (!(await this.gateBundledToggle(
            t,
            "normalizeHeadingGap",
            v,
            "Normalize heading gap to 1 blank line",
          ))) return;
          if (v && !this.plugin.settings.normalizeWarningAcknowledged) {
            const ok = await this.showWarning();
            if (!ok) {
              t.setValue(this.plugin.settings.normalizeHeadingGap);
              return;
            }
            this.plugin.settings.normalizeWarningAcknowledged = true;
          }
          this.plugin.settings.normalizeHeadingGap = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(normSection)
      .setName("Condense multiple blank lines")
      .setDesc("Cap runs of 2+ blank lines at 1 on save. Respects fenced code blocks.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.condenseBlankLines).onChange(async (v) => {
          if (!(await this.gateBundledToggle(
            t,
            "condenseBlankLines",
            v,
            "Condense multiple blank lines",
          ))) return;
          if (v && !this.plugin.settings.normalizeWarningAcknowledged) {
            const ok = await this.showWarning();
            if (!ok) {
              t.setValue(this.plugin.settings.condenseBlankLines);
              return;
            }
            this.plugin.settings.normalizeWarningAcknowledged = true;
          }
          this.plugin.settings.condenseBlankLines = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(normSection)
      .setName("Close unclosed code fences")
      .setDesc("Append a closing fence when the file ends mid-fence. Prevents later edits from being swallowed when parsers extend the fence to end-of-file. Top-level fences only.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.closeUnclosedFences).onChange(async (v) => {
          if (!(await this.gateBundledToggle(
            t,
            "closeUnclosedFences",
            v,
            "Close unclosed code fences",
          ))) return;
          if (v && !this.plugin.settings.normalizeWarningAcknowledged) {
            const ok = await this.showWarning();
            if (!ok) {
              t.setValue(this.plugin.settings.closeUnclosedFences);
              return;
            }
            this.plugin.settings.normalizeWarningAcknowledged = true;
          }
          this.plugin.settings.closeUnclosedFences = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(normSection)
      .setName("Auto-split full-width images into their own block")
      .setDesc("Move full-width inline images into their own paragraph. Sized embeds (with `|WIDTH`) stay inline.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.splitFullWidthImages).onChange(async (v) => {
          if (!(await this.gateBundledToggle(
            t,
            "splitFullWidthImages",
            v,
            "Auto-split full-width images into their own block",
          ))) return;
          this.plugin.settings.splitFullWidthImages = v;
          await this.plugin.saveSettings();
        }),
      );

    // Discoverability: palette commands for one-shot cleanup that
    // apply regardless of the global toggles above.
    const commandNote = normSection.createDiv({ cls: "setting-item-description" });
    commandNote.createEl("div", {
      text:
        "Three palette commands clean files on demand. Tidy whitespace applies the normalizers above. Rewrite current note re-serializes with your canonical preferences. Rewrite entire vault does the same across all notes (commit to Git first).",
    });
  }

/** Show a blocking warning modal. Resolves to true if the user
   *  confirms, false if they cancel. Used as the first-enable gate
   *  for normalization toggles so users don't accidentally rewrite
   *  their entire vault. */
  export function showWarning(this: ButterSettingTab): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new NormalizeWarningModal(this.app, resolve);
      modal.open();
    });
  }

/** Show the preset-drift confirm modal when a bundled setting
   *  changes would move the user out of an active preset. Resolves
   *  true on confirm (apply the change), false on cancel (revert). */
  export function confirmPresetDrift(this: ButterSettingTab, activePreset: SourcePurityMode, settingLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      new PresetDriftConfirmModal(
        this.app,
        activePreset,
        settingLabel,
        resolve,
      ).open();
    });
  }