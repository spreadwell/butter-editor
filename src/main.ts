import {
  Plugin,
  MarkdownView,
  setIcon,
  addIcon,
  Menu,
  MenuItem,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

// Extensions MUST be registered before schema.ts or obsidian-md-bridge
// evaluate their module bodies - those are where the registry is
// read to build the live schema / token handlers / serializers.
// The internal Extension API exists, but no example extensions are
// activated in shipped builds. The dogfooded `:::spoiler` block +
// `@username` inline atom previously imported from
// `./integration/extensions-examples` are now developer reference
// only (see that file's header). To turn them back on for local
// dev / testing, re-add the side-effect import here ABOVE the
// schema/parser/serializer imports below.

import { parser } from "./core/parser";
import { serializer } from "./core/serializer";
import { normalize as normalizeSource } from "./core/normalize";
import { debug, setVerbose, recordError, getErrorLog, clearErrorLog } from "./integration/debug";


import {
  type LayoutItem as ToolbarLayoutItem,
  defaultMainLayout,
  backfillMissingButtons,
  defaultTableLayout,
  migrateFromHiddenList,
  migrateLegacyHeadingButton,
  mobileLayoutDefault,
  mobileTableLayoutDefault,
} from "./ui/toolbar-layout";
export type { ToolbarLayoutItem };
import { toggleMark } from "prosemirror-commands";
import type { MarkType } from "prosemirror-model";




import { openFind, openReplace } from "./editor/search-plugin";
import {
  installSaveStatus,
  type SaveStatusController,
} from "./ui/save-status";
import { SaveDiffModal } from "./ui/save-diff-modal";
import { ShortcutHelpModal } from "./ui/shortcut-help";


import { ButterOutlineView, VIEW_TYPE_BUTTER_OUTLINE } from "./ui/outline-view";
import { scrollHost } from "./util/dom-utils";
import { ButterSettingTab } from "./ui/settings-tab";
import { installWordCountBridge } from "./ui/wordcount-bridge";
import { WelcomeModal } from "./ui/welcome-modal";
import { LicenseClient, LicenseClientError, setPluginVersion } from "./integration/license/client";
import { LINKS } from "./integration/license/links";
import {
  BUTTER_HOVER_SOURCE,
} from "./editor/nodeviews";

export const VIEW_TYPE_BUTTER = "butter-editor";
export const VIEW_TYPE_BUTTER_LOCKED = "butter-locked-file";
import { ButterLockedFileView } from "./views/ButterLockedFileView";
import { ButterEditorView } from "./views/ButterEditorView";
import { ErrorLogModal } from "./ui/modals/ErrorLogModal";
import { CanonicalizeVaultModal } from "./ui/modals/CanonicalizeVaultModal";

// ═══════════════════════════════════════════
//  View-swap helpers - preserve caret across mode changes
// ═══════════════════════════════════════════

/**
 * Swap a Butter view's leaf to MarkdownView while preserving the
 * user's sense of place - which is dominated by the heading they
 * were currently reading under, not a precise caret position. We
 * capture the topmost above-the-fold heading's source-markdown line
 * and pass it as `eState.line`; MarkdownView's built-in handler
 * scrolls to that line.
 */
function swapButterToMarkdown(view: ButterEditorView) {
  if (!view.file) return;
  const line = view.visibleHeadingLine();
  void view.leaf.setViewState(
    {
      type: "markdown",
      state: { file: view.file.path, mode: "source" },
    },
    { line },
  );
}

/**
 * Mode identifier used by the cycle / view-as wiring. Maps to:
 *   source  → MarkdownView in Source mode (raw markdown text)
 *   live    → MarkdownView in Live Preview
 *   reading → MarkdownView in Reading view
 *   butter  → ButterEditorView (our PMX view type)
 */
export type ButterViewMode = "source" | "live" | "reading" | "butter";

/** Inspect a leaf and return which mode (if any) it's currently in. */
function getCurrentMode(leaf: WorkspaceLeaf): ButterViewMode | null {
  const view = leaf.view;
  if (view instanceof ButterEditorView) return "butter";
  if (view instanceof MarkdownView) {
    const mode = view.getMode();
    if (mode === "preview") return "reading";
    // editor mode - distinguish Source from Live Preview by the
    // `source` flag on view state.
    const state = view.getState() as { source?: boolean };
    return state.source ? "source" : "live";
  }
  return null;
}

/** Capture current visible heading line for scroll preservation. */
function captureLine(leaf: WorkspaceLeaf): number {
  const view = leaf.view;
  if (view instanceof ButterEditorView) return view.visibleHeadingLine();
  if (view instanceof MarkdownView) return visibleHeadingLineMD(view);
  return 0;
}

/** Switch a leaf to the requested mode. No-op if already there. */
async function switchToMode(
  leaf: WorkspaceLeaf,
  mode: ButterViewMode,
): Promise<void> {
  const view = leaf.view;
  const file: TFile | null =
    view instanceof MarkdownView || view instanceof ButterEditorView
      ? view.file

      : null;
  if (!file) return;
  if (getCurrentMode(leaf) === mode) return;
  const line = captureLine(leaf);

  if (mode === "butter") {
    await leaf.setViewState(
      {
        type: VIEW_TYPE_BUTTER,
        state: { file: file.path },
      },
      { line },
    );
    return;
  }

  await leaf.setViewState(
    {
      type: "markdown",
      state: {
        file: file.path,
        mode: mode === "reading" ? "preview" : "source",
        source: mode === "source",
      },
    },
    { line },
  );
}

/** Cycle the leaf to the next mode in the user's configured list. */
export function cycleView(leaf: WorkspaceLeaf, modes: ButterViewMode[]): void {
  if (!modes.length) return;
  const current = getCurrentMode(leaf);
  let nextIdx = 0;
  if (current) {
    const idx = modes.indexOf(current);
    if (idx >= 0) nextIdx = (idx + 1) % modes.length;
  }
  void switchToMode(leaf, modes[nextIdx]);
}

/** Human-readable label for a mode - used in tooltips / menu items. */
function modeLabel(mode: ButterViewMode): string {
  switch (mode) {
    case "source": return "Source";
    case "live": return "Live Preview";
    case "reading": return "Reading";
    case "butter": return "Butter";
  }
}

/** Lucide icon name for each mode - surfaced in the View-as menu.
 *  `butter-editor` is the Butter brand mark registered via `addIcon()`
 *  in `onload()`; the others are stock Lucide names. */
export function modeIcon(mode: ButterViewMode): string {
  switch (mode) {
    case "source": return "code-2";
    case "live": return "edit-3";
    case "reading": return "book-open";
    case "butter": return "butter-editor";
  }
}

/**
 * Swap a MarkdownView's leaf to Butter while preserving the visible
 * heading. For CM6 (Live Preview / Source) we read the scroll
 * position from CM6 and find the last heading at-or-above the top
 * of the viewport. For Reading mode, we scan heading DOM rects.
 */
function swapMarkdownToButter(view: MarkdownView) {
  if (!view.file) return;
  const line = visibleHeadingLineMD(view);
  void view.leaf.setViewState(
    {
      type: VIEW_TYPE_BUTTER,
      state: { file: view.file.path },
    },
    { line },
  );
}

/**
 * Source-markdown line of the heading currently at the top of the
 * viewport in a MarkdownView, regardless of view mode (Live Preview,
 * Source, or Reading). Zero when no heading is above the fold.
 */
function visibleHeadingLineMD(view: MarkdownView): number {
  const mode = view.getMode?.() ?? "source";
  const cache = view.file ? view.app.metadataCache.getFileCache(view.file) : null;
  const cached = cache?.headings ?? [];
  if (cached.length === 0) return 0;

  if (mode === "preview") {
    const previewEl: HTMLElement | null =
      view.containerEl.querySelector(".markdown-preview-view") ??
      view.previewMode?.containerEl ??
      null;
    if (!previewEl) return 0;
    const domHs = Array.from(
      previewEl.querySelectorAll("h1, h2, h3, h4, h5, h6"),
    );
    const host = scrollHost(previewEl) ?? previewEl;
    const threshold = host.getBoundingClientRect().top + 40;
    let bestTop = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < domHs.length; i++) {
      const top = domHs[i].getBoundingClientRect().top;
      if (top <= threshold && top > bestTop) {
        bestTop = top;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && cached[bestIdx]) {
      return cached[bestIdx].position.start.line;
    }
    return 0;
  }

  // CM6 (source / live preview): measure each heading's rendered
  // viewport top via coordsAtPos, which reflects actual DOM layout
  // even under live-preview's dynamic decorations. Pick the one
  // closest-to-but-at-or-above the 40px threshold.
  const cm = view.editor?.cm;
  if (!cm) return 0;
  try {
    const scrollDOM = cm.scrollDOM;
    const scrollRect = scrollDOM.getBoundingClientRect();
    const threshold = scrollRect.top + 40;
    let best = -Infinity;
    let bestLine = 0;
    for (const h of cached) {
      const ln = h.position.start.line;
      try {
        const pos = cm.state.doc.line(ln + 1).from;
        const coords = cm.coordsAtPos(pos);
        let top: number;
        if (coords) {
          top = coords.top;
        } else {
          const block = cm.lineBlockAt(pos);
          const estInViewport = block.top - scrollDOM.scrollTop;
          if (estInViewport > 0) continue;
          top = scrollRect.top + estInViewport;
        }
        if (top <= threshold && top > best) {
          best = top;
          bestLine = ln;
        }
      } catch {
        /* skip */
      }
    }
    return bestLine;
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════
//  Settings
// ═══════════════════════════════════════════

export interface ButterSettings {
  /**
   * Allow HTML-only formatting in the toolbar. When ON (default),
   * Butter exposes the marks that have no markdown shorthand and can
   * only be written as inline HTML in source: `<font color>` (text
   * color), `<mark style="background-color: ...">` (custom highlight
   * color), `<u>` (underline), `<sup>` / `<sub>`, `<kbd>`.
   *
   * When OFF, those toolbar buttons hide so the user can't author
   * HTML inline. The plain `==highlight==` toggle stays available
   * because it's markdown-native. The parser still recognises HTML
   * inline marks in source files so existing notes round-trip; the
   * setting is purely a toolbar gate, not a source-level restriction.
   */
  enableHtmlFormatting: boolean;
  /** Enable EditorSuggest bridge for other Obsidian plugins. */
  enableSuggestBridge: boolean;
  /** Enable rich paste + file drop. */
  enablePasteDrop: boolean;
  /** Open .md files in Butter automatically. When ON, any markdown
   *  file opened (via Open Quickly, file explorer click, internal
   *  link, new-note creation, etc.) is switched to the Butter view
   *  unless it's already a Butter leaf. */
  openNewFilesInButter: boolean;
  /** Master kill-switch for Butter's CSS animations + transitions.
   *  When ON, applies `body.butter-no-anim` which a CSS rule in
   *  styles.css uses to nuke `animation` and `transition` on every
   *  Butter-prefixed element + the editor's ProseMirror tree. Also
   *  short-circuits the JS-driven entrance animation in setViewData. */
  disableAnimations: boolean;
  /** Active-style for toolbar (filled/soft/outlined/underline). */
  toolbarActiveStyle: "filled" | "soft" | "outlined" | "underline";
  /** Where the formatting toolbar pins relative to the editor view.
   *  Top: sticks to the top of the view's scroll area (under the
   *  workspace tab chrome). Bottom: sticks to the bottom. Both modes
   *  align to the body's content width so the toolbar's left/right
   *  edges match the prose margins. */
  toolbarPosition: "top" | "bottom";
  /**
   * Visual style of the formatting toolbar:
   *   • attached: flush full-pane chrome row between tab title bar
   *     and editor content, with a hairline border separating it
   *     from the document. Most native-feeling.
   *   • detached: body-width floating card with backdrop blur, sits
   *     inside the editor content with sticky positioning. Visually
   *     "above" the document like a HUD.
   *   • integrated: TBD - merge toolbar controls into the view-header
   *     row itself for the densest chrome (design pending).
   */
  toolbarStyle: "attached" | "detached" | "integrated";
  /**
   * In integrated toolbar mode, show the inline title as a pill to
   * the right of the nav buttons (uses Obsidian's view-header title).
   * When off, the title is hidden in the view header - useful for
   * users who already have the filename in their tab strip and don't
   * want the redundancy.
   */
  integratedShowTitle: boolean;
  /**
   * Which view modes the cycle action button rotates through, in
   * order. Default includes all four. User can pare down (e.g. just
   * "source" + "butter") so the cycle button only flips between
   * those two modes. The "View as…" submenu always shows all four
   * regardless of this setting.
   */
  viewCycleModes: Array<"source" | "live" | "reading" | "butter">;
  /**
   * Experimental: run Obsidian-registered CM6 extensions against a
   * hidden mirror view and surface their decorations inside Butter.
   * Enables inline widget rendering for Dataview inline, Tasks inline,
   * Templater live, etc. - at the cost of more memory + CPU per edit.
   */
  enableCM6Bridge: boolean;
  frontmatterVisibility: "match" | "visible" | "hidden";
  showComments: boolean;
  showListIndentGuides: boolean;
  /**
   * When on, use Butter's own outline sidebar and disable the core
   * Obsidian Outline plugin (avoids two outlines competing). When
   * off, Butter's outline is hidden and the core Outline plugin is
   * restored to whatever state it had.
   */
  useButterOutline: boolean;
  /** Motion curve applied to drag animations (indicator, handle). */
  dragMotion: "springy" | "snappy" | "smooth";
  /** Whether the gutter handle only appears on block hover or
   *  persists on the nearest block at all times. */
  dragHandleVisibility: "hover" | "always";
  /** Px of "earliness" for the block-drag slot swap. Higher commits the
   *  swap sooner (less travel); 0 makes the dragged block fully clear
   *  its neighbor first. Applied symmetrically up/down. */
  blockDragSensitivity: number;
  /**
   * Advanced - Canonical form preferences.
   *
   * Markers used by the serializer when emitting canonical markdown.
   * All default to the most common Obsidian / GitHub convention. Only
   * applied when serializing (preserved blocks emit original bytes
   * regardless of these settings).
   */
  canonicalBullet: "-" | "*" | "+";
  canonicalItalic: "*" | "_";
  canonicalBold: "**" | "__";
  canonicalCodeFence: "```" | "~~~";
  canonicalHorizontalRule: "---" | "***" | "___";
  /**
   * Advanced - Source preservation.
   *
   * When ON, Butter preserves the original bytes of any block you
   * didn't edit. Whitespace, marker style, indentation, blank-line
   * counts - all retained byte-for-byte for unedited blocks. Tight/
   * loose neighbor formatting is preserved only where the original
   * pair stays adjacent; reorders/inserts/deletes break the pair
   * and use a default 1-blank-line gap.
   *
   * When OFF (default), Butter writes canonical markdown - clean,
   * consistent output matching the convention every other WYSIWYG
   * editor uses (Typora, Milkdown, Live Preview's Source Mode). One
   * canonical form: `**bold**`, `-` bullets, single blanks, LF
   * endings. The "first save" of a legacy file may produce a one-
   * time formatting diff as Butter normalizes it; subsequent saves
   * are stable.
   *
   * Off-by-default reflects the dominant ecosystem convention. Turn
   * on if you specifically need byte-for-byte source fidelity for
   * git-tracked vaults, hand-formatted source, or workflows
   * involving non-WYSIWYG tools editing the same files.
   */
  preserveOriginalSource: boolean;
  /**
   * Advanced: ensure at least 1 blank line separates an ATX heading
   * from the following block on save. Off by default (canonical
   * serializer already produces ≥1 blank in most cases; toggle this
   * if you want a stricter guarantee). With source preservation ON,
   * normalizes tight heading-paragraph layouts to the community
   * convention.
   */
  normalizeHeadingGap: boolean;
  /**
   * Advanced: cap runs of 2+ blank lines at 1 on save. Off by default
   * (source is truth - Butter respects multi-blanks authored in LP).
   * On produces clean source matching Prettier / markdownlint style.
   */
  condenseBlankLines: boolean;
  /**
   * Advanced: append a closing ``` (or ~~~) when the file ends mid-
   * fence. Prevents the "user types a new block below what looks like
   * a contained code block in Butter, saves, and reloads to find the
   * new block swallowed into the fence" scenario - CommonMark treats
   * unclosed fences as extending to EOF, so any content authored
   * after them becomes fence body on parse. Idempotent; fence-aware;
   * only top-level fences handled.
   */
  closeUnclosedFences: boolean;
  /**
   * Set to true the first time the user enables any normalizer, after
   * they acknowledge the "this modifies files on save" warning. Used
   * to skip the warning on subsequent enables.
   */
  normalizeWarningAcknowledged: boolean;
  /**
   * Auto-split full-width inline images into their own paragraph.
   * When ON (default), an image / wikilink-embed without a `|W` size
   * hint sitting inside a paragraph with other inline content will
   * be moved into its own block - so a full-column-wide image isn't
   * awkwardly mixed with text that's technically inline but
   * visually attached to a block-level rendering. When OFF, source
   * preservation wins and the image sits inline regardless of
   * visual weirdness.
   */
  splitFullWidthImages: boolean;
  /**
   * Experimental: claim Obsidian's `.markdown-rendered` class on
   * Butter's ProseMirror element so theme CSS scoped to that class
   * cascades into Butter. Expands theme coverage to include rules
   * that override properties directly (bypassing CSS variables),
   * at the cost of potential editing-interaction quirks - some
   * Reading-mode CSS assumes non-contenteditable content and sets
   * `user-select: none` or similar on interactive-looking elements.
   * OFF by default. Flip on if a specific theme's Reading-mode look
   * isn't cascading through; flip off if editing feels broken.
   */
  experimentalThemeCompatMode: boolean;
  /**
   * Verbose debug logging. When on, internal events - parser
   * fallbacks, drag lifecycle, save scheduler ticks, serializer
   * paths, etc. - log to the dev-tools console with a
   * `[butter:<category>]` prefix. Useful for reporting bugs or
   * investigating unusual behavior. Off by default (console stays
   * clean for normal use).
   */
  verboseLogging: boolean;
  /**
   * Legacy. Ids of main-toolbar buttons the user hid via the
   * pre-layout settings UI. Migrated into `toolbarLayout` on first
   * load with the new code; left in place so older versions can
   * still read it if a user downgrades.
   */
  toolbarHiddenButtons: string[];
  /** Legacy. Same as above for the table toolbar. */
  tableToolbarHiddenButtons: string[];
  /**
   * Ordered tree describing the user's main formatting toolbar:
   * each entry is a button (referenced by id), a separator, or a
   * submenu (parent button that opens a popup of its own children).
   * `null` means "use the default layout"; once the user touches
   * the customizer, this becomes a concrete tree.
   */
  toolbarLayout: ToolbarLayoutItem[] | null;
  /**
   * Mobile-specific main-toolbar layout. Same shape as
   * `toolbarLayout` but rendered when `Platform.isMobile` so users
   * can curate a thumb-friendly subset (no submenus - mobile
   * flattens them). `null` means "use the default mobile preset"
   * (`mobileLayoutDefault()`); once the user touches the mobile
   * segment of the customizer, this becomes a concrete tree.
   */
  mobileToolbarLayout: ToolbarLayoutItem[] | null;
  /** Same shape as `toolbarLayout`, for the table toolbar. */
  tableToolbarLayout: ToolbarLayoutItem[] | null;
  /** Mobile-only table-toolbar layout. `null` means "use the
   *  default mobile preset" (`mobileTableLayoutDefault()`). Lets
   *  the user curate a thumb-friendly set of cell actions
   *  separate from the desktop layout. */
  mobileTableToolbarLayout: ToolbarLayoutItem[] | null;
  /** Visual style for the mobile toolbars (main + table).
   *   • `"attached"` (default) - Butter's own thumb-optimized look:
   *     44×44 buttons, backdrop blur, accent-tinted swap buttons.
   *   • `"detached"` - matches Obsidian's built-in mobile toolbar:
   *     `--input-height`-sized buttons, no backdrop blur, standard
   *     chrome. Reads as part of the host app.
   *
   * (Legacy key names "native" / "butter" are migrated on
   * `loadSettings()`.) */
  mobileToolbarStyle: "detached" | "attached";
  /**
   * When ON (default), hovering a bottom-attached toolbar fades
   * Obsidian's status bar out of the way for the duration of the
   * hover - but only if the cursor's X is within (or just left of)
   * the status bar's X range. Lets users reach toolbar buttons that
   * would otherwise be obscured in pane configurations where the
   * leaf's bottom edge sits behind the status bar. Turn off if the
   * fade feels distracting in your layout.
   */
  statusBarHoverFade: boolean;
  /**
   * Source purity preset. The headline question Butter asks new
   * users on first launch:
   *   • "strict"  - markdown is canonical; HTML escape hatches
   *     (font color, raw spans, etc.) are disabled to keep source
   *     clean and tool-portable.
   *   • "rich"    - markdown plus HTML extras are allowed; users
   *     prioritize visual formatting freedom over source purity.
   * Future HTML-only features check this flag directly. Default
   * "strict" matches Obsidian community convention.
   */
  sourcePurity: "strict" | "rich";
  /**
   * Onboarding gate. False on first install → triggers the welcome
   * modal in onload(). Set to true once the user has either picked
   * a source-purity preset or dismissed the modal (silent default
   * = strict). Subsequent launches skip the modal.
   */
  hasCompletedOnboarding: boolean;

  // ── License ──────────────────────────────────────────────────────
  // The Cloudflare Worker at https://api.buttereditor.com is the
  // source of truth. The plugin caches a signed session token here
  // (7-day TTL) so it doesn't need to hit the network on every load,
  // and reads it back on `loadSettings()` to compute `licenseStatus`.
  // Architecture reference lives in the private planning notes.

  /** Per-install random UUID v4. Generated on first load if missing.
   *  Used as the device identifier for trial dedupe + session tokens.
   *  Surviving across vault re-creates is intentional (a vault is one
   *  "device" from the licensing perspective). */
  deviceId: string;

  /** The license key the user pasted (or the trial-issued key). Empty
   *  string when no license is active. */
  licenseKey: string;

  /** Polar customer ID associated with the license. Set when the
   *  Worker's /session call returns. Used for the License tab UI. */
  customerId: string;

  /** HMAC-signed session payload returned by /session. Cached so
   *  subsequent plugin loads don't need to re-validate online. */
  sessionToken: string;

  /** ms-epoch when sessionToken expires. ~7 days from issue. When
   *  within 1 day of expiry, plugin re-validates online on next load. */
  sessionExpiresAt: number;

  /** ms-epoch of the last successful /session call. Drives the
   *  "Last verified: X ago" UI label and the daily background re-check. */
  lastValidatedAt: number;

  /** Sticky flag set the first time /session ever succeeded. Enables
   *  indefinite offline grace: a customer who was once licensed never
   *  gets locked out by Worker / Polar outages. */
  everValidated: boolean;

  /** ms-epoch when the active license expires. Captured from
   *  `/trial/poll`'s `expiresAt` on activation; refreshed on every
   *  successful `/session` validation if the response carries it. 0
   *  means unknown - UI falls back to `sessionExpiresAt`. Drives the
   *  trial countdown ("Trial · 6 days left") + the day-progress bar. */
  licenseExpiresAt: number;

  /** In-flight trial activation. Set when `/trial` returns; cleared
   *  when `/trial/poll` returns ready (or invalid_token / 30-min
   *  staleness). Persisting the pollToken means closing Settings or
   *  Obsidian mid-activation doesn't lose the trial - the plugin's
   *  `onload()` resumes the poll, and re-opening Settings re-renders
   *  the polling UI in place. */
  pendingTrialActivation: {
    pollToken: string;
    startedAt: number;
    /** Browser-fallback URL captured from `/trial`'s response.
     *  Surfaced by the polling state's "Open in browser" escalation
     *  row when polling exceeds 25s. Optional for back-compat with
     *  records persisted before this field existed. */
    checkoutUrl?: string;
  } | null;

  /** ms-epoch when the active license first activated on this device
   *  (trial poll resolved or first /session succeeded). Drives the
   *  Lifetime "activated {date}" line. 0 for legacy installs with no
   *  recorded activation; the License tab falls back to
   *  `lastValidatedAt` when this is 0. */
  activatedAt: number;

  /** Customer's email on the Polar account. Returned by /session
   *  (Worker 1.8.0+) and cached for display on the Lifetime state's
   *  "Holder" line. Empty when unknown / not yet fetched. */
  customerEmail: string;

  /** License tier - `"v1"` for current Butter, `"v2"` once v2
   *  ships and the customer has a v2 benefit grant on Polar.
   *  Returned by /session; cached for offline display. Defaults
   *  to `"v1"`. */
  tier: "v1" | "v2";

  /** Sticky flag set when /session returns `device_deactivated`.
   *  Preserves the deactivation signal across the state-clear in
   *  refreshLicenseStatus so the License tab can surface a
   *  "this device was deactivated from elsewhere" message instead
   *  of dropping to a generic unlicensed flow. Cleared on the next
   *  successful activation (or by Reset license state). */
  wasDeactivated: boolean;

  /** Sticky flag set when /session returns `license_invalid` AND
   *  the customer had previously been validated (`everValidated`).
   *  Distinguishes refund/chargeback/revoked from a normal trial
   *  expiry. Cleared on next successful activation or Reset. */
  wasInvalidated: boolean;

  /** The last error.kind from a /session failure, stored alongside
   *  wasInvalidated so the License tab can surface why ("Reason:
   *  key not recognized by server"). Empty when no recent
   *  failure. */
  lastReason: string;

  /** Developer flag. When true, the trial flow generates a tagged
   *  email so the activation can be executed against production
   *  surfaces without polluting real customer metrics. */
  devTestMode: boolean;
}

/** Module-level timer shared by all Butter views' toolbar hover
 *  handlers. When the cursor moves between two views' toolbars, the
 *  outgoing view's mouseleave schedules a hide-removal; the incoming
 *  view's mouseenter cancels it before it fires. A per-view timer
 *  would race here - view-A's leave-timer would fire while the
 *  cursor is on view-B and incorrectly remove the body class. */
export const StatusState = { statusBarHideTimer: null as number | null };

/** Toggle `body.butter-mobile-active` based on whether any Butter
 *  view's editor currently holds focus. The body class drives the
 *  CSS rule that suppresses Obsidian's native mobile toolbar inside
 *  Butter views (see styles.css). Polled-on-event (focusin/focusout)
 *  rather than refcounted because there's only ever one focused
 *  element at a time and `closest()` is O(depth). */
export function refreshButterMobileBodyClass(): void {
  const active = activeDocument.activeElement;
  const inButter =
    active instanceof Element &&
    active.closest(".butter-editor-view") !== null;
  activeDocument.body.classList.toggle("butter-mobile-active", inButter);
}

const DEFAULT_SETTINGS: ButterSettings = {
  enableHtmlFormatting: true,
  enableSuggestBridge: true,
  enablePasteDrop: true,
  openNewFilesInButter: true,
  disableAnimations: false,
  toolbarActiveStyle: "soft",
  toolbarPosition: "top",
  toolbarStyle: "attached",
  integratedShowTitle: true,
  viewCycleModes: ["source", "live", "reading", "butter"],
  enableCM6Bridge: false,
  frontmatterVisibility: "match",
  showComments: false,
  showListIndentGuides: true,
  useButterOutline: true,
  dragMotion: "springy",
  dragHandleVisibility: "hover",
  blockDragSensitivity: 4,
  canonicalBullet: "-",
  canonicalItalic: "*",
  canonicalBold: "**",
  canonicalCodeFence: "```",
  canonicalHorizontalRule: "---",
  preserveOriginalSource: false,
  normalizeHeadingGap: false,
  condenseBlankLines: false,
  closeUnclosedFences: false,
  normalizeWarningAcknowledged: false,
  splitFullWidthImages: true,
  experimentalThemeCompatMode: false,
  verboseLogging: false,
  toolbarHiddenButtons: [],
  tableToolbarHiddenButtons: [],
  toolbarLayout: null,
  mobileToolbarLayout: null,
  tableToolbarLayout: null,
  mobileTableToolbarLayout: null,
  mobileToolbarStyle: "attached",
  statusBarHoverFade: true,
  sourcePurity: "strict",
  hasCompletedOnboarding: false,
  // License defaults - empty / zero. `deviceId` is generated on first
  // `loadSettings()` if still empty. `everValidated` stays false until
  // /session succeeds at least once.
  deviceId: "",
  licenseKey: "",
  customerId: "",
  sessionToken: "",
  sessionExpiresAt: 0,
  lastValidatedAt: 0,
  everValidated: false,
  licenseExpiresAt: 0,
  pendingTrialActivation: null,
  activatedAt: 0,
  customerEmail: "",
  tier: "v1",
  wasDeactivated: false,
  wasInvalidated: false,
  lastReason: "",
  devTestMode: false,
};

// ═══════════════════════════════════════════
//  View
// ═══════════════════════════════════════════


// ═══════════════════════════════════════════
//  Plugin
// ═══════════════════════════════════════════

/** Every body-level class Butter toggles. Listed here so onunload
 *  can strip them all in one pass and the next DOM inspection
 *  doesn't show residue after disable/uninstall. */
const BUTTER_BODY_CLASSES = [
  "butter-no-anim",
  "butter-status-bar-hide",
  "butter-scroll-hide",
  "butter-mobile-active",
  "butter-mobile-table-active",
  "butter-mobile-prefer-main",
  "butter-mobile-drawer-open",
  "butter-is-dragging",
  "butter-cell-drag-active",
  "butter-cell-drag-copy",
  "butter-table-drag-active",
];

export default class ButterEditorPlugin extends Plugin {
  settings!: ButterSettings;
  /** Remembered when we've flipped the core Outline plugin off so
   *  onunload can restore it - without this we'd leave the user
   *  without an outline if they disable Butter Editor. */
  private disabledNativeOutline = false;
  /** Ribbon icon for our outline, kept to flip visibility when the
   *  setting changes without reloading the plugin. */
  private outlineRibbonEl: HTMLElement | null = null;
  /** Status-bar save-state indicator. Reflects the active view's last
   *  save outcome: clean (round-tripped) or normalized (structure was
   *  altered to satisfy the parser). */
  private saveStatus: SaveStatusController | null = null;
  /** Reference to our settings tab so callers (e.g. the toolbar's
   *  right-click "Settings" item) can pre-select a sub-tab before
   *  opening the modal. */
  private settingTab: ButterSettingTab | null = null;

  /** Worker client for licensing. Initialized in onload(). */
  licenseClient!: LicenseClient;

  /** Computed on every load + on demand; NOT persisted (the underlying
   *  state is in `settings.sessionToken` etc.). Drives read-only
   *  gating in ButterEditorView and the License settings tab UI.
   *
   *   - `valid`: live session token, plugin is licensed
   *   - `trial`: same as valid but the key is from the trial product
   *     (used by the UI to show "Trial - expires X" instead of just
   *     "Active license")
   *   - `expired`: /session returned license_invalid (revoked or
   *     trial ran out)
   *   - `unlicensed`: never validated; user has not started a trial
   *     or pasted a key
   *   - `unknown`: still resolving (the brief window during onload
   *     before refreshLicenseStatus() returns) */
  public licenseStatus: "valid" | "trial" | "expired" | "unlicensed" | "unknown" = "unknown";
  public hasShownLicensePopupThisSession = false;
  private upgradePoller: number | null = null;
  private upgradePollTicks = 0;

  /** When the cached sessionToken expires, in ms epoch. Distinct from
   *  the underlying setting so consumers can read this off the plugin
   *  instance directly. Mirror of `settings.sessionExpiresAt`. */
  get sessionExpiresAt(): number {
    return this.settings?.sessionExpiresAt ?? 0;
  }

  /** Open Obsidian Settings to Butter's tab, optionally jumping to a
   *  specific sub-tab. Used by surfaces (toolbar context menu, etc.)
   *  that want a one-click route into the relevant settings page. */
  openSettings(
    subtab?:
      | "general"
      | "behavior"
      | "toolbar"
      | "advanced"
      | "license",
  ): void {
    if (subtab && this.settingTab) {
      this.settingTab.activeTab = subtab;
    }
    const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
    if (!setting) return;
    setting.open?.();
    setting.openTabById?.(this.manifest.id);
  }

  /** Opens the license settings tab and immediately initiates a trial. */
  /** Temporary UI state to render 'Activating...' instantly when trial flow is triggered externally */
  isActivatingTrialFlow = false;

  startTrialFlow(): void {
    this.isActivatingTrialFlow = true;
    if (this.settingTab) {
      void this.settingTab.beginTrialActivation();
    }
    this.openSettings("license");
  }

  startLifetimeCheckoutFlow(): void {
    window.open(LINKS.buyLifetime(this.settings.deviceId), "_blank");

    if (!this.settings.licenseKey) {
      new Notice(
        "Complete your purchase in the browser, then use the license link on the welcome page to activate Butter.",
        8000,
      );
      return;
    }

    this.startUpgradePolling();
  }

  private startUpgradePolling(): void {
    if (this.upgradePoller != null) return;
    this.upgradePollTicks = 0;
    new Notice("Complete your purchase in the browser. Butter will update automatically.", 8000);
    this.upgradePoller = window.setInterval(() => {
      void this.pollForUpgrade();
    }, 2000);
  }

  private stopUpgradePolling(): void {
    if (this.upgradePoller == null) return;
    window.clearInterval(this.upgradePoller);
    this.upgradePoller = null;
    this.upgradePollTicks = 0;
  }

  private async pollForUpgrade(): Promise<void> {
    this.upgradePollTicks++;
    if (this.upgradePollTicks > 300) {
      this.stopUpgradePolling();
      return;
    }

    try {
      await this.refreshLicenseStatus(true);
      if (this.licenseStatus === "valid") {
        this.stopUpgradePolling();
        this.app.workspace.trigger("butter:license-updated");
        (this.settingTab as { display?: () => void })?.display?.();
      }
    } catch {
      // refreshLicenseStatus is defensive, but keep the checkout poll
      // resilient if a future caller lets network errors bubble.
    }
  }

  /**
   * Refresh `licenseStatus` against the cached session token + (when
   * needed) the Worker's /session endpoint. Call sites:
   *
   *  - `onload()` once on plugin start
   *  - Forced 24-hour interval registered in `onload()`
   *  - After the user enters a key or completes a trial in settings
   *  - After the magic-link deep-link auto-fills a key
   *
   * State machine (full version in the private planning notes,
   * § "Architecture overview"):
   *
   *   no licenseKey         → unlicensed
   *   sessionToken fresh    → valid/trial (no network call unless forced)
   *   local trial expired   → call /session (can still auto-upgrade)
   *   sessionToken stale    → call /session
   *      success            → valid, refresh cached token
   *      license_invalid    → expired
   *      network/polar err  → if everValidated: valid (offline grace)
   *                           else: unknown
   *
   * Emits a `butter:license-changed` workspace event when status
   * transitions so views can re-evaluate their read-only gate.
   */
  private _refreshing = false;
  async refreshLicenseStatus(force = false): Promise<void> {
    if (this._refreshing) return;
    this._refreshing = true;
    try { return await this._refreshLicenseStatusInner(force); } finally { this._refreshing = false; }
  }
  private async _refreshLicenseStatusInner(force = false): Promise<void> {
    const before = this.licenseStatus;
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    if (!this.settings.licenseKey) {
      this.licenseStatus = "unlicensed";

      // Background sync: check if this device has already used a trial on the server
      // so we don't inappropriately show a "Start free trial" button if the local state was lost.
      if (!this.settings.everValidated && !this.settings.activatedAt) {
        try {
          const { eligible } = await this.licenseClient.checkTrialEligibility(this.settings.deviceId);
          if (!eligible) {
            this.settings.everValidated = true;
            this.settings.activatedAt = now;
            await this.saveSettings();
            // Re-render settings tab if open to reflect new state
            this.app.workspace.trigger("butter:license-updated");
          }
        } catch {
          // Ignore network errors on background poll
        }
      }
    } else if (
      !force &&
      this.deriveLocalLicenseStatus(this.settings.licenseKey, now) !== "expired" &&
      this.settings.sessionToken &&
      this.settings.sessionExpiresAt > now + ONE_DAY_MS
    ) {
      this.licenseStatus = this.deriveLocalLicenseStatus(this.settings.licenseKey, now);
    } else {
      // Token missing, expired, or near expiry → re-validate online.
      try {
        const session = await this.licenseClient.validateAndIssueSession(
          this.settings.licenseKey,
          this.settings.deviceId,
        );
        // Auto-upgrade: trial device purchased a paid license
        if (session.upgrade) {
          this.settings.licenseKey = session.upgrade.licenseKey;
          this.settings.customerId = session.upgrade.customerId;
          this.settings.customerEmail = "";
          this.settings.pendingTrialActivation = null;
          await this.saveSettings();
          new Notice("Your license has been upgraded!", 5000);
          import("canvas-confetti").then((m) => {
            void (m.default || m)({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
          }).catch(() => {});
          return this._refreshLicenseStatusInner(true);
        }
        this.settings.sessionToken = session.sessionToken;
        const parsedExpiry = Date.parse(session.expiresAt);
        if (Number.isNaN(parsedExpiry)) throw new Error("malformed expiresAt from server");
        this.settings.sessionExpiresAt = parsedExpiry;
        this.settings.lastValidatedAt = now;
        if (session.customerId) this.settings.customerId = session.customerId;
        if (session.email) this.settings.customerEmail = session.email;
        if (session.tier) this.settings.tier = session.tier;
        this.settings.everValidated = true;
        if (!this.settings.activatedAt) this.settings.activatedAt = now;
        // Successful validation clears any sticky failure flags from a
        // prior session - the user has demonstrably come back.
        this.settings.wasDeactivated = false;
        this.settings.wasInvalidated = false;
        this.settings.lastReason = "";
        await this.saveSettings();
        this.licenseStatus = this.deriveLocalLicenseStatus(this.settings.licenseKey, now);
      } catch (err) {
        const kind = err instanceof LicenseClientError ? err.kind : "unknown";
        if (err instanceof LicenseClientError && err.kind === "license_invalid") {
          // Distinguish refund/chargeback/revoked (customer was once
          // valid → wasInvalidated) from a natural trial expiry
          // (just expired). Both clear the in-flight session.
          this.settings.lastReason = kind;
          const isTrial = this.isTrialKey(this.settings.licenseKey);
          if (this.settings.everValidated && !isTrial) {
            this.settings.wasInvalidated = true;
            await this.saveSettings();
          }
          this.licenseStatus = "expired";
        } else if (err instanceof LicenseClientError && err.kind === "device_deactivated") {
          // Device was deactivated remotely (from another device on
          // the same license). Preserve a sticky `wasDeactivated`
          // flag + last reason BEFORE we clear the rest of the
          // license state, so the License tab can surface a
          // "this device was deactivated from elsewhere" message
          // instead of dropping to a generic unlicensed flow.
          this.settings.wasDeactivated = true;
          this.settings.lastReason = kind;
          this.settings.sessionToken = "";
          this.settings.sessionExpiresAt = 0;
          this.settings.lastValidatedAt = 0;
          this.settings.licenseKey = "";
          this.settings.customerId = "";
          this.settings.licenseExpiresAt = 0;
          this.settings.activatedAt = 0;
          await this.saveSettings();
          this.licenseStatus = "unlicensed";
        } else {
          // network / polar_error / unknown - apply offline grace if
          // the customer was ever validated; otherwise hold "unknown"
          // (treated as unlicensed by the editor gate but distinct in
          // the settings UI so we can show "Couldn't check, retrying…"
          // instead of "License required").
          this.licenseStatus = this.settings.everValidated ? this.deriveLocalLicenseStatus(this.settings.licenseKey) : "unknown";
        }
      }
    }

    if (this.licenseStatus !== before) {
      this.app.workspace.trigger("butter:license-changed");
    }
  }

  /** Heuristic: trial-product keys carry either the new `BTR-T-`
   *  prefix (post-prefix-shortening, 2026-05-11+) or the legacy
   *  `BUTTER_TRIAL-` prefix (pre-shortening - existing customers).
   *  Lifetime license keys use the plain `BTR-` or `BUTTER-` prefix.
   *  The Worker doesn't tell us which product a key belongs to from
   *  /session alone, so we infer locally.
   *
   *  Note: the trailing dash on `BTR-T-` is required for
   *  disambiguation - a lifetime key whose body starts with `T`
   *  (e.g. `BTR-TXY8-…`) must NOT match as a trial. The legacy
   *  `BUTTER_TRIAL` is unambiguous on its own (the underscore
   *  guarantees no collision with the `BUTTER-` lifetime prefix). */
  isTrialKey(key: string): boolean {
    return key.startsWith("BTR-T-") || key.startsWith("BUTTER_TRIAL");
  }

  private deriveLocalLicenseStatus(key: string, now = Date.now()): "valid" | "trial" | "expired" {
    if (!this.isTrialKey(key)) return "valid";
    const expiresAt = this.settings.licenseExpiresAt || 0;
    if (expiresAt > 0 && expiresAt <= now) return "expired";
    return "trial";
  }

  /** Short-term retries when the initial /session call lands in
   *  "unknown". 4 attempts at 30s, 60s, 90s, 120s — covers the
   *  common captive-portal / transient-DNS window without hammering
   *  the server. Stops early if status leaves "unknown" (success or
   *  the user activated a trial in the meantime). */
  private scheduleUnknownRetries(): void {
    const delays = [30_000, 60_000, 90_000, 120_000];
    let i = 0;
    const tick = () => {
      if (i >= delays.length || this.licenseStatus !== "unknown") return;
      const delay = delays[i++];
      this.registerInterval(
        window.setTimeout(() => {
          void (async () => {
            if (this.licenseStatus !== "unknown") return;
            await this.refreshLicenseStatus();
            tick();
          })();
        }, delay),
      );
    };
    tick();
  }

  /**
   * Background-resume an in-flight trial activation. Called from
   * `onload()`. If `pendingTrialActivation` is set + not stale (< 30
   * min old), fires one `/trial/poll` request. On `ready`, persists
   * the license + clears the pending state + emits
   * `butter:license-changed` so any open Settings re-renders. On
   * `pending`, no-op (the in-tab poller takes over once Settings
   * opens). On `invalid_token`, clears the pending state silently.
   */
  async resumeTrialActivation(): Promise<void> {
    const pending = this.settings.pendingTrialActivation;
    if (!pending) return;
    const ageMs = Date.now() - (pending.startedAt || 0);
    if (ageMs > 30 * 60 * 1000) {
      this.settings.pendingTrialActivation = null;
      await this.saveSettings();
      new Notice(
        "Trial activation timed out. Open settings → license to try again.",
        10_000,
      );
      return;
    }
    try {
      const res = await this.licenseClient.pollTrial(pending.pollToken);
      if (res.status === "ready" && res.licenseKey) {
        this.settings.licenseKey = res.licenseKey;
        if (res.expiresAt) {
          const exp = Date.parse(res.expiresAt);
          if (!Number.isNaN(exp)) this.settings.licenseExpiresAt = exp;
        }
        this.settings.pendingTrialActivation = null;
        if (!this.settings.activatedAt) this.settings.activatedAt = Date.now();
        await this.saveSettings();
        await this.refreshLicenseStatus();
        // refreshLicenseStatus only fires the changed event when the
        // status itself flips. Re-fire here so an open Settings panel
        // also re-renders (e.g. license_expires_at changed even if
        // status was already "trial" via offline-grace heuristic).
        this.app.workspace.trigger("butter:license-changed");
      }
    } catch (err) {
      if (err instanceof LicenseClientError && err.kind === "invalid_token") {
        this.settings.pendingTrialActivation = null;
        await this.saveSettings();
      }
      // Other errors: leave pendingTrialActivation in place - the
      // user's next visit to Settings will retry inline.
    }
  }

  /**
   * Handle the magic-link recovery deep-link
   * `obsidian://butter-recover?key=…&customer=…`. Fired when the
   * customer clicks "Re-open in Butter Editor" on the HTML recovery
   * page served by the Worker.
   *
   * Trust model: the user already proved they control the email by
   * being able to click the link from inside their inbox. The plugin
   * still validates the key against Polar via /session before
   * unlocking - no blind trust. So an attacker who somehow forged a
   * deep-link (URL phishing) can't unlock anything because /session
   * would reject a key that isn't on Polar's records.
   *
   * UX: silently auto-fills + validates. On success: opens settings
   * to the License tab + toast. On failure: opens to the License tab so
   * the user sees the error context inline.
   */
  async handleRecoveryDeepLink(rawKey?: string, rawCustomer?: string): Promise<void> {
    const key = (rawKey ?? "").trim();
    const customer = (rawCustomer ?? "").trim();
    if (!key) {
      new Notice("Recovery link is missing the license key.", 7000);
      this.openSettings("license");
      return;
    }
    // Email is informational only; we don't enforce it here. The
    // Worker checks the key against Polar's records.
    try {
      const session = await this.licenseClient.validateAndIssueSession(
        key,
        this.settings.deviceId,
      );
      this.settings.licenseKey = key;
      this.settings.sessionToken = session.sessionToken;
      this.settings.sessionExpiresAt = Date.parse(session.expiresAt);
      this.settings.lastValidatedAt = Date.now();
      if (session.customerId) this.settings.customerId = session.customerId;
      this.settings.everValidated = true;
      await this.saveSettings();
      await this.refreshLicenseStatus();
      this.openSettings("license");
      const tag = customer ? ` (${customer})` : "";
      new Notice(`License recovered${tag}.`, 5000);
    } catch (err) {
      const msg = err instanceof LicenseClientError && err.kind === "license_invalid"
        ? "Recovery link's key is not valid (revoked, expired, or unrecognized)."
        : "Couldn't validate the recovered license. Try again from Settings → License.";
      new Notice(msg, 8000);
      this.openSettings("license");
    }
  }

  async onload() {
    try { await this.loadSettings(); } catch { /* corrupt data.json — defaults applied */ }
    setPluginVersion(this.manifest.version);

    const origGetActiveViewOfType = this.app.workspace.getActiveViewOfType.bind(this.app.workspace);
    const wsPatched = this.app.workspace as unknown as {
      getActiveViewOfType: (type: { name?: string }) => unknown;
      activeLeaf: WorkspaceLeaf | null;
      _butterActiveEditorProxied?: boolean;
      activeEditor: unknown;
    };
    wsPatched.getActiveViewOfType = (type: { name?: string }) => {
      if (type && type.name === "MarkdownView") {
        const activeLeaf = wsPatched.activeLeaf;
        if (activeLeaf && activeLeaf.view instanceof ButterEditorView) {
          return activeLeaf.view;
        }
      }
      return origGetActiveViewOfType(type as Parameters<typeof origGetActiveViewOfType>[0]);
    };

    const origGetLeavesOfType = this.app.workspace.getLeavesOfType.bind(this.app.workspace);
    this.app.workspace.getLeavesOfType = (type: string) => {
      const leaves = origGetLeavesOfType(type);
      if (type === "markdown") {
        const butterLeaves = origGetLeavesOfType(VIEW_TYPE_BUTTER);
        const lockedLeaves = origGetLeavesOfType(VIEW_TYPE_BUTTER_LOCKED);
        return [...leaves, ...butterLeaves, ...lockedLeaves];
      }
      return leaves;
    };

    // Safely proxy activeEditor for widgets. We check the call stack
    // to ensure we return the real activeEditor (usually undefined for Butter)
    // during Obsidian's internal layout lifecycle, preventing crashes.
    const wsEditor = this.app.workspace as import("obsidian").Workspace & { _butterActiveEditorProxied?: boolean, activeEditor?: unknown };
    if (!wsEditor._butterActiveEditorProxied) {
      wsEditor._butterActiveEditorProxied = true;
      const origDescriptor = Object.getOwnPropertyDescriptor(wsEditor, "activeEditor") || { value: wsEditor.activeEditor, writable: true, configurable: true };
      Object.defineProperty(wsEditor, "activeEditor", {
        get: () => {
          const stack = new Error().stack || "";
          if (stack.includes("updateViewState") || stack.includes("_onFileOpen") || stack.includes("activeLeafEvents")) {
            if (origDescriptor.get) return origDescriptor.get.call(wsEditor) as unknown;
            return origDescriptor.value as unknown;
          }
          const butterView = origGetActiveViewOfType(ButterEditorView) as unknown as ButterEditorView | null;
          if (butterView) {
            return butterView;
          }
          if (origDescriptor.get) return origDescriptor.get.call(wsEditor) as unknown;
          return origDescriptor.value as unknown;
        },
        set: (val: unknown) => {
          if (origDescriptor.set) origDescriptor.set.call(wsEditor, val);
          else origDescriptor.value = val;
        },
        configurable: true
      });
    }

    // Initialize the license client and resolve the initial status
    // before any view mounts - read-only gating in ButterEditorView
    // checks `this.licenseStatus` on construction. The bounded ~10s
    // worst case (one /session call) is acceptable startup cost; in
    // the common case (cached token still fresh) this is a no-op.
    this.licenseClient = new LicenseClient();
    await this.refreshLicenseStatus();
    // If the first /session call failed (captive portal, DNS, flaky
    // wifi), schedule short-term retries so first-time users don't
    // sit in "unknown" read-only mode for 24 hours.
    if (this.licenseStatus === "unknown") {
      this.scheduleUnknownRetries();
    }
    // Resume any in-flight trial activation. If the customer tapped
    // "Start trial" and then closed Obsidian or Settings before the
    // poll resolved, this fires the next poll silently in the
    // background - by the time they reopen the License tab their
    // trial is already loaded. Bounded by `pendingTrialActivation`'s
    // 30-min staleness check inside `resumeTrialActivation`.
    void this.resumeTrialActivation();
    // Re-validate every 24h while Obsidian is open. Picks up
    // server-side license revocations and refreshes the cached
    // session token before it expires. registerInterval ensures the
    // timer is cleared on plugin unload (no stray callbacks).
    this.registerInterval(
      window.setInterval(() => {
        void this.refreshLicenseStatus(true);
      }, 24 * 60 * 60 * 1000),
    );
    // Re-validate on wake-from-sleep / mobile-background-return so a
    // trial that expired while the device was asleep is surfaced
    // immediately instead of waiting for the next 24h tick.
    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (activeDocument.visibilityState !== "visible") return;
      const staleMs = Date.now() - (this.settings.lastValidatedAt || 0);
      if (staleMs > 60 * 60 * 1000) {
        void this.refreshLicenseStatus(true);
      }
    });
    // Magic-link recovery deep-link. The Worker's HTML recovery page
    // renders a button as obsidian://butter-recover?key=…&customer=…
    // - clicking it brings Obsidian to front and lands here. See
    // handleRecoveryDeepLink for the security note.
    this.registerObsidianProtocolHandler("butter-recover", (params) => {
      void this.handleRecoveryDeepLink(params.key, params.customer);
    });

    // Boot toast announcing the running plugin + version. Reads
    // straight from the loaded manifest so dev builds (which inject
    // a "(DEV)" suffix into the name and `-N` into the version)
    // automatically show as `Butter Editor (DEV) v0.9.2-127`, while
    // production builds show `Butter Editor v0.9.2`. The counter in
    // the dev version tells you whether a rebuild actually loaded.
    new Notice(`${this.manifest.name} v${this.manifest.version}`, 3000);

    // Locked-file UX. When another process holds a vault file open
    // exclusively (VS Code, antivirus mid-scan, another Obsidian
    // instance), Obsidian's readFile throws `EPERM` / `EBUSY` /
    // `EACCES` and the file silently refuses to open with only a
    // cryptic console error. We catch the unhandled rejection at
    // the window level, identify the failing leaf, and swap it to
    // the ButterLockedFileView - a clean explainer with native-
    // styled action buttons (Try again / Open another / New note).
    // Falls back to a Notice if we can't find a target leaf.
    const lockedFileSwapped = new Set<string>();
    this.registerDomEvent(window, "unhandledrejection", (ev: PromiseRejectionEvent) => {
      const err = ev.reason as unknown;
      if (!err) return;
      const errMsg = (err as { message?: unknown }).message;
      const msg =
        typeof errMsg === "string"
          ? errMsg
          : typeof err === "string"
            ? err
            : "";
      if (!/E(PERM|BUSY|ACCES)/.test(msg)) return;
      const pathMatch = msg.match(/'([^']+\.\w+)'/);
      const fullPath = pathMatch?.[1];
      if (!fullPath) return;

      // Normalize: errors give absolute filesystem paths; vault
      // files use vault-relative paths. Try both shapes.
      const vaultRelative = fullPath
        .replace(/^.*[\\/](?=[^\\/]+[\\/])/, "")
        .replace(/\\/g, "/");
      const name = fullPath.split(/[\\/]/).pop() ?? fullPath;

      // Dedupe - multiple rejections per failure are common
      if (lockedFileSwapped.has(fullPath)) return;
      lockedFileSwapped.add(fullPath);
      window.setTimeout(() => lockedFileSwapped.delete(fullPath), 3000);

      // Find the leaf that was trying to show this file. Search
      // order:
      //   1. Markdown/Butter leaves that still have the file set
      //      (rare - usually the leaf gets cleared on failure).
      //   2. The active leaf if it's now "empty" - when the readFile
      //      fails, Obsidian flips the target leaf to its empty
      //      state (the "new tab" page), and that empty leaf is
      //      usually the active one.
      //   3. Any leaf of type "empty" - fallback if more than one
      //      leaf is open or focus moved.
      const allTyped: WorkspaceLeaf[] = [
        ...this.app.workspace.getLeavesOfType("markdown"),
        ...this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER),
      ];
      let target: WorkspaceLeaf | undefined = allTyped.find((l) => {
        const file = (l.view as { file?: TFile } | undefined)?.file;
        return file && (file.path === vaultRelative || fullPath.endsWith(file.path));
      });
      if (!target) {
        const active = this.app.workspace.getMostRecentLeaf();
        if (active && active.view.getViewType() === "empty") {
          target = active;
        }
      }
      if (!target) {
        const empties = this.app.workspace.getLeavesOfType("empty");
        // Single empty leaf → that's our target. Multiple → pick
        // the active one or the first as a best guess.
        target = empties[0];
      }

      // Best vault-relative path: prefer the target leaf's own file
      // path if one is open; otherwise fall back to the precomputed
      // vault-relative path. (Earlier versions iterated every tracked
      // file looking for a suffix match - removed per Obsidian's
      // policy of avoiding `getFiles().find`.)
      const targetFile = (target?.view as { file?: { path?: string } } | undefined)?.file;
      const lockedPath = targetFile?.path ?? vaultRelative;

      if (target) {
        void target.setViewState({
          type: VIEW_TYPE_BUTTER_LOCKED,
          state: { lockedPath, lockedName: name },
        });
      } else {
        // Last resort: Notice toast.
        new Notice(
          `"${name}" is locked by another process. Close the other app and try again.`,
          7000,
        );
      }
    });

    // Mobile chrome scroll-hide. Native Obsidian Mobile fades the
    // view-header chrome out when the user scrolls down through the
    // note and brings it back when they scroll up - what makes the
    // chrome read as "transparent" in casual comparison. The native
    // behavior is wired to `.cm-scroller`, which our PM editor
    // doesn't have. Hook `.butter-editor-view` (our scroller) to the
    // same effect by toggling a body class that CSS targets.
    if (Platform.isMobile) {
      let lastScrollTop = 0;
      const onScroll = (ev: Event) => {
        const target = ev.target as HTMLElement | null;
        if (!target || !target.classList.contains("butter-editor-view")) return;
        if (activeDocument.body.classList.contains("butter-is-dragging")) return;
        const dragEnd = parseInt(activeDocument.body.dataset.butterDragEndedAt || "0", 10);
        if (Date.now() - dragEnd < 600) return;
        const st = target.scrollTop;
        const delta = st - lastScrollTop;
        // Hide chrome when scrolling DOWN past a small threshold;
        // show when scrolling UP or near the top.
        if (st < 24) {
          activeDocument.body.classList.remove("butter-scroll-hide");
        } else if (delta > 6) {
          activeDocument.body.classList.add("butter-scroll-hide");
        } else if (delta < -6) {
          activeDocument.body.classList.remove("butter-scroll-hide");
        }
        lastScrollTop = st;
      };
      this.registerDomEvent(activeDocument, "scroll", onScroll, { capture: true, passive: true });
    }


    // Custom icons - registered once at load so `setIcon(el, "butter-…")`
    // works the same way as Lucide icon IDs anywhere in the plugin.
    // Row / column rectangles with a diagonal strike-through. The
    // strike crosses the shape's center, reading universally as
    // "this is being deleted" (same visual idiom as a struck-out
    // line of text). Direction encodes axis: row icon is a wide-
    // short bar with a strike; column icon is a tall-narrow bar
    // with a strike that crosses through its center.
    // Butter brand mark - the wave-glyph-in-a-rounded-rect logo.
    // Registered as `butter-editor` and referenced by `modeIcon()`
    // for the View-as menu + the editor's mode-cycle button.
    addIcon(
      "butter-editor",
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:1.5;"><g transform="matrix(1,0,0,1,-112.678345,-44.485992)"><g transform="matrix(1.087664,0,0,1.433718,220.741139,-122.077846)"><g transform="matrix(0.023898,0,0,0.018129,-117.145741,104.829128)"><path d="M1206.206,684.914C1576.954,684.914 1610.168,718.128 1610.168,1088.876C1610.168,1459.624 1576.954,1492.838 1206.206,1492.838C835.458,1492.838 802.244,1459.624 802.244,1088.876C802.244,718.128 835.458,684.914 1206.206,684.914Z" fill="none" stroke="currentColor" stroke-width="76.95"/></g><g transform="matrix(0.013632,0,0,0.015879,-106.215729,112.408534)"><path d="M657.622,782.347C670.417,768.126 657.607,765.864 657.607,765.864C657.607,342.578 713.651,304.657 1339.243,304.657C1964.094,304.657 2020.745,342.488 2020.879,764.362L2020.865,765.864C2019.98,968.497 1943.553,862.395 1778.676,999.512C1620.883,1130.737 1475.792,1048.446 1372.478,952.257C1259.153,846.749 1084.931,928.14 1019.59,949.717C810.02,1018.92 587.616,860.151 657.622,782.347ZM925.33,745.67L1751.055,745.67C1786.884,745.67 1815.973,725.988 1815.973,701.746C1815.973,677.503 1786.884,657.821 1751.055,657.821L925.33,657.821C889.501,657.821 860.413,677.503 860.413,701.746C860.413,725.988 889.501,745.67 925.33,745.67ZM925.33,563.005L1488.998,563.005C1524.827,563.005 1553.916,543.323 1553.916,519.08C1553.916,494.838 1524.827,475.156 1488.998,475.156L925.33,475.156C889.501,475.156 860.413,494.838 860.413,519.08C860.413,543.323 889.501,563.005 925.33,563.005Z" fill="currentColor"/></g></g></g></svg>`,
    );

    addIcon(
      "butter-delete-row",
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="10" width="18" height="4" rx="1"/><path d="M4 18l16-12"/></svg>`,
    );
    addIcon(
      "butter-delete-column",
      `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="3" width="4" height="18" rx="1"/><path d="M6 4l12 16"/></svg>`,
    );

    // Status-bar save indicator. Lucide icon only - `check` when the
    // last save round-tripped cleanly, `triangle-alert` when a save
    // had to fall through to canonical with structural normalization.
    // Click on the warning state opens the diff modal.
    this.saveStatus = installSaveStatus(this, (state) => {
      new SaveDiffModal(this.app, state.original, state.saved, state.reason).open();
    });

    this.registerView(
      VIEW_TYPE_BUTTER,
      (leaf) => new ButterEditorView(leaf, this.settings, this, (result) => {
        this.saveStatus?.set(result);
      }),
    );

    if (this.settings.openNewFilesInButter) {
      this.installExtensionRouting();
    }

    this.registerView(
      VIEW_TYPE_BUTTER_OUTLINE,
      (leaf) => new ButterOutlineView(leaf),
    );

    this.registerView(
      VIEW_TYPE_BUTTER_LOCKED,
      (leaf) => new ButterLockedFileView(leaf, this),
    );

    // Register Butter as a valid `hover-link` source so Obsidian's
    // core page-preview plugin shows hover cards for wikilinks and
    // embeds inside Butter views - same UX as Live Preview / Reading
    // mode. `defaultMod: true` means users who have "require modifier
    // key for preview" enabled must hold that modifier (Obsidian's
    // own preference); we delegate to their setting.
    this.app.workspace.registerHoverLinkSource?.(
      BUTTER_HOVER_SOURCE,
      { display: "Butter Editor", defaultMod: true },
    );

    this.registerCommands();
    this.registerMenus();
    this.registerNewFileHook();
    this.registerFormattingCaptureHandler();
    this.registerPolishCommands();

    // Bridge Butter's PM doc into Obsidian's built-in Word Count
    // plugin so it updates live as the user types, instead of only
    // refreshing when Butter saves to disk.
    installWordCountBridge(this, () => {
      const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
      return v?.pmViewRef() ?? null;
    });



    this.settingTab = new ButterSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Apply the animations kill-switch state to body immediately so
    // any in-flight entrance animations or transitions on already-
    // mounted Butter elements are suppressed from the first frame.
    this.applyAnimationsBodyClass();
    this.register(() => activeDocument.body.classList.remove("butter-no-anim"));

    // Obsidian's internal plugins may not be ready at onload; defer
    // the outline-mode reconcile until the workspace is up.
    this.app.workspace.onLayoutReady(() => {
      void this.applyOutlineMode();
      // Wire the cycle action button onto every existing markdown
      // view + every future one. ButterEditorView wires it itself
      // in onOpen - only markdown views need the injection here.
      this.installCycleButtonsOnAllMarkdownViews();
      // First-launch onboarding. Fires only when the user hasn't yet
      // either picked a preset or dismissed the modal - both paths
      // set the flag so subsequent launches skip silently.
      if (!this.settings.hasCompletedOnboarding) {
        new WelcomeModal(this.app, this).open();
      }
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.installCycleButtonsOnAllMarkdownViews();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.installCycleButtonsOnAllMarkdownViews();
        // Reset save-status indicator when switching files. The
        // newly-opened file's first save (whenever it fires) will
        // update the status; until then the indicator shows clean by
        // default. Avoids carrying a "normalized" warning over from a
        // different file the user already moved past.
        this.saveStatus?.set({ kind: "clean" });
      }),
    );

    // Additive-only file-menu integration. Fires for the more-options
    // 3-dot dropdown and tab-header right-click. Strategy:
    //   • Markdown view (current = source/live/reading): Obsidian
    //     already shows native Source/Live preview/Reading view items.
    //     We add a single "Open as Butter" item.
    //   • Butter view (current = butter): Obsidian doesn't surface
    //     the three markdown view-as items here, so we add them all.
    // After adding, we move our items to the TOP of the menu. We
    // only move our own captured `item.dom` elements - no string
    // matching, no removal of native items, no locale fragility.
    this.registerEvent(
      this.app.workspace.on(
        "file-menu",
        (menu: Menu, file: unknown, source: string, leaf?: WorkspaceLeaf) => {
          if (source !== "more-options" && source !== "tab-header") return;
          if (!(file instanceof TFile) || file.extension !== "md") return;
          const targetLeaf = leaf ?? this.app.workspace.getMostRecentLeaf();
          if (!targetLeaf) return;
          const current = getCurrentMode(targetLeaf);
          const ourModes: ButterViewMode[] =
            current === "butter"
              ? ["source", "live", "reading"]
              : ["butter"];

          const addedItems: MenuItem[] = [];
          for (const mode of ourModes) {
            menu.addItem((item) => {
              item.setTitle(`Open as ${modeLabel(mode)}`);
              item.setIcon(modeIcon(mode));
              item.onClick(() => {
                void switchToMode(targetLeaf, mode);
              });
              addedItems.push(item);
            });
          }

          // Promote our items to the top of the menu DOM. We only move
          // elements WE added (captured via the item callback), so this
          // doesn't touch native items or depend on their text - robust
          // across locales and across Obsidian menu-structure tweaks.
          // Iterate in reverse so the final visible order matches the
          // order we added them in.
          const menuDom = menu.dom;
          if (menuDom) {
            for (let i = addedItems.length - 1; i >= 0; i--) {
              const itemDom = (addedItems[i] as unknown as { dom?: HTMLElement }).dom;
              if (itemDom && itemDom.parentNode === menuDom) {
                menuDom.insertBefore(itemDom, menuDom.firstChild);
              }
            }
          }
        },
      ),
    );

    this.registerMarkdownPostProcessor((el, ctx) => {
      const mount = el.closest(".obsidian-render-mount");
      if (!mount) {
        return;
      }
      if (!("__butterWidgetInfo" in mount)) {
        return;
      }
      const info = (mount as unknown as { __butterWidgetInfo?: { view: import("prosemirror-view").EditorView, getPos: () => number | undefined } }).__butterWidgetInfo;
      if (!info) {
        return;
      }

      const { view: pmView, getPos } = info;

      ctx.getSectionInfo = (targetEl) => {
        const pos = getPos();
        if (pos == null) return null;

        const doc = pmView.state.doc;
        const currentNode = doc.nodeAt(pos);
        if (!currentNode) return null;

        // We don't flush here anymore, to avoid concurrent vault.modify / vault.process races.
        // Instead, we provide an `editor` polyfill on ButterEditorView so widgets can use replaceRange!

        // Normalize line endings to \n so indexOf works across Windows/Mac files
        const fullTextRaw = serializer.serialize(doc);
        const fullText = fullTextRaw.replace(/\r\n/g, '\n');
        
        const blockDoc = doc.cut(pos, pos + currentNode.nodeSize);
        const blockStr = serializer.serialize(blockDoc).replace(/\r\n/g, '\n').trim();

        let occurrenceIndex = 0;
        doc.descendants((n: import("prosemirror-model").Node, nodePos: number) => {
          if (nodePos >= pos) return false;
          if (n.type.name === currentNode.type.name &&
              n.textContent === currentNode.textContent &&
              n.attrs.language === currentNode.attrs.language) {
            occurrenceIndex++;
          }
          return false; // don't descend into block content
        });

        let startIdx = -1;
        let matchCount = 0;
        let currentIndex = fullText.indexOf(blockStr);

        while (currentIndex !== -1) {
          if (matchCount === occurrenceIndex) {
            startIdx = currentIndex;
            break;
          }
          matchCount++;
          currentIndex = fullText.indexOf(blockStr, currentIndex + 1);
        }

        if (startIdx === -1) {
          console.warn("[Butter Debug] Could not find block in serialized string.");
          return null;
        }

        const textBefore = fullText.slice(0, startIdx);
        const lineStart = (textBefore.match(/\n/g) || []).length;
        const lineCount = (blockStr.match(/\n/g) || []).length;
        const lineEnd = lineStart + lineCount;

        // Support widgets that use the context's internal replace method (like official Base/Dataviews)
        // since MarkdownRenderer.render creates a headless context where replace() does nothing.
        (ctx as import("obsidian").MarkdownPostProcessorContext & { replace?: (newText: string) => void }).replace = (newText: string) => {
          let innerText = newText;
          const firstNewline = innerText.indexOf("\n");
          if (firstNewline !== -1 && innerText.startsWith("```")) {
            innerText = innerText.substring(firstNewline + 1);
          }
          const lastFence = innerText.lastIndexOf("\n```");
          if (lastFence !== -1) {
            innerText = innerText.substring(0, lastFence);
          } else if (innerText.endsWith("```")) {
            innerText = innerText.substring(0, innerText.length - 3);
          }
          
          if (!pmView.state.doc.nodeAt(pos)) {
            return;
          }

          const content = innerText.length > 0 ? pmView.state.schema.text(innerText) : null;
          const newNode = pmView.state.schema.nodes.code_block.create(currentNode.attrs, content);
          const tr = pmView.state.tr.replaceWith(pos, pos + currentNode.nodeSize, newNode);
          pmView.dispatch(tr);
        };

        return { text: fullText, lineStart, lineEnd };
      };
    }, -9999);
  }

  private installCycleButtonsOnAllMarkdownViews() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView & {
        _butterCycleAdded?: boolean;
        _butterCycleEl?: HTMLElement;
      };
      if (view.getViewType() === VIEW_TYPE_BUTTER || view.getViewType() === VIEW_TYPE_BUTTER_LOCKED) continue;
      // Skip deferred / placeholder views - Obsidian sometimes returns
      // a stub for an unmounted leaf where `addAction` isn't defined.
      // We'll re-run on layout-change once the view becomes real.
      if (typeof view?.addAction !== "function") continue;
      const currentMode = getCurrentMode(leaf) ?? "live";
      const icon = modeIcon(currentMode);

      if (!view._butterCycleAdded) {
        view._butterCycleAdded = true;
        const el = view.addAction(
          icon,
          "Switch view mode",
          () => {
            cycleView(view.leaf, this.settings.viewCycleModes);
          },
        );
        el.setAttribute("data-butter-action", "cycle");
        view._butterCycleEl = el;
      } else if (view._butterCycleEl) {
        // Existing button: refresh icon so it tracks in-place mode
        // changes (Source ↔ Live Preview ↔ Reading don't recreate
        // the view, just toggle mode - addAction wouldn't re-fire,
        // so we update the icon manually on every layout-change).
        setIcon(view._butterCycleEl, icon);
      }

      // Hide Obsidian's native LP/Reading toggle button. Identified by
      // the lucide icon class on its inner SVG - Obsidian uses one of
      // a small known set (book-open / edit-3 / pencil / etc.) for
      // the toggle. We skip our own button via data-butter-action.
      this.hideNativeToggleIn(view);
    }
  }

  private hideNativeToggleIn(view: MarkdownView) {
    if (!view?.containerEl) return;
    const actions = view.containerEl.querySelector(".view-actions");
    if (!actions) return;
    const NATIVE_TOGGLE_ICONS = new Set([
      "lucide-edit-3",
      "lucide-pencil",
      "lucide-pen",
      "lucide-square-pen",
      "lucide-book-open",
      "lucide-eye",
    ]);
    actions.querySelectorAll<HTMLElement>(".clickable-icon").forEach((btn) => {
      if (btn.getAttribute("data-butter-action")) return; // ours, skip
      if (btn.dataset.butterToggleHidden === "1") return; // already hidden
      const svg = btn.querySelector("svg");
      if (!svg) return;
      const hasToggleIcon = Array.from(svg.classList).some((c) =>
        NATIVE_TOGGLE_ICONS.has(c),
      );
      if (!hasToggleIcon) return;
      btn.addClass("butter-hidden");
      btn.dataset.butterToggleHidden = "1";
    });
  }

  onunload(): void {
    this.stopUpgradePolling();

    // FIRST: flush any in-flight scheduled saves across open Butter
    // views. If the user disables Butter mid-typing (within the save
    // scheduler's idle window), pending edits would otherwise get
    // torn down without firing and the last few keystrokes would be
    // lost. Obsidian unloads the plugin before tearing down its
    // views, so we can't rely on per-view `onClose` to catch this
    // path.
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER);
    for (const leaf of leaves) {
      const view = leaf.view as ButterEditorView | undefined;
      const scheduler = (view as { saveScheduler?: { hasPending: () => boolean; flush: () => void } } | undefined)?.saveScheduler as
        | { hasPending: () => boolean; flush: () => void }
        | null
        | undefined;
      if (scheduler && scheduler.hasPending()) {
        try {
          scheduler.flush();
        } catch {
          /* swallow - save can fail during teardown; onClose will
             get another shot if we make it that far */
        }
      }
    }

    // Strip every body class Butter toggles. The CSS rules these
    // classes target are gone with our styles.css, so they're inert
    // on disable - but leaving them on <body> after uninstall reads
    // as residue when a user inspects the DOM. Cheap to clean up.
    // (`butter-no-anim` is already registered for removal via
    // `this.register()` during enableOnReady; included here too as a
    // belt-and-braces in case that path didn't run.)
    const body = activeDocument.body;
    for (const cls of BUTTER_BODY_CLASSES) {
      body.removeClass(cls);
    }

    // Best-effort: if we turned off core Outline, flip it back on so
    // the user isn't left with no outline when Butter is disabled.
    const core = this.app.internalPlugins?.plugins?.outline;
    if (this.disabledNativeOutline && core && !core.enabled) {
      void (async () => {
        try {
          await core.enable?.();
        } catch {
          /* nothing to do */
        }
      })();
      this.disabledNativeOutline = false;
    }
  }

  private registerCommands() {
    this.addCommand({
      id: "toggle-butter",
      name: "Toggle WYSIWYG mode",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
        if (v?.file) {
          if (!checking) swapButterToMarkdown(v);
          return true;
        }
        const md = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (md?.file) {
          if (!checking) swapMarkdownToButter(md);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "open-as-butter",
      name: "Open current note in WYSIWYG view",
      checkCallback: (checking) => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!md?.file) return false;
        if (!checking) swapMarkdownToButter(md);
        return true;
      },
    });

    this.addCommand({
      id: "open-as-markdown",
      name: "Switch back to default Markdown view",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
        if (!v?.file) return false;
        if (!checking) swapButterToMarkdown(v);
        return true;
      },
    });

    // Find / Replace in note. No default hotkeys - Obsidian's policy
    // discourages default bindings since they can override user-
    // configured hotkeys. Users bind these via Settings → Hotkeys.
    this.addCommand({
      id: "find-in-note",
      name: "Find in note",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
        const pm = v?.pmViewRef();
        if (!pm) return false;
        if (!checking) openFind(pm);
        return true;
      },
    });

    this.addCommand({
      id: "replace-in-note",
      name: "Replace in note",
      checkCallback: (checking) => {
        const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
        const pm = v?.pmViewRef();
        if (!pm) return false;
        if (!checking) openReplace(pm);
        return true;
      },
    });

    // ── Formatting shortcuts ───────────────────────────────────
    //
    // Registered at the Obsidian command level rather than as PM
    // keymap bindings. Obsidian's global dispatcher fires the first
    // command whose checkCallback returns true; since `ctx` for a
    // Butter view is a ButterEditorView (not MarkdownView),
    // Obsidian's own `editor:toggle-bold` etc. return false while
    // ours return true, so our commands are the ones that run in
    // Butter while the natives keep working in Source / Live Preview.
    const butterMarkCommand = (
      id: string,
      name: string,
      hotkey:
        | { modifiers: ("Mod" | "Shift" | "Alt" | "Ctrl" | "Meta")[]; key: string }
        | null,
      markName: string,
    ) => {
      this.addCommand({
        id,
        name,
        ...(hotkey ? { hotkeys: [hotkey] } : {}),
        checkCallback: (checking) => {
          const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
          const pm = v?.pmViewRef();
          if (!pm) return false;
          const mark = (pm.state.schema.marks as Record<string, MarkType>)[markName];
          if (!mark) return false;
          if (!checking) toggleMark(mark)(pm.state, pm.dispatch.bind(pm));
          return true;
        },
      });
    };

    butterMarkCommand("toggle-bold", "Toggle bold", null, "strong");
    butterMarkCommand("toggle-italic", "Toggle italic", null, "em");
    butterMarkCommand("toggle-inline-code", "Toggle inline code", null, "code");
    butterMarkCommand(
      "toggle-strikethrough",
      "Toggle strikethrough",
      null,
      "strikethrough",
    );
    butterMarkCommand("toggle-highlight", "Toggle highlight", null, "highlight");
  }

  /**
   * Commands that back the Tier-2 polish layer: outline view, zen
   * mode, shortcut help. All globally-available (palette + ribbon)
   * rather than gated on Butter being active, because they're about
   * the shell / workflow, not document edits.
   */
  private registerPolishCommands() {
    this.addCommand({
      id: "show-shortcuts",
      name: "Show keyboard shortcuts",
      callback: () => new ShortcutHelpModal(this.app).open(),
    });

    this.addCommand({
      id: "open-outline",
      name: "Open outline view",
      checkCallback: (checking) => {
        if (!this.settings.useButterOutline) return false;
        if (!checking) void this.openOutline();
        return true;
      },
    });

    this.addCommand({
      id: "toggle-frontmatter-visibility",
      name: "Toggle frontmatter visibility",
      callback: async () => {
        const cycle: Record<string, "match" | "visible" | "hidden"> =
          { match: "visible", visible: "hidden", hidden: "match" };
        const next = cycle[this.settings.frontmatterVisibility] ?? "match";
        this.settings.frontmatterVisibility = next;
        await this.saveSettings();
        this.refreshAllButterViews();
        const labels = { match: "Match Obsidian", visible: "Always visible", hidden: "Always hidden" };
        new Notice(`Frontmatter: ${labels[next]}`);
      },
    });

    this.addCommand({
      id: "toggle-comments",
      name: "Toggle comments",
      callback: async () => {
        this.settings.showComments = !this.settings.showComments;
        await this.saveSettings();
        this.refreshAllButterViews();
        new Notice(`Comments: ${this.settings.showComments ? "shown" : "hidden"}`);
      },
    });

    // One-shot source normalizer on the active file. Applies BOTH
    // normalizers (heading-gap + condense-blanks) to the current
    // file's content via vault.modify, independent of the global
    // toggles. Useful for cleaning up a single note without opting
    // in across the vault.
    //
    // If the file has no changes after normalization, no write
    // happens (avoids spurious mtime bumps).
    // Two cleanup commands with deliberately distinct scopes:
    //
    //   "Tidy whitespace" - string-level only. Runs heading-gap +
    //   condense-blanks + close-fences once on the source text. Doesn't
    //   parse the file. Useful for quick whitespace cleanup that doesn't
    //   touch marker style, table padding, or anything else.
    //
    //   "Rewrite in canonical form" - full parse + serialize. Rewrites
    //   markers (bullet/italic/bold), table padding, indentation, blank-
    //   line layout. Then applies normalizers if their toggles are on.
    //   The thorough cleanup; expect a bigger diff.
    this.addCommand({
      id: "normalize-current-note",
      name: "Tidy whitespace in current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.normalizeCurrentFile();
        return true;
      },
    });

    this.addCommand({
      id: "canonicalize-current-note",
      name: "Rewrite current note in standard format",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.canonicalizeFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "canonicalize-vault",
      name: "Rewrite entire vault in standard format (irreversible - back up first)",
      callback: () => void this.canonicalizeVaultWithConfirm(),
    });

    // Mobile-friendly error inspection. Mobile Obsidian has no
    // accessible JS console, so console.error is invisible to the
    // user. The error ring buffer in debug.ts captures recent
    // entries; this command surfaces them in a modal that's
    // copy-able + clearable.
    this.addCommand({
      id: "show-recent-errors",
      name: "Show recent errors",
      callback: () => {
        new ErrorLogModal(this.app, getErrorLog(), () => clearErrorLog()).open();
      },
    });

    this.outlineRibbonEl = this.addRibbonIcon(
      "list-tree",
      "Open Butter outline",
      () => this.openOutline(),
    );
    // Applied on layout-ready below (see applyOutlineMode).
  }

  private async openOutline() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_BUTTER_OUTLINE);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_BUTTER_OUTLINE, active: true });
    await workspace.revealLeaf(leaf);
  }

  /**
   * Read the active markdown file, apply both normalizers to its
   * body (preserving frontmatter + line-ending style), and write the
   * result back. No-op if normalization produces the same bytes.
   *
   * Operates at the FILE level (not through the PM view), so it
   * works regardless of whether the current view is Butter, Live
   * Preview, Source, or Reading. Also independent of the global
   * toggles - users can invoke this for one-off cleanup without
   * opting into automatic normalization vault-wide.
   */
  private async normalizeCurrentFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;
    const original = await this.app.vault.read(file);

    // Detect + strip frontmatter so the normalizer runs on body only.
    // We re-attach frontmatter verbatim. Butter's parser doesn't
    // handle YAML frontmatter directly - it's a separate top-matter
    // construct Obsidian owns.
    const fmMatch = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(original);
    const frontmatter = fmMatch ? fmMatch[1] : "";
    const body = fmMatch ? original.slice(fmMatch[1].length) : original;

    // Preserve line ending. Work on LF internally then restore.
    const crlf = /\r\n/.test(body);
    const bodyLF = body.replace(/\r\n/g, "\n");

    const normalizedLF = normalizeSource(bodyLF, {
      headingGap: true,
      condenseBlanks: true,
      closeUnclosedFences: true,
    });

    if (normalizedLF === bodyLF) return; // no change - skip write

    const normalized = crlf
      ? normalizedLF.replace(/\n/g, "\r\n")
      : normalizedLF;

    await this.app.vault.modify(file, frontmatter + normalized);
  }

  /**
   * Build the canonical-form options object from current settings.
   * Used by the canonicalize commands and the save path so they
   * stay in lockstep - same preferences applied wherever canonical
   * synthesis happens.
   */
  private canonicalOptionsFromSettings() {
    return {
      bullet: this.settings.canonicalBullet,
      italic: this.settings.canonicalItalic,
      bold: this.settings.canonicalBold,
      codeFence: this.settings.canonicalCodeFence,
      horizontalRule: this.settings.canonicalHorizontalRule,
    };
  }

  /**
   * Force-canonicalize a single file. Parse the body, serialize via
   * canonical (honoring user's marker preferences), apply enabled
   * normalizers, write back.
   *
   * Frontmatter is preserved byte-identical (Butter's parser doesn't
   * own YAML; that's Obsidian's surface). Line endings + BOM are
   * preserved at the file shell level.
   *
   * Skips writing if the canonical output equals the input - avoids
   * spurious mtime bumps and sync events for already-canonical files.
   *
   * Returns: { changed: boolean, error?: string } so the vault-wide
   * driver can report aggregate results without throwing on per-file
   * parse failures.
   */
  private async canonicalizeFile(
    file: TFile,
  ): Promise<{ changed: boolean; error?: string }> {
    try {
      const original = await this.app.vault.read(file);

      // BOM detection.
      let hasBOM = false;
      let afterBOM = original;
      if (original.charCodeAt(0) === 0xfeff) {
        hasBOM = true;
        afterBOM = original.slice(1);
      }

      // Frontmatter passthrough.
      const fmMatch = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/.exec(afterBOM);
      const frontmatter = fmMatch ? fmMatch[1] : "";
      const body = fmMatch ? afterBOM.slice(fmMatch[1].length) : afterBOM;

      const isCRLF = body.includes("\r\n");
      const bodyLF = body.replace(/\r\n/g, "\n");

      // Trailing-newline count from input. Canonical default is 1
      // when ambiguous; preserve when explicit.
      const trailMatch = bodyLF.match(/\n*$/);
      const trailingCount = trailMatch ? Math.max(1, trailMatch[0].length) : 1;

      const doc = parser.parse(bodyLF);
      if (!doc) {
        return { changed: false, error: "parse returned null" };
      }

      let canonical = serializer.serialize(
        doc,
        this.canonicalOptionsFromSettings(),
      );

      // Apply enabled normalizers AFTER canonical-serialize. They're
      // idempotent and operate on the source string.
      if (
        this.settings.normalizeHeadingGap ||
        this.settings.condenseBlankLines ||
        this.settings.closeUnclosedFences
      ) {
        canonical = normalizeSource(canonical, {
          headingGap: this.settings.normalizeHeadingGap,
          condenseBlanks: this.settings.condenseBlankLines,
          closeUnclosedFences: this.settings.closeUnclosedFences,
        });
      }

      // Restore trailing-newline count.
      canonical = canonical.replace(/\n*$/, "") + "\n".repeat(trailingCount);

      // Reattach frontmatter, line-ending, BOM.
      let out = frontmatter + canonical;
      out = out.replace(/\r\n/g, "\n"); // normalize first
      if (isCRLF) out = out.replace(/\n/g, "\r\n");
      if (hasBOM) out = "﻿" + out;

      if (out === original) return { changed: false };

      await this.app.vault.modify(file, out);
      return { changed: true };
    } catch (e) {
      const err = e as { message?: string };
      return {
        changed: false,
        error: String(err?.message ?? e),
      };
    }
  }

  /**
   * Show a confirm modal then iterate every .md file in the vault,
   * canonicalizing each. Reports aggregate counts via Notice.
   * Long-running (~ms per file × file count) - chunked into yields
   * so the UI doesn't freeze.
   */
  private async canonicalizeVaultWithConfirm(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const ok = await new Promise<boolean>((resolve) => {
      new CanonicalizeVaultModal(this.app, files.length, resolve).open();
    });
    if (!ok) return;

    const startNotice = new Notice(
      `Canonicalizing ${files.length} files…`,
      0,
    );
    let changed = 0;
    let unchanged = 0;
    let errored = 0;
    const errorSamples: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const result = await this.canonicalizeFile(file);
      if (result.error) {
        errored++;
        if (errorSamples.length < 5) {
          errorSamples.push(`${file.path}: ${result.error}`);
        }
      } else if (result.changed) {
        changed++;
      } else {
        unchanged++;
      }

      // Yield to the event loop every 25 files so the UI breathes
      // and the user can cancel via reload if something hangs.
      if (i % 25 === 0) {
        await new Promise((r) => window.setTimeout(r, 0));
      }
    }

    startNotice.hide();
    const summary =
      `Canonicalized: ${changed} changed, ${unchanged} unchanged` +
      (errored ? `, ${errored} errored` : "");
    new Notice(summary, 8000);
    if (errored) {
      console.warn(
        "[butter] Canonicalize errors:\n" + errorSamples.join("\n"),
      );
    }
  }

  /** Toggle `body.butter-no-anim` to match the current setting. The
   *  CSS rule keyed off this class nukes animations + transitions on
   *  every Butter-prefixed element and the ProseMirror tree. Called
   *  on plugin load and whenever the user flips the setting. */
  applyAnimationsBodyClass(): void {
    activeDocument.body.classList.toggle(
      "butter-no-anim",
      this.settings.disableAnimations,
    );
  }

  /**
   * Reconcile the world with `settings.useButterOutline`:
   *
   *   • On ─ disable core Outline (remembered so we can restore on
   *     unload / setting-off). Show our ribbon and command.
   *   • Off ─ close any open Butter Outline leaves and re-enable
   *     core Outline if we were the one that disabled it. Hide our
   *     ribbon.
   */
  async applyOutlineMode() {
    const core = this.app.internalPlugins?.plugins?.outline;
    if (this.settings.useButterOutline) {
      if (core?.enabled && !this.disabledNativeOutline) {
        this.disabledNativeOutline = true;
        try {
          await core.disable?.();
        } catch {
          this.disabledNativeOutline = false;
        }
      }
      if (this.outlineRibbonEl) this.outlineRibbonEl.removeClass("butter-hidden");
    } else {
      for (const leaf of this.app.workspace.getLeavesOfType(
        VIEW_TYPE_BUTTER_OUTLINE,
      )) {
        leaf.detach();
      }
      if (this.disabledNativeOutline && core && !core.enabled) {
        try {
          await core.enable?.();
        } catch {
          /* user can re-enable manually if this fails */
        }
        this.disabledNativeOutline = false;
      }
      if (this.outlineRibbonEl) this.outlineRibbonEl.addClass("butter-hidden");
    }
  }

  /** Push the experimental theme-compat class state to every active
   *  Butter view so the setting's toggle takes effect immediately
   *  without the user reopening each file. */
  public applyThemeCompatModeToAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER)) {
      const v = leaf.view as unknown as ButterEditorView;
      if (typeof v?.applyThemeCompatMode === "function") {
        v.applyThemeCompatMode();
      }
    }
  }

  /** Push the toolbar-position preference to every active Butter view.
   *  Updates the data-toolbar-pos attribute (CSS swaps sticky-top vs
   *  sticky-bottom rules) AND moves the toolbar DOM node to the end /
   *  before-editor position so sticky positioning has the right
   *  ancestor placement. Called from the settings tab on dropdown
   *  change. */
  public applyToolbarPositionToAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER)) {
      const v = leaf.view as unknown as ButterEditorView;
      if (typeof v?.applyToolbarPosition === "function") {
        v.applyToolbarPosition();
      }
    }
  }

  /** Push toolbar button visibility (from settings) to every active
   *  Butter view. Called from the settings tab when the user toggles
   *  a per-button hide/show. */
  public refreshAllButterViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER)) {
      const v = leaf.view as unknown as ButterEditorView;
      if (typeof v?.renderProperties === "function") {
        v.renderProperties();
      }
      v?.contentEl?.toggleClass("butter-no-indent-guides", !this.settings.showListIndentGuides);
      v?.contentEl?.toggleClass("butter-show-comments", this.settings.showComments);
    }
  }

  public applyToolbarButtonVisibilityToAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BUTTER)) {
      const v = leaf.view as unknown as ButterEditorView;
      if (typeof v?.applyToolbarButtonVisibility === "function") {
        v.applyToolbarButtonVisibility();
      }
    }
  }

  private registerMenus() {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) => {
          item
            .setTitle("Open in Butter editor")
            .setIcon("edit-3")
            .onClick(() => {
              const leaf = this.app.workspace.getLeaf(false);
              void leaf.setViewState({
                type: VIEW_TYPE_BUTTER,
                state: { file: file.path },
              });
            });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        menu.addItem((item) => {
          item
            .setTitle("Switch to Butter editor")
            .setIcon("edit-3")
            .onClick(() => swapMarkdownToButter(view));
        });
      }),
    );
  }

  /**
   * Install a document-level keydown listener in CAPTURE phase so
   * Butter's formatting hotkeys intercept before Obsidian's own
   * command dispatcher (which would otherwise route Ctrl+B through
   * `editor:toggle-bold` against our editor shim and eat the event).
   *
   * Only fires when the active view is a ButterEditorView with an
   * active PM editor; otherwise the event is left alone so Obsidian's
   * native hotkeys keep working in Source / Live Preview / every
   * other view type.
   */
  private registerFormattingCaptureHandler() {
    const isMod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

    const handler = (evt: KeyboardEvent) => {
      if (!isMod(evt)) return;

      const key = evt.key.toLowerCase();
      const shift = evt.shiftKey;
      let markName: string | null = null;
      if (!shift) {
        if (key === "b") markName = "strong";
        else if (key === "i") markName = "em";
        else if (key === "e") markName = "code";
      } else {
        if (key === "s") markName = "strikethrough";
        else if (key === "h") markName = "highlight";
      }
      if (!markName) return;

      const v = this.app.workspace.getActiveViewOfType(ButterEditorView);
      const pm = v?.pmViewRef();
      if (!pm) return;

      const target = evt.target as Node | null;
      if (!target || !v!.containerEl.contains(target)) return;

      const mark = pm.state.schema.marks[markName];
      if (!mark) return;

      evt.preventDefault();
      evt.stopImmediatePropagation();
      toggleMark(mark)(pm.state, pm.dispatch.bind(pm));
    };

    // Window capture phase is the earliest listener slot in the DOM
    // event chain - earlier than any document-level handler Obsidian
    // or another plugin could register. Whichever one Obsidian's own
    // hotkey dispatcher uses, ours fires first and claims the event
    // (via stopImmediatePropagation) when Butter is the target. For
    // all other views, the handler early-returns and the event
    // continues to native hotkey processing.
    this.registerDomEvent(window, "keydown", handler, { capture: true });
    this.registerDomEvent(activeDocument, "keydown", handler, { capture: true });
  }

  /**
   * Route .md files to Butter at the view-registry level so every
   * open path - file-explorer click, wikilink, quick-switcher,
   * new-note, OS drag-drop - creates a Butter view directly instead
   * of a MarkdownView we then race-swap. Obsidian's public
   * `Plugin.registerExtensions` throws on conflict (the built-in
   * markdown view already owns `.md`), so we operate on the
   * underlying viewRegistry: capture the current handler, install
   * ours, and restore the captured handler on plugin unload.
   *
   * The explicit "switch to source/live/reading" cycle still works
   * because `swapButterToMarkdown` sets the leaf's view type to
   * `"markdown"` directly, which bypasses the extension map.
   *
   * Setting-gated; takes effect on plugin load only. Toggling
   * `openNewFilesInButter` at runtime requires a reload.
   *
   * `viewRegistry` is internal API. The whole flow is guarded so a
   * future Obsidian version that renames or removes it degrades
   * gracefully to "no auto-route"; the file-open polling hook below
   * picks up the slack via the swap-after-mount path.
   *
   * Partial-failure handling: if `unregister` succeeds but `register`
   * for Butter throws, we restore the captured handler immediately
   * so `.md` files don't end up orphaned mid-session.
   */
  private installExtensionRouting() {
    const reg = this.app.viewRegistry;
    const previous: string | undefined = reg?.typeByExtension?.["md"];
    if (
      !previous ||
      typeof reg?.unregisterExtensions !== "function" ||
      typeof reg?.registerExtensions !== "function"
    ) {
      return;
    }
    try {
      reg.unregisterExtensions(["md"]);
    } catch (e) {
      recordError("auto-butter", `unregister .md failed: ${String(e)}`);
      return;
    }
    try {
      reg.registerExtensions(["md"], VIEW_TYPE_BUTTER);
    } catch (e) {
      recordError("auto-butter", `register .md → butter failed: ${String(e)}`);
      try { reg.registerExtensions(["md"], previous); } catch { /* best-effort restore */ }
      return;
    }
    this.register(() => {
      try {
        reg.unregisterExtensions?.(["md"]);
        reg.registerExtensions?.(["md"], previous);
      } catch (e) {
        recordError("auto-butter", `restore .md handler on unload failed: ${String(e)}`);
      }
    });
  }

  private registerNewFileHook() {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.openNewFilesInButter) return;
        if (!file || file.extension !== "md") return;
        // Poll for up to ~10 frames (~165ms @ 60fps) looking for a
        // MarkdownView leaf showing the just-opened file. file-open
        // fires at variable points across open paths:
        //   - file-explorer click: leaf already mounted, find on attempt 0
        //   - quick-switcher: usually 1-2 frames late
        //   - link click that converts a butter leaf back to markdown:
        //     Obsidian fires file-open BEFORE the view-type swap
        //     completes, so we need to wait until the swap lands
        // A fixed single-rAF deferral handled the easy paths but lost
        // the race on the slow ones, leaving the leaf in Live Preview.
        this.tryAutoSwapToButter(file, 0);
      }),
    );
  }

  /** Locate any leaf showing `file` as a MarkdownView and swap it to
   *  Butter. Re-arms via `requestAnimationFrame` up to MAX_ATTEMPTS so
   *  we catch leaves that haven't finished mounting yet. Short-
   *  circuits silently if the file is already in a Butter view (the
   *  expected path now that view-registry routing sends .md straight
   *  to Butter). Only logs when an actual swap is performed or when
   *  the budget runs out without finding either butter or markdown
   *  view - those are the real signals worth noticing. */
  private tryAutoSwapToButter(file: TFile, attempt: number) {
    const MAX_ATTEMPTS = 10;
    if (!this.settings.openNewFilesInButter) return;
    let target: WorkspaceLeaf | null = null;
    let alreadyButter = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (alreadyButter) return;
      const view = leaf.view;
      if (view instanceof ButterEditorView && view.file?.path === file.path) {
        alreadyButter = true;
        return;
      }
      if (!target && view instanceof MarkdownView && view.file?.path === file.path) {
        target = leaf;
      }
    });
    if (alreadyButter) return; // routed directly via extension map - nothing to do
    if (target) {
      debug("auto-butter", `swap on attempt ${attempt}:`, file.path);
      void (target as WorkspaceLeaf).setViewState({
        type: VIEW_TYPE_BUTTER,
        state: { file: file.path },
      });
      return;
    }
    if (attempt >= MAX_ATTEMPTS) {
      debug("auto-butter", `no butter or markdown leaf after ${attempt} attempts:`, file.path);
      return;
    }
    window.requestAnimationFrame(() => this.tryAutoSwapToButter(file, attempt + 1));
  }

  async loadSettings() {
    const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    // Sanitize: only carry forward keys we know about. Unknown keys
    // accumulate when settings are renamed or removed in code but
    // the saved data.json keeps the old field. Without this filter,
    // `Object.assign({}, DEFAULT_SETTINGS, raw)` would preserve them
    // on every save in perpetuity. We track whether any were dropped
    // and force a clean save below so the on-disk file matches the
    // in-memory shape immediately.
    const known = new Set(Object.keys(DEFAULT_SETTINGS));
    const filtered: Record<string, unknown> = {};
    let hadUnknownKeys = false;
    for (const [k, v] of Object.entries(raw)) {
      if (known.has(k)) filtered[k] = v;
      else hadUnknownKeys = true;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, filtered);
    // Migrate legacy mobileToolbarStyle keys ("native" / "butter") to
    // the new names ("detached" / "attached"). Old data.json files
    // still have the legacy values; rename them in-memory now and
    // mark dirty so the new key gets written on the next save.
    {
      const raw = this.settings.mobileToolbarStyle as unknown as string;
      if (raw === "native") {
        this.settings.mobileToolbarStyle = "detached";
        hadUnknownKeys = true;
      } else if (raw === "butter") {
        this.settings.mobileToolbarStyle = "attached";
        hadUnknownKeys = true;
      }
    }
    // Push verbose-logging state to the module flag so debug() calls
    // across the plugin pick up the current setting without having
    // to thread `settings` through every file.
    setVerbose(this.settings.verboseLogging);
    // Migrate legacy hidden-button arrays to the new layout tree.
    // Only runs when the layout is null (first load with new code).
    // The hidden arrays are left in place so a downgrade still works.
    if (this.settings.toolbarLayout === null) {
      this.settings.toolbarLayout = migrateFromHiddenList(
        defaultMainLayout(),
        this.settings.toolbarHiddenButtons,
      );
    } else {
      // Existing layout - replace any legacy `heading` button with
      // the new individual H1-H6 split (saved layouts from before
      // the split would otherwise reference an unknown id).
      this.settings.toolbarLayout = migrateLegacyHeadingButton(
        this.settings.toolbarLayout,
      );
    }
    if (this.settings.tableToolbarLayout === null) {
      this.settings.tableToolbarLayout = migrateFromHiddenList(
        defaultTableLayout(),
        this.settings.tableToolbarHiddenButtons,
      );
    }
    if (this.settings.mobileToolbarLayout) {
      backfillMissingButtons(this.settings.mobileToolbarLayout, mobileLayoutDefault());
    }
    if (this.settings.toolbarLayout) {
      backfillMissingButtons(this.settings.toolbarLayout, defaultMainLayout());
    }
    // Generate a per-install device ID on first load. Used as the
    // stable identifier for trial dedupe + session token binding.
    // crypto.randomUUID is available in Obsidian's Electron context.
    let deviceIdGenerated = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      deviceIdGenerated = true;
    }
    // Persist the cleaned shape if we discarded anything - without
    // this the stale keys would re-appear in data.json on the next
    // save (since saveData writes the whole settings object). The
    // re-save is a no-op if `hadUnknownKeys` is false.
    if (hadUnknownKeys || deviceIdGenerated) await this.saveSettings();
  }

  /** Resolve the user's main toolbar layout - returns the customized
   *  layout if set, otherwise a fresh copy of the default. The toolbar
   *  reader gets a deep clone so direct mutations don't leak into
   *  settings (the settings tab does explicit save + rebuild).
   *
   *  Desktop-specific: `mobileToolbarLayout` is queried separately
   *  via `getMobileToolbarLayout()`. The render path uses the
   *  platform-aware `getActiveToolbarLayout()`, which dispatches
   *  between the two based on `Platform.isMobile`. */
  public getMainToolbarLayout(): ToolbarLayoutItem[] {
    return this.settings.toolbarLayout ?? defaultMainLayout();
  }

  /** Mobile-specific main-toolbar layout - see `getMainToolbarLayout`.
   *  Customizer reads this directly when on the Mobile segment so
   *  the user can prepare their phone layout from desktop. */
  public getMobileToolbarLayout(): ToolbarLayoutItem[] {
    return this.settings.mobileToolbarLayout ?? mobileLayoutDefault();
  }

  /** Platform-aware resolver. Render-path callers (the main
   *  toolbar's `getLayout` callback) use this so the same toolbar
   *  factory works on both desktop and mobile without each
   *  consumer needing to know about the split. */
  public getActiveToolbarLayout(): ToolbarLayoutItem[] {
    if (Platform.isMobile) return this.getMobileToolbarLayout();
    return this.getMainToolbarLayout();
  }

  public getTableToolbarLayout(): ToolbarLayoutItem[] {
    return this.settings.tableToolbarLayout ?? defaultTableLayout();
  }

  public getMobileTableToolbarLayout(): ToolbarLayoutItem[] {
    return (
      this.settings.mobileTableToolbarLayout ?? mobileTableLayoutDefault()
    );
  }

  public getActiveTableToolbarLayout(): ToolbarLayoutItem[] {
    if (Platform.isMobile) return this.getMobileTableToolbarLayout();
    return this.getTableToolbarLayout();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Re-apply on every save so the Debug-tab toggle takes effect
    // without reloading the plugin.
    setVerbose(this.settings.verboseLogging);
  }
}

// Settings tab moved to src/settings-tab.ts.

/**
 * Modal that confirms a vault-wide canonicalization. Shows the
 * affected file count and warns that the operation isn't undoable
 * from inside Butter - recommends a git commit beforehand.
 */
/**
 * In-app error log viewer. Mobile Obsidian has no accessible JS
 * console, so this modal surfaces the recent-errors ring buffer for
 * users who hit a save error on phone or tablet.
 */
