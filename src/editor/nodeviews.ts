/**
 * ProseMirror NodeViews that delegate rendering to Obsidian's MarkdownRenderer.
 */
import { App, Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { Selection } from "prosemirror-state";
import { MathEditModal } from "./math-edit-modal";
import { recordError } from "../integration/debug";

interface WidgetInfoHost extends HTMLElement {
  __butterWidgetInfo?: unknown;
}

/** Safe wrapper around MarkdownRenderer.render. Buggy third-party
 *  processors (Dataview query syntax error, Mermaid parse failure,
 *  custom code-block handler that throws) reject the returned Promise.
 *  Without a catch, those bubble up as unhandled rejections - noisy
 *  console output and, on some Electron builds, a visible error dialog.
 *  Funnel rejections into our error ring buffer instead so they're
 *  visible via the in-app log (especially on mobile where the console
 *  isn't reachable). */
function safeMarkdownRender(
  app: App,
  md: string,
  mount: HTMLElement,
  sourcePath: string,
  comp: Component,
  context: string,
): Promise<void> {
  try {
    return MarkdownRenderer.render(app, md, mount, sourcePath, comp).catch(
      (err: unknown) => {
        recordError(
          "markdown-render",
          `${context}: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  } catch (err) {
    recordError(
      "markdown-render",
      `${context} (sync throw): ${err instanceof Error ? err.message : String(err)}`,
    );
    return Promise.resolve();
  }
}

/**
 * Fenced code languages that Butter edits in place as a PM code shell
 * (with Prism highlighting + language picker).
 *
 * Everything NOT in this set is piped through Obsidian's
 * `MarkdownRenderer.render()` - which lets every installed plugin's
 * `registerMarkdownCodeBlockProcessor` handler run automatically
 * (Mermaid, Dataview, Tasks, Charts, Tracker, Kroki, Admonition,
 * PlantUML, etc. - we don't need to know about them). If no plugin is
 * registered for the language, MarkdownRenderer just produces a
 * plain `<pre><code>` and we get syntax highlighting via Prism inside
 * its output. Either way the block has a click-to-edit toggle in the
 * header so users can still edit the fence source when they need to.
 *
 * Keeping this list matters for ONE reason: these are the langs where
 * we expect users to edit frequently (programming code). For those we
 * skip the widget render and default straight to the editable shell.
 */
const EDITABLE_LANGS = new Set([
  // Programming languages
  "javascript", "js",
  "typescript", "ts",
  "tsx", "jsx",
  "python", "py",
  "bash", "sh", "shell", "zsh", "fish",
  "rust", "rs",
  "go", "golang",
  "java",
  "c", "h",
  "cpp", "c++", "cxx", "hpp",
  "cs", "csharp",
  "ruby", "rb",
  "php",
  "swift",
  "kotlin", "kt",
  "scala",
  "r",
  "lua",
  "perl", "pl",
  "dart",
  "objc", "objective-c",
  "haskell", "hs",
  "elixir", "ex",
  "erlang", "erl",
  "clojure", "clj",
  "elm",
  "ocaml", "ml",
  "fsharp", "fs",
  "groovy",
  "julia", "jl",
  "nim",
  "zig",
  "crystal",
  "solidity", "sol",
  // Data / config
  "json", "jsonc", "json5",
  "yaml", "yml",
  "xml",
  "toml",
  "ini",
  "csv", "tsv",
  "properties",
  // Web
  "html", "htm",
  "css", "scss", "sass", "less", "stylus",
  "vue", "svelte",
  // Query
  "sql", "mysql", "postgresql", "sqlite", "plsql",
  "graphql", "gql",
  // DevOps
  "dockerfile", "docker",
  "makefile", "make",
  "cmake",
  "nginx",
  "apache",
  "terraform", "tf", "hcl",
  "vim", "viml",
  // Text / docs
  "plain", "plaintext", "text", "txt",
  "markdown", "md",
  "latex", "tex",
  "bibtex", "bib",
  "rst", "restructuredtext",
  "diff", "patch",
  "regex", "regexp",
  "asciidoc", "adoc",
  // Shells / scripts
  "powershell", "ps", "ps1",
  "bat", "batch", "cmd",
  "awk",
  "sed",
]);

export function isEditableLang(language: string): boolean {
  // Empty-language fences get the editable shell - plugins don't
  // register on empty lang, so there's no widget to render anyway.
  if (!language) return true;
  return EDITABLE_LANGS.has(language.toLowerCase());
}

// PM's `Node.attrs` is typed `Attrs` = `Record<string, any>`. Every
// node-view reads its config off `node.attrs.<X>`, which lights up
// `no-unsafe-member-access`. These helpers narrow the access:
// `attrStr` returns "" when the attr is missing / non-string, which
// matches what every existing call site falls back to anyway.
function attrStr(node: PMNode, key: string): string {
  const v = (node.attrs as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

// ── Shared lifecycle tracking ──

export class NodeViewManager {
  private components: Component[] = [];

  createComponent(): Component {
    const comp = new Component();
    comp.load();
    this.components.push(comp);
    return comp;
  }

  removeComponent(comp: Component) {
    comp.unload();
    const idx = this.components.indexOf(comp);
    if (idx >= 0) this.components.splice(idx, 1);
  }

  destroy() {
    for (const c of this.components) c.unload();
    this.components.length = 0;
  }
}

// ── Code block NodeView (Obsidian-delegated languages + lang picker) ──

export const COMMON_LANGS = [
  "js",
  "ts",
  "tsx",
  "jsx",
  "python",
  "bash",
  "sh",
  "json",
  "yaml",
  "html",
  "css",
  "rust",
  "go",
  "java",
  "cpp",
  "c",
  "sql",
  "md",
  "xml",
  "php",
  "ruby",
  "swift",
  "kotlin",
  "mermaid",
  "dataview",
  "dataviewjs",
  "query",
];

/**
 * Open a floating language-picker popover anchored to `anchor`'s
 * bottom-left corner. Returns a close handle so the caller can
 * dismiss the popover externally if needed.
 *
 * Features a search field, a list of common languages, and - when
 * the search text doesn't match any known lang - offers the typed
 * value as a "custom" option at the top so Enter applies it directly.
 * This is how users set plugin-specific fence langs (`chart`,
 * `tasks`, `ad-note`, `vega-lite`, etc.) without needing us to
 * maintain an allowlist.
 */
export function showLangPopover(
  anchor: HTMLElement,
  current: string,
  onChange: (lang: string) => void,
): { close: () => void } {
  const popover = activeDocument.createElement("div");
  popover.className = "butter-code-lang-popover";

  let isOpen = true;
  const outsideHandler = (e: MouseEvent) => {
    if (!isOpen) return;
    if (popover.contains(e.target as Node)) return;
    close();
  };
  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    popover.remove();
    activeDocument.removeEventListener("mousedown", outsideHandler);
  };

  const input = activeDocument.createElement("input");
  input.type = "text";
  input.placeholder = "Search languages\u2026";
  input.className = "butter-code-lang-search";
  popover.appendChild(input);

  const list = activeDocument.createElement("div");
  list.className = "butter-code-lang-list";
  popover.appendChild(list);

  const renderList = (query: string) => {
    list.empty();
    const q = query.toLowerCase().trim();

    // Build options with intent-matching ordering:
    //   - No query → "plain" first, then COMMON_LANGS.
    //   - Query matching a known lang → matches first, then "plain".
    //   - Query matching nothing → custom query first (so Enter applies
    //     the user's typed value directly), then "plain".
    const options: Array<{ lang: string; isCustom?: boolean }> = [];
    if (q) {
      const matches = COMMON_LANGS.filter(
        (l) => l !== "plain" && l.includes(q),
      );
      const exact = matches.includes(q);
      if (!exact) {
        options.push({ lang: q, isCustom: true });
      }
      for (const m of matches) options.push({ lang: m });
      options.push({ lang: "plain" });
    } else {
      options.push({ lang: "plain" });
      for (const l of COMMON_LANGS.filter((l) => l !== "plain")) {
        options.push({ lang: l });
      }
    }

    for (const opt of options) {
      const row = activeDocument.createElement("div");
      row.className = "butter-code-lang-item";
      if (opt.lang === current || (opt.lang === "plain" && !current)) {
        row.addClass("is-selected");
      }
      const labelText = activeDocument.createElement("span");
      labelText.className = "butter-code-lang-item-label";
      labelText.textContent = opt.lang;
      row.appendChild(labelText);
      if (opt.isCustom) {
        const hint = activeDocument.createElement("span");
        hint.className = "butter-code-lang-hint";
        hint.textContent = "Custom";
        row.appendChild(hint);
      }
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        const effective = opt.lang === "plain" ? "" : opt.lang;
        onChange(effective);
        close();
      });
      list.appendChild(row);
    }
  };

  input.addEventListener("input", () => renderList(input.value));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const first = list.querySelector(".butter-code-lang-item");
      first?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  });

  activeDocument.body.appendChild(popover);
  const rect = anchor.getBoundingClientRect();
  popover.addClass("butter-pos-fixed-popover");
  popover.setCssProps({
    "--butter-pos-top": `${rect.bottom + 4}px`,
    "--butter-pos-left": `${rect.left}px`,
  });
  window.setTimeout(() => {
    input.focus();
    activeDocument.addEventListener("mousedown", outsideHandler);
  }, 0);
  renderList("");

  return { close };
}



export function codeBlockView(
  app: App,
  getSourcePath: () => string,
  manager: NodeViewManager,
  butterView?: unknown,
) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => {
    const rawLanguage = attrStr(node, "language");
    // Fenced-code language is interpolated into a `\`\`\`${lang}\\n…`
    // template before being passed to MarkdownRenderer. Backticks /
    // newlines / leading whitespace in `lang` would terminate the
    // fence early or break the parser. A legitimate language tag is
    // [A-Za-z0-9_+.-] only; everything else collapses to empty.
    const language = /^[A-Za-z0-9_+.-]*$/.test(rawLanguage) ? rawLanguage : "";
    const editable = isEditableLang(language);

    // ── Shell root ──
    // Single NodeView handles both editable shells (Prism-highlighted
    // PM-backed `<code>`) and delegated widgets (Obsidian's
    // MarkdownRenderer output - which is where plugin code-block
    // processors like Mermaid/Dataview/Tasks/Charts automatically run).
    // The two modes live side-by-side in the DOM; CSS toggles which is
    // visible. contentDOM is always the editable `<code>`, so PM's text
    // model stays intact regardless of which view is showing.
    const dom = activeDocument.createElement("div");
    dom.classList.add("butter-code-block-shell");
    if (!editable) {
      dom.classList.add("butter-obsidian-block");
      if (language) dom.classList.add(`butter-block-${language}`);
    }
    // Expose the current mode as a data attribute so the drag-handle
    // context menu can read it and show the correct "Edit source" vs
    // "Preview" label without coupling directly to NodeView internals.
    dom.dataset.butterMode = editable ? "edit" : "view";
    // Default to "widget" for delegated blocks - the common case. If
    // the render produces a plain <pre><code> fallback (unregistered
    // lang), renderWidget() flips this to "fallback" so CSS restores
    // the code-block chrome.
    if (!editable) dom.dataset.butterWidget = "widget";

    // ── View wrap (MarkdownRenderer output - plugin widgets land here) ──
    const viewWrap = activeDocument.createElement("div");
    viewWrap.classList.add("butter-code-view-wrap");
    viewWrap.contentEditable = "false";
    const mount = activeDocument.createElement("div");
    mount.classList.add("obsidian-render-mount");
    if (butterView) {
      (mount as WidgetInfoHost).__butterWidgetInfo = { view, getPos, butterView, node };
    }
    viewWrap.appendChild(mount);
    dom.appendChild(viewWrap);

    // ── Edit wrap (editable PM code shell - contentDOM lives here) ──
    const editWrap = activeDocument.createElement("div");
    editWrap.classList.add("butter-code-edit-wrap");

    // ── Floating edit toolbar (delegated langs only) ──
    // For blocks where the normal view is a rendered widget (Mermaid,
    // Dataview, Charts, Tasks, …), entering edit mode reveals the
    // plain-text source with a floating toolbar above offering Save
    // (keep the edits) or Cancel (revert to the pre-edit snapshot).
    // Editable langs (js/py/etc.) don't need this flow - they live in
    // edit mode permanently.
    let editToolbar: HTMLElement | null = null;
    let snapshotSource: string | null = null;
    if (!editable) {
      editToolbar = activeDocument.createElement("div");
      editToolbar.className = "butter-code-edit-toolbar";
      editToolbar.contentEditable = "false";
      editToolbar.setAttribute("role", "toolbar");
      editToolbar.setAttribute("aria-label", "Code edit controls");

      // Language label - identifies what kind of block you're editing
      // ("mermaid", "dataviewjs", "chart", etc.). Positioned first in
      // the toolbar, separated from the action buttons by a vertical
      // divider matching the table toolbar's divider style.
      const langLabel = activeDocument.createElement("span");
      langLabel.className = "butter-code-edit-toolbar-lang";
      langLabel.textContent = language;

      const divider = activeDocument.createElement("div");
      divider.className = "butter-code-edit-toolbar-divider";

      const cancelBtn = activeDocument.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "butter-code-edit-toolbar-btn clickable-icon";
      cancelBtn.setAttribute("aria-label", "Cancel (discard edits)");
      cancelBtn.title = "Cancel";
      setIcon(cancelBtn, "x");

      const saveBtn = activeDocument.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "butter-code-edit-toolbar-btn clickable-icon";
      saveBtn.setAttribute("aria-label", "Save edits");
      saveBtn.title = "Save";
      setIcon(saveBtn, "check");

      editToolbar.appendChild(langLabel);
      editToolbar.appendChild(divider);
      editToolbar.appendChild(cancelBtn);
      editToolbar.appendChild(saveBtn);
      editWrap.appendChild(editToolbar);

      // Ensure PM doesn't steal focus / move the selection when the
      // user presses the toolbar buttons - mousedown is the event
      // that triggers PM's selection update, so we preventDefault
      // *before* PM sees it. The click handler still fires normally.
      const eatMouse = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      };
      cancelBtn.addEventListener("mousedown", eatMouse);
      saveBtn.addEventListener("mousedown", eatMouse);
      cancelBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        exitToView(snapshotSource);
      });
      saveBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        exitToView(null);
      });
    }

    const pre = activeDocument.createElement("pre");
    pre.classList.add("butter-code-block");
    const code = activeDocument.createElement("code");
    if (language) code.classList.add(`language-${language}`);
    pre.appendChild(code);
    editWrap.appendChild(pre);
    dom.appendChild(editWrap);

    // ── Language tag (top-right, editable blocks with a lang) ──
    // Subtle pill showing the code block's language. Clicking it
    // copies the block's current source to the clipboard. Replaces
    // the old hover-copy button with a more discoverable affordance
    // that also identifies the language at a glance.
    if (editable && language) {
      // Use a <span> (not <button>) so no user-agent or Obsidian-app
      // default button styling leaks in - this is pure text that
      // happens to be clickable. role="button" + title + aria-label
      // keep it accessible. Keyboard affordance is deliberately
      // omitted - users have the drag-handle Copy item for that.
      const langTag = activeDocument.createElement("span");
      langTag.className = "butter-code-lang-tag";
      langTag.textContent = language;
      langTag.contentEditable = "false";
      langTag.setAttribute("role", "button");
      langTag.setAttribute("aria-label", `Copy ${language} code`);
      langTag.title = "Copy";
      // mousedown preventDefault stops PM from moving selection to
      // "near" the tag when the user presses it. Click still fires.
      langTag.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      langTag.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(currentSource).then(
          () => new Notice("Copied code"),
          () => new Notice("Clipboard write failed"),
        );
      });
      dom.appendChild(langTag);
    }

    // ── Mode state ──
    let mode: "view" | "edit" = editable ? "edit" : "view";
    const comp = manager.createComponent();
    let currentSource = node.textContent;

    const renderWidget = (source: string) => {
      mount.innerHTML = "";
      const md = "```" + language + "\n" + source + "\n```";
      const result = safeMarkdownRender(
        app,
        md,
        mount,
        getSourcePath(),
        comp,
        `code_block(${language})`,
      );
      // Classify the output after the render settles:
      //   • "widget"   - a plugin produced custom DOM (dataview table,
      //                  mermaid SVG, chart canvas, etc.). Strip our
      //                  code-block chrome so it looks native.
      //   • "fallback" - no plugin is registered for this lang (typo
      //                  like ```chicken, or a random identifier). We
      //                  got a bare <pre><code> from MarkdownRenderer
      //                  whose own styling doesn't reach our NodeView.
      //                  KEEP the shell chrome so it still reads as a
      //                  code block, not bare inline-looking text.
      const finalize = () => {
        const first = mount.firstElementChild as HTMLElement | null;
        const isFallback = first?.tagName === "PRE";
        dom.dataset.butterWidget = isFallback ? "fallback" : "widget";
      };
      void result.then(finalize, finalize);
    };

    const applyMode = () => {
      dom.dataset.butterMode = mode;
      if (mode === "view") {
        viewWrap.removeClass("butter-hidden");
        editWrap.addClass("butter-hidden");
        renderWidget(currentSource);
      } else {
        viewWrap.addClass("butter-hidden");
        editWrap.removeClass("butter-hidden");
      }
      if (editToolbar) repositionToolbar();
    };

    // ── Viewport-sticky edit toolbar ──
    // The edit toolbar is default-positioned (via CSS) at `top: -42px`
    // relative to the code-block shell. That works great when the
    // shell's top is in view - the toolbar floats just above the
    // block. But when the user scrolls deep into a long code block
    // being edited, the shell's top leaves the viewport and the
    // toolbar scrolls away with it.
    //
    // This reposition pins the toolbar to the top of the viewport
    // whenever the shell's top is above it, and hides it when the
    // shell is entirely out of view. It's a JS-driven scroll-tracker
    // rather than `position: sticky` because sticky would require
    // the toolbar to be in-flow (adding 34px to the block's top
    // content) and would rely on an ancestor being the scroll
    // container - not a given across Obsidian's layout.
    let rafPending = false;
    const repositionToolbar = () => {
      if (!editToolbar) return;
      if (mode !== "edit") {
        // CSS default (absolute top:-42px) takes over when the
        // toolbar isn't being shown.
        editToolbar.addClass("butter-hidden");
        editToolbar.removeClass("butter-code-edit-toolbar-pinned");
        return;
      }
      const rect = editWrap.getBoundingClientRect();
      const toolbarH = editToolbar.offsetHeight || 34;
      const viewportMargin = 8;
      const viewportH = window.innerHeight;

      // Hide toolbar if the block is entirely out of view
      // there's nothing to anchor to.
      if (rect.bottom < 0 || rect.top > viewportH) {
        editToolbar.addClass("butter-hidden");
        return;
      }
      editToolbar.removeClass("butter-hidden");

      // If the shell's top is above (or within toolbar-height of)
      // the viewport top, pin the toolbar to the viewport. Else
      // restore the default absolute positioning above the block.
      if (rect.top < toolbarH + viewportMargin + 6) {
        editToolbar.addClass("butter-code-edit-toolbar-pinned");
        editToolbar.setCssProps({
          "--butter-pos-top": `${viewportMargin}px`,
          "--butter-pos-left": `${rect.left}px`,
          "--butter-pos-width": `${rect.width}px`,
        });
      } else {
        editToolbar.removeClass("butter-code-edit-toolbar-pinned");
      }
    };
    const scheduleReposition = () => {
      if (rafPending) return;
      rafPending = true;
      window.requestAnimationFrame(() => {
        rafPending = false;
        repositionToolbar();
      });
    };
    if (editToolbar) {
      // Capture phase catches scroll on ancestor scroll containers
      // too (scroll doesn't bubble by default, so a scroll-anywhere
      // listener on window needs capture to see descendant scrolls).
      window.addEventListener("scroll", scheduleReposition, true);
      window.addEventListener("resize", scheduleReposition);
    }

    const enterEditMode = () => {
      if (mode === "edit") return;
      snapshotSource = currentSource;
      mode = "edit";
      applyMode();
      // Focus the contentDOM directly via browser `focus()` rather
      // than dispatching a PM setSelection transaction. The latter,
      // immediately after the display swap, was racing with PM's
      // mutation observer and causing the NodeView to be torn down
      // + recreated - which reset mode back to "view" (the flicker).
      window.requestAnimationFrame(() => {
        try {
          code.focus();
          // Place the caret at the start of the code content (if any)
          // so the user is ready to type without an extra click.
          const range = activeDocument.createRange();
          range.selectNodeContents(code);
          range.collapse(true);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {
          /* noop - user can click into the code area */
        }
      });
    };

    /**
     * Leave edit mode and return to the rendered widget.
     *   • `restoreSource = null` → Save: keep the user's edits.
     *   • `restoreSource = <string>` → Cancel: replace the block's
     *     text content with the snapshot before returning.
     */
    const exitToView = (restoreSource: string | null) => {
      if (mode !== "edit") return;
      if (restoreSource !== null) {
        try {
          const pos = getPos();
          if (pos != null) {
            const currentNode = view.state.doc.nodeAt(pos);
            if (currentNode && currentNode.type.name === "code_block") {
              const from = pos + 1;
              const to = pos + 1 + currentNode.content.size;
              if (restoreSource.length > 0) {
                view.dispatch(
                  view.state.tr.replaceWith(
                    from,
                    to,
                    view.state.schema.text(restoreSource),
                  ),
                );
              } else if (from < to) {
                view.dispatch(view.state.tr.delete(from, to));
              }
            }
          }
        } catch {
          /* swallow - if the restore fails, fall through to just
             exiting edit mode with whatever text the user left. */
        }
      }
      snapshotSource = null;
      mode = "view";
      applyMode();
    };

    // Drag-handle context menu dispatches `butter-toggle-mode` on
    // this shell DOM when the user picks "Edit source". For a
    // delegated block in view mode that enters edit mode; if somehow
    // fired while already editing it acts as Save (keep + exit).
    // Editable langs have no view mode to enter, so they ignore.
    dom.addEventListener("butter-toggle-mode", () => {
      if (editable) return;
      if (mode === "view") {
        enterEditMode();
      } else {
        exitToView(null);
      }
    });

    applyMode();

    return {
      dom,
      contentDOM: code,
      update(updatedNode) {
        if (updatedNode.type.name !== "code_block") return false;
        // Language change → recreate so the new NodeView picks up the
        // right editable/delegated shape. setNodeMarkup fires this.
        if (updatedNode.attrs.language !== language) return false;
        const newSource = updatedNode.textContent;
        if (newSource !== currentSource) {
          currentSource = newSource;
          // Keep the rendered widget in sync with doc edits (undo,
          // external edits, paste). In edit mode the user sees the
          // raw source so no widget re-render needed.
          if (mode === "view") renderWidget(newSource);
        }
        return true;
      },
      ignoreMutation(m) {
        // contentDOM (the <code> element) is PM's territory - the
        // node's text content lives there and changes to it must be
        // noticed. Everything else in our shell DOM is presentation
        // only: mode dataset, display-style swaps on view/edit
        // wrappers, widget rendering inside viewWrap, toolbar DOM.
        // Telling PM to ignore those prevents spurious re-renders
        // that would tear down our mode state (the old "flicker").
        const target = m.target as Node | null | undefined;
        if (target == null) return true;
        if (target === code) return false;
        if (code.contains(target)) return false;
        return true;
      },
      stopEvent(e: Event) {
        const target = e.target;
        if (target instanceof Node) {
          // Widget is fully interactive (links, dataviewjs buttons,
          // mermaid diagrams that wire their own click handlers)
          // don't let PM interfere with those. Same for the floating
          // edit toolbar's buttons.
          if (viewWrap.contains(target)) return true;
          if (editToolbar && editToolbar.contains(target)) return true;
        }
        return false;
      },
      destroy() {
        manager.removeComponent(comp);
        if (editToolbar) {
          window.removeEventListener("scroll", scheduleReposition, true);
          window.removeEventListener("resize", scheduleReposition);
        }
      },
    };
  };
}

