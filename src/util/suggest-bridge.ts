/** Own the public EditorSuggest context and UI for this exact PM view. */
import type { App, Editor, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from "obsidian";
import { Plugin as PMPlugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { PMEditorShim } from "./editor-shim";
import type { Serializer } from "../core/serializer-types";
import type { EditorSourceHost } from "../core/editor-source-edit";

interface SuggestLike {
  context?: EditorSuggestContext | null;
  limit?: number;
  onTrigger(cursor: unknown, editor: unknown, file: TFile | null): EditorSuggestTriggerInfo | null;
  getSuggestions(context: EditorSuggestContext): unknown[] | Promise<unknown[]>;
  renderSuggestion(suggestion: unknown, el: HTMLElement): void;
  selectSuggestion(suggestion: unknown, event: MouseEvent | KeyboardEvent): void;
  close?(): void;
}
interface Session {
  owner: EditorView;
  suggest: SuggestLike;
  context: EditorSuggestContext;
  doc: EditorView["state"]["doc"];
  source: string;
  selection: EditorView["state"]["selection"];
  items: unknown[];
  selected: number;
  pending: boolean;
  /** Suggestions were requested for display, not only the context published. */
  shown: boolean;
  popover: HTMLElement | null;
  unbind?: () => void;
}
const ownership = new WeakMap<SuggestLike, Session>();

// Obsidian keeps a closed suggestion's last context after its editor loses
// focus, such as Live Preview's after switching the note to Butter. Only an
// editor that reports no focus releases it; unknown focus never does.
function released(suggest: SuggestLike): boolean {
  if ((suggest as { isOpen?: unknown }).isOpen === true) return false;
  try { return (suggest.context?.editor as { hasFocus?: () => unknown } | undefined)?.hasFocus?.() === false; }
  catch { return false; }
}

export function suggestBridgePlugin(
  app: App, serialize: Serializer, getFile: () => TFile | null,
  sourceHost?: (view: EditorView) => EditorSourceHost,
) {
  const controls = new WeakMap<EditorView, {
    close(): void; focus(): void; key(event: KeyboardEvent): boolean; typed(): void;
  }>();
  // Keys that edit text, including those a keymap handles before `beforeinput`.
  const editingKey = (event: KeyboardEvent) =>
    (event.key.length === 1 && !event.ctrlKey && !event.metaKey) ||
    event.key === "Backspace" || event.key === "Delete" || event.key === "Enter" || event.key === "Tab";
  return new PMPlugin({
    key: new PluginKey("butter-suggest-bridge"),
    view(view) {
      const shim = new PMEditorShim(view, serialize, sourceHost?.(view));
      const ownerWindow = view.dom.ownerDocument.defaultView!;
      let active: Session | null = null, version = 0, destroyed = false, selecting = false;
      let timer: number | null = null;
      let published: { doc: EditorView["state"]["doc"]; head: number } | null = null;
      // Like Live Preview, only typing or deleting opens suggestions. Other
      // editor updates publish the context and refresh suggestions already shown.
      let typedAt = -Infinity, pendingOpen = false;
      const fastTriggers = new Set(["[", "]", "@", ":", "$", "!"]);
      const registered = (): SuggestLike[] => {
        const list = app.workspace.editorSuggest?.suggests;
        return Array.isArray(list) ? list as unknown as SuggestLike[] : [];
      };
      const retire = (session = active) => {
        if (!session) return;
        if (active === session) active = null;
        session.popover?.remove(); session.popover = null;
        session.unbind?.(); session.unbind = undefined;
        if (ownership.get(session.suggest) !== session) return;
        ownership.delete(session.suggest);
        if (session.suggest.context === session.context) {
          session.suggest.context = null;
          try { session.suggest.close?.(); } catch { /* Already retired. */ }
        }
      };
      const close = () => {
        version++; pendingOpen = false;
        if (timer !== null) ownerWindow.clearTimeout(timer);
        timer = null;
        retire();
      };
      const current = (s: Session, revision: number) => {
        if (destroyed || view.isDestroyed || version !== revision || active !== s ||
          !view.editable || !view.hasFocus() || view.state.doc !== s.doc ||
          !view.state.selection.eq(s.selection) || getFile() !== s.context.file ||
          ownership.get(s.suggest) !== s || s.suggest.context !== s.context ||
          !registered().includes(s.suggest)) return false;
        // Frontmatter or save settings can change without changing the PM body.
        try { return shim.getValue() === s.source; } catch { return false; }
      };
      const select = (s: Session, event: MouseEvent | KeyboardEvent) => {
        if (s.pending) return false;
        if (!current(s, version)) { retire(s); return false; }
        if (s.selected < 0 || s.selected >= s.items.length) return false;
        event.preventDefault();
        selecting = true; version++;
        s.popover?.remove(); s.popover = null; s.unbind?.(); s.unbind = undefined;
        // Keep the public context alive through the synchronous callback.
        // Its edits update PM views, without starting another suggestion session.
        try {
          const result: unknown = s.suggest.selectSuggestion(s.items[s.selected], event);
          // The public callback is synchronous. Contain a plugin's rejected
          // promise; its expired context cannot perform delayed editor writes.
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(result).catch(error => console.error("[butter-editor] selectSuggestion failed:", error));
          }
        }
        catch (error) { console.error("[butter-editor] selectSuggestion failed:", error); }
        finally { selecting = false; typedAt = -Infinity; pendingOpen = false; retire(s); }
        return true;
      };
      const highlight = (s: Session) => s.popover?.querySelectorAll(".suggestion-item")
        .forEach((el, index) => el.classList.toggle("is-selected", index === s.selected));
      const render = (s: Session) => {
        const document = view.dom.ownerDocument, win = document.defaultView;
        if (!win) { retire(s); return; }
        if (!s.popover) {
          const pop = document.win.createDiv();
          pop.className = "butter-surface butter-surface--compact suggestion-container butter-suggest-ext butter-pos-fixed-popover";
          s.popover = pop; document.body.appendChild(pop);
          const outside = (event: Event) => {
            if (!pop.contains(event.target as Node) && !view.dom.contains(event.target as Node)) close();
          };
          let frame: number | null = null;
          const position = () => {
            if (s.popover !== pop || !pop.isConnected || view.isDestroyed) return;
            const coords = view.coordsAtPos(view.state.selection.head);
            pop.style.setProperty("--butter-pos-left", `${coords.left}px`);
            pop.style.setProperty("--butter-pos-top", `${coords.bottom + 4}px`);
            if (pop.getBoundingClientRect().bottom > win.innerHeight - 12) {
              pop.style.setProperty("--butter-pos-top", `${coords.top - pop.getBoundingClientRect().height - 4}px`);
            }
          };
          const schedulePosition = () => {
            if (frame !== null) return;
            frame = win.requestAnimationFrame(() => { frame = null; position(); });
          };
          document.addEventListener("mousedown", outside, true);
          document.addEventListener("scroll", schedulePosition, true);
          win.addEventListener("resize", schedulePosition);
          s.unbind = () => {
            if (frame !== null) win.cancelAnimationFrame(frame);
            document.removeEventListener("mousedown", outside, true);
            document.removeEventListener("scroll", schedulePosition, true);
            win.removeEventListener("resize", schedulePosition);
          };
          schedulePosition();
        }
        const pop = s.popover;
        pop.replaceChildren();
        const container = document.win.createDiv(); container.className = "suggestion";
        for (const [index, item] of s.items.entries()) {
          const el = document.win.createDiv();
          el.className = "butter-surface-row butter-surface-row--compact suggestion-item";
          if (index === s.selected) el.classList.add("is-selected");
          s.suggest.renderSuggestion(item, el);
          el.addEventListener("mouseenter", () => { s.selected = index; highlight(s); });
          el.addEventListener("mousedown", event => {
            if (!s.popover?.contains(el)) return;
            s.selected = index; select(s, event);
          });
          container.appendChild(el);
        }
        pop.appendChild(container);
      };
      const update = async (revision: number, openIfClosed: boolean) => {
        try {
          if (destroyed || view.isDestroyed || !view.editable || !view.hasFocus()) { retire(); return; }
          const file = getFile(), suggests = registered();
          if (!file || !suggests.length) { retire(); return; }
          // Like Live Preview, selected text never queries or shows suggestions.
          if (!view.state.selection.empty) { retire(); return; }
          shim.refresh();
          const cursor = shim.getCursor();
          published = { doc: view.state.doc, head: view.state.selection.head };
          const candidates = active && suggests.includes(active.suggest)
            ? [active.suggest, ...suggests.filter(s => s !== active!.suggest)] : suggests;
          for (const suggest of candidates) {
            if (revision !== version) return;
            const prior = ownership.get(suggest);
            if (suggest.context && (!prior || prior.owner !== view || suggest.context !== prior.context) &&
              !released(suggest)) continue;
            let info: EditorSuggestTriggerInfo | null;
            try { info = suggest.onTrigger(cursor, shim, file); }
            catch { if (active?.suggest === suggest) retire(); continue; }
            if (revision !== version) return;
            if (!info) { if (active?.suggest === suggest) retire(); continue; }
            const context: EditorSuggestContext = { ...info, start: { ...info.start }, end: { ...info.end }, editor: shim as unknown as Editor, file };
            const open = openIfClosed || (active?.suggest === suggest && active.shown);
            if (active?.suggest !== suggest) retire();
            const s: Session = active ?? { owner: view, suggest, context, doc: view.state.doc, source: "",
              selection: view.state.selection, items: [], selected: 0, pending: true, shown: false, popover: null };
            s.context = context; s.doc = view.state.doc; s.selection = view.state.selection; s.pending = open; s.shown = open;
            s.source = shim.getValue();
            // A plugin may retain its context across await. Bind its Editor
            // methods to this request/file, while allowing the synchronous
            // selection callback to replace text and then position the caret.
            const guardContext = () => {
              if (destroyed || view.isDestroyed || !view.editable || !view.hasFocus() ||
                getFile() !== file || active !== s || ownership.get(suggest) !== s ||
                suggest.context !== context || s.context !== context ||
                (!selecting && !current(s, revision))) {
                throw new Error("Butter plugin edit: suggestion context expired");
              }
            };
            const editor = new Proxy(shim, {
              get(target, property) {
                const value: unknown = Reflect.get(target, property, target);
                if (typeof value !== "function") return value;
                return (...args: unknown[]): unknown => {
                  guardContext();
                  if (property === "getDoc") return editor;
                  const result: unknown = Reflect.apply(value, target, args);
                  return result;
                };
              },
            });
            context.editor = editor as unknown as Editor;
            active = s; ownership.set(suggest, s); suggest.context = context;
            if (!open) { s.items = []; return; }
            let items: unknown[];
            try { items = await suggest.getSuggestions(context); }
            catch { if (revision === version) retire(s); return; }
            if (!current(s, revision)) { if (revision === version) retire(s); return; }
            s.items = Array.isArray(items) ? items.slice(0, Math.max(0, Math.min(suggest.limit ?? 50, 50))) : [];
            s.selected = 0; s.pending = false;
            if (!s.items.length) retire(s); else render(s);
            return;
          }
          retire();
        } catch { if (revision === version) retire(); }
      };
      const run = (revision: number) => {
        const open = pendingOpen;
        pendingOpen = false;
        void update(revision, open);
      };
      controls.set(view, {
        close,
        focus() { if (selecting) return; close(); void update(version, false); },
        typed() { typedAt = Date.now(); },
        key(event) {
          const s = active;
          if (!s?.shown) return false;
          if (event.key === "Escape") { event.preventDefault(); close(); return true; }
          if (s.pending || !s.popover) return false;
          if (!current(s, version)) { close(); return false; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            s.selected = Math.max(0, Math.min(s.items.length - 1, s.selected + (event.key === "ArrowDown" ? 1 : -1)));
            highlight(s); return true;
          }
          return event.key === "Enter" || event.key === "Tab" ? select(s, event) : false;
        },
      });
      const refreshFileContext = () => {
        if (destroyed || selecting || view.isDestroyed || !view.editable || !view.hasFocus() || !registered().length) return;
        const revision = ++version;
        if (active) active.pending = true;
        if (timer !== null) ownerWindow.clearTimeout(timer);
        // Native lifecycle subscribers may finish their current-file indexing
        // asynchronously. Publish the actual file transition through the same
        // bounded idle query path, without mutating any provider's state.
        timer = ownerWindow.setTimeout(() => { timer = null; run(revision); }, view.state.doc.content.size > 20_000 ? 500 : 50);
      };
      const fileEvent = app.workspace.on("file-open", file => { if (file === getFile()) refreshFileContext(); });
      const leafEvent = app.workspace.on("active-leaf-change", leaf => {
        if (leaf?.view.containerEl.contains(view.dom)) refreshFileContext();
      });
      return {
        update(v, previous) {
          if (selecting) return;
          const docChanged = !v.state.doc.eq(previous.doc);
          // A keystroke's DOM change can arrive a little after its key event.
          // Each keystroke vouches for one edit, not for later plugin edits.
          if (docChanged && (v.composing || Date.now() - typedAt < 250)) { pendingOpen = true; typedAt = -Infinity; }
          if (!docChanged && v.state.selection.eq(previous.selection)) return;
          const revision = ++version;
          if (active) active.pending = true;
          if (timer !== null) ownerWindow.clearTimeout(timer);
          timer = null;
          if (!v.editable || !v.hasFocus() || !registered().length) { pendingOpen = false; retire(); return; }
          // Stateful EditorSuggest implementations observe navigation before
          // the next typing burst. Coalescing it into typing can leave their
          // previous-line cache bound to the editor we just left.
          if (!docChanged && v.state.selection.empty) {
            const head = v.state.selection.$head;
            const prior = published?.doc === v.state.doc ? v.state.doc.resolve(published.head) : previous.selection.$head;
            let crossedLine = head.start() !== prior.start();
            if (!crossedLine && head.pos !== prior.pos) {
              const from = Math.min(head.pos, prior.pos), to = Math.max(head.pos, prior.pos);
              v.state.doc.nodesBetween(from, to, (node, pos) => {
                if (node.type.name === "hard_break" || (node.isText &&
                  node.text!.slice(Math.max(0, from - pos), Math.max(0, to - pos)).includes("\n"))) crossedLine = true;
                return !crossedLine;
              });
            }
            if (crossedLine) { run(revision); return; }
          }
          const head = v.state.selection.head;
          // Publish common trigger contexts before the next keystroke. All
          // other characters remain eligible after idle; none are blacklisted.
          const immediate = head > 0 && fastTriggers.has(v.state.doc.textBetween(head - 1, head));
          if (immediate) { run(revision); return; }
          // Exact source coordinates require save-policy verification. Keep
          // that work off continuous large-note typing rather than repeating a
          // full-file cursor probe on every character.
          timer = ownerWindow.setTimeout(() => { timer = null; run(revision); }, v.state.doc.content.size > 20_000 ? 500 : 50);
        },
        destroy() {
          destroyed = true; close(); controls.delete(view);
          app.workspace.offref(fileEvent); app.workspace.offref(leafEvent);
        },
      };
    },
    props: {
      handleKeyDown: (view, event) => {
        // Also sees keys ProseMirror synthesizes for mobile input.
        if (editingKey(event)) controls.get(view)?.typed();
        return controls.get(view)?.key(event) ?? false;
      },
      handleDOMEvents: {
        blur(view) { controls.get(view)?.close(); return false; },
        focus(view, event) { if (event.target === view.dom) controls.get(view)?.focus(); return false; },
        keydown(view, event) { if (editingKey(event)) controls.get(view)?.typed(); return false; },
        beforeinput(view, event) {
          if (/^(?:insert|delete)/.test(event.inputType)) controls.get(view)?.typed();
          return false;
        },
        paste(view) { controls.get(view)?.typed(); return false; },
        cut(view) { controls.get(view)?.typed(); return false; },
        drop(view) { controls.get(view)?.typed(); return false; },
      },
    },
  });
}
