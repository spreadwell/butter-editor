import { Notice, Setting } from "obsidian";
import type { ButterSettingTab } from "../settings-tab";
import {
  collectFeedbackDiagnostics,
  submitFeedback,
  type FeedbackAccessStatus,
  type FeedbackDiagnostics,
  type FeedbackKind,
} from "../../integration/feedback-client";
import { LINKS } from "../../integration/license/links";
import { tx, txKnown } from "../../i18n";
import { BUTTER_GITHUB_README, WelcomeModal } from "../welcome-modal";

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function accessStatus(tab: ButterSettingTab): FeedbackAccessStatus {
  if (tab.plugin.settings.licenseType === "trial" || tab.plugin.licenseStatus === "trial") {
    return "trial";
  }
  if (tab.plugin.settings.licenseType === "lifetime" || tab.plugin.licenseStatus === "valid") {
    return "paid";
  }
  return "unknown";
}

function diagnosticsPreview(diagnostics: FeedbackDiagnostics): DocumentFragment {
  const fragment = createFragment();
  const list = fragment.createEl("dl", { cls: "butter-feedback-diagnostics" });
  const rows: Array<[string, string | number | undefined]> = [
    [tx("Butter Editor version"), diagnostics.pluginVersion],
    [tx("Obsidian version"), diagnostics.obsidianVersion],
    [tx("Operating system"), diagnostics.platform],
    [tx("Architecture"), diagnostics.architecture],
    [tx("Logical processors"), diagnostics.logicalProcessors],
    [tx("Memory"), diagnostics.memoryGb === undefined ? undefined : `${diagnostics.memoryGb} GB`],
    [tx("Display"), diagnostics.display],
    [tx("Touch points"), diagnostics.touchPoints],
  ];
  for (const [label, value] of rows) {
    if (value === undefined) continue;
    list.createEl("dt", { text: label });
    list.createEl("dd", { text: String(value) });
  }
  return fragment;
}

