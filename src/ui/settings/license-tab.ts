import { Setting, Notice, setIcon } from "obsidian";
import { ButterSettingTab, DeactivateConfirmModal } from "../settings-tab";
import type { DeviceWireRecord } from "../../integration/license/client";
import { LicenseClientError } from "../../integration/license/client";
import { TRIAL_LENGTH_DAYS, MAX_DEVICES_PER_CUSTOMER } from "../../integration/license/policy";
import { LINKS } from "../../integration/license/links";
import {
  formatI18nRelativeTime,
  formatI18nUnit,
  getI18nLanguage,
  tx,
  tv,
} from "../../i18n";

/**
   * License tab - four-zone layout: brand stamp, hero, settings
   * card, destructive footer. Below the polished frame the Device
   * + Support sections render as plain native Obsidian setting stacks
   * for utility access (device id, diagnostic copy, docs/issues/
   * email/privacy/terms links). Trial activation morphs the frame in
   * place via `pendingTrialActivation`.
   */
  export function renderLicense(this: ButterSettingTab, root: HTMLElement) {
    // Bump the generation so any in-flight poll-tick from a prior
    // render bails before mutating settings or scheduling next.
    this.pollGeneration++;
    if (this.trialPollTimer != null) {
      window.clearTimeout(this.trialPollTimer);
      this.trialPollTimer = null;
    }

    const phase = this.computeLicensePhase();
    // The License settings group: native Obsidian section group
    // (heading + body). The body holds the ticket on top, then
    // native hairline-divided detail rows below, all in one card.
    // Same chrome as Devices + Support below.
    const section = this.createSettingGroup(root, tx("License"), undefined);
    section.addClass("butter-license-section");
    this.renderRowsFor(section, phase);

    this.renderDevicesSection(root);
    this.renderSupportSection(root);

    // If we're in the polling phase, kick the inline poll. Idempotent
    // because we cleared the timer above.
    if (phase === "polling") this.scheduleTrialPoll();
  }

/** Resolve the effective License-tab phase from the plugin's
   *  reported `licenseStatus` plus the in-flight pendingTrialActivation
   *  overlay and the offline-grace heuristic. The pending activation
   *  only counts as "polling" if no license is already active - once
   *  the poll completes the field is cleared, but a defensive check
   *  here guards against a stale pending entry overriding a freshly-
   *  active license. The "offline" sub-phase fires when the customer
   *  has been validated before but we couldn't reach the worker on
   *  the most recent attempt and the last successful check is more
   *  than an hour old. */
  export function computeLicensePhase(this: ButterSettingTab): | "unlicensed" | "polling" | "trial" | "valid" | "expired" | "unknown"
    | "offline" | "deactivated" | "invalidated" {
    if (this.plugin.isActivatingTrialFlow) return "polling";
    const s = this.plugin.settings;
    const pending = s.pendingTrialActivation;
    const status = this.plugin.licenseStatus;
    const hasLicense = Boolean(s.licenseKey);
    if (pending && !hasLicense) {
      const ageMs = Date.now() - (pending.startedAt || 0);
      if (ageMs <= 30 * 60 * 1000) return "polling";
    }
    // Sticky "this device was deactivated elsewhere" - fires only
    // when there's no current license to render (the deactivation
    // cleared it). Cleared on next successful activation.
    if (s.wasDeactivated && !hasLicense) return "deactivated";
    // Sticky "license was invalidated" (refund / chargeback /
    // revoked). Distinct from a natural trial expiry.
    if (s.wasInvalidated && status === "expired") return "invalidated";
    if (status === "unknown" && s.everValidated) {
      const since = Date.now() - (s.lastValidatedAt || 0);
      if (since > 60 * 60 * 1000) return "offline";
    }
    return status;
  }

function prependIcon(row: Setting, icon: string, cls: string) {
    const el = row.nameEl.createSpan({ cls });
    setIcon(el, icon);
    row.nameEl.prepend(el);
  }

