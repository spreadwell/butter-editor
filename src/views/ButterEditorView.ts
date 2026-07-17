import {
  TextFileView,
  Component,
  setIcon,
  Menu,
  MenuItem,
  Notice,
  Platform,
  WorkspaceLeaf,
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
  mobileLayoutDefault,
  mobileTableLayoutDefault,
} from "../ui/toolbar-layout";
export type { ToolbarLayoutItem };
import { slashMenuPlugin } from "../ui/slash-menu";
import { pasteDropPlugin } from "../editor/paste-drop";
import { overlapResolverPlugin } from "../core/overlap-resolver";
import { suggestBridgePlugin } from "../util/suggest-bridge";
import { cm6BridgePlugins } from "../integration/cm6-bridge";
import { tableEditingPlugins } from "../editor/table-editing";
import { tableToolbarPlugin } from "../editor/table-toolbar";
import type { Node as PMNode } from "prosemirror-model";
import {
  docAtomFingerprint,
  firstFingerprintDivergence,
} from "../core/doc-fingerprint";
import { normalizeDocForSave } from "../core/doc-normalize";
import { checkboxPlugin } from "../editor/checkbox-plugin";
import { commentOnlyParagraphPlugin } from "../editor/comment-only-paragraph";
import { listNumberingPlugin } from "../editor/list-numbering";
import { selectionOverlayPlugin } from "../editor/selection-overlay";
import { multiBlockSelectPlugin } from "../editor/multi-block-select";
import { listOperationsPlugin } from "../editor/list-operations";
import { searchPlugin } from "../editor/search-plugin";
import { codeHighlightPlugin } from "../editor/code-highlight";
import { imageView } from "../editor/image-view";
import { PMEditorShim } from "../util/editor-shim";
import {
  type SaveState,
} from "../ui/save-status";
import { dragHandlesPlugin } from "../editor/drag-handles";
import { blockSpacingPlugin } from "../editor/block-spacing";
import { blockIdStamperPlugin } from "../editor/block-id-stamper";
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
import { tx, tv } from "../i18n";
import { SaveScheduler } from "../ui/save-scheduler";
import { suppressNativeMobileToolbar } from "../ui/mobile-native-toolbar";
import { scrollHostTop, runClipboardCommand } from "../util/dom-utils";
import { mountLicenseBanner, type LicenseBanner } from "../ui/license-banner";
import {
  NodeViewManager,
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

export const VIEW_TYPE_BUTTER = "butter-editor";
export const VIEW_TYPE_BUTTER_LOCKED = "butter-locked-file";
import type ButterEditorPlugin from "../main";
import { cycleView, modeIcon, refreshButterMobileBodyClass, StatusState } from "../main";
import type { ButterSettings } from "../main";

export class ButterEditorView extends TextFileView {
  private pmView: EditorView | null = null;
  private nodeViewManager: NodeViewManager | null = null;
  private propertiesEl: HTMLElement | null = null;
  private inlineTitleEl: HTMLElement | null = null;
  private toolbarDom: HTMLElement | null = null;
  /** Re-renders the main toolbar from the current layout settings.
   *  Invoked from the settings tab after a customizer edit. */
  private rebuildMainToolbar: (() => void) | null = null;
  private frontmatter: string = "";
  /** Line-ending style of the file as it was on disk. Preserved so
   *  a CRLF source (typical on Windows-authored / git-autocrlf vaults)
   *  is saved back as CRLF - without this, every save rewrites every
   *  line and shows up as a whole-file diff in git. */
  private lineEnding: "\n" | "\r\n" = "\n";
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
  /** Set by `installMobileToolbarBehavior` to a callback that
   *  re-applies the editable state to PM. Drag-handles' tap-to-
   *  focus path calls this to flip the lock open. */
  public mobileSetEditable: ((editable: boolean) => void) | null = null;
  /** If setEphemeralState fires before PM finishes mounting (common
   *  on view-type swaps), we stash the state and replay it right
   *  after the PM view is live. */
  private pendingEphemeralState: unknown = null;
  /** License-required banner mounted at the top of the editor when
   *  status is anything other than valid/trial. Lazily attached on
   *  view open, refreshed by the `butter:license-changed` workspace
   *  event, destroyed on view close. */
  private licenseBanner: LicenseBanner | null = null;
  /** Cached full-doc markdown, keyed by PM doc reference. Invalidated
   *  whenever the doc changes (new reference). Saves re-serializing
   *  when multiple code paths ask for the same view data in one frame
   *  (save + echo-check, etc.). */
  private markdownCache: { doc: unknown; text: string } | null = null;
  /** Timestamp (Date.now()) of the last doc mutation - kept for
   *  diagnostics / status-bar readouts. Save-scheduling proper is
   *  owned by {@link saveScheduler}. */
  private lastEditTime = 0;
  /** Debouncer that coordinates save-to-disk timing across typing
   *  bursts, continuous editing, blur, tab-hide, and unload. See
   *  src/save-scheduler.ts for the full model. Bound to
   *  {@link requestSave} so any trigger path goes through the
   *  single save entry point. Initialized lazily on first PM
   *  mount because requestSave needs the view to exist. */
  private saveScheduler: SaveScheduler | null = null;
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
            enableMarkdownShortcuts: this.settings.enableMarkdownShortcuts,
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

    // Mirrors Obsidian's `hasKeyboardVisible` flag in `J6` (the
    // native mobile-toolbar class). Flipped to true on
    // keyboardWillShow, false on keyboardWillHide - except when
    // `e.hasPhysicalKeyboard` is set (hardware keyboard:
    // Obsidian's native toolbar stays visible in that case, so we
    // do too by leaving the flag at its prior state).
    let hasKeyboardVisible = false;

    const focusIsInEditorOrToolbar = (): boolean => {
      const active = activeDocument.activeElement;
      if (!(active instanceof Element)) return false;
      // Toolbar-button taps briefly steal focus from the editor;
      // treat focus-on-toolbar as "still editing" so the bar
      // doesn't self-hide on tap.
      return editorDom.contains(active) || toolbarDom.contains(active);
    };

    const updateState = () => {
      const focused = focusIsInEditorOrToolbar();
      // Mirror Obsidian's update logic. iOS: focus is enough;
      // Android: also require the keyboard to be visible.
      const shouldShow =
        focused &&
        (!(Platform as { isAndroidApp?: boolean }).isAndroidApp ||
          hasKeyboardVisible);
      toolbarDom.classList.toggle(VISIBLE_CLASS, shouldShow);
      refreshButterMobileBodyClass();
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

  public applyToolbarPosition() {
    if (Platform.isMobile) return; // mobile keeps body-attached behavior
    const leaf = this.containerEl; // .workspace-leaf-content (header + content)
    const content = this.contentEl; // .view-content
    if (!leaf || !content || !this.toolbarDom) return;

    const bannerActive = !(this.plugin.licenseStatus === "valid" || this.plugin.licenseStatus === "trial");
    const style = bannerActive ? "attached" : this.settings.toolbarStyle;
    const pos = bannerActive ? "top" : this.settings.toolbarPosition;
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

    // Tear down integrated state from a previous style switch - the
    // marker class on view-header and any inline-title display
    // override need to come off before re-applying anything else.
    const viewHeader = leaf.querySelector<HTMLElement>(".view-header");
    const inlineTitle = content.querySelector<HTMLElement>(".inline-title");
    if (viewHeader && style !== "integrated") {
      viewHeader.classList.remove("butter-integrated-header");
    }
    if (inlineTitle && style !== "integrated") {
      inlineTitle.style.removeProperty("display");
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
      // Inline-title visibility tracks the integrated-show-title
      // setting. Hidden state survives toolbar re-applies because we
      // set inline display:none (CSS doesn't compete).
      if (inlineTitle) {
        inlineTitle.style.display = this.settings.integratedShowTitle
          ? ""
          : "none";
      }
      // View-header's own title-container also tracks the setting
      // it's the "pill" the user sees. CSS handles visibility via
      // an attr we set on view-header.
      viewHeader.dataset.butterShowTitle = this.settings.integratedShowTitle
        ? "1"
        : "0";
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
  // No tab icon. TextFileView's default `getIcon()` returns "document"
  // so a Butter tab would otherwise show that. Returning an empty
  // string tells Obsidian's tab UI to render no icon, giving the tab
  // a clean text-only label that matches what's wanted here.
  getIcon(): string {
    return "";
  }

  // ── Frontmatter ──

  private stripFrontmatter(data: string): string {
    // Capture byte-level file metadata for round-trip preservation.
    //   - BOM: rare but legitimate (some foreign tooling produces it);
    //     preserve rather than silently strip.
    //   - Line endings: CRLF vs LF. Recaptured on save per-file.
    //   - Trailing newlines: 0, 1, 2+ - preserve verbatim.
    this.originalHasBOM = data.charCodeAt(0) === 0xfeff;
    if (this.originalHasBOM) data = data.slice(1);
    this.lineEnding = data.includes("\r\n") ? "\r\n" : "\n";

    // Eat ALL trailing newlines after the closing `---`, not just
    // one. Many vaults store a blank line between frontmatter and
    // the first heading. If we capture only one newline, the blank
    // line gets parsed as part of the body, serialized away, and
    // the reassembled save is missing it - which looks like a
    // whole-file diff in git / Obsidian Sync on every save. By
    // folding the separator newlines into the preserved frontmatter
    // string, they're re-emitted byte-identically on save.
    let body: string;
    const match = data.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)*/);
    if (match) {
      this.frontmatter = match[0];
      body = data.slice(match[0].length);
    } else {
      this.frontmatter = "";
      body = data;
    }

    // Count trailing newlines in the body (normalized LF). Used on
    // save to emit exactly the same trailing-byte state.
    const bodyNormalized = body.replace(/\r\n/g, "\n");
    const m = bodyNormalized.match(/\n*$/);
    this.originalTrailingNewlines = m ? m[0].length : 0;

    return body;
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
    this.propertiesEl.empty();
    if (this.propertiesComponent) {
      this.propertiesComponent.unload();
      this.propertiesComponent = null;
    }
    if (!this.frontmatter || !this.file) {
      this.propertiesEl.addClass("butter-hidden");
      return;
    }
    const vis = this.plugin.settings.frontmatterVisibility;
    const shouldHide = vis === "hidden" ||
      (vis === "match" && this.app.vault.getConfig?.("propertiesInDocument") === "hidden");
    if (shouldHide) {
      this.propertiesEl.addClass("butter-hidden");
      return;
    }
    this.propertiesEl.removeClass("butter-hidden");
    const cache = this.app.metadataCache.getFileCache(this.file);
    const fmRaw: unknown = cache?.frontmatter;
    const fm = (fmRaw && typeof fmRaw === "object" ? fmRaw : null) as
      | Record<string, unknown>
      | null;
    if (!fm) {
      this.propertiesEl.addClass("butter-hidden");
      return;
    }
    this.propertiesEl.removeClass("butter-hidden");
    this.propertiesComponent = new Component();
    this.propertiesComponent.load();

    const propCount = Object.keys(fm).filter((k) => k !== "position").length;
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

    /** Render any frontmatter value to a flat string for input fields.
     *  Skips deep stringification of plain objects (which would yield
     *  the useless `[object Object]`) by returning empty for those. */
    const fmValueToString = (v: unknown): string => {
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      return ""; // arrays / plain objects shouldn't be flattened here
    };
    for (const [key, value] of Object.entries(fm)) {
      if (key === "position") continue;
      const { type, icon } = this.getPropertyType(key, value);
      const prop = properties.createDiv({
        cls: "metadata-property",
        attr: {
          "data-property-key": key.toLowerCase(),
          "data-property-type": type,
          tabIndex: 0,
        },
      });

      const showPropertyMenu = (e: MouseEvent) => {
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
          item.setTitle(tx("Cut")).setIcon("lucide-scissors").onClick(() =>
            runClipboardCommand(activeDocument, "cut"),
          );
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item.setTitle(tx("Copy")).setIcon("lucide-copy").onClick(() =>
            runClipboardCommand(activeDocument, "copy"),
          );
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item.setTitle(tx("Paste")).setIcon("lucide-clipboard-check").onClick(
            () => runClipboardCommand(activeDocument, "paste"),
          );
          item.setSection?.("clipboard");
        });
        menu.addItem((item: MenuItem) => {
          item
            .setTitle(tx("Remove"))
            .setIcon("lucide-trash-2")
            .onClick(() => {
              void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                delete fm[key];
              });
              window.setTimeout(() => this.renderProperties(), 100);
            });
          item.setWarning?.(true);
          item.setSection?.("danger");
        });
        menu.setParentElement?.(prop);
        menu.showAtMouseEvent(e);
      };
      prop.addEventListener("contextmenu", showPropertyMenu);

      const iconEl = prop.createDiv({ cls: "metadata-property-icon" });
      setIcon(iconEl, icon);
      iconEl.addEventListener("click", (e) => {
        e.preventDefault();
        if (!prop.hasClass("has-active-menu")) showPropertyMenu(e);
      });

      const keyEl = prop.createDiv({ cls: "metadata-property-key" });
      const keyInput = keyEl.createEl("input", {
        cls: "metadata-property-key-input",
        value: key,
        type: "text",
        attr: { autocapitalize: "none", enterkeyhint: "next" },
      });
      keyInput.addEventListener("blur", () => {
        const newKey = keyInput.value.trim();
        if (!newKey) {
          keyInput.value = key;
          return;
        }
        if (newKey !== key) {
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[newKey] = fm[key];
            delete fm[key];
          });
          window.setTimeout(() => this.renderProperties(), 100);
        }
      });
      keyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          keyInput.blur();
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
              void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
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
            void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
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
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[key] = cb.checked;
          });
        });
      } else if (type === "date" || type === "datetime") {
        const dateInput = valContainer.createEl("input", {
          cls: `metadata-input metadata-input-text mod-${type}`,
          type: type === "datetime" ? "datetime-local" : "date",
          value: fmValueToString(value).slice(0, type === "datetime" ? 16 : 10),
          attr: { tabIndex: 0 },
        });
        dateInput.addEventListener("change", () => {
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[key] = dateInput.value;
          });
        });
      } else if (type === "number") {
        const numInput = valContainer.createEl("input", {
          cls: "metadata-input metadata-input-number",
          type: "number",
          value: fmValueToString(value),
          attr: { tabIndex: 0 },
        });
        numInput.addEventListener("change", () => {
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
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
          void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
            fm[key] = textInput.value;
          });
        });
      }
    }

    const addBtn = content.createDiv({
      cls: "metadata-add-button text-icon-button",
      attr: { tabIndex: 0 },
    });
    const addBtnIcon = addBtn.createSpan({ cls: "text-button-icon" });
    setIcon(addBtnIcon, "lucide-plus");
    addBtn.createSpan({ cls: "text-button-label", text: tx("Add property") });
    addBtn.addEventListener("click", () => {
      void app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        let k = "property";
        let i = 1;
        while (fm[k] !== undefined) k = `property${i++}`;
        fm[k] = "";
      });
      window.setTimeout(() => this.renderProperties(), 100);
    });
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
          plugin.settings.toolbarPosition = p;
          await plugin.saveSettings();
          plugin.applyToolbarPositionToAllViews();
        };
        const setStyle = async (s: "attached" | "detached") => {
          plugin.settings.toolbarStyle = s;
          await plugin.saveSettings();
          plugin.applyToolbarPositionToAllViews();
        };
        menu.addItem((item) => {
          item.setTitle(tx("Position"));
          item.setIcon("move-vertical");
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
      activeDocument.body.appendChild(toolbarDom);
    } else {
      this.applyToolbarPosition();
    }
    this.refreshContentPaddingVar();

    const getSourcePath = () => this.file?.path ?? "";
    const getFile = () => this.file ?? null;

    const body = this.stripFrontmatter(this.data ?? "");
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
    try {
      result = parser.parseWithSourceMap(body);
    } catch (err) {
      console.error(
        "[butter-editor] parser.parseWithSourceMap threw on this file. Falling back to empty doc; source is preserved on disk.",
        err,
      );
    }
    const doc = result?.doc || schema.node("doc", null, [schema.node("paragraph")]);
    this.captureSourceState(body, result?.doc ?? null);

    this.nodeViewManager = new NodeViewManager();
    const mgr = this.nodeViewManager;

    const plugins = [
      toolbarPlugin,
      autocompletePlugin(this.app, schema),
      slashMenuPlugin(this.app, schema),
      buildInputRules(schema, {
        enableMarkdownShortcuts: this.settings.enableMarkdownShortcuts,
      }),
      buildKeymap(schema),
      blockIdStamperPlugin(),
      blockSpacingPlugin(),
      commentOnlyParagraphPlugin(),
      checkboxPlugin(),
      listNumberingPlugin(),
      multiBlockSelectPlugin({
        app: this.app,
        serializeNode: (node) =>
          serializer.serialize(schema.node("doc", null, [node])),
      }),
      selectionOverlayPlugin(),
      listOperationsPlugin(),
      codeHighlightPlugin(this.app),
      searchPlugin(),
      dragHandlesPlugin({
        app: this.app,
        serializeNode: (node) =>
          serializer.serialize(schema.node("doc", null, [node])),
        dragHandleVisibility: () => this.settings.dragHandleVisibility,
        dragMotion: () => this.settings.dragMotion,
        dragTriggerBias: () => this.settings.blockDragSensitivity,
        disableAnimations: () => this.settings.disableAnimations,
        unlockMobileEditable: () => this.mobileSetEditable?.(true),
        chromeBottom: () => {
          const header = this.containerEl?.querySelector<HTMLElement>(".view-header");
          const stack = this.containerEl?.querySelector<HTMLElement>(".butter-toolbar-stack");
          const tableBar = stack?.querySelector<HTMLElement>(".butter-table-toolbar:not(.is-hidden)");
          const hb = header?.getBoundingClientRect().bottom ?? 0;
          const sb = stack?.getBoundingClientRect().bottom ?? 0;
          const tb = tableBar?.getBoundingClientRect().bottom ?? 0;
          const toolbarPosition = this.containerEl?.getAttribute("data-toolbar-pos") === "bottom"
            ? "bottom"
            : "top";
          return editorTopChromeBottom(toolbarPosition, hb, sb, tb);
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
      clickToSpawnPlugin(() => this.mobileSetEditable?.(true)),
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
      contextMenuPlugin(schema),
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

    if (this.settings.enableCM6Bridge) {
      plugins.push(
        ...cm6BridgePlugins(this.app, {
          serialize: (d) => serializer.serialize(d),
          parse: (md) => parser.parse(md),
          schema,
        }),
      );
    }

    plugins.push(
      new PMPlugin({
        view: () => ({
          update: (view, prevState) => {
            if (this.suppressChange) return;
            if (!view.state.doc.eq(prevState.doc)) {
              this.lastEditTime = Date.now();
              // Route every edit through the scheduler; it manages
              // idle + ceiling + event-driven flush triggers.
              this.saveScheduler?.onEdit();
            }
          },
        }),
      }),
    );

    // EditorState.create runs PM's content validation which recursively
    // walks fillBefore / createAndFill. On our schema's content graph
    // that recursion sits near Electron's stack limit (Node's is much
    // larger - tests don't trip it). Certain doc shapes can blow past
    // it. Wrap in try/catch + fall back to an empty paragraph doc so
    // a single bad parse doesn't take the entire plugin offline. The
    // file's source remains on disk untouched; user can reload after
    // we ship the underlying schema-graph fix.
    let state: EditorState;
    try {
      state = EditorState.create({ doc, schema, plugins });
    } catch (err) {
      console.error(
        "[butter-editor] EditorState.create threw (likely PM fillBefore stack overflow on this doc). Falling back to empty paragraph doc.",
        err,
      );
      const fallback = schema.node("doc", null, [schema.node("paragraph")]);
      state = EditorState.create({ doc: fallback, schema, plugins });
    }

    const pmView = new EditorView(editorRoot, {
      state,
      editable: () => this.isEditable(),
      // Identify the contenteditable region to assistive tech.
      // role=textbox + aria-multiline distinguishes it from a one-
      // line input. No `aria-label` because Obsidian's tooltip
      // system renders aria-label as a hover tooltip - on a giant
      // editing surface that becomes constant visual noise. SR users
      // still get sensible behavior via role + context.
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
      },
      nodeViews: {
        code_block: codeBlockView(this.app, getSourcePath, mgr, this),
        obsidian_embed: embedView(this.app, getSourcePath, mgr, this),
        obsidian_embed_inline: embedInlineView(this.app, getSourcePath, mgr, this),
        obsidian_callout: calloutView(this.app, getSourcePath, mgr, this),
        math_block: mathBlockView(this.app, getSourcePath, mgr, this),
        inline_math: inlineMathView(this.app, getSourcePath, mgr, this),
        wikilink: wikilinkView(this.app, getSourcePath),
        obsidian_tag: tagView(this.app),
        block_comment: blockCommentView(),
        inline_footnote: inlineFootnoteView(),
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
        this.setViewData(newMarkdown, false);
        this.lastEditTime = Date.now();
        this.saveScheduler?.onEdit();
      }
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
    this.saveScheduler = new SaveScheduler(() => {
      // Wrap the scheduler-driven save in async error capture. Without
      // this, an async vault.modify rejection (disk full, file locked
      // by sync clients, network drive drop, EACCES) silently escapes
      // to the event loop as an unhandled promise rejection - the user
      // sees nothing while their typing piles up unsaved.
      void (async () => {
        try {
          await this.save();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recordError("save", `vault.modify failed: ${msg}`);
          new Notice(`${tx("Butter: save failed -")} ${msg}`);
        }
      })();
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
    this.destroyed = true;
    // Tear down the license banner. registerEvent handles the
    // workspace listener cleanup automatically.
    if (this.licenseBanner) {
      this.licenseBanner.destroy();
      this.licenseBanner = null;
    }
    // Flush pending save NOW so we don't lose the user's most
    // recent typing when the view closes (common on file switch).
    if (this.saveScheduler) {
      this.saveScheduler.flush();
      this.saveScheduler = null;
    }
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

  getViewData(): string {
    if (!this.pmView) return this.data;
    return this.serializeCurrent();
  }

  /**
   * Memoized serialization. On large docs a full serialize is the
   * main cost of save, so we cache by PM doc reference and reuse the
   * string on any subsequent call that sees the same doc - avoids
   * repeat work when Obsidian + our own code both ask for viewData
   * in the same frame (save + echo-check, etc).
   */
  private serializeCurrent(): string {
    if (!this.pmView) return this.data;
    const rawDoc = this.pmView.state.doc;
    if (this.markdownCache && this.markdownCache.doc === rawDoc) {
      return this.markdownCache.text;
    }
    // Defensive table normalization: re-tag `table_header` /
    // `table_cell` cell types based on each cell's row position,
    // so historical reorder bugs (header row dragged to body or
    // vice versa) recover on the next save instead of locking the
    // file behind a permanent round-trip-guard rejection. The
    // round-trip guard further down compares this same `doc`
    // against the re-parse of the serialized output, so both sides
    // of the comparison see the normalized table.
    const tableNormalized = normalizeTablesInDoc(rawDoc, this.pmView.state.schema);
    // Pre-serialize doc normalization: rewrite shapes markdown can't
    // represent (block_id mid-paragraph, orphan list_item depths,
    // heading inline softbreaks + edge whitespace, sole embed_inline
    // in paragraph, text nodes with embedded newlines) into their
    // canonical equivalents BEFORE the serializer runs. Both the
    // fingerprint check below and the serialize itself see the same
    // normalized shape, so the round-trip guard only fires on TRUE
    // serializer bugs — not on PM tree states the user could
    // legitimately reach via merge / wrap / depth edits. User's
    // in-memory PM tree is unchanged; this is purely the save-path
    const doc = normalizeDocForSave(tableNormalized);
    // Paranoid save-path guard: if the loaded doc had a raw_block
    // (parse failed, source is being preserved verbatim) but the
    // current PM doc doesn't, refuse to save and return the original
    // file bytes. Normally the rawBlockSafetyPlugin's
    // filterTransaction blocks any such transition, but this guard
    // catches anything that somehow slips through (PM bug, direct
    // state mutation, us accidentally dispatching a sync-tagged
    // transaction that drops the raw_block). Zero tolerance for
    // data loss on an already-bad parse-failure day.
    if (this.originalDoc && this.hasRawBlock(this.originalDoc)) {
      if (!this.hasRawBlock(doc)) {
        console.error(
          "[butter-pmx] raw_block disappeared from PM doc but was " +
            "in loaded doc - refusing to save, returning original " +
            "bytes to prevent source loss.",
        );
        return this.data;
      }
    }
    try {
      // Source-preserving save: for each top-level block that's
      // still structurally identical to its loaded state (user
      // didn't touch it), emit the original source bytes verbatim
      // rather than re-serialize in Butter's canonical style. This
      // gives us Live-Preview-like source fidelity - untouched
      // blocks keep their exact whitespace, table alignment,
      // conservative-escape-free prose, etc. Only edited blocks
      // come out in the serializer's canonical form.
      //
      // Source-preserving save.
      //
      // Every top-level block in `doc` carries a `sourceRange` attr
      // placed there at parse time by the bridge. A companion
      // PM plugin (sourcePreservationPlugin) invalidates that attr
      // to null whenever the node's content or meaningful attrs
      // change - so at save time, a non-null range means "this node
      // is still byte-for-byte what the user had in source."
      //
      // The serializer walks the doc's children: valid range → emit
      // `originalBody.slice(range.start, range.end)` unchanged;
      // null range → re-serialize that block only. Everything else
      // stays byte-identical.
      //
      // No `childCount` check, no parallel range array, no per-save
      // positional index matching. The source-preservation invariant
      // lives on the nodes themselves and survives structural edits
      // (insert, delete, reorder) because each node carries its own
      // range regardless of where it sits in the doc.
      // Save mode is gated by user setting + runtime context:
      //   - `preserveOriginalSource` setting: user opted into byte
      //     preservation. Off by default (canonical mode).
      //   - `this.preserveSource`: runtime flag that's true only if
      //     parse succeeded and we have an originalDoc to compare
      //     against. False when parse failed (raw_block fallback) or
      //     the file is newly created.
      // Both must hold for preservation to engage. If either is
      // false, fall through to canonical serialize - what every
      // other WYSIWYG markdown editor does.
      // Canonical-form preferences are passed to whichever path runs.
      // Preserved blocks emit original bytes regardless; only synthesized
      // blocks honor these.
      const canonicalOptions = {
        bullet: this.settings.canonicalBullet,
        italic: this.settings.canonicalItalic,
        bold: this.settings.canonicalBold,
        codeFence: this.settings.canonicalCodeFence,
        horizontalRule: this.settings.canonicalHorizontalRule,
      };
      // Choose the primary serialize path (canonical vs preservation)
      // by user setting + runtime context. The OTHER path is held in
      // `tryFallback` for the round-trip-guard recovery below - if
      // the primary fails to round-trip, we attempt the alternate
      // before refusing the save outright.
      const useCanonical = !(
        this.settings.preserveOriginalSource &&
        this.preserveSource &&
        this.originalDoc
      );
      let body: string;
      const tryFallback = () => {
        if (useCanonical && this.preserveSource && this.originalDoc) {
          // Canonical was primary; preservation is the fallback.
          return serializer.serializeWithSourcePreservation(
            doc,
            this.originalBody,
            this.originalDoc,
            canonicalOptions,
          );
        }
        if (!useCanonical) {
          // Preservation was primary; canonical is the fallback.
          return serializer.serialize(doc, canonicalOptions);
        }
        return null;
      };
      if (useCanonical) {
        body = serializer.serialize(doc, canonicalOptions);
      } else {
        body = serializer.serializeWithSourcePreservation(
          doc,
          this.originalBody,
          this.originalDoc!,
          canonicalOptions,
        );
      }
      // Trailing-newline handling follows the same gating: when the
      // user has opted into source preservation AND we have parse
      // context, emit the original's exact trailing-newline count.
      // Otherwise fall back to the canonical convention of exactly 1.
      const targetTrailing =
        this.settings.preserveOriginalSource &&
        this.preserveSource &&
        this.originalDoc
          ? this.originalTrailingNewlines
          : 1;
      body = body.replace(/\n*$/, "") + "\n".repeat(targetTrailing);

      // Optional source normalization (opt-in advanced setting).
      // Applied AFTER trailing-newline preservation so the normalizer
      // can cap long trailing blank runs if `condenseBlankLines` is
      // on. The normalizer functions are idempotent and no-op when
      // all toggles are false.
      const preNormalizeBody = body;
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

      // If a normalizer changed the body bytes, update the
      // source-preservation baseline so subsequent saves diff against
      // the normalized form rather than the pre-normalized one.
      //
      // Subtlety: we update originalBody but NOT originalDoc. Re-
      // parsing to refresh sourceRanges would invalidate the PM
      // node-identity matching preservation depends on (every live
      // node would differ from a freshly-parsed baseline, collapsing
      // preservation to canonical-serialize for all nodes). Instead
      // we rely on the fact that `closeUnclosedFences` only appends
      // at EOF - existing sourceRanges stay valid pointing into the
      // new (longer) originalBody. For `normalizeHeadingGap` and
      // `condenseBlankLines`, which can shift mid-doc byte offsets,
      // sourceRanges drift slightly; acceptable because those
      // normalizers only touch inter-block whitespace that source-
      // preservation treats as a computed gap anyway (see the
      // content+gap preservation refactor in history).
      if (body !== preNormalizeBody) {
        this.originalBody = body;
        const trailingMatch = body.match(/\n*$/);
        this.originalTrailingNewlines = trailingMatch
          ? trailingMatch[0].length
          : 0;
      }

      // Save-path round-trip sanity check. Re-parse the serialized
      // body and compare a structural fingerprint against the current
      // PM doc. If the fingerprints diverge, the serializer produced
      // output that doesn't round-trip cleanly - a corruption bug
      // somewhere (ours, a theme interaction, an odd paste, whatever).
      // Refuse to save; return the original file bytes. The check
      // runs on every save as defense-in-depth against unknown
      // corruption paths - zero tolerance for silent data loss.
      //
      // Cost: one parse pass per save, ~10-50ms on typical docs.
      // Cheap relative to the risk of writing corrupted bytes.
      // Round-trip guard with fallback. Try the chosen serializer
      // path first; if its output doesn't reparse to the same
      // structure, attempt the OTHER path before refusing the save
      // entirely. This lets the user keep saving even when one path
      // has a latent bug on a specific file shape.
      const checkRoundTrip = (
        candidate: string,
      ): { ok: true } | { ok: false; reason: string } => {
        try {
          const reparsed = parser.parseWithSourceMap(candidate);
          if (!reparsed?.doc) return { ok: false, reason: "reparse returned null" };
          const origFp = docAtomFingerprint(doc);
          const reFp = docAtomFingerprint(reparsed.doc);
          if (origFp === reFp) return { ok: true };
          // Find the first divergent top-level block so the error is
          // actionable. Without this we just see "fingerprints differ"
          // and can't repro.
          const diff = firstFingerprintDivergence(origFp, reFp);
          return {
            ok: false,
            reason: `fingerprint mismatch at ${diff.path}: orig=${diff.orig} re=${diff.re}`,
          };
        } catch (err) {
          const e = err as { stack?: string; message?: string };
          const msg = String(e?.stack ?? e?.message ?? err);
          return { ok: false, reason: `reparse threw: ${msg.slice(0, 200)}` };
        }
      };

      // Capture the previous on-disk bytes so the diff modal can show
      // before/after if normalization fires. `this.originalBody` may
      // be updated mid-flight by the normalizers above; snapshot here.
      const preSaveOriginal = this.originalBody;

      const primary = checkRoundTrip(body);
      let saveResult: SaveState = { kind: "clean" };

      if (!primary.ok) {
        const fbBody = tryFallback();
        if (fbBody !== null) {
          const fb = checkRoundTrip(fbBody);
          if (fb.ok) {
            // Fallback path round-trips cleanly - silent recovery.
            recordError(
              "save",
              `Primary path (${useCanonical ? "canonical" : "preservation"}) did not round-trip; ` +
                `saved via fallback (${useCanonical ? "preservation" : "canonical"}) instead. ` +
                `Reason: ${primary.reason}. ` +
                `Body excerpt: ${JSON.stringify(body.slice(0, 200))}`,
            );
            body = fbBody;
            // saveResult stays { kind: "clean" } - round-trip is fine.
          } else {
            // Both paths failed round-trip. Save the CANONICAL output
            // (the safer of the two - it's our serializer's output
            // rather than potentially-stale source bytes carrying
            // forward whatever shape the in-memory doc disagrees with),
            // surface a warning to the user, and write the diagnostic
            // dump for our debugging. The user's work is NOT lost: the
            // bytes on disk are valid CommonMark/GFM/Obsidian markdown,
            // just normalized to a structure the parser accepts cleanly.
            // Obsidian's core File Recovery plugin handles version
            // restore if the user wants to roll back.
            const canonicalBody = useCanonical ? body : fbBody;
            const guardReason =
              `${useCanonical ? "canonical" : "preservation"}: ${primary.reason} | ` +
              `${useCanonical ? "preservation" : "canonical"}: ${fb.reason}`;

            // Auto-dump for diagnostics. TIMESTAMPED filename so
            // multiple guard fires in a session don't clobber each
            // other — the old `.butter-save-failure.md` single-file
            // approach lost prior dumps every time the guard fired
            // again, making it impossible to compare repro patterns.
            // Sortable ISO-ish stamp, hyphen-only (no colons → safe
            // on every filesystem including Windows + macOS legacy).
            const stamp = new Date()
              .toISOString()
              .replace(/[:]/g, "-")
              .replace(/\.\d+Z$/, "Z");
            const dumpPath = `.butter-save-failure-${stamp}.md`;
            const fileName = this.file?.path ?? "(unknown file)";
            const docDump = JSON.stringify(doc.toJSON(), null, 2);
            const dump =
              `<!-- Butter save-normalization auto-dump\n` +
              `   timestamp: ${new Date().toISOString()}\n` +
              `   file:      ${fileName}\n` +
              `   primary:   ${primary.reason}\n` +
              `   fallback:  ${fb.reason}\n` +
              `   doc.textContent.length: ${doc.textContent.length}\n` +
              `   File WAS written (canonical body); this dump captures\n` +
              `   the round-trip mismatch for diagnostics. Timestamped\n` +
              `   filename so repeated failures pile up rather than\n` +
              `   overwriting — please send these to support@buttereditor.com\n` +
              `   along with what you were doing when it happened.\n` +
              `-->\n\n` +
              `<!-- ===== IN-MEMORY PM DOC (JSON) ===== -->\n` +
              "```json\n" + docDump + "\n```\n\n" +
              `<!-- ===== ORIGINAL ON-DISK BODY ===== -->\n` +
              preSaveOriginal +
              `\n\n<!-- ===== CANONICAL SERIALIZER OUTPUT (saved) ===== -->\n` +
              canonicalBody +
              `\n\n<!-- ===== PRESERVATION SERIALIZER OUTPUT (alternative) ===== -->\n` +
              fbBody;
            void this.app.vault.adapter
              .write(dumpPath, dump)
              .catch((err) =>
                console.warn(
                  "[butter:save] failed to write auto-dump:",
                  err,
                ),
              );
            // High-visibility user notice — the console error alone
            // is invisible to anyone not actively in DevTools. A
            // long-duration Notice + status-bar warning indicator
            // makes it impossible to miss that something happened.
            new Notice(
              `${tx("Butter: save normalized - the file was saved but Butter's safety check found a structural difference.")} ` +
                tv("Diagnostic dump: {path} (at vault root).", { path: dumpPath }),
              15000,
            );
            recordError(
              "save",
              `Both serialize paths failed round-trip; saved canonical anyway. ` +
                `${guardReason} | auto-dump written to ${dumpPath} at vault root`,
            );

            body = canonicalBody;
            saveResult = {
              kind: "normalized",
              original: preSaveOriginal,
              saved: canonicalBody,
              reason: guardReason,
            };
          }
        } else {
          // Primary failed and no fallback available. Save the primary
          // output anyway - the user's work survives, and the warning
          // status indicator + diff modal lets them see what changed.
          // (The "no fallback" case typically means they only have one
          // serializer path enabled by setting; respecting that choice
          // and saving its output is the right behavior.)
          new Notice(
            tx("Butter: save normalized - primary serializer round-trip failed and no fallback is available. File saved anyway. Open DevTools console for details."),
            12000,
          );
          recordError(
            "save",
            `Round-trip ${primary.reason}. No fallback available; saved primary anyway.`,
          );
          saveResult = {
            kind: "normalized",
            original: preSaveOriginal,
            saved: body,
            reason:
              `${useCanonical ? "canonical" : "preservation"}: ${primary.reason}`,
          };
        }
      }

      // Report the final save outcome to the plugin's status bar.
      // Fires even on the clean path so the indicator clears any prior
      // warning state when a subsequent save round-trips cleanly.
      if (this.reportSaveResult) {
        try { this.reportSaveResult(saveResult); }
        catch (err) {
          console.warn("[butter:save] reportSaveResult threw:", err);
        }
      }

      let text = this.frontmatter + body;
      // Preserve the input file's line-ending style. Matters for
      // git-tracked vaults on Windows with autocrlf=false: converting
      // CRLF→LF on every save produces a whole-file diff that drowns
      // real changes. First normalize everything to LF (frontmatter
      // may still carry the original CRLF from disk), then re-apply
      // the target style uniformly.
      text = text.replace(/\r\n/g, "\n");
      if (this.lineEnding === "\r\n") text = text.replace(/\n/g, "\r\n");
      // Re-apply BOM if the original had one.
      if (this.originalHasBOM) text = "\ufeff" + text;
      // Cache keyed by the PM doc identity (rawDoc) since the next
      // call's identity check uses `this.pmView.state.doc`. The
      // table-normalized `doc` may be a fresh instance - caching by
      // it would always miss.
      this.markdownCache = { doc: rawDoc, text };
      return text;
    } catch {
      return this.data;
    }
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
      if (scheduler.hasPending()) scheduler.flush();
    };
    activeDocument.addEventListener("mousedown", onDocMouseDown, true);
    this.schedulerListeners.push(() =>
      activeDocument.removeEventListener("mousedown", onDocMouseDown, true),
    );

    const onWindowBlur = () => {
      if (scheduler.hasPending()) scheduler.flush();
    };
    window.addEventListener("blur", onWindowBlur);
    this.schedulerListeners.push(() =>
      window.removeEventListener("blur", onWindowBlur),
    );

    const onVisibility = () => {
      if (activeDocument.visibilityState === "hidden" && scheduler.hasPending()) {
        scheduler.flush();
      }
    };
    activeDocument.addEventListener("visibilitychange", onVisibility);
    this.schedulerListeners.push(() =>
      activeDocument.removeEventListener("visibilitychange", onVisibility),
    );

    const onBeforeUnload = () => {
      if (scheduler.hasPending()) scheduler.flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    this.schedulerListeners.push(() =>
      window.removeEventListener("beforeunload", onBeforeUnload),
    );
  }

  setViewData(data: string, clear: boolean) {
    this.data = data;
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

    // Fast path: same-content echo from our own save.
    const currentMarkdown = this.serializeCurrent();
    if (data === currentMarkdown) return;

    // External change (vault sync, git pull, another plugin edited
    // the file). Apply as a content replace transaction instead of
    // tearing down the whole EditorState - that keeps PM's undo
    // history and plugin state intact across the sync.
    const syncResult = parser.parseWithSourceMap(body);
    const newDoc = syncResult?.doc || schema.node("doc", null, [schema.node("paragraph")]);
    this.captureSourceState(body, syncResult?.doc ?? null);

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
      const tr = this.pmView.state.tr.replaceWith(
        0,
        this.pmView.state.doc.content.size,
        newDoc.content,
      );
      tr.setMeta("addToHistory", false);
      // Trusted-sync marker - raw-block safety plugin allows this
      // transaction through even if it removes a raw_block, because
      // setViewData's newDoc came from a fresh parse of the latest
      // file bytes (either parse succeeded and the raw_block's
      // replacement is the correct post-fix content, or parse failed
      // again and newDoc contains a new raw_block that still
      // protects the updated source).
      tr.setMeta(RAW_BLOCK_SYNC_META, true);
      this.pmView.dispatch(tr);
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
      const doc = schema.node("doc", null, [schema.node("paragraph")]);
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