// ── Embed NodeView  ![[...]] ──

function parseSize(raw: string): { target: string; width: number | null; height: number | null } {
  const m = raw.match(/^(.*?)\|(\d+)(?:x(\d+))?$/);
  if (!m) return { target: raw, width: null, height: null };
  return {
    target: m[1],
    width: parseInt(m[2]),
    height: m[3] ? parseInt(m[3]) : null,
  };
}

/**
 * Sanitize an embed src before interpolating into the
 * `![[${src}]]` template passed to MarkdownRenderer. An src
 * containing `]]` would terminate the embed wrapper early and let the
 * remainder be parsed as arbitrary markdown (including raw HTML via
 * the renderer). Strip every character that could change the parser's
 * interpretation - none of these are valid inside an Obsidian
 * wikilink target / alias / size suffix.
 */
function safeEmbedSrc(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[[\]\\\r\n<>`]/g, "");
}

export function embedView(
  app: App,
  getSourcePath: () => string,
  manager: NodeViewManager,
  butterView?: unknown,
) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => {
    const src = safeEmbedSrc(attrStr(node, "src"));
    const dom = activeDocument.createElement("div");
    dom.classList.add("butter-obsidian-embed");
    const mount = activeDocument.createElement("div");
    mount.classList.add("obsidian-render-mount");
    if (butterView) {
      (mount as WidgetInfoHost).__butterWidgetInfo = { view, getPos, butterView, node };
    }
    dom.appendChild(mount);

    const comp = manager.createComponent();
    void safeMarkdownRender(app, `![[${src}]]`, mount, getSourcePath(), comp, `embed(${src})`);

    // Apply |WxH sizing if encoded in src
    const sized = parseSize(src);
    if (sized.width) {
      const img = mount.querySelector("img");
      if (img) {
        img.width = sized.width;
        if (sized.height) img.height = sized.height;
      }
      // When the file is missing, Obsidian renders a
      // `.mod-empty-attachment` placeholder (full-width "could not
      // be found" text card) instead of an `<img>`. For sized
      // embeds, replace it with a plain gray rectangle holding the
      // declared footprint + a centered broken-image icon. Same
      // visual the markdown-image NodeView produces for sized
      // missing srcs.
      const empty = mount.querySelector<HTMLElement>(
        ".mod-empty-attachment",
      );
      if (empty) {
        empty.className = "butter-image-missing-sized";
        // Square fallback when only one axis is declared in the
        // |WxH suffix - the placeholder has no intrinsic art to
        // size against, so an unset axis would collapse to 0.
        // `![[bg.jpg|300]]` → 300×300 tile.
        const effectiveW = sized.width;
        const effectiveH = sized.height ?? sized.width;
        empty.style.width = `${effectiveW}px`;
        empty.style.height = `${effectiveH}px`;
        empty.textContent = "";
        setIcon(empty, "image-off");
      }
    }

    // Native hover-preview for note embeds. Strips any |size suffix
    // since hover-link wants the file reference only.
    const linktext = stripEmbedSize(src);
    dom.addEventListener("mouseover", (event) => {
      app.workspace.trigger("hover-link", {
        event,
        source: BUTTER_HOVER_SOURCE,
        hoverParent: dom,
        targetEl: dom,
        linktext,
        sourcePath: getSourcePath(),
      });
    });

    return {
      dom,
      stopEvent: () => true,
      destroy() { manager.removeComponent(comp); },
    };
  };
}

/** Strip Obsidian's optional `|WxH` size suffix from an embed src
 *  so the remaining string is a clean link target (page-preview
 *  doesn't understand `file|300x200`). */
function stripEmbedSize(src: string): string {
  const pipe = src.indexOf("|");
  return pipe >= 0 ? src.slice(0, pipe) : src;
}

/**
 * Inline embed view. Used when `![[…]]` appears mixed with other
 * inline text or inside a list-item's first paragraph (where a
 * block-level embed would force an empty leading paragraph). Renders
 * the same MarkdownRenderer output as the block view, but hosted in
 * an inline-layout `<span>` so ProseMirror's inline content model is
 * satisfied.
 */
export function embedInlineView(
  app: App,
  getSourcePath: () => string,
  manager: NodeViewManager,
  butterView?: unknown,
) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => {
    const src = safeEmbedSrc(attrStr(node, "src"));
    const dom = activeDocument.createElement("span");
    dom.classList.add("butter-obsidian-embed", "butter-obsidian-embed-inline");
    const mount = activeDocument.createElement("span");
    mount.classList.add("obsidian-render-mount");
    if (butterView) {
      (mount as WidgetInfoHost).__butterWidgetInfo = { view, getPos, butterView, node };
    }
    dom.appendChild(mount);

    const comp = manager.createComponent();
    void safeMarkdownRender(app, `![[${src}]]`, mount, getSourcePath(), comp, `embed-sized(${src})`);

    const sized = parseSize(src);
    if (sized.width) {
      const img = mount.querySelector("img");
      if (img) {
        img.width = sized.width;
        if (sized.height) img.height = sized.height;
      }
      // Mirror the block embedView's missing-attachment swap: when
      // the file is missing, Obsidian's MarkdownRenderer produces a
      // `.mod-empty-attachment` placeholder that defaults to full-
      // column width. For sized inline embeds we want a tile sized
      // to the declared footprint (square fallback when only one
      // axis given), with a centered broken-image icon - matches
      // the block-level treatment.
      const empty = mount.querySelector<HTMLElement>(
        ".mod-empty-attachment",
      );
      if (empty) {
        empty.className = "butter-image-missing-sized";
        const effectiveW = sized.width;
        const effectiveH = sized.height ?? sized.width;
        empty.style.width = `${effectiveW}px`;
        empty.style.height = `${effectiveH}px`;
        empty.textContent = "";
        setIcon(empty, "image-off");
      }
    }

    const linktext = stripEmbedSize(src);
    dom.addEventListener("mouseover", (event) => {
      app.workspace.trigger("hover-link", {
        event,
        source: BUTTER_HOVER_SOURCE,
        hoverParent: dom,
        targetEl: dom,
        linktext,
        sourcePath: getSourcePath(),
      });
    });

    return {
      dom,
      stopEvent: () => true,
      destroy() { manager.removeComponent(comp); },
    };
  };
}

// ── Callout NodeView (editable) ──

const CALLOUT_ICONS: Record<string, string> = {
  note: "lucide-pencil",
  abstract: "lucide-clipboard-list",
  summary: "lucide-clipboard-list",
  tldr: "lucide-clipboard-list",
  info: "lucide-info",
  todo: "lucide-check-circle-2",
  tip: "lucide-flame",
  hint: "lucide-flame",
  important: "lucide-flame",
  success: "lucide-check",
  check: "lucide-check",
  done: "lucide-check",
  question: "lucide-help-circle",
  help: "lucide-help-circle",
  faq: "lucide-help-circle",
  warning: "lucide-alert-triangle",
  caution: "lucide-alert-triangle",
  attention: "lucide-alert-triangle",
  failure: "lucide-x-circle",
  fail: "lucide-x-circle",
  missing: "lucide-x-circle",
  danger: "lucide-zap",
  error: "lucide-zap",
  bug: "lucide-bug",
  example: "lucide-list",
  quote: "lucide-quote",
  cite: "lucide-quote",
};

export function calloutIcon(type: string): string {
  return CALLOUT_ICONS[type.toLowerCase()] ?? "lucide-pencil";
}

export function calloutView(
  _app: unknown,
  _getSourcePath: unknown,
  _manager: unknown,
  butterView?: unknown,
) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => {
    const dom = activeDocument.createElement("div");
    // Add Obsidian's native callout classes + data attrs alongside
    // our own. Theme CSS targeting `.callout[data-callout="note"]`
    // (Minimal / AnuPpuccin / Catppuccin / etc.) cascades through,
    // so our callouts inherit whatever --callout-color / icon /
    // styling the user's theme expects. Our butter-* selectors
    // stay for Butter-specific rules.
    dom.classList.add("butter-callout-view", "callout");
    dom.setAttribute("data-callout-type", attrStr(node, "calloutType"));
    dom.setAttribute("data-callout", attrStr(node, "calloutType"));
    if (attrStr(node, "foldState")) {
      dom.setAttribute("data-fold", attrStr(node, "foldState"));
      dom.setAttribute("data-callout-fold", attrStr(node, "foldState"));
    }

    const header = activeDocument.createElement("div");
    header.className = "butter-callout-header callout-title";
    header.contentEditable = "false";

    const icon = activeDocument.createElement("span");
    icon.className = "butter-callout-icon callout-icon";
    setIcon(icon, calloutIcon(attrStr(node, "calloutType")));
    header.appendChild(icon);

    const defaultLabel = (type: string) =>
      type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();

    // Title is contenteditable so the user can click in and rename.
    // Typing dispatches nothing until blur (or Enter / Escape) - we
    // commit the new title via `setNodeMarkup` once, avoiding
    // transaction churn during typing.
    //
    // The title text is a NODE ATTRIBUTE, not PM content, so PM's
    // normal editing pipeline shouldn't see these keystrokes. The
    // NodeView's `stopEvent` (below) blocks events from bubbling
    // into PM. `ignoreMutation` keeps PM from reacting to our DOM
    // text changes as if they were editor-content edits.
    const label = activeDocument.createElement("span");
    label.className = "butter-callout-title callout-title-inner";
    label.contentEditable = "true";
    label.spellcheck = false;
    label.textContent =
      attrStr(node, "title") || defaultLabel(attrStr(node, "calloutType"));

    // Keep mousedown on the title from bubbling up to the header's
    // focus-inside handler - otherwise clicking the title would
    // dispatch a selection-into-body transaction before the user
    // got to type. (stopPropagation is enough; don't preventDefault
    // so the browser still places the caret at the click point.)
    label.addEventListener("mousedown", (e) => e.stopPropagation());

    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const pos = getPos();
        if (pos == null) return;
        const currentNode = view.state.doc.nodeAt(pos);
        if (!currentNode || currentNode.type.name !== "obsidian_callout") return;
        const raw = (label.textContent ?? "").trim();
        const isDefault = raw === defaultLabel(attrStr(currentNode, "calloutType"));
        const newTitle = raw && !isDefault ? raw : undefined;
        const schema = view.state.schema;
        const paraType = schema.nodes.paragraph;
        const tr = view.state.tr;
        if (newTitle !== attrStr(currentNode, "title")) {
          tr.setNodeMarkup(pos, undefined, {
            ...currentNode.attrs,
            title: newTitle,
            sourceRange: null,
          });
        }
        // With `block*` content, the callout may have zero children
        // - the title-only / no-body state. To land the caret in the
        // body we have to first INSERT an empty paragraph at the
        // start of the body, then setSelection inside it.
        if (currentNode.childCount === 0 && paraType) {
          tr.insert(pos + 1, paraType.create());
        }
        const target = pos + 2; // open callout + open first child
        const clamped = Math.min(target, tr.doc.content.size);
        const sel = Selection.near(
          tr.doc.resolve(clamped),
        );
        tr.setSelection(sel).scrollIntoView();
        view.dispatch(tr);
        view.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        const pos = getPos();
        if (pos != null) {
          const currentNode = view.state.doc.nodeAt(pos);
          if (currentNode) {
            label.textContent =
              attrStr(currentNode, "title") ||
              defaultLabel(attrStr(currentNode, "calloutType"));
          }
        }
        label.blur();
      } else if (e.key === "Backspace") {
        // Empty title - swallow the key so it can't cascade into
        // deleting the callout from the title side. preventDefault
        // stops the browser; stopPropagation stops PM's keymap
        // (joinBackward/etc.) from acting on PM's current selection.
        if ((label.textContent ?? "") === "") {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    });

    label.addEventListener("blur", () => {
      const pos = getPos();
      if (pos == null) return;
      const currentNode = view.state.doc.nodeAt(pos);
      if (!currentNode || currentNode.type.name !== "obsidian_callout") return;
      const raw = (label.textContent ?? "").trim();
      // Store undefined when the user either left the default text
      // or blanked it out - the NodeView regenerates the default at
      // paint time, so the DOM text won't be empty in either case.
      const isDefault = raw === defaultLabel(attrStr(currentNode, "calloutType"));
      const newTitle = raw && !isDefault ? raw : undefined;
      if (newTitle === attrStr(currentNode, "title")) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...currentNode.attrs,
          title: newTitle,
          // Clear preservation key - attr-only edits keep PM-node
          // identity intact, which would otherwise emit ORIGINAL
          // bytes (with the old title) on save. Setting null forces
          // canonical serialize for this block.
          sourceRange: null,
        }),
      );
    });

    header.appendChild(label);

    // Clicking the header area OUTSIDE the title label (icon, empty
    // header space) places the caret into the first editable
    // position of the callout's body - the "focus the card"
    // affordance. Clicking the title itself is excluded because the
    // title's own mousedown handler stopPropagation()s up.
    const focusInside = (e: Event) => {
      e.preventDefault();
      const pos = getPos();
      if (pos == null) return;
      const currentNode = view.state.doc.nodeAt(pos);
      const schema = view.state.schema;
      const paraType = schema.nodes.paragraph;
      const tr = view.state.tr;
      // Same insertion-on-empty-body logic as the title Enter handler:
      // when the callout has zero children, we need a paragraph for
      // the caret to land in.
      if (currentNode?.childCount === 0 && paraType) {
        tr.insert(pos + 1, paraType.create());
      }
      const target = pos + 2;
      const clamped = Math.min(target, tr.doc.content.size);
      const sel = Selection.near(
        tr.doc.resolve(clamped),
      );
      tr.setSelection(sel).scrollIntoView();
      view.dispatch(tr);
      view.focus();
    };
    header.addEventListener("mousedown", focusInside);

    dom.appendChild(header);

    // Editable content lives in contentDOM; PM fills this with the
    // callout's child blocks (paragraphs, lists, code, etc.).
    const contentDOM = activeDocument.createElement("div");
    contentDOM.className = "butter-callout-content callout-content";
    dom.appendChild(contentDOM);

    // Slim-display the callout only when its body has ZERO children
    // (the new `block*` natural empty state - title-only, matches
    // Live Preview). When the body has a paragraph in it - even an
    // empty one freshly spawned by Enter-on-title - keep normal
    // padding/margins so the caret has breathing room. Backspace at
    // an empty body deletes the paragraph, which transitions back
    // to zero children and re-enables slim.
    const setEmptyBodyAttr = (n: PMNode) => {
      if (n.childCount === 0) dom.setAttribute("data-empty-body", "true");
      else dom.removeAttribute("data-empty-body");
    };
    setEmptyBodyAttr(node);

    return {
      dom,
      contentDOM,
      update(updated) {
        if (updated.type.name !== "obsidian_callout") return false;
        const type = attrStr(updated, "calloutType");
        dom.setAttribute("data-callout-type", type);
        dom.setAttribute("data-callout", type);
        setEmptyBodyAttr(updated);
        const foldState = attrStr(updated, "foldState");
        if (foldState) {
          dom.setAttribute("data-fold", foldState);
          dom.setAttribute("data-callout-fold", foldState);
        } else {
          dom.removeAttribute("data-fold");
          dom.removeAttribute("data-callout-fold");
        }
        // Don't overwrite the label while the user is typing in it
        // that would yank their caret. The commit flow on blur
        // brings the attribute + DOM back into sync.
        const expected = attrStr(updated, "title") || defaultLabel(type);
        if (activeDocument.activeElement !== label && label.textContent !== expected) {
          label.textContent = expected;
        }
        icon.empty();
        setIcon(icon, calloutIcon(type));
        return true;
      },
      // Block drag-handle events + title-editing events from flowing
      // into PM's event-handling pipeline. The header is non-PM
      // chrome; the title is a node attribute, not PM content.
      stopEvent(event: Event) {
        return header.contains(event.target as Node);
      },
      ignoreMutation(m) {
        const target = m.target as Node | null | undefined;
        return target != null && header.contains(target);
      },
    };
  };
}

// ── Math block NodeView ──

export function mathBlockView(
  app: App,
  getSourcePath: () => string,
  manager: NodeViewManager,
  butterView?: unknown,
) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => {
    const dom = activeDocument.createElement("div");
    dom.classList.add("butter-math-block-view");
    const mount = activeDocument.createElement("div");
    mount.classList.add("obsidian-render-mount");
    if (butterView) {
      (mount as WidgetInfoHost).__butterWidgetInfo = { view, getPos, butterView, node };
    }
    dom.appendChild(mount);

    const comp = manager.createComponent();
    const md = `$$\n${attrStr(node, "value")}\n$$`;
    void safeMarkdownRender(app, md, mount, getSourcePath(), comp, "math_block");

    // Double-click opens the same edit modal the drag-handle "Edit
    // source" item uses. Without this, the block can only be edited
    // through the right-click menu - discoverable for power users,
    // invisible to anyone who hits the rendered math and expects
    // "click to edit" to work like every other rich-text editor.
    const openEdit = () => {
      const pos = getPos();
      if (pos == null) return;
      const current = attrStr(node, "value");
      new MathEditModal(app, current, (next) => {
        const fresh = view.state.doc.nodeAt(pos);
        if (!fresh || fresh.type.name !== "math_block") return;
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, {
            ...fresh.attrs,
            value: next,
            sourceRange: null,
          }),
        );
      }).open();
    };
    dom.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEdit();
    });
    // Right-click opens the same edit modal — third path alongside
    // double-click and the drag-handle "Edit source" item. Redundant
    // by design: more entry points make the affordance discoverable
    // without forcing one specific gesture.
    dom.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEdit();
    });

    return {
      dom,
      stopEvent: () => true,
      destroy() { manager.removeComponent(comp); },
    };
  };
}

// ── Inline math NodeView ──

export function inlineMathView(
  app: App,
  getSourcePath: () => string,
  manager: NodeViewManager,
  butterView?: unknown,
) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => {
    const dom = activeDocument.createElement("span");
    dom.classList.add("butter-inline-math-view");
    const mount = activeDocument.createElement("span");
    mount.classList.add("obsidian-render-mount");
    if (butterView) {
      (mount as WidgetInfoHost).__butterWidgetInfo = { view, getPos, butterView, node };
    }
    dom.appendChild(mount);

    const comp = manager.createComponent();
    void safeMarkdownRender(app, `$${attrStr(node, "value")}$`, mount, getSourcePath(), comp, "inline_math");

    // MarkdownRenderer wraps single-paragraph output in a <p>, which
    // is display:block - that forces a visual line break around our
    // inline atom. Strip the <p> wrapper post-render: pull its
    // children up into the mount span so the math sits inline with
    // the surrounding prose.
    const wrapperP = mount.querySelector(":scope > p");
    if (wrapperP) {
      while (wrapperP.firstChild) {
        mount.insertBefore(wrapperP.firstChild, wrapperP);
      }
      wrapperP.remove();
    }

    return {
      dom,
      stopEvent: () => true,
      destroy() { manager.removeComponent(comp); },
    };
  };
}

// ── Wikilink NodeView ──

/** The `source` string passed to `workspace.trigger("hover-link", …)`
 *  so Obsidian's page-preview plugin recognizes Butter as an origin
 *  for hover previews. Also what we register via
 *  `registerHoverLinkSource` at plugin onload. */
export const BUTTER_HOVER_SOURCE = "butter-editor";

export function wikilinkView(app: App, getSourcePath: () => string) {
  return (node: PMNode): NodeView => {
    const target = attrStr(node, "target");
    const alias = attrStr(node, "alias");
    const dom = activeDocument.createElement("a");
    dom.classList.add("butter-wikilink", "internal-link");
    dom.textContent = alias || target;
    dom.href = target;
    dom.dataset.href = target;

    dom.addEventListener("click", (e) => {
      e.preventDefault();
      void app.workspace.openLinkText(target, "", e.ctrlKey || e.metaKey);
    });

    // Native Obsidian hover-preview. The "page-preview" core plugin
    // listens for workspace.trigger("hover-link", …) and shows a
    // floating preview card when the user hovers (with whatever
    // modifier the user has configured - Obsidian's setting, not
    // ours). Firing the same event Butter-side gets us the exact
    // same preview UX as Live Preview / Reading mode.
    dom.addEventListener("mouseover", (event) => {
      app.workspace.trigger("hover-link", {
        event,
        source: BUTTER_HOVER_SOURCE,
        hoverParent: dom,
        targetEl: dom,
        linktext: target,
        sourcePath: getSourcePath(),
      });
    });

    return { dom, stopEvent: () => true };
  };
}

// ── Tag NodeView ──

export function tagView(app: App) {
  return (node: PMNode): NodeView => {
    const tag = attrStr(node, "tag");
    const dom = activeDocument.createElement("a");
    dom.classList.add("butter-tag", "tag");
    dom.textContent = `#${tag}`;
    dom.href = "#";

    dom.addEventListener("click", (e) => {
      e.preventDefault();
      const search = app.internalPlugins?.getPluginById?.("global-search");
      const inst = search?.instance as
        | { openGlobalSearch?: (q: string) => void }
        | undefined;
      inst?.openGlobalSearch?.(`tag:${tag}`);
    });

    return { dom, stopEvent: () => true };
  };
}

