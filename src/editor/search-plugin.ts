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
  type EditorState,
  TextSelection,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { setIcon } from "obsidian";

// ═══════════════════════════════════════════
//  Plugin state + match computation
// ═══════════════════════════════════════════

interface SearchState {
  query: string;
  replace: string;
  caseSensitive: boolean;
  regex: boolean;
  matches: Array<{ from: number; to: number }>;
  currentIndex: number;
  open: boolean;
  replaceVisible: boolean;
}

const emptyState: SearchState = {
  query: "",
  replace: "",
  caseSensitive: false,
  regex: false,
  matches: [],
  currentIndex: -1,
  open: false,
  replaceVisible: false,
};

const key = new PluginKey<SearchState>("butter-search");

function findAllMatches(
  doc: EditorState["doc"],
  query: string,
  caseSensitive: boolean,
  regex: boolean,
): Array<{ from: number; to: number }> {
  if (!query) return [];
  const matches: Array<{ from: number; to: number }> = [];
  let pattern: RegExp;
  try {
    pattern = regex
      ? new RegExp(query, caseSensitive ? "g" : "gi")
      : new RegExp(
          query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          caseSensitive ? "g" : "gi",
        );
  } catch {
    return [];
  }

  // Gather textblock contents with their doc offset so regex can span
  // a whole textblock (but not across blocks - the boundary breaks it).
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textContent;
    if (!text) return false;
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text))) {
      if (m[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      matches.push({
        from: pos + 1 + m.index,
        to: pos + 1 + m.index + m[0].length,
      });
    }
    return false;
  });

  return matches;
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

function buildUI(): UIRefs {
  const root = activeDocument.createElement("div");
  root.className = "butter-search-bar";
  root.setAttribute("role", "search");

  const row1 = root.createDiv({ cls: "butter-search-row" });
  const iconWrap = row1.createDiv({ cls: "butter-search-icon" });
  setIcon(iconWrap, "search");

  const queryInput = row1.createEl("input", {
    cls: "butter-search-input",
    attr: { type: "text", placeholder: "Find in note…", spellcheck: "false" },
  });

  const countEl = row1.createDiv({ cls: "butter-search-count" });
  countEl.textContent = "";

  const caseBtn = row1.createEl("button", {
    cls: "butter-search-flag",
    attr: { title: "Match case" },
  });
  caseBtn.textContent = "Aa";

  const regexBtn = row1.createEl("button", {
    cls: "butter-search-flag",
    attr: { title: "Use regular expression" },
  });
  regexBtn.textContent = ".*";

  const prevBtn = row1.createEl("button", {
    cls: "butter-search-nav clickable-icon",
    attr: { title: "Previous match (Shift+Enter)" },
  });
  setIcon(prevBtn, "chevron-up");

  const nextBtn = row1.createEl("button", {
    cls: "butter-search-nav clickable-icon",
    attr: { title: "Next match (enter)" },
  });
  setIcon(nextBtn, "chevron-down");

  const toggleReplaceBtn = row1.createEl("button", {
    cls: "butter-search-nav clickable-icon",
    attr: { title: "Toggle replace (Ctrl+H)" },
  });
  setIcon(toggleReplaceBtn, "replace");

  const closeBtn = row1.createEl("button", {
    cls: "butter-search-nav clickable-icon",
    attr: { title: "Close (escape)" },
  });
  setIcon(closeBtn, "x");

  const replaceRow = root.createDiv({ cls: "butter-search-row" });
  replaceRow.addClass("butter-hidden");
  const rSpacer = replaceRow.createDiv({ cls: "butter-search-icon" });
  setIcon(rSpacer, "corner-down-right");

  const replaceInput = replaceRow.createEl("input", {
    cls: "butter-search-input",
    attr: { type: "text", placeholder: "Replace with…", spellcheck: "false" },
  });

  const replaceBtn = replaceRow.createEl("button", {
    cls: "butter-search-action",
  });
  replaceBtn.textContent = "Replace";

  const replaceAllBtn = replaceRow.createEl("button", {
    cls: "butter-search-action",
  });
  replaceAllBtn.textContent = "All";

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

export function searchPlugin(): PMPlugin<SearchState> {
  return new PMPlugin<SearchState>({
    key,
    state: {
      init: () => ({ ...emptyState }),
      apply(tr, old) {
        const meta = tr.getMeta(key) as Partial<SearchState> | undefined;
        let next = old;
        if (meta) next = { ...old, ...meta };
        if (tr.docChanged && next.open && next.query) {
          const matches = findAllMatches(
            tr.doc,
            next.query,
            next.caseSensitive,
            next.regex,
          );
          next = {
            ...next,
            matches,
            currentIndex: matches.length ? 0 : -1,
          };
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        const s = key.getState(state);
        if (!s?.open || !s.matches.length) return null;
        const decos = s.matches.map((m, i) =>
          Decoration.inline(m.from, m.to, {
            class:
              i === s.currentIndex
                ? "butter-search-match is-current"
                : "butter-search-match",
          }),
        );
        return DecorationSet.create(state.doc, decos);
      },
      handleKeyDown(view, event) {
        const s = key.getState(view.state);
        if (!s?.open) return false;
        if (!view.dom.parentElement) return false;

        // We only claim keys when the search input or replace input
        // is focused; otherwise let the editor handle them normally.
        const target = event.target as HTMLElement;
        const insideBar = target.closest(".butter-search-bar");
        if (!insideBar) return false;

        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          navigate(view, 1);
          return true;
        }
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          navigate(view, -1);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeSearch(view);
          return true;
        }
        return false;
      },
    },
    view(view) {
      const ui = buildUI();
      const parent = view.dom.parentElement;
      if (parent) parent.appendChild(ui.root);

      // Wire input handlers
      ui.queryInput.addEventListener("input", () => {
        updateQuery(view, ui.queryInput.value);
      });
      ui.replaceInput.addEventListener("input", () => {
        const meta: Partial<SearchState> = { replace: ui.replaceInput.value };
        view.dispatch(view.state.tr.setMeta(key, meta));
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

      ui.caseBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const s = key.getState(view.state)!;
        ui.caseBtn.classList.toggle("is-active", !s.caseSensitive);
        const next: Partial<SearchState> = {
          caseSensitive: !s.caseSensitive,
        };
        const matches = findAllMatches(
          view.state.doc,
          s.query,
          !s.caseSensitive,
          s.regex,
        );
        view.dispatch(
          view.state.tr.setMeta(key, {
            ...next,
            matches,
            currentIndex: matches.length ? 0 : -1,
          }),
        );
      });

      ui.regexBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const s = key.getState(view.state)!;
        ui.regexBtn.classList.toggle("is-active", !s.regex);
        const next: Partial<SearchState> = { regex: !s.regex };
        const matches = findAllMatches(
          view.state.doc,
          s.query,
          s.caseSensitive,
          !s.regex,
        );
        view.dispatch(
          view.state.tr.setMeta(key, {
            ...next,
            matches,
            currentIndex: matches.length ? 0 : -1,
          }),
        );
      });

      // Initial UI sync
      syncUI(view, ui);

      return {
        update(v) {
          syncUI(v, ui);
        },
        destroy() {
          ui.root.remove();
        },
      };
    },
  });
}

