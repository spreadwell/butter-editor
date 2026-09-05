export type PropertyTextSegment =
  | { kind: "text"; text: string }
  | { kind: "wikilink"; target: string; label: string };

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

/**
 * Parse only Obsidian wikilinks, leaving every other character literal.
 * Returns null when no valid link is present so ordinary property values can
 * continue through Obsidian's native text widget unchanged.
 */
export function parsePropertyTextWikilinks(
  value: string,
): PropertyTextSegment[] | null {
  const segments: PropertyTextSegment[] = [];
  let textStart = 0;
  let cursor = 0;
  let found = false;

  while (cursor < value.length - 1) {
    const open = value.indexOf("[[", cursor);
    if (open < 0) break;
    if (isEscaped(value, open) || value[open - 1] === "!") {
      cursor = open + 2;
      continue;
    }
    const close = value.indexOf("]]", open + 2);
    if (close < 0) break;
    const inner = value.slice(open + 2, close);
    const pipe = inner.indexOf("|");
    const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
    const alias = pipe < 0 ? "" : inner.slice(pipe + 1).trim();
    if (!target || target.includes("[") || target.includes("]") ||
        target.includes("\r") || target.includes("\n")) {
      cursor = open + 2;
      continue;
    }

    if (open > textStart) {
      segments.push({ kind: "text", text: value.slice(textStart, open) });
    }
    segments.push({
      kind: "wikilink",
      target,
      label: alias || target,
    });
    found = true;
    cursor = close + 2;
    textStart = cursor;
  }

  if (!found) return null;
  if (textStart < value.length) {
    segments.push({ kind: "text", text: value.slice(textStart) });
  }
  return segments;
}
