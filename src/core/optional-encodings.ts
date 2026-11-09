/**
 * Minimal escaping for file saves.
 *
 * The text codec escapes Markdown punctuation without knowing whether a
 * character could form syntax where it sits, so a typed `50%` used to save as
 * `50\%`. A save asks the serializer to tag each such escape, and each encoded
 * boundary space, as optional. The save then keeps only the tags whose removal
 * changes the reparsed document, judged by the same exact semantic check that
 * gates every save. Callers outside a save keep the conservative form.
 */

/** Precedes a backslash that the save may drop. */
export const OPTIONAL_ESCAPE = "";
/** Precedes an `&#32;` or `&#9;` that the save may write as the raw character. */
export const OPTIONAL_ENTITY = "";

const SITE = /\\|(&#32;|&#9;)/g;
const MARKER = /[]/;

let marking = false;

export function optionalEncodingMarksEnabled(): boolean {
  return marking;
}

export function withOptionalEncodingMarks<T>(serialize: () => T): T {
  const previous = marking;
  marking = true;
  try {
    return serialize();
  } finally {
    marking = previous;
  }
}

export function hasOptionalEncodings(text: string): boolean {
  return MARKER.test(text);
}

/** Extra full reparses one save may spend, scaled so large notes stay fast. */
export function optionalEncodingAttemptBudget(body: string): number {
  return Math.max(2, Math.min(16, Math.floor(240_000 / Math.max(1, body.length))));
}

/**
 * An escape in an opening position that almost always guards syntax: a doubled
 * delimiter (`**`, `==`, `%%`, `~~`, `[[`), a footnote opener, an HTML-like or
 * autolink `<`, a tag-like `#`, or inline math. Keeping these without testing
 * saves full reparses; a wrong guess only keeps one harmless escape.
 */
function guardsSyntax(marked: string, escapedAt: number): boolean {
  const char = marked[escapedAt];
  let next = escapedAt + 1;
  if (marked[next] === OPTIONAL_ESCAPE && marked[next + 1] === "\\") next += 2;
  const following = marked[next] ?? "";
  // The site is OPTIONAL_ESCAPE, backslash, then the escaped character.
  const preceding = marked[escapedAt - 3] ?? "";
  const opens = preceding === "" || !/[\p{L}\p{N}]/u.test(preceding);
  if (!opens || preceding === char) return false;
  switch (char) {
    case "*": case "_": case "=": case "%": case "~": return following === char;
    case "[": return following === "[" || following === "^";
    case "<": return /[A-Za-z/!?]/.test(following);
    case "#": return /\s/.test(preceding || " ") && /\p{L}/u.test(following);
    case "$": return following !== "" && !/[\s\d$]/.test(following);
    default: return false;
  }
}

/**
 * Returns the accepted candidate with the fewest encodings the search
 * reached, or null when no candidate was accepted (including when the note's
 * own text contains a marker character, which makes the tags ambiguous).
 *
 * Dropping every optional encoding usually passes on the first attempt. When
 * it does not, adaptive bisection finds the encodings that must stay; every
 * returned candidate was itself accepted, so the search never needs the
 * encodings to be independent.
 */
export function reduceOptionalEncodings<T>(
  marked: string,
  accept: (candidate: string) => T | null,
  maxAttempts: number,
): { candidate: string; result: T } | null {
  const sites: { start: number; end: number; encoded: string; plain: string }[] = [];
  SITE.lastIndex = 0;
  for (let match = SITE.exec(marked); match; match = SITE.exec(marked)) {
    const start = match.index;
    const entity = match[1];
    sites.push(entity === undefined
      ? { start, end: start + 2, encoded: "\\", plain: "" }
      : { start, end: start + 1 + entity.length, encoded: entity, plain: entity === "&#9;" ? "\t" : " " });
  }
  let rest = "";
  let at = 0;
  for (const site of sites) {
    rest += marked.slice(at, site.start);
    at = site.end;
  }
  if (hasOptionalEncodings(rest + marked.slice(at))) return null;

  const render = (dropped: ReadonlySet<number>): string => {
    let out = "";
    let from = 0;
    sites.forEach((site, index) => {
      out += marked.slice(from, site.start) + (dropped.has(index) ? site.plain : site.encoded);
      from = site.end;
    });
    return out + marked.slice(from);
  };

  const dropped = new Set<number>();
  let best: { candidate: string; result: T } | null = null;
  let attempts = 0;
  const tryDrop = (group: readonly number[]): boolean => {
    if (attempts >= maxAttempts) return false;
    attempts++;
    const next = new Set(dropped);
    for (const index of group) next.add(index);
    const candidate = render(next);
    const result = accept(candidate);
    if (result === null) return false;
    for (const index of group) dropped.add(index);
    best = { candidate, result };
    return true;
  };
  // Precondition: dropping `group` on top of `dropped` was rejected. Later
  // sites are dropped first, so a kept escape sits on the opening delimiter
  // (`\*not italic*`), the way people escape by hand.
  const search = (group: readonly number[]): void => {
    if (group.length < 2 || attempts >= maxAttempts) return;
    const middle = group.length >> 1;
    const left = group.slice(0, middle);
    const right = group.slice(middle);
    // After right passes, dropping left on top is exactly the rejected set.
    if (tryDrop(right)) {
      search(left);
      return;
    }
    search(right);
    if (!tryDrop(left)) search(left);
  };
  const all: number[] = [];
  sites.forEach((site, index) => {
    if (site.plain !== "" || !guardsSyntax(marked, site.end)) all.push(index);
  });
  if (!tryDrop(all)) search(all);
  return best;
}
