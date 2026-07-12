import { Setting } from "obsidian";
import { ButterSettingTab, NormalizeWarningModal } from "../settings-tab";
import { appendInlineNotice } from "../inline-notice";
import { tx } from "../../i18n";

export function renderSourceSection(this: ButterSettingTab, root: HTMLElement) {
    const formSection = this.createSettingGroup(root, tx("Formatting style"));

    new Setting(formSection)
      .setName(tx("Bullet marker"))
      .setDesc(tx("Character used for unordered list items."))
      .addDropdown((d) =>
        d
          .addOptions({
            "-": "- hyphen (default)",
            "*": "* asterisk",
            "+": "+ plus",
          })
          .setValue(this.plugin.settings.canonicalBullet)
          .onChange(async (v) => {
            this.plugin.settings.canonicalBullet = v as "*" | "-" | "+";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName(tx("Italic marker"))
      .setDesc(tx("Character used to italicize text."))
      .addDropdown((d) =>
        d
          .addOptions({
            "*": "*text* (default)",
            _: "_text_",
          })
          .setValue(this.plugin.settings.canonicalItalic)
          .onChange(async (v) => {
            this.plugin.settings.canonicalItalic = v as "*" | "_";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName(tx("Bold marker"))
      .setDesc(tx("Character used to bold text."))
      .addDropdown((d) =>
        d
          .addOptions({
            "**": "**text** (default)",
            __: "__text__",
          })
          .setValue(this.plugin.settings.canonicalBold)
          .onChange(async (v) => {
            this.plugin.settings.canonicalBold = v as "**" | "__";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName(tx("Code fence character"))
      .setDesc(tx("Triple-backtick is the standard; tildes are an alternative."))
      .addDropdown((d) =>
        d
          .addOptions({
            "```": "``` backtick (default)",
            "~~~": "~~~ tilde",
          })
          .setValue(this.plugin.settings.canonicalCodeFence)
          .onChange(async (v) => {
            this.plugin.settings.canonicalCodeFence = v as "```" | "~~~";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(formSection)
      .setName(tx("Horizontal rule"))
      .setDesc(tx("Character used for horizontal divider lines."))
      .addDropdown((d) =>
        d
          .addOptions({
            "---": "--- (default)",
            "***": "***",
            ___: "___",
          })
          .setValue(this.plugin.settings.canonicalHorizontalRule)
          .onChange(async (v) => {
            this.plugin.settings.canonicalHorizontalRule = v as "---" | "***" | "___";
            await this.plugin.saveSettings();
          }),
      );

    const presSection = this.createSettingGroup(root, tx("Source preservation"));

    const preserveSetting = new Setting(presSection)
      .setName(tx("Preserve original formatting exactly"))
      .setDesc(
        tx("Parts of the note you didn't edit stay exactly as they were in the original file: spacing, formatting style, and blank lines all preserved. Sections you edited are saved in Butter's standard clean format."),
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.preserveOriginalSource)
          .onChange(async (v) => {
            this.plugin.settings.preserveOriginalSource = v;
            await this.plugin.saveSettings();
          }),
      );
    appendInlineNotice(preserveSetting.descEl, tx("Experimental"), "warning");

    const normSection = this.createSettingGroup(root, tx("Source normalizers"));

    new Setting(normSection)
      .setName(tx("Normalize heading gap to 1 blank line"))
      .setDesc(tx("Adds a blank line between a heading and the next block if they're touching. Existing gaps are left alone. Respects fenced code blocks."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.normalizeHeadingGap).onChange(async (v) => {
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
      .setName(tx("Condense multiple blank lines"))
      .setDesc(tx("Cap runs of 2+ blank lines at 1 on save. Respects fenced code blocks."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.condenseBlankLines).onChange(async (v) => {
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
      .setName(tx("Close unclosed code fences"))
      .setDesc(tx("Add a closing fence when the file ends inside an open code block. Prevents new content below the block from being treated as part of it."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.closeUnclosedFences).onChange(async (v) => {
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
      .setName(tx("Auto-split full-width images into their own block"))
      .setDesc(tx("Move full-width inline images into their own paragraph. Sized embeds (with `|WIDTH`) stay inline."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.splitFullWidthImages).onChange(async (v) => {
          this.plugin.settings.splitFullWidthImages = v;
          await this.plugin.saveSettings();
        }),
      );

    // Discoverability: palette commands for one-shot cleanup that
    // apply regardless of the global toggles above.
    const commandNote = normSection.createDiv({ cls: "setting-item-description" });
    commandNote.createEl("div", {
      text:
        tx("Three commands (find them in the command palette) clean files on demand. 'tidy whitespace' applies the cleanup options above. 'rewrite current note' reformats the whole note with your marker choices. 'rewrite entire vault' does the same across all notes (back up with Git first)."),
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
