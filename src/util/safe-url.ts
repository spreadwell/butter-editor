/**
 * URL allowlist for any href / window.open path that may carry
 * user-authored content (link mark, wikilink, external-link panel).
 *
 * Rejected schemes (javascript:, data:, vbscript:, etc.) collapse to
 * "#" so the DOM still has a syntactically valid href but click does
 * nothing harmful. Relative URLs and fragments pass through unchanged
 * since they cannot carry a scheme.
 */
const ALLOWED_SCHEMES = new Set([
  "http:",
  "https:",
  "mailto:",
  "obsidian:",
  "file:",
  "tel:",
]);

export function sanitizeHref(input: unknown): string {
  if (typeof input !== "string") return "#";
  const url = input.trim();
  if (!url) return "#";

  // Fragment-only and absolute paths can't carry a scheme.
  if (url.startsWith("#") || url.startsWith("/") || url.startsWith("?")) {
    return url;
  }

  // Scheme detection: any `[a-z][a-z0-9+.-]*:` prefix is a scheme.
  // ASCII control chars + whitespace embedded in the prefix sneak past
  // naive .indexOf(":"), so we walk + reject anything non-printable
  // before the first colon.
  const colon = url.indexOf(":");
  if (colon === -1) return url; // relative path like `foo/bar.md`

  const prefix = url.slice(0, colon);
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(prefix)) {
    // Colon present but the run before it isn't a valid scheme name.
    // Treat as a relative path (Obsidian wikilink-targets often
    // contain colons in note titles).
    return url;
  }

  const scheme = prefix.toLowerCase() + ":";
  return ALLOWED_SCHEMES.has(scheme) ? url : "#";
}
