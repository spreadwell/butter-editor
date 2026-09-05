/**
 * In-note find / replace.
 *
 *   Ctrl+F      - open the search bar, focus the search input
 *   Ctrl+H      - open the search bar with the replace row showing
 *   Enter       - next match
 *   Shift+Enter - previous match
 *   Escape      - close the bar and restore focus to the editor
 *
 * The bar floats above the editor, tracks the current / total match
 * count, highlights all matches as an inline decoration set, and
 * supports case-sensitive and regex modes. Replace is a single-match
 * operation; Replace-All replaces every match in the doc.
 *
 * Exposed via a PM plugin and two imperative entry points
 * (`openFind`, `openReplace`) the plugin's command registrations call.
 */
import {
  Plugin as PMPlugin,
  PluginKey,
  TextSelection,
  NodeSelection,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { Platform, setIcon } from "obsidian";
import { tx } from "../i18n";
import { executeSearch, searchSegments, RegexSearch, type SearchMatch, type SearchResult } from "./search-engine";
import { revealHeadingPosition } from "./heading-folding";
import { revealCalloutPosition } from "./fold-reveal";
import { visibleEditorBounds } from "../ui/toolbar-layout";

// ═══════════════════════════════════════════
//  Plugin state + match computation
// ═══════════════════════════════════════════

interface SearchState {
  query: string;
  replace: string;
  caseSensitive: boolean;
  regex: boolean;
  matches: SearchMatch[];
  pending: boolean;
  revision: number;
  error?: SearchResult["error"];
  preferredFrom?: number;
  currentIndex: number;
  open: boolean;
  replaceVisible: boolean;
}

interface SearchMeta extends Partial<SearchState> {
  /** Preferred position in the transaction's resulting document. */
  preferredFrom?: number;
}

const emptyState: SearchState = {
  query: "",
  replace: "",
  caseSensitive: false,
  regex: false,
  matches: [],
  pending: false,
  revision: 0,
  currentIndex: -1,
  open: false,
  replaceVisible: false,
};

const key = new PluginKey<SearchState>("butter-search");
const searchUiByView = new WeakMap<EditorView, UIRefs>();

interface SearchPluginOptions {
  getMainToolbarDom?: () => HTMLElement | null;
  getMobileStyle?: () => "detached" | "attached";
}

// ═══════════════════════════════════════════
//  Plugin + UI
// ═══════════════════════════════════════════

interface UIRefs {
  root: HTMLElement;
  queryInput: HTMLInputElement;
  replaceRow: HTMLElement;
  replaceInput: HTMLInputElement;
  countEl: HTMLElement;
  caseBtn: HTMLElement;
  regexBtn: HTMLElement;
  refs: {
    prevBtn: HTMLElement;
    nextBtn: HTMLElement;
    toggleReplaceBtn: HTMLElement;
    closeBtn: HTMLElement;
    replaceBtn: HTMLElement;
    replaceAllBtn: HTMLElement;
  };
}

let searchLandmarkLabelId = 0;

function buildUI(doc: Document): UIRefs {
  const root = doc.win.createDiv();
  root.className = "butter-search-bar";
  root.setAttribute("role", "search");
  // Keep the search landmark named without invoking Obsidian's global
  // aria-label tooltip behavior on this non-action container.
  const landmarkLabel = root.createSpan({
    cls: "butter-visually-hidden",
    text: tx("Find in note"),
  });
  landmarkLabel.id = `butter-search-landmark-label-${++searchLandmarkLabelId}`;
  root.setAttribute("aria-labelledby", landmarkLabel.id);

  const inner = root.createDiv({
    cls: "butter-search-toolbar-inner butter-context-toolbar-inner",
  });
  const row1 = inner.createDiv({ cls: "butter-search-row butter-search-row-main" });
  const toggleReplaceBtn = row1.createEl("button", {
    cls: "butter-search-tool butter-search-nav butter-context-toolbar-btn clickable-icon",
    attr: {
      "aria-label": tx("Toggle replace (Ctrl+H)"),
    },
  });
  setIcon(toggleReplaceBtn, "chevron-right");

  const queryField = row1.createDiv({ cls: "butter-search-field" });
  const iconWrap = queryField.createDiv({ cls: "butter-search-icon" });
  setIcon(iconWrap, "search");

  const queryInput = queryField.createEl("input", {
    cls: "butter-search-input",
    attr: {
      type: "text",
      placeholder: tx("Find in note..."),
      "aria-label": tx("Find in note"),
      spellcheck: "false",
    },
  });

  const countEl = queryField.createDiv({ cls: "butter-search-count" });
  countEl.textContent = "";
  countEl.setAttribute("aria-live", "polite");

  const caseBtn = row1.createEl("button", {
    cls: "butter-search-tool butter-search-flag butter-context-toolbar-btn clickable-icon",
    attr: { "aria-label": tx("Match case") },
  });
  caseBtn.textContent = "Aa";

  const regexBtn = row1.createEl("button", {
    cls: "butter-search-tool butter-search-flag butter-context-toolbar-btn clickable-icon",
    attr: {
      "aria-label": tx("Use regular expression"),
    },
  });
  regexBtn.textContent = ".*";

  row1.createDiv({ cls: "butter-search-divider" });

  const prevBtn = row1.createEl("button", {
    cls: "butter-search-tool butter-search-nav butter-context-toolbar-btn clickable-icon",
    attr: {
      "aria-label": tx("Previous match (Shift+Enter)"),
    },
  });
  setIcon(prevBtn, "chevron-up");

  const nextBtn = row1.createEl("button", {
    cls: "butter-search-tool butter-search-nav butter-context-toolbar-btn clickable-icon",
    attr: {
      "aria-label": tx("Next match (enter)"),
    },
  });
  setIcon(nextBtn, "chevron-down");

  const closeBtn = row1.createEl("button", {
    cls: "butter-search-tool butter-search-nav butter-context-toolbar-btn clickable-icon",
    attr: {
      "aria-label": tx("Close (escape)"),
    },
  });
  setIcon(closeBtn, "x");

  const replaceRow = inner.createDiv({ cls: "butter-search-row butter-search-row-replace" });
  replaceRow.createDiv({ cls: "butter-search-replace-spacer" });
  const replaceField = replaceRow.createDiv({ cls: "butter-search-field" });
  const rSpacer = replaceField.createDiv({ cls: "butter-search-icon" });
  setIcon(rSpacer, "corner-down-right");

  const replaceInput = replaceField.createEl("input", {
    cls: "butter-search-input",
    attr: {
      type: "text",
      placeholder: tx("Replace with..."),
      "aria-label": tx("Replace with..."),
      spellcheck: "false",
    },
  });

  const replaceBtn = replaceRow.createEl("button", {
    cls: "butter-search-tool butter-search-action butter-context-toolbar-btn clickable-icon",
    attr: { "aria-label": tx("Replace") },
  });
  setIcon(replaceBtn, "replace");

  const replaceAllBtn = replaceRow.createEl("button", {
    cls: "butter-search-tool butter-search-action butter-context-toolbar-btn clickable-icon",
    attr: { "aria-label": tx("All") },
  });
  setIcon(replaceAllBtn, "replace-all");

  // Imperative wiring is attached by the view() callback via closures
  // over the PM view. We expose the DOM refs via the return value.
  return {
    root,
    queryInput,
    replaceRow,
    replaceInput,
    countEl,
    caseBtn,
    regexBtn,
    refs: {
      prevBtn,
      nextBtn,
      toggleReplaceBtn,
      closeBtn,
      replaceBtn,
      replaceAllBtn,
    },
  };
}

// ═══════════════════════════════════════════
//  Plugin
// ═══════════════════════════════════════════

export function searchPlugin(
  options: SearchPluginOptions = {},
): PMPlugin<SearchState> {
  return new PMPlugin<SearchState>({
    key,
    state: {
      init: () => ({ ...emptyState }),
      apply(tr, old) {
        const meta = tr.getMeta(key) as SearchMeta | undefined;
        let next = old;
        if (meta) next = { ...old, ...meta };
        const changed = tr.docChanged || (meta &&
          ["query", "caseSensitive", "regex", "replace", "open"].some(name => name in meta));
        if (changed) {
          const oldCurrent = old.matches[old.currentIndex];
          const preferredFrom = meta?.preferredFrom ??
            (oldCurrent ? tr.mapping.map(oldCurrent.from, 1) : 0);
          const pending = next.open && next.regex && !!next.query;
          const result = next.open && !next.regex
            ? executeSearch({ ...next, segments: searchSegments(tr.doc) })
            : { matches: [] };
          const index = result.matches.findIndex(match => match.from >= preferredFrom);
          next = { ...next, ...result, error: result.error, pending,
            preferredFrom, revision: old.revision + 1,
            currentIndex: result.matches.length ? Math.max(0, index) : -1 };
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        const s = key.getState(state);
        if (!s?.open || !s.matches.length) return null;
        const decos = s.matches.map((m, i) => {
          const attrs = {
            class:
              i === s.currentIndex
                ? "butter-search-match is-current"
                : "butter-search-match",
          };
          if (m.atom) return Decoration.node(m.from, m.to, attrs);
          if (m.from === m.to) return Decoration.widget(m.from, view => {
            const marker = view.dom.ownerDocument.win.createSpan();
            marker.className = attrs.class + " butter-search-zero-width";
            marker.setAttribute("aria-hidden", "true");
            return marker;
          });
          return Decoration.inline(m.from, m.to, attrs);
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
    view(view) {
      const doc = view.dom.ownerDocument;
      const ui = buildUI(doc);
      const regexSearch = new RegexSearch();
      let alive = true;
      let requestedRevision = -1;
      const refreshRegex = (v: EditorView) => {
        const state = key.getState(v.state)!;
        if (requestedRevision === state.revision) return;
        requestedRevision = state.revision;
        regexSearch.cancel();
        if (!state.pending) return;
        const doc = v.state.doc;
        queueMicrotask(() => {
          if (!alive || key.getState(v.state)?.revision !== state.revision) return;
          regexSearch.run({ ...state, segments: searchSegments(doc) }, result => {
            if (!alive || key.getState(v.state)?.revision !== state.revision) return;
            const index = result.matches.findIndex(match => match.from >= (state.preferredFrom ?? 0));
            const currentIndex = result.matches.length ? Math.max(0, index) : -1;
            v.dispatch(v.state.tr.setMeta(key, { ...result, pending: false, currentIndex }));
            if (currentIndex >= 0) scrollToMatch(v, result.matches[currentIndex]);
          });
        });
      };
      const isMobile = Platform.isMobile;
      ui.root.classList.add(
        "butter-search-toolbar",
        "butter-context-toolbar",
        "is-hidden",
      );
      searchUiByView.set(view, ui);

      if (isMobile) {
        ui.root.classList.add("butter-mobile-search-toolbar", "butter-mobile-bar");
        ui.root.dataset.mobileStyle = options.getMobileStyle?.() ?? "attached";
        doc.body.appendChild(ui.root);
      }

      const ensureMounted = () => {
        if (isMobile) {
          if (ui.root.parentElement !== doc.body) {
            doc.body.appendChild(ui.root);
          }
          ui.root.dataset.mobileStyle = options.getMobileStyle?.() ?? "attached";
          return true;
        }
        const main = options.getMainToolbarDom?.();
        if (!main?.parentElement) return false;
        const parent = main.parentElement;
        const pos = main.getAttribute("data-toolbar-pos");
        const wantBefore = pos === "bottom";
        if (wantBefore) {
          if (ui.root.parentElement !== parent || ui.root.nextElementSibling !== main) {
            parent.insertBefore(ui.root, main);
          }
        } else if (
          ui.root.parentElement !== parent ||
          ui.root.previousElementSibling !== main
        ) {
          parent.insertBefore(ui.root, main.nextSibling);
        }
        const style = main.getAttribute("data-toolbar-style");
        const activeStyle = main.getAttribute("data-active-style");
        if (pos) ui.root.dataset.toolbarPos = pos;
        if (style) ui.root.dataset.toolbarStyle = style;
        if (activeStyle) ui.root.dataset.activeStyle = activeStyle;
        return true;
      };

      const setToolbarVisible = (visible: boolean) => {
        if (visible && !ensureMounted()) return false;
        ui.root.classList.toggle("is-hidden", !visible);
        if (isMobile) {
          doc.body.classList.toggle("butter-mobile-search-active", !!doc.body.querySelector(".butter-mobile-search-toolbar:not(.is-hidden)"));
          return true;
        }
        const root = ui.root.closest(".butter-view-root");
        const stack = ui.root.closest(".butter-toolbar-stack");
        root?.classList.toggle("butter-has-search-toolbar", visible);
        stack?.classList.toggle("butter-has-search-toolbar", visible);
        const tableToolbar = ui.root.parentElement?.querySelector<HTMLElement>(
          ":scope > .butter-table-toolbar",
        );
        tableToolbar?.classList.toggle("butter-search-suppressed", visible);
        return true;
      };

      // Wire input handlers
      ui.queryInput.addEventListener("input", () => {
        updateQuery(view, ui.queryInput.value);
      });
      ui.replaceInput.addEventListener("input", () => {
        const meta: SearchMeta = { replace: ui.replaceInput.value };
        view.dispatch(view.state.tr.setMeta(key, meta));
      });
      // The panel is a sibling of the ProseMirror content DOM, so keyboard
      // events from its inputs never reach `props.handleKeyDown`. Own the
      // panel keys directly and stop them before Obsidian treats Enter/Escape
      // as editor or modal shortcuts.
      let composing = false;
      ui.root.addEventListener("compositionstart", () => { composing = true; });
      ui.root.addEventListener("compositionend", () => { composing = false; });
      ui.root.addEventListener("keydown", (event: KeyboardEvent) => {
        // WebKit may end composition before the confirming keydown; 229 is
        // the documented fallback when isComposing is already false.
        if (composing || event.isComposing || Reflect.get(event, "keyCode") === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          navigate(view, event.shiftKey ? -1 : 1);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeSearch(view);
        }
      });

      const refs = ui.refs;
      refs.prevBtn.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        navigate(view, -1);
      });
      refs.nextBtn.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        navigate(view, 1);
      });
      refs.toggleReplaceBtn.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        toggleReplace(view);
      });
      refs.closeBtn.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        closeSearch(view);
      });
      refs.replaceBtn.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        replaceCurrent(view);
      });
      refs.replaceAllBtn.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        replaceAll(view);
      });

      ui.caseBtn.addEventListener("click", () => {
        const state = key.getState(view.state)!;
        view.dispatch(view.state.tr.setMeta(key, { caseSensitive: !state.caseSensitive }));
        const next = key.getState(view.state)!;
        if (next.currentIndex >= 0) scrollToMatch(view, next.matches[next.currentIndex]);
      });
      ui.regexBtn.addEventListener("click", () => {
        const state = key.getState(view.state)!;
        view.dispatch(view.state.tr.setMeta(key, { regex: !state.regex }));
        const next = key.getState(view.state)!;
        if (next.currentIndex >= 0) scrollToMatch(view, next.matches[next.currentIndex]);
      });

      // Initial UI sync
      syncUI(view, ui);

      return {
        update(v) {
          refreshRegex(v);
          syncUI(v, ui);
          setToolbarVisible(key.getState(v.state)?.open === true);
        },
        destroy() {
          alive = false;
          regexSearch.cancel();
          setToolbarVisible(false);
          searchUiByView.delete(view);
          ui.root.remove();
        },
      };
    },
  });
}