// ── Block comment NodeView (hidden) ──

export function blockCommentView() {
  return (node: PMNode): NodeView => {
    const dom = activeDocument.createElement("div");
    dom.classList.add("butter-block-comment-view");
    dom.textContent = `%%${node.attrs.value ?? ""}%%`;
    return { dom };
  };
}

/**
 * Raw-block NodeView. Shows a diagnostic banner + the raw source
 * inside a pre block so users can SEE that Butter couldn't parse
 * this region but also that the bytes are preserved. Atomic (not
 * editable through PM); save emits the raw attr verbatim.
 */
export function rawBlockView() {
  return (node: PMNode): NodeView => {
    const dom = activeDocument.createElement("div");
    dom.classList.add("butter-raw-block-view");

    const banner = activeDocument.createElement("div");
    banner.classList.add("butter-raw-block-banner");
    banner.setAttribute("contenteditable", "false");
    const icon = activeDocument.createElement("span");
    icon.classList.add("butter-raw-block-icon");
    icon.textContent = "\u26A0"; // ⚠ warning sign
    banner.appendChild(icon);
    const msg = activeDocument.createElement("span");
    msg.classList.add("butter-raw-block-msg");
    const reason = attrStr(node, "reason") || "unparseable region";
    msg.textContent = `Unparseable: ${reason} - source preserved byte-for-byte.`;
    banner.appendChild(msg);
    dom.appendChild(banner);

    const pre = activeDocument.createElement("pre");
    pre.classList.add("butter-raw-block-content");
    pre.setAttribute("contenteditable", "false");
    pre.textContent = attrStr(node, "raw") || "";
    dom.appendChild(pre);

    return { dom };
  };
}

