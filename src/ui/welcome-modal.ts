/**
 * Three-page first-launch walkthrough.
 *
 * Page 1 introduces the editing experience, page 2 offers the
 * initial writing preferences, and page 3 handles trial/license
 * actions before getting the user into a note.
 */
import { App, Modal, Platform, ToggleComponent, setIcon } from "obsidian";
import type ButterEditorPlugin from "../main";
import {
  LIFETIME_LICENSE_PRICE,
  TRIAL_LENGTH_DAYS,
} from "../integration/license/policy";
import { tx, tv } from "../i18n";
import { appendInlineNotice } from "./inline-notice";
import {
  applyOnboardingChoices,
  initialRichFormattingChoice,
} from "./rich-formatting-preference";

export const BUTTER_GITHUB_README =
  "https://github.com/spreadwell/butter-editor#readme";

export class WelcomeModal extends Modal {
  private page: 1 | 2 | 3 = 1;
  private richFormattingEnabled: boolean;
  private markdownShortcutsEnabled: boolean;
  private finished = false;

  constructor(app: App, private plugin: ButterEditorPlugin) {
    super(app);
    this.richFormattingEnabled = initialRichFormattingChoice(plugin.settings);
    this.markdownShortcutsEnabled = plugin.settings.enableMarkdownShortcuts;
  }

  onOpen() {
    this.modalEl.addClass("butter-welcome-modal");
    if (Platform.isMobile) {
      this.modalEl.addClass("mod-sidebar-layout");
    }
    this.render();
  }

  onClose() {
    if (!this.finished) {
      void this.applyAndPersist();
    }
    this.contentEl.empty();
  }

  private render() {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    this.renderTitle(titleEl);
    if (this.page === 1) this.renderPage1(contentEl);
    else if (this.page === 2) this.renderPage2(contentEl);
    else this.renderPage3(contentEl);
  }

  private renderTitle(titleEl: HTMLElement): void {
    titleEl.empty();
    titleEl.addClass("is-brand");
    const iconSpan = titleEl.createSpan({ cls: "butter-welcome-title-icon" });
    setIcon(iconSpan, "butter-editor");
    titleEl.appendChild(activeDocument.createTextNode(` ${tx("Welcome to Butter Editor")}`));
  }

  private renderPage1(contentEl: HTMLElement) {
    this.renderProgress(contentEl);
    const body = contentEl.createDiv({ cls: "butter-welcome-body is-intro" });

    const hero = body.createDiv({ cls: "butter-welcome-hero" });
    hero.createEl("p", {
      text: tx("Write without the noise."),
    });

    const features = body.createDiv({ cls: "butter-welcome-features" });
    this.renderFeature(
      features,
      "text-cursor-input",
      tx("Visual editing"),
      tx("Format without syntax."),
    );
    this.renderFeature(
      features,
      "butter-obsidian-wireframe",
      tx("Built for Obsidian"),
      tx("Links, tags, callouts, and more."),
    );
    this.renderFeature(
      features,
      "paintbrush",
      tx("Work with your theme"),
      tx("Matches the look of your Obsidian theme."),
    );
    this.renderFeature(
      features,
      "palette",
      tx("Rich formatting"),
      tx("Color, highlights, and more."),
    );
    this.renderFeature(
      features,
      "sliders-horizontal",
      tx("Customizable Toolbar"),
      tx("Keep your favorite tools within reach."),
    );
    this.renderFeature(
      features,
      "file-check-2",
      tx("Use existing files"),
      tx("No importing or converting required."),
    );

    const footer = contentEl.createDiv({
      cls: "butter-welcome-footer is-end",
    });
    this.renderContinueButton(footer, () => {
      this.page = 2;
      this.render();
    });
  }

  private renderPage2(contentEl: HTMLElement) {
    this.renderProgress(contentEl);
    const body = contentEl.createDiv({ cls: "butter-welcome-body is-preferences" });

    const intro = body.createDiv({ cls: "butter-welcome-intro" });
    intro.createEl("p", {
      text: `${tx("Choose the options that fit how you write.")} ${tx("These are off by default for the simplest writing experience.")}`,
    });

    const formatting = body.createDiv({ cls: "butter-welcome-formatting" });
    this.renderPreference(
      formatting,
      "palette",
      tx("Rich formatting"),
      tx("Adds text color, custom highlights, underline, superscript, and subscript."),
      this.richFormattingEnabled,
      (enabled) => {
        this.richFormattingEnabled = enabled;
      },
      tx("Uses HTML, which can make notes less portable and harder to read in source view."),
    );
    this.renderPreference(
      formatting,
      "keyboard",
      tx("Markdown typing shortcuts"),
      tx("When this is on, typing things like *word*, # Heading, or - List turns them into formatting. Leave it off to keep those characters as text."),
      this.markdownShortcutsEnabled,
      (enabled) => {
        this.markdownShortcutsEnabled = enabled;
      },
    );

    const footer = contentEl.createDiv({
      cls: "butter-welcome-footer",
    });
    this.renderBackButton(footer, 1);
    const actions = footer.createDiv({ cls: "butter-welcome-footer-actions" });
    this.renderContinueButton(actions, () => {
      this.page = 3;
      this.render();
    });
  }

