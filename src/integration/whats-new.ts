import type { MessageKey } from "../i18n";

export const WHATS_NEW_CARD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface WhatsNewDemo {
  section: "new" | "improvement";
  title: MessageKey;
  description: MessageKey;
  asset: string;
  alt: MessageKey;
}

export interface WhatsNewRelease {
  version: string;
  headline: MessageKey;
  summary: MessageKey;
  demos: readonly WhatsNewDemo[];
  improvements: readonly MessageKey[];
  fixed: readonly MessageKey[];
}

export interface WhatsNewState {
  whatsNewInitialized: boolean;
  whatsNewAutoOpen: boolean;
  whatsNewReleaseVersion: string;
  whatsNewFirstSeenAt: number;
  whatsNewDismissedVersion: string;
  whatsNewAutoOpenedVersion: string;
}

export const WHATS_NEW_RELEASES: readonly WhatsNewRelease[] = [
  {
    version: "0.12.0",
    headline: "A more fluid Butter Editor",
    summary:
      "Butter Editor 0.12 makes everyday editing faster and more dependable. The new context menu includes spellcheck, headings and callouts fold naturally, images are easier to place, and settings are simpler to navigate.",
    demos: [
      {
        section: "new",
        title: "A context menu shaped around the way you work",
        description:
          "Right-click to reach the actions you use most. Format text, insert content, run Obsidian or plugin commands, and arrange the menu to fit your workflow.",
        asset: "butter-enhanced-context-menu.gif",
        alt: "Butter Editor's enhanced right-click menu opening over selected text and applying formatting from an organized submenu.",
      },
      {
        section: "new",
        title: "Spellcheck inside Butter's context menu",
        description:
          "Spelling suggestions now appear directly in Butter's context menu. Fix a word or add it to your dictionary without stepping out of the editor.",
        asset: "butter-spellcheck-context-menu.gif",
        alt: "A misspelled word being right-clicked in Butter Editor, corrected with an integrated spelling suggestion, and updated in place.",
      },
      {
        section: "new",
        title: "Fold entire heading sections",
        description:
          "Fold a heading to tuck away everything in its section. Expand it when you need the details again. The Markdown underneath stays unchanged.",
        asset: "butter-heading-folding.gif",
        alt: "A Butter Editor heading section collapsing and expanding in place.",
      },
      {
        section: "new",
        title: "Collapse native callouts",
        description:
          "Collapse a detailed callout to its title, then open it again when you need the full note. Its Markdown source stays intact.",
        asset: "butter-callout-folding.gif",
        alt: "A native Obsidian callout collapsing to its title and expanding again in Butter Editor.",
      },
      {
        section: "new",
        title: "Image resizing and placement",
        description:
          "Resize standalone images in place, or move a smaller image into a sentence. Clear placement feedback shows exactly where it will land.",
        asset: "butter-image-handling.gif",
        alt: "An inline image being resized and dragged onto its own block in Butter Editor.",
      },
      {
        section: "improvement",
        title: "Reorganized settings",
        description:
          "Find editor, drag and drop, toolbar, context menu, advanced, license, and support controls in focused sections.",
        asset: "butter-settings-overhaul.gif",
        alt: "Butter Editor's redesigned settings switching between focused Editor, Toolbar, and Context menu sections.",
      },
    ],
    improvements: [
      "Send bug reports and feature requests from Help & feedback in settings.",
      "Find and replace text safely, including regular expressions, without leaving your note.",
      "Keep your place when switching between Butter, Source, Live Preview, and Reading.",
      "Edit note links and web links through polished desktop popovers and mobile drawers.",
      "Tailor desktop and mobile toolbars with presets, submenus, and command palette actions.",
      "Write faster with smarter slash commands, list indentation, Properties suggestions, footnotes, and inline Markdown shortcuts.",
      "Move blocks with clearer reflow, better nesting intent, compact previews, and steadier drop placement.",
      "Under the hood, rendering is more efficient, saves are more reliable, and long editing sessions stay steadier.",
    ],
    fixed: [
      "Convert selected text to a bullet list without losing its content or selection.",
      "Use <br> tags for explicit line breaks in your notes.",
      "More stable list markers, task checkboxes, block selection, and nested drag geometry.",
      "More predictable keyboard dismissal, disclosure controls, and link editing on iOS.",
      "Safer date-only values in datetime Properties and broader Markdown source-preservation coverage.",
      "Cleaner spacing, icons, presets, responsive layouts, and settings discoverability.",
    ],
  },
];

export const LATEST_WHATS_NEW_RELEASE = WHATS_NEW_RELEASES[0];

declare const __BUTTER_DEV_WHATS_NEW_ASSETS__: Record<string, string>;