// ── License section: per-state native rows ──────────────────

  /** Render the per-state License surface as a stack of native
   *  Obsidian `Setting()` rows. Top row carries the state name +
   *  one-line description + the primary action. Detail rows below
   *  show the relevant info (license key, customer, dates).
   *  Inline forms (paste-key, recovery) come last for states that
   *  need them. */
  export function renderRowsFor(this: ButterSettingTab, parent: HTMLElement, phase: ReturnType<typeof this.computeLicensePhase>) {
    switch (phase) {
      case "unlicensed":  this.renderUnlicensedRows(parent); break;
      case "polling":     this.renderPollingRows(parent); break;
      case "trial":       this.renderTrialRows(parent); break;
      case "valid":       this.renderLifetimeRows(parent); break;
      case "expired":     this.renderExpiredRows(parent); break;
      case "offline":     this.renderLifetimeRows(parent); break;
      case "deactivated": this.renderDeactivatedRows(parent); break;
      case "invalidated": this.renderInvalidatedRows(parent); break;
      case "unknown":
      default:            this.renderUnknownRows(parent); break;
    }
  }

export function renderUnlicensedRows(this: ButterSettingTab, parent: HTMLElement) {
    const hasActivated = !!this.plugin.settings.everValidated || !!this.plugin.settings.activatedAt;

    if (!hasActivated) {
      const row = new Setting(parent)
        .setName(tx("Free trial available"))
        .setDesc(tv("{days} days, full access. No card, no email.", { days: TRIAL_LENGTH_DAYS }))
          .addButton((b) =>
            b.setButtonText(tx("Start free trial")).setCta()
              .onClick(async () => {
                b.setDisabled(true);
                b.setButtonText(tx("Starting..."));
                await this.beginTrialActivation();
              }),
          )
          .addButton((b) =>
            b.setButtonText(tx("Purchase"))
              .onClick(() => { this.openCheckoutAndPoll(); }),
          );
      prependIcon(row, "badge-alert", "butter-license-icon-muted");
    } else {
      const row = new Setting(parent)
        .setName(tx("License required"))
        .setDesc(tx("This device has already used a free trial. Purchase a license to keep using Butter. One-time, no subscription."))
        .addButton((b) =>
          b.setButtonText(tx("Purchase")).setCta()
            .onClick(() => { this.openCheckoutAndPoll(); }),
        );
      prependIcon(row, "badge-alert", "butter-license-icon-muted");
    }

    this.renderPasteKeyRow(parent, /* asUpdate */ false);
    this.renderRecoveryRow(parent);
  }

export function renderPollingRows(this: ButterSettingTab, parent: HTMLElement) {
    const pending = this.plugin.settings.pendingTrialActivation;
    const ageSec = pending ? (Date.now() - (pending.startedAt || 0)) / 1000 : 0;
    const desc = ageSec > 15
      ? "Taking longer than expected. Your trial is being set up in the background - hang tight."
      : "Confirming with the licensing server. This usually takes a few seconds.";
    const row = new Setting(parent)
      .setName(tx("Activating trial..."))
      .setDesc(tx(desc));
    prependIcon(row, "loader-2", "butter-activating-spinner");
  }

export function renderTrialRows(this: ButterSettingTab, parent: HTMLElement) {
    const r = this.computeRemaining();
    const s = this.plugin.settings;
    const dayN = Math.min(TRIAL_LENGTH_DAYS, r.daysUsed + 1);
    const stateName = r.daysLeft <= 0 && r.hoursLeft > 0
      ? tv("Trial - {count} {unit} left", { count: r.hoursLeft, unit: formatI18nUnit("hour", r.hoursLeft) })
      : tv("Trial - {count} {unit} left", { count: r.daysLeft, unit: formatI18nUnit("day", r.daysLeft) });
    const exp = s.licenseExpiresAt
      ? tv("Day {day} of {total} - ends {date}.", { day: dayN, total: TRIAL_LENGTH_DAYS, date: this.formatActivationDate(s.licenseExpiresAt) })
      : tv("Day {day} of {total}.", { day: dayN, total: TRIAL_LENGTH_DAYS });
    const row = new Setting(parent)
      .setName(stateName)
      .setDesc(exp)
      .addButton((b) =>
        b.setButtonText(tx("Purchase")).setCta()
          .onClick(() => { this.openCheckoutAndPoll(); }),
      );
    prependIcon(row, "hourglass", "butter-license-icon-trial");
    this.renderKeyRow(parent);
    this.renderPasteKeyRow(parent, /* asUpdate */ true);
  }