// ═══════════════════════════════════════════
//  External API (called by command registrations)
// ═══════════════════════════════════════════

function openSearch(view: EditorView, replaceVisible: boolean) {
  const s = key.getState(view.state);
  const selection = view.state.selection;
  const initial = !selection.empty && selection.$from.sameParent(selection.$to)
    ? view.state.doc.textBetween(selection.from, selection.to)
    : "";
  const query = initial && !initial.includes("\n") ? initial : (s?.query ?? "");
  view.dispatch(view.state.tr.setMeta(key, {
    open: true, replaceVisible, query, preferredFrom: selection.from,
  } satisfies SearchMeta));
  const next = key.getState(view.state)!;
  if (next.currentIndex >= 0) scrollToMatch(view, next.matches[next.currentIndex]);

  const focusInput = () => {
    if (!key.getState(view.state)?.open || key.getState(view.state)?.revision !== next.revision || !searchUiByView.has(view)) return;
    const input = searchUiByView.get(view)?.queryInput ??
      view.dom.closest<HTMLElement>(".butter-view-root")
        ?.querySelector<HTMLInputElement>(".butter-search-toolbar:not(.is-hidden) .butter-search-input") ??
      null;
    if (input) {
      input.value = query;
      input.focus();
      input.select();
    }
  };
  focusInput();
  // Obsidian's command dispatcher may restore its originating focus after
  // the command callback. Reassert once at the end of that same turn. A timer
  // also keeps this reliable when a desktop window is temporarily occluded,
  // where Chromium is allowed to pause requestAnimationFrame callbacks.
  window.setTimeout(focusInput, 0);
}

