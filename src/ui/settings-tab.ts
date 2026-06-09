/**
 * Butter's plugin-settings tab.
 *
 * Extracted from main.ts for readability - the tab is self-contained:
 * it reads + writes `plugin.settings`, triggers saves via
 * `plugin.saveSettings()`, and nudges `plugin.applyOutlineMode()` when
 * the outline toggle flips. It doesn't touch the editor view directly.
 *
 * Four tabs (General / Outline / Block Drag / Normalization) render
 * independently; active tab persists in-memory only (resets on
 * re-open, per Obsidian's settings pane convention).
 */
import {
  App,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  getIconIds,
  setIcon,
} from "obsidian";
import type ButterEditorPlugin from "../main";
import type { ButterSettings } from "../main";
import { LicenseClientError } from "../integration/license/client";
import type { DeviceWireRecord } from "../integration/license/client";
import type { ToolbarLayoutItem } from "../main";


import {
  wouldDriftFromActive,
  type SourcePurityMode,
} from "./welcome-modal";

import { renderLicense, computeLicensePhase, renderRowsFor, renderUnlicensedRows, renderPollingRows, renderTrialRows, renderLifetimeRows, renderDeactivatedRows, renderInvalidatedRows, reasonCopyFor, renderExpiredRows, renderUnknownRows, trialHeadlineFor, trialStatLineFor, formatActivationDate, formatRelativeTime, renderKeyRow, renderPasteKeyRow, renderRecoveryRow, renderDevicesSection, renderDeviceListSkeleton, renderDeviceRow, renderCurrentDeviceFallback, renderDeviceUtilities, renderSupportSection, computeRemaining, scheduleTrialPoll, friendlyError } from "./settings/license-tab";
import { renderGeneral, renderGeneralIntroSections, renderBehavior, renderAdvanced, renderStartTrialCardIfApplicable } from "./settings/general-tab";
import { TRIAL_LENGTH_DAYS } from "../integration/license/policy";
import { renderToolbar, renderLayoutSection, createSettingGroup, renderPrimaryToolbarSection, renderTableToolbarSection, renderLayoutEditor, openMoveToSubmenuMenu, openSubmenuEditModal, wireDrag } from "./settings/toolbar-tab";
import { renderOutlineSection } from "./settings/outline-tab";
import { renderDragSection } from "./settings/drag-tab";
import { renderSourceSection, confirmPresetDrift, showWarning } from "./settings/source-tab";
import { renderDebugSection } from "./settings/debug-tab";

export class ButterSettingTab extends PluginSettingTab {
  /** Active tab key - persists across re-opens of the settings pane.
   *  Order is the user-facing order in the tab bar. */
  activeTab:
    | "general"
    | "behavior"
    | "toolbar"
    | "advanced"
    | "license" = "general";

  /** Inline trial-poll timer, owned by the License tab's hero block.
   *  Cleared on `hide()` so we don't poll while Settings is closed
   *  (the plugin's `resumeTrialActivation` still picks it up next
   *  open). Null when no poll is scheduled. */
  public trialPollTimer: number | null = null;

  /** Bumped each time the License tab is rendered. The poll loop's
   *  in-flight ticks check this against their captured generation
   *  before continuing - guarantees old timers from a prior render
   *  can't race with a fresher render's state. */
  public pollGeneration = 0;

  /** ResizeObserver watching the tab bar. Created on each display();
   *  disconnected on hide() and at the top of the next display() so
   *  re-renders don't pile up observers. */
  public tabBarResizeObserver: ResizeObserver | null = null;

  constructor(app: App, public plugin: ButterEditorPlugin) {
    super(app, plugin);
  }

