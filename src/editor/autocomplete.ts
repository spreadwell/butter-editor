/**
 * Autocomplete for wikilinks ([[) and tags (#).
 * Pure ProseMirror plugin using the slash menu row structure for
 * visual consistency with Butter's other insertion popups.
 */
import { App, setIcon } from "obsidian";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Fragment } from "prosemirror-model";
import type { Schema } from "prosemirror-model";

import {
  getAutocompleteQuery,
  isTagAutocompleteQuery,
  type AutocompleteMode,
} from "./autocomplete-query";
import { bindFloatingSurfaceReposition } from "../util/floating-surface";
import { tx, tv } from "../i18n";

type SuggestItem = { text: string; secondary?: string; create?: boolean };
type Mode = AutocompleteMode | null;

export function autocompletePlugin(app: App, schema: Schema) {
  let popover: HTMLDivElement | null = null;
  let isOpen = false;
  let mode: Mode = null;
  let startPos = -1;
  let selectedIndex = 0;
  let items: SuggestItem[] = [];
  let unbindReposition: (() => void) | null = null;

  // ── Query extraction ──

  function getQuery(view: EditorView): string | null {
    const { from } = view.state.selection;
    if (startPos < 0 || from <= startPos) return null;

    const text = view.state.doc.textBetween(startPos, from);

    return mode ? getAutocompleteQuery(mode, text) : null;
  }

  // ── Suggestion sources ──

  function getWikilinkSuggestions(query: string): SuggestItem[] {
    const files = app.vault.getMarkdownFiles();
    const lower = query.toLowerCase();
    const suggestions: SuggestItem[] = files
      .filter((f) => !query || f.basename.toLowerCase().includes(lower))
      .slice(0, 20)
      .map((f) => ({
        text: f.basename,
        secondary: f.parent && f.parent.path !== "/" ? f.parent.path : undefined,
      }));
    if (
      query &&
      !files.some((f) => f.basename.toLowerCase() === lower)
    ) {
      suggestions.unshift({ text: query, create: true });
    }
    return suggestions;
  }

  function getTagSuggestions(query: string): SuggestItem[] {
    const allTags = new Set<string>();
    const files = app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = app.metadataCache.getFileCache(file);
      if (cache?.tags) {
        for (const t of cache.tags) {
          allTags.add(t.tag.slice(1));
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
    const suggestions: SuggestItem[] = Array.from(allTags)
      .filter((t) => !query || t.toLowerCase().includes(lower))
      .sort()
      .slice(0, 20)
      .map((t) => ({ text: t }));
    if (
      query &&
      isTagAutocompleteQuery(query) &&
      !Array.from(allTags).some((t) => t.toLowerCase() === lower)
    ) {
      suggestions.unshift({ text: query, create: true });
    }
    return suggestions;
  }

  // ── Popover lifecycle ──

  function createPopover(newMode: Mode): HTMLDivElement {
    const el = activeDocument.createElement("div");
    el.classList.add(
      "butter-surface",
      "butter-surface--compact",
      "butter-autocomplete-menu",
    );
    el.setAttribute("role", "listbox");
    el.setAttribute(
      "aria-label",
      newMode === "tag" ? tx("Tag suggestions") : tx("Link suggestions"),
    );
    el.id = `butter-autocomplete-${Math.random().toString(36).slice(2, 9)}`;
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
    window.requestAnimationFrame(() => {
      if (!popover) return;
      const rect = popover.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 12) {
        popover.setCssProps({
          "--butter-pos-top": `${coords.top - rect.height - 4}px`,
        });
      }
    });
  }

  function itemIcon(): string {
    return mode === "tag" ? "hash" : "file-text";
  }

  function itemLabel(item: SuggestItem): string {
    if (item.create) {
      return mode === "tag"
        ? tv("Create #{tag}", { tag: item.text })
        : tv("Create link to \"{name}\"", { name: item.text });
    }
    return mode === "tag" ? `#${item.text}` : item.text;
  }

  function itemDesc(item: SuggestItem): string | null {
    if (item.create) return tx("Press Enter");
    if (item.secondary) return item.secondary;
    return null;
  }

  function syncActiveDescendant() {
    if (!popover) return;
    const selected = popover.querySelector<HTMLElement>(
      ".butter-surface-row.is-selected",
    );
    if (selected?.id) {
      popover.setAttribute("aria-activedescendant", selected.id);
    } else {
      popover.removeAttribute("aria-activedescendant");
    }
  }

  function syncSelection() {
    if (!popover) return;
    const rows = Array.from(
      popover.querySelectorAll<HTMLElement>(".butter-surface-row"),
    );
    for (const [i, row] of rows.entries()) {
      const selected = i === selectedIndex;
      row.toggleClass("is-selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
    }
    syncActiveDescendant();
  }

  function renderSuggestions(view: EditorView) {
    if (!popover) return;
    popover.innerHTML = "";

    if (items.length === 0) {
      const empty = activeDocument.createElement("div");
      empty.classList.add("butter-surface-empty");
      empty.textContent = tx("No matches");
      popover.appendChild(empty);
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const el = activeDocument.createElement("div");
      el.classList.add(
        "butter-surface-row",
        "butter-surface-row--compact",
        "butter-autocomplete-item",
      );
      el.setAttribute("role", "option");
      el.id = `${popover.id}-opt-${i}`;
      const selected = i === selectedIndex;
      el.toggleClass("is-selected", selected);
      el.setAttribute("aria-selected", selected ? "true" : "false");

      const iconEl = activeDocument.createElement("div");
      iconEl.classList.add("butter-surface-icon");
      setIcon(iconEl, itemIcon());
      el.appendChild(iconEl);

      const meta = activeDocument.createElement("div");
      meta.classList.add("butter-surface-meta");
      const title = activeDocument.createElement("div");
      title.classList.add("butter-surface-label");
      title.textContent = itemLabel(item);
      meta.appendChild(title);
      const desc = itemDesc(item);
      if (desc) {
        const note = activeDocument.createElement("div");
        note.classList.add("butter-surface-detail");
        note.textContent = desc;
        meta.appendChild(note);
      }
      el.appendChild(meta);

      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectItem(view, item);
      });
      el.addEventListener("mouseenter", () => {
        selectedIndex = i;
        syncSelection();
      });

      popover.appendChild(el);
    }
    syncActiveDescendant();
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
    popover = createPopover(newMode);
    unbindReposition = bindFloatingSurfaceReposition(() => {
      if (isOpen && popover) positionPopover(view);
    });
    update(view);
  }

  function close() {
    isOpen = false;
    mode = null;
    startPos = -1;
    selectedIndex = 0;
    unbindReposition?.();
    unbindReposition = null;
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
            if (!items.length) return true;
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            syncSelection();
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            if (!items.length) return true;
            selectedIndex = Math.max(selectedIndex - 1, 0);
            syncSelection();
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
          if (mode === "tag" && event.key.length === 1 && !isTagAutocompleteQuery(event.key)) {
            close();
            return false;
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

        // Tag: detect # being typed at the start of a block or after whitespace.
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