  private renderPage3(contentEl: HTMLElement) {
    this.renderProgress(contentEl);
    const body = contentEl.createDiv({ cls: "butter-welcome-body is-license" });

    this.renderTrialSection(body);

    const footer = contentEl.createDiv({
      cls: "butter-welcome-footer",
    });
    this.renderBackButton(footer, 2);
    const actions = footer.createDiv({ cls: "butter-welcome-footer-actions" });

    const goBtn = actions.createEl("button", {
      cls: "mod-cta butter-welcome-continue butter-welcome-finish",
      attr: { type: "button" },
    });
    const finishIcon = goBtn.createSpan({ cls: "butter-welcome-continue-icon" });
    setIcon(finishIcon, "check");
    goBtn.createSpan({ text: tx("Finish Setup") });
    goBtn.addEventListener("click", () => {
      this.runActionOnce(goBtn, async () => {
        await this.applyAndPersist();
        this.finished = true;
        this.close();
      });
    });

  }

  private renderProgress(parent: HTMLElement): void {
    const progress = parent.createDiv({ cls: "butter-welcome-progress" });
    progress.setAttr("role", "progressbar");
    progress.setAttr("aria-valuemin", "1");
    progress.setAttr("aria-valuemax", "3");
    progress.setAttr("aria-valuenow", String(this.page));
    progress.createSpan({
      cls: "butter-welcome-progress-count",
      text: `${this.page} / 3`,
    });
    const track = progress.createDiv({ cls: "butter-welcome-progress-track" });
    for (let step = 1; step <= 3; step += 1) {
      track.createSpan({
        cls: `butter-welcome-progress-step${step <= this.page ? " is-complete" : ""}${step === this.page ? " is-current" : ""}`,
      });
    }
  }

  private renderFeature(
    parent: HTMLElement,
    icon: string,
    title: string,
    description: string,
  ): void {
    const feature = parent.createDiv({ cls: "butter-welcome-feature" });
    const iconEl = feature.createDiv({ cls: "butter-welcome-feature-icon" });
    setIcon(iconEl, icon);
    const copy = feature.createDiv({ cls: "butter-welcome-feature-copy" });
    copy.createDiv({ cls: "butter-welcome-feature-title", text: title });
    copy.createDiv({
      cls: "butter-welcome-feature-description",
      text: description,
    });
  }

  private renderPreference(
    parent: HTMLElement,
    iconName: string,
    title: string,
    description: string,
    value: boolean,
    onChange: (enabled: boolean) => void,
    notice?: string,
  ): void {
    const card = parent.createDiv({
      cls: "butter-welcome-feature butter-welcome-preference",
    });
    const icon = card.createDiv({ cls: "butter-welcome-feature-icon" });
    setIcon(icon, iconName);
    card.createDiv({ cls: "butter-welcome-feature-title", text: title });
    card.createDiv({
      cls: "butter-welcome-feature-description",
      text: description,
    });
    if (notice) appendInlineNotice(card, notice);
    const control = card.createDiv({ cls: "butter-welcome-preference-control" });
    new ToggleComponent(control).setValue(value).onChange(onChange);
  }

  private renderBackButton(parent: HTMLElement, page: 1 | 2): void {
    const backBtn = parent.createEl("button", {
      cls: "butter-welcome-back",
      attr: { type: "button" },
    });
    const icon = backBtn.createSpan({ cls: "butter-welcome-back-icon" });
    setIcon(icon, "arrow-left");
    backBtn.createSpan({ text: tx("Back") });
    backBtn.addEventListener("click", () => {
      this.page = page;
      this.render();
    });
  }

  private renderContinueButton(
    parent: HTMLElement,
    onClick: () => void,
  ): void {
    const button = parent.createEl("button", {
      cls: "mod-cta butter-welcome-continue",
      attr: { type: "button" },
    });
    button.createSpan({ text: tx("Continue") });
    const icon = button.createSpan({ cls: "butter-welcome-continue-icon" });
    setIcon(icon, "arrow-right");
    button.addEventListener("click", onClick);
  }