  hide() {
    if (this.trialPollTimer != null) {
      window.clearTimeout(this.trialPollTimer);
      this.trialPollTimer = null;
    }
    if (this.tabBarResizeObserver) {
      this.tabBarResizeObserver.disconnect();
      this.tabBarResizeObserver = null;
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("butter-settings-root");

    // Tab bar with optional left/right overflow indicators. The wrap
    // is positioned-relative so the indicators can absolutely overlay
    // the bar's edges; the bar itself is the scrollable element. On
    // narrow windows the tabs scroll horizontally and the indicators
    // appear when content extends past the visible bounds. Clicking
    // an indicator scrolls one tab worth in that direction.
    const tabWrap = containerEl.createDiv({ cls: "butter-settings-tabs-wrap" });
    const leftInd = tabWrap.createDiv({
      cls: "butter-settings-tabs-indicator is-left",
      attr: { role: "button", tabindex: "0", "aria-label": "Scroll tabs left" },
    });
    setIcon(leftInd, "chevron-left");
    const tabBar = tabWrap.createDiv({ cls: "butter-settings-tabs" });
    const rightInd = tabWrap.createDiv({
      cls: "butter-settings-tabs-indicator is-right",
      attr: { role: "button", tabindex: "0", "aria-label": "Scroll tabs right" },
    });
    setIcon(rightInd, "chevron-right");

    const updateIndicators = () => {
      // 1px tolerance for fractional scroll positions (some browsers
      // report scrollLeft+clientWidth slightly under scrollWidth even
      // when fully scrolled to the right).
      const canLeft = tabBar.scrollLeft > 1;
      const canRight =
        tabBar.scrollLeft + tabBar.clientWidth < tabBar.scrollWidth - 1;
      leftInd.toggleClass("is-visible", canLeft);
      rightInd.toggleClass("is-visible", canRight);
    };

    const scrollByOneTab = (dir: -1 | 1) => {
      const tabs = Array.from(
        tabBar.querySelectorAll<HTMLElement>(".butter-settings-tab"),
      );
      if (dir === 1) {
        // First tab whose right edge is past the current visible end.
        const visibleRight = tabBar.scrollLeft + tabBar.clientWidth;
        const next = tabs.find(
          (t) => t.offsetLeft + t.offsetWidth > visibleRight + 1,
        );
        if (next) {
          tabBar.scrollTo({
            left: next.offsetLeft - 4,
            behavior: "smooth",
          });
        }
      } else {
        // Last tab whose left edge is before the current visible start.
        const visibleLeft = tabBar.scrollLeft;
        let prev: HTMLElement | undefined;
        for (let i = tabs.length - 1; i >= 0; i--) {
          if (tabs[i].offsetLeft < visibleLeft - 1) {
            prev = tabs[i];
            break;
          }
        }
        if (prev) {
          tabBar.scrollTo({
            left: Math.max(0, prev.offsetLeft - 4),
            behavior: "smooth",
          });
        }
      }
    };

    const wireIndicator = (el: HTMLElement, dir: -1 | 1) => {
      el.addEventListener("click", () => scrollByOneTab(dir));
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          scrollByOneTab(dir);
        }
      });
    };
    wireIndicator(leftInd, -1);
    wireIndicator(rightInd, 1);

    tabBar.addEventListener("scroll", updateIndicators, { passive: true });
    // ResizeObserver catches container width changes (Obsidian pane
    // resize, sidebar toggle, etc.) without a window-scoped listener
    // that would leak across display() re-renders. Disconnect any
    // observer from a previous display() first so we never stack.
    if (this.tabBarResizeObserver) this.tabBarResizeObserver.disconnect();
    this.tabBarResizeObserver = new ResizeObserver(updateIndicators);
    this.tabBarResizeObserver.observe(tabBar);

    const body = containerEl.createDiv({ cls: "butter-settings-tab-body" });

    const render = () => {
      body.empty();
      tabBar.querySelectorAll(".butter-settings-tab").forEach((el) => {
        el.toggleClass("is-active", el.getAttribute("data-tab") === this.activeTab);
      });
      switch (this.activeTab) {
        case "general":
          this.renderGeneral(body);
          break;
        case "behavior":
          this.renderBehavior(body);
          break;
        case "toolbar":
          this.renderToolbar(body);
          break;
        case "advanced":
          this.renderAdvanced(body);
          break;
        case "license":
          this.renderLicense(body);
          break;
      }
    };

    const addTab = (id: typeof this.activeTab, label: string) => {
      // Render as a div, not a <button>, so Obsidian's and themes'
      // button-element styling (box-shadow, focus rings, hover fills,
      // padding overrides) never touches us. ARIA role + tabindex
      // restore keyboard activation; Enter/Space dispatch a click.
      const tab = tabBar.createDiv({
        cls: "butter-settings-tab",
        attr: { "data-tab": id, role: "tab", tabindex: "0" },
      });
      tab.createSpan({ cls: "butter-settings-tab-label", text: label });
      const activate = () => {
        this.activeTab = id;
        render();
      };
      tab.addEventListener("click", activate);
      tab.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    };

    addTab("general", "General");
    addTab("behavior", "Behavior");
    addTab("toolbar", "Toolbar");
    addTab("advanced", "Advanced");
    addTab("license", "License");
    render();
    // Initial indicator visibility once layout has settled.
    window.requestAnimationFrame(updateIndicators);
  }

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  /** Async fetch + render of the live device list. Replaces the
   *  skeleton in `listEl` with real rows on resolve, or a graceful
   *  fallback on network/auth failure. */
  public async fetchAndRenderDevices(listEl: HTMLElement) {
    const sessionToken = this.plugin.settings.sessionToken;
    if (sessionToken === "dev-fake") {
      listEl.empty();
      this.renderCurrentDeviceFallback(
        listEl,
        "Dev mode: Devices list bypassed.",
      );
      return;
    }
    if (!sessionToken) {
      listEl.empty();
      this.renderCurrentDeviceFallback(
        listEl,
        "Local session missing - re-paste your key to refresh the device list.",
      );
      return;
    }
    let devices: DeviceWireRecord[];
    try {
      devices = await this.plugin.licenseClient.listDevices(sessionToken);
    } catch (err) {
      listEl.empty();
      if (err instanceof LicenseClientError) {
        if (err.kind === "device_deactivated") {
          // Server confirms this device was deactivated remotely.
          // refreshLicenseStatus would normally clear local state,
          // but listDevices doesn't go through that path - do it
          // here, then re-render.
          await this.plugin.refreshLicenseStatus();
          (this as unknown as { display: () => void }).display();
          return;
        }
        if (err.kind === "unauthorized") {
          // Token expired client-side. Trigger refresh - that'll
          // either re-issue or mark unlicensed.
          await this.plugin.refreshLicenseStatus();
          (this as unknown as { display: () => void }).display();
          return;
        }
      }
      // Network / polar / unknown - fall back to local-only view.
      this.renderCurrentDeviceFallback(
        listEl,
        "Couldn't reach the licensing server. Showing this device only.",
      );
      return;
    }

    listEl.empty();
    if (devices.length === 0) {
      // Worker has no record of this device yet (legacy customer or
      // pre-1.7.0 Worker). Fall back to local-only view.
      this.renderCurrentDeviceFallback(
        listEl,
        "Paste your license key on another machine to add it here.",
      );
      return;
    }

    for (const device of devices) {
      this.renderDeviceRow(listEl, device);
    }

    // Device-count summary line below the list. Always shown when
    // there's at least one device - "1 device" doubles as the hint
    // that you can add more.
    const count = devices.length;
    const summary = count === 1
      ? "1 device · paste your key on another machine to add it here."
      : `${count} devices on this license.`;
    listEl.createDiv({ cls: "butter-license-devices-hint", text: summary });
  }

  

  

  /** Self-deactivation: revoke server-side, then clear local
   *  session token + regenerate deviceId so this Obsidian install
   *  drops back to read-only mode immediately AND can be re-added
   *  cleanly by re-pasting the same key (a fresh deviceId means the
   *  Worker's device_deactivated gate doesn't fire on re-validation,
   *  since the new id has no deactivated entry). The old deviceId's
   *  deactivated entry stays in the server-side list as a historical
   *  record. */
  public async deactivateCurrentDevice() {
    const sessionToken = this.plugin.settings.sessionToken;
    const oldDeviceId = this.plugin.settings.deviceId;
    if (sessionToken) {
      try {
        await this.plugin.licenseClient.deactivateDevice(
          sessionToken,
          oldDeviceId,
        );
      } catch (err) {
        // Server revoke failed - log it, but still clear local
        // state so the user's "deactivate" intent succeeds locally.
        // The new deviceId means re-validation will work either
        // way; the worst case is the old deviceId stays usable on
        // the server until its session token expires (≤7 days).
        console.warn("[butter] device-deactivate server call failed:", err);
      }
    }
    // Clear the in-flight license state. Note: we preserve
    // `everValidated` so the user keeps offline grace if they
    // re-paste the same key on this install - losing it on a
    // self-initiated action would punish them for cleaning up.
    // Same reason for clearing the sticky failure flags - a user
    // who chose to deactivate isn't surprised by it.
    this.plugin.settings.sessionToken = "";
    this.plugin.settings.sessionExpiresAt = 0;
    this.plugin.settings.lastValidatedAt = 0;
    this.plugin.settings.licenseKey = "";
    this.plugin.settings.customerId = "";
    this.plugin.settings.customerEmail = "";
    this.plugin.settings.licenseExpiresAt = 0;
    this.plugin.settings.activatedAt = 0;
    this.plugin.settings.wasDeactivated = false;
    this.plugin.settings.wasInvalidated = false;
    this.plugin.settings.lastReason = "";
    this.plugin.settings.deviceId = (crypto).randomUUID();
    await this.plugin.saveSettings();
    await this.plugin.refreshLicenseStatus();
    (this as unknown as { display: () => void }).display();
    new Notice("This device deactivated.", 4000);
  }

  /** Sibling-device deactivation: revoke server-side, refresh the
   *  list. The other device keeps its cached session token until
   *  expiry (~7 days max); on its next /session refresh the Worker
   *  returns device_deactivated and that device's local state
   *  clears itself via main.ts's refreshLicenseStatus handler. */
  public async deactivateSiblingDevice(deviceId: string) {
    const sessionToken = this.plugin.settings.sessionToken;
    if (!sessionToken) {
      new Notice("Session expired - re-paste your key to refresh.", 5000);
      return;
    }
    try {
      await this.plugin.licenseClient.deactivateDevice(sessionToken, deviceId);
      new Notice("Device deactivated.", 4000);
    } catch (err) {
      const msg = err instanceof LicenseClientError
        ? this.friendlyError(err)
        : "Couldn't reach the licensing server.";
      new Notice(msg, 5000);
      return;
    }
    // Re-render Devices section to reflect the change.
    (this as unknown as { display: () => void }).display();
  }

  

  

  

  

  /** Apply a fake license-settings shape and re-render. Starts from
   *  a fully-cleared base so partial patches don't leave stale fields
   *  (e.g. forcing Polling shouldn't leave a stale licenseKey). The
   *  deviceId is preserved across forces - only the explicit Reset
   *  action regenerates it. */
  public async forceLicenseState(state: {
    licenseKey?: string;
    sessionToken?: string;
    sessionExpiresAt?: number;
    customerId?: string;
    customerEmail?: string;
    tier?: "v1" | "v2";
    everValidated?: boolean;
    lastValidatedAt?: number;
    licenseExpiresAt?: number;
    pendingTrialActivation?: ButterSettings["pendingTrialActivation"];
    activatedAt?: number;
    wasDeactivated?: boolean;
    wasInvalidated?: boolean;
    lastReason?: string;
    devTestMode?: boolean;
  }, saveToDisk = true) {
    this.plugin.settings.licenseKey = "";
    this.plugin.settings.sessionToken = "";
    this.plugin.settings.sessionExpiresAt = 0;
    this.plugin.settings.customerId = "";
    this.plugin.settings.customerEmail = "";
    this.plugin.settings.tier = "v1";
    this.plugin.settings.everValidated = false;
    this.plugin.settings.lastValidatedAt = 0;
    this.plugin.settings.licenseExpiresAt = 0;
    this.plugin.settings.pendingTrialActivation = null;
    this.plugin.settings.activatedAt = 0;
    this.plugin.settings.wasDeactivated = false;
    this.plugin.settings.wasInvalidated = false;
    this.plugin.settings.lastReason = "";
    this.plugin.settings.devTestMode = false;
    Object.assign(this.plugin.settings, state);
    if (saveToDisk) {
      await this.plugin.saveSettings();
    }
    await this.plugin.refreshLicenseStatus();
    (this as unknown as { display: () => void }).display();
  }

  

  // ── Inline trial activation (replaces TrialPollingModal) ────

  /** Tap-to-trial: hits `/trial`, persists `pendingTrialActivation`
   *  (including the browser-fallback `checkoutUrl`), flips the
   *  License-status section into the polling phase, and starts the
   *  inline poll loop. Idempotent - a second tap while polling is a
   *  no-op. */
  public async beginTrialActivation(): Promise<void> {
    this.plugin.isActivatingTrialFlow = false; // Clear UI flag instantly
    if (this.plugin.settings.pendingTrialActivation) {
      return;
    }

    // Show pending state immediately so the user knows it's working
    this.plugin.settings.pendingTrialActivation = { pollToken: "", startedAt: Date.now() };
    (this as unknown as { display: () => void }).display();

    try {
      const resp = await this.plugin.licenseClient.startInstantTrial(
        this.plugin.settings.deviceId,
      );
      this.plugin.settings.licenseKey = resp.licenseKey;
      this.plugin.settings.licenseExpiresAt = Date.parse(resp.expiresAt);
      this.plugin.settings.everValidated = true;
      this.plugin.settings.activatedAt = Date.now();
      this.plugin.settings.pendingTrialActivation = null;
      await this.plugin.saveSettings();
      await this.plugin.refreshLicenseStatus();
      new Notice(`Trial activated! You have ${TRIAL_LENGTH_DAYS} days of full access.`, 5000);
      import("canvas-confetti").then((module) => {
        const confetti = module.default || module;
        void confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      }).catch(() => {});
    } catch (err) {
      this.plugin.settings.pendingTrialActivation = null;
      console.error("[beginTrialActivation] Error starting trial:", err);
      if (err instanceof LicenseClientError && err.kind === "trial_used") {
        new Notice(
          "Your free trial has already been used on this device. Purchase a license to keep using Butter.",
          10_000,
        );
        this.plugin.settings.everValidated = true;
        this.plugin.settings.lastReason = "trial_used";
        await this.plugin.saveSettings();
      } else {
        const msg = err instanceof LicenseClientError
          ? this.friendlyError(err)
          : "Couldn't reach the licensing server.";
        new Notice(msg, 7000);
      }
    }
    (this as unknown as { display: () => void }).display();
  }

  public openCheckoutAndPoll(): void {
    this.plugin.startLifetimeCheckoutFlow();
  }

  /** Single `/trial/poll` request. Updates settings on `ready`,
   *  re-renders accordingly. Re-arms via `display()` if still
   *  polling. */
  public async runTrialPollOnce(): Promise<void> {
    const pending = this.plugin.settings.pendingTrialActivation;
    if (!pending) {
      return;
    }
    const ageMs = Date.now() - (pending.startedAt || 0);
    if (ageMs > 30 * 60_000) {
      console.warn("[runTrialPollOnce] Trial activation timed out (30m).");
      this.plugin.settings.pendingTrialActivation = null;
      await this.plugin.saveSettings();
      new Notice(
        "Trial activation timed out. Open settings → license to try again.",
        10_000,
      );
      (this as unknown as { display: () => void }).display();
      return;
    }
    try {
      const res = await this.plugin.licenseClient.pollTrial(pending.pollToken);
      if (res.status === "ready" && res.licenseKey) {
        this.plugin.settings.licenseKey = res.licenseKey;
        if (res.expiresAt) {
          const exp = Date.parse(res.expiresAt);
          if (!Number.isNaN(exp)) this.plugin.settings.licenseExpiresAt = exp;
        }
        this.plugin.settings.pendingTrialActivation = null;
        if (!this.plugin.settings.activatedAt) {
          this.plugin.settings.activatedAt = Date.now();
        }
        // Fresh activation clears any sticky failure flags from a
        // prior state. customerEmail + tier get populated by the
        // first /session call that follows (via refreshLicenseStatus
        // below); we don't need to clear them since this is a brand
        // new license attaching to this device.
        this.plugin.settings.wasDeactivated = false;
        this.plugin.settings.wasInvalidated = false;
        this.plugin.settings.lastReason = "";
        await this.plugin.saveSettings();
        await this.plugin.refreshLicenseStatus();
        new Notice("Trial activated!", 4000);
        
        import("canvas-confetti").then((module) => {
          const confetti = module.default || module;
          void confetti({
            particleCount: 100,
            spread: 70,
            origin: { y: 0.6 }
          });
        }).catch(e => console.error("Confetti failed to load:", e));

        (this as unknown as { display: () => void }).display();
        return;
      }
    } catch (err) {
      console.error(`[runTrialPollOnce] Error polling trial:`, err);
      if (err instanceof LicenseClientError && err.kind === "invalid_token") {
        // Token rotted - reset and let the user retry.
        this.plugin.settings.pendingTrialActivation = null;
        await this.plugin.saveSettings();
        (this as unknown as { display: () => void }).display();
        return;
      }
      // Transient - fall through, schedule next tick.
    }
    // Pending. Re-render so the "Still working on it…" copy can
    // appear once we cross the 25s threshold, then re-schedule.
    (this as unknown as { display: () => void }).display();
  }

  /**
   * Validate-license-key flow: call /session, persist the issued
   * sessionToken, refresh status. On failure, show the typed error
   * message inline beneath the input.
   */
  public async validateLicenseKeyFlow(
    licenseKey: string,
    errorEl: HTMLElement | null,
  ): Promise<void> {
    if (errorEl) errorEl.addClass("butter-hidden");
    try {
      const session = await this.plugin.licenseClient.validateAndIssueSession(
        licenseKey,
        this.plugin.settings.deviceId,
      );
      this.plugin.settings.licenseKey = licenseKey;
      this.plugin.settings.sessionToken = session.sessionToken;
      this.plugin.settings.sessionExpiresAt = Date.parse(session.expiresAt);
      this.plugin.settings.lastValidatedAt = Date.now();
      if (session.customerId) this.plugin.settings.customerId = session.customerId;
      if (session.email) this.plugin.settings.customerEmail = session.email;
      if (session.tier) this.plugin.settings.tier = session.tier;
      this.plugin.settings.everValidated = true;
      if (!this.plugin.settings.activatedAt) {
        this.plugin.settings.activatedAt = Date.now();
      }
      // Fresh activation clears any sticky failure flags from a
      // prior state so the License tab doesn't briefly show
      // "deactivated"/"invalidated" between save + re-render.
      this.plugin.settings.wasDeactivated = false;
      this.plugin.settings.wasInvalidated = false;
      this.plugin.settings.lastReason = "";
      await this.plugin.saveSettings();
      await this.plugin.refreshLicenseStatus();
      (this as unknown as { display: () => void }).display();
      new Notice("License activated.", 4000);

      import("canvas-confetti").then((module) => {
        const confetti = module.default || module;
        void confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 }
        });
      }).catch(e => console.error("Confetti failed to load:", e));
    } catch (err) {
      const msg = err instanceof LicenseClientError
        ? this.friendlyError(err)
        : "Couldn't reach the licensing server.";
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.removeClass("butter-hidden");
      } else {
        new Notice(msg, 7000);
      }
    }
  }

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  /** Drift-check wrapper for a bundled-setting toggle. If changing
   *  `settingKey` to `newValue` would move the user out of an active
   *  preset, fires the drift confirm modal. Returns true if the
   *  caller should proceed with the change, false if it should
   *  revert the toggle (already reverted here). Use at the top of
   *  any bundled toggle's onChange before mutating settings. */
  public async gateBundledToggle(
    t: { setValue(v: boolean): void },
    settingKey: keyof ButterSettings,
    newValue: boolean,
    settingLabel: string,
  ): Promise<boolean> {
    const drift = wouldDriftFromActive(
      this.plugin,
      settingKey,
      newValue,
    );
    if (drift === null) return true;
    const ok = await this.confirmPresetDrift(drift, settingLabel);
    if (!ok) {
      t.setValue(this.plugin.settings[settingKey] as boolean);
      return false;
    }
    return true;
  }

  /** Drift-check wrapper for a bundled string-valued dropdown (e.g.
   *  canonical-glyph picks). Same flow as gateBundledToggle but
   *  reverts via setValue(string) so the dropdown returns to the
   *  current setting if the user cancels the drift modal. */
  public async gateBundledChoice(
    d: { setValue(v: string): void },
    settingKey: keyof ButterSettings,
    newValue: string,
    settingLabel: string,
  ): Promise<boolean> {
    const drift = wouldDriftFromActive(
      this.plugin,
      settingKey,
      newValue,
    );
    if (drift === null) return true;
    const ok = await this.confirmPresetDrift(drift, settingLabel);
    if (!ok) {
      d.setValue(this.plugin.settings[settingKey] as string);
      return false;
    }
    return true;
  }

  
  public renderGeneralIntroSections(root: HTMLElement) {
    return renderGeneralIntroSections.call(this, root);
  }

  public renderLicense(root: HTMLElement) {
    return renderLicense.call(this, root);
  }

  public computeLicensePhase(): | "unlicensed" | "polling" | "trial" | "valid" | "expired" | "unknown"
    | "offline" | "deactivated" | "invalidated" {
    return computeLicensePhase.call(this);
  }

  public renderRowsFor(parent: HTMLElement, phase: ReturnType<typeof this.computeLicensePhase>) {
    return renderRowsFor.call(this, parent, phase);
  }

  public renderUnlicensedRows(parent: HTMLElement) {
    return renderUnlicensedRows.call(this, parent);
  }

  public renderPollingRows(parent: HTMLElement) {
    return renderPollingRows.call(this, parent);
  }

  public renderTrialRows(parent: HTMLElement) {
    return renderTrialRows.call(this, parent);
  }

  public renderLifetimeRows(parent: HTMLElement) {
    return renderLifetimeRows.call(this, parent);
  }

  public renderDeactivatedRows(parent: HTMLElement) {
    return renderDeactivatedRows.call(this, parent);
  }

  public renderInvalidatedRows(parent: HTMLElement) {
    return renderInvalidatedRows.call(this, parent);
  }

  public reasonCopyFor(reason: string): string {
    return reasonCopyFor.call(this, reason);
  }

  public renderExpiredRows(parent: HTMLElement) {
    return renderExpiredRows.call(this, parent);
  }

  public renderUnknownRows(parent: HTMLElement) {
    return renderUnknownRows.call(this, parent);
  }

  public trialHeadlineFor(remaining: { daysLeft: number; hoursLeft: number; expired: boolean }): string {
    return trialHeadlineFor.call(this, remaining);
  }

  public trialStatLineFor(remaining: { daysLeft: number; hoursLeft: number; daysUsed: number; expired: boolean }): string {
    return trialStatLineFor.call(this, remaining);
  }

  public formatActivationDate(ms: number): string {
    return formatActivationDate.call(this, ms);
  }

  public formatRelativeTime(ms: number): string {
    return formatRelativeTime.call(this, ms);
  }

  public renderKeyRow(parent: HTMLElement) {
    return renderKeyRow.call(this, parent);
  }

  public renderPasteKeyRow(parent: HTMLElement, asUpdate: boolean) {
    return renderPasteKeyRow.call(this, parent, asUpdate);
  }

  public renderRecoveryRow(parent: HTMLElement) {
    return renderRecoveryRow.call(this, parent);
  }

  public renderDevicesSection(root: HTMLElement) {
    return renderDevicesSection.call(this, root);
  }

  public renderDeviceListSkeleton(parent: HTMLElement) {
    return renderDeviceListSkeleton.call(this, parent);
  }

  public renderDeviceRow(parent: HTMLElement, device: DeviceWireRecord) {
    return renderDeviceRow.call(this, parent, device);
  }

  public renderCurrentDeviceFallback(parent: HTMLElement, hintText: string) {
    return renderCurrentDeviceFallback.call(this, parent, hintText);
  }

  public renderDeviceUtilities(section: HTMLElement) {
    return renderDeviceUtilities.call(this, section);
  }

  public renderSupportSection(root: HTMLElement) {
    return renderSupportSection.call(this, root);
  }

  public computeRemaining(): {
    daysLeft: number;
    hoursLeft: number;
    daysUsed: number;
    expired: boolean;
  } {
    return computeRemaining.call(this);
  }

  public scheduleTrialPoll() {
    return scheduleTrialPoll.call(this);
  }

  public friendlyError(err: LicenseClientError): string {
    return friendlyError.call(this, err);
  }

  public renderGeneral(root: HTMLElement) {
    return renderGeneral.call(this, root);
  }

  public renderBehavior(root: HTMLElement) {
    return renderBehavior.call(this, root);
  }

  public renderAdvanced(root: HTMLElement) {
    return renderAdvanced.call(this, root);
  }

  public renderStartTrialCardIfApplicable(root: HTMLElement) {
    return renderStartTrialCardIfApplicable.call(this, root);
  }

  public renderToolbar(root: HTMLElement) {
    return renderToolbar.call(this, root);
  }

  public renderLayoutSection(root: HTMLElement, getSegment: () => "desktop" | "mobile", reRenders: Array<() => void>): void {
    return renderLayoutSection.call(this, root, getSegment, reRenders);
  }

  public createSettingGroup(parent: HTMLElement, heading: string, description?: string, action?: {
      icon: string;
      tooltip: string;
      onClick: () => void | Promise<void>;
    }, tag?: { label: string; icon?: string }): HTMLElement {
    return createSettingGroup.call(this, parent, heading, description, action, tag);
  }

  public renderPrimaryToolbarSection(root: HTMLElement, getSegment: () => "desktop" | "mobile", reRenders: Array<() => void>): void {
    return renderPrimaryToolbarSection.call(this, root, getSegment, reRenders);
  }

  public renderTableToolbarSection(root: HTMLElement, getSegment: () => "desktop" | "mobile", reRenders: Array<() => void>): void {
    return renderTableToolbarSection.call(this, root, getSegment, reRenders);
  }

  public renderLayoutEditor(root: HTMLElement, title: string, desc: string, defs: ReadonlyArray<{
      id: string;
      label: string;
      group: string;
      icon: string;
    }>, getLayout: () => ToolbarLayoutItem[], saveLayout: (layout: ToolbarLayoutItem[]) => Promise<void>, presets: ReadonlyArray<{
      name: string;
      desc: string;
      cta?: boolean;
      build: () => ToolbarLayoutItem[];
    }>, tag?: { label: string; icon?: string }) {
    return renderLayoutEditor.call(this, root, title, desc, defs, getLayout, saveLayout, presets, tag);
  }

  public openMoveToSubmenuMenu(anchor: HTMLElement, submenus: Array<Extract<ToolbarLayoutItem, { type: "submenu" }>>, onPick: (submenuId: string) => void | Promise<void>) {
    return openMoveToSubmenuMenu.call(this, anchor, submenus, onPick);
  }

  public openSubmenuEditModal(item: Extract<ToolbarLayoutItem, { type: "submenu" }>, onSave: (
      updated: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    ) => void | Promise<void>, isNew = false) {
    return openSubmenuEditModal.call(this, item, onSave, isNew);
  }

  public wireDrag(handle: HTMLElement, row: HTMLElement, rootLayout: ToolbarLayoutItem[], draggedItemId: string, onCommit: () => void | Promise<void>) {
    return wireDrag.call(this, handle, row, rootLayout, draggedItemId, onCommit);
  }

  public renderOutlineSection(root: HTMLElement) {
    return renderOutlineSection.call(this, root);
  }

  public renderDragSection(root: HTMLElement) {
    return renderDragSection.call(this, root);
  }

  public renderSourceSection(root: HTMLElement) {
    return renderSourceSection.call(this, root);
  }

  public showWarning(): Promise<boolean> {
    return showWarning.call(this);
  }

  public confirmPresetDrift(activePreset: SourcePurityMode, settingLabel: string): Promise<boolean> {
    return confirmPresetDrift.call(this, activePreset, settingLabel);
  }

  public renderDebugSection(root: HTMLElement) {
    return renderDebugSection.call(this, root);
  }
}