export function renderLifetimeRows(this: ButterSettingTab, parent: HTMLElement) {
    const s = this.plugin.settings;
    const tierLabel = s.tier === "v2" ? "v2" : "v1";
    const row = new Setting(parent)
      .setName(`${tx("Lifetime License")} - ${tierLabel}`)
      .setDesc(tx("Thanks for buying Butter - yours, forever."));
    prependIcon(row, "badge-check", "butter-license-icon-paid");
    row
      .addButton((b) =>
        b.setButtonText(tx("Manage license")).setCta()
          .onClick(() => { window.open(LINKS.licensePortal, "_blank"); }),
      );
    this.renderKeyRow(parent);
    // `customerId` is Polar's internal billing identifier (`cust_xxx`).
    // It used to render here as a fallback "Customer" row when no
    // email was on file - opaque to the user, useful to nobody but
    // support, and confusing as a settings row. Removed; if support
    // ever needs it, it stays available in the diagnostic copy under
    // Devices → Copy diagnostics.
    const realEmail = s.customerEmail && !/^trial-[0-9a-f]+@buttereditor\.com$/i.test(s.customerEmail)
      ? s.customerEmail : "";
    if (s.activatedAt) {
      const desc = realEmail
        ? tv("{email} - Activated {date}", { email: realEmail, date: this.formatActivationDate(s.activatedAt) })
        : tv("Activated {date}", { date: this.formatActivationDate(s.activatedAt) });
      new Setting(parent)
        .setName(tx(realEmail ? "Registered email" : "Activated"))
        .setDesc(desc);
    } else if (realEmail) {
      new Setting(parent).setName(tx("Registered email")).setDesc(realEmail);
    }
    this.renderPasteKeyRow(parent, /* asUpdate */ true);
  }

/** "This device was deactivated from elsewhere" - sticky state
   *  set by refreshLicenseStatus when /session returns
   *  device_deactivated. Cleared on next successful activation. */
  export function renderDeactivatedRows(this: ButterSettingTab, parent: HTMLElement) {
    new Setting(parent)
      .setName(tx("Device deactivated"))
      .setDesc(tx("This install was removed from your license from another device. Paste your key to add it back."));
    this.renderPasteKeyRow(parent, /* asUpdate */ false);
    this.renderRecoveryRow(parent);
  }

/** License was invalidated by the server (refund, chargeback,
   *  revoked, or key not recognized). Distinct from a natural trial
   *  expiry - the user was a real customer who lost access for a
   *  specific reason we can surface. */
  export function renderInvalidatedRows(this: ButterSettingTab, parent: HTMLElement) {
    const s = this.plugin.settings;
    const reason = this.reasonCopyFor(s.lastReason);
    new Setting(parent)
      .setName(tx("License could not be verified"))
      .setDesc(tv("We couldn't validate your license. {reason}", { reason }))
      .addButton((b) =>
        b.setButtonText(tx("Re-check")).setCta().onClick(async () => {
          await this.plugin.refreshLicenseStatus();
          (this as unknown as { display: () => void }).display();
        }),
      );
    new Setting(parent)
      .setName(tx("Contact support"))
      .setDesc(tx("If this is unexpected, get in touch and we'll sort it."))
      .addButton((b) =>
        b.setButtonText(tx("Email")).onClick(() => {
          window.open(`mailto:${LINKS.supportEmail}`, "_blank");
        }),
      );
    this.renderPasteKeyRow(parent, /* asUpdate */ false);
  }

