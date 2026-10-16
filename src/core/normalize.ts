/**
 * Opt-in source normalization.
 *
 * Butter's default stance is "source is truth": whatever the user
 * wrote gets preserved byte-for-byte on save. But some users prefer
 * clean source that matches community convention (Prettier, GitHub
 * style, etc.). This module provides pure-function normalizers that
 * can be applied to a markdown string on save OR via an explicit
 * "normalize now" command, depending on the user's setting.
 *
 * Currently supported:
 *   - `condenseBlankLines`: cap runs of 2+ blank lines between blocks
 *     at 1 blank line. The live parser identifies content ranges so opaque
 *     payload whitespace is never mistaken for an inter-block gap.
 *   - `normalizeHeadingGap`: ensure at least 1 blank line separates
 *     an ATX heading from a following non-blank block. Respects
 *     parser-identified headings. Setext headings (underline style) are not
 *     handled - they're rare in Obsidian and require multi-line
 *     pattern recognition.
 *
 * Both normalizers are idempotent: applying a normalized output back
 * through the same normalizer produces the same bytes. Tests verify
 * this so we can trust them on every save without drift.
 */

import type Token from "markdown-it/lib/token.mjs";
import { __mdit } from "./bridge/common";

// Containers carry maps spanning both content and layout gaps. Every other
// mapped token owns content, including opaque syntax supplied by extensions.
const GAP_CONTAINERS = new Set([
  "blockquote_open", "obsidian_callout_open", "bullet_list_open",
  "ordered_list_open", "list_item_open",
]);

function sourceTokens(source: string): Token[] | null {
  try {
    return __mdit.parse(source, {});
  } catch {
    // Formatting is optional; if the live parser cannot classify the source,
    // retain its bytes rather than guess where content ends.
    return null;
  }
}

function contentLineMask(tokens: Token[], lineCount: number): boolean[] {
  const covered = new Array<boolean>(lineCount).fill(false);
  for (const token of tokens) {
    if (!token.map || GAP_CONTAINERS.has(token.type)) continue;
    for (let line = token.map[0]; line < token.map[1] && line < lineCount; line++) {
      covered[line] = true;
    }
  }
  return covered;
}

export interface NormalizeOptions {
  /** Force at least 1 blank line after every ATX heading. */
  headingGap?: boolean;
  /** Collapse runs of 2+ blank lines to exactly 1. */
  condenseBlanks?: boolean;
  /** Append a closing ``` (or ~~~) when the file ends mid-fence. */
  closeUnclosedFences?: boolean;
}

/**
 * Apply the enabled normalizers to a markdown source string.
 *
 * Order: condense first, heading-gap next, close-unclosed-fences last.
 * Condense + heading-gap can interact (heading-gap may re-expand a run
 * that condense just shrunk - each op is idempotent but they compose
 * in a specific order to avoid one undoing the other). Close-unclosed-
 * fences touches only the trailing bytes after the last close-fence
 * (appends a marker), so it's independent of the earlier two.
 */
export function normalize(source: string, opts: NormalizeOptions): string {
  let out = source;
  if (opts.condenseBlanks) out = condenseBlankLines(out);
  if (opts.headingGap) out = normalizeHeadingGap(out);
  if (opts.closeUnclosedFences) out = closeUnclosedFences(out);
  return out;
}

/**
 * Cap consecutive blank lines at 1 in parser-approved layout gaps.
 *
 * A "blank line" here means an empty line between content lines or
 * between content and EOF. Mapped content includes code, math, comments,
 * definitions and extension payloads, irrespective of their spelling.
 *
 * Algorithm:
 *   - use the live parser's content ranges, then walk the unowned gaps.
 *   - in a gap, whenever we encounter a run of N empty lines,
 *     emit at most 1 (or 2 if the run reaches EOF, so a trailing
 *     blank line + final \n both survive).
 *   - inside content, emit every line unchanged.
 *
 * The "EOF trailing special case" keeps files that end with "foo\n\n"
 * (content + 1 blank + final newline) stable after normalization,
 * rather than stripping the blank entirely.
 */
export function condenseBlankLines(source: string): string {
  const lines = source.split("\n");
  const tokens = sourceTokens(source);
  if (!tokens) return source;
  const content = contentLineMask(tokens, lines.length);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (content[i]) {
      out.push(line);
      i++;
      continue;
    }

    if (line === "") {
      // Count the run of consecutive blanks starting at i.
      let j = i;
      while (j < lines.length && !content[j] && lines[j] === "") j++;
      const blankCount = j - i;
      const isTrailing = j === lines.length;
      // Split-of-"foo\n\n\n\n" yields ["foo","","","",""] - the last
      // element is the "trailing newline marker" (end-of-split
      // artifact), not a blank line. For trailing runs we keep up to
      // 2 empties (1 real blank line + 1 trailing marker); for
      // middle-of-file runs we keep 1.
      const keep = isTrailing ? Math.min(blankCount, 2) : 1;
      for (let k = 0; k < keep; k++) out.push("");
      i = j;
    } else {
      out.push(line);
      i++;
    }
  }

  return out.join("\n");
}

