import { Setting, Notice, setIcon } from "obsidian";
import { ButterSettingTab } from "../settings-tab";
import { WelcomeModal, SourcePurityConfirmModal, BUTTER_GITHUB_README, matchActivePreset } from "../welcome-modal";
import type { SourcePurityMode } from "../welcome-modal";

/**
   * Composes the intro sections used at the top of the General tab:
   * the "What is Butter" blurb, the source-purity preset cards, and
   * the "Learn more" links / walkthrough replay. Pulled out as a
   * helper so renderGeneral can wrap these with the trial card and
   * everyday toggles without duplicating any of the long copy.
   */
  export function renderGeneralIntroSections(this: ButterSettingTab, root: HTMLElement) {
    // ── Settings Presets ──
    const purity = this.createSettingGroup(root, "Settings Presets");

    // Match-based active preset. Null when the bundled settings have
    // drifted away from every preset (Custom state).
    const activeMode = matchActivePreset(this.plugin);

    // Custom-state indicator. Appears only when no preset matches.
    // Sits as a dimmed line above the cards; applying any preset
    // below clears the state by overwriting the bundled settings.
    if (activeMode === null) {
      purity.createEl("p", {
        cls: "setting-item-description butter-preset-custom-indicator",
        text:
          "Custom: your bundled settings don't match any preset. Apply one below to return to a known baseline.",
      });
    }

    const purityOptions: Array<{
      mode: SourcePurityMode;
      label: string;
      icon: string;
      tag?: string;
      bestFor: string;
      rest: string;
    }> = [
      {
        mode: "strict",
        label: "Plain markdown",
        icon: "file-text",
        tag: "Default",
        bestFor: "Best for simple notes that work everywhere.",
        rest:
          "Maximum cross-app compatibility. Font color, inline styles, and other HTML extras stay off so your files read cleanly anywhere and version-control diffs stay tidy.",
      },
      {
        mode: "rich",
        label: "Rich formatting",
        icon: "paintbrush",
        bestFor: "Best for colorful, freely styled notes.",
        rest:
          "If you just want to color and style your notes how you want without worrying about markdown source then use this preset. This mixes some HTML into your note under the hood; invisible to you but some don't prefer that.",
      },
    ];

    for (const opt of purityOptions) {
      const setting = new Setting(purity).setName(opt.label);
      const isActive = activeMode === opt.mode;
      // Prepend the preset's icon. Inline-flex, muted color, sized
      // to match the row's text height. Same chrome as the other
      // icon-prefixed setting rows (Customize buttons, etc.).
      const presetIcon = createSpan({ cls: "butter-preset-icon" });
      setIcon(presetIcon, opt.icon);
      setting.nameEl.prepend(presetIcon);
      // Render optional tag (e.g. "Default", "Experimental") as a
      // dimmed-italic span next to the name. Reads as a label
      // annotation rather than a parenthetical, which lets the title
      // stand on its own typographically.
      if (opt.tag) {
        setting.nameEl.createSpan({
          cls:
            "butter-preset-tag" +
            (opt.tag === "Experimental" ? " is-experimental" : ""),
          text: opt.tag,
        });
      }
      // Build the description manually so the "best for" lead sentence
      // can render in the theme accent color. setDesc(string) doesn't
      // allow per-span styling, so we populate descEl directly.
      setting.descEl.empty();
      setting.descEl.createSpan({
        cls: "butter-preset-best-for",
        text: opt.bestFor,
      });
      setting.descEl.appendText(" " + opt.rest);
      setting.addButton((b) => {
        if (isActive) {
          b.setButtonText("Currently active").setDisabled(true);
        } else {
          b.setButtonText("Apply preset")
            .setCta()
            .onClick(() => {
              new SourcePurityConfirmModal(
                this.app,
                this.plugin,
                opt.mode,
                () => (this as unknown as { display: () => void }).display(),
              ).open();
            });
        }
      });
    }

    // Tail row: not a preset, just a pointer to the Advanced tab's
    // source-preservation toggle. Lets users who want exact-byte
    // file fidelity find the right control without us framing it as
    // a one-click preset (which it isn't - it's an advanced setting
    // in its own right with its own gotchas).
    const preserveRow = new Setting(purity).setName("Source preservation");
    const preserveIcon = createSpan({ cls: "butter-preset-icon" });
    setIcon(preserveIcon, "code-2");
    preserveRow.nameEl.prepend(preserveIcon);
    preserveRow.descEl.empty();
    preserveRow.descEl.createSpan({
      cls: "butter-preset-best-for",
      text: "Best for keeping your files exactly as written.",
    });
    preserveRow.descEl.appendText(
      " Useful for git-tracked vaults or hand-formatted notes. Find the toggle and related normalizers under the Advanced tab.",
    );
    preserveRow.addButton((b) =>
      b
        .setButtonText("Open advanced")
        .onClick(() => {
          this.activeTab = "advanced";
          (this as unknown as { display: () => void }).display();
        }),
    );

    // ── Learn more / replay ──
    const more = this.createSettingGroup(root, "Learn more");

    new Setting(more)
      .setName("Open feature docs")
      .setDesc("Opens the Butter README on GitHub. Feature descriptions with screenshots and GIFs.")
      .addButton((b) =>
        b.setButtonText("Open README").onClick(() => {
          window.open(BUTTER_GITHUB_README, "_blank");
        }),
      );

    new Setting(more)
      .setName("Replay welcome walkthrough")
      .setDesc("Re-open the welcome walkthrough.")
      .addButton((b) =>
        b.setButtonText("Replay").onClick(() => {
          new WelcomeModal(this.app, this.plugin).open();
        }),
      );
  }