/** Maps the lastReason error.kind to a one-line explanation. */
  export function reasonCopyFor(this: ButterSettingTab, reason: string): string {
    switch (reason) {
      case "license_invalid":
        return tx("The key was not recognized by the server (refund, chargeback, or revoked).");
      case "device_deactivated":
        return tx("This device was deactivated from another machine.");
      case "polar_error":
        return tx("The licensing service is temporarily unavailable.");
      case "network":
        return tx("We couldn't reach the licensing server.");
      default:
        return tx("Try again, or contact support if this persists.");
    }
  }

  export function renderExpiredRows(this: ButterSettingTab, parent: HTMLElement) {
    const expiredAt = this.plugin.settings.licenseExpiresAt || 0;
    const isFuture = expiredAt > Date.now();
    let desc = tx("Your free trial has expired. Purchase a license to keep using Butter. One-time, no subscription.");
    let title = tx("Free trial expired");
    if (expiredAt) {
      if (isFuture) {
        title = tx("Trial revoked");
        desc = tx("Your trial was revoked. Purchase a license to keep using Butter.");
      } else {
        desc = tv("Your free trial expired {date}. Purchase a license to keep using Butter.", { date: this.formatActivationDate(expiredAt) });
      }
    }
    const row = new Setting(parent)
      .setName(title)
      .setDesc(desc)
      .addButton((b) =>
        b.setButtonText(tx("Purchase")).setCta()
          .onClick(() => { this.openCheckoutAndPoll(); }),
      );
    prependIcon(row, "badge-x", "butter-license-icon-expired");
    this.renderPasteKeyRow(parent, /* asUpdate */ false);
  }


export function renderUnknownRows(this: ButterSettingTab, parent: HTMLElement) {
    const row = new Setting(parent)
      .setName(tx("Checking license..."))
      .setDesc(tx("Verifying with the licensing server."))
      .addButton((b) => b.setButtonText(tx("Checking...")).setDisabled(true));
    prependIcon(row, "badge-alert", "butter-license-icon-muted");
  }

// ── Trial / time formatters (used by hero meta) ──────────────

  /** Trial-state headline copy table. Urgency lives ONLY here
   *  the layout, accent, and CTA stay constant across the full
   *  trial so day N-1 doesn't visually shout at the user. Buckets
   *  are computed as fractions of `TRIAL_LENGTH_DAYS` so the copy
   *  follows trial-length changes automatically. */
  export function trialHeadlineFor(this: ButterSettingTab, remaining: { daysLeft: number; hoursLeft: number; expired: boolean }): string {
    if (remaining.expired) return tx("Trial expired.");
    if (remaining.daysLeft <= 0) return tx("Today's the day.");
    if (remaining.daysLeft === 1) return tx("One day left.");
    if (remaining.daysLeft === 2) return tx("Two days left.");
    const pct = remaining.daysLeft / TRIAL_LENGTH_DAYS;
    if (pct <= 0.33) return tx("Closing in.");
    if (pct <= 0.66) return tx("Halfway through.");
    return tx("Settling in.");
  }

/** Mono detail line below the trial headline. Format:
   *  "day {n} of {TRIAL_LENGTH_DAYS} · ends {date}" or
   *  "· ends in {h}h" on the last day. Plays well against the
   *  italic-serif headline. */
  export function trialStatLineFor(this: ButterSettingTab, remaining: { daysLeft: number; hoursLeft: number; daysUsed: number; expired: boolean }): string {
    const dayN = Math.min(TRIAL_LENGTH_DAYS, Math.max(1, remaining.daysUsed + 1));
    const exp = this.plugin.settings.licenseExpiresAt
      || this.plugin.settings.sessionExpiresAt
      || 0;
    if (!exp) return tv("day {day} of {total}", { day: dayN, total: TRIAL_LENGTH_DAYS });
    if (remaining.expired) return tv("day {day} of {total} - ended", { day: TRIAL_LENGTH_DAYS, total: TRIAL_LENGTH_DAYS });
    const dateStr = remaining.daysLeft <= 0
      ? tv("ends in {hours}h", { hours: Math.max(1, remaining.hoursLeft) })
      : tv("ends {date}", { date: this.formatActivationDate(exp) });
    return tv("day {day} of {total} - {date}", { day: dayN, total: TRIAL_LENGTH_DAYS, date: dateStr });
  }