export function openFind(view: EditorView) {
  openSearch(view, false);
}

export function openReplace(view: EditorView) {
  if (!view.editable) return;
  openSearch(view, true);
}

// ═══════════════════════════════════════════
//  Internal helpers
// ═══════════════════════════════════════════

function updateQuery(view: EditorView, query: string) {
  view.dispatch(view.state.tr.setMeta(key, { query, preferredFrom: 0 }));
  const state = key.getState(view.state)!;
  if (state.currentIndex >= 0) scrollToMatch(view, state.matches[state.currentIndex]);
}

function navigate(view: EditorView, dir: 1 | -1) {
  const s = key.getState(view.state);
  if (!s || !s.matches.length) return;
  const next =
    (s.currentIndex + dir + s.matches.length) % s.matches.length;
  view.dispatch(view.state.tr.setMeta(key, { currentIndex: next }));
  scrollToMatch(view, s.matches[next]);
}

function scrollToMatch(
  view: EditorView,
  match: SearchMatch,
) {
  revealHeadingPosition(view, match.from);
  revealCalloutPosition(view, match.from);
  const tr = view.state.tr.setSelection(match.atom
    ? NodeSelection.create(view.state.doc, match.from)
    : TextSelection.create(view.state.doc, match.from, match.to));
  view.dispatch(tr.scrollIntoView());
  revealCurrentMatch(view, match);
}