export function whatsNewRelease(version: string): WhatsNewRelease | null {
  return WHATS_NEW_RELEASES.find((release) => release.version === version) ?? null;
}

export function stableWhatsNewRelease(runtimeVersion: string): WhatsNewRelease | null {
  if (!/^\d+\.\d+\.\d+$/.test(runtimeVersion)) return null;
  return whatsNewRelease(runtimeVersion);
}

export function whatsNewAssetUrl(release: WhatsNewRelease, asset: string): string {
  const embedded = typeof __BUTTER_DEV_WHATS_NEW_ASSETS__ === "object"
    ? __BUTTER_DEV_WHATS_NEW_ASSETS__[asset]
    : undefined;
  if (embedded) return embedded;
  return `https://raw.githubusercontent.com/spreadwell/butter-editor/${release.version}/assets/whats-new/${release.version}/${asset}`;
}

export function initializeWhatsNewState(
  current: WhatsNewState,
  raw: Record<string, unknown>,
  runtimeVersion: string,
  now: number,
): { state: WhatsNewState; changed: boolean } {
  const stableRelease = stableWhatsNewRelease(runtimeVersion);
  const previewRelease = stableRelease ?? LATEST_WHATS_NEW_RELEASE;
  const hadExistingInstall = Object.keys(raw).length > 0 && raw.hasCompletedOnboarding === true;
  const state: WhatsNewState = {
    whatsNewInitialized: current.whatsNewInitialized === true,
    whatsNewAutoOpen: typeof current.whatsNewAutoOpen === "boolean"
      ? current.whatsNewAutoOpen
      : true,
    whatsNewReleaseVersion: typeof current.whatsNewReleaseVersion === "string"
      ? current.whatsNewReleaseVersion
      : "",
    whatsNewFirstSeenAt: Number.isFinite(current.whatsNewFirstSeenAt)
      ? Math.max(0, current.whatsNewFirstSeenAt)
      : 0,
    whatsNewDismissedVersion: typeof current.whatsNewDismissedVersion === "string"
      ? current.whatsNewDismissedVersion
      : "",
    whatsNewAutoOpenedVersion: typeof current.whatsNewAutoOpenedVersion === "string"
      ? current.whatsNewAutoOpenedVersion
      : "",
  };
  let changed =
    current.whatsNewInitialized !== state.whatsNewInitialized ||
    current.whatsNewAutoOpen !== state.whatsNewAutoOpen ||
    current.whatsNewReleaseVersion !== state.whatsNewReleaseVersion ||
    current.whatsNewFirstSeenAt !== state.whatsNewFirstSeenAt ||
    current.whatsNewDismissedVersion !== state.whatsNewDismissedVersion ||
    current.whatsNewAutoOpenedVersion !== state.whatsNewAutoOpenedVersion;

  if (raw.whatsNewInitialized !== true) {
    state.whatsNewInitialized = true;
    state.whatsNewReleaseVersion = previewRelease.version;
    if (hadExistingInstall) {
      state.whatsNewFirstSeenAt = now;
      state.whatsNewDismissedVersion = "";
      state.whatsNewAutoOpenedVersion = "";
    } else {
      // Onboarding already introduces the product on a fresh install.
      state.whatsNewFirstSeenAt = 0;
      state.whatsNewDismissedVersion = previewRelease.version;
      state.whatsNewAutoOpenedVersion = previewRelease.version;
    }
    changed = true;
  } else if (
    stableRelease &&
    state.whatsNewReleaseVersion !== stableRelease.version
  ) {
    state.whatsNewReleaseVersion = stableRelease.version;
    state.whatsNewFirstSeenAt = now;
    state.whatsNewDismissedVersion = "";
    state.whatsNewAutoOpenedVersion = "";
    changed = true;
  }

  return { state, changed };
}

export function shouldShowWhatsNewCard(
  state: WhatsNewState,
  now: number,
): boolean {
  const release = whatsNewRelease(state.whatsNewReleaseVersion);
  if (!release || state.whatsNewFirstSeenAt <= 0) return false;
  if (state.whatsNewDismissedVersion === release.version) return false;
  const age = now - state.whatsNewFirstSeenAt;
  return age >= 0 && age < WHATS_NEW_CARD_LIFETIME_MS;
}

export function shouldAutoOpenWhatsNew(
  state: WhatsNewState,
  runtimeVersion: string,
): boolean {
  const release = stableWhatsNewRelease(runtimeVersion);
  return Boolean(
    release &&
    state.whatsNewAutoOpen &&
    state.whatsNewReleaseVersion === release.version &&
    state.whatsNewAutoOpenedVersion !== release.version,
  );
}