  private renderTrialSection(parent: HTMLElement) {
    const status = this.plugin.licenseStatus;
    const panel = parent.createDiv({ cls: "butter-welcome-license-card" });

    if (status === "trial") {
      this.renderLicenseHeader(
        panel,
        "circle-check",
        tx("Free trial active"),
        tv("Your {days}-day free trial is currently active. You're all set.", { days: TRIAL_LENGTH_DAYS }),
      );
      return;
    }

    if (status === "valid") {
      this.renderLicenseHeader(
        panel,
        "circle-check",
        tx("Setup complete"),
        tx("Butter Editor is ready."),
      );
      return;
    }

    const hasActivated = !!this.plugin.settings.everValidated || !!this.plugin.settings.activatedAt;
    if (status === "expired" || hasActivated) {
      this.renderLicenseHeader(
        panel,
        "key-round",
        tx(status === "expired" ? "Free trial expired" : "License required"),
        tx("Unlock Butter Editor with a lifetime license."),
      );
      const offer = panel.createDiv({ cls: "butter-welcome-license-offer" });
      const price = offer.createDiv({ cls: "butter-welcome-license-price" });
      price.createDiv({ cls: "butter-welcome-license-price-value", text: LIFETIME_LICENSE_PRICE });
      price.createDiv({
        cls: "butter-welcome-license-price-label",
        text: tx("Lifetime License • One-time purchase"),
      });
      const purchase = offer.createEl("button", {
        cls: "mod-cta",
        text: tx("Purchase"),
        attr: { type: "button" },
      });
      purchase.addEventListener("click", () => {
        this.runActionOnce(purchase, async () => {
          await this.applyAndPersist();
          this.finished = true;
          this.close();
          this.plugin.startLifetimeCheckoutFlow();
        });
      });
      this.renderEnterKeyRow(parent);
      return;
    }

    const header = this.renderLicenseHeader(
      panel,
      "badge-alert",
      tx("Free Trial Available"),
      tv("{days} days, full access. No card, no email. Butter Editor stays installed but read-only after the trial until you activate a license.", { days: TRIAL_LENGTH_DAYS }),
    );
    header.addClass("has-action");
    const trial = header.createEl("button", {
      cls: "mod-cta",
      text: tx("Start free trial"),
      attr: { type: "button" },
    });
    trial.addEventListener("click", () => {
      this.runActionOnce(trial, async () => {
        await this.applyAndPersist();
        this.finished = true;
        this.close();
        this.plugin.startTrialFlow();
      });
    });
    this.renderEnterKeyRow(parent);
  }

  private renderEnterKeyRow(parent: HTMLElement) {
    const row = parent.createDiv({ cls: "butter-welcome-license-existing" });
    const copy = row.createDiv();
    copy.createDiv({ cls: "butter-welcome-license-existing-title", text: tx("Already have a license?") });
    copy.createDiv({ cls: "butter-welcome-license-existing-desc", text: tx("Paste your key in settings > license.") });
    const button = row.createEl("button", {
      text: tx("Enter license"),
      attr: { type: "button" },
    });
    button.addEventListener("click", () => {
      this.runActionOnce(button, async () => {
        await this.applyAndPersist();
        this.finished = true;
        this.close();
        this.plugin.openSettings("license");
      });
    });
  }

  private runActionOnce(
    button: HTMLButtonElement,
    action: () => Promise<void>,
  ): void {
    if (button.disabled) return;
    button.disabled = true;
    void action().catch((error: unknown) => {
      if (button.isConnected) button.disabled = false;
      console.error("[butter:onboarding] Action failed:", error);
    });
  }

  private renderLicenseHeader(
    parent: HTMLElement,
    iconName: string,
    title: string,
    description: string,
  ): HTMLElement {
    const header = parent.createDiv({ cls: "butter-welcome-license-header" });
    const icon = header.createDiv({ cls: "butter-welcome-license-icon" });
    setIcon(icon, iconName);
    const copy = header.createDiv();
    copy.createDiv({ cls: "butter-welcome-license-title", text: title });
    copy.createDiv({ cls: "butter-welcome-license-description", text: description });
    return header;
  }

  private async applyAndPersist(): Promise<void> {
    applyOnboardingChoices(
      this.plugin.settings,
      this.richFormattingEnabled,
      this.markdownShortcutsEnabled,
    );
    await this.plugin.saveSettings();
    this.plugin.applyToolbarButtonVisibilityToAllViews();
    this.plugin.applyMarkdownShortcutSettingToAllViews();
  }
}