export function renderSupportSection(this: ButterSettingTab, root: HTMLElement): void {
  const feedback = this.createSettingGroup(root, tx("Send feedback"));
  feedback.addClass("butter-feedback-form");

  let kind: FeedbackKind = "bug";
  let subject = "";
  let message = "";
  let contactEmail = "";
  let includeDiagnostics = false;
  const diagnostics = collectFeedbackDiagnostics(this.plugin.manifest.version);

  new Setting(feedback)
    .setName(tx("Feedback type"))
    .addDropdown((dropdown) => dropdown
      .addOption("bug", tx("Bug report"))
      .addOption("feature", tx("Feature request"))
      .addOption("other", tx("Other"))
      .setValue(kind)
      .onChange((value) => { kind = value as FeedbackKind; }));

  new Setting(feedback)
    .setName(tx("Subject"))
    .setDesc(tx("Briefly describe the feedback."))
    .addText((input) => {
      input.inputEl.maxLength = 120;
      input.setPlaceholder(tx("Short summary"));
      input.onChange((value) => { subject = value; });
    });

  const detailSetting = new Setting(feedback)
    .setName(tx("Details"))
    .setDesc(tx("Describe what happened or what you would like to see."));
  detailSetting.addTextArea((input) => {
    input.inputEl.maxLength = 10_000;
    input.inputEl.rows = 7;
    input.inputEl.addClass("butter-feedback-message");
    input.onChange((value) => { message = value; });
  });

  new Setting(feedback)
    .setName(tx("Contact email (optional)"))
    .setDesc(tx("Add an email only if you would like a response."))
    .addText((input) => {
      input.inputEl.type = "email";
      input.inputEl.maxLength = 254;
      input.setPlaceholder("name@example.com");
      input.onChange((value) => { contactEmail = value; });
    });

  let preview!: Setting;
  new Setting(feedback)
    .setName(tx("Include basic device details"))
    .setDesc(tx("Adds app versions, operating system, processor count, memory when available, display details, and touch capability."))
    .addToggle((toggle) => toggle
      .setValue(false)
      .onChange((value) => {
        includeDiagnostics = value;
        preview.settingEl.toggleClass("is-hidden", !value);
      }));

  preview = new Setting(feedback)
    .setName(tx("Device details that will be included"))
    .setDesc(diagnosticsPreview(diagnostics));
  preview.settingEl.addClasses(["butter-feedback-diagnostics-row", "is-hidden"]);

  const submitRow = new Setting(feedback)
    .setDesc(tx("No contact information required. To respect your privacy, nothing about your vault will be included in this report without your permission."));
  submitRow.settingEl.addClass("butter-feedback-submit-row");
  const status = submitRow.descEl.createDiv({
    cls: "butter-feedback-status",
    attr: { role: "status", "aria-live": "polite" },
  });
  submitRow.addButton((button) => button
    .setButtonText(tx("Submit feedback"))
    .setCta()
    .onClick(async () => {
      const trimmedSubject = subject.trim();
      const trimmedMessage = message.trim();
      const trimmedEmail = contactEmail.trim();
      status.removeClasses(["is-success", "is-error"]);
      if (trimmedSubject.length < 3) {
        status.setText(tx("Enter a subject."));
        status.addClass("is-error");
        return;
      }
      if (trimmedMessage.length < 10) {
        status.setText(tx("Add a few details before sending."));
        status.addClass("is-error");
        return;
      }
      if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
        status.setText(tx("Enter a valid email address or leave it blank."));
        status.addClass("is-error");
        return;
      }

      button.setDisabled(true).setButtonText(tx("Sending..."));
      status.empty();
      try {
        await submitFeedback({
          kind,
          subject: trimmedSubject,
          message: trimmedMessage,
          contactEmail: trimmedEmail || undefined,
          accessStatus: accessStatus(this),
          diagnostics: includeDiagnostics ? diagnostics : undefined,
        });
        status.setText(tx("Feedback sent. Thank you."));
        status.addClass("is-success");
      } catch {
        status.setText(tx("Couldn't send feedback. Check your connection and try again."));
        status.addClass("is-error");
        new Notice(tx("Couldn't send feedback. Check your connection and try again."), 5000);
      } finally {
        button.setDisabled(false).setButtonText(tx("Submit feedback"));
      }
    }));

  const resources = this.createSettingGroup(root, tx("Learn more"));

  new Setting(resources)
    .setName(txKnown("What's new"))
    .setDesc(txKnown("Review the latest Butter Editor highlights."))
    .addButton((button) => button.setButtonText(txKnown("View what's new")).onClick(() => {
      this.plugin.openWhatsNewFromSettings();
    }));

  new Setting(resources)
    .setName(tx("Open feature docs"))
    .setDesc(tx("Opens the Butter README on GitHub. Feature descriptions with screenshots and GIFs."))
    .addButton((button) => button.setButtonText(tx("Open README")).onClick(() => {
      window.open(BUTTER_GITHUB_README, "_blank");
    }));

  new Setting(resources)
    .setName(tx("Replay welcome walkthrough"))
    .setDesc(tx("Re-open the welcome walkthrough."))
    .addButton((button) => button.setButtonText(tx("Replay")).onClick(() => {
      new WelcomeModal(this.app, this.plugin).open();
    }));

  const support = this.createSettingGroup(root, tx("Other support options"));
  new Setting(support)
    .setName(tx("GitHub issue tracker"))
    .addButton((button) => button.setButtonText(tx("Open")).onClick(() => {
      window.open(LINKS.issues, "_blank");
    }));
  new Setting(support)
    .setName(tx("Community thread"))
    .setDesc(tx("Obsidian forum thread."))
    .addButton((button) => button.setButtonText(tx("Open")).onClick(() => {
      window.open(LINKS.forum, "_blank");
    }));
  new Setting(support)
    .setName(tx("Email support"))
    .setDesc(LINKS.supportEmail)
    .addButton((button) => button.setButtonText(tx("Email")).onClick(() => {
      window.open(`mailto:${LINKS.supportEmail}`, "_blank");
    }));

  this.renderDeviceUtilities(support);

  new Setting(support)
    .setName(tx("Privacy policy"))
    .addButton((button) => button.setButtonText(tx("Open")).onClick(() => {
      window.open(LINKS.privacy, "_blank");
    }));
  new Setting(support)
    .setName(tx("Terms of service"))
    .addButton((button) => button.setButtonText(tx("Open")).onClick(() => {
      window.open(LINKS.terms, "_blank");
    }));
  new Setting(support)
    .setName(tx("Refund policy"))
    .addButton((button) => button.setButtonText(tx("Open")).onClick(() => {
      window.open(LINKS.refunds, "_blank");
    }));
  new Setting(support)
    .setName(tx("Plugin version"))
    .setDesc(`v${this.plugin.manifest.version}`);
}
