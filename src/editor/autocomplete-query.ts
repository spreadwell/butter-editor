import { isObsidianTagName, isObsidianTagText } from "../core/tag-characters";

export type AutocompleteMode = "wikilink" | "embed" | "tag";

export function isTagAutocompleteQuery(text: string): boolean {
  return isObsidianTagText(text);
}

/** Partial numeric queries are useful; only representable names become atoms. */
export function tagAutocompleteSuggestions(
  query: string,
  available: Iterable<string>,
): Array<{ text: string; create?: boolean }> {
  const tags = new Set(Array.from(available).filter(isObsidianTagName));
  const lower = query.toLowerCase();
  const suggestions: Array<{ text: string; create?: boolean }> = Array.from(tags)
    .filter(tag => !query || tag.toLowerCase().includes(lower))
    .sort()
    .slice(0, 20)
    .map(text => ({ text }));
  if (isObsidianTagName(query) && !Array.from(tags).some(tag => tag.toLowerCase() === lower)) {
    suggestions.unshift({ text: query, create: true });
  }
  return suggestions;
}

export function getAutocompleteQuery(
  mode: AutocompleteMode,
  text: string,
): string | null {
  if (mode === "wikilink" || mode === "embed") {
    const opener = mode === "embed" ? "![[" : "[[";
    if (!text.startsWith(opener)) return null;
    const body = text.slice(opener.length);
    const closeIndex = body.indexOf("]]");
    if (closeIndex >= 0) {
      const trailing = body.slice(closeIndex + 2);
      return trailing.length > 0 ? null : body.slice(0, closeIndex);
    }
    return body;
  }

  if (!text.startsWith("#")) return null;
  const query = text.slice(1);
  if (!isTagAutocompleteQuery(query)) return null;
  return query;
}
