import {
  TextFileView,
  Component,
  setIcon,
  Menu,
  MenuItem,
  Notice,
  Platform,
  WorkspaceLeaf,
  parseYaml,
  stringifyYaml,
  type TFile,
} from "obsidian";
import { EditorState, Plugin as PMPlugin, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";

// Extension registration must happen before schema.ts or obsidian-md-bridge
// evaluate their module bodies. Example extensions are not activated in
// shipped builds.
import { materializeButterEditorExtensions } from "../integration/extensions";
import { schema } from "../core/schema";
import { parser } from "../core/parser";
import { serializer } from "../core/serializer";
import { normalize as normalizeSource } from "../core/normalize";
import { recordError } from "../integration/debug";
import {
  buildKeymap,
  buildInputRules,
  contextMenuPlugin,
  trimDblClickSelectionPlugin,
} from "../editor/editor-ux";
import { autocompletePlugin } from "../editor/autocomplete";
import { createToolbar } from "../ui/toolbar";
import {
  type LayoutItem as ToolbarLayoutItem,
  defaultMainLayout,
  defaultTableLayout,
  editorTopChromeBottom,
  visibleContextToolbarBottom,
  mobileLayoutDefault,
  mobileTableLayoutDefault,
} from "../ui/toolbar-layout";
export type { ToolbarLayoutItem };
import { slashMenuPlugin } from "../ui/slash-menu";
import { pasteDropPlugin } from "../editor/paste-drop";
import { overlapResolverPlugin } from "../core/overlap-resolver";
import { suggestBridgePlugin } from "../util/suggest-bridge";
import { tableEditingPlugins } from "../editor/table-editing";
import { tableToolbarPlugin } from "../editor/table-toolbar";
import type { Node as PMNode } from "prosemirror-model";
import {
  preflightExactSave,
  type SavePreflightResult,
} from "../core/save-preflight";
import { normalizeDocForSave } from "../core/doc-normalize";
import { checkboxPlugin } from "../editor/checkbox-plugin";
import { commentOnlyParagraphPlugin } from "../editor/comment-only-paragraph";
import { listNumberingPlugin } from "../editor/list-numbering";
import { headingFoldPlugin } from "../editor/heading-folding";
import { selectionOverlayPlugin } from "../editor/selection-overlay";
import { multiBlockSelectPlugin } from "../editor/multi-block-select";
import {
  listOperationsPlugin,
  toggleTaskOnCurrentLine,
} from "../editor/list-operations";
import { searchPlugin } from "../editor/search-plugin";
import { codeHighlightPlugin } from "../editor/code-highlight";
import { imageView } from "../editor/image-view";
import { PMEditorShim } from "../util/editor-shim";
import {
  type SaveState,
} from "../ui/save-status";
import { dragHandlesPlugin } from "../editor/drag-handles";
import {
  blockIdStamperPlugin,
  ensureBlockIds,
} from "../editor/block-id-stamper";
import { blockAnimatorPlugin } from "../editor/block-animator";
import { clickToSpawnPlugin } from "../editor/click-to-spawn";
import { inlineAtomEditPlugin } from "../editor/inline-atom-edit";
import { autoSplitImagesPlugin } from "../editor/auto-split-images";
import { tableRowColDragPlugin } from "../editor/table-row-col-drag";
import { tableCellDragPlugin } from "../editor/table-cell-drag";
import { normalizeTablesInDoc } from "../editor/table-normalize";
import {
  rawBlockSafetyPlugin,
  RAW_BLOCK_SYNC_META,
} from "../core/raw-block-safety";
import { tx } from "../i18n";
import { SaveScheduler } from "../ui/save-scheduler";
import { suppressNativeMobileToolbar } from "../ui/mobile-native-toolbar";
import {
  capturePropertyClipboardTarget,
  shouldUseNativePropertyContextMenu,
  scrollHost,
  scrollHostTop,
} from "../util/dom-utils";
import {
  BUTTER_VIEWPORT_STATE_KEY,
  elementViewportFraction,
  isButterViewportAnchor,
  restoreElementViewport,
  restoreViewportProgress,
  viewportProbeOffset,
  viewportProgress,
  type ButterViewportAnchor,
} from "../util/view-viewport";
import { mountLicenseBanner, type LicenseBanner } from "../ui/license-banner";
import { stableDefaultNodeViews } from "../editor/stable-default-nodeviews";
import { retainUnchangedBlockIds } from "../editor/runtime-block-identity";
import { selectionThroughRetainedBlocks } from "../editor/runtime-selection";
import {
  NodeViewManager,
  BUTTER_HOVER_SOURCE,
  codeBlockView,
  embedView,
  embedInlineView,
  calloutView,
  mathBlockView,
  inlineMathView,
  wikilinkView,
  tagView,
  blockCommentView,
  inlineFootnoteView,
  footnoteRefView,
  footnoteDefView,
  blockIdView,
  rawBlockView,
} from "../editor/nodeviews";
import { parsePropertyTextWikilinks } from "../ui/property-wikilinks";
import { dismissMenuOnScroll } from "../ui/menu-scroll-dismiss";
import { linkEditorKeyboardPlugin } from "../ui/link-editor";
import { applyPropertyKeySuggest } from "../ui/property-key-suggest";
import { footnotePresentationPlugin } from "../editor/footnote-presentation";

export const VIEW_TYPE_BUTTER = "butter-editor";
export const VIEW_TYPE_BUTTER_LOCKED = "butter-locked-file";
import type ButterEditorPlugin from "../main";
import { cycleView, modeIcon, refreshButterMobileBodyClass, StatusState } from "../main";
import type { ButterSettings } from "../main";

// Each visible inline title labels exactly one editable region. A monotonic
// session-local suffix keeps aria-labelledby exact when the same note is open
// in more than one pane; the IDs are DOM-only and never enter Markdown.
let editorAccessibleLabelSequence = 0;

type SourceLineEnding = "\n" | "\r\n" | "\r";

export interface TemporalPropertyInputSpec {
  inputType: "date" | "datetime-local" | "text";
  value: string;
  compatibility: "native" | "date-only-datetime" | "raw";
}

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day;
}

/**
 * HTML temporal controls silently blank values they cannot represent. Keep
 * every stored value visible: a date-only value assigned the vault-wide
 * datetime type uses a date control, while malformed or otherwise
 * incompatible values use a raw text control.
 */
export function resolveTemporalPropertyInput(
  type: string,
  value: unknown,
): TemporalPropertyInputSpec | null {
  if (type !== "date" && type !== "datetime") return null;
  const raw = value == null
    ? ""
    : typeof value === "string" || typeof value === "number" ||
        typeof value === "boolean"
      ? String(value)
      : "";
  if (raw === "") {
    return {
      inputType: type === "datetime" ? "datetime-local" : "date",
      value: "",
      compatibility: "native",
    };
  }
  if (isValidCalendarDate(raw)) {
    return {
      inputType: "date",
      value: raw,
      compatibility: type === "datetime" ? "date-only-datetime" : "native",
    };
  }
  const datetime = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(raw);
  if (type === "datetime" && datetime &&
      isValidCalendarDate(datetime[1]) &&
      Number(datetime[2]) <= 23 &&
      Number(datetime[3]) <= 59 &&
      (datetime[4] == null || Number(datetime[4]) <= 59)) {
    return {
      inputType: "datetime-local",
      value: raw.slice(0, 16),
      compatibility: "native",
    };
  }
  return { inputType: "text", value: raw, compatibility: "raw" };
}

function normalizeSourceLineEndings(value: string): string {
  return value.replace(/\r\n?|\n/g, "\n");
}

function detectSourceLineEnding(value: string): SourceLineEnding {
  // Keep the established CRLF preference for mixed files, then recognize the
  // CommonMark-valid bare-CR form before falling back to LF.
  if (value.includes("\r\n")) return "\r\n";
  if (value.includes("\r")) return "\r";
  return "\n";
}

const FRONTMATTER_SOURCE_RE =
  /^---(?:\r\n?|\n)([\s\S]*?)(?:\r\n?|\n)---(?:\r\n?|\n)*/;

export class ButterEditorView extends TextFileView {
  private pmView: EditorView | null = null;
  private nodeViewManager: NodeViewManager | null = null;
  private propertiesEl: HTMLElement | null = null;
  private propertiesRenderDeferred = false;
  private inlineTitleEl: HTMLElement | null = null;
  private headerTitleRenameEl: HTMLElement | null = null;
  private toolbarDom: HTMLElement | null = null;
  /** Re-renders the main toolbar from the current layout settings.
   *  Invoked from the settings tab after a customizer edit. */
  private rebuildMainToolbar: (() => void) | null = null;
  private frontmatter: string = "";
  /** Line-ending style of the file as it was on disk. Preserved so
   *  LF, CRLF (typical on Windows-authored / git-autocrlf vaults), and
   *  CommonMark-valid bare CR are saved back in their original style. */
  private lineEnding: SourceLineEnding = "\n";
  /** Count of trailing newlines in the original file body (after
   *  frontmatter). Preserved verbatim on save so a file with 0, 1,
   *  2, or N trailing newlines round-trips exactly. */
  private originalTrailingNewlines: number = 1;
  /** Whether the original file began with a UTF-8 BOM. Preserved
   *  on save so files that Obsidian-foreign tooling produced with
   *  a BOM keep their BOM. */
  private originalHasBOM: boolean = false;
  /** Source-preservation state. Captured at load time. On save, for
   *  each top-level block in the current PM doc we check whether it
   *  still equals the corresponding original block - if so, we emit
   *  the original markdown bytes for that block verbatim instead of
   *  re-serializing in Butter's canonical style. This is what gives
   *  us effective parity with Obsidian Live Preview's "the source is
   *  the source" behavior: untouched blocks in a file keep their
   *  hand-formatted table alignment, tight-style spacing, exact
   *  whitespace, etc. Only blocks the user actually edited come out
   *  in Butter canonical form. */
  private originalBody: string = "";
  private originalDoc: PMNode | null = null;
  private preserveSource = false;
  private suppressChange = false;
  private destroyed = false;
  /** Mobile keyboard-down lock. When false, PM's `editable` prop
   *  returns false so the contenteditable is non-editable - Android's
   *  native long-press text-selection has no editable host to latch
   *  onto. Flipped to true on focus intent (tap when blurred) and
   *  back to false on `keyboardWillHide`. Always true on desktop. */
  private mobileEditable = true;
  /** True while an explicit Hide-keyboard request is settling on iOS. */
  private mobileKeyboardDismissalActive = false;
  private mobileKeyboardDismissalTimer = 0;
  /** Set by `installMobileToolbarBehavior` to a callback that
   *  re-applies the editable state to PM. Drag-handles' tap-to-
   *  focus path calls this to flip the lock open. */
  public mobileSetEditable: ((editable: boolean) => void) | null = null;

  /** Explicit edit intent (editor tap/insert return) ends a prior dismissal. */
  public requestMobileEditing(): void {
    this.clearMobileKeyboardDismissal();
    this.mobileSetEditable?.(true);
  }

  /** Lock and blur before WebKit can restore ProseMirror selection focus. */
  public dismissMobileKeyboard(): void {
    if (!Platform.isMobile) return;
    this.mobileKeyboardDismissalActive = true;
    window.clearTimeout(this.mobileKeyboardDismissalTimer);
    this.mobileKeyboardDismissalTimer = window.setTimeout(
      () => this.clearMobileKeyboardDismissal(),
      1500,
    );
    this.mobileSetEditable?.(false);
    suppressNativeMobileToolbar();
    this.pmView?.dom.blur();
    const active = activeDocument.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }

  private clearMobileKeyboardDismissal(): void {
    this.mobileKeyboardDismissalActive = false;
    window.clearTimeout(this.mobileKeyboardDismissalTimer);
    this.mobileKeyboardDismissalTimer = 0;
  }
  /** If setEphemeralState fires before PM finishes mounting (common
   *  on view-type swaps), we stash the state and replay it right
   *  after the PM view is live. */
  private pendingEphemeralState: unknown = null;
  /** License-required banner mounted at the top of the editor when
   *  status is anything other than valid/trial. Lazily attached on
   *  view open, refreshed by the `butter:license-changed` workspace
   *  event, destroyed on view close. */
  private licenseBanner: LicenseBanner | null = null;
  /** Debouncer that coordinates save-to-disk timing across typing
   *  bursts, continuous editing, blur, tab-hide, and unload. See
   *  src/save-scheduler.ts for the full model. Bound to
   *  {@link requestSave} so any trigger path goes through the
   *  single save entry point. Initialized lazily on first PM
   *  mount because requestSave needs the view to exist. */
  private saveScheduler: SaveScheduler | null = null;
  /** Monotonic local-edit generation. A save only marks the generation it
   * captured as persisted; edits arriving during an async write stay dirty. */
  private editGeneration = 0;
  private persistedGeneration = 0;
  /**
   * Last full-file text this view actually rendered or successfully saved.
   * Obsidian assigns TextFileView.data before calling setViewData(), so the
   * inherited field cannot distinguish an incoming reload from the current
   * rendered value. This mirror is identity detection only; native
   * TextFileView remains the sole persistence/merge owner.
   */
  private acceptedViewData: string | null = null;
  /** Serializes calls into the native TextFileView writer; it never writes. */
  private saveQueue: Promise<void> = Promise.resolve();
  private preparedSave: { doc: PMNode; text: string } | null = null;
  private lastBlockedDoc: PMNode | null = null;
  /** DOM-event handlers we installed for the scheduler's flush
   *  triggers. Tracked so onClose() can tear them down. */
  private schedulerListeners: Array<() => void> = [];
  /** Obsidian-`Editor`-shaped shim over the PM view. Plugins that
   *  read `activeLeaf.view.editor` (e.g., Templater commands,
   *  plugins using `editor.replaceRange` / `editor.getCursor`) will
   *  find a working editor here. */
  public editor: PMEditorShim | null = null;

  /** Accessor for the underlying PM EditorView. Intentionally a
   *  method (not a public field) so external call sites go through
   *  one guarded entry point. Returns null if the view isn't mounted. */
  public pmViewRef(): EditorView | null {
    return this.pmView;
  }

  /** Rebuild only Butter's input-rules plugin when the markdown
   *  shortcut preference changes. Existing editor state, selection,
   *  history, and every other plugin instance stay in place. */
  public applyMarkdownShortcutSetting() {
    if (!this.pmView) return;
    const plugins = this.pmView.state.plugins.map((plugin) =>
      (plugin.spec as { isInputRules?: boolean }).isInputRules
        ? buildInputRules(schema, {
            markdownShortcuts: this.settings.markdownShortcuts,
          })
        : plugin,
    );
    this.suppressChange = true;
    this.pmView.updateState(this.pmView.state.reconfigure({ plugins }));
    this.suppressChange = false;
  }

  /** Apply the experimental "max theme compatibility" mode: toggles
   *  Obsidian's Reading-mode scope classes on the PM element. When
   *  on, theme CSS scoped to any of those classes cascades in.
   *  Both classes are claimed because different themes target
   *  different scopes - `.markdown-rendered` is common, but some
   *  (Things, Minimal variants) target `.markdown-preview-view`
   *  which is the view-container class in Obsidian's own DOM.
   *  Claiming both gives the broadest coverage without requiring
   *  per-theme case-by-case bridges. Called on PM view creation
   *  AND whenever the setting toggles so the classes appear /
   *  disappear without needing a view reload. */
  public applyThemeCompatMode() {
    const el = this.pmView?.dom;
    if (!el) return;
    const compatClasses = ["markdown-rendered", "markdown-preview-view"];
    if (this.settings.experimentalThemeCompatMode) {
      for (const c of compatClasses) el.classList.add(c);
    } else {
      for (const c of compatClasses) el.classList.remove(c);
    }
  }

  /** Apply the toolbar-position preference to this view: update the
   *  data-toolbar-pos attribute on the container (CSS hook) and move
   *  the toolbar DOM node to the appropriate placement. Sticky-bottom
   *  needs the element AFTER the editor; sticky-top wants it before. */
  /** Read the view-content's computed padding values and expose them
   *  as CSS custom properties on the same element. CSS rules that
   *  need to escape the padding box (e.g. the top fade-gradient
   *  pseudo-element) reference these to compute their offsets - we
   *  can't extract individual edges from `--file-margins` (a CSS
   *  shorthand) at runtime, so JS-reads are the cleanest path. */
  public refreshContentPaddingVar() {
    if (!this.contentEl) return;
    const cs = getComputedStyle(this.contentEl);
    this.contentEl.style.setProperty(
      "--butter-content-pad-top",
      cs.paddingTop || "0px",
    );
    this.contentEl.style.setProperty(
      "--butter-content-pad-x",
      cs.paddingLeft || "0px",
    );
  }