/**
 * Ensure every ATX heading is followed by a blank line before the
 * next non-blank content line. Matches community convention
 * (GitHub, Prettier, most style guides).
 *
 * Only ATX-style headings (`#` through `######`) are handled. Setext
 * headings (`Title\n====`) are untouched.
 *
 * Only actual parser heading tokens are eligible. Heading-like payload in
 * math, comments, code or extension blocks is retained exactly.
 *
 * Idempotent: if a heading is already followed by a blank line, no
 * change. Inserting a blank line after a heading doesn't create a
 * condition for further insertion on re-application.
 */
export function normalizeHeadingGap(source: string): string {
  const lines = source.split("\n");
  const tokens = sourceTokens(source);
  if (!tokens) return source;
  const headings = new Set<number>();
  for (const token of tokens) {
    if (token.type === "heading_open" && token.map && /^#{1,6}$/.test(token.markup)) {
      // Existing policy applies to top-level ATX source lines only. Nested
      // containers own their prefix and spacing; never insert a bare gap.
      const line = token.map[1] - 1;
      if (/^#{1,6}(\s|$)/.test(lines[line] ?? "")) headings.add(line);
    }
  }
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);

    // ATX heading check: `#` through `######`, followed by a space
    // OR end-of-line (empty heading like `####` is valid CommonMark).
    if (!headings.has(i)) continue;

    // Look at the next line. If it exists AND has non-empty content,
    // insert a blank line.
    //
    // nextLine === undefined: we're at the last element of split
    //   either source had no trailing \n (heading is literally last
    //   content) or we're at the post-trailing-\n empty marker.
    //   Either way, no insertion: no content follows the heading.
    const nextLine = lines[i + 1];
    if (nextLine === undefined) continue;
    if (nextLine === "") continue; // already has blank line after
    out.push("");
  }

  return out.join("\n");
}

/**
 * Append a closing fence marker when the file ends mid-fence.
 *
 * Why this matters: CommonMark treats an unclosed ``` (or ~~~) fence
 * as extending to end-of-input - everything after it is fence body.
 * Butter parses it that way, producing a bounded code_block PM node.
 * The user sees a contained block, can click below it and type new
 * content. But when the file is saved byte-for-byte via source
 * preservation, the unclosed fence persists and the new content gets
 * swallowed into the fence body on reload.
 *
 * This normalizer detects the unclosed-at-EOF case and appends the
 * matching close marker (same length and type as the opener) on its
 * own line before any trailing newlines. Trailing-newline count is
 * preserved. Idempotent: already-closed files walk through with
 * `inFence === false` at EOF and are returned untouched.
 *
 * Scope: only top-level unclosed fences. Fences nested inside block-
 * quotes or list items with their own line prefixes (`> \`\`\``) are
 * not handled - rare case, would need block-container tracking.
 */
export function closeUnclosedFences(source: string): string {
  const lines = source.split("\n");
  const tokens = sourceTokens(source);
  if (!tokens) return source;
  const lineCount = source.endsWith("\n") ? lines.length - 1 : lines.length;
  const fence = tokens.find((token) => token.type === "fence" && token.level === 0 &&
    token.map?.[1] === lineCount);
  if (!fence?.map) return source;
  const fenceMarker = fence.markup;
  const finalLine = lines[fence.map[1] - 1] ?? "";
  const closingPattern = new RegExp(`^ {0,3}${fenceMarker[0]}{${fenceMarker.length},}[\\t ]*$`);
  if (fence.map[1] - fence.map[0] > 1 && closingPattern.test(finalLine)) return source;

  // Append a close marker at end-of-file. Strip only ONE trailing
  // newline (the file's final newline, if any) so any preceding
  // blank lines stay as fence body - CommonMark treats them that
  // way in the unclosed original, so closing without preserving
  // them would re-interpret the same bytes. Insert the close
  // marker on its own line; restore the stripped trailing newline
  // so the file's end-of-line state is unchanged.
  const endsWithNewline = source.endsWith("\n");
  const trimmed = endsWithNewline ? source.slice(0, -1) : source;
  return trimmed + "\n" + fenceMarker + (endsWithNewline ? "\n" : "");
}