/**
   * General tab - the user's touchbase. Intro blurb explaining Butter,
   * the source-purity preset cards (the headline configuration
   * choice), an optional Start-trial CTA card visible only when the
   * user hasn't yet activated a license / trial, the most-frequently-
   * toggled settings, and a Learn more section with docs link and
   * walkthrough replay.
   */
  export function renderGeneral(this: ButterSettingTab, root: HTMLElement) {
    // Start-trial CTA first - this is the most-common first-session
    // action for any new user. Only renders while the user has never
    // activated a license and isn't mid-trial-activation; once that
    // changes the section disappears and the tab leads with the
    // preset intro below instead.
    this.renderStartTrialCardIfApplicable(root);

    // Intro + source-purity presets. Composed from a shared helper so
    // the long copy lives in one place.
    this.renderGeneralIntroSections(root);

    // Most-common toggles. These are the knobs new users most often
    // want to change; less-common behavior settings live in the
    // Behavior tab.
    const common = this.createSettingGroup(root, "Common settings");

    new Setting(common)
      .setName("Open notes in Butter")
      .setDesc("Markdown files open directly in Butter. Reload Obsidian after toggling.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.openNewFilesInButter)
          .onChange(async (v) => {
            this.plugin.settings.openNewFilesInButter = v;
            await this.plugin.saveSettings();
            new Notice(
              "Reload Obsidian for this change to take full effect.",
              5000,
            );
          }),
      );

    new Setting(common)
      .setName("Animations")
      .setDesc("Entrance fades, drag springs, hint transitions, and other motion polish. Turn off for slower machines, accessibility, or screen recordings.")
      .addToggle((t) =>
        t
          .setValue(!this.plugin.settings.disableAnimations)
          .onChange(async (v) => {
            this.plugin.settings.disableAnimations = !v;
            await this.plugin.saveSettings();
            this.plugin.applyAnimationsBodyClass();
          }),
      );
  }