export class NormalizeWarningModal extends Modal {
  public resolved = false;
  constructor(app: App, public resolve: (ok: boolean) => void) {
    super(app);
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Enable source normalization?");
    contentEl.createEl("p", {
      text:
        "You're turning on a setting that automatically changes file formatting on save. Files with different formatting will be adjusted the next time they're saved.",
    });
    contentEl.createEl("p", {
      text:
        "This is an advanced feature. Most users prefer the default so they can switch freely between Butter, Live Preview, and Source mode without their files being reformatted.",
    });
    contentEl.createEl("p", {
      text:
        "Continue only if you understand you're opting into automatic source changes.",
    });
    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const okBtn = btnRow.createEl("button", {
      text: "I understand - enable",
      cls: "mod-cta",
    });
    cancelBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolve(false);
      this.close();
    });
    okBtn.addEventListener("click", () => {
      this.resolved = true;
      this.resolve(true);
      this.close();
    });
  }
  onClose() {
    // If the user dismissed via Esc / clicking outside without
    // clicking a button, treat that as a cancel.
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}

/** Edit a submenu's icon + label. New submenus open with default
 *  values; existing ones populate from the current attrs. */
export class SubmenuEditModal extends Modal {
  public current: Extract<ToolbarLayoutItem, { type: "submenu" }>;
  constructor(
    app: App,
    initial: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    public isNew: boolean,
    public onSave: (
      updated: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    ) => void | Promise<void>,
  ) {
    super(app);
    // Local copy so cancel discards any edits.
    this.current = JSON.parse(JSON.stringify(initial)) as Extract<
      ToolbarLayoutItem,
      { type: "submenu" }
    >;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    if (Platform.isMobile) this.modalEl.addClass("mod-lg");
    titleEl.setText(this.isNew ? "Add submenu" : "Edit submenu");

    const previewWrap = contentEl.createDiv({
      cls: "butter-submenu-edit-preview",
    });
    const previewIcon = previewWrap.createDiv({
      cls: "butter-submenu-edit-preview-icon",
    });
    setIcon(previewIcon, this.current.icon || "more-horizontal");
    const previewLabel = previewWrap.createDiv({
      cls: "butter-submenu-edit-preview-label",
      text: this.current.label || "Submenu",
    });

    new Setting(contentEl)
      .setName("Label")
      .setDesc("Shown as the submenu's tooltip.")
      .addText((t) => {
        t.setValue(this.current.label).onChange((v) => {
          this.current.label = v;
          previewLabel.setText(v || "Submenu");
        });
        t.inputEl.addClass("butter-submenu-label-input");
      });

    // Icon picker - search box on top, scrollable grid below.
    // Sourced from Obsidian's full icon registry via `getIconIds`,
    // so plugin-registered custom icons (including Butter's own
    // `butter-delete-row` etc.) show up alongside Lucide.
    const iconWrap = contentEl.createDiv({ cls: "butter-icon-picker" });
    iconWrap.createEl("div", {
      cls: "butter-icon-picker-label",
      text: "Icon",
    });
    const search = iconWrap.createEl("input", {
      cls: "butter-icon-picker-search",
      attr: { type: "text", placeholder: "Search icons…" },
    });
    const grid = iconWrap.createDiv({ cls: "butter-icon-picker-grid" });

    const allIds = getIconIds();
    // Strip "lucide-" prefix for display + matching since `setIcon`
    // accepts either form. Sort alphabetically. Filter out a small
    // set of non-iconic markers (Lucide ships some empty / debug
    // entries on certain Obsidian versions).
    const normalized = Array.from(
      new Set(allIds.map((id) => id.replace(/^lucide-/, ""))),
    )
      .filter((id) => id.length > 0)
      .sort();

    const renderGrid = (query: string) => {
      grid.empty();
      const q = query.trim().toLowerCase();
      const matches = q
        ? normalized.filter((id) => id.toLowerCase().includes(q))
        : normalized;
      // Cap rendered tiles for perf - the registry has ~1500 icons.
      const cap = 240;
      const shown = matches.slice(0, cap);
      for (const id of shown) {
        const tile = grid.createEl("button", {
          cls: "butter-icon-picker-tile",
          attr: { type: "button", "aria-label": id, "data-icon-id": id },
        });
        if (id === this.current.icon) tile.classList.add("is-selected");
        setIcon(tile, id);
        tile.addEventListener("click", (e) => {
          e.preventDefault();
          this.current.icon = id;
          previewIcon.empty();
          setIcon(previewIcon, id);
          // Refresh the grid's selection ring.
          grid
            .querySelectorAll(".butter-icon-picker-tile.is-selected")
            .forEach((el) => el.classList.remove("is-selected"));
          tile.classList.add("is-selected");
        });
      }
      if (matches.length > cap) {
        grid.createEl("div", {
          cls: "butter-icon-picker-overflow",
          text: `Showing first ${cap} of ${matches.length} matches - refine your search.`,
        });
      }
      if (matches.length === 0) {
        grid.createEl("div", {
          cls: "butter-icon-picker-empty",
          text: "No icons match.",
        });
      }
    };
    renderGrid("");
    search.addEventListener("input", () => renderGrid(search.value));

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    const saveBtn = btnRow.createEl("button", {
      text: this.isNew ? "Add" : "Save",
      cls: "mod-cta",
    });
    cancelBtn.addEventListener("click", () => this.close());
    saveBtn.addEventListener("click", () => {
      // Default icon if blank (avoid invisible submenu).
      if (!this.current.icon) this.current.icon = "more-horizontal";
      if (!this.current.label) this.current.label = "Submenu";
      void (async () => {
        await this.onSave(this.current);
        this.close();
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
/**
 * Per-device deactivation confirmation. Shown only for the "this
 * device" action since sibling-device deactivations are
 * non-destructive locally. The license key itself stays valid; the
 * user can re-add the device later by re-pasting the key.
 */
export class DeactivateConfirmModal extends Modal {
  constructor(
    app: App,
    public onConfirm: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Deactivate this device?" });
    contentEl.createEl("p", {
      text:
        "Removes the cached license from this Obsidian install. Your license key stays valid - paste it back on this or any other device any time to re-add it.",
    });
    contentEl.createEl("p", {
      text:
        "Butter editor will switch to read-only mode here until you re-add the device.",
      cls: "setting-item-description",
    });

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = btnRow.createEl("button", { text: "Cancel" });
    const ok = btnRow.createEl("button", {
      text: "Deactivate",
      cls: "mod-warning",
    });
    cancel.addEventListener("click", () => this.close());
    ok.addEventListener("click", () => {
      void (async () => {
        await this.onConfirm();
        this.close();
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

