/**
 * Bridges Obsidian's EditorSuggest plugin API into Butter's PM view.
 *
 * Obsidian's own suggest system expects a MarkdownView with its CM6
 * editor. Plugins call `registerEditorSuggest(suggest)`, which stores
 * the suggest in `workspace.editorSuggest.suggests`. Those suggests are
 * normally fired when the user types in Obsidian's editor.
 *
 * Our PM view is a separate editor, so the native firing doesn't reach
 * us. Instead, we observe PM transactions and run each registered
 * suggest's `onTrigger` against an Editor shim. When one triggers, we
 * open a popover, call the suggest's `getSuggestions`, render each
 * item via `renderSuggestion`, and dispatch selection via
 * `selectSuggestion` - replicating Obsidian's flow.
 */
import { App, TFile } from "obsidian";
import { Plugin as PMPlugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { PMEditorShim } from "./editor-shim";
import type { Serializer } from "../core/serializer-types";

interface SuggestLike {
  onTrigger(cursor: unknown, editor: unknown, file: TFile | null): unknown;
  getSuggestions(context: unknown): unknown[] | Promise<unknown[]>;
  renderSuggestion(suggestion: unknown, el: HTMLElement): void;
  selectSuggestion(suggestion: unknown, evt: MouseEvent | KeyboardEvent): void;
  close?(): void;
}

interface OpenedContext {
  suggest: SuggestLike;
  triggerInfo: unknown;
  popover: HTMLElement;
  items: unknown[];
  selectedIndex: number;
  itemEls: HTMLElement[];
}

export function suggestBridgePlugin(
  app: App,
  serialize: Serializer,
  getFile: () => TFile | null,
) {
  const key = new PluginKey("butter-suggest-bridge");

  return new PMPlugin({
    key,
    view(view) {
      const shim = new PMEditorShim(view, serialize);
      let open: OpenedContext | null = null;

      const getRegisteredSuggests = (): SuggestLike[] => {
        try {
          const list = app.workspace.editorSuggest?.suggests;
          if (Array.isArray(list)) return list;
        } catch {
          // Ignored: Obsidian internals access can throw; we fall back
          // to an empty suggest list which is safe.
        }
        return [];
      };

      const close = () => {
        if (!open) return;
        try {
          open.suggest.close?.();
        } catch {
          // Ignored: some suggests don't expose a close method.
        }
        open.popover.remove();
        open = null;
      };

      const runSelection = async (
        ctx: OpenedContext,
        index: number,
        evt: MouseEvent | KeyboardEvent,
      ) => {
        const item = ctx.items[index];
        if (!item) return;
        try {
          ctx.suggest.selectSuggestion(item, evt);
        } catch (e) {
          console.error("[butter-editor] selectSuggestion failed:", e);
        }
        close();
      };

      const renderPopover = (ctx: OpenedContext) => {
        ctx.popover.empty();
        ctx.itemEls = [];
        if (!ctx.items.length) {
          const empty = ctx.popover.createDiv({ cls: "suggestion-empty" });
          empty.textContent = "No suggestions";
          return;
        }
        const container = ctx.popover.createDiv({ cls: "suggestion" });
        for (let i = 0; i < ctx.items.length; i++) {
          const el = container.createDiv({ cls: "suggestion-item" });
          if (i === ctx.selectedIndex) el.addClass("is-selected");
          try {
            ctx.suggest.renderSuggestion(ctx.items[i], el);
          } catch {
            const item = ctx.items[i];
            el.setText(typeof item === "string" ? item : "[suggestion]");
          }
          el.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            void runSelection(ctx, i, ev);
          });
          el.addEventListener("mouseenter", () => {
            ctx.selectedIndex = i;
            for (const [j, e] of ctx.itemEls.entries()) {
              e.toggleClass("is-selected", j === ctx.selectedIndex);
            }
          });
          ctx.itemEls.push(el);
        }
      };

      const positionPopover = (el: HTMLElement, v: EditorView) => {
        const coords = v.coordsAtPos(v.state.selection.head);
        if (!coords) return;
        el.addClass("butter-pos-fixed-popover");
        el.setCssProps({
          "--butter-pos-left": `${coords.left}px`,
          "--butter-pos-top": `${coords.bottom + 4}px`,
        });
      };

      const update = async (v: EditorView) => {
        shim.refresh();
        const cursor = shim.getCursor();
        const file = getFile();

        if (open) {
          const info = open.suggest.onTrigger(cursor, shim, file);
          if (!info) {
            close();
            return;
          }
          const items = await open.suggest.getSuggestions(info);
          open.items = Array.isArray(items) ? items.slice(0, 50) : [];
          open.selectedIndex = 0;
          renderPopover(open);
          positionPopover(open.popover, v);
          return;
        }

        for (const suggest of getRegisteredSuggests()) {
          try {
            const info = suggest.onTrigger(cursor, shim, file);
            if (!info) continue;
            const items = await suggest.getSuggestions(info);
            const arr = Array.isArray(items) ? items.slice(0, 50) : [];
            if (!arr.length) continue;
            const popover = activeDocument.createElement("div");
            popover.className = "suggestion-container butter-suggest-ext";
            activeDocument.body.appendChild(popover);
            open = {
              suggest,
              triggerInfo: info,
              popover,
              items: arr,
              selectedIndex: 0,
              itemEls: [],
            };
            renderPopover(open);
            positionPopover(popover, v);
            break;
          } catch {
            // Suggest errored on this cursor - ignore and try next
          }
        }
      };

      // The suggest update path serializes the entire doc to
      // build a line map (shim.refresh) so registered suggests
      // can read the text around the cursor. On a big doc that's
      // expensive. The earlier debounce still forced that cost
      // on every pause, so on continuous typing it was firing
      // repeatedly - creating the rhythmic longtask loop.
      //
      // New strategy: only run the suggest-check when the user
      // actually typed a character that a common suggest plugin
      // might respond to. For plain prose typing, skip entirely
      // (zero work per keystroke).
      const TRIGGER_CHARS = new Set([
        "[",
        "]",
        "@",
        ":",
        "#",
        "$",
        "!",
      ]);

      /** When no suggest is open, should we skip the (expensive)
       *  onTrigger check for this transaction? A registered suggest
       *  can only fire when the character immediately before the
       *  cursor matches one of its trigger symbols. So: peek at
       *  that one character. If it's not in the trigger set, no
       *  suggest can possibly open - skip the full-doc serialize
       *  and onTrigger loop entirely.
       *
       *  This covers all transaction shapes uniformly:
       *    • single-char insert of a non-trigger → preceding char
       *      is what the user just typed, which isn't a trigger
       *    • deletion (any size) → the char before the cursor
       *      after the delete is whatever was left; check it
       *    • block reorders / paste / drag-drop (delta === 0 or
       *      large multi-char changes) → cursor lands wherever;
       *      same one-char check applies.
       *
       *  Prior to this generalization, block reorders on large
       *  docs triggered `shim.refresh()` = full-doc textBetween,
       *  which dominated the drop-frame budget. */
      const canSkipForClosedSuggest = (
        v: EditorView,
        _prev: (typeof v)["state"],
      ): boolean => {
        const pos = v.state.selection.head;
        if (pos <= 0) return true;
        try {
          const ch = v.state.doc.textBetween(pos - 1, pos);
          return !TRIGGER_CHARS.has(ch);
        } catch {
          return false;
        }
      };

      return {
        update: (v, prev) => {
          if (
            v.state.doc.eq(prev.doc) &&
            v.state.selection.eq(prev.selection)
          )
            return;
          if (open) {
            void update(v);
            return;
          }
          if (canSkipForClosedSuggest(v, prev)) return;
          void update(v);
        },
        destroy: () => close(),
      };
    },
    props: {
      handleKeyDown(view, event) {
        // We rely on the active popover DOM rather than poking at PM's
        // internal pluginViews list — both options work in practice but
        // the DOM check is robust across PM versions.
        const suggests = app.workspace.editorSuggest?.suggests;
        if (!Array.isArray(suggests)) return false;

        const pop = activeDocument.querySelector(
          ".butter-suggest-ext",
        );
        if (!pop) return false;

        const items = pop.querySelectorAll(".suggestion-item");
        const current = Array.from(items).findIndex((el) =>
          el.classList.contains("is-selected"),
        );

        if (event.key === "ArrowDown") {
          event.preventDefault();
          const next = Math.min(current + 1, items.length - 1);
          items.forEach((el, i) =>
            el.classList.toggle("is-selected", i === next),
          );
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          const next = Math.max(current - 1, 0);
          items.forEach((el, i) =>
            el.classList.toggle("is-selected", i === next),
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const el = items[current] as HTMLElement | undefined;
          if (el) {
            event.preventDefault();
            el.dispatchEvent(
              new MouseEvent("mousedown", { bubbles: true }),
            );
            return true;
          }
        }
        if (event.key === "Escape") {
          event.preventDefault();
          pop.remove();
          return true;
        }
        return false;
      },
    },
  });
}
