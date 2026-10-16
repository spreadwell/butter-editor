import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

interface DelimiterMatch {
  readonly type: "strong" | "em" | "s";
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly end: number;
}

/** Source-owned Obsidian emphasis grammar, independently implemented from
 * native rendering observations. Escaped punctuation participates in native
 * closing adjacency; strong pairs, single emphasis and strike pairs therefore
 * cannot use CommonMark's delimiter-run pairing as a second interpretation.
 * This policy owns only those three delimiter families. Other inline syntax
 * continues through its existing rule, in the same bounded inline state.
 */
export function nativeDelimiterPlugin(md: MarkdownIt): void {
  md.inline.ruler.disable(["emphasis", "strikethrough"]);
  md.inline.ruler2.disable(["emphasis", "strikethrough"]);
  // Failed suffix scans are reusable within the same immutable source/range.
  // Long intraword underscore text must not repeatedly scan the whole suffix.
  const failedSuffixes = new WeakMap<StateInline, Map<string, number>>();
  md.inline.ruler.before("strikethrough", "native_delimiters", (state, silent) => {
    const marker = state.src[state.pos];
    if (marker !== "*" && marker !== "_" && marker !== "~") return false;
    let failed = failedSuffixes.get(state);
    if (!failed) {
      failed = new Map();
      failedSuffixes.set(state, failed);
    }
    const match = matchStrong(state.src, state.pos, state.posMax, failed) ??
      matchEmphasis(state.src, state.pos, state.posMax, failed) ??
      matchStrike(state.src, state.pos, state.posMax, failed);
    if (!match) {
      // A native literal marker must not enter CommonMark's later pairing.
      if (!silent) state.pending += marker;
      state.pos += 1;
      return true;
    }
    if (!silent) {
      const tag = match.type === "s" ? "s" : match.type;
      state.push(`${match.type}_open`, tag, 1);
      const outerEnd = state.posMax;
      const outerSource = state.src;
      // The markdown-it declaration omits its stock backtick caches and
      // types the skip cache as any; describe those actual state fields.
      const nativeState = state as unknown as {
        cache: Record<number, number>;
        backticks: Record<number, number>;
        backticksScanned: boolean;
        __butterNativeDelimiterSource?: { source: string; end: number };
      };
      const outerCache = nativeState.cache;
      const outerBackticks = nativeState.backticks;
      const outerBackticksScanned = nativeState.backticksScanned;
      const outerNativeSource = nativeState.__butterNativeDelimiterSource;
      nativeState.__butterNativeDelimiterSource ??= { source: outerSource, end: outerEnd };
      state.pos = match.bodyStart;
      state.posMax = match.bodyEnd;
      // Some stock scanners search src directly instead of obeying posMax.
      // Keep absolute offsets but exclude bytes owned by the outer region.
      // Range-specific failed scans must never poison the outer caches.
      state.src = outerSource.slice(0, match.bodyEnd);
      nativeState.cache = {};
      nativeState.backticks = {};
      nativeState.backticksScanned = false;
      try {
        // Preserve linkLevel, HTML scopes, extension context and maxNesting.
        state.md.inline.tokenize(state);
      } finally {
        state.posMax = outerEnd;
        state.src = outerSource;
        nativeState.cache = outerCache;
        nativeState.backticks = outerBackticks;
        nativeState.backticksScanned = outerBackticksScanned;
        nativeState.__butterNativeDelimiterSource = outerNativeSource;
      }
      state.push(`${match.type}_close`, tag, -1);
    }
    state.pos = match.end;
    return true;
  });
}

function matchStrong(source: string, start: number, end: number, failed: Map<string, number>): DelimiterMatch | null {
  const marker = source[start];
  if ((marker !== "*" && marker !== "_") || start + 1 >= end || source[start + 1] !== marker) return null;
  const bodyStart = start + 2;
  const key = `strong:${marker}:${end}`;
  if (bodyStart >= (failed.get(key) ?? Infinity)) return null;
  for (let at = bodyStart; at < end; at++) {
    if (source[at] === "\\") { at++; continue; }
    if (source[at] === marker && at + 1 < end && source[at + 1] === marker &&
      (at + 2 >= end || source[at + 2] !== marker)) {
      if (!source.slice(bodyStart, at).trim()) return null;
      return { type: "strong", bodyStart, bodyEnd: at, end: at + 2 };
    }
  }
  failed.set(key, Math.min(bodyStart, failed.get(key) ?? Infinity));
  return null;
}

function matchEmphasis(source: string, start: number, end: number, failed: Map<string, number>): DelimiterMatch | null {
  const marker = source[start];
  if (marker !== "*" && marker !== "_") return null;
  const bodyStart = start + 1;
  const key = `em:${marker}:${end}`;
  if (bodyStart >= (failed.get(key) ?? Infinity)) return null;
  let previous = "";
  for (let at = bodyStart; at < end; at++) {
    const character = source[at];
    if (character === "\\") {
      at++;
      previous = at < end ? source[at] : "";
      continue;
    }
    if (character === marker) {
      if (at + 1 < end && source[at + 1] === marker) {
        at++;
        previous = marker;
        continue;
      }
      if (!source.slice(bodyStart, at).trim() || previous === marker) return null;
      const after = at + 1 < end ? source[at + 1] : "";
      // Native underscores cannot close immediately before an ASCII word.
      if (marker === "_" && /\w/.test(after)) { previous = after; continue; }
      return { type: "em", bodyStart, bodyEnd: at, end: at + 1 };
    }
    previous = character;
  }
  failed.set(key, Math.min(bodyStart, failed.get(key) ?? Infinity));
  return null;
}

function matchStrike(source: string, start: number, end: number, failed: Map<string, number>): DelimiterMatch | null {
  if (source[start] !== "~" || start + 1 >= end || source[start + 1] !== "~" ||
    (start + 2 < end && /\s/.test(source[start + 2]))) return null;
  const bodyStart = start + 2;
  const key = `strike:${end}`;
  if (bodyStart >= (failed.get(key) ?? Infinity)) return null;
  for (let at = bodyStart; at + 1 < end; at++) {
    // Native strike matching examines raw tildes, including escaped tildes.
    if (source[at] === "~" && source[at + 1] === "~" &&
      (at === bodyStart || !/\s/.test(source[at - 1]))) {
      return { type: "s", bodyStart, bodyEnd: at, end: at + 2 };
    }
  }
  failed.set(key, Math.min(bodyStart, failed.get(key) ?? Infinity));
  return null;
}
