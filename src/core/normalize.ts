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
 *     at 1 blank line. Respects fenced code blocks (their internal
 *     whitespace is content, not inter-block whitespace).
 *   - `normalizeHeadingGap`: ensure at least 1 blank line separates
 *     an ATX heading from a following non-blank block. Respects
 *     fenced code blocks. Setext headings (underline style) are not
 *     handled - they're rare in Obsidian and require multi-line
 *     pattern recognition.
 *
 * Both normalizers are idempotent: applying a normalized output back
 * through the same normalizer produces the same bytes. Tests verify
 * this so we can trust them on every save without drift.
 */

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
 * Cap consecutive blank lines at 1 outside fenced code blocks.
 *
 * A "blank line" here means an empty line between content lines or
 * between content and EOF. Inside ``` or ~~~ fenced code blocks, all
 * whitespace is part of the code - skipped.
 *
 * Algorithm:
 *   - walk line by line; maintain a fence state flag.
 *   - outside fences, whenever we encounter a run of N empty lines,
 *     emit at most 1 (or 2 if the run reaches EOF, so a trailing
 *     blank line + final \n both survive).
 *   - inside fences, emit every line unchanged.
 *
 * The "EOF trailing special case" keeps files that end with "foo\n\n"
 * (content + 1 blank + final newline) stable after normalization,
 * rather than stripping the blank entirely.
 */
export function condenseBlankLines(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);

    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[2];
      } else if (line.replace(/^\s+/, "").startsWith(fenceMarker)) {
        inFence = false;
      }
      out.push(line);
      i++;
      continue;
    }

    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    if (line === "") {
      // Count the run of consecutive blanks starting at i.
      let j = i;
      while (j < lines.length && lines[j] === "") j++;
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
 * Respects fenced code blocks - `#` lines inside a fence are code,
 * not headings.
 *
 * Idempotent: if a heading is already followed by a blank line, no
 * change. Inserting a blank line after a heading doesn't create a
 * condition for further insertion on re-application.
 */
export function normalizeHeadingGap(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);

    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[2];
      } else if (line.replace(/^\s+/, "").startsWith(fenceMarker)) {
        inFence = false;
      }
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    out.push(line);

    // ATX heading check: `#` through `######`, followed by a space
    // OR end-of-line (empty heading like `####` is valid CommonMark).
    if (!/^#{1,6}(\s|$)/.test(line)) continue;

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
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const m = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    if (!inFence) {
      inFence = true;
      fenceMarker = m[2];
    } else if (line.replace(/^\s+/, "").startsWith(fenceMarker)) {
      inFence = false;
    }
  }

  if (!inFence) return source;

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
