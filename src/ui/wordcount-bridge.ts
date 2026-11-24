/**
 * Bridges Butter's in-memory PM doc into Obsidian's built-in
 * Word Count core plugin's status bar item so it updates live as the
 * user types — instead of only refreshing when Butter saves to disk.
 *
 * Strategy:
 *   1. Hand the text to the built-in with `wcInstance.updateCount(text)`.
 *      It counts off the main thread and shows the result its own way
 *      (the user's language, the mobile file info), and its status bar
 *      item stays its own, so it goes on working for every other note.
 *   2. If this Obsidian has no such method, fall back to finding the
 *      word-count status bar item and writing to it directly.
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
  updateCount?: (text: string) => void;
  /** Length of the text the built-in counted last. */
  charCount?: number;
}

type CountingInstance = WordCountInstance & { updateCount: (text: string) => void };

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

function canCount(inst: WordCountInstance | null): inst is CountingInstance {
  return typeof inst?.updateCount === "function";
}

const WORDCOUNT_PATTERN = /\d[\d,]*\s+words?\b|\d[\d,]*\s+characters?\b/i;

let cachedStatusEl: HTMLElement | null = null;
function findWordCountStatusEl(): HTMLElement | null {
  if (cachedStatusEl && cachedStatusEl.isConnected) return cachedStatusEl;
  const statusBarEl = activeDocument.querySelector(".status-bar");
  const own = statusBarEl?.querySelector<HTMLElement>(".status-bar-item.plugin-word-count");
  if (own) {
    cachedStatusEl = own;
    return cachedStatusEl;
  }
  // Walk every status bar item — Butter is itself a status-bar
  // contributor so we can't assume a single status bar; pick the one
  // whose text matches the built-in's `N words M characters` shape.
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

function format(words: number, chars: number): { words: string; chars: string } {
  const fmt = (n: number) => n.toLocaleString();
  return { words: `${fmt(words)} words`, chars: `${fmt(chars)} characters` };
}

function showInStatusBar(el: HTMLElement, label: { words: string; chars: string }) {
  // The built-in keeps a span for each number. Writing into them, not
  // over them, leaves it able to show its own count for other notes.
  const segments = el.querySelectorAll<HTMLElement>(".status-bar-item-segment");
  if (segments.length === 2) {
    if (segments[0].textContent !== label.words) segments[0].setText(label.words);
    if (segments[1].textContent !== label.chars) segments[1].setText(label.chars);
    return;
  }
  const text = `${label.words} ${label.chars}`;
  if (el.textContent !== text) el.setText(text);
}

/** What the status bar was last given, and for which text. */
interface ShownCount {
  doc: unknown;
  start: number;
  end: number;
  /** The built-in's `charCount` once it had been handed the text. */
  handedOver?: number;
  label?: { words: string; chars: string };
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
  // While what was shown still holds, a tick has nothing to do. Reading a
  // long note's text on every tick was a constant drain with the note
  // merely open: 3ms four times a second at 75,000 characters.
  let shown: ShownCount | null = null;
  let handOverFailed = false;

  const tick = () => {
    const pm = getActivePM();
    if (!pm) {
      shown = null;
      return;
    }

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

    const inst = getWordCountInstance(plugin.app);
    const counter = !handOverFailed && canCount(inst) ? inst : null;
    const el = counter ? null : findWordCountStatusEl();
    if (!counter && !el) {
      // Word Count is off, or has no status bar item to write to.
      shown = null;
      return;
    }

    // A caret has no text of its own, so moving it leaves the count alone.
    const selecting = from !== to;
    const start = selecting ? from : 0;
    const end = selecting ? to : doc.content.size;
    const current = shown && shown.doc === doc && shown.start === start && shown.end === end
      ? shown
      : null;

    if (counter) {
      // The built-in counts the file on disk whenever one is opened, which
      // replaces what it was handed. Its `charCount` tells the two apart.
      if (current && counter.charCount === current.handedOver) return;
      const text = doc.textBetween(start, end, "\n", "\n");
      try {
        counter.updateCount(text);
        shown = { doc, start, end, handedOver: counter.charCount };
        lastPushedAt = now;
      } catch {
        // The next tick writes to the status bar item instead.
        handOverFailed = true;
        shown = null;
      }
      return;
    }

    // DOM fallback: write directly to the built-in's status bar item.
    // Brief flicker possible if the built-in races us with a save-
    // driven update, but typing is the dominant flow.
    if (!el) return;
    let label = current?.label;
    if (!label) {
      const { words, chars } = countText(doc.textBetween(start, end, "\n", "\n"));
      label = format(words, chars);
      shown = { doc, start, end, label };
    }
    showInStatusBar(el, label);
    lastPushedAt = now;
  };

  plugin.registerInterval(window.setInterval(tick, 250));
  tick();
}