/** ProseMirror's scrollIntoView only reasons about the selection and its
 * nearest scroll parent. Find keeps focus in a toolbar sibling, and attached
 * toolbars can cover part of that scroll parent, so explicitly reveal the
 * painted current-match decoration inside Butter's actual note viewport. */
function revealCurrentMatch(
  view: EditorView,
  expected: { from: number; to: number },
) {
  window.setTimeout(() => {
    const state = key.getState(view.state);
    const current = state?.matches[state.currentIndex];
    if (!current || current.from !== expected.from || current.to !== expected.to) return;

    const scrollHost = view.dom.closest<HTMLElement>(".butter-editor-view");
    if (!scrollHost) return;
    const pieces = Array.from(
      view.dom.querySelectorAll<HTMLElement>(".butter-search-match.is-current"),
    );
    if (!pieces.length) return;

    const rects = pieces.map((piece) => piece.getBoundingClientRect());
    const matchTop = Math.min(...rects.map((rect) => rect.top));
    const matchBottom = Math.max(...rects.map((rect) => rect.bottom));
    const { top: visibleTop, bottom: visibleBottom } = visibleEditorBounds(scrollHost);

    let delta = 0;
    if (matchTop < visibleTop) delta = matchTop - visibleTop;
    else if (matchBottom > visibleBottom) delta = matchBottom - visibleBottom;
    if (Math.abs(delta) >= 0.5) scrollHost.scrollTop += delta;
  }, 0);
}

