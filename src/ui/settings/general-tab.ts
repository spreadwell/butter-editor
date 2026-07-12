import { Setting, Notice } from "obsidian";
import { ButterSettingTab } from "../settings-tab";
import { WelcomeModal, BUTTER_GITHUB_README } from "../welcome-modal";
import { appendInlineNotice } from "../inline-notice";
import { BUTTER_LANGUAGE_OPTIONS, tx, type ButterLanguageSetting, type MessageKey } from "../../i18n";

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

/** High-value shortcuts plus documentation and walkthrough links. */
export function renderGeneralIntroSections(this: ButterSettingTab, root: HTMLElement) {
    const quick = this.createSettingGroup(root, tx("Quick settings"));
    renderRichFormattingSetting(this, quick);

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
            (this as unknown as { display: () => void }).display();
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

    new Setting(quick)
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

    const more = this.createSettingGroup(root, tx("Learn more"));

    new Setting(more)
      .setName(tx("Open feature docs"))
      .setDesc(tx("Opens the Butter README on GitHub. Feature descriptions with screenshots and GIFs."))
      .addButton((b) =>
        b.setButtonText(tx("Open README")).onClick(() => {
          window.open(BUTTER_GITHUB_README, "_blank");
        }),
      );

    new Setting(more)
      .setName(tx("Replay welcome walkthrough"))
      .setDesc(tx("Re-open the welcome walkthrough."))
      .addButton((b) =>
        b.setButtonText(tx("Replay")).onClick(() => {
          new WelcomeModal(this.app, this.plugin).open();
        }),
      );
}

/**
 * General tab - the user's touchbase. Includes the rich-formatting
 * preference, an optional Start-trial CTA visible only when the user
 * has not activated a license or trial, common settings, and help.
 */
export function renderGeneral(this: ButterSettingTab, root: HTMLElement) {
    // Start-trial CTA first - this is the most-common first-session
    // action for any new user. Only renders while the user has never
    // activated a license and isn't mid-trial-activation; once that
    // changes the section disappears and the tab leads with the
    // formatting choice below instead.
    this.renderStartTrialCardIfApplicable(root);

    // High-value shortcuts and help links.
    this.renderGeneralIntroSections(root);
}

/**
 * Behavior tab - the less-common everyday knobs that do not merit a
 * place on the General tab. Outline, drag handle behavior, plugin
 * compatibility, and view-cycle ordering.
 */
export function renderBehavior(this: ButterSettingTab, root: HTMLElement) {
    const outline = this.createSettingGroup(root, tx("Outline"));
    this.renderOutlineSection(outline);

    const formatting = this.createSettingGroup(root, tx("Formatting"));
    renderRichFormattingSetting(this, formatting);

    new Setting(formatting)
      .setName(tx("Markdown typing shortcuts"))
      .setDesc(
        tx("When this is on, typing things like *word*, # Heading, or - List turns them into formatting. Leave it off to keep those characters as text."),
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableMarkdownShortcuts)
          .onChange(async (v) => {
            this.plugin.settings.enableMarkdownShortcuts = v;
            await this.plugin.saveSettings();
            this.plugin.applyMarkdownShortcutSettingToAllViews();
          }),
      );

    const display = this.createSettingGroup(root, tx("Display"));
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

    const cycleSection = this.createSettingGroup(root, tx("View cycle modes"));
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
            .setValue(this.plugin.settings.viewCycleModes.includes(m.id))
            .onChange(async (v) => {
              const current = new Set(this.plugin.settings.viewCycleModes);
              if (v) current.add(m.id);
              else current.delete(m.id);
              // Preserve the canonical order so cycle direction stays
              // consistent regardless of toggle sequence.
              const ordered: Array<typeof m.id> = [];
              for (const id of ["source", "live", "reading", "butter"] as const) {
                if (current.has(id)) ordered.push(id);
              }
              this.plugin.settings.viewCycleModes = ordered;
              await this.plugin.saveSettings();
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

/**
 * Surface a Start-trial CTA card on the General tab while the user
 * has never activated a license / trial. The card disappears once
 * they have a key or a pending activation - this surface is for
 * users who haven't yet engaged with the licensing flow at all.
 * The button bounces them to the License tab where the actual
 * trial activation UI lives.
 */
export function renderStartTrialCardIfApplicable(this: ButterSettingTab, root: HTMLElement) {
  const s = this.plugin.settings;
  const hasKey = typeof s.licenseKey === "string" && s.licenseKey.trim() !== "";
  const trialPending = !!s.pendingTrialActivation;
  const hasActivated = !!s.everValidated || !!s.activatedAt;
  if (hasKey || trialPending || hasActivated) return;

  // Native Setting row so the chrome matches the rest of the
  // settings surface. The CTA bounces to the License tab where
  // the actual activation flow lives.
  new Setting(root)
    .setName(tx("Free Trial Available"))
    .setDesc(
      tx("Butter is paid software with a free trial. No card, no email. You get the full editor for the trial window, then choose whether to license or fall back to read-only."),
    )
    .addButton((b) =>
      b
        .setButtonText(tx("Start free trial"))
        .setCta()
        .onClick(() => {
          this.plugin.startTrialFlow();
        }),
    );
}
