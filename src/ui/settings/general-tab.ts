import { Setting, Notice } from "obsidian";
import { ButterSettingTab } from "../settings-tab";
import { appendInlineNotice } from "../inline-notice";
import { BUTTER_LANGUAGE_OPTIONS, tx, type ButterLanguageSetting, type MessageKey } from "../../i18n";
import {
  allMarkdownShortcutSettings,
  type MarkdownShortcutKey,
} from "../../editor/markdown-shortcuts";

function renderRichFormattingSetting(
  tab: ButterSettingTab,
  parent: HTMLElement,
): void {
  const richSetting = new Setting(parent)
    .setName(tx("Rich formatting"))
    .addToggle((toggle) =>
      toggle
        .setValue(tab.plugin.settings.enableHtmlFormatting)
        .onChange(async (enabled) => {
          tab.plugin.settings.enableHtmlFormatting = enabled;
          await tab.plugin.saveSettings();
          tab.plugin.applyToolbarButtonVisibilityToAllViews();
        }),
    );

  richSetting.descEl.empty();
  richSetting.descEl.createDiv({
    text: tx("Adds text color, custom highlights, underline, superscript, and subscript."),
  });
  appendInlineNotice(
    richSetting.descEl,
    tx("Uses HTML, which can make notes less portable and harder to read in source view."),
  );
}

/** General app integration and view-navigation preferences. */
export function renderGeneralIntroSections(this: ButterSettingTab, root: HTMLElement) {
    const quick = this.createSettingGroup(root, tx("General"));

    const languageSetting = new Setting(quick)
      .setName(tx("Language"))
      .setDesc(tx("Choose the language used by Butter's own buttons, menus, and settings."))
      .addDropdown((d) => {
        for (const option of BUTTER_LANGUAGE_OPTIONS) {
          d.addOption(option.value, option.translateLabel ? tx(option.label) : option.label);
        }
        d
          .setValue(this.plugin.settings.uiLanguage)
          .onChange(async (v) => {
            this.plugin.settings.uiLanguage = v as ButterLanguageSetting;
            this.plugin.applyI18nLanguage();
            await this.plugin.saveSettings();
            this.refreshSettingsUi();
          });
      });
    appendInlineNotice(languageSetting.descEl, tx("Experimental"), "warning");

    new Setting(quick)
      .setName(tx("Open notes in Butter"))
      .setDesc(tx("Markdown files open directly in Butter. Reload Obsidian after toggling."))
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.openNewFilesInButter)
          .onChange(async (v) => {
            this.plugin.settings.openNewFilesInButter = v;
            await this.plugin.saveSettings();
            new Notice(
              tx("Reload Obsidian for this change to take full effect."),
              5000,
            );
          }),
      );

    this.renderOutlineSection(quick);

    const cycleSection = this.createSettingGroup(root, tx("View cycle modes"));
    renderViewCycleModes(this, cycleSection);
}

/**
 * General tab - the user's touchbase. Includes the rich-formatting
 * preference, an optional Start-trial CTA visible only when the user
 * has not activated a license or trial, common settings, and help.
 */
export function renderGeneral(this: ButterSettingTab, root: HTMLElement) {
    this.renderGeneralIntroSections(root);
}

/**
 * Editor page - writing and display preferences that affect everyday
 * interaction with note content.
 */
export function renderEditor(this: ButterSettingTab, root: HTMLElement) {
    const formatting = this.createSettingGroup(root, tx("Formatting"));
    renderRichFormattingSetting(this, formatting);

    const display = this.createSettingGroup(root, tx("Display"));
    new Setting(display)
      .setName(tx("Animations"))
      .setDesc(tx("Entrance fades, drag springs, hint transitions, and other motion polish. Turn off for slower machines, accessibility, or screen recordings."))
      .addToggle((t) =>
        t
          .setValue(!this.plugin.settings.disableAnimations)
          .onChange(async (v) => {
            this.plugin.settings.disableAnimations = !v;
            await this.plugin.saveSettings();
            this.plugin.applyAnimationsBodyClass();
          }),
      );

    new Setting(display)
      .setName(tx("Frontmatter visibility"))
      .setDesc(tx("Control whether the properties/frontmatter panel is shown at the top of notes."))
      .addDropdown((d) =>
        d
          .addOption("match", tx("Match Obsidian"))
          .addOption("visible", tx("Always visible"))
          .addOption("hidden", tx("Always hidden"))
          .setValue(this.plugin.settings.frontmatterVisibility)
          .onChange(async (v) => {
            this.plugin.settings.frontmatterVisibility = v as "match" | "visible" | "hidden";
            await this.plugin.saveSettings();
            this.plugin.refreshAllButterViews();
          }),
      );

    new Setting(display)
      .setName(tx("List indentation guides"))
      .setDesc(tx("Show vertical lines connecting nested list levels."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showListIndentGuides).onChange(async (v) => {
          this.plugin.settings.showListIndentGuides = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAllButterViews();
        }),
      );

    new Setting(display)
      .setName(tx("Save status icon"))
      .setDesc(tx("Show a checkmark for clean saves and a warning for blocked or normalized saves in Obsidian's status bar."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showSaveStatusIcon).onChange(async (v) => {
          this.plugin.settings.showSaveStatusIcon = v;
          await this.plugin.saveSettings();
          this.plugin.applySaveStatusSetting();
        }),
      );

    renderMarkdownTypingShortcuts(this, root);
}

