/**
 * Bridges Butter's in-memory PM doc into Obsidian's built-in
 * Word Count core plugin's status bar item so it updates live as the
 * user types — instead of only refreshing when Butter saves to disk.
 *
 * Strategy:
 *   1. Try `wcInstance.updateLineCount(text)` first — if Obsidian
 *      exposes a callable update method on the plugin instance,
 *      that's the cleanest path (no DOM hunting).
 *   2. Fall back to finding the word-count status bar element by its
 *      content pattern (`123 words 456 characters`) and writing
 *      directly to it.
 *
 * Either way, polling honors selection: if the user has a range
 * selected, the count switches to the selection — same behavior as
 * the built-in has in native Markdown views.
 *
 * Fail-safe: if the built-in is disabled or its status bar item
 * can't be located, the bridge silently no-ops and falls back to
 * whatever the built-in does on its own (typically save-driven).
 */
import type { App, Plugin } from "obsidian";
import type { EditorView } from "prosemirror-view";

interface WordCountInstance {
  updateLineCount?: (text?: string) => void;
}

interface InternalPluginEntry {
  enabled?: boolean;
  instance?: WordCountInstance;
}

function getWordCountInstance(app: App): WordCountInstance | null {
  const internal = (app as unknown as {
    internalPlugins?: { plugins?: Record<string, InternalPluginEntry> };
  }).internalPlugins;
  const entry = internal?.plugins?.["word-count"];
  if (!entry?.enabled) return null;
  return entry.instance ?? null;
}

const WORDCOUNT_PATTERN = /\d[\d,]*\s+words?\b|\d[\d,]*\s+characters?\b/i;

let cachedStatusEl: HTMLElement | null = null;
function findWordCountStatusEl(): HTMLElement | null {
  if (cachedStatusEl && cachedStatusEl.isConnected) return cachedStatusEl;
  // Walk every status bar item — Butter is itself a status-bar
  // contributor so we can't assume a single status bar; pick the one
  // whose text matches the built-in's `N words M characters` shape.
  const statusBarEl = activeDocument.querySelector(".status-bar");
  const items = (statusBarEl ?? activeDocument).querySelectorAll<HTMLElement>(
    ".status-bar-item",
  );
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (WORDCOUNT_PATTERN.test(item.textContent ?? "")) {
      cachedStatusEl = item;
      return cachedStatusEl;
    }
  }
  return null;
}

function countText(text: string): { words: number; chars: number } {
  const chars = text.length;
  const words = (text.match(/\S+/g) ?? []).length;
  return { words, chars };
}

function format(words: number, chars: number): string {
  const fmt = (n: number) => n.toLocaleString();
  return `${fmt(words)} words ${fmt(chars)} characters`;
}

export function installWordCountBridge(
  plugin: Plugin,
  getActivePM: () => EditorView | null,
) {
  let lastDoc: unknown = null;
  let lastFrom = -1;
  let lastTo = -1;
  let stableSince = 0;
  let lastPushedAt = 0;

  const tick = () => {
    const pm = getActivePM();
    if (!pm) return;

    const doc = pm.state.doc;
    const { from, to } = pm.state.selection;
    const now = Date.now();

    // Same debounce strategy the old in-house counter used: defer the
    // heavy textBetween walk until the user has been idle briefly, but
    // force an update every few seconds during continuous typing so
    // the counter doesn't sit completely frozen on long sessions.
    const IDLE_MS = 200;
    const MAX_STALE_MS = 2000;
    if (doc !== lastDoc || from !== lastFrom || to !== lastTo) {
      lastDoc = doc;
      lastFrom = from;
      lastTo = to;
      stableSince = now;
      if (now - lastPushedAt < MAX_STALE_MS) return;
    } else if (now - stableSince < IDLE_MS) {
      return;
    }

    const selecting = from !== to;
    const text = selecting
      ? doc.textBetween(from, to, "\n", "\n")
      : doc.textBetween(0, doc.content.size, "\n", "\n");
    const { words, chars } = countText(text);

    // Try the plugin instance method first — if Obsidian exposes one,
    // it's the cleanest path (the plugin will reformat as it likes).
    const inst = getWordCountInstance(plugin.app);
    if (inst && typeof inst.updateLineCount === "function") {
      try {
        inst.updateLineCount(text);
        lastPushedAt = now;
        return;
      } catch {
        // Fall through to DOM update.
      }
    }

    // DOM fallback: write directly to the built-in's status bar item.
    // Brief flicker possible if the built-in races us with a save-
    // driven update, but typing is the dominant flow.
    const el = findWordCountStatusEl();
    if (!el) return;
    el.setText(format(words, chars));
    lastPushedAt = now;
  };

  plugin.registerInterval(window.setInterval(tick, 250));
  tick();
}