function replaceCurrent(view: EditorView) {
  if (!view.editable) return;
  const s = key.getState(view.state);
  if (!s || !s.matches.length || s.currentIndex < 0) return;
  const match = s.matches[s.currentIndex];
  if (s.pending || match.atom) return;
  const replacement = s.regex ? match.replacement : s.replace;
  const tr = view.state.tr
    .insertText(replacement, match.from, match.to)
    .setMeta(key, { preferredFrom: match.from + Math.max(1, replacement.length) } satisfies SearchMeta);
  view.dispatch(tr);
  const next = key.getState(view.state);
  if (next && next.currentIndex >= 0) scrollToMatch(view, next.matches[next.currentIndex]);
}

function replaceAll(view: EditorView) {
  if (!view.editable) return;
  const s = key.getState(view.state);
  if (!s || s.pending || !s.matches.length) return;
  const tr = view.state.tr;
  // Replace in reverse so earlier positions stay valid.
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i];
    if (!m.atom) tr.insertText(s.regex ? m.replacement : s.replace, m.from, m.to);
  }
  view.dispatch(tr);
}

function toggleReplace(view: EditorView) {
  if (!view.editable) return;
  const s = key.getState(view.state)!;
  view.dispatch(
    view.state.tr.setMeta(key, { replaceVisible: !s.replaceVisible }),
  );
}