/** Compact "Mon DD, YYYY" - Intl.DateTimeFormat with short month.
   *  Year omitted when the date is in the current calendar year. */
  export function formatActivationDate(this: ButterSettingTab, ms: number): string {
    if (!ms) return "-";
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(getI18nLanguage(), {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  }

/** "5 minutes ago" / "3 hours ago" / "yesterday" / "Mon DD"
   *  used by the Offline state for the last-verified line. */
  export function formatRelativeTime(this: ButterSettingTab, ms: number): string {
    if (!ms) return "-";
    const diffMs = Date.now() - ms;
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return tx("just now");
    if (min < 60) return formatI18nRelativeTime(min, "minute");
    const hr = Math.floor(min / 60);
    if (hr < 24) return formatI18nRelativeTime(hr, "hour");
    const day = Math.floor(hr / 24);
    if (day < 7) return formatI18nRelativeTime(day, "day", "auto");
    return this.formatActivationDate(ms);
  }

export function renderKeyRow(this: ButterSettingTab, parent: HTMLElement) {
    const setting = new Setting(parent).setName(tx("License key"));
    setting.descEl.createEl("code", {
      cls: "butter-license-keyview",
      text: this.plugin.settings.licenseKey || "-",
    });
    setting.addButton((b) =>
      b.setButtonText(tx("Copy")).onClick(async () => {
        try {
          await navigator.clipboard.writeText(this.plugin.settings.licenseKey);
          new Notice(tx("License key copied."), 2000);
        } catch {
          new Notice(tx("Couldn't copy - your browser blocked clipboard access."), 4000);
        }
      }),
    );
  }


/** Paste-key form, one-shot Setting row. `asUpdate` flips copy
   *  between "Have a license key?" and "Update license key". */
  export function renderPasteKeyRow(this: ButterSettingTab, parent: HTMLElement, asUpdate: boolean) {
    let keyInputValue = "";
    const setting = new Setting(parent)
      .setName(tx(asUpdate ? "Update license key" : "Have a license key?"))
      .setDesc(asUpdate
        ? tx("Replace the active key (e.g. trial to lifetime).")
        : tx("Paste the key from your purchase or recovery email."))
      .addText((t) =>
        t.setPlaceholder("BTR-xxxx-xxxx-xxxx")
          .onChange((v) => { keyInputValue = v.trim(); }),
      );
    const errorEl = setting.descEl.createDiv({ cls: "butter-license-error" });
    errorEl.addClass("butter-hidden");
    setting.addButton((b) =>
      b.setButtonText(tx("Validate")).setCta().onClick(async () => {
        if (!keyInputValue) { new Notice(tx("Paste a key first.")); return; }
        await this.validateLicenseKeyFlow(keyInputValue, errorEl);
      }),
    );
  }

export function renderRecoveryRow(this: ButterSettingTab, parent: HTMLElement) {
    let recoverEmail = "";
    new Setting(parent)
      .setName(tx("Lost your key?"))
      .setDesc(tx("We'll email a one-time access link to recover your licenses."))
      .addText((t) =>
        t.setPlaceholder("you@example.com")
          .onChange((v) => { recoverEmail = v.trim(); }),
      )
      .addButton((b) =>
        b.setButtonText(tx("Send link")).onClick(async () => {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoverEmail)) {
            new Notice(tx("Enter a valid email first."));
            return;
          }
          try {
            await this.plugin.licenseClient.requestRecovery(recoverEmail);
            new Notice(
              tx("If a license exists for that email, a recovery link is on its way."),
              7000,
            );
          } catch (err) {
            const msg = err instanceof LicenseClientError
              ? this.friendlyError(err)
              : tx("Couldn't reach the licensing server. Try again in a moment.");
            new Notice(msg, 7000);
          }
        }),
      );
  }