function renderMarkdownTypingShortcuts(
  tab: ButterSettingTab,
  root: HTMLElement,
): void {
  const shortcuts = tab.createSettingGroup(
    root,
    tx("Markdown typing shortcuts"),
  );
  const setAllMarkdownShortcuts = async (enabled: boolean): Promise<void> => {
    tab.plugin.settings.markdownShortcuts =
      allMarkdownShortcutSettings(enabled);
    await tab.plugin.saveSettings();
    tab.plugin.applyMarkdownShortcutSettingToAllViews();
    tab.refreshSettingsUi();
  };

  new Setting(shortcuts)
    .setName(tx("All"))
    .addButton((button) =>
      button
        .setButtonText(tx("Enable all"))
        .onClick(() => void setAllMarkdownShortcuts(true)),
    )
    .addButton((button) =>
      button
        .setButtonText(tx("Disable all"))
        .onClick(() => void setAllMarkdownShortcuts(false)),
    );

  const shortcutGroups: Array<{
    title: MessageKey;
    entries: Array<{
      key: MarkdownShortcutKey;
      label: MessageKey;
      syntax: string;
    }>;
  }> = [
    {
      title: "Inline marks",
      entries: [
        { key: "bold", label: "Bold", syntax: "**text**  __text__" },
        { key: "italic", label: "Italic", syntax: "*text*  _text_" },
        { key: "highlight", label: "Highlight", syntax: "==text==" },
        { key: "strikethrough", label: "Strikethrough", syntax: "~~text~~" },
        { key: "inlineCode", label: "Inline code", syntax: "`code`" },
        { key: "inlineMath", label: "Inline math", syntax: "$x + 1$" },
      ],
    },
    {
      title: "Links and metadata",
      entries: [
        { key: "wikilinks", label: "Wikilink", syntax: "[[Note]]" },
        { key: "markdownLinks", label: "Link", syntax: "[text](url)" },
        { key: "tags", label: "Tag", syntax: "#tag" },
      ],
    },
    {
      title: "Block types",
      entries: [
        { key: "headings", label: "Headings", syntax: "# Heading" },
        { key: "blockquotes", label: "Blockquote", syntax: "> Quote" },
        { key: "bulletLists", label: "Bullet list", syntax: "- List" },
        { key: "numberedLists", label: "Numbered list", syntax: "1. List" },
        { key: "taskLists", label: "Task list", syntax: "- [ ] Task" },
        { key: "codeBlocks", label: "Code block", syntax: "```lang" },
        { key: "horizontalRules", label: "Horizontal rule", syntax: "---" },
      ],
    },
  ];

  for (const group of shortcutGroups) {
    new Setting(shortcuts).setName(tx(group.title)).setHeading();
    for (const entry of group.entries) {
      const setting = new Setting(shortcuts)
        .setName(tx(entry.label))
        .addToggle((toggle) =>
          toggle
            .setValue(tab.plugin.settings.markdownShortcuts[entry.key])
            .onChange(async (enabled) => {
              tab.plugin.settings.markdownShortcuts[entry.key] = enabled;
              await tab.plugin.saveSettings();
              tab.plugin.applyMarkdownShortcutSettingToAllViews();
            }),
        );
      setting.descEl.createEl("code", { text: entry.syntax });
    }
  }
}

/** Block movement, insertion, paste, and file-drop preferences. */
export function renderDragAndDrop(this: ButterSettingTab, root: HTMLElement) {
    const dragDrop = this.createSettingGroup(root, tx("Drag and drop"));
    this.renderDragSection(dragDrop);
    new Setting(dragDrop)
      .setName(tx("Rich paste and file drop"))
      .setDesc(tx("Pasted URLs become links. HTML pastes as Markdown. Images and files dropped on the editor save to the vault and embed."))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enablePasteDrop).onChange(async (v) => {
          this.plugin.settings.enablePasteDrop = v;
          await this.plugin.saveSettings();
        }),
      );
}

