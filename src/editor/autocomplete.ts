/**
 * Autocomplete for wikilinks ([[) and tags (#).
 * Pure ProseMirror plugin - uses Obsidian's vault API for suggestions
 * and Obsidian's suggestion-container CSS classes for native look.
 */
import { App } from "obsidian";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Fragment } from "prosemirror-model";
import type { Schema } from "prosemirror-model";

type SuggestItem = { text: string; secondary?: string };
type Mode = "wikilink" | "tag" | null;

export function autocompletePlugin(app: App, schema: Schema) {
  let popover: HTMLDivElement | null = null;
  let isOpen = false;
  let mode: Mode = null;
  let startPos = -1;
  let selectedIndex = 0;
  let items: SuggestItem[] = [];

  // ── Query extraction ──

  function getQuery(view: EditorView): string | null {
    const { from } = view.state.selection;
    if (startPos < 0 || from <= startPos) return null;

    const text = view.state.doc.textBetween(startPos, from);

    if (mode === "wikilink") {
      if (!text.startsWith("[[")) return null;
      return text.slice(2);
    }
    if (mode === "tag") {
      if (!text.startsWith("#")) return null;
      return text.slice(1);
    }
    return null;
  }

  // ── Suggestion sources ──

  function getWikilinkSuggestions(query: string): SuggestItem[] {
    const files = app.vault.getMarkdownFiles();
    const lower = query.toLowerCase();
    return files
      .filter((f) => !query || f.basename.toLowerCase().includes(lower))
      .slice(0, 20)
      .map((f) => ({
        text: f.basename,
        secondary: f.parent && f.parent.path !== "/" ? f.parent.path : undefined,
      }));
  }

  function getTagSuggestions(query: string): SuggestItem[] {
    // Get all tags from the vault metadata cache
    const allTags = new Set<string>();
    const files = app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = app.metadataCache.getFileCache(file);
      if (cache?.tags) {
        for (const t of cache.tags) {
          allTags.add(t.tag.slice(1)); // remove leading #
        }
      }
      if (cache?.frontmatter?.tags) {
        const fmTags: unknown = cache.frontmatter.tags;
        if (Array.isArray(fmTags)) {
          for (const t of fmTags) allTags.add(String(t));
        }
      }
    }

    const lower = query.toLowerCase();
    return Array.from(allTags)
      .filter((t) => !query || t.toLowerCase().includes(lower))
      .sort()
      .slice(0, 20)
      .map((t) => ({ text: t }));
  }

  // ── Popover lifecycle ──

  function createPopover(): HTMLDivElement {
    const el = activeDocument.createElement("div");
    el.classList.add("suggestion-container", "butter-suggest");
    activeDocument.body.appendChild(el);
    return el;
  }

  function positionPopover(view: EditorView) {
    if (!popover) return;
    const coords = view.coordsAtPos(startPos);
    if (!coords) return;
    popover.addClass("butter-pos-fixed-popover");
    popover.setCssProps({
      "--butter-pos-left": `${coords.left}px`,
      "--butter-pos-top": `${coords.bottom + 4}px`,
    });
  }

  function renderSuggestions(view: EditorView) {
    if (!popover) return;
    popover.innerHTML = "";

    if (items.length === 0) {
      const empty = activeDocument.createElement("div");
      empty.classList.add("suggestion-empty");
      empty.textContent = "No results";
      popover.appendChild(empty);
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const el = activeDocument.createElement("div");
      el.classList.add("suggestion-item");
      if (i === selectedIndex) el.classList.add("is-selected");

      const title = activeDocument.createElement("span");
      title.classList.add("suggestion-title");
      title.textContent = item.text;
      el.appendChild(title);

      if (item.secondary) {
        const note = activeDocument.createElement("span");
        note.classList.add("suggestion-note");
        note.textContent = item.secondary;
        el.appendChild(note);
      }

      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectItem(view, item);
      });

      popover.appendChild(el);
    }
  }

  // ── Selection ──

  function selectItem(view: EditorView, item: SuggestItem) {
    const from = startPos;
    const to = view.state.selection.from;

    if (mode === "wikilink") {
      const node = schema.nodes.wikilink.create({ target: item.text, alias: "" });
      view.dispatch(view.state.tr.replaceWith(from, to, node));
    } else if (mode === "tag") {
      const node = schema.nodes.obsidian_tag.create({ tag: item.text });
      const space = schema.text(" ");
      view.dispatch(view.state.tr.replaceWith(from, to, Fragment.from([node, space])));
    }

    close();
    view.focus();
  }

  // ── Open / close / update ──

  function open(view: EditorView, newMode: Mode) {
    mode = newMode;
    isOpen = true;
    selectedIndex = 0;
    popover = createPopover();
    update(view);
  }

  function close() {
    isOpen = false;
    mode = null;
    startPos = -1;
    selectedIndex = 0;
    if (popover) {
      popover.remove();
      popover = null;
    }
  }

  function update(view: EditorView) {
    if (!isOpen) return;
    const query = getQuery(view);
    if (query === null) {
      close();
      return;
    }

    items = mode === "wikilink"
      ? getWikilinkSuggestions(query)
      : getTagSuggestions(query);

    selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));
    positionPopover(view);
    renderSuggestions(view);
  }

  // ── Plugin ──

  return new Plugin({
    key: new PluginKey("butter-autocomplete"),
    props: {
      handleKeyDown(view, event) {
        // ── Active popover key handling ──
        if (isOpen) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            renderSuggestions(view);
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            renderSuggestions(view);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            if (items[selectedIndex]) {
              event.preventDefault();
              selectItem(view, items[selectedIndex]);
              return true;
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close();
            return true;
          }
        }

        // ── Trigger detection ──

        // Wikilink: detect second [ being typed
        if (event.key === "[" && !isOpen) {
          const { from } = view.state.selection;
          if (from > 0) {
            const charBefore = view.state.doc.textBetween(from - 1, from);
            if (charBefore === "[") {
              startPos = from - 1;
              window.setTimeout(() => open(view, "wikilink"), 0);
            }
          }
        }

        // Tag: detect # being typed (preceded by space or start of block)
        if (event.key === "#" && !isOpen) {
          const { from } = view.state.selection;
          const atStart = from === view.state.selection.$from.start();
          if (atStart || (from > 0 && /\s/.test(view.state.doc.textBetween(from - 1, from)))) {
            startPos = from;
            window.setTimeout(() => open(view, "tag"), 0);
          }
        }

        return false;
      },
    },
    view() {
      return {
        update: (view) => {
          if (isOpen) update(view);
        },
        destroy: () => {
          close();
        },
      };
    },
  });
}