// ── Section 2: Devices ──────────────────────────────────────

  /** Devices using this license. Each row shows the device's
   *  activation date and a Deactivate action. The list is fetched
   *  live from the Worker (1.7.0+) and includes every device the
   *  customer has activated. While the fetch is in flight, render
   *  pulsing skeleton rows. On network failure or pre-1.7.0 Worker,
   *  fall back to showing just the current device.
   *
   *  Reset license state + Copy diagnostic info live below the
   *  device list as plain rows. */
  export function renderDevicesSection(this: ButterSettingTab, root: HTMLElement) {
    const section = this.createSettingGroup(root, tx("Devices"));
    const phase = this.computeLicensePhase();
    const hasActiveLicense =
      phase === "trial" || phase === "valid" || phase === "offline";

    const list = section.createDiv({ cls: "butter-license-device-list" });
    if (hasActiveLicense) {
      this.renderDeviceListSkeleton(list);
      void this.fetchAndRenderDevices(list);
    } else {
      list.createDiv({
        cls: "butter-license-devices-hint",
        text: tx("No active license on this device."),
      });
    }

    this.renderDeviceUtilities(section);
  }

/** Pulse-skeleton rows for the in-flight device fetch. Two rows
   *  to roughly match a typical 2-device customer's resolved list. */
  export function renderDeviceListSkeleton(this: ButterSettingTab, parent: HTMLElement) {
    for (let i = 0; i < 2; i++) {
      const row = parent.createDiv({ cls: "butter-license-skeleton-row" });
      const info = row.createDiv({ cls: "butter-license-skeleton-info" });
      info.createDiv({ cls: "butter-license-skeleton is-row-name" });
      info.createDiv({ cls: "butter-license-skeleton is-row-desc" });
      row.createDiv({ cls: "butter-license-skeleton is-row-control" });
    }
  }

/** Single device row. The current device's row uses the
   *  confirm-modal sign-out path (clears local session immediately
   *  + revokes server-side); sibling devices revoke server-side
   *  only - their next /session call will return device_deactivated. */
  export function renderDeviceRow(this: ButterSettingTab, parent: HTMLElement, device: DeviceWireRecord) {
    const activated = this.formatActivationDate(device.activatedAt);
    const lastSeen = device.lastSeenAt && device.lastSeenAt !== device.activatedAt
      ? tv(" - last seen {time}", { time: this.formatRelativeTime(device.lastSeenAt) })
      : "";
    const setting = new Setting(parent)
      .setName(tx(device.isCurrent ? "This device" : "Another device"))
      .setDesc(tv("Activated {date}{extra}", { date: activated, extra: lastSeen }));
      setting.addButton((b) => {
        b.setButtonText(tx("Deactivate"));
        (b as unknown as { setWarning: () => typeof b }).setWarning();
        b.onClick(() => {
        if (device.isCurrent) {
          new DeactivateConfirmModal(this.app, async () => {
            await this.deactivateCurrentDevice();
          }).open();
        } else {
          void this.deactivateSiblingDevice(device.deviceId);
        }
      });
    });
  }

/** Local-only fallback row for the current device - used when the
   *  /devices fetch fails (network, pre-1.7.0 Worker) or the Worker
   *  returns an empty list (legacy customer). */
  export function renderCurrentDeviceFallback(this: ButterSettingTab, parent: HTMLElement, hintText: string) {
    const activatedAt = this.plugin.settings.activatedAt
      || this.plugin.settings.lastValidatedAt
      || 0;
    const desc = activatedAt
      ? tv("Activated {date}", { date: this.formatActivationDate(activatedAt) })
      : tx("this install");
    new Setting(parent)
      .setName(tx("This device"))
      .setDesc(desc)
      .addButton((b) => {
        b.setButtonText(tx("Deactivate"));
        (b as unknown as { setWarning: () => typeof b }).setWarning();
        b.onClick(() => {
          new DeactivateConfirmModal(this.app, async () => {
            await this.deactivateCurrentDevice();
          }).open();
        });
      });
    parent.createDiv({
      cls: "butter-license-devices-hint",
      text: hintText,
    });
  }

