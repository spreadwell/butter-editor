import { sanitizeHref } from "../util/safe-url";

const EXPLICIT_WEB_SCHEME = /^(?:https?|mailto|tel|obsidian|file):/i;
const DOMAIN_DESTINATION = /^(?:[^\s./:?#]+\.)+[^\s./:?#]{2,}(?::\d{1,5})?(?:[/?#].*)?$/u;
const IPV4_DESTINATION = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#].*)?$/;
const LOCALHOST_DESTINATION = /^localhost(?::\d{1,5})?(?:[/?#].*)?$/i;

/** True when an uncommitted destination is unmistakably intended as a web-style link. */
export function looksLikeWebDestination(raw: string): boolean {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return false;
  if (EXPLICIT_WEB_SCHEME.test(value)) return true;
  if (DOMAIN_DESTINATION.test(value)
    || IPV4_DESTINATION.test(value)
    || LOCALHOST_DESTINATION.test(value)) return true;
  return false;
}

/** Normalize common scheme-less web destinations and reject unsafe schemes. */
export function normalizeWebDestination(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (looksLikeWebDestination(value) && !EXPLICIT_WEB_SCHEME.test(value)) {
    value = `https://${value}`;
  }
  const safe = sanitizeHref(value);
  return safe === "#" && value !== "#" ? null : safe;
}