// ── Inline footnote NodeView - renders as superscript [n] with tooltip ──

export function inlineFootnoteView() {
  return (node: PMNode): NodeView => {
    const dom = activeDocument.createElement("sup");
    dom.classList.add("butter-footnote-ref");
    dom.setAttribute("data-footnote-inline", "");
    dom.title = attrStr(node, "content");

    const link = activeDocument.createElement("a");
    link.classList.add("footnote-link");
    link.textContent = "*";
    link.href = "#";
    link.addEventListener("click", (e) => e.preventDefault());
    dom.appendChild(link);

    return { dom, stopEvent: () => true };
  };
}

// ── Footnote ref NodeView - renders as superscript [label] like reading mode ──

export function footnoteRefView() {
  return (node: PMNode): NodeView => {
    const dom = activeDocument.createElement("sup");
    dom.classList.add("butter-footnote-ref");
    dom.setAttribute("data-footnote-id", attrStr(node, "label"));

    const link = activeDocument.createElement("a");
    link.classList.add("footnote-link");
    link.textContent = attrStr(node, "label");
    link.href = "#";
    link.addEventListener("click", (e) => e.preventDefault());
    dom.appendChild(link);

    return { dom, stopEvent: () => true };
  };
}

// ── Footnote def NodeView - renders as a footnote entry in a section ──