function renderViewCycleModes(tab: ButterSettingTab, cycleSection: HTMLElement): void {
    const cycleModes: Array<{
      id: "source" | "live" | "reading" | "butter";
      label: MessageKey;
      desc: MessageKey;
    }> = [
      { id: "source", label: "Source", desc: "Raw markdown text." },
      {
        id: "live",
        label: "Live Preview",
        desc: "Obsidian's default editor - markdown with inline rendering.",
      },
      {
        id: "reading",
        label: "Reading",
        desc: "Read-only rendered view.",
      },
      {
        id: "butter",
        label: "Butter",
        desc: "Butter's WYSIWYG editor (this plugin).",
      },
    ];
    for (const m of cycleModes) {
      new Setting(cycleSection)
        .setName(tx(m.label))
        .setDesc(tx(m.desc))
        .addToggle((t) =>
          t
            .setValue(tab.plugin.settings.viewCycleModes.includes(m.id))
            .onChange(async (v) => {
              const current = new Set(tab.plugin.settings.viewCycleModes);
              if (v) current.add(m.id);
              else current.delete(m.id);
              // Preserve the canonical order so cycle direction stays
              // consistent regardless of toggle sequence.
              const ordered: Array<typeof m.id> = [];
              for (const id of ["source", "live", "reading", "butter"] as const) {
                if (current.has(id)) ordered.push(id);
              }
              tab.plugin.settings.viewCycleModes = ordered;
              await tab.plugin.saveSettings();
            }),
        );
    }
}

/**
 * Advanced tab - power-user surface. Source preservation and
 * normalization options, canonical glyph choices, experimental
 * flags, theme compatibility, and debug controls.
 */
export function renderAdvanced(this: ButterSettingTab, root: HTMLElement) {
  // Source preservation + canonical-glyph + normalize options.
  this.renderSourceSection(root);

  const resilience = this.createSettingGroup(root, tx("Input resilience"));
  new Setting(resilience)
    .setName(tx("Mouse release protection"))
    .setDesc(tx("Keeps a block drag active through an extremely brief mouse-button dropout. Automatic adds a sub-frame confirmation; Strong tolerates a longer faulty-switch gap."))
    .addDropdown((dropdown) =>
      dropdown
        .addOptions({
          off: tx("Off"),
          automatic: tx("Automatic"),
          strong: tx("Strong"),
        })
        .setValue(this.plugin.settings.mouseReleaseProtection)
        .onChange(async (value) => {
          this.plugin.settings.mouseReleaseProtection = value as
            | "off"
            | "automatic"
            | "strong";
          await this.plugin.saveSettings();
        }),
    );

  // Compatibility bridges. Each adapts an Obsidian API or theme
  // surface that assumes the native CM6 MarkdownView to Butter's
  // PM editor. Grouped together because they're conceptually
  // related, with per-row experimental notices where appropriate.
  const compat = this.createSettingGroup(root, tx("Compatibility"));
  new Setting(compat)
    .setName(tx("Plugin autocomplete pop-ups"))
    .setDesc(tx("Show autocomplete pop-ups from other plugins as you type, like emoji, mentions, or dates. Press esc to dismiss."))
    .addToggle((t) =>
      t
        .setValue(this.plugin.settings.enableSuggestBridge)
        .onChange(async (v) => {
          this.plugin.settings.enableSuggestBridge = v;
          await this.plugin.saveSettings();
        }),
    );
  const themeCompat = new Setting(compat)
    .setName(tx("Max theme compatibility"))
    .setDesc(tx("Let more theme styles apply inside Butter by sharing a class with reading mode. Gives better theme coverage, but some themes may interfere with editing."))
    .addToggle((t) =>
      t
        .setValue(this.plugin.settings.experimentalThemeCompatMode)
        .onChange(async (v) => {
          this.plugin.settings.experimentalThemeCompatMode = v;
          await this.plugin.saveSettings();
          this.plugin.applyThemeCompatModeToAllViews();
        }),
    );
  appendInlineNotice(themeCompat.descEl, tx("Experimental"), "warning");

  // Debug controls last - usually only touched when investigating
  // an issue.
  const debug = this.createSettingGroup(root, tx("Debug"));
  this.renderDebugSection(debug);
}