  /** Re-render both toolbars from the current layout settings.
   *  Called from the settings tab when the user changes the layout
   *  (reorder, add/remove, create/edit submenu). The table toolbar
   *  dom exposes its own rebuild via `__butterRebuild` (stashed by
   *  `tableToolbarPlugin`); the main toolbar uses the closure stored
   *  on this view at construction time. */
  public applyToolbarButtonVisibility() {
    if (this.rebuildMainToolbar) this.rebuildMainToolbar();
    const parent = this.toolbarDom?.parentElement;
    const tableToolbar = parent?.querySelector(
      ":scope > .butter-table-toolbar",
    ) as HTMLElement | null;
    const rebuild = (tableToolbar as unknown as { __butterRebuild?: () => void } | null)
      ?.__butterRebuild;
    if (rebuild) rebuild();
  }

  /** True when the cursor is on this view's toolbar AND its X
   *  position falls inside (or just left of) the status bar's
   *  X range - i.e. moving any further right would bring it onto
   *  toolbar pixels that are physically behind the status bar.
   *
   *  Why X-only: the obscured pixels can't be reached directly by
   *  the cursor (the status bar is above them in z-order, so
   *  mousemove fires on the status bar, not the toolbar). We have
   *  to trigger the fade BEFORE the cursor crosses the threshold
   *  the `PRELOAD_X` buffer makes that happen 24px early so by the
   *  time the cursor would hit the boundary, the status bar has
   *  already faded out (with `pointer-events: none`) and the cursor
   *  passes through to the toolbar pixels underneath.
   *
   *  Multi-pane: the left pane's toolbar lives in a different X
   *  range than the status bar, so the cursor on it can never be
   *  inside the status-bar X range. Only the pane whose toolbar
   *  shares X with the status bar drives the fade.
   *
   *  Single pane: hovering toolbar buttons in clear airspace
   *  (left of `sbRect.left - 24`) doesn't fade anything. Only
   *  approaching the right side - where the status bar actually
   *  sits - triggers it. */
  public cursorInToolbarStatusBarOverlap(ev: MouseEvent): boolean {
    const dom = this.toolbarDom;
    if (!dom) return false;
    if (dom.getAttribute("data-toolbar-pos") !== "bottom") return false;
    if (dom.getAttribute("data-toolbar-style") !== "attached") return false;
    const statusBar = activeDocument.body.querySelector<HTMLElement>(
      ".status-bar",
    );
    if (!statusBar) return false;
    if (statusBar.offsetParent === null) return false; // hidden by user
    const tbRect = dom.getBoundingClientRect();
    const sbRect = statusBar.getBoundingClientRect();
    if (sbRect.height === 0 || sbRect.width === 0) return false;
    // No vertical overlap - toolbar is well above the status bar
    // (e.g. very tall pane). Nothing to fade.
    if (sbRect.top >= tbRect.bottom) return false;
    // Cursor's X is in the buffered status-bar X range.
    const PRELOAD_X = 24;
    return (
      ev.clientX >= sbRect.left - PRELOAD_X && ev.clientX <= sbRect.right
    );
  }

  /**
   * Mobile-only: wire the keyboard-accessory-bar behavior, mirror-
   * matching how Obsidian's own native mobile toolbar works. Two
   * pieces, both light:
   *
   * 1. **Position** - handled in CSS via `bottom: var(--keyboard-
   *    height, 0px)`. Obsidian itself writes `--keyboard-height`
   *    to `document.documentElement` whenever the soft keyboard
   *    changes height (it owns the Capacitor keyboard listeners
   *    and is the right place to centralize this). By referencing
   *    the same variable, our toolbar tracks the keyboard exactly
   *    as Obsidian's does - across all platforms, hardware
   *    keyboards, mid-session resizes (suggestion bars, emoji
   *    swap, Samsung toolbar expand) - without us reimplementing
   *    any of that.
   *
   * 2. **Visibility** - mirrors Obsidian's `J6.update()` logic:
   *    show when the editor has focus; on Android additionally
   *    require `hasKeyboardVisible` (a flag we flip on
   *    `keyboardWillShow` / `keyboardWillHide`, mirroring
   *    Obsidian's own listener). On iOS the focus-only check is
   *    enough because tapping the editor reliably brings up the
   *    soft keyboard there; on Android the keyboard can be
   *    suppressed by hardware keyboard, voice-input mode, or
   *    multi-window splits, so we wait for the actual signal.
   *
   * Body class `body.butter-mobile-active` is still toggled by
   * `refreshButterMobileBodyClass()` on focus changes - it drives
   * the CSS rule that suppresses Obsidian's own mobile toolbar
   * inside Butter views, so the two don't compete.
   */
  private installMobileToolbarBehavior(
    toolbarDom: HTMLElement,
    editorDom: HTMLElement,
  ): void {
    const VISIBLE_CLASS = "butter-mobile-toolbar-visible";
    const editorDocument = editorDom.ownerDocument;

    const ensureToolbarMounted = (): void => {
      if (this.destroyed) return;
      if (!toolbarDom.isConnected || toolbarDom.parentElement !== editorDocument.body) {
        editorDocument.body.appendChild(toolbarDom);
      }
    };

    // Mirrors Obsidian's `hasKeyboardVisible` flag in `J6` (the
    // native mobile-toolbar class). Flipped to true on
    // keyboardWillShow, false on keyboardWillHide - except when
    // `e.hasPhysicalKeyboard` is set (hardware keyboard:
    // Obsidian's native toolbar stays visible in that case, so we
    // do too by leaving the flag at its prior state).
    let hasKeyboardVisible = false;

    const focusIsInEditorOrToolbar = (): boolean => {
      const active = editorDocument.activeElement;
      if (!(active instanceof Element)) return false;
      // Toolbar-button taps briefly steal focus from the editor;
      // treat focus-on-toolbar as "still editing" so the bar
      // doesn't self-hide on tap.
      return editorDom.contains(active) || toolbarDom.contains(active);
    };

    const updateState = () => {
      ensureToolbarMounted();
      const focused = focusIsInEditorOrToolbar();
      const isAndroid = Boolean(
        (Platform as { isAndroidApp?: boolean }).isAndroidApp,
      );
      const isIos = Boolean((Platform as { isIosApp?: boolean }).isIosApp);
      // WebKit can retain an editable selection and visible keyboard while
      // reporting body (or another transient node) as activeElement. On iOS,
      // accept either real editor focus or the native keyboard-visible signal.
      // Android still requires the native signal in addition to focus.
      const shouldShow =
        (focused || (isIos && hasKeyboardVisible)) &&
        (!isAndroid || hasKeyboardVisible);
      toolbarDom.classList.toggle(VISIBLE_CLASS, shouldShow);
      refreshButterMobileBodyClass();
      if (shouldShow) editorDocument.body.classList.add("butter-mobile-active");
    };

    let pendingRaf = 0;
    const schedule = () => {
      if (pendingRaf !== 0) return;
      pendingRaf = window.requestAnimationFrame(() => {
        pendingRaf = 0;
        updateState();
      });
    };

    // Capacitor keyboard events - used ONLY for the
    // hasKeyboardVisible flag (Android visibility gate). Position
    // tracking is the responsibility of CSS via `--keyboard-
    // height`, which Obsidian writes for us. Match Obsidian's
    // native behavior of NOT clearing the flag when a hardware
    // keyboard hides (`e.hasPhysicalKeyboard`).
    this.registerDomEvent(
      window as unknown as HTMLElement,
      "keyboardWillShow" as keyof HTMLElementEventMap,
      () => {
        if (this.mobileKeyboardDismissalActive) {
          hasKeyboardVisible = false;
          setEditable(false);
          this.pmView?.dom.blur();
          const active = activeDocument.activeElement;
          if (active instanceof HTMLElement) active.blur();
          suppressNativeMobileToolbar();
          schedule();
          return;
        }
        hasKeyboardVisible = true;
        setEditable(true);
        schedule();
      },
    );
    // Re-apply PM's `editable` prop. Setting `editable` directly on
    // the EditorView via `setProps` triggers PM's own update pipeline,
    // which sets the `contenteditable` attribute through the same path
    // it uses on construction - so PM doesn't fight us. Manual
    // `editorDom.contentEditable = "false"` gets reverted on the next
    // PM update; this doesn't.
    const setEditable = (editable: boolean) => {
      if (this.mobileEditable === editable) return;
      this.mobileEditable = editable;
      if (this.pmView) {
        this.pmView.setProps({ editable: () => this.isEditable() });
      }
    };
    this.mobileSetEditable = setEditable;
    // Start locked when mobile (assume kb-down at view-open). The
    // first tap will flip it open (see drag-handles' mobile pointerup).
    setEditable(false);

    this.registerDomEvent(
      window as unknown as HTMLElement,
      "keyboardWillHide" as keyof HTMLElementEventMap,
      (ev: Event) => {
        const anyEv = ev as unknown as { hasPhysicalKeyboard?: boolean };
        if (
          !anyEv.hasPhysicalKeyboard &&
          (focusIsInEditorOrToolbar() ||
            toolbarDom.classList.contains(VISIBLE_CLASS) ||
            activeDocument.body.classList.contains("butter-mobile-drawer-open"))
        ) {
          suppressNativeMobileToolbar();
        }
        if (!anyEv.hasPhysicalKeyboard) hasKeyboardVisible = false;
        // Skip the post-keyboard cleanup when the insert drawer
        // dismissed the keyboard. The drawer blurs the editor on
        // open so its 2-col picker can occupy the keyboard's space;
        // when the user taps a tile we re-focus the editor to bring
        // the keyboard back. Without this guard, `setEditable(false)`
        // here would lock the editor non-editable, the focus call
        // wouldn't fire `keyboardWillShow`, and the user would have
        // to tap a second time to start typing.
        const drawerOpen = activeDocument.body.classList.contains(
          "butter-mobile-drawer-open",
        );
        // Blur the editor so we exit "typing" state - keeps the
        // long-press-to-drag gate consistent (gate proxies on focus)
        // and avoids stranded contenteditable focus when the user
        // dismissed the keyboard intentionally.
        if (
          !anyEv.hasPhysicalKeyboard &&
          !drawerOpen &&
          editorDom.contains(activeDocument.activeElement)
        ) {
          (activeDocument.activeElement as HTMLElement).blur();
        }
        // Lock the editor non-editable so Android's native long-
        // press text-selection has no editable host to grab. Restored
        // on tap (see drag-handles' mobile pointerup).
        if (!anyEv.hasPhysicalKeyboard && !drawerOpen) setEditable(false);
        schedule();
      },
    );

    this.registerDomEvent(
      window as unknown as HTMLElement,
      "keyboardDidHide" as keyof HTMLElementEventMap,
      () => this.clearMobileKeyboardDismissal(),
    );


    this.registerDomEvent(editorDom, "focusin", schedule);
    this.registerDomEvent(editorDom, "focusout", () => {
      suppressNativeMobileToolbar();
      schedule();
    });
    this.registerDomEvent(toolbarDom, "focusin", schedule);
    this.registerDomEvent(toolbarDom, "focusout", () => {
      suppressNativeMobileToolbar();
      schedule();
    });
    this.registerDomEvent(window, "focusin", schedule);
    this.registerDomEvent(window, "focusout", schedule);

    updateState();

  }

  public refreshLocalization(): void {
    this.applyToolbarButtonVisibility();
    this.renderProperties();
    this.licenseBanner?.refresh();
  }

  /** Obsidian renders the normal header title for custom FileViews, but its
   * Markdown-only click handler does not make that title editable. Bridge the
   * existing native element rather than creating replacement header chrome. */
  private installHeaderTitleRenameBridge(): void {
    if (Platform.isMobile) return;
    const title = this.containerEl.querySelector<HTMLElement>(
      ".view-header-title",
    );
    if (!title || title === this.headerTitleRenameEl) return;
    this.headerTitleRenameEl = title;

    let editing = false;
    let cancelled = false;
    let originalName = "";
    let breadcrumbWidth = 0;
    let animationVersion = 0;
    const breadcrumb = title.parentElement?.querySelector<HTMLElement>(
      ":scope > .view-header-title-parent",
    ) ?? null;

    const collapseBreadcrumb = (): void => {
      if (!breadcrumb) return;
      animationVersion += 1;
      breadcrumbWidth = breadcrumb.getBoundingClientRect().width;
      breadcrumb.setCssProps({
        "--butter-header-breadcrumb-width": `${breadcrumbWidth}px`,
      });
      breadcrumb.classList.add("butter-header-breadcrumb-animated");
      void breadcrumb.offsetWidth;
      breadcrumb.classList.add("is-collapsed");
    };

    const restoreBreadcrumb = (): void => {
      if (!breadcrumb) return;
      const version = ++animationVersion;
      breadcrumb.classList.remove("is-collapsed");
      window.setTimeout(() => {
        if (editing || version !== animationVersion || !breadcrumb.isConnected) {
          return;
        }
        breadcrumb.classList.remove("butter-header-breadcrumb-animated");
        breadcrumb.style.removeProperty("--butter-header-breadcrumb-width");
      }, 160);
    };

    const finishEditing = (): void => {
      title.removeAttribute("contenteditable");
      title.removeAttribute("tabindex");
      title.removeAttribute("spellcheck");
      restoreBreadcrumb();
    };

    this.registerDomEvent(title, "mousedown", () => {
      if (editing || !this.file) return;
      editing = true;
      cancelled = false;
      originalName = this.file.basename;
      // This must happen during mousedown, before Chromium's focus/caret
      // default action. Setting it on click is one event phase too late.
      title.contentEditable = "true";
      title.tabIndex = -1;
      title.spellcheck =
        (this.app.vault.getConfig?.("spellcheck") as boolean | undefined) ?? true;
      collapseBreadcrumb();
    });

    this.registerDomEvent(title, "keydown", (event) => {
      if (!editing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        title.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelled = true;
        title.textContent = originalName;
        title.blur();
      }
    });

    this.registerDomEvent(title, "blur", () => {
      if (!editing) return;
      editing = false;
      finishEditing();
      const nextName = title.textContent?.trim() ?? "";
      if (cancelled || !nextName || nextName === originalName || !this.file) {
        title.textContent = originalName;
        return;
      }

      const file = this.file;
      const parentPath = file.parent?.path;
      const prefix = parentPath && parentPath !== "/" ? `${parentPath}/` : "";
      void this.app.fileManager
        .renameFile(file, `${prefix}${nextName}.${file.extension}`)
        .catch((error: unknown) => {
          if (title.isConnected) title.textContent = originalName;
          recordError(
            "header-title-rename",
            String((error as Error)?.message ?? error),
          );
          new Notice(tx("Rename failed"));
        });
    });
  }