/** Copy-diagnostic row parked at the bottom of the Devices
   *  section. Real customer feature - gives them a one-block payload
   *  to paste into support tickets. (Reset license state used to
   *  live here too; it's now in the Dev section since normal users
   *  shouldn't need it - Deactivate covers the sign-out path.) */
  export function renderDeviceUtilities(this: ButterSettingTab, section: HTMLElement) {
    new Setting(section)
      .setName(tx("Copy diagnostic info"))
      .setDesc(tx("Device ID, key prefix, plugin version, and server URL for support tickets."))
      .addButton((b) =>
        b.setButtonText(tx("Copy")).onClick(async () => {
          const devId = this.plugin.settings.deviceId || "-";
          const keyPrefix = (this.plugin.settings.licenseKey || "").slice(0, 12) || "-";
          const ver = this.plugin.manifest.version;
          const status = this.plugin.licenseStatus;
          const payload = [
            `Butter Editor diagnostic`,
            `version: ${ver}`,
            `device: ${devId}`,
            `key prefix: ${keyPrefix}`,
            `status: ${status}`,
            `worker: https://api.buttereditor.com`,
          ].join("\n");
          try {
            await navigator.clipboard.writeText(payload);
            new Notice(tx("Diagnostic info copied."), 2000);
          } catch {
            new Notice(tx("Couldn't copy - clipboard access was blocked."), 4000);
          }
        }),
      );
  }

// ── Section 3: Support ──────────────────────────────────────

  export function renderSupportSection(this: ButterSettingTab, root: HTMLElement) {
    const section = this.createSettingGroup(root, tx("Support"), undefined);

    new Setting(section)
      .setName(tx("Documentation"))
      .setDesc(tx("Read the docs and FAQ."))
      .addButton((b) =>
        b.setButtonText(tx("Open")).onClick(() => { window.open(LINKS.docs, "_blank"); }),
      );

    new Setting(section)
      .setName(tx("Report an issue"))
      .setDesc(tx("GitHub issue tracker."))
      .addButton((b) =>
        b.setButtonText(tx("Open")).onClick(() => { window.open(LINKS.issues, "_blank"); }),
      );

    new Setting(section)
      .setName(tx("Community thread"))
      .setDesc(tx("Obsidian forum thread."))
      .addButton((b) =>
        b.setButtonText(tx("Open")).onClick(() => { window.open(LINKS.forum, "_blank"); }),
      );

    new Setting(section)
      .setName(tx("Email support"))
      .setDesc(LINKS.supportEmail)
      .addButton((b) =>
        b.setButtonText(tx("Email")).onClick(() => {
          window.open(`mailto:${LINKS.supportEmail}`, "_blank");
        }),
      );

    new Setting(section)
      .setName(tx("Privacy policy"))
      .addButton((b) =>
        b.setButtonText(tx("Open")).onClick(() => { window.open(LINKS.privacy, "_blank"); }),
      );

    new Setting(section)
      .setName(tx("Terms of service"))
      .addButton((b) =>
        b.setButtonText(tx("Open")).onClick(() => { window.open(LINKS.terms, "_blank"); }),
      );

    new Setting(section)
      .setName(tx("Refund policy"))
      .addButton((b) =>
        b.setButtonText(tx("Open")).onClick(() => { window.open(LINKS.refunds, "_blank"); }),
      );

    new Setting(section)
      .setName(tx("Plugin version"))
      .setDesc(`v${this.plugin.manifest.version}`);
  }

