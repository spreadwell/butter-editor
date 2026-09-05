export type AutocompleteMode = "wikilink" | "embed" | "tag";

const TAG_QUERY_RE = /^[A-Za-z0-9_/-]*$/;

export function isTagAutocompleteQuery(text: string): boolean {
  return TAG_QUERY_RE.test(text);
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
