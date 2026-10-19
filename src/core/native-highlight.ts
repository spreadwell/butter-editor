/** Obsidian 1.14 highlight prefixes. Squares are native aliases for circles. */
const colors = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
const circles = ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣"];
const squares = ["🟥", "🟧", "🟨", "🟩", "🟦", "🟪"];

export function nativeHighlightColor(name: unknown): string | null {
  return typeof name === "string" && colors.some(color => color === name)
    ? `var(--highlight-background-${name}, rgba(var(--color-${name}-rgb), 0.4))` : null;
}

export function nativeHighlightName(color: unknown): string | null {
  return colors.find(name => color === nativeHighlightColor(name)) ?? null;
}

export function nativeHighlightEmoji(color: unknown): string | null {
  const name = nativeHighlightName(color);
  return name ? circles[colors.findIndex(color => color === name)] : null;
}

export function nativeHighlightPrefix(source: string, offset: number): { name: string; length: number } | null {
  const codePoint = source.codePointAt(offset);
  if (codePoint === undefined) return null;
  const character = String.fromCodePoint(codePoint);
  const index = Math.max(circles.indexOf(character), squares.indexOf(character));
  return index < 0 ? null : { name: colors[index], length: character.length };
}
