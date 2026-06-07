/**
 * Module augmentation declaring the Obsidian internal APIs Butter
 * relies on. These are NOT part of Obsidian's public type surface,
 * so they can disappear or change shape without notice. Each entry
 * here is a documented bet on what Butter is reading from at runtime;
 * if Obsidian renames or removes the property the runtime code already
 * uses optional chaining and try/catch, so the worst case is the
 * affected integration silently no-ops.
 *
 * Strategy used throughout:
 *   - Mark every internal property OPTIONAL with `?:` so the existence
 *     check the runtime code already does (`?.`) typechecks.
 *   - Use conservative parameter / return types — `unknown` for
 *     payloads we don't dictate, narrow only the shapes Butter
 *     actually reads.
 *   - Keep the declared surface minimal: only what Butter uses today.
 *
 * Where reasonable, prefer `EditorView` (CodeMirror 6) and PM types
 * from their respective packages rather than redeclaring them.
 */
import "obsidian";
import type { TFile as ObsTFile } from "obsidian";
import type { EditorView as CMEditorView } from "@codemirror/view";
import type { Extension as CMExtension } from "@codemirror/state";

declare module "obsidian" {
  // ── Workspace internals ──────────────────────────────────────────

  /** Minimal EditorSuggest shape Butter consumes via suggest-bridge. */
  interface ButterEditorSuggestLike {
    onTrigger(cursor: unknown, editor: unknown, file: ObsTFile | null): unknown;
    getSuggestions(context: unknown): unknown[] | Promise<unknown[]>;
    renderSuggestion(suggestion: unknown, el: HTMLElement): void;
    selectSuggestion(suggestion: unknown, evt: MouseEvent | KeyboardEvent): void;
    close?(): void;
  }

  interface Workspace {
    /** Registered EditorSuggest plugins. Populated by Obsidian core
     *  and any third-party plugins that call `registerEditorSuggest`. */
    editorSuggest?: {
      suggests: ButterEditorSuggestLike[];
    };

    /** CM6 extensions registered via `registerEditorExtension`. */
    editorExtensions?: CMExtension[];

    /** Register a custom hover-link source so Obsidian's core
     *  page-preview surfaces hover cards for this view. */
    registerHoverLinkSource?(
      id: string,
      info: { display: string; defaultMod?: boolean },
    ): void;
  }

  // ── App internals ────────────────────────────────────────────────

  interface App {
    /** Obsidian's command palette registry. */
    commands?: {
      executeCommandById(id: string): boolean;
      commands?: Record<string, unknown>;
    };

    /** Third-party plugin registry. */
    plugins?: {
      plugins: Record<string, unknown>;
      enabledPlugins?: Set<string>;
    };

    /** Core (built-in) plugin registry. */
    internalPlugins?: {
      plugins: Record<
        string,
        | {
            enabled?: boolean;
            instance?: unknown;
            enable?(): Promise<void>;
            disable?(): Promise<void>;
          }
        | undefined
      >;
      getPluginById?(
        id: string,
      ): {
        enabled?: boolean;
        instance?: unknown;
        enable?(): Promise<void>;
        disable?(): Promise<void>;
      } | undefined;
    };

    /** View-type registry for extension-routing. */
    viewRegistry?: {
      unregisterExtensions?(exts: string[]): void;
      registerExtensions?(exts: string[], viewType: string): void;
      typeByExtension?: Record<string, string | undefined>;
    };

    /** Settings dialog handle. */
    setting?: {
      open?(): void;
      openTabById?(id: string): void;
    };

    /** Frontmatter property type registry (powers the Properties panel). */
    metadataTypeManager?: {
      assignedWidgets?: Record<
        string,
        { widget?: string; type?: string } | undefined
      >;
      registeredTypeWidgets?: Record<
        string,
        {
          type: string;
          icon?: string;
          name?: () => string;
          reservedKeys?: string[];
        } | undefined
      >;
      setType?(key: string, type: string): void;
    };
  }

  // ── Vault internals ─────────────────────────────────────────────

  interface Vault {
    /** Read an Obsidian config flag (spellcheck, etc.) from
     *  user-config (vault.json / app.json equivalent). */
    getConfig?(key: string): unknown;
  }

  // ── Menu / MenuItem internals ───────────────────────────────────

  interface Menu {
    /** Declare the section order for the menu. Sections become
     *  visual groups; items are placed into them via setSection. */
    addSections?(sections: string[]): Menu;
    /** Attach a submenu to a previously declared section. */
    setSectionSubmenu?(
      section: string,
      info: { title: string; icon?: string },
    ): Menu;
    /** Set the parent element used as positioning anchor. */
    setParentElement?(el: HTMLElement): Menu;
    /** DOM element this menu renders into. */
    dom?: HTMLElement;
  }

  interface MenuItem {
    /** Place this item into a named section (declared via addSections). */
    setSection?(section: string): MenuItem;
    /** Convert this item into a submenu host and return the submenu.
     *  Available in Obsidian 1.x; runtime no-op on older builds where
     *  the call may silently throw if removed. Callers should treat
     *  this as best-effort. */
    setSubmenu(): Menu;
    /** Visually highlight as destructive (red). */
    setWarning?(warning: boolean): MenuItem;
    /** DOM node hosting the item — used for adding extra classes. */
    dom?: HTMLElement;
  }

  // ── Editor (CM6 bridge) ────────────────────────────────────────

  interface Editor {
    /** The underlying CM6 EditorView. Public API doesn't expose this. */
    cm?: CMEditorView;
  }

  // ── MarkdownView preview internals ─────────────────────────────

  interface MarkdownView {
    /** Reading-mode renderer state. */
    previewMode?: {
      containerEl?: HTMLElement;
    };
  }

}