// ═══════════════════════════════════════════
//  External API (called by command registrations)
// ═══════════════════════════════════════════

export function openFind(view: EditorView) {
  const s = key.getState(view.state);
  const initial = view.state.doc.textBetween(
    view.state.selection.from,
    view.state.selection.to,
  );
  const meta: Partial<SearchState> = {
    open: true,
    replaceVisible: s?.replaceVisible ?? false,
  };
  if (initial && !initial.includes("\n")) meta.query = initial;
  view.dispatch(view.state.tr.setMeta(key, meta));

  window.requestAnimationFrame(() => {
    const bar = view.dom.parentElement?.querySelector(
      ".butter-search-bar",
    ) as HTMLElement | null;
    const input = bar?.querySelector(
      ".butter-search-input",
    ) as HTMLInputElement | null;
    if (input) {
      if (meta.query) input.value = meta.query;
      input.focus();
      input.select();
      if (meta.query) updateQuery(view, meta.query);
    }
  });
}

export function openReplace(view: EditorView) {
  openFind(view);
  view.dispatch(
    view.state.tr.setMeta(key, { replaceVisible: true }),
  );
}

// ═══════════════════════════════════════════
//  Internal helpers
// ═══════════════════════════════════════════

function updateQuery(view: EditorView, query: string) {
  const s = key.getState(view.state)!;
  const matches = findAllMatches(
    view.state.doc,
    query,
    s.caseSensitive,
    s.regex,
  );
  const tr = view.state.tr.setMeta(key, {
    query,
    matches,
    currentIndex: matches.length ? 0 : -1,
  });
  view.dispatch(tr);
  if (matches.length) scrollToMatch(view, matches[0]);
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
  match: { from: number; to: number },
) {
  const tr = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, match.from, match.to),
  );
  view.dispatch(tr.scrollIntoView());
}

function replaceCurrent(view: EditorView) {
  const s = key.getState(view.state);
  if (!s || !s.matches.length || s.currentIndex < 0) return;
  const match = s.matches[s.currentIndex];
  const tr = view.state.tr.insertText(s.replace, match.from, match.to);
  view.dispatch(tr);
}

function replaceAll(view: EditorView) {
  const s = key.getState(view.state);
  if (!s || !s.matches.length) return;
  const tr = view.state.tr;
  // Replace in reverse so earlier positions stay valid.
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i];
    tr.insertText(s.replace, m.from, m.to);
  }
  view.dispatch(tr);
}

function toggleReplace(view: EditorView) {
  const s = key.getState(view.state)!;
  view.dispatch(
    view.state.tr.setMeta(key, { replaceVisible: !s.replaceVisible }),
  );
}

function closeSearch(view: EditorView) {
  view.dispatch(
    view.state.tr.setMeta(key, { open: false, matches: [], currentIndex: -1 }),
  );
  view.focus();
}

function syncUI(view: EditorView, ui: UIRefs) {
  const s = key.getState(view.state);
  if (!s) return;
  ui.root.style.display = s.open ? "flex" : "none";
  ui.replaceRow.style.display = s.replaceVisible ? "flex" : "none";
  ui.caseBtn.classList.toggle("is-active", s.caseSensitive);
  ui.regexBtn.classList.toggle("is-active", s.regex);
  if (!s.matches.length) {
    ui.countEl.textContent = s.query ? "No matches" : "";
  } else {
    ui.countEl.textContent = `${s.currentIndex + 1} / ${s.matches.length}`;
  }
}
