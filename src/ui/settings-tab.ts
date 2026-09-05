/**
 * Butter's plugin-settings tab.
 *
 * Extracted from main.ts for readability - the tab is self-contained:
 * it reads + writes `plugin.settings`, triggers saves via
 * `plugin.saveSettings()`, and nudges `plugin.applyOutlineMode()` when
 * the outline toggle flips. It doesn't touch the editor view directly.
 *
 * Butter's settings are organized as native Obsidian pages. Hosts without
 * the SettingPage API receive the same grouped page index and in-place page
 * navigation instead of a separate, horizontally scrolling tab design.
 */
import * as ObsidianApi from "obsidian";
import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  getIconIds,
  setIcon,
} from "obsidian";
import type { SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import type ButterEditorPlugin from "../main";
import { LicenseClientError } from "../integration/license/client";
import type { DeviceWireRecord } from "../integration/license/client";
import type { ToolbarLayoutItem } from "../main";
import { tx, txKnown, tv } from "../i18n";


import { renderLicense, computeLicensePhase, licensePhaseIcon, renderRowsFor, renderUnlicensedRows, renderPollingRows, renderTrialRows, renderLifetimeRows, renderDeactivatedRows, renderInvalidatedRows, reasonCopyFor, renderExpiredRows, renderUnknownRows, trialHeadlineFor, trialStatLineFor, formatActivationDate, formatRelativeTime, renderKeyRow, renderPasteKeyRow, renderRecoveryRow, renderDevicesSection, renderDeviceListSkeleton, renderDeviceRow, renderCurrentDeviceFallback, renderDeviceUtilities, computeRemaining, scheduleTrialPoll, friendlyError } from "./settings/license-tab";
import { renderSupportSection } from "./settings/support-tab";
import { renderGeneral, renderGeneralIntroSections, renderEditor, renderDragAndDrop, renderAdvanced } from "./settings/general-tab";
import { MAX_DEVICES_PER_CUSTOMER, TRIAL_LENGTH_DAYS } from "../integration/license/policy";
import { renderToolbar, renderLayoutSection, renderPresetColorsSection, createSettingGroup, renderPrimaryToolbarSection, renderTableToolbarSection, renderLayoutEditor, openMoveToSubmenuMenu, openSubmenuEditModal, openCommandPicker, openCommandActionEditModal, wireDrag } from "./settings/toolbar-tab";
import { renderOutlineSection } from "./settings/outline-tab";
import { renderDragSection } from "./settings/drag-tab";
import { renderSourceSection, showWarning } from "./settings/source-tab";
import { renderDebugSection } from "./settings/debug-tab";
import { renderContextMenu } from "./settings/context-menu-tab";
import { CONTEXT_MENU_CUSTOMIZER_FEATURE_ID } from "./feature-discovery";
import {
  commandActionIcon,
  commandActionLabel,
  listObsidianCommands,
  type CommandLayoutItem,
  type ObsidianCommandDescriptor,
} from "./command-actions";

type ButterSettingsSection =
  | "general"
  | "editor"
  | "drag-drop"
  | "toolbar"
  | "context-menu"
  | "advanced"
  | "license"
  | "support";

interface ButterSettingPageCompat {
  title: string;
  containerEl: HTMLElement;
  display(): void;
  hide(): void;
}

const BUTTER_SETTINGS_PAGES: ReadonlyArray<{
  id: ButterSettingsSection;
  label: "General" | "Editor" | "Drag and drop" | "Toolbar" | "Advanced" | "License" | "Context menu" | "Help & feedback";
  icon: string;
}> = [
  { id: "general", label: "General", icon: "settings-2" },
  { id: "editor", label: "Editor", icon: "pen-line" },
  { id: "drag-drop", label: "Drag and drop", icon: "move" },
  { id: "toolbar", label: "Toolbar", icon: "panel-bottom" },
  { id: "context-menu", label: "Context menu", icon: "menu" },
  { id: "advanced", label: "Advanced", icon: "code" },
  { id: "license", label: "License", icon: "key-round" },
  { id: "support", label: "Help & feedback", icon: "messages-square" },
];

interface NavigationLicenseStatus {
  phase: Exclude<ReturnType<ButterSettingTab["computeLicensePhase"]>, "valid">;
  name: string;
  description: string;
  icon: string;
  tone: "accent" | "warning" | "danger" | "muted";
  startTrial?: boolean;
}

function createButterSettingsPage(
  tab: ButterSettingTab,
  section: ButterSettingsSection,
  title: string,
): ButterSettingPageCompat {
  const SettingPageBase = (
    ObsidianApi as unknown as { SettingPage?: new () => ButterSettingPageCompat }
  ).SettingPage;
  if (typeof SettingPageBase !== "function") {
    throw new Error("Obsidian SettingPage is unavailable");
  }

  class ButterSectionPage extends SettingPageBase {
    display(): void {
      tab.renderDeclarativePage(this, section);
    }

    hide(): void {
      tab.releaseDeclarativePage(this);
      super.hide();
    }
  }

  const page = new ButterSectionPage();
  page.title = title;
  return page;
}

export class ButterSettingTab extends PluginSettingTab {
  /** Active tab key - persists across re-opens of the settings pane.
   *  Order is the user-facing order in the tab bar. */
  activeTab: ButterSettingsSection = "general";
  private activeDeclarativePage: ButterSettingPageCompat | null = null;
  private pendingNavigationPage: ButterSettingsSection | null = null;
  private fallbackPage: ButterSettingsSection | null = null;

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

  private settingPageIconObserver: MutationObserver | null = null;
  public pendingFocusSection: string | null = null;

  constructor(app: App, public plugin: ButterEditorPlugin) {
    super(app, plugin);
  }

  private cleanupSettingsUi(): void {
    if (this.trialPollTimer != null) {
      window.clearTimeout(this.trialPollTimer);
      this.trialPollTimer = null;
    }
  }

  /** Release lifetime-owned settings resources when the plugin unloads.
   * The page-icon observer intentionally survives ordinary hide/show cycles:
   * Obsidian can reopen cached declarative definitions without calling
   * getSettingDefinitions(), then rebuild the rows in the detached container. */
  public dispose(): void {
    this.cleanupSettingsUi();
    this.settingPageIconObserver?.disconnect();
    this.settingPageIconObserver = null;
  }

  /** Obsidian's declarative page rows do not currently expose an icon field.
   * Decorate only Butter's native navigation rows after Obsidian creates
   * them, leaving navigation, focus, and page ownership entirely native. */
  private syncSettingPageIcons(): void {
    const decorate = () => {
      const rows = Array.from(
        this.containerEl.querySelectorAll<HTMLElement>(".setting-item.mod-navigable"),
      );
      for (const row of rows) {
        const nameEl = row.querySelector<HTMLElement>(
          ":scope > .setting-item-info > .setting-item-name",
        );
        if (!nameEl) continue;
        const storedPageId = row.dataset.butterSettingsPage as
          | ButterSettingsSection
          | undefined;
        const undecoratedName = nameEl.cloneNode(true) as HTMLElement;
        undecoratedName.querySelectorAll(
          ".butter-settings-page-icon, .butter-settings-page-new-badge",
        ).forEach((element) => element.remove());
        const definition = storedPageId
          ? BUTTER_SETTINGS_PAGES.find(({ id }) => id === storedPageId)
          : BUTTER_SETTINGS_PAGES.find(({ label }) =>
              undecoratedName.textContent?.trim() ===
                (label === "Context menu" ? txKnown(label) : tx(label))
            );
        if (!definition) continue;
        row.dataset.butterSettingsPage = definition.id;
        row.addClass("butter-settings-page-link");
        if (!nameEl.querySelector(":scope > .butter-settings-page-icon")) {
          const iconEl = nameEl.createSpan({ cls: "butter-settings-page-icon" });
          iconEl.setAttribute("aria-hidden", "true");
          setIcon(iconEl, definition.icon);
          nameEl.prepend(iconEl);
        }
        const existingBadge = nameEl.querySelector<HTMLElement>(
          ":scope > .butter-settings-page-new-badge",
        );
        const showBadge = definition.id === "context-menu" &&
          !this.plugin.hasVisitedFeatureDiscovery(
            CONTEXT_MENU_CUSTOMIZER_FEATURE_ID,
          );
        if (showBadge && !existingBadge) {
          nameEl.createSpan({
            cls: "butter-settings-page-new-badge",
            text: txKnown("New"),
            attr: { "aria-label": txKnown("New feature") },
          });
        } else if (!showBadge) {
          existingBadge?.remove();
        }
        if (definition.id === "context-menu" &&
            row.dataset.butterDiscoveryVisitWired !== "true") {
          row.dataset.butterDiscoveryVisitWired = "true";
          row.addEventListener("click", () => {
            this.completeContextMenuDiscovery();
          });
        }
      }
      this.openPendingNavigationPage();
    };

    this.settingPageIconObserver?.disconnect();
    decorate();
    this.settingPageIconObserver = new MutationObserver(decorate);
    this.settingPageIconObserver.observe(this.containerEl, {
      childList: true,
      subtree: true,
    });
  }

  public requestPage(section: ButterSettingsSection): void {
    const alreadyActive = this.activeDeclarativePage !== null &&
      this.activeTab === section;
    this.activeTab = section;
    this.pendingNavigationPage = alreadyActive ? null : section;
    if (!alreadyActive) {
      window.setTimeout(() => this.openPendingNavigationPage(), 0);
    }
  }

  private openPendingNavigationPage(): void {
    const section = this.pendingNavigationPage;
    if (!section) return;
    const row = this.containerEl.querySelector<HTMLElement>(
      `.setting-item.mod-navigable[data-butter-settings-page="${section}"]`,
    );
    if (!row) return;
    this.pendingNavigationPage = null;
    row.click();
  }

  private completeContextMenuDiscovery(): void {
    this.containerEl.querySelectorAll(
      ".butter-settings-page-new-badge",
    ).forEach((badge) => badge.remove());
    void this.plugin.completeFeatureDiscoveryVisit(
      CONTEXT_MENU_CUSTOMIZER_FEATURE_ID,
      Platform.isMobile ? "mobile-context-menu" : "desktop-context-menu",
    );
  }

  hide(): void {
    this.cleanupSettingsUi();
    this.fallbackPage = null;
  }

  /** Obsidian 1.13+ entry point. Each Butter area is a native settings page;
   * dynamic page contents use the API's supported SettingPage escape hatch. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    // Install the observer before Obsidian creates the declarative rows. A
    // delayed timer can lose a race with first-open indexing/hide cleanup and
    // also allows an iconless frame to paint. MutationObserver decoration runs
    // in the same rendering turn once the native rows are inserted.
    this.syncSettingPageIcons();
    const pages = BUTTER_SETTINGS_PAGES.map(({ id, label }) => ({
      type: "page" as const,
      name: label === "Context menu" ? txKnown(label) : tx(label),
      page: (() => createButterSettingsPage(
          this,
          id,
          label === "Context menu" ? txKnown(label) : tx(label),
        )) as NonNullable<SettingDefinitionPage["page"]>,
    }));
    return [
      {
        type: "group" as const,
        cls: "butter-settings-license-status-container",
        visible: () => this.navigationLicenseStatus() !== null,
        items: [{
          name: tx("License"),
          searchable: false,
          render: (setting: Setting) => this.renderNavigationLicenseStatus(setting),
        }],
      },
      {
        type: "group" as const,
        cls: "butter-settings-whats-new-container",
        visible: () => this.plugin.shouldShowWhatsNewSettingsCard(),
        items: [{
          name: txKnown("What's new"),
          searchable: false,
          render: (setting: Setting) => this.renderWhatsNewCard(setting),
        }],
      },
      {
        type: "group" as const,
        cls: "butter-settings-primary-pages",
        items: pages.filter((_, index) => BUTTER_SETTINGS_PAGES[index]?.id !== "support"),
      },
      {
        type: "group" as const,
        cls: "butter-settings-help-pages",
        items: pages.filter((_, index) => BUTTER_SETTINGS_PAGES[index]?.id === "support"),
      },
    ];
  }

  private renderWhatsNewCard(setting: Setting): void {
    if (!this.plugin.shouldShowWhatsNewSettingsCard()) {
      setting.settingEl.remove();
      return;
    }
    const version = this.plugin.settings.whatsNewReleaseVersion;
    setting.settingEl.addClass("butter-settings-whats-new-card");
    setting.nameEl.empty();
    const icon = setting.nameEl.createSpan({ cls: "butter-settings-whats-new-card__icon" });
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, "party-popper");
    setting.nameEl.createSpan({ text: txKnown("What's new") });
    setting.setDesc(tv("See the highlights in Butter Editor {version}.", { version }));
    setting.addButton((button) => button
      .setButtonText(txKnown("View what's new"))
      .onClick(() => this.plugin.openWhatsNewFromSettings(version)));
    setting.addExtraButton((button) => button
      .setIcon("x")
      .setTooltip(txKnown("Dismiss this release"))
      .onClick(() => void this.plugin.dismissWhatsNewSettingsCard()));
  }

  private navigationLicenseStatus(): NavigationLicenseStatus | null {
    const phase = this.computeLicensePhase();
    if (phase === "valid") return null;

    if (phase === "unlicensed") {
      const days = this.plugin.settings.trialLengthDays || TRIAL_LENGTH_DAYS;
      return {
        phase,
        name: tx("Free trial available"),
        description: tv("{days} days, full access. No card, no email.", { days }),
        icon: licensePhaseIcon(phase),
        tone: "accent",
        startTrial: true,
      };
    }
    if (phase === "polling") {
      return {
        phase,
        name: tx("Activating trial..."),
        description: tx("Checking license..."),
        icon: licensePhaseIcon(phase),
        tone: "muted",
      };
    }
    if (phase === "trial") {
      const remaining = this.computeRemaining();
      return {
        phase,
        name: tx("Trial active"),
        description: this.trialStatLineFor(remaining),
        icon: licensePhaseIcon(phase),
        tone: "accent",
      };
    }
    if (phase === "expired") {
      return {
        phase,
        name: tx("Trial expired"),
        description: tx("License required - read-only mode"),
        icon: licensePhaseIcon(phase),
        tone: "danger",
      };
    }
    if (phase === "deactivated") {
      return {
        phase,
        name: tx("Device deactivated"),
        description: tx("This device was deactivated from another machine."),
        icon: licensePhaseIcon(phase),
        tone: "warning",
      };
    }
    if (phase === "offline") {
      return {
        phase,
        name: tx("License could not be verified"),
        description: tx("Read-only until the licensing server can be reached."),
        icon: licensePhaseIcon(phase),
        tone: "warning",
      };
    }
    if (phase === "invalidated") {
      return {
        phase,
        name: tx("License could not be verified"),
        description: this.reasonCopyFor(this.plugin.settings.lastReason),
        icon: licensePhaseIcon(phase),
        tone: "danger",
      };
    }
    return {
      phase,
      name: tx("License could not be verified"),
      description: tx("Try again, or contact support if this persists."),
      icon: licensePhaseIcon(phase),
      tone: "warning",
    };
  }

  private renderNavigationLicenseStatus(setting: Setting): void {
    const status = this.navigationLicenseStatus();
    if (!status) {
      setting.settingEl.remove();
      return;
    }

    setting.settingEl.addClasses([
      "butter-settings-license-status",
      `is-${status.tone}`,
    ]);
    setting.settingEl.setAttrs({
      role: "button",
      tabindex: "0",
      "aria-label": `${status.name}. ${status.description}`,
    });
    setting.nameEl.empty();
    const icon = setting.nameEl.createSpan({ cls: "butter-settings-license-status__icon" });
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, status.icon);
    setting.nameEl.createSpan({ text: status.name });
    setting.setDesc(status.description);

    setting.addButton((button) => {
      button.setButtonText(
        status.startTrial ? tx("Start trial") : tx("Go to license settings"),
      );
      if (status.startTrial) button.setCta();
      button.buttonEl.addEventListener("click", (event) => event.stopPropagation());
      button.onClick(() => {
        this.openNavigationPage("license");
        if (status.startTrial) {
          window.setTimeout(() => void this.beginTrialActivation(), 0);
        }
      });
    });

    const open = () => this.openNavigationPage("license");
    setting.settingEl.addEventListener("click", (event) => {
      if ((event.target as Element | null)?.closest("button")) return;
      open();
    });
    setting.settingEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  }

  private openNavigationPage(section: ButterSettingsSection): void {
    const definition = BUTTER_SETTINGS_PAGES.find(({ id }) => id === section);
    if (definition) {
      const label = definition.label === "Context menu"
        ? txKnown(definition.label)
        : tx(definition.label);
      const row = Array.from(
        this.containerEl.querySelectorAll<HTMLElement>(".setting-item.mod-navigable"),
      ).find((candidate) => {
        const name = candidate.querySelector<HTMLElement>(
          ":scope > .setting-item-info > .setting-item-name",
        );
        return name?.textContent?.trim() === label;
      });
      if (row) {
        row.click();
        return;
      }
    }
    this.activeTab = section;
    this.fallbackPage = section;
    this.refreshSettingsUi();
  }

  /** Re-render through the API that owns the current Obsidian version. */
  public refreshSettingsUi(): void {
    if (this.activeDeclarativePage) {
      this.activeDeclarativePage.display();
      return;
    }
    const update = (this as unknown as { update?: () => void }).update;
    if (typeof update === "function") {
      update.call(this);
      return;
    }
    this.cleanupSettingsUi();
    this.renderSettingsInto(this.containerEl);
  }

  /** Imperative page-navigation fallback for Obsidian versions before 1.13. */
  display(): void {
    this.renderSettingsInto(this.containerEl);
  }

  public renderDeclarativePage(
    page: ButterSettingPageCompat,
    section: ButterSettingsSection,
  ): void {
    this.cleanupSettingsUi();
    this.activeDeclarativePage = page;
    this.activeTab = section;
    page.containerEl.empty();
    page.containerEl.addClass("butter-settings-page");
    this.renderSettingsSection(page.containerEl, section);
    this.focusPendingSection(page.containerEl);
  }

  public releaseDeclarativePage(page: ButterSettingPageCompat): void {
    if (this.activeDeclarativePage === page) this.activeDeclarativePage = null;
    this.cleanupSettingsUi();
    window.requestAnimationFrame(() => this.syncSettingPageIcons());
  }

  private renderSettingsSection(
    body: HTMLElement,
    section: ButterSettingsSection,
  ): void {
    switch (section) {
      case "general": this.renderGeneral(body); break;
      case "editor": this.renderEditor(body); break;
      case "drag-drop": this.renderDragAndDrop(body); break;
      case "toolbar": this.renderToolbar(body); break;
      case "context-menu": this.renderContextMenu(body); break;
      case "advanced": this.renderAdvanced(body); break;
      case "license": this.renderLicense(body); break;
      case "support": this.renderSupportSection(body); break;
    }
  }

  private focusPendingSection(body: HTMLElement): void {
    const pendingFocusSection = this.pendingFocusSection;
    if (!pendingFocusSection) return;
    this.pendingFocusSection = null;
    window.requestAnimationFrame(() => {
      body.querySelector<HTMLElement>(
        `[data-butter-settings-section="${pendingFocusSection}"]`,
      )?.scrollIntoView({ block: "start" });
    });
  }

  private renderSettingsInto(containerEl: HTMLElement): void {
    containerEl.empty();
    containerEl.addClass("butter-settings-root");
    containerEl.removeClasses([
      "butter-settings-fallback-index",
      "butter-settings-fallback-page",
    ]);
    const pending = this.pendingNavigationPage;
    if (pending) {
      this.pendingNavigationPage = null;
      this.fallbackPage = pending;
      this.activeTab = pending;
    }
    if (this.fallbackPage) {
      this.renderFallbackPage(containerEl, this.fallbackPage);
    } else {
      this.renderFallbackPageIndex(containerEl);
    }
  }

  private fallbackPageLabel(section: ButterSettingsSection): string {
    const definition = BUTTER_SETTINGS_PAGES.find(({ id }) => id === section);
    if (!definition) return "";
    return definition.label === "Context menu"
      ? txKnown(definition.label)
      : tx(definition.label);
  }

  private createFallbackNavigationGroup(
    parent: HTMLElement,
    className: string,
  ): HTMLElement {
    const group = parent.createDiv({
      cls: `setting-group ${className} butter-settings-fallback-group`,
    });
    return group.createDiv({ cls: "setting-items" });
  }

  private renderFallbackPageIndex(containerEl: HTMLElement): void {
    containerEl.addClass("butter-settings-fallback-index");
    if (this.navigationLicenseStatus()) {
      const items = this.createFallbackNavigationGroup(
        containerEl,
        "butter-settings-license-status-container",
      );
      this.renderNavigationLicenseStatus(new Setting(items));
    }
    if (this.plugin.shouldShowWhatsNewSettingsCard()) {
      const items = this.createFallbackNavigationGroup(
        containerEl,
        "butter-settings-whats-new-container",
      );
      this.renderWhatsNewCard(new Setting(items));
    }

    const primary = this.createFallbackNavigationGroup(
      containerEl,
      "butter-settings-primary-pages",
    );
    const help = this.createFallbackNavigationGroup(
      containerEl,
      "butter-settings-help-pages",
    );
    for (const definition of BUTTER_SETTINGS_PAGES) {
      this.renderFallbackPageLink(
        definition.id === "support" ? help : primary,
        definition,
      );
    }
  }

  private renderFallbackPageLink(
    parent: HTMLElement,
    definition: (typeof BUTTER_SETTINGS_PAGES)[number],
  ): void {
    const label = this.fallbackPageLabel(definition.id);
    const setting = new Setting(parent).setName(label);
    const row = setting.settingEl;
    row.addClasses(["mod-navigable", "butter-settings-page-link"]);
    row.dataset.butterSettingsPage = definition.id;
    row.setAttrs({ role: "button", tabindex: "0", "aria-label": label });
    setting.nameEl.empty();
    const icon = setting.nameEl.createSpan({ cls: "butter-settings-page-icon" });
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, definition.icon);
    setting.nameEl.createSpan({ text: label });
    if (definition.id === "context-menu" &&
        !this.plugin.hasVisitedFeatureDiscovery(CONTEXT_MENU_CUSTOMIZER_FEATURE_ID)) {
      setting.nameEl.createSpan({
        cls: "butter-settings-page-new-badge",
        text: txKnown("New"),
        attr: { "aria-label": txKnown("New feature") },
      });
    }
    const chevron = setting.controlEl.createSpan({
      cls: "butter-settings-page-chevron",
    });
    chevron.setAttribute("aria-hidden", "true");
    setIcon(chevron, "chevron-right");
    const open = () => {
      this.activeTab = definition.id;
      this.fallbackPage = definition.id;
      if (definition.id === "context-menu") this.completeContextMenuDiscovery();
      this.renderSettingsInto(this.containerEl);
      this.containerEl.scrollTop = 0;
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  }

  private renderFallbackPage(
    containerEl: HTMLElement,
    section: ButterSettingsSection,
  ): void {
    containerEl.addClass("butter-settings-fallback-page");
    const label = this.fallbackPageLabel(section);
    const header = containerEl.createDiv({ cls: "butter-settings-fallback-header" });
    const back = header.createEl("button", {
      cls: "butter-settings-fallback-back clickable-icon",
      attr: { type: "button", "aria-label": tx("Back") },
    });
    setIcon(back, "chevron-left");
    const title = new Setting(header).setName(label).setHeading();
    title.settingEl.addClass("butter-settings-fallback-title");
    back.addEventListener("click", () => {
      this.fallbackPage = null;
      this.renderSettingsInto(this.containerEl);
      this.containerEl.scrollTop = 0;
    });
    const body = containerEl.createDiv({ cls: "butter-settings-page" });
    this.renderSettingsSection(body, section);
    this.focusPendingSection(body);
  }















































  /** Async fetch + render of the live device list. Replaces the
   *  skeleton in `listEl` with real rows on resolve, or a graceful
   *  fallback on network/auth failure. */
  public async fetchAndRenderDevices(listEl: HTMLElement) {
    const sessionToken = this.plugin.settings.sessionToken;
    if (!sessionToken) {
      listEl.empty();
      this.renderCurrentDeviceFallback(
        listEl,
        tx("Local session missing - re-paste your key to refresh the device list."),
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
          this.refreshSettingsUi();
          return;
        }
        if (err.kind === "unauthorized") {
          // Token expired client-side. Trigger refresh - that'll
          // either re-issue or mark unlicensed.
          await this.plugin.refreshLicenseStatus();
          this.refreshSettingsUi();
          return;
        }
      }
      // Network / polar / unknown - fall back to local-only view.
      this.renderCurrentDeviceFallback(
        listEl,
        tx("Couldn't reach the licensing server. Showing this device only."),
      );
      return;
    }

    listEl.empty();
    if (devices.length === 0) {
      // Worker has no record of this device yet (legacy customer or
      // pre-1.7.0 Worker). Fall back to local-only view.
      this.renderCurrentDeviceFallback(
        listEl,
        tx("Paste your license key on another machine to add it here."),
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
    const limit = this.plugin.settings.deviceLimit || MAX_DEVICES_PER_CUSTOMER;
    const summary = count === 1
      ? `1 of ${limit} devices · paste your key on another machine to add it here.`
      : `${count} of ${limit} devices on this license.`;
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
    this.plugin.settings.licenseType = "";
    this.plugin.settings.licenseStartedAt = 0;
    this.plugin.settings.licenseExpiresAt = 0;
    this.plugin.settings.trialLengthDays = TRIAL_LENGTH_DAYS;
    this.plugin.settings.deviceLimit = MAX_DEVICES_PER_CUSTOMER;
    this.plugin.settings.activatedAt = 0;
    this.plugin.settings.wasDeactivated = false;
    this.plugin.settings.wasInvalidated = false;
    this.plugin.settings.lastReason = "";
    this.plugin.settings.deviceId = (crypto).randomUUID();
    await this.plugin.saveSettings();
    await this.plugin.refreshLicenseStatus();
    this.refreshSettingsUi();
    new Notice(tx("This device deactivated."), 4000);
  }

  /** Sibling-device deactivation: revoke server-side, refresh the
   *  list. The other device keeps its cached session token until
   *  expiry (~7 days max); on its next /session refresh the Worker
   *  returns device_deactivated and that device's local state
   *  clears itself via main.ts's refreshLicenseStatus handler. */
  public async deactivateSiblingDevice(deviceId: string) {
    const sessionToken = this.plugin.settings.sessionToken;
    if (!sessionToken) {
      new Notice(tx("Session expired - re-paste your key to refresh."), 5000);
      return;
    }
    try {
      await this.plugin.licenseClient.deactivateDevice(sessionToken, deviceId);
      new Notice(tx("Device deactivated."), 4000);
    } catch (err) {
      const msg = err instanceof LicenseClientError
        ? this.friendlyError(err)
        : tx("Couldn't reach the licensing server.");
      new Notice(msg, 5000);
      return;
    }
    // Re-render Devices section to reflect the change.
    this.refreshSettingsUi();
  }









  // ── Inline trial activation (replaces TrialPollingModal) ────

  /** Tap-to-trial: hits `/trial/instant` and keeps the License section
   *  in its activating phase until the request resolves. Idempotent -
   *  a second tap while activation is in flight is a no-op. */
  public async beginTrialActivation(): Promise<void> {
    if (
      this.plugin.isActivatingTrialFlow
      || this.plugin.settings.pendingTrialActivation
    ) {
      return;
    }

    this.plugin.isActivatingTrialFlow = true;
    this.refreshSettingsUi();

    try {
      const resp = await this.plugin.licenseClient.startInstantTrial(
        this.plugin.settings.deviceId,
      );
      this.plugin.settings.licenseKey = resp.licenseKey;
      this.plugin.settings.licenseExpiresAt = Date.parse(resp.expiresAt);
      this.plugin.settings.everValidated = true;
      this.plugin.settings.activatedAt = Date.now();
      await this.plugin.saveSettings();
      await this.plugin.refreshLicenseStatus();
      new Notice(tv("Trial activated! You have {days} days of full access.", {
        days: this.plugin.settings.trialLengthDays || TRIAL_LENGTH_DAYS,
      }), 5000);
      import("canvas-confetti").then((module) => {
        const confetti = module.default || module;
        void confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
      }).catch(() => {});
    } catch (err) {
      console.error("[beginTrialActivation] Error starting trial:", err);
      if (err instanceof LicenseClientError && err.kind === "trial_used") {
        new Notice(
          tx("Your free trial has already been used on this device. Purchase a license to keep using Butter."),
          10_000,
        );
        this.plugin.settings.everValidated = true;
        this.plugin.settings.lastReason = "trial_used";
        await this.plugin.saveSettings();
      } else {
        const msg = err instanceof LicenseClientError
          ? this.friendlyError(err)
          : tx("Couldn't reach the licensing server.");
        new Notice(msg, 7000);
      }
    } finally {
      this.plugin.isActivatingTrialFlow = false;
    }
    this.refreshSettingsUi();
  }

  public openCheckoutAndPoll(): void {
    this.plugin.startLifetimeCheckoutFlow();
  }

  /** Single `/trial/poll` request. Updates settings on `ready`,
   *  re-renders accordingly. Re-arms via `display()` if still
   *  polling. */
  public async runTrialPollOnce(): Promise<void> {
    const pending = this.plugin.settings.pendingTrialActivation;
    if (!pending?.pollToken) {
      return;
    }
    const ageMs = Date.now() - (pending.startedAt || 0);
    if (ageMs > 30 * 60_000) {
      console.warn("[runTrialPollOnce] Trial activation timed out (30m).");
      this.plugin.settings.pendingTrialActivation = null;
      await this.plugin.saveSettings();
      new Notice(
        tx("Trial activation timed out. Open settings > license to try again."),
        10_000,
      );
      this.refreshSettingsUi();
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
        new Notice(tx("Trial activated!"), 4000);

        import("canvas-confetti").then((module) => {
          const confetti = module.default || module;
          void confetti({
            particleCount: 100,
            spread: 70,
            origin: { y: 0.6 }
          });
        }).catch(e => console.error("Confetti failed to load:", e));

        this.refreshSettingsUi();
        return;
      }
    } catch (err) {
      console.error(`[runTrialPollOnce] Error polling trial:`, err);
      if (err instanceof LicenseClientError && err.kind === "invalid_token") {
        // Token rotted - reset and let the user retry.
        this.plugin.settings.pendingTrialActivation = null;
        await this.plugin.saveSettings();
        this.refreshSettingsUi();
        return;
      }
      // Transient - fall through, schedule next tick.
    }
    // Pending. Re-render so the "Still working on it…" copy can
    // appear once we cross the 25s threshold, then re-schedule.
    this.refreshSettingsUi();
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
      let session = await this.plugin.licenseClient.validateAndIssueSession(
        licenseKey,
        this.plugin.settings.deviceId,
        "activate",
      );
      let validatedKey = licenseKey;
      if (session.upgrade) {
        validatedKey = session.upgrade.licenseKey;
        this.plugin.settings.customerId = session.upgrade.customerId;
        session = await this.plugin.licenseClient.validateAndIssueSession(
          validatedKey,
          this.plugin.settings.deviceId,
          "activate",
        );
      }
      if (session.upgrade) throw new Error("unexpected repeated license upgrade");
      this.plugin.applyLicenseSession(session, validatedKey);
      await this.plugin.saveSettings();
      await this.plugin.refreshLicenseStatus();
      this.refreshSettingsUi();
      new Notice(tx("License activated."), 4000);

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
        : tx("Couldn't reach the licensing server.");
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.removeClass("butter-hidden");
      } else {
        new Notice(msg, 7000);
      }
    }
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

  public renderEditor(root: HTMLElement) {
    return renderEditor.call(this, root);
  }

  public renderDragAndDrop(root: HTMLElement) {
    return renderDragAndDrop.call(this, root);
  }

  public renderAdvanced(root: HTMLElement) {
    return renderAdvanced.call(this, root);
  }

  public renderToolbar(root: HTMLElement) {
    return renderToolbar.call(this, root);
  }

  public renderContextMenu(root: HTMLElement): void {
    return renderContextMenu.call(this, root);
  }

  public renderLayoutSection(root: HTMLElement, getSegment: () => "desktop" | "mobile", reRenders: Array<() => void>): void {
    return renderLayoutSection.call(this, root, getSegment, reRenders);
  }

  public renderPresetColorsSection(root: HTMLElement): void {
    return renderPresetColorsSection.call(this, root);
  }

  public createSettingGroup(parent: HTMLElement, heading: string, description?: string, action?: {
      icon: string;
      tooltip: string;
      onClick: () => void | Promise<void>;
    }, tag?: { label: string; icon?: string; icons?: string[] }): HTMLElement {
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
    }>, tag?: { label: string; icon?: string }, options?: { allowCommands?: boolean }) {
    return renderLayoutEditor.call(this, root, title, desc, defs, getLayout, saveLayout, presets, tag, options);
  }

  public openMoveToSubmenuMenu(anchor: HTMLElement, submenus: Array<Extract<ToolbarLayoutItem, { type: "submenu" }>>, onPick: (submenuId: string) => void | Promise<void>) {
    return openMoveToSubmenuMenu.call(this, anchor, submenus, onPick);
  }

  public openSubmenuEditModal(item: Extract<ToolbarLayoutItem, { type: "submenu" }>, onSave: (
      updated: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    ) => void | Promise<void>, isNew = false) {
    return openSubmenuEditModal.call(this, item, onSave, isNew);
  }

  public openCommandPicker(
    onChoose: (command: { id: string; name: string; icon?: string }) => void,
  ): void {
    return openCommandPicker.call(this, onChoose);
  }

  public openCommandActionEditModal(
    item: Extract<ToolbarLayoutItem, { type: "command" }>,
    onSave: (updated: Extract<ToolbarLayoutItem, { type: "command" }>) => void | Promise<void>,
  ): void {
    return openCommandActionEditModal.call(this, item, onSave);
  }

  public wireDrag(handle: HTMLElement, row: HTMLElement, rootLayout: ToolbarLayoutItem[], draggedItemId: string, onCommit: () => void | Promise<void>, options?: {
    canDropInto?: (
      submenu: Extract<ToolbarLayoutItem, { type: "submenu" }>,
      dragged: ToolbarLayoutItem,
    ) => boolean;
  }) {
    return wireDrag.call(this, handle, row, rootLayout, draggedItemId, onCommit, options);
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
    titleEl.setText(tx("Enable source normalization?"));
    contentEl.createEl("p", {
      text:
        tx("You're turning on a setting that automatically changes file formatting on save. Files with different formatting will be adjusted the next time they're saved."),
    });
    contentEl.createEl("p", {
      text:
        tx("This is an advanced feature. Most users prefer the default so they can switch freely between Butter, live preview, and source mode without their files being reformatted."),
    });
    contentEl.createEl("p", {
      text:
        tx("Continue only if you understand you're opting into automatic source changes."),
    });
    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: tx("Cancel") });
    const okBtn = btnRow.createEl("button", {
      text: tx("I understand - enable"),
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
    titleEl.setText(tx(this.isNew ? "Add submenu" : "Edit submenu"));

    const previewWrap = contentEl.createDiv({
      cls: "butter-submenu-edit-preview",
    });
    const previewIcon = previewWrap.createDiv({
      cls: "butter-submenu-edit-preview-icon",
    });
    setIcon(previewIcon, this.current.icon || "more-horizontal");
    const previewLabel = previewWrap.createDiv({
      cls: "butter-submenu-edit-preview-label",
      text: this.current.label || tx("Submenu"),
    });

    new Setting(contentEl)
      .setName(tx("Label"))
      .setDesc(tx("Shown as the submenu's tooltip."))
      .addText((t) => {
        t.setValue(this.current.label).onChange((v) => {
          this.current.label = v;
          previewLabel.setText(v || tx("Submenu"));
        });
        t.inputEl.addClass("butter-submenu-label-input");
      });

    // Icon picker - search box on top, scrollable grid below.
    // Sourced from Obsidian's full icon registry via `getIconIds`,
    // so plugin-registered custom icons (including Butter's own
    // `butter-delete-row` etc.) show up alongside Lucide.
    const iconWrap = contentEl.createDiv({ cls: "butter-icon-picker" });
    iconWrap.createDiv({
      cls: "butter-icon-picker-label",
      text: tx("Icon"),
    });
    const search = iconWrap.createEl("input", {
      cls: "butter-icon-picker-search",
      attr: { type: "text", placeholder: tx("Search icons...") },
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
        grid.createDiv({
          cls: "butter-icon-picker-overflow",
          text: tv("Showing first {shown} of {total} matches - refine your search.", { shown: cap, total: matches.length }),
        });
      }
      if (matches.length === 0) {
        grid.createDiv({
          cls: "butter-icon-picker-empty",
          text: tx("No icons match."),
        });
      }
    };
    renderGrid("");
    search.addEventListener("input", () => renderGrid(search.value));

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: tx("Cancel") });
    const saveBtn = btnRow.createEl("button", {
      text: tx(this.isNew ? "Add" : "Save"),
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

export class CommandPickerModal extends FuzzySuggestModal<ObsidianCommandDescriptor> {
  private readonly commands: ObsidianCommandDescriptor[];

  constructor(
    app: App,
    private readonly onChoose: (command: ObsidianCommandDescriptor) => void,
  ) {
    super(app);
    this.commands = listObsidianCommands(app);
    this.setPlaceholder("Search command palette commands...");
  }

  getItems(): ObsidianCommandDescriptor[] {
    return this.commands;
  }

  getItemText(command: ObsidianCommandDescriptor): string {
    return command.name;
  }

  onChooseItem(command: ObsidianCommandDescriptor): void {
    this.onChoose(command);
  }
}

/** Edits the persistent presentation of one command action. The command ID is
 * intentionally read-only: replacing a command creates a new action, while
 * labels and Lucide icons remain freely customizable per placement. */
export class CommandActionEditModal extends Modal {
  private current: CommandLayoutItem;

  constructor(
    app: App,
    initial: CommandLayoutItem,
    private readonly onSave: (updated: CommandLayoutItem) => void | Promise<void>,
  ) {
    super(app);
    this.current = { ...initial };
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    if (Platform.isMobile) this.modalEl.addClass("mod-lg");
    titleEl.setText(txKnown("Edit command action"));

    const previewWrap = contentEl.createDiv({ cls: "butter-submenu-edit-preview" });
    const previewIcon = previewWrap.createDiv({ cls: "butter-submenu-edit-preview-icon" });
    setIcon(previewIcon, commandActionIcon(this.app, this.current));
    const previewLabel = previewWrap.createDiv({
      cls: "butter-submenu-edit-preview-label",
      text: commandActionLabel(this.app, this.current),
    });

    new Setting(contentEl)
      .setName(txKnown("Command"))
      .setDesc(this.current.commandId);

    new Setting(contentEl)
      .setName(tx("Label"))
      .setDesc(txKnown("Shown in menus and as the toolbar tooltip."))
      .addText((text) => {
        text.setValue(this.current.label).onChange((value) => {
          this.current.label = value;
          previewLabel.setText(commandActionLabel(this.app, this.current));
        });
      });

    const iconWrap = contentEl.createDiv({ cls: "butter-icon-picker" });
    iconWrap.createDiv({ cls: "butter-icon-picker-label", text: tx("Icon") });
    const search = iconWrap.createEl("input", {
      cls: "butter-icon-picker-search",
      attr: { type: "text", placeholder: "Search lucide icons..." },
    });
    const grid = iconWrap.createDiv({ cls: "butter-icon-picker-grid" });
    const iconIds = Array.from(new Set(getIconIds().map((id) => id.replace(/^lucide-/, ""))))
      .filter(Boolean)
      .sort();

    const renderIcons = (query: string) => {
      grid.empty();
      const normalizedQuery = query.trim().toLowerCase();
      const matches = iconIds
        .filter((id) => !normalizedQuery || id.toLowerCase().includes(normalizedQuery))
        .slice(0, 240);
      for (const id of matches) {
        const tile = grid.createEl("button", {
          cls: "butter-icon-picker-tile",
          attr: { type: "button", "aria-label": id },
        });
        if (id === this.current.icon) tile.classList.add("is-selected");
        setIcon(tile, id);
        tile.addEventListener("click", (event) => {
          event.preventDefault();
          this.current.icon = id;
          previewIcon.empty();
          setIcon(previewIcon, id);
          grid.querySelectorAll(".is-selected").forEach((element) => element.removeClass("is-selected"));
          tile.classList.add("is-selected");
        });
      }
      if (matches.length === 0) {
        grid.createDiv({ cls: "butter-icon-picker-empty", text: tx("No icons match.") });
      }
    };
    renderIcons("");
    search.addEventListener("input", () => renderIcons(search.value));

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: tx("Cancel") }).addEventListener("click", () => this.close());
    const save = buttons.createEl("button", { text: tx("Save"), cls: "mod-cta" });
    save.addEventListener("click", () => {
      if (!this.current.label) this.current.label = commandActionLabel(this.app, this.current);
      if (!this.current.icon) this.current.icon = commandActionIcon(this.app, this.current);
      void Promise.resolve(this.onSave(this.current)).then(() => this.close());
    });
  }

  onClose(): void {
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
    contentEl.createEl("h2", { text: tx("Deactivate this device?") });
    contentEl.createEl("p", {
      text:
        tx("Removes the cached license from this Obsidian install. Your license key stays valid - paste it back on this or any other device any time to re-add it."),
    });
    contentEl.createEl("p", {
      text:
        tx("Butter editor will switch to read-only mode here until you re-add the device."),
      cls: "setting-item-description",
    });

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = btnRow.createEl("button", { text: tx("Cancel") });
    const ok = btnRow.createEl("button", {
      text: tx("Deactivate"),
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