/**
   * Behavior tab - the less-common everyday knobs that don't merit a
   * place on the General tab. Outline, drag handle behavior, plugin
   * compat, view-cycle ordering.
   */
  export function renderBehavior(this: ButterSettingTab, root: HTMLElement) {
    const outline = this.createSettingGroup(root, "Outline");
    this.renderOutlineSection(outline);

    const formatting = this.createSettingGroup(root, "Formatting");
    new Setting(formatting)
      .setName("HTML formatting")
      .setDesc(
        "Show toolbar buttons for marks that can only be written as inline HTML in source: text color, custom highlight color, underline, superscript, subscript, keyboard key. Turn off to keep your source pure Markdown. Existing HTML in files is still read and round-tripped either way.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableHtmlFormatting)
          .onChange(async (v) => {
            this.plugin.settings.enableHtmlFormatting = v;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          }),
      );

    const properties = this.createSettingGroup(root, "Properties");
    new Setting(properties)
      .setName("Frontmatter visibility")
      .setDesc("Control whether the properties/frontmatter panel is shown at the top of notes.")
      .addDropdown((d) =>
        d
          .addOption("match", "Match Obsidian")
          .addOption("visible", "Always visible")
          .addOption("hidden", "Always hidden")
          .setValue(this.plugin.settings.frontmatterVisibility)
          .onChange(async (v) => {
            this.plugin.settings.frontmatterVisibility = v as "match" | "visible" | "hidden";
            await this.plugin.saveSettings();
            this.plugin.refreshAllButterViews();
          }),
      );

    const dragDrop = this.createSettingGroup(root, "Drag and drop");
    this.renderDragSection(dragDrop);
    new Setting(dragDrop)
      .setName("Rich paste and file drop")
      .setDesc("Pasted URLs become links. HTML pastes as Markdown. Images and files dropped on the editor save to the vault and embed.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enablePasteDrop).onChange(async (v) => {
          this.plugin.settings.enablePasteDrop = v;
          await this.plugin.saveSettings();
        }),
      );

    const cycleSection = this.createSettingGroup(root, "View cycle modes");
    const cycleModes: Array<{
      id: "source" | "live" | "reading" | "butter";
      label: string;
      desc: string;
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
        .setName(m.label)
        .setDesc(m.desc)
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
   * Advanced tab - power-user surface. Source preservation + normalize
   * options, canonical-glyph choices, experimental flags (CM6 bridge,
   * theme compat), and debug controls.
   */
  export function renderAdvanced(this: ButterSettingTab, root: HTMLElement) {
    // Source preservation + canonical-glyph + normalize options.
    this.renderSourceSection(root);

    // Compatibility bridges. Each adapts an Obsidian API or theme
    // surface that assumes the native CM6 MarkdownView to Butter's
    // PM editor. Grouped together because they're conceptually
    // related, with per-row Experimental tags where appropriate.
    const compat = this.createSettingGroup(root, "Compatibility");
    new Setting(compat)
      .setName("Plugin autocomplete pop-ups")
      .setDesc("Pop-ups that appear as you type. `[[` for wikilinks, `#` for tags, `:` for emoji, `@today` for Natural Language Dates. Dismiss with Esc.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableSuggestBridge)
          .onChange(async (v) => {
            this.plugin.settings.enableSuggestBridge = v;
            await this.plugin.saveSettings();
          }),
      );
    const themeCompat = new Setting(compat)
      .setName("Max theme compatibility")
      .setDesc("Claim Obsidian's `.markdown-rendered` class so Reading-mode theme CSS cascades into Butter. Wider theme coverage; some themes assume non-editable content and can break selection or hover.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.experimentalThemeCompatMode)
          .onChange(async (v) => {
            this.plugin.settings.experimentalThemeCompatMode = v;
            await this.plugin.saveSettings();
            this.plugin.applyThemeCompatModeToAllViews();
          }),
      );
    themeCompat.nameEl.createSpan({
      cls: "butter-preset-tag is-experimental",
      text: "Experimental",
    });

    // Debug controls last - usually only touched when investigating
    // an issue.
    const debug = this.createSettingGroup(root, "Debug");
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
      .setName("Start a free trial")
      .setDesc(
        "Butter is paid software with a free trial. No card, no email. You get the full editor for the trial window, then choose whether to license or fall back to read-only.",
      )
      .addButton((b) =>
        b
          .setButtonText("Start free trial")
          .setCta()
          .onClick(() => {
            this.plugin.startTrialFlow();
          }),
      );
  }