// Section 4: Diagnostics

  /** Diagnostic helpers for license-state troubleshooting. Force-state
   *  buttons write coherent local settings shapes; refresh exercises
   *  the real session endpoint. Reset clears license state and
   *  regenerates deviceId. */


  /** Returns the trial's progress in days/hours plus a derived
   *  daysUsed counter for the 7-segment strip. All zero-valued when
   *  expiry is unknown. `expired` is true once msLeft <= 0. */
  export function computeRemaining(this: ButterSettingTab): {
    daysLeft: number;
    hoursLeft: number;
    daysUsed: number;
    expired: boolean;
  } {
    const exp = this.plugin.settings.licenseExpiresAt
      || this.plugin.settings.sessionExpiresAt
      || 0;
    if (!exp) {
      return { daysLeft: TRIAL_LENGTH_DAYS, hoursLeft: TRIAL_LENGTH_DAYS * 24, daysUsed: 0, expired: false };
    }
    const now = Date.now();
    const msLeft = exp - now;
    if (msLeft <= 0) {
      return { daysLeft: 0, hoursLeft: 0, daysUsed: TRIAL_LENGTH_DAYS, expired: true };
    }
    const hoursLeft = Math.max(1, Math.ceil(msLeft / (60 * 60 * 1000)));
    if (msLeft < 24 * 60 * 60 * 1000) {
      return { daysLeft: 0, hoursLeft, daysUsed: TRIAL_LENGTH_DAYS - 1, expired: false };
    }
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
    const daysUsed = Math.max(0, Math.min(TRIAL_LENGTH_DAYS, TRIAL_LENGTH_DAYS - daysLeft));
    return { daysLeft, hoursLeft, daysUsed, expired: false };
  }

/** Schedule the next `/trial/poll` tick. Cadence ramps with elapsed
   *  time so we hit the server tightly during the typical ~3-5s
   *  fulfillment window then back off. Captures `pollGeneration` so
   *  a render-induced cancel is honored even if the timer already
   *  fired before clearTimeout ran. */
  export function scheduleTrialPoll(this: ButterSettingTab) {
    if (this.trialPollTimer != null) return; // already armed
    const pending = this.plugin.settings.pendingTrialActivation;
    if (!pending?.pollToken) return;
    const ageMs = Date.now() - (pending.startedAt || 0);
    const delay = ageMs < 25_000 ? 1_500 : ageMs < 5 * 60_000 ? 5_000 : 30_000;
    const myGen = this.pollGeneration;
    this.trialPollTimer = window.setTimeout(() => {
      this.trialPollTimer = null;
      if (myGen !== this.pollGeneration) return;
      void this.runTrialPollOnce();
    }, delay);
  }

/** Maps the LicenseClientError kind to a customer-facing string.
   *  Settings UI uses this for inline errors + toasts. */
  export function friendlyError(this: ButterSettingTab, err: LicenseClientError): string {
    switch (err.kind) {
      case "license_invalid":
        return tx("That license key is not valid (revoked, expired, or unrecognized).");
      case "device_deactivated":
        return tx("This device was removed from this license. Paste the key again to add it back.");
      case "device_cap":
        return tv("This license is active on {count} devices already. Deactivate one at licenses.buttereditor.com to free a slot.", { count: MAX_DEVICES_PER_CUSTOMER });
      case "unauthorized":
        return tx("Session expired. Re-enter the license key to continue.");
      case "trial_used":
        return tx("A trial has already been activated for this email or device.");
      case "rate_limited":
        return tx("Too many attempts in a short window. Wait a minute and try again.");
      case "network":
        return tx("Couldn't reach the licensing server. Check your internet connection.");
      case "polar_error":
        return tx("The licensing service is temporarily unavailable. Try again in a minute.");
      case "invalid_input":
        return tx("Input was rejected by the server. Double-check email + key formatting.");
      default:
        return tx("Something went wrong. Try again in a moment.");
    }
  }
