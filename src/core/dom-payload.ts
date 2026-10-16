import { canEncodeButterFileUtf8 } from "./file-shell";

/** Private clipboard JSON avoids HTML's raw CR/CRLF attribute/text
 * normalization. The legacy field remains available to ordinary import. */
export function encodeDOMPayload(value: string): string {
  return JSON.stringify(value);
}

export function readDOMPayload(
  dom: Pick<HTMLElement, "getAttribute">,
  attribute: string,
  fallback = dom.getAttribute(attribute) ?? "",
): string {
  const encoded = dom.getAttribute(`${attribute}-json`);
  // JSON can expand one UTF-16 unit to six ASCII bytes. Bound private
  // decoding by the independently available ordinary payload carrier.
  if (!encoded || encoded.length > fallback.length * 6 + 2) return fallback;
  try {
    const value: unknown = JSON.parse(encoded);
    return typeof value === "string" && !value.includes("\0") && canEncodeButterFileUtf8(value) ? value : fallback;
  } catch { return fallback; }
}
