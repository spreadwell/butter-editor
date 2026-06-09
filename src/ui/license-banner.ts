/**
 * License-required banner. Visible whenever the plugin's
 * `licenseStatus` is anything other than `valid` or `trial`.
 *
 * Placement: attaches to the toolbar stack (same parent as the main
 * formatting toolbar) so the banner reads as another toolbar row -
 * the same chrome language as the table toolbar that docks adjacent
 * to the main toolbar when a table is focused. When the user changes
 * toolbarPosition / toolbarStyle, the view re-calls `refresh()` and
 * the banner re-locates itself.
 *
 * "Read-only with a banner" was the chosen UX over hard-blocking
 * file-open: avoids feeling destructive when a paying customer is
 * temporarily offline + their cached session expires, and gives
 * unlicensed users a path to evaluate the visual quality before
 * starting a trial.
 */

import { Modal, setIcon, Platform } from "obsidian";
import type ButterEditorPlugin from "../main";

export class LicenseActionSheet extends Modal {
  constructor(
    private plugin: ButterEditorPlugin,
    private status: "expired" | "unknown" | "unlicensed",
    private hasActivated: boolean,
  ) {
    super(plugin.app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("butter-license-action-sheet");

    const header = contentEl.createDiv({ cls: "butter-license-action-sheet-header" });
    const icon = header.createSpan({ cls: "butter-license-action-sheet-icon" });
    if (this.status === "expired") icon.addClass("is-expired");
    setIcon(icon, this.status === "expired" ? "alert-triangle" : "lock");

    const text = header.createDiv({ cls: "butter-license-action-sheet-text" });
    if (this.status === "expired") {
      text.createDiv({ cls: "title", text: "Trial expired - read-only mode" });
      text.createDiv({ cls: "subtitle", text: "Purchase a license to keep editing in Butter." });
    } else if (this.status === "unknown") {
      text.createDiv({ cls: "title", text: "Checking license…" });
      text.createDiv({ cls: "subtitle", text: "Read-only until the licensing server can be reached." });
    } else {
      text.createDiv({ cls: "title", text: "License required - read-only mode" });
      text.createDiv({
        cls: "subtitle",
        text: this.hasActivated
          ? "Paste your license key to enable editing."
          : "Start a free trial or paste a license key to enable editing.",
      });
    }

    const actions = contentEl.createDiv({ cls: "butter-license-action-sheet-actions" });
    const openSettings = () => {
      this.close();
      this.plugin.openSettings("license");
    };

    const trialBtnText = this.status === "expired" ? "Purchase" : (this.hasActivated ? "Purchase" : "Start trial");
    const trialBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: trialBtnText,
    });
    trialBtn.addEventListener("click", () => {
      this.close();
      if (this.status !== "expired" && !this.hasActivated) {
        this.plugin.startTrialFlow();
      } else {
        this.plugin.openSettings("license");
      }
    });

    if (this.status !== "expired") {
      const enterBtn = actions.createEl("button", { text: "Enter license" });
      enterBtn.addEventListener("click", openSettings);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

const BANNER_CLASS = "butter-license-banner";

export interface LicenseBanner {
  /** Re-evaluates the plugin's `licenseStatus` and shows / hides /
   *  re-renders the banner accordingly. Called from the
   *  `butter:license-changed` workspace listener, on view open,
   *  and after applyToolbarPosition swaps the toolbar's parent. */
  refresh(): void;
  /** Removes the banner DOM. Call from the view's `onClose()`. */
  destroy(): void;
}

/**
 * Mount the banner. `viewContainer` is the ButterEditorView's outer
 * containerEl - we query inside it for the main toolbar to find the
 * stack to dock into, and fall back to prepending to the view's
 * contentEl if the toolbar isn't mounted yet (edge case during
 * initial render before applyToolbarPosition has run).
 */

export function mountLicenseBanner(
  viewContainer: HTMLElement,
  insertBeforeEl: HTMLElement,
  wrapperEl: HTMLElement,
  plugin: ButterEditorPlugin,
  leafEl?: HTMLElement,
): LicenseBanner {
  let bannerEl: HTMLElement | null = null;

  const placeAsFloatingPill = () => {
    if (!leafEl) return;
    const contentEl = leafEl.querySelector(":scope > .view-content");
    if (contentEl) {
      if (wrapperEl.parentElement !== contentEl) {
        contentEl.prepend(wrapperEl);
      }
    } else {
      leafEl.prepend(wrapperEl);
    }
  };

  /** Mobile: place the banner inside .butter-editor-view, above the inline title. */
  const placeAboveTitle = () => {
    if (wrapperEl.nextElementSibling !== insertBeforeEl) {
      insertBeforeEl.parentElement?.insertBefore(wrapperEl, insertBeforeEl);
    }
  };

  const render = () => {
    const status = plugin.licenseStatus;
    const visible = !(status === "valid" || status === "trial");

    if (!visible) {
      if (bannerEl) {
        bannerEl.remove();
        bannerEl = null;
      }
      wrapperEl.remove();
      return;
    }

    wrapperEl.classList.add("is-pill");

    if (!bannerEl) {
      bannerEl = wrapperEl.createDiv({ cls: BANNER_CLASS });
      bannerEl.setAttribute("role", "status");
      bannerEl.setAttribute("aria-live", "polite");
    }

    if (Platform.isMobile) {
      placeAboveTitle();
    } else {
      placeAsFloatingPill();
    }
    // Ensure view-content has relative positioning for the absolute pill
    wrapperEl.classList.add("is-pill");

    bannerEl.empty();

    const isTrialAvailable = status !== "expired" && !plugin.settings.activatedAt && !plugin.settings.everValidated;

    const iconEl = bannerEl.createSpan({ cls: `${BANNER_CLASS}-icon` });
    setIcon(iconEl, "lock");

    const stateText = status === "expired" ? "Trial expired"
      : status === "unknown" ? "Checking license…"
      : isTrialAvailable ? "Free trial available" : "License required";
    bannerEl.createSpan({ cls: `${BANNER_CLASS}-state`, text: stateText });
    bannerEl.createSpan({ cls: `${BANNER_CLASS}-separator`, text: "•" });
    bannerEl.createSpan({ cls: `${BANNER_CLASS}-readonly`, text: "Read-only" });

    const actions = bannerEl.createDiv({ cls: `${BANNER_CLASS}-actions` });

    const enterBtn = actions.createEl("button", { text: "Enter key" });
    enterBtn.addEventListener("click", () => {
      plugin.openSettings("license");
    });

    if (status !== "unknown") {
      const purchaseBtn = actions.createEl("button", { text: "Purchase" });
      purchaseBtn.addEventListener("click", () => {
        plugin.startLifetimeCheckoutFlow();
      });
    }

    if (isTrialAvailable) {
      const trialBtn = actions.createEl("button", { cls: "mod-cta", text: "Start trial" });
      trialBtn.addEventListener("click", () => {
        trialBtn.disabled = true;
        trialBtn.innerText = "Starting…";
        plugin.startTrialFlow();
      });
    }
  };

  render();

  return {
    refresh: render,
    destroy: () => {
      if (bannerEl) {
        bannerEl.remove();
        bannerEl = null;
      }
      wrapperEl.remove();
    },
  };
}
