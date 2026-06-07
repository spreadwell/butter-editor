/**
 * Syntax highlighting for non-delegated fenced code blocks.
 *
 * Obsidian ships Prism (for code in Reading mode) and exposes it on
 * `window.Prism`. We use it to tokenize the text content of any
 * `code_block` whose language isn't already being delegated to
 * MarkdownRenderer, and emit PM inline decorations with Prism's
 * standard `token <type>` CSS classes so Obsidian themes style them
 * exactly as they do in Reading mode.
 *
 * All work is purely presentational - the underlying doc text is
 * untouched, so the code remains editable and round-trips cleanly.
 */
import { App, Component, MarkdownRenderer } from "obsidian";
import {
  Plugin as PMPlugin,
  PluginKey,
  type EditorState,
} from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

// Which blocks to skip? None explicitly. `codeBlockView` (see
// src/nodeviews.ts) now delegates every non-editable language to
// Obsidian's MarkdownRenderer at render time - a language-agnostic
// model. For decoration purposes we only need one gate: does Prism
// have a grammar for this language? If yes, decorate; if no, nothing
// to tokenize anyway. That gate lives inside `tokenize()` below
// (`if (!grammar) return []`), so no allowlist / denylist here.

const key = new PluginKey<DecorationSet>("butter-code-highlight");

interface PrismToken {
  type: string;
  content: string | PrismToken | Array<string | PrismToken>;
  alias?: string | string[];
  length: number;
}

interface PrismLike {
  languages: Record<string, unknown>;
  tokenize(text: string, grammar: unknown): Array<string | PrismToken>;
}

function getPrism(): PrismLike | null {
  const p = (window as unknown as { Prism?: unknown }).Prism;
  if (!p || typeof p !== "object") return null;
  const candidate = p as Partial<PrismLike>;
  if (!candidate.languages || typeof candidate.tokenize !== "function") return null;
  return candidate as PrismLike;
}

/** Run Prism and collect decoration specs for the given code text. */
function tokenize(
  text: string,
  lang: string,
  baseOffset: number,
): Decoration[] {
  const prism = getPrism();
  if (!prism) return [];
  const grammar = prism.languages[lang];
  if (!grammar) return [];

  const decos: Decoration[] = [];
  let pos = baseOffset;

  const walk = (
    items: Array<string | PrismToken>,
    parentClasses: string[] = [],
  ) => {
    for (const item of items) {
      if (typeof item === "string") {
        pos += item.length;
        continue;
      }
      const classes = [...parentClasses, `token`, item.type];
      if (item.alias) {
        const alias = Array.isArray(item.alias) ? item.alias : [item.alias];
        classes.push(...alias);
      }
      const start = pos;
      if (typeof item.content === "string") {
        pos += item.content.length;
      } else if (Array.isArray(item.content)) {
        walk(item.content, classes);
      } else {
        walk([item.content], classes);
      }
      const end = pos;
      if (end > start) {
        decos.push(
          Decoration.inline(start, end, { class: classes.join(" ") }),
        );
      }
    }
  };

  try {
    const tokens = prism.tokenize(text, grammar);
    walk(tokens);
  } catch {
    return [];
  }

  return decos;
}

function buildAll(state: EditorState): DecorationSet {
  const prism = getPrism();
  if (!prism) return DecorationSet.empty;
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return true;
    const lang = (node.attrs as { language?: string }).language ?? "";
    if (!lang) return false;
    // The code's text starts at pos + 1 (inside the code_block node).
    // For languages Prism doesn't recognize (including plugin-handled
    // langs like mermaid / chart / tasks), tokenize() returns an empty
    // array - no decorations, no cost beyond the grammar lookup.
    decos.push(...tokenize(node.textContent, lang, pos + 1));
    return false;
  });
  return DecorationSet.create(state.doc, decos);
}

/**
 * Is there a `code_block` node anywhere in the given range of the
 * given state's doc? Used to decide whether a transaction's
 * changes could have affected any highlighting - if not, we can
 * skip the expensive per-doc Prism rebuild and just map the
 * existing decorations forward through the transaction.
 */