  public applyToolbarPosition() {
    if (Platform.isMobile) return; // mobile keeps body-attached behavior
    const leaf = this.containerEl; // .workspace-leaf-content (header + content)
    const content = this.contentEl; // .view-content
    if (!leaf || !content || !this.toolbarDom) return;

    const bannerActive = !(this.plugin.licenseStatus === "valid" || this.plugin.licenseStatus === "trial");
    const style = bannerActive ? "attached" : this.settings.toolbarStyle;
    const pos = bannerActive || style === "integrated"
      ? "top"
      : this.settings.toolbarPosition;
    this.toolbarDom.setAttribute("data-toolbar-style", style);
    this.toolbarDom.setAttribute("data-toolbar-pos", pos);
    content.setAttribute("data-toolbar-pos", pos);
    content.setAttribute("data-toolbar-style", style);
    // Also tag the leaf (containerEl, which has .butter-view-root)
    // so CSS rules on .view-header / leaf-bottom pseudo can branch
    // on toolbar style + position. Both attributes are needed for
    // the fade-height rules to size correctly per toolbar side.
    leaf.setAttribute("data-toolbar-style", style);
    leaf.setAttribute("data-toolbar-pos", pos);
    leaf.setAttribute(
      "data-filename-pill",
      String(this.settings.showFilenamePill),
    );

    // Tear down integrated state from a previous style switch before
    // re-applying anything else.
    const viewHeader = leaf.querySelector<HTMLElement>(".view-header");
    if (viewHeader && style !== "integrated") {
      viewHeader.classList.remove("butter-integrated-header");
    }

    // The .butter-toolbar-stack wrapper is the shared parent that
    // holds both the main and table toolbars. It serves two purposes:
    //   • Detached: the stack is a sticky parent inside view-content
    //     so both toolbars scroll together as one card.
    //   • Attached: the stack is a relatively-positioned flow child
    //     inside the leaf that gives the table toolbar a positioned
    //     anchor - the table toolbar absolute-positions over content
    //     instead of pushing it down when it appears.
    // Integrated has no stack (toolbar lives directly in view-header).
    // On every re-apply, prune any stack from a parent that doesn't
    // match the current style so a leftover wrapper from a prior
    // mode doesn't strand the toolbars.
    const stackInLeaf = leaf.querySelector(
      ":scope > .butter-toolbar-stack",
    );
    const stackInContent = content.querySelector(
      ":scope > .butter-toolbar-stack",
    );
    if (style === "integrated") {
      if (stackInLeaf) stackInLeaf.remove();
      if (stackInContent) stackInContent.remove();
    } else if (style === "attached") {
      if (stackInContent) stackInContent.remove();
    } else if (style === "detached") {
      if (stackInLeaf) stackInLeaf.remove();
    }

    // Integrated: mount the toolbar INSIDE the view-header itself,
    // between the title-container and view-actions. The view-header
    // becomes a single chrome row containing nav buttons, title pill,
    // toolbar (centered), and view-actions. Position setting (top/
    // bottom) is irrelevant in this style - the view-header is
    // always at the top of the leaf.
    if (style === "integrated") {
      if (!viewHeader) return; // safety: bail if Obsidian DOM shape changed
      viewHeader.classList.add("butter-integrated-header");
      const viewActions = viewHeader.querySelector(".view-actions");
      if (this.toolbarDom.parentElement !== viewHeader) {
        if (viewActions) {
          viewHeader.insertBefore(this.toolbarDom, viewActions);
        } else {
          viewHeader.appendChild(this.toolbarDom);
        }
      }
      return;
    }

    // Detached mounts INSIDE view-content for sticky positioning to
    // work - the scrolling parent has to be the same element the
    // toolbar is sticky against.
    //
    // We wrap both toolbars (main + table) in a `.butter-toolbar-stack`
    // element. The stack is the sticky parent; the toolbars themselves
    // become normal flow children. This keeps the table toolbar glued
    // to the main toolbar during scroll instead of letting it scroll
    // away while the main stays pinned. The table-toolbar plugin docks
    // adjacent to the main toolbar in main.parentElement, so it lands
    // inside the stack automatically.
    if (style === "detached") {
      const editorRoot = content.querySelector(
        ".butter-editor-root",
      );
      if (!editorRoot) return;

      let stack = content.querySelector(
        ":scope > .butter-toolbar-stack",
      );
      if (!stack) {
        stack = activeWindow.createDiv();
        stack.className = "butter-toolbar-stack";
        content.insertBefore(stack, editorRoot);
      }
      stack.setAttribute("data-toolbar-style", style);
      stack.setAttribute("data-toolbar-pos", pos);

      // Position the stack at the correct end of the content.
      if (pos === "bottom") {
        if (stack.nextElementSibling !== null) {
          content.appendChild(stack);
        }
      } else {
        if (stack.nextElementSibling !== editorRoot) {
          content.insertBefore(stack, editorRoot);
        }
      }

      // Mount main toolbar inside the stack. Skip the move when
      // already inside the stack so we don't disturb the table
      // toolbar's sibling order on idempotent re-applies.
      if (this.toolbarDom.parentElement !== stack) {
        stack.appendChild(this.toolbarDom);
      }
      return;
    }

    // Attached: stack wrapper hosts main + table toolbars in the leaf
    // chrome row. Stack is `position: relative` so the table toolbar
    // can `position: absolute` over content without pushing it down
    // when it appears.
    let stack = leaf.querySelector(
      ":scope > .butter-toolbar-stack",
    );
    if (!stack) {
      stack = activeWindow.createDiv();
      stack.className = "butter-toolbar-stack";
      leaf.insertBefore(stack, content);
    }
    stack.setAttribute("data-toolbar-style", style);
    stack.setAttribute("data-toolbar-pos", pos);

    if (pos === "bottom") {
      if (stack.parentElement !== leaf || stack.previousElementSibling !== content) {
        leaf.insertBefore(stack, content.nextSibling);
      }
    } else {
      if (stack.parentElement !== leaf || stack.nextElementSibling !== content) {
        leaf.insertBefore(stack, content);
      }
    }

    if (this.toolbarDom.parentElement !== stack) {
      stack.appendChild(this.toolbarDom);
    }
    // Re-anchor the license banner into the (possibly new) stack so
    // it stays glued to the toolbar across style + position changes.
    this.licenseBanner?.refresh();
  }

  /**
   * Source-markdown line number of the heading currently at the top
   * of the editor viewport. Used both for outline tracking and for
   * preserving the user's sense of place across a view-type swap.
   *
   * Viewport-based (not caret-based), because "where you are in a
   * long doc" is a property of what you're reading, not where your
   * cursor happened to be parked.
   */
  public visibleHeadingLine(): number {
    if (!this.pmView) return 0;
    const doc = this.pmView.state.doc;
    const threshold = scrollHostTop(this.pmView.dom) + 40;

    const fmLines = this.frontmatter
      ? Math.max(0, this.frontmatter.split("\n").length - 1)
      : 0;

    let bestTop = -Infinity;
    let bestLine = 0;
    let line = fmLines;
    doc.forEach((child, offset) => {
      if (child.type.name === "heading") {
        const dom = this.pmView!.nodeDOM(offset) as HTMLElement | null;
        if (dom) {
          const top = dom.getBoundingClientRect().top;
          if (top <= threshold && top > bestTop) {
            bestTop = top;
            bestLine = line;
          }
        }
      }
      const text = child.textContent;
      const nlines = text ? text.split("\n").length : 1;
      line += nlines + 1;
    });
    return bestLine;
  }

  /** Capture the rendered content under a stable point near the viewport top.
   * Source line + within-block fraction transfer cleanly between Butter and
   * Obsidian renderers even when their total document heights differ. */
  public captureViewportAnchor(): ButterViewportAnchor | null {
    if (!this.pmView) return null;
    const host = scrollHost(this.pmView.dom);
    if (!host) return null;
    const hostRect = host.getBoundingClientRect();
    const probeOffset = viewportProbeOffset(host);
    const probeY = hostRect.top + probeOffset;
    let candidate: {
      element: HTMLElement;
      node: PMNode;
      pos: number;
      start: number;
      end: number;
      distance: number;
      height: number;
    } | null = null;

    this.pmView.state.doc.descendants((node, pos) => {
      if (!node.isBlock) return true;
      const range = node.attrs.sourceRange as
        | { start?: unknown; end?: unknown }
        | null;
      if (
        !range ||
        typeof range.start !== "number" ||
        typeof range.end !== "number" ||
        range.start < 0 ||
        range.end < range.start
      ) return true;
      const dom = this.pmView?.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return true;
      const rect = dom.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom < hostRect.top || rect.top > hostRect.bottom) {
        return true;
      }
      const distance = probeY < rect.top
        ? rect.top - probeY
        : probeY > rect.bottom
          ? probeY - rect.bottom
          : 0;
      if (
        !candidate ||
        distance < candidate.distance ||
        (distance === candidate.distance && rect.height < candidate.height)
      ) {
        candidate = {
          element: dom,
          node,
          pos,
          start: range.start,
          end: range.end,
          distance,
          height: rect.height,
        };
      }
      return true;
    });

    const viewportCandidate = candidate as {
      element: HTMLElement;
      node: PMNode;
      pos: number;
      start: number;
      end: number;
      distance: number;
      height: number;
    } | null;
    if (!viewportCandidate) {
      return {
        version: 1,
        line: this.visibleHeadingLine(),
        fraction: 0,
        probeOffset,
        progress: viewportProgress(host),
      };
    }