export function footnoteDefView(
  app: App,
  getSourcePath: () => string,
  manager: NodeViewManager,
) {
  return (node: PMNode): NodeView => {
    const dom = activeDocument.createElement("div");
    dom.classList.add("butter-footnote-def-view");
    dom.setAttribute("data-footnote-label", attrStr(node, "label"));

    // Back-reference label
    const labelEl = activeDocument.createElement("sup");
    labelEl.classList.add("butter-footnote-label");
    labelEl.textContent = attrStr(node, "label");
    dom.appendChild(labelEl);

    // Content - render via MarkdownRenderer (but as plain paragraph, not as footnote def syntax)
    const mount = activeDocument.createElement("span");
    mount.classList.add("butter-footnote-content");
    dom.appendChild(mount);

    const comp = manager.createComponent();
    // Render the content as regular markdown, not as [^label]: syntax
    // (Obsidian's renderer doesn't show footnote definitions inline)
    void safeMarkdownRender(app, attrStr(node, "content"), mount, getSourcePath(), comp, "inline_footnote");

    return {
      dom,
      stopEvent: () => true,
      destroy() { manager.removeComponent(comp); },
    };
  };
}

// ── Block ID NodeView ──

export function blockIdView() {
  return (node: PMNode): NodeView => {
    const dom = activeDocument.createElement("span");
    dom.classList.add("butter-block-id-view");
    dom.textContent = `^${attrStr(node, "id")}`;
    return { dom, stopEvent: () => true };
  };
}