function closeSearch(view: EditorView) {
  view.dispatch(
    view.state.tr.setMeta(key, {
      open: false,
      replaceVisible: false,
      matches: [],
      currentIndex: -1,
    }),
  );
  view.focus();
}

function syncUI(view: EditorView, ui: UIRefs) {
  const s = key.getState(view.state);
  if (!s) return;
  ui.replaceRow.classList.toggle("is-visible", s.replaceVisible);
  if (ui.queryInput.value !== s.query) ui.queryInput.value = s.query;
  if (ui.replaceInput.value !== s.replace) ui.replaceInput.value = s.replace;
  ui.caseBtn.classList.toggle("is-active", s.caseSensitive);
  ui.regexBtn.classList.toggle("is-active", s.regex);
  setIcon(ui.refs.toggleReplaceBtn, s.replaceVisible ? "chevron-down" : "chevron-right");
  ui.caseBtn.setAttribute("aria-pressed", String(s.caseSensitive));
  ui.regexBtn.setAttribute("aria-pressed", String(s.regex));
  const replaceDisabled = !view.editable;
  ui.replaceInput.disabled = replaceDisabled;
  for (const button of [
    ui.refs.toggleReplaceBtn,
    ui.refs.replaceBtn,
    ui.refs.replaceAllBtn,
  ]) {
    (button as HTMLButtonElement).disabled = replaceDisabled;
    button.classList.toggle("is-disabled", replaceDisabled);
    button.setAttribute("aria-disabled", String(replaceDisabled));
  }

  ui.refs.replaceBtn.setAttribute("aria-disabled", String(replaceDisabled || s.pending || !s.matches.length || !!s.matches[s.currentIndex]?.atom));
  (ui.refs.replaceBtn as HTMLButtonElement).disabled = replaceDisabled || s.pending || !s.matches.length || !!s.matches[s.currentIndex]?.atom;
  (ui.refs.replaceAllBtn as HTMLButtonElement).disabled = replaceDisabled || s.pending || !s.matches.some(match => !match.atom);
  ui.queryInput.setAttribute("aria-invalid", String(!!s.error));
  if (s.pending) ui.countEl.textContent = tx("Searching...");
  else if (s.error) ui.countEl.textContent = s.error === "invalid" ? tx("Invalid regular expression") : tx("Search is too complex or unavailable");
  else if (s.matches[s.currentIndex]?.atom) ui.countEl.textContent = `${s.currentIndex + 1} / ${s.matches.length} · ${tx("Label (find only)")}`;
  else if (!s.matches.length) {
    ui.countEl.textContent = s.query ? tx("No matches") : "";
  } else {
    ui.countEl.textContent = `${s.currentIndex + 1} / ${s.matches.length}`;
  }
}