    const fraction = elementViewportFraction(host, viewportCandidate.element, probeOffset);
    const frontmatterLines = this.frontmatter
      ? Math.max(0, this.frontmatter.split("\n").length - 1)
      : 0;
    const lineAtOffset = (offset: number): number => {
      const clamped = Math.max(0, Math.min(this.originalBody.length, offset));
      return frontmatterLines + (this.originalBody.slice(0, clamped).match(/\n/g)?.length ?? 0);
    };
    let bodySourceOffset = Math.round(
      viewportCandidate.start +
        (viewportCandidate.end - viewportCandidate.start) * fraction,
    );
    if (viewportCandidate.node.isTextblock && viewportCandidate.node.content.size > 0) {
      const rect = viewportCandidate.element.getBoundingClientRect();
      const point = this.pmView.posAtCoords({
        left: Math.max(rect.left + 1, this.pmView.dom.getBoundingClientRect().left + 1),
        top: probeY,
      });
      if (point) {
        const contentStart = viewportCandidate.pos + 1;
        const relative = Math.max(
          0,
          Math.min(viewportCandidate.node.content.size, point.pos - contentStart),
        );
        bodySourceOffset = Math.round(
          viewportCandidate.start +
            (viewportCandidate.end - viewportCandidate.start) *
              (relative / viewportCandidate.node.content.size),
        );
      }
    }
    const line = lineAtOffset(bodySourceOffset);
    return {
      version: 1,
      sourceOffset: this.frontmatter.length + bodySourceOffset,
      line,
      fraction,
      probeOffset,
      progress: viewportProgress(host),
    };
  }

  /** Restore a logical viewport anchor without moving the caret or focus. */
  public restoreViewportAnchor(anchor: ButterViewportAnchor): boolean {
    if (!this.pmView) return false;
    const host = scrollHost(this.pmView.dom);
    if (!host) return false;
    const frontmatterLines = this.frontmatter
      ? Math.max(0, this.frontmatter.split("\n").length - 1)
      : 0;
    let sourceOffset = anchor.sourceOffset == null
      ? 0
      : Math.max(0, anchor.sourceOffset - this.frontmatter.length);
    if (anchor.sourceOffset == null) {
      const bodyLine = Math.max(0, Math.floor(anchor.line) - frontmatterLines);
      for (let line = 0; line < bodyLine; line++) {
        const next = this.originalBody.indexOf("\n", sourceOffset);
        if (next < 0) {
          sourceOffset = this.originalBody.length;
          break;
        }
        sourceOffset = next + 1;
      }
    }

    let exact: {
      element: HTMLElement;
      node: PMNode;
      pos: number;
      start: number;
      end: number;
      span: number;
    } | null = null;
    let nearest: { element: HTMLElement; distance: number; span: number } | null = null;
    this.pmView.state.doc.descendants((node, pos) => {
      if (!node.isBlock) return true;
      const range = node.attrs.sourceRange as
        | { start?: unknown; end?: unknown }
        | null;
      if (
        !range ||
        typeof range.start !== "number" ||
        typeof range.end !== "number"
      ) return true;
      const dom = this.pmView?.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return true;
      const rect = dom.getBoundingClientRect();
      if (rect.height <= 0) return true;
      const span = Math.max(0, range.end - range.start);
      if (range.start <= sourceOffset && sourceOffset <= range.end) {
        if (!exact || span < exact.span) {
          exact = {
            element: dom,
            node,
            pos,
            start: range.start,
            end: range.end,
            span,
          };
        }
      } else {
        const distance = sourceOffset < range.start
          ? range.start - sourceOffset
          : sourceOffset - range.end;
        if (
          !nearest ||
          distance < nearest.distance ||
          (distance === nearest.distance && span < nearest.span)
        ) nearest = { element: dom, distance, span };
      }
      return true;
    });

    const exactTarget = exact as {
      element: HTMLElement;
      node: PMNode;
      pos: number;
      start: number;
      end: number;
      span: number;
    } | null;
    const nearestTarget = nearest as {
      element: HTMLElement;
      distance: number;
      span: number;
    } | null;
    if (
      anchor.sourceOffset != null &&
      exactTarget?.node.isTextblock &&
      exactTarget.node.content.size > 0 &&
      exactTarget.span > 0
    ) {
      const ratio = Math.max(
        0,
        Math.min(1, (sourceOffset - exactTarget.start) / exactTarget.span),
      );
      const pmPos = exactTarget.pos + 1 + Math.round(
        exactTarget.node.content.size * ratio,
      );
      const coords = this.pmView.coordsAtPos(pmPos);
      const max = Math.max(0, host.scrollHeight - host.clientHeight);
      host.scrollTop = Math.max(
        0,
        Math.min(
          max,
          host.scrollTop + coords.top - host.getBoundingClientRect().top - anchor.probeOffset,
        ),
      );
    } else {
      const target = exactTarget?.element ?? nearestTarget?.element;
      if (target) restoreElementViewport(host, target, anchor);
      else restoreViewportProgress(host, anchor.progress);
    }
    return true;
  }


  constructor(
    leaf: WorkspaceLeaf,
    private settings: ButterSettings,
    private plugin: ButterEditorPlugin,
    private reportSaveResult?: (result: SaveState) => void,
  ) {
    super(leaf);
  }

  /** True when the editor should accept user input. Read on every PM
   *  transaction dispatch (PM's `editable` prop is a callback) so a
   *  status flip mid-session takes effect without re-mounting. Two
   *  inputs:
   *    - `mobileEditable` - existing mobile keyboard-down lock
   *    - `plugin.licenseStatus` - read-only when no license is active
   *  License-required mode preserves the visual editor (cursor, scroll,
   *  selection still work) but blocks edits, matching the user-chosen
   *  "gentle gate" UX. */
  isEditable(): boolean {
    if (!this.mobileEditable) return false;
    const s = this.plugin.licenseStatus;
    return s === "valid" || s === "trial";
  }

  getViewType(): string {
    return VIEW_TYPE_BUTTER;
  }

  // Act like we are in source/Live Preview mode so widgets allow editing
  getMode(): string {
    return "source";
  }

  toggleMode(): void {
    cycleView(this.leaf, this.settings.viewCycleModes);
  }

  get currentMode(): unknown {
    return { type: "source" };
  }

  toggleMarkdownFormatting(format?: unknown, ...rest: unknown[]): void {
    this.editor?.toggleMarkdownFormatting(format, ...rest);
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Butter Editor";
  }

  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    if (this.inlineTitleEl) this.inlineTitleEl.textContent = file.basename;
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    const headerTitle = this.containerEl.querySelector<HTMLElement>(
      ".view-header-title",
    );
    if (headerTitle) headerTitle.textContent = file.basename;
    // Defensively rebind if an Obsidian version replaces the header title
    // element while refreshing the leaf chrome.
    this.installHeaderTitleRenameBridge();
  }

  // No tab icon. TextFileView's default `getIcon()` returns "document"
  // so a Butter tab would otherwise show that. Returning an empty
  // string tells Obsidian's tab UI to render no icon, giving the tab
  // a clean text-only label that matches what's wanted here.
  getIcon(): string {
    return "";
  }

  onPaneMenu(
    menu: Menu,
    source: string,
  ): void {
    super.onPaneMenu(menu, source);
    const nativeCommand = this.app.commands?.commands?.[
      "markdown:add-metadata-property"
    ] as { name?: unknown } | undefined;
    const title = typeof nativeCommand?.name === "string"
      ? nativeCommand.name
      : tx("Add property");
    menu.addItem((item) => {
      item
        .setTitle(title)
        .setIcon("lucide-plus-circle")
        .setDisabled(!this.canAddFileProperty())
        .onClick(() => this.beginAddFileProperty());
      item.setSection?.("action");
    });
  }

  // ── Frontmatter ──

  private stripFrontmatter(data: string): string {
    // Capture byte-level file metadata for round-trip preservation.
    //   - BOM: rare but legitimate (some foreign tooling produces it);
    //     preserve rather than silently strip.
    //   - Line endings: LF, CRLF, or bare CR. Recaptured on save per-file.
    //   - Trailing newlines: 0, 1, 2+ - preserve verbatim.
    this.originalHasBOM = data.charCodeAt(0) === 0xfeff;
    if (this.originalHasBOM) data = data.slice(1);
    this.lineEnding = detectSourceLineEnding(data);

    // Eat ALL trailing newlines after the closing `---`, not just
    // one. Many vaults store a blank line between frontmatter and
    // the first heading. If we capture only one newline, the blank
    // line gets parsed as part of the body, serialized away, and
    // the reassembled save is missing it - which looks like a
    // whole-file diff in git / Obsidian Sync on every save. By
    // folding the separator newlines into the preserved frontmatter
    // string, they're re-emitted byte-identically on save.
    let body: string;
    const match = data.match(FRONTMATTER_SOURCE_RE);
    if (match) {
      this.frontmatter = match[0];
      body = data.slice(match[0].length);
    } else {
      this.frontmatter = "";
      body = data;
    }

    // Count trailing newlines in the body (normalized LF). Used on
    // save to emit exactly the same trailing-byte state.
    const bodyNormalized = normalizeSourceLineEndings(body);
    const m = bodyNormalized.match(/\n*$/);
    this.originalTrailingNewlines = m ? m[0].length : 0;

    return body;
  }

  /** Apply a property mutation to Butter's owned file projection. */
  private mutateFrontmatterSource(
    mutator: (frontmatter: Record<string, unknown>) => void,
  ): void {
    const normalized = normalizeSourceLineEndings(this.frontmatter);
    const match = normalized.match(/^---\n([\s\S]*?)\n---(\n*)$/);
    if (!match) {
      const frontmatter: Record<string, unknown> = {};
      mutator(frontmatter);
      if (Object.keys(frontmatter).length === 0) return;
      const yaml = normalizeSourceLineEndings(stringifyYaml(frontmatter))
        .replace(/\n*$/, "");
      this.frontmatter = `---\n${yaml}\n---\n`;
      this.editGeneration += 1;
      return;
    }

    const parsed: unknown = parseYaml(match[1]);
    const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    mutator(frontmatter);

    const yaml = normalizeSourceLineEndings(stringifyYaml(frontmatter))
      .replace(/\n*$/, "");
    this.frontmatter = `---\n${yaml}\n---${match[2]}`;
    this.editGeneration += 1;
  }

  /**
   * Capture source-preservation state after a successful parse.
   *
   * Source ranges live on the PM nodes themselves (the `sourceRange`
   * attribute, populated by the bridge during the parse walk). We
   * also keep a reference to the parsed doc so the serializer can
   * reference-compare the live doc's nodes against the originals
   * ProseMirror's immutable-tree model means a node's JS reference
   * survives if-and-only-if no step has mutated it. That's the
   * cleanest "this node is still original" signal available.
   *
   * Structural edits (insert, delete, reorder) don't break
   * preservation: each surviving node carries its own range and
   * identity, and the serializer walks the current order.
   */
  private captureSourceState(
    body: string,
    doc: PMNode | null,
  ) {
    this.originalBody = body;
    this.originalDoc = doc;
    this.preserveSource = doc !== null;
  }

  /**
   * True if `doc` contains any top-level `raw_block` child. Used by
   * the save-path guard to detect the "parse failed, source is in a
   * raw_block" state and protect it from being serialized out of
   * existence.
   */
  private hasRawBlock(doc: PMNode): boolean {
    for (let i = 0; i < doc.childCount; i++) {
      if (doc.child(i).type.name === "raw_block") return true;
    }
    return false;
  }

  // ── Properties (unchanged from original) ──

  private propertiesComponent: Component | null = null;
  private pendingPropertyKeyFocus: { filePath: string; key: string } | null = null;
  private pendingPropertyValueFocus: { filePath: string; key: string } | null = null;
  private pendingPropertyDraft = false;

  private propertiesAreVisible(): boolean {
    if (!this.file) return false;
    const visibility = this.plugin.settings.frontmatterVisibility;
    return visibility !== "hidden" &&
      !(visibility === "match" &&
        this.app.vault.getConfig?.("propertiesInDocument") === "hidden");
  }

  canAddFileProperty(): boolean {
    return !this.destroyed && this.propertiesAreVisible() && this.isEditable();
  }

  beginAddFileProperty(): void {
    if (!this.canAddFileProperty() || !this.file) return;
    this.pendingPropertyDraft = true;
    this.pendingPropertyKeyFocus = { filePath: this.file.path, key: "" };
    this.renderProperties();
    const draftInput = this.propertiesEl?.querySelector<HTMLInputElement>(
      '[data-butter-property-draft="true"] .metadata-property-key-input',
    );
    if (draftInput) {
      this.pendingPropertyKeyFocus = null;
      const focusDraft = () => {
        if (!this.pendingPropertyDraft || !draftInput.isConnected) return;
        draftInput.focus();
        const EventCtor = draftInput.ownerDocument.defaultView?.Event ?? Event;
        draftInput.dispatchEvent(new EventCtor("input", { bubbles: true }));
      };
      focusDraft();
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(focusDraft);
      } else {
        window.setTimeout(focusDraft, 0);
      }
    }
  }

  private cancelPendingPropertyDraft(): void {
    if (!this.pendingPropertyDraft) return;
    this.pendingPropertyDraft = false;
    this.pendingPropertyKeyFocus = null;
    window.setTimeout(() => {
      if (!this.destroyed) this.renderProperties();
    }, 0);
  }

  private static TYPE_ICONS: Record<string, string> = {
    text: "lucide-text",
    number: "lucide-binary",
    checkbox: "lucide-check-square",
    date: "lucide-calendar",
    datetime: "lucide-clock",
    tags: "lucide-tags",
    aliases: "lucide-forward",
    multitext: "lucide-list",
    unknown: "lucide-file-question",
  };

  /**
   * Obsidian's Properties UI does not edit nested YAML structures. Rendering
   * one as a blank text field (or as `[object Object]` list pills) is unsafe:
   * an ordinary change event can silently replace the preserved structure.
   * Flat scalar lists remain supported; objects and arrays containing another
   * object/array are rendered through the non-editable path below.
   */
  private static isUnsupportedNestedPropertyValue(value: unknown): boolean {
    if (Array.isArray(value)) {
      return value.some(
        (item) => item !== null && typeof item === "object",
      );
    }
    return value !== null && typeof value === "object";
  }

  private getPropertyType(
    key: string,
    value: unknown,
  ): { type: string; icon: string } {
    const mgr = this.app.metadataTypeManager;
    if (mgr?.assignedWidgets) {
      const assigned = mgr.assignedWidgets[key.toLowerCase()];
      if (assigned) {
        const typeName = assigned.widget ?? assigned.type ?? "text";
        const registered = mgr.registeredTypeWidgets?.[typeName];
        const icon =
          registered?.icon ||
          ButterEditorView.TYPE_ICONS[typeName] ||
          "lucide-text";
        return { type: typeName, icon };
      }
    }
    if (Array.isArray(value)) return { type: "multitext", icon: "lucide-list" };
    if (typeof value === "boolean")
      return { type: "checkbox", icon: "lucide-check-square" };
    if (typeof value === "number") return { type: "number", icon: "lucide-binary" };
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value))
      return { type: "datetime", icon: "lucide-clock" };
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
      return { type: "date", icon: "lucide-calendar" };
    return { type: "text", icon: "lucide-text" };
  }

  renderProperties() {
    if (!this.propertiesEl) return;
    const active = this.propertiesEl.ownerDocument.activeElement;
    const editingProperty = active !== null &&
      this.propertiesEl.contains(active) &&
      (active.matches("input, textarea, select") ||
        (active as HTMLElement).isContentEditable);
    if (editingProperty) {
      if (!this.propertiesRenderDeferred) {
        this.propertiesRenderDeferred = true;
        (active as HTMLElement).addEventListener("blur", () => {
          this.propertiesRenderDeferred = false;
          if (!this.destroyed && this.propertiesEl) {
            window.setTimeout(() => this.renderProperties(), 0);
          }
        }, { once: true });
      }
      return;
    }
    this.propertiesRenderDeferred = false;
    this.propertiesEl.empty();
    if (this.propertiesComponent) {
      this.propertiesComponent.unload();
      this.propertiesComponent = null;
    }
    if (!this.file || (!this.frontmatter && !this.pendingPropertyDraft)) {
      this.propertiesEl.addClass("butter-hidden");
      return;
    }
    if (!this.propertiesAreVisible()) {
      this.propertiesEl.addClass("butter-hidden");
      return;
    }
    this.propertiesEl.removeClass("butter-hidden");
    const cache = this.app.metadataCache.getFileCache(this.file);
    const fmRaw: unknown = cache?.frontmatter;
    let fm = (fmRaw && typeof fmRaw === "object" && !Array.isArray(fmRaw)
      ? fmRaw
      : null) as Record<string, unknown> | null;
    if (!fm && this.frontmatter) {
      const sourceMatch = normalizeSourceLineEndings(this.frontmatter)
        .match(/^---\n([\s\S]*?)\n---(?:\n*)$/);
      if (sourceMatch) {
        const parsed: unknown = parseYaml(sourceMatch[1]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          fm = parsed as Record<string, unknown>;
        }
      }
    }
    if (!fm && this.pendingPropertyDraft) fm = {};
    if (!fm) {
      this.propertiesEl.addClass("butter-hidden");
      return;
    }
    this.propertiesEl.removeClass("butter-hidden");
    this.propertiesComponent = new Component();
    this.propertiesComponent.load();

    const propCount = Object.keys(fm).filter((k) => k !== "position").length +
      (this.pendingPropertyDraft ? 1 : 0);
    const metaContainer = this.propertiesEl.createDiv({
      cls: "metadata-container",
      attr: { "data-property-count": String(propCount) },
    });
    const heading = metaContainer.createDiv({
      cls: "metadata-properties-heading",
      attr: { tabIndex: 0 },
    });
    const foldEl = heading.createDiv({ cls: "collapse-indicator collapse-icon" });
    setIcon(foldEl, "right-triangle");
    heading.createDiv({ cls: "metadata-properties-title", text: tx("Properties") });
    heading.addEventListener("click", (e) => {
      e.preventDefault();
      metaContainer.toggleClass("is-collapsed", !metaContainer.hasClass("is-collapsed"));
    });

    const content = metaContainer.createDiv({ cls: "metadata-content" });
    const properties = content.createDiv({ cls: "metadata-properties" });
    const file = this.file;
    const app = this.app;
    const processFrontMatter = (
      mutator: (frontmatter: Record<string, unknown>) => void,
    ): void => {
      void this.enqueueNativeFileOperation(async () => {
        if (this.destroyed || this.file !== file) return;
        // Frontmatter and body are one file and therefore have one writer.
        // Mutate the staged TextFileView projection, then let the same native
        // writer persist both pieces. Body saves queued while this is in flight
        // run afterward with the updated frontmatter source.
        this.mutateFrontmatterSource(mutator);
        await this.performNativeSave(false);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        recordError("frontmatter", message);
        new Notice(`${tx("Butter: save failed -")} ${message}`);
      });
    };

    /** Render any frontmatter value to a flat string for input fields.
     *  Skips deep stringification of plain objects (which would yield
     *  the useless `[object Object]`) by returning empty for those. */
    const fmValueToString = (v: unknown): string => {
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      return ""; // arrays / plain objects shouldn't be flattened here
    };
    const propertyEntries = Object.entries(fm).filter(([key]) => key !== "position");
    if (this.pendingPropertyDraft) propertyEntries.push(["", null]);
    for (const [key, value] of propertyEntries) {
      if (key === "position") continue;
      const isDraft = this.pendingPropertyDraft && key === "";
      const unsupportedNested =
        ButterEditorView.isUnsupportedNestedPropertyValue(value);
      const { type, icon } = unsupportedNested
        ? { type: "unknown", icon: ButterEditorView.TYPE_ICONS.unknown }
        : this.getPropertyType(key, value);
      const prop = properties.createDiv({
        cls: "metadata-property",
        attr: {
          "data-property-key": key.toLowerCase(),
          "data-property-type": type,
          ...(isDraft ? { "data-butter-property-draft": "true" } : {}),
          ...(unsupportedNested
            ? { "data-butter-unsupported-nested": "true" }
            : {}),
          tabIndex: 0,
        },
      });

      const showPropertyMenu = (e: MouseEvent) => {
        if (isDraft) return;
        if (shouldUseNativePropertyContextMenu(e, prop)) return;
        // Capture the control before Obsidian's menu takes focus. Chromium
        // refuses execCommand("paste"), so Paste must target this exact input
        // after the asynchronous Clipboard API resolves.
        const clipboardTarget = capturePropertyClipboardTarget(e, prop);
        e.preventDefault();
        const menu = new Menu();
        const mgr = this.app.metadataTypeManager;
        const widgets = mgr?.registeredTypeWidgets;
        menu.addSections?.([
          "title",
          "action",
          "action.changeType",
          "clipboard",
          "",
          "danger",
        ]);
        menu.setSectionSubmenu?.("action.changeType", {
          title: tx("Property type"),
          icon: "lucide-info",
        });
        if (widgets) {
          for (const w of Object.values(widgets)) {
            if (!w) continue;
            if (w.reservedKeys && !w.reservedKeys.includes(key.toLowerCase()))
              continue;
            menu.addItem((item: MenuItem) => {
              const label = typeof w.name === "function" ? w.name() : w.type;
              item
                .setTitle(label)
                .setIcon(w.icon ?? null)
                .setChecked(w.type === type)
                .onClick(() => {
                  mgr?.setType?.(key.toLowerCase(), w.type);
                  window.setTimeout(() => this.renderProperties(), 100);
                });
              item.setSection?.("action.changeType");
            });
          }
        }
        menu.addItem((item: MenuItem) => {
          item
            .setTitle(tx("Cut"))
            .setIcon("lucide-scissors")
            .setDisabled(!clipboardTarget)
            .onClick(() => { clipboardTarget?.run("cut"); });
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item
            .setTitle(tx("Copy"))
            .setIcon("lucide-copy")
            .setDisabled(!clipboardTarget)
            .onClick(() => { clipboardTarget?.run("copy"); });
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item
            .setTitle(tx("Paste"))
            .setIcon("lucide-clipboard-check")
            .setDisabled(!clipboardTarget)
            .onClick(() => {
              if (clipboardTarget) void clipboardTarget.paste();
            });
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item
            .setTitle(tx("Remove"))
            .setIcon("lucide-trash-2")
            .onClick(() => {
              processFrontMatter((fm: Record<string, unknown>) => {
                delete fm[key];
              });
              window.setTimeout(() => this.renderProperties(), 100);
            });
          item.setWarning?.(true);
          item.setSection?.("danger");
        });
        menu.setParentElement?.(prop);
        menu.showAtMouseEvent(e);
        dismissMenuOnScroll(menu, prop.ownerDocument);
      };
      prop.addEventListener("contextmenu", showPropertyMenu);

      const iconEl = prop.createDiv({ cls: "metadata-property-icon" });
      setIcon(iconEl, icon);
      if (isDraft) {
        iconEl.setAttribute("aria-disabled", "true");
      } else {
        iconEl.addEventListener("click", (e) => {
          e.preventDefault();
          if (!prop.hasClass("has-active-menu")) showPropertyMenu(e);
        });
      }

      const keyEl = prop.createDiv({ cls: "metadata-property-key" });
      const keyInput = keyEl.createEl("input", {
        cls: "metadata-property-key-input",
        value: key,
        type: "text",
        attr: {
          autocapitalize: "none",
          enterkeyhint: "next",
          "aria-label": key || tx("Add property"),
        },
      });
      let propertyRenameCommitted = false;
      const commitPropertyKey = (candidate: string): boolean => {
        const newKey = candidate.trim();
        if (!newKey) {
          if (isDraft) this.cancelPendingPropertyDraft();
          else keyInput.value = key;
          return false;
        }
        if (newKey === key || propertyRenameCommitted) return true;
        const duplicateKey = Object.keys(fm).find(
          (existingKey) => existingKey !== key &&
            existingKey.toLowerCase() === newKey.toLowerCase(),
        );
        if (duplicateKey) {
          keyInput.value = key;
          const duplicateRow = Array.from(
            properties.querySelectorAll<HTMLElement>(".metadata-property"),
          ).find((row) =>
            row.dataset.propertyKey === duplicateKey.toLowerCase()
          );
          duplicateRow?.focus();
          return false;
        }
        propertyRenameCommitted = true;
        if (isDraft) this.pendingPropertyDraft = false;
        processFrontMatter((frontmatter: Record<string, unknown>) => {
          const concurrentDuplicate = Object.keys(frontmatter).some(
            (existingKey) => existingKey !== key &&
              existingKey.toLowerCase() === newKey.toLowerCase(),
          );
          if (concurrentDuplicate) return;
          if (isDraft) {
            frontmatter[newKey] = null;
          } else {
            if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) return;
            frontmatter[newKey] = frontmatter[key];
            delete frontmatter[key];
          }
        });
        window.setTimeout(() => this.renderProperties(), 100);
        return true;
      };
      if (isDraft) {
        // Register on the document before constructing Obsidian's suggester.
        // Its own document-capture listener consumes Escape with
        // stopImmediatePropagation, so input-level listeners never see it.
        const draftDocument = keyInput.ownerDocument;
        const escapeTarget: Window | Document =
          draftDocument.defaultView ?? draftDocument;
        const onDraftEscape = (e: KeyboardEvent) => {
          if (e.target !== keyInput || e.key !== "Escape" || e.isComposing) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          this.cancelPendingPropertyDraft();
          keyInput.blur();
          window.setTimeout(() => this.pmView?.focus(), 0);
        };
        escapeTarget.addEventListener("keydown", onDraftEscape as EventListener, true);
        this.propertiesComponent?.register(() => {
          escapeTarget.removeEventListener(
            "keydown",
            onDraftEscape as EventListener,
            true,
          );
        });
      }
      const propertySuggest = applyPropertyKeySuggest(app, keyInput, {
        currentKey: key,
        existingKeys: Object.keys(fm).filter((name) => name !== "position"),
        onSelect: (newKey) => {
          if (commitPropertyKey(newKey)) {
            this.pendingPropertyValueFocus = {
              filePath: file.path,
              key: newKey,
            };
            keyInput.blur();
          }
        },
      });
      this.propertiesComponent?.register(() => propertySuggest.close());
      if (this.pendingPropertyKeyFocus?.filePath === file.path &&
          this.pendingPropertyKeyFocus.key === key) {
        this.pendingPropertyKeyFocus = null;
        window.setTimeout(() => {
          if (this.destroyed || !keyInput.isConnected) return;
          keyInput.focus();
          const EventCtor = keyInput.ownerDocument.defaultView?.Event ?? Event;
          keyInput.dispatchEvent(new EventCtor("input", { bubbles: true }));
        }, 0);
      }
      keyInput.addEventListener("blur", () => {
        commitPropertyKey(keyInput.value);
      });
      keyInput.addEventListener("keydown", (e) => {
        if (e.isComposing || e.defaultPrevented) return;
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (commitPropertyKey(keyInput.value)) keyInput.blur();
        } else if (e.key === "Escape") {
          keyInput.value = key;
          prop.focus();
        }
      });

      const valContainer = prop.createDiv({
        cls: "metadata-property-value",
        attr: { "data-property-type": type },
      });
      valContainer.addEventListener("mousedown", () => {
        window.setTimeout(() => {
          const active = valContainer.querySelector(":focus") as HTMLElement;
          if (!active) {
            const focusable = valContainer.querySelector(
              "input, [contenteditable='true']",
            ) as HTMLElement;
            focusable?.focus();
          }
        }, 0);
      });
      valContainer.addClass("butter-prop-val-text");

      if (unsupportedNested) {
        const readOnlyInput = valContainer.createEl("input", {
          cls: "metadata-input metadata-input-text butter-property-readonly-value",
          type: "text",
          value: tx("Read-only"),
          attr: {
            tabIndex: -1,
            title: tx("Read-only"),
            "aria-label": tx("Read-only"),
            "aria-readonly": "true",
          },
        });
        readOnlyInput.readOnly = true;
        readOnlyInput.disabled = true;
        continue;
      }

      const temporalInput = resolveTemporalPropertyInput(type, value);
      const renderTemporalInput = (spec: TemporalPropertyInputSpec) => {
        const dateInput = valContainer.createEl("input", {
          cls: `metadata-input metadata-input-text mod-${type}`,
          type: spec.inputType,
          value: spec.value,
          attr: {
            tabIndex: 0,
            "data-butter-temporal-compatibility": spec.compatibility,
          },
        });
        dateInput.addEventListener("change", () => {
          processFrontMatter((frontmatter: Record<string, unknown>) => {
            frontmatter[key] = dateInput.value;
          });
        });
      };

      // Obsidian's registered datetime widget may ultimately create a native
      // datetime-local input. Bypass it only when the stored shape cannot be
      // represented by that control, preventing a populated YAML value from
      // appearing empty.
      if (temporalInput && temporalInput.compatibility !== "native") {
        renderTemporalInput(temporalInput);
        continue;
      }

      // Delegate supported values to Obsidian's own property widgets. Besides
      // keeping control behavior visually native, its text and multitext
      // widgets render quoted YAML wikilinks as clickable internal links while
      // unfocused, then expose the exact `[[...]]` source only during editing.
      const widget = this.app.metadataTypeManager?.registeredTypeWidgets?.[type];
      if (widget?.render) {
        const widgetContext = {
          app: this.app,
          key,
          sourcePath: file.path,
          onChange: (nextValue: unknown) => {
            processFrontMatter((frontmatter) => {
              frontmatter[key] = nextValue;
            });
          },
          blur: () => {
            const activeElement = valContainer.ownerDocument.activeElement as
              | HTMLElement
              | null;
            activeElement?.blur?.();
          },
        };
        const mixedWikilinks = type === "text" && typeof value === "string"
          ? parsePropertyTextWikilinks(value)
          : null;
        const hasSurroundingText = mixedWikilinks?.some(
          (segment) => segment.kind === "text" && segment.text.length > 0,
        ) === true;
        if (mixedWikilinks && hasSurroundingText) {
          const display = valContainer.createDiv({
            cls: "metadata-input-longtext butter-property-mixed-wikilinks",
            attr: {
              tabIndex: 0,
              role: "textbox",
              "aria-readonly": "true",
              "aria-label": `${key}: ${String(value)}`,
            },
          });
          for (const segment of mixedWikilinks) {
            if (segment.kind === "text") {
              display.appendChild(display.ownerDocument.createTextNode(segment.text));
              continue;
            }
            const link = display.createEl("a", {
              cls: "internal-link butter-property-wikilink",
              text: segment.label,
              href: segment.target,
              attr: {
                "data-href": segment.target,
                contentEditable: "false",
              },
            });
            link.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              void this.app.workspace.openLinkText(
                segment.target,
                file.path,
                event.ctrlKey || event.metaKey,
              );
            });
            link.addEventListener("mouseover", (event) => {
              this.app.workspace.trigger("hover-link", {
                event,
                source: BUTTER_HOVER_SOURCE,
                hoverParent: link,
                targetEl: link,
                linktext: segment.target,
                sourcePath: file.path,
              });
            });
          }
          const beginEdit = () => {
            if (!display.isConnected) return;
            valContainer.empty();
            widget.render?.(valContainer, value, widgetContext);
            const editor = valContainer.querySelector<HTMLElement>(
              "input, textarea, [contenteditable='true']",
            );
            editor?.focus();
            if (editor?.isContentEditable) {
              const selection = editor.ownerDocument.getSelection();
              const range = editor.ownerDocument.createRange();
              range.selectNodeContents(editor);
              range.collapse(false);
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
            editor?.addEventListener("blur", () => {
              if (!this.destroyed && this.file === file) {
                window.setTimeout(() => this.renderProperties(), 0);
              }
            }, { once: true });
          };
          display.addEventListener("click", beginEdit);
          display.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === "F2") {
              event.preventDefault();
              beginEdit();
            }
          });
        } else {
          widget.render(valContainer, value, widgetContext);
        }
        continue;
      }

      const isMulti =
        type === "tags" || type === "aliases" || type === "multitext";
      const arrValue: unknown[] | null = Array.isArray(value)
        ? value
        : isMulti && value
          ? fmValueToString(value)
              .split(",")
              .map((s) => s.trim())
          : null;

      if (isMulti) {
        const wrapper = valContainer.createDiv({ cls: "multi-select-container" });
        if (arrValue && arrValue.length > 0) {
          for (const item of arrValue) {
            const pill = wrapper.createDiv({
              cls: "multi-select-pill",
              attr: { tabIndex: 0 },
            });
            const pillContent = pill.createDiv({ cls: "multi-select-pill-content" });
            pillContent.textContent = String(item);
            const removeBtn = pill.createDiv({ cls: "multi-select-pill-remove-button" });
            setIcon(removeBtn, "lucide-x");
            removeBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              processFrontMatter((fm: Record<string, unknown>) => {
                const arr = fm[key];
                if (Array.isArray(arr)) {
                  fm[key] = arr.filter((v: unknown) => String(v) !== String(item));
                }
              });
              window.setTimeout(() => this.renderProperties(), 100);
            });
            if (type === "tags") {
              pillContent.addEventListener("click", () => {
                const search = app.internalPlugins?.getPluginById?.("global-search");
                const inst = search?.instance as
                  | { openGlobalSearch?: (q: string) => void }
                  | undefined;
                inst?.openGlobalSearch?.(`tag:${String(item)}`);
              });
            }
          }
        }
        const addInput = wrapper.createDiv({
          cls: "multi-select-input",
          attr: { contentEditable: "true", tabIndex: 0 },
        });
        if (!arrValue || arrValue.length === 0) {
          addInput.setAttribute("data-placeholder", tx("Empty"));
        }
        addInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && addInput.textContent?.trim()) {
            e.preventDefault();
            const newVal = addInput.textContent.trim();
            processFrontMatter((fm: Record<string, unknown>) => {
              let arr = fm[key];
              if (!Array.isArray(arr)) {
                arr = [];
                fm[key] = arr;
              }
              (arr as unknown[]).push(newVal);
            });
            addInput.textContent = "";
            window.setTimeout(() => this.renderProperties(), 100);
          }
        });
      } else if (type === "checkbox") {
        const cb = valContainer.createEl("input", {
          cls: "metadata-input-checkbox",
          type: "checkbox",
          attr: { tabIndex: 0 },
        });
        if (value) cb.checked = true;
        cb.addEventListener("change", () => {
          processFrontMatter((fm: Record<string, unknown>) => {
            fm[key] = cb.checked;
          });
        });
      } else if (type === "date" || type === "datetime") {
        renderTemporalInput(temporalInput ?? {
          inputType: "text",
          value: fmValueToString(value),
          compatibility: "raw",
        });
      } else if (type === "number") {
        const numInput = valContainer.createEl("input", {
          cls: "metadata-input metadata-input-number",
          type: "number",
          value: fmValueToString(value),
          attr: { tabIndex: 0 },
        });
        numInput.addEventListener("change", () => {
          processFrontMatter((fm: Record<string, unknown>) => {
            fm[key] = Number(numInput.value);
          });
        });
      } else {
        const textInput = valContainer.createEl("input", {
          cls: "metadata-input metadata-input-text",
          type: "text",
          value: fmValueToString(value),
          placeholder: tx("Empty"),
          attr: { tabIndex: 0 },
        });
        textInput.addEventListener("change", () => {
          processFrontMatter((fm: Record<string, unknown>) => {
            fm[key] = textInput.value;
          });
        });
      }
    }

    const pendingValueFocus = this.pendingPropertyValueFocus;
    if (pendingValueFocus?.filePath === file.path) {
      const pendingRow = Array.from(
        properties.querySelectorAll<HTMLElement>(".metadata-property"),
      ).find((row) =>
        row.dataset.propertyKey === pendingValueFocus.key.toLowerCase()
      );
      const valueControl = pendingRow?.querySelector<HTMLElement>(
        ".metadata-property-value [contenteditable='true'], " +
        ".metadata-property-value input:not([disabled]), " +
        ".metadata-property-value textarea:not([disabled]), " +
        ".metadata-property-value .combobox-button[tabindex='0'], " +
        ".metadata-property-value [tabindex='0']",
      );
      if (valueControl) {
        this.pendingPropertyValueFocus = null;
        window.setTimeout(() => {
          if (!this.destroyed && valueControl.isConnected) valueControl.focus();
        }, 0);
      }
    }

    const addBtn = content.createDiv({
      cls: "metadata-add-button text-icon-button",
      attr: { tabIndex: 0 },
    });
    const addBtnIcon = addBtn.createSpan({ cls: "text-button-icon" });
    setIcon(addBtnIcon, "lucide-plus");
    addBtn.createSpan({ cls: "text-button-label", text: tx("Add property") });
    addBtn.addEventListener("click", () => this.beginAddFileProperty());
  }

  // ── Lifecycle ──

  async onOpen() {
    this.destroyed = false;


    const container = this.contentEl;
    container.empty();
    container.addClass("butter-editor-view");
    container.toggleClass("butter-no-indent-guides", !this.plugin.settings.showListIndentGuides);
    container.toggleClass("butter-show-comments", this.plugin.settings.showComments);

    // View-type indicator on the tab/header
    this.containerEl.addClass("butter-view-root");
    this.installHeaderTitleRenameBridge();

    // (License banner mount moved down below properties)

    // Header action: cycle to next view mode in the user's
    // configured cycle list. Icon reflects the CURRENT mode so users
    // can identify which mode they're in at a glance - "butter-editor"
    // for Butter, "code-2" for Source, "edit-3" for Live Preview,
    // "book-open" for Reading.
    const cycleAction = this.addAction(
      modeIcon("butter"),
      tx("Switch view mode"),
      () => {
        cycleView(this.leaf, this.settings.viewCycleModes);
      },
    );
    cycleAction.setAttr("data-butter-action", "cycle");

    // Inline title
    const inlineTitle = container.createDiv({ cls: "inline-title" });
    const editorAccessibleLabelId =
      `butter-editor-label-${++editorAccessibleLabelSequence}`;
    inlineTitle.id = editorAccessibleLabelId;
    inlineTitle.contentEditable = "true";
    inlineTitle.spellcheck =
      (this.app.vault.getConfig?.("spellcheck") as boolean | undefined) ?? true;
    inlineTitle.tabIndex = -1;
    inlineTitle.addEventListener("blur", () => {
      const newName = inlineTitle.textContent?.trim();
      if (newName && this.file && newName !== this.file.basename) {
        this.app.fileManager.renameFile(
          this.file,
          this.file.parent?.path + "/" + newName + "." + this.file.extension,
        ).catch((err: unknown) => {
          recordError("inline-title-rename", String((err as Error)?.message ?? err));
          new Notice(tx("Rename failed"));
        });
      }
    });
    inlineTitle.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        inlineTitle.blur();
      }
    });
    this.inlineTitleEl = inlineTitle;

    // Properties
    this.propertiesEl = container.createDiv({
      cls: "butter-properties-wrapper markdown-source-view cm-s-obsidian is-live-preview show-properties",
    });

    // License-required banner. Mounts above the title (on mobile) or
    // above the toolbar at the leaf level (on desktop), using the same
    // positioning logic as the top-pinned attached toolbar.
    const bannerWrapper = container.createDiv({
      cls: "butter-license-banner-wrapper",
    });
    this.licenseBanner = mountLicenseBanner(container, this.inlineTitleEl, bannerWrapper, this.plugin, this.containerEl);
    this.registerEvent(
      this.app.workspace.on("butter:license-changed" as never, () => {
        this.licenseBanner?.refresh();
        this.applyToolbarPosition();
        if (this.pmView) {
          this.pmView.dispatch(this.pmView.state.tr);
        }
      }),
    );

    const getSourcePath = () => this.file?.path ?? "";

    // Toolbar
    const plugin = this.app.plugins?.plugins?.["butter-editor"] as
      | ButterEditorPlugin
      | undefined;
    const {
      dom: toolbarDom,
      plugin: toolbarPlugin,
      rebuild: rebuildToolbar,
    } = createToolbar(
      this.app,
      schema,
      () =>
        plugin
          ? plugin.getActiveToolbarLayout()
          : Platform.isMobile
            ? this.settings.mobileToolbarLayout ?? mobileLayoutDefault()
            : this.settings.toolbarLayout ?? defaultMainLayout(),
      () => this.settings.mobileToolbarStyle,
      // Single-block markdown serializer - used by the mobile
      // drawer's Block-actions Copy tile (and any other future
      // mobile context-button paths). Same one the desktop drag-
      // handle context menu uses.
      (node) => serializer.serialize(schema.node("doc", null, [node])),
      getSourcePath,
      () => this.dismissMobileKeyboard(),
    );
    toolbarDom.setAttribute("data-active-style", this.settings.toolbarActiveStyle);
    this.toolbarDom = toolbarDom;
    this.rebuildMainToolbar = rebuildToolbar;

    // Status-bar hover-fade - cursor-position-aware. Only fades when
    // the cursor is on toolbar pixels that actually share screen
    // space with the status bar. Multi-pane configs: only the pane
    // whose toolbar overlaps the status-bar's X range drives the
    // fade. Single pane with a centered toolbar: the left half of
    // the toolbar (clear of the status bar) doesn't trigger; only
    // the rightmost portion behind the status bar does.
    //
    // Mousemove sets/clears the class continuously as the cursor
    // moves across the obscured boundary inside the toolbar.
    // Mouseleave schedules a 150ms grace delay before clearing so
    // briefly brushing past the toolbar edge doesn't pulse the
    // status bar in and out.
    this.registerDomEvent(toolbarDom, "mouseenter", () => {
      if (!this.settings.statusBarHoverFade) return;
      if (StatusState.statusBarHideTimer !== null) {
        window.clearTimeout(StatusState.statusBarHideTimer);
        StatusState.statusBarHideTimer = null;
      }
    });
    this.registerDomEvent(toolbarDom, "mousemove", (ev) => {
      if (!this.settings.statusBarHoverFade) {
        activeDocument.body.classList.remove("butter-status-bar-hide");
        return;
      }
      if (StatusState.statusBarHideTimer !== null) {
        window.clearTimeout(StatusState.statusBarHideTimer);
        StatusState.statusBarHideTimer = null;
      }
      activeDocument.body.classList.toggle(
        "butter-status-bar-hide",
        this.cursorInToolbarStatusBarOverlap(ev),
      );
    });
    this.registerDomEvent(toolbarDom, "mouseleave", () => {
      if (!this.settings.statusBarHoverFade) return;
      if (StatusState.statusBarHideTimer !== null) window.clearTimeout(StatusState.statusBarHideTimer);
      StatusState.statusBarHideTimer = window.setTimeout(() => {
        activeDocument.body.classList.remove("butter-status-bar-hide");
        StatusState.statusBarHideTimer = null;
      }, 150);
    });

    // Right-click on the toolbar's empty area opens a quick-access
    // menu for changing position / style without going to settings.
    // Skipped when the click is on a button, separator, popover, or
    // any other interactive descendant.
    toolbarDom.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement;
      if (
        target.closest(".butter-btn") ||
        target.closest(".butter-toolbar-popover") ||
        target.closest("button") ||
        target.closest("input")
      ) {
        return;
      }
      e.preventDefault();
      // settings + saveSettings + applyToolbarPositionToAllViews live
      // on the plugin, not the view. Look it up via Obsidian's
      // plugin registry. Cast to any since the plugins map isn't in
      // the public types.
      const plugin = (this.app.plugins?.plugins?.[
        "butter-editor"
      ] ?? null) as ButterEditorPlugin | null;
      if (!plugin) return;
      const menu = new Menu();
      // Mobile toolbar is body-attached above the keyboard - Position
      // and Style settings don't apply there, so just expose Settings.
      if (!Platform.isMobile) {
        const setPos = async (p: "top" | "bottom") => {
          if (plugin.settings.toolbarStyle === "integrated") return;
          plugin.settings.toolbarPosition = p;
          await plugin.saveSettings();
          plugin.applyToolbarPositionToAllViews();
        };
        const setStyle = async (s: "attached" | "detached" | "integrated") => {
          plugin.settings.toolbarStyle = s;
          if (s === "integrated") {
            plugin.settings.toolbarPosition = "top";
          }
          await plugin.saveSettings();
          plugin.applyToolbarPositionToAllViews();
        };
        menu.addItem((item) => {
          item.setTitle(tx("Position"));
          item.setIcon("move-vertical");
          item.setDisabled(plugin.settings.toolbarStyle === "integrated");
          const sub = item.setSubmenu();
          sub.addItem((s) => {
            s.setTitle(tx("Top"));
            s.setIcon("arrow-up-to-line");
            if (plugin.settings.toolbarPosition === "top") s.setChecked(true);
            s.onClick(() => void setPos("top"));
          });
          sub.addItem((s) => {
            s.setTitle(tx("Bottom"));
            s.setIcon("arrow-down-to-line");
            if (plugin.settings.toolbarPosition === "bottom") s.setChecked(true);
            s.onClick(() => void setPos("bottom"));
          });
        });
        menu.addItem((item) => {
          item.setTitle(tx("Style"));
          item.setIcon("layers");
          const sub = item.setSubmenu();
          sub.addItem((s) => {
            s.setTitle(tx("Attached"));
            s.setIcon("rectangle-horizontal");
            if (plugin.settings.toolbarStyle === "attached") s.setChecked(true);
            s.onClick(() => void setStyle("attached"));
          });
          sub.addItem((s) => {
            s.setTitle(tx("Detached"));
            s.setIcon("square-dashed");
            if (plugin.settings.toolbarStyle === "detached") s.setChecked(true);
            s.onClick(() => void setStyle("detached"));
          });
          sub.addItem((s) => {
            s.setTitle(tx("Integrated"));
            s.setIcon("panel-top");
            if (plugin.settings.toolbarStyle === "integrated") s.setChecked(true);
            s.onClick(() => void setStyle("integrated"));
          });
        });
        menu.addSeparator();
      }
      menu.addItem((item) => {
        item
          .setTitle(tx("Settings"))
          .setIcon("settings")
          .onClick(() => plugin.openSettings("toolbar"));
      });
      menu.showAtMouseEvent(e);
      dismissMenuOnScroll(menu, toolbarDom.ownerDocument);
    });

    // Mark the view container with the user's toolbar-position
    // preference so CSS can swap sticky-top vs sticky-bottom rules.
    // Updated live by applyToolbarPosition() when the setting changes.
    container.setAttribute(
      "data-toolbar-pos",
      this.settings.toolbarPosition,
    );

    // NOTE: do not add `markdown-rendered` here. That class is Obsidian's
    // Reading-mode wrapper and its CSS can mask the live PM editor's
    // rendering (e.g., stripping font-weight on <strong>). Our NodeViews
    // apply `markdown-rendered` to the MarkdownRenderer output *inside*
    // callouts / embeds / math / code blocks, which is where it belongs.
    const editorRoot = container.createDiv({
      cls: "butter-editor-root",
    });

    // Mobile keeps its body-attached behavior; desktop hands off to
    // applyToolbarPosition (called below) which mounts the toolbar
    // in the leaf chrome between view-header and view-content. The
    // mobile keyboard-accessory behavior (visualViewport tracking,
    // focus-tied show/hide, native-toolbar suppression body class)
    // is installed AFTER the PM view is created - see the call to
    // `installMobileToolbarBehavior` below.
    if (Platform.isMobile) {
      editorRoot.ownerDocument.body.appendChild(toolbarDom);
    } else {
      this.applyToolbarPosition();
    }
    this.refreshContentPaddingVar();

    const getFile = () => this.file ?? null;

    this.acceptedViewData ??= this.data ?? "";
    const body = this.stripFrontmatter(this.acceptedViewData);
    this.renderProperties();

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file === this.file) this.renderProperties();
      }),
    );

    // parseWithSourceMap delegates to PM's createAndFill which can
    // recurse into fillBefore on certain doc shapes. Node's stack
    // accommodates our schema graph; Electron's smaller stack can
    // blow on specific input combinations. Catch + fall back rather
    // than crash the entire view (and through it, the plugin).
    let result: ReturnType<typeof parser.parseWithSourceMap> | null = null;
    let parseFailure: unknown = null;
    try {
      result = parser.parseWithSourceMap(body);
    } catch (err) {
      parseFailure = err;
      console.error(
        "[butter-editor] parser.parseWithSourceMap threw on this file. Falling back to a source-preserving raw block.",
        err,
      );
    }
    const doc = ensureBlockIds(
      result?.doc ?? parser.rawBlockFallbackDocument(
        body,
        parseFailure instanceof Error
          ? `initial parse failed: ${parseFailure.message}`
          : "initial parse returned no document",
      ),
    );
    this.captureSourceState(body, doc);

    this.nodeViewManager = new NodeViewManager();
    const mgr = this.nodeViewManager;
    const extensionRuntime = materializeButterEditorExtensions();

    const plugins = [
      toolbarPlugin,
      autocompletePlugin(this.app, schema),
      slashMenuPlugin(this.app, schema),
      buildInputRules(schema, {
        markdownShortcuts: this.settings.markdownShortcuts,
      }),
      buildKeymap(schema, {
        markdownShortcuts: () => this.settings.markdownShortcuts,
      }),
      linkEditorKeyboardPlugin(this.app, getSourcePath),
      blockIdStamperPlugin(),
      blockAnimatorPlugin(),
      commentOnlyParagraphPlugin(),
      checkboxPlugin(),
      listNumberingPlugin(),
      footnotePresentationPlugin(),
      headingFoldPlugin(),
      multiBlockSelectPlugin({
        app: this.app,
        serializeNode: (node) =>
          serializer.serialize(schema.node("doc", null, [node])),
      }),
      selectionOverlayPlugin(),
      listOperationsPlugin(),
      codeHighlightPlugin(this.app),
      searchPlugin({
        getMainToolbarDom: () => this.toolbarDom,
        getMobileStyle: () => this.settings.mobileToolbarStyle,
      }),
      dragHandlesPlugin({
        app: this.app,
        serializeNode: (node) =>
          serializer.serialize(schema.node("doc", null, [node])),
        dragHandleVisibility: () => this.settings.dragHandleVisibility,
        dragMotion: () => this.settings.dragMotion,
        dragTriggerOffset: () => this.settings.blockDragTriggerOffsetPx,
        containerDragTriggerOffset: () =>
          this.settings.blockDragContainerTriggerOffsetPx,
        dragCompactionTriggerPx: () => this.settings.dragCompactionTriggerPx,
        dragCompactedHeightPx: () => this.settings.dragCompactedHeightPx,
        mouseReleaseProtection: () => this.settings.mouseReleaseProtection,
        unlockMobileEditable: () => this.requestMobileEditing(),
        chromeBottom: () => {
          const header = this.containerEl?.querySelector<HTMLElement>(".view-header");
          const stack = this.containerEl?.querySelector<HTMLElement>(".butter-toolbar-stack");
          const hb = header?.getBoundingClientRect().bottom ?? 0;
          const sb = stack?.getBoundingClientRect().bottom ?? 0;
          const cb = visibleContextToolbarBottom(this.containerEl);
          const toolbarPosition = this.containerEl?.getAttribute("data-toolbar-pos") === "bottom"
            ? "bottom"
            : "top";
          return editorTopChromeBottom(toolbarPosition, hb, sb, cb);
        },
      }),
      // Cell-range drag MUST register BEFORE tableEditing() so its
      // mousedown handler fires first. When the user grabs an active
      // CellSelection, it returns true and pm-tables' mousedown (which
      // would otherwise start a fresh drag-select and clobber the
      // selection we're about to drag) never runs.
      tableCellDragPlugin(),
      ...tableEditingPlugins(),
      tableToolbarPlugin(
        this.app,
        schema,
        () => this.toolbarDom,
        () =>
          plugin
            ? plugin.getActiveTableToolbarLayout()
            : Platform.isMobile
              ? this.settings.mobileTableToolbarLayout ?? mobileTableLayoutDefault()
              : this.settings.tableToolbarLayout ?? defaultTableLayout(),
        () => this.settings.mobileToolbarStyle,
      ),
      tableRowColDragPlugin(),
      clickToSpawnPlugin(() => this.requestMobileEditing()),
      inlineAtomEditPlugin(this.app, {
        canEdit: () => {
          const s = this.plugin.licenseStatus;
          return s === "valid" || s === "trial";
        },
      }),
      autoSplitImagesPlugin(schema, () => this.settings.splitFullWidthImages),
      // Safety net: once a raw_block enters the doc (parse failure
      // fallback), block any transaction that would remove it
      // unless the transaction is flagged as a trusted sync. User
      // gets a Notice explaining why the edit didn't stick.
      rawBlockSafetyPlugin((msg) => new Notice(msg, 6000)),
      keymap({ "Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo }),
      history(),
      dropCursor(),
      gapCursor(),
      contextMenuPlugin(schema, {
        app: this.app,
        getEditor: () => {
          this.editor?.refresh();
          return this.editor as unknown as import("obsidian").Editor | null;
        },
        getInfo: () => this as unknown as import("obsidian").MarkdownFileInfo,
        getContextMenuLayout: () => this.plugin.getContextMenuLayout(),
        getPendingFeatureAnnouncement: (surface) =>
          this.plugin.getPendingFeatureAnnouncement(surface),
        acknowledgeFeatureAnnouncement: (id) =>
          this.plugin.acknowledgeFeatureAnnouncement(id),
        openContextMenuSettings: () => this.plugin.openSettings("context-menu"),
        serializeNode: (node) =>
          serializer.serialize(schema.node("doc", null, [node])),
      }),
      trimDblClickSelectionPlugin(),
      // Resolves em/strong overlap at transaction-end so the saved
      // file stays pure markdown (no `<em>`/`<strong>` HTML fallback).
      // Word-aligned overlap → smart-split via whitespace-eject (no
      // formatting loss). Mid-word overlap → older mark yields in
      // the overlap region (some pre-existing formatting trimmed).
      overlapResolverPlugin(schema),
    ];

    if (this.settings.enablePasteDrop) {
      plugins.push(pasteDropPlugin(this.app, schema, parser, getSourcePath, (d) => serializer.serialize(d)));
    }

    if (this.settings.enableSuggestBridge) {
      plugins.push(
        suggestBridgePlugin(
          this.app,
          (d) => serializer.serialize(d),
          getFile,
        ),
      );
    }

    plugins.push(
      new PMPlugin({
        view: () => ({
          update: (view, prevState) => {
            if (this.suppressChange) return;
            if (!view.state.doc.eq(prevState.doc)) {
              this.editGeneration += 1;
              // TextFileView's public contract requires this on every local
              // edit so Obsidian knows the view is dirty and protects it from
              // external replacement/close-time loss. Our scheduler remains
              // the immediate-flush/continuous-edit ceiling layer.
              this.requestSave();
              // Route every edit through the scheduler; it manages
              // idle + ceiling + event-driven flush triggers.
              this.saveScheduler?.onEdit();
            }
          },
        }),
      }),
    );
    // Core plugins are intentionally earlier: ProseMirror resolves plugin
    // props in array order. Extension plugins remain native PM plugins, with
    // their state/view/destroy lifecycle owned by ProseMirror.
    plugins.push(...extensionRuntime.plugins);

    // EditorState.create runs PM's content validation which recursively
    // walks fillBefore / createAndFill. On our schema's content graph
    // that recursion sits near Electron's stack limit (Node's is much
    // larger - tests don't trip it). Certain doc shapes can blow past
    // it. Wrap in try/catch and fall back to an atomic raw_block carrying
    // every source byte. An empty paragraph fallback looked harmless but
    // could later overwrite the real file if any save path reached it.
    let state: EditorState;
    try {
      state = EditorState.create({ doc, schema, plugins });
    } catch (err) {
      console.error(
        "[butter-editor] EditorState.create threw (likely PM fillBefore stack overflow on this doc). Falling back to a source-preserving raw block.",
        err,
      );
      const fallback = ensureBlockIds(
        parser.rawBlockFallbackDocument(
          body,
          `EditorState.create failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      this.captureSourceState(body, fallback);
      state = EditorState.create({ doc: fallback, schema, plugins });
    }

    const pmView = new EditorView(editorRoot, {
      state,
      editable: () => this.isEditable(),
      // Identify the contenteditable region to assistive tech.
      // role=textbox + aria-multiline distinguishes it from a one-
      // line input; aria-labelledby supplies the required accessible
      // name without triggering Obsidian's aria-label tooltip behavior.
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        // The visible note title is the editor's accessible name. Referencing
        // it avoids Obsidian's aria-label tooltip behavior and follows ARIA's
        // preference for aria-labelledby when label text exists in the DOM.
        "aria-labelledby": editorAccessibleLabelId,
      },
      nodeViews: {
        // Source provenance and session block IDs are deliberately invisible
        // to DOM rendering. Preserve default node wrappers when only that
        // metadata changes during a native same-file/external reload.
        ...stableDefaultNodeViews(schema),
        // External NodeViews may fill extension-owned node types; Butter's
        // built-ins below deliberately win any name collision.
        ...extensionRuntime.nodeViews,
        code_block: codeBlockView(this.app, getSourcePath, mgr, this),
        obsidian_embed: embedView(this.app, getSourcePath, mgr, this),
        obsidian_embed_inline: embedInlineView(this.app, getSourcePath, mgr, this),
        obsidian_callout: calloutView(this.app, getSourcePath, mgr, this),
        math_block: mathBlockView(this.app, getSourcePath, mgr, this),
        inline_math: inlineMathView(this.app, getSourcePath, mgr, this),
        wikilink: wikilinkView(this.app, getSourcePath),
        obsidian_tag: tagView(this.app),
        block_comment: blockCommentView(),
        inline_footnote: inlineFootnoteView(this.app, getSourcePath, mgr),
        footnote_ref: footnoteRefView(),
        footnote_def: footnoteDefView(this.app, getSourcePath, mgr),
        block_id: blockIdView(),
        image: imageView(this.app, getSourcePath),
        raw_block: rawBlockView(),
      },
    });
    this.pmView = pmView;

    if (this.destroyed) {
      this.pmView.destroy();
      this.pmView = null;
      return;
    }

    // Apply experimental theme-compat mode (may add `.markdown-
    // rendered` to the PM element so theme CSS scoped to that class
    // cascades into Butter). No-op when the setting is off.
    this.applyThemeCompatMode();

    // Mobile keyboard-accessory behavior - needs the PM view to
    // exist so we can attach focus listeners to its DOM. No-op on
    // desktop. See `installMobileToolbarBehavior` for the full
    // contract (visualViewport tracking, focus-tied visibility,
    // native-toolbar suppression body class).
    if (Platform.isMobile && this.toolbarDom) {
      this.installMobileToolbarBehavior(this.toolbarDom, this.pmView.dom);
    }

    // Expose an Obsidian-Editor-shaped shim. Plugins that read
    // `activeLeaf.view.editor` can now operate against our view.
    this.editor = new PMEditorShim(
      this.pmView,
      (d) => serializer.serialize(d),
      (newMarkdown) => {
        this.replaceLocalMarkdown(newMarkdown);
      },
      (cycle) => {
        const pmView = this.pmView;
        if (!pmView) return;
        toggleTaskOnCurrentLine(
          pmView.state,
          pmView.dispatch.bind(pmView),
          cycle,
        );
      },
    );

    // Initialize the save scheduler. Every edit lands here; blur,
    // tab-hide, and beforeunload trigger an instant flush so sync
    // plugins + file watchers see the newest bytes without paying
    // the full idle-window cost.
    //
    // We call `save()` directly rather than `requestSave()` because
    // the latter is documented as "Debounced save in 2 seconds from
    // now" - our scheduler already handles idle/ceiling/event
    // triggering, so layering Obsidian's 2s debounce on top would
    // mean event flushes (blur, window-blur, etc.) don't actually
    // hit disk for 2 seconds. `save()` writes immediately.
    this.saveScheduler = new SaveScheduler(async () => {
      // Wrap the scheduler-driven save in async error capture. Without
      // this, an async vault.modify rejection (disk full, file locked
      // by sync clients, network drive drop, EACCES) silently escapes
      // to the event loop as an unhandled promise rejection - the user
      // sees nothing while their typing piles up unsaved.
      try {
        await this.save();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordError("save", `save failed: ${msg}`);
        new Notice(`${tx("Butter: save failed -")} ${msg}`);
        // SaveScheduler owns retry/pending state. Re-throw so flush(), file
        // switching, and teardown cannot mistake a failed write for success.
        throw err;
      }
    });
    this.installSchedulerTriggers();

    // Replay any ephemeral state that arrived while the PM view was
    // still mounting (typical on a Markdown → Butter view swap).
    if (this.pendingEphemeralState) {
      const pending = this.pendingEphemeralState;
      this.pendingEphemeralState = null;
      this.applyEphemeralState(pending);
    }

  }

  async onClose() {
    this.clearMobileKeyboardDismissal();
    // Tear down the license banner. registerEvent handles the
    // workspace listener cleanup automatically.
    if (this.licenseBanner) {
      this.licenseBanner.destroy();
      this.licenseBanner = null;
    }
    // Flush pending save NOW so we don't lose the user's most
    // recent typing when the view closes (common on file switch).
    if (this.saveScheduler) {
      await this.saveScheduler.flush();
      this.saveScheduler = null;
    }
    await this.saveQueue;
    this.destroyed = true;
    // Detach DOM-event triggers installed by installSchedulerTriggers.
    for (const teardown of this.schedulerListeners) {
      try { teardown(); } catch { /* already gone */ }
    }
    this.schedulerListeners = [];
    this.editor = null;
    this.propertiesEl = null;
    if (this.propertiesComponent) {
      this.propertiesComponent.unload();
      this.propertiesComponent = null;
    }
    if (this.toolbarDom?.parentNode) {
      this.toolbarDom.remove();
      this.toolbarDom = null;
    }
    // Re-check body class - if THIS view's editor was the focused
    // Butter view, removing its DOM moves activeElement off our
    // .butter-editor-view subtree, and the body class should follow.
    // (The window focusin/focusout listeners are torn down by
    // registerDomEvent at this point, so we refresh manually.)
    if (Platform.isMobile) refreshButterMobileBodyClass();
    if (this.nodeViewManager) {
      this.nodeViewManager.destroy();
      this.nodeViewManager = null;
    }
    if (this.pmView) {
      this.pmView.destroy();
      this.pmView = null;
    }
  }

  private canonicalSaveOptions() {
    return {
      bullet: this.settings.canonicalBullet,
      italic: this.settings.canonicalItalic,
      bold: this.settings.canonicalBold,
      codeFence: this.settings.canonicalCodeFence,
      horizontalRule: this.settings.canonicalHorizontalRule,
    };
  }

  /** Finalize a serializer body identically for both preflight paths. */
  private finalizeSaveBody(serializedBody: string): string {
    let body = normalizeSourceLineEndings(serializedBody);
    const preserveTrailing = Boolean(
      this.settings.preserveOriginalSource &&
      this.preserveSource &&
      this.originalDoc,
    );
    body = body.replace(/\n*$/, "") + "\n".repeat(
      preserveTrailing ? this.originalTrailingNewlines : 1,
    );
    if (
      this.settings.normalizeHeadingGap ||
      this.settings.condenseBlankLines ||
      this.settings.closeUnclosedFences
    ) {
      body = normalizeSource(body, {
        headingGap: this.settings.normalizeHeadingGap,
        condenseBlanks: this.settings.condenseBlankLines,
        closeUnclosedFences: this.settings.closeUnclosedFences,
      });
    }
    return body;
  }

  private assembleSaveText(body: string): string {
    let text = normalizeSourceLineEndings(this.frontmatter + body);
    if (this.lineEnding !== "\n") {
      text = text.replace(/\n/g, this.lineEnding);
    }
    return this.originalHasBOM ? `\ufeff${text}` : text;
  }

  private preflightCurrent(
    rawDoc = this.pmView?.state.doc ?? null,
  ): SavePreflightResult | null {
    if (!rawDoc) return null;
    const tableNormalized = normalizeTablesInDoc(rawDoc, rawDoc.type.schema);
    if (
      this.originalDoc &&
      this.hasRawBlock(this.originalDoc) &&
      !this.hasRawBlock(tableNormalized)
    ) {
      return {
        ok: false,
        blocked: true,
        attempts: [{
          ok: false,
          path: "source-preserving",
          stage: "compare",
          error: "loaded raw source artifact disappeared from the live document",
        }],
      };
    }
    const canPreserve = Boolean(
      this.settings.preserveOriginalSource &&
      this.preserveSource &&
      this.originalDoc,
    );
    return preflightExactSave({
      currentDoc: tableNormalized,
      originalBody: this.originalBody,
      originalDoc: this.originalDoc,
      canonicalOptions: this.canonicalSaveOptions(),
      primaryPath: canPreserve ? "source-preserving" : "canonical",
      finalizeBody: (body) => this.finalizeSaveBody(body),
    });
  }

  private preflightFailureReason(result: Extract<SavePreflightResult, { ok: false }>): string {
    return result.attempts
      .map((attempt) => `${attempt.path}/${attempt.stage}: ${attempt.error}`)
      .join(" | ");
  }

  private exactViewData(doc: PMNode): string {
    return this.exactSaveCandidate(doc).text;
  }

  private exactSaveCandidate(doc: PMNode): {
    text: string;
    normalizedDoc: PMNode;
  } {
    const preflight = this.preflightCurrent(doc);
    if (!preflight || !preflight.ok) {
      const reason = preflight
        ? this.preflightFailureReason(preflight)
        : "editor is not available";
      this.reportSaveResult?.({ kind: "blocked", reason });
      recordError("save", `Exact preflight blocked the write: ${reason}`);
      if (this.lastBlockedDoc !== doc) {
        this.lastBlockedDoc = doc;
        new Notice(
          `${tx("Butter: save failed -")} safety check blocked the write; your file was not changed.`,
          12000,
        );
      }
      throw new Error(`Butter exact-save preflight blocked: ${reason}`);
    }
    return {
      text: this.assembleSaveText(preflight.candidate),
      normalizedDoc: preflight.normalizedDoc,
    };
  }

  private mapPresentationPosition(
    live: PMNode,
    target: PMNode,
    position: number,
    association: -1 | 1,
    fallback: number,
  ): number {
    const resolved = live.resolve(position);
    let targetParent = target;
    let targetParentStart = 0;

    // Presentation normalization preserves block cardinality. Follow the
    // exact child-index path to the same parent instead of asking a bounding
    // ReplaceStep to guess where a cursor inside an unchanged middle block
    // belongs.
    for (let depth = 0; depth < resolved.depth; depth++) {
      const index = resolved.index(depth);
      if (index >= targetParent.childCount) return fallback;
      let offset = 0;
      for (let childIndex = 0; childIndex < index; childIndex++) {
        offset += targetParent.child(childIndex).nodeSize;
      }
      const targetChild = targetParent.child(index);
      const liveChild = resolved.node(depth + 1);
      if (targetChild.type !== liveChild.type) return fallback;
      targetParentStart += offset + 1;
      targetParent = targetChild;
    }

    let targetOffset: number;
    if (resolved.parent.inlineContent && targetParent.inlineContent) {
      targetOffset = this.mapPresentationInlineOffset(
        resolved.parent,
        targetParent,
        resolved.parentOffset,
        resolved.index(resolved.depth),
        resolved.textOffset,
        association,
      );
    } else {
      const index = resolved.index(resolved.depth);
      if (index > targetParent.childCount) return fallback;
      targetOffset = 0;
      for (let childIndex = 0; childIndex < index; childIndex++) {
        targetOffset += targetParent.child(childIndex).nodeSize;
      }
    }

    return targetParentStart + Math.max(
      0,
      Math.min(targetOffset, targetParent.content.size),
    );
  }

  private mapPresentationInlineOffset(
    liveParent: PMNode,
    targetParent: PMNode,
    offset: number,
    sourceIndex: number,
    textOffset: number,
    association: -1 | 1,
  ): number {
    // Normalize the exact source prefix and accept it only when it is an exact
    // prefix of the target. This gives a linear, monotonic offset map across
    // any number of disjoint insertions (for example, spaces before multiple
    // Obsidian tags) without an edit-distance algorithm.
    try {
      const prefixParent = liveParent.copy(liveParent.content.cut(0, offset));
      const prefixDoc = liveParent.type.schema.nodes.doc.create(
        null,
        prefixParent,
      );
      const normalizedPrefixDoc = normalizeDocForSave(prefixDoc, {
        mode: "presentation",
      });
      const normalizedPrefix = normalizedPrefixDoc.firstChild;
      if (
        normalizedPrefix?.type === targetParent.type &&
        normalizedPrefix.sameMarkup(targetParent) &&
        normalizedPrefix.content.size <= targetParent.content.size &&
        targetParent.content
          .cut(0, normalizedPrefix.content.size)
          .eq(normalizedPrefix.content)
      ) {
        return normalizedPrefix.content.size;
      }
    } catch {
      // A prefix can be schema-invalid for an extension node. Reference
      // anchors below remain exact for all retained children.
    }

    const targetOffsetOf = (needle: PMNode): number | null => {
      let childOffset = 0;
      for (let index = 0; index < targetParent.childCount; index++) {
        const child = targetParent.child(index);
        if (child === needle) return childOffset;
        childOffset += child.nodeSize;
      }
      return null;
    };

    if (textOffset > 0 && sourceIndex < liveParent.childCount) {
      const sourceChild = liveParent.child(sourceIndex);
      const anchored = targetOffsetOf(sourceChild);
      if (anchored !== null) return anchored + textOffset;
    } else {
      const after = sourceIndex < liveParent.childCount
        ? liveParent.child(sourceIndex)
        : null;
      const before = sourceIndex > 0
        ? liveParent.child(sourceIndex - 1)
        : null;
      const preferred = association < 0 ? [before, after] : [after, before];
      for (const child of preferred) {
        if (!child) continue;
        const anchored = targetOffsetOf(child);
        if (anchored === null) continue;
        return child === before ? anchored + child.nodeSize : anchored;
      }
    }

    // The cursor is inside content that presentation normalization actually
    // replaced (for example `$x$` becoming one inline-math atom). There is no
    // interior Markdown-source position in the rendered atom, so map to the
    // corresponding representable boundary. This branch is not used for
    // unchanged children or for disjoint insertions.
    {
      const liveContent = liveParent.content;
      const targetContent = targetParent.content;
      const start = liveContent.findDiffStart(targetContent);
      const rawEnd = liveContent.findDiffEnd(targetContent);
      if (start === null || rawEnd === null) {
        return offset;
      } else {
        let liveEnd = rawEnd.a;
        let targetEnd = rawEnd.b;
        const overlap = start - Math.min(liveEnd, targetEnd);
        if (overlap > 0) {
          liveEnd += overlap;
          targetEnd += overlap;
        }
        const liveLength = liveEnd - start;
        const targetLength = targetEnd - start;
        if (offset < start) {
          return offset;
        } else if (offset > liveEnd) {
          return targetEnd + offset - liveEnd;
        } else if (liveLength === 0) {
          return association < 0 ? start : targetEnd;
        } else if (liveLength === targetLength) {
          return offset;
        } else {
          return association < 0 ? start : targetEnd;
        }
      }
    }
  }

  private presentationSelection(
    live: PMNode,
    target: PMNode,
    selection: Selection,
    fallbackMapping: Parameters<Selection["map"]>[1],
  ): Selection {
    const json = selection.toJSON() as Record<string, unknown>;
    const mapped: Record<string, unknown> = { ...json };
    const anchor = typeof json.anchor === "number" ? json.anchor : null;
    const head = typeof json.head === "number" ? json.head : null;
    const collapsed = anchor !== null && head !== null && anchor === head;

    for (const key of ["anchor", "head", "pos"] as const) {
      const value = json[key];
      if (typeof value !== "number") continue;
      const association: -1 | 1 = collapsed || key !== "anchor" ? 1 : -1;
      mapped[key] = this.mapPresentationPosition(
        live,
        target,
        value,
        association,
        fallbackMapping.map(value, association),
      );
    }

    try {
      if (
        json.type === "text" &&
        (
          typeof mapped.anchor !== "number" ||
          typeof mapped.head !== "number" ||
          !target.resolve(mapped.anchor).parent.inlineContent ||
          !target.resolve(mapped.head).parent.inlineContent
        )
      ) {
        return selection.map(target, fallbackMapping);
      }
      return Selection.fromJSON(target, mapped);
    } catch {
      return selection.map(target, fallbackMapping);
    }
  }

  private presentationTargetForSave(
    live: PMNode,
    persistedTarget: PMNode,
  ): PMNode {
    const presentationTarget = normalizeDocForSave(live, {
      mode: "presentation",
    });
    const persistedFromPresentation = normalizeDocForSave(
      presentationTarget,
    );
    if (!persistedFromPresentation.eq(persistedTarget)) {
      throw new Error(
        "save presentation normalization diverged from persisted semantics",
      );
    }
    return presentationTarget;
  }

  /**
   * Make durable save-time normalization visible in the one live ProseMirror
   * state before bytes are written. Presentation-only empty blocks and marked
   * edge whitespace remain in the target. One bounding PM replacement keeps
   * reconciliation linear; the explicit structural selection projection
   * prevents that replacement from swallowing a cursor in a stable block.
   * ProseMirror remains the sole state and DOM reconciler.
   */
  private reconcileLiveDocForSave(target: PMNode): PMNode {
    if (!this.pmView) throw new Error("editor is not available");
    const live = this.pmView.state.doc;
    if (live.eq(target)) return live;

    const start = live.content.findDiffStart(target.content);
    const rawEnd = live.content.findDiffEnd(target.content);
    if (start === null || rawEnd === null) {
      throw new Error("save normalization changed semantics without a PM diff");
    }

    // findDiffEnd is measured backward from each differently-sized Fragment.
    // When the common prefix/suffix overlap (notably a trailing block delete),
    // shift both endpoints by the overlap before slicing the target.
    let liveEnd = rawEnd.a;
    let targetEnd = rawEnd.b;
    const overlap = start - Math.min(liveEnd, targetEnd);
    if (overlap > 0) {
      liveEnd += overlap;
      targetEnd += overlap;
    }
    const originalSelection = this.pmView.state.selection;
    const storedMarks = this.pmView.state.storedMarks;
    const tr = this.pmView.state.tr.replace(
      start,
      liveEnd,
      target.slice(start, targetEnd),
    );
    tr.setSelection(this.presentationSelection(
      live,
      tr.doc,
      originalSelection,
      tr.mapping,
    ));
    // Adding a replace step clears Transaction.storedMarks. Preserve both an
    // active mark set and the meaningful empty set used to keep formatting
    // toggled off at a cursor inside marked text.
    if (storedMarks !== null) tr.setStoredMarks(storedMarks);
    tr.setMeta("addToHistory", false);
    tr.setMeta(RAW_BLOCK_SYNC_META, true);
    this.suppressChange = true;
    try {
      this.pmView.dispatch(tr);
    } finally {
      this.suppressChange = false;
    }

    const reconciled = this.pmView.state.doc;
    if (!reconciled.eq(target)) {
      throw new Error("live editor did not accept exact save normalization");
    }
    return reconciled;
  }

  /**
   * Exact validation is Butter's responsibility; persistence, external-change
   * merge, own-write suppression, unload clearing, and File Recovery remain
   * owned by Obsidian's TextFileView. The staged value guarantees that
   * super.save() writes the exact string that passed preflight.
   */
  override save(clear = false): Promise<void> {
    return this.enqueueNativeFileOperation(() => this.performNativeSave(clear));
  }

  private enqueueNativeFileOperation(operation: () => Promise<void>): Promise<void> {
    const run = this.saveQueue.then(operation, operation);
    this.saveQueue = run.catch(() => undefined);
    return run;
  }

  private async performNativeSave(clear: boolean): Promise<void> {
    if (!this.pmView || !this.file || this.destroyed) {
      await super.save(clear);
      return;
    }
    const file = this.file;
    const doc = this.pmView.state.doc;
    const generation = this.editGeneration;
    // requestSave() and the immediate/ceiling scheduler deliberately share
    // this adapter. Whichever reaches the native writer second must be a
    // cheap no-op once the same edit generation is already durable.
    if (!clear && generation === this.persistedGeneration) return;
    const exact = this.exactSaveCandidate(doc);
    const presentationTarget = this.presentationTargetForSave(
      doc,
      exact.normalizedDoc,
    );
    const saveDoc = this.reconcileLiveDocForSave(presentationTarget);
    const candidate = exact.text;
    this.preparedSave = { doc: saveDoc, text: candidate };
    try {
      await super.save(clear);
    } catch (error) {
      // TextFileView consumes its private dirty flag before starting I/O. If
      // the write then fails, re-arm that native flag immediately so an
      // external reload cannot mistake the unsaved PM projection for clean.
      // SaveScheduler separately retains the retry/error boundary.
      if (!clear && this.file === file && !this.destroyed) this.requestSave();
      throw error;
    } finally {
      this.preparedSave = null;
    }
    if (clear || this.file !== file || this.data !== candidate) return;
    this.acceptedViewData = candidate;
    this.lastBlockedDoc = null;
    this.reportSaveResult?.({ kind: "clean" });
    if (this.editGeneration === generation) this.persistedGeneration = generation;
  }

  getViewData(): string {
    if (!this.pmView) return this.acceptedViewData ?? this.data;
    if (this.preparedSave?.doc === this.pmView.state.doc) {
      return this.preparedSave.text;
    }
    return this.exactViewData(this.pmView.state.doc);
  }

  /**
   * Install the DOM-event triggers that ask the save scheduler to
   * flush immediately rather than waiting out the idle window.
   * Tracks handlers in `schedulerListeners` so onClose() can
   * remove them cleanly.
   *
   * Triggers wired:
   *   - Document `mousedown` (capture) - user clicked anywhere
   *     OUTSIDE this editor's DOM (file tree, tab bar, ribbon,
   *     status bar, another note's editor). Flushes immediately
   *     so sync / collab / backup systems see the latest bytes
   *     the moment the user's attention has moved on.
   *   - Window `blur` - the whole Obsidian window lost focus
   *     (user switched to another app). On desktop Electron this
   *     is DISTINCT from visibilitychange (which doesn't always
   *     fire when Obsidian stays visible in the background).
   *   - `visibilitychange → hidden` - tab/window fully hidden.
   *     Still useful for minimized windows + mobile browsers.
   *   - `beforeunload` - window is about to close. Best-effort
   *     synchronous flush.
   *
   * Removed: editor-scoped blur listener. The document-level
   * mousedown covers "focus left the editor" more reliably than
   * relying on focusable-descendant blur events firing.
   */
  private installSchedulerTriggers() {
    if (!this.pmView || !this.saveScheduler) return;
    const scheduler = this.saveScheduler;

    const onDocMouseDown = (event: MouseEvent) => {
      if (this.destroyed || !this.pmView) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      // Click landed inside this editor's own DOM → user is still
      // editing here, don't flush.
      if (this.pmView.dom.contains(target)) return;
      // Click landed elsewhere in Obsidian (file tree, tab bar,
      // sidebar, another note, etc.) - flush whatever's pending
      // so the bytes on disk match what the user was just writing.
      if (scheduler.hasPending()) void scheduler.flush();
    };
    activeDocument.addEventListener("mousedown", onDocMouseDown, true);
    this.schedulerListeners.push(() =>
      activeDocument.removeEventListener("mousedown", onDocMouseDown, true),
    );

    const onWindowBlur = () => {
      if (scheduler.hasPending()) void scheduler.flush();
    };
    window.addEventListener("blur", onWindowBlur);
    this.schedulerListeners.push(() =>
      window.removeEventListener("blur", onWindowBlur),
    );

    const onVisibility = () => {
      if (activeDocument.visibilityState === "hidden" && scheduler.hasPending()) {
        void scheduler.flush();
      }
    };
    activeDocument.addEventListener("visibilitychange", onVisibility);
    this.schedulerListeners.push(() =>
      activeDocument.removeEventListener("visibilitychange", onVisibility),
    );

    const onBeforeUnload = () => {
      if (scheduler.hasPending()) void scheduler.flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    this.schedulerListeners.push(() =>
      window.removeEventListener("beforeunload", onBeforeUnload),
    );
  }

  /** Apply a plugin/shim-authored Markdown replacement as a local PM edit.
   *
   * This deliberately does not call setViewData(): that method represents a
   * host/file load and advances the persisted source baseline. Treating a
   * local replacement as persisted caused later saves to splice against bytes
   * that had never reached disk. */
  private replaceLocalMarkdown(markdown: string): void {
    if (!this.pmView) return;
    const parsed = parser.parseWithSourceMap(markdown);
    if (!parsed?.doc || this.hasRawBlock(parsed.doc)) {
      new Notice(
        `${tx("Butter: save failed -")} invalid plugin Markdown`,
        6000,
      );
      return;
    }
    const replacement = ensureBlockIds(parsed.doc);
    const tr = this.pmView.state.tr.replaceWith(
      0,
      this.pmView.state.doc.content.size,
      replacement.content,
    );
    this.pmView.dispatch(tr);
  }

  setViewData(data: string, clear: boolean) {
    const previousData = this.acceptedViewData;
    if (!clear && previousData !== null && data === previousData) {
      this.data = data;
      return;
    }

    if (clear) {
      this.saveScheduler?.cancel();
      this.editGeneration = 0;
      this.persistedGeneration = 0;
      this.lastBlockedDoc = null;
      this.pendingPropertyDraft = false;
      this.pendingPropertyKeyFocus = null;
      this.pendingPropertyValueFocus = null;
    }
    this.data = data;
    this.acceptedViewData = data;
    const body = this.stripFrontmatter(data);
    this.renderProperties();
    if (this.inlineTitleEl && this.file) {
      this.inlineTitleEl.textContent = this.file.basename;
      if (clear) (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
      if (clear && !body.trim()) {
        window.requestAnimationFrame(() => {
          const el = this.inlineTitleEl;
          if (!el) return;
          el.focus();
          const range = activeDocument.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        });
      }
    }
    if (!this.pmView) return;

    // External change (vault sync, git pull, another plugin edited
    // the file). Apply as a content replace transaction instead of
    // tearing down the whole EditorState - that keeps PM's undo
    // history and plugin state intact across the sync.
    let syncResult: ReturnType<typeof parser.parseWithSourceMap> | null = null;
    let syncFailure: unknown = null;
    try {
      syncResult = parser.parseWithSourceMap(body);
    } catch (error) {
      syncFailure = error;
      recordError(
        "external-reload",
        error instanceof Error ? error.message : String(error),
      );
    }
    const parsedDoc = syncResult?.doc ?? parser.rawBlockFallbackDocument(
      body,
      syncFailure instanceof Error
        ? `file reload parse failed: ${syncFailure.message}`
        : "file reload could not be parsed",
    );
    const newDoc = ensureBlockIds(
      clear
        ? parsedDoc
        : retainUnchangedBlockIds(this.pmView.state.doc, parsedDoc),
    );
    this.captureSourceState(body, newDoc);

    // Pre-stage the entrance animation BEFORE the PM dispatch so
    // the first paint already has the first 15 children at the
    // animation's `from` visuals (opacity:0 + 8px translate). Without
    // this, content paints at full opacity for ~2 frames before the
    // double-rAF below adds `.butter-just-loaded` and snaps it to
    // hidden - a visible flash on every note open. Skipped entirely
    // when the user has disabled animations.
    const animsOff = this.plugin.settings.disableAnimations;
    const animEl = animsOff ? null : this.contentEl;
    if (animEl) {
      animEl.classList.remove("butter-just-loaded");
      animEl.classList.add("butter-anim-prepped");
    }

    this.suppressChange = true;
    try {
      if (clear) {
        // A different file must not inherit history, plugin state, source
        // identity, or selection from the prior file even when the bytes are
        // coincidentally identical.
        this.pmView.updateState(EditorState.create({
          doc: newDoc,
          schema,
          plugins: this.pmView.state.plugins,
        }));
      } else {
        const previousDoc = this.pmView.state.doc;
        const previousSelection = this.pmView.state.selection;
        const storedMarks = this.pmView.state.storedMarks;
        const tr = this.pmView.state.tr.replaceWith(
          0,
          previousDoc.content.size,
          newDoc.content,
        );
        tr.setSelection(selectionThroughRetainedBlocks(
          previousDoc,
          tr.doc,
          previousSelection,
          tr.mapping,
        ));
        if (storedMarks !== null) tr.setStoredMarks(storedMarks);
        tr.setMeta("addToHistory", false);
        // Trusted-sync marker - raw-block safety plugin allows this
        // transaction through because newDoc came from fresh file bytes.
        tr.setMeta(RAW_BLOCK_SYNC_META, true);
        this.pmView.dispatch(tr);
      }
    } catch {
      // Replace failed (e.g. schema mismatch). Fall back to hard reset.
      this.pmView.updateState(
        EditorState.create({
          doc: newDoc,
          schema,
          plugins: this.pmView.state.plugins,
        }),
      );
    } finally {
      this.suppressChange = false;
    }

    // Run the entrance animation after PM has dispatched. The prep
    // class set above is holding the first 15 children at opacity:0
    // through this rAF window; on the second frame we swap to the
    // animation class, which shares the same `from` visuals so the
    // transition is seamless. Double-rAF rather than single because
    // class removal needs a paint cycle before the re-add to count
    // as a fresh animation start (a single-rAF swap collapses to a
    // no-op in the browser's animation diffing).
    if (animEl) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          animEl.classList.remove("butter-anim-prepped");
          animEl.classList.add("butter-just-loaded");
          window.setTimeout(() => animEl.classList.remove("butter-just-loaded"), 1100);
        });
      });
    }
  }

  /**
   * Handle navigation requests from the rest of Obsidian - including
   * clicks on headings in the native Outline core plugin, Graph
   * back-links, Search results, Command-palette line jumps, and any
   * third-party plugin that uses `leaf.openFile(file, { eState })`.
   *
   * `eState.line` (and optionally `eState.col`) is Obsidian's standard
   * shape. We translate the line number to a PM position by walking
   * the serialized markdown, then place the caret there.
   */
  setEphemeralState(state: unknown): void {
    (super.setEphemeralState as ((state: unknown) => void) | undefined)?.(state);
    if (!state) return;
    if (!this.pmView) {
      this.pendingEphemeralState = state;
      return;
    }
    this.applyEphemeralState(state);
  }

  private applyEphemeralState(state: unknown) {
    if (!this.pmView || !state) return;
    const viewportAnchor = (state as Record<string, unknown>)[
      BUTTER_VIEWPORT_STATE_KEY
    ];
    if (isButterViewportAnchor(viewportAnchor)) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          this.restoreViewportAnchor(viewportAnchor);
        });
      });
      return;
    }
    const lineRaw = (state as { line?: unknown }).line;
    const line = typeof lineRaw === "number" ? lineRaw : undefined;
    if (line == null) return;

    const md = this.frontmatter + serializer.serialize(this.pmView.state.doc);
    const lines = md.split("\n");
    // Walk outward from the requested line to find a nearby non-empty
    // probe: the target line might be empty (blank line), a fence
    // marker, or inside frontmatter, in which case the block we want
    // is usually on an adjacent line.
    const nearbyLineText = (idx: number): string | null => {
      for (let delta = 0; delta <= 3; delta++) {
        for (const sign of delta === 0 ? [0] : [-1, 1]) {
          const i = idx + sign * delta;
          if (i < 0 || i >= lines.length) continue;
          const t = lines[i] ?? "";
          if (t.trim()) return t;
        }
      }
      return null;
    };
    const lineText = nearbyLineText(line) ?? "";
    const probe = lineText
      .replace(/^#+\s*/, "")
      .replace(/^-\s*(\[[ x]\]\s*)?/, "")
      .slice(0, 40)
      .trim();
    if (!probe) return;

    let hitPos: number | null = null;
    this.pmView.state.doc.descendants((node, pos) => {
      if (hitPos !== null) return false;
      if (!node.isTextblock) return true;
      if (node.textContent.includes(probe)) {
        hitPos = pos + 1;
        return false;
      }
      return false;
    });
    if (hitPos !== null) {
      const size = this.pmView.state.doc.content.size;
      const clamped = Math.min(hitPos, size);
      const sel = Selection.near(this.pmView.state.doc.resolve(clamped));
      this.pmView.dispatch(this.pmView.state.tr.setSelection(sel).scrollIntoView());
      this.pmView.focus();
    }
  }

  clear() {
    this.data = "";
    this.frontmatter = "";
    this.pendingPropertyDraft = false;
    this.pendingPropertyKeyFocus = null;
    this.pendingPropertyValueFocus = null;
    if (this.propertiesComponent) {
      this.propertiesComponent.unload();
      this.propertiesComponent = null;
    }
    if (this.propertiesEl) {
      this.propertiesEl.empty();
      this.propertiesEl.addClass("butter-hidden");
    }
    if (this.pmView) {
      this.suppressChange = true;
      const doc = ensureBlockIds(
        schema.node("doc", null, [schema.node("paragraph")]),
      );
      this.pmView.updateState(
        EditorState.create({
          doc,
          schema,
          plugins: this.pmView.state.plugins,
        }),
      );
      this.suppressChange = false;
    }
  }
}