function rangeTouchesCodeBlock(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  let found = false;
  state.doc.nodesBetween(
    Math.max(0, from),
    Math.min(state.doc.content.size, to),
    (node) => {
      if (found) return false;
      if (node.type.name === "code_block") {
        found = true;
        return false;
      }
      return true;
    },
  );
  return found;
}

/**
 * Get the unique non-empty languages used in code blocks of `doc`.
 */
function collectLangs(doc: EditorState["doc"]): string[] {
  const langs = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "code_block") {
      const lang = (node.attrs as { language?: string }).language;
      if (lang) langs.add(lang);
      return false;
    }
    return true;
  });
  return [...langs];
}

/**
 * Trigger Obsidian to load Prism grammars for the given languages.
 * Obsidian lazy-loads grammars on first render, so we render a small
 * code block of each language to a hidden DOM. The `MarkdownRenderer
 * .render` Promise resolves after the grammar is loaded and Prism
 * has tokenized - at which point `Prism.languages[lang]` is populated
 * and our `tokenize()` will succeed.
 */
async function loadGrammars(app: App, langs: string[]): Promise<void> {
  if (!langs.length) return;
  const hidden = activeDocument.createElement("div");
  hidden.addClass("butter-prism-loader");
  activeDocument.body.appendChild(hidden);
  const comp = new Component();
  comp.load();
  try {
    for (const lang of langs) {
      const prism = getPrism();
      if (prism?.languages[lang]) continue;
      try {
        await MarkdownRenderer.render(
          app,
          "```" + lang + "\nx\n```",
          hidden,
          "",
          comp,
        );
      } catch {
        /* unrecognized lang - Prism will give up too, that's fine */
      }
    }
  } finally {
    comp.unload();
    hidden.remove();
  }
}

export function codeHighlightPlugin(app?: App): PMPlugin<DecorationSet> {
  return new PMPlugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => buildAll(state),
      apply(tr, old, oldState, newState) {
        // Refresh meta - fired by the view callback after async
        // grammar loading completes, so we rebuild even if the doc
        // didn't change.
        if (tr.getMeta(key) === "refresh") return buildAll(newState);

        if (!tr.docChanged) return old;

        // Check whether any step of this transaction touched a
        // code_block - either in the OLD doc (edits inside an
        // existing code block) or in the NEW doc (new code blocks
        // appearing). If none did, we skip the full Prism rebuild
        // and just map existing decorations forward. On a multi-
        // thousand-line doc with many code blocks this turns an
        // O(doc × Prism) per-keystroke cost into O(1) for edits
        // in non-code regions - which is virtually all typing.
        let touched = false;
        const mapping = tr.mapping;
        for (let i = 0; i < mapping.maps.length && !touched; i++) {
          const stepMap = mapping.maps[i];
          stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
            if (touched) return;
            if (rangeTouchesCodeBlock(oldState, oldStart, oldEnd)) {
              touched = true;
              return;
            }
            if (rangeTouchesCodeBlock(newState, newStart, newEnd)) {
              touched = true;
            }
          });
        }

        if (!touched) {
          return old.map(tr.mapping, tr.doc);
        }
        return buildAll(newState);
      },
    },
    view(view) {
      // Track which languages we've already kicked off a grammar-load
      // for so re-scans (on doc changes) only fire async loads for
      // newly-introduced languages.
      const seenLangs = new Set<string>();
      let cancelled = false;

      const scan = async () => {
        if (!app || cancelled) return;
        const all = collectLangs(view.state.doc);
        const fresh = all.filter((lang) => !seenLangs.has(lang));
        if (!fresh.length) return;
        for (const lang of fresh) seenLangs.add(lang);
        await loadGrammars(app, fresh);
        if (cancelled) return;
        // Trigger a re-decorate with the now-loaded grammars.
        view.dispatch(view.state.tr.setMeta(key, "refresh"));
      };

      void scan();

      return {
        update() { void scan(); },
        destroy() { cancelled = true; },
      };
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
