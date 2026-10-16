import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

const HTML_SPACE = /[\t\n\f\r ]/;
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;

export interface HtmlSourceAttribute {
  readonly name: string;
  /** Raw HTML value, before entity decoding. Boolean attributes are null. */
  readonly value: string | null;
}

export interface HtmlSourceElement {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: string;
  readonly markup: string;
  readonly end: number;
}

/** Read actual lexical HTML, never decoded/entity/escaped ordinary text.
 * Quotes own their angle brackets. Only a complete native element token is
 * admitted here; comparisons, autolinks and incomplete '<' text stay literal. */
export function readHtmlElement(source: string, start: number, limit: number): HtmlSourceElement | null {
  if (source[start] !== "<") return null;
  const prefix = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\t\n\f\r />])/.exec(source.slice(start, limit));
  if (!prefix) return null;
  const closing = prefix[1] === "/";
  const attributesStart = start + prefix[0].length;
  let cursor = attributesStart;
  let quote = "";
  for (; cursor < limit; cursor++) {
    const character = source[cursor];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "<") {
      return null;
    } else if (character === ">") {
      break;
    }
  }
  if (cursor >= limit || quote) return null;
  let attributes = source.slice(attributesStart, cursor);
  const parsed = closing ? null : readAttributeSource(attributes);
  if (closing ? !/^[\t\n\f\r ]*$/.test(attributes) : parsed === null) return null;
  const selfClosing = parsed?.selfClosing ?? false;
  if (selfClosing) attributes = attributes.slice(0, -1);
  return { name: prefix[2].toLowerCase(), closing, selfClosing, attributes,
    markup: source.slice(start, cursor + 1), end: cursor + 1 };
}

/** Complete raw attribute syntax. Unknown/duplicate fields can be protected
 * before a supported handler discards them. A final '/' is the img codec's
 * lexical self-close, not a private field or an ignored style declaration. */
function readAttributeSource(source: string): {
  readonly attributes: readonly HtmlSourceAttribute[];
  readonly selfClosing: boolean;
} | null {
  const attributes: HtmlSourceAttribute[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const beforeSpace = cursor;
    while (HTML_SPACE.test(source[cursor] ?? "")) cursor++;
    if (cursor === source.length) return { attributes, selfClosing: false };
    if (source[cursor] === "/" && cursor + 1 === source.length) return { attributes, selfClosing: true };
    if (cursor === beforeSpace) return null;
    const name = ATTRIBUTE_NAME.exec(source.slice(cursor));
    if (!name) return null;
    cursor += name[0].length;
    const normalizedName = name[0].toLowerCase();
    const afterName = cursor;
    while (HTML_SPACE.test(source[cursor] ?? "")) cursor++;
    let value: string | null = null;
    if (source[cursor] === "=") {
      cursor++;
      while (HTML_SPACE.test(source[cursor] ?? "")) cursor++;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, ++cursor);
        if (close < 0) return null;
        value = source.slice(cursor, close);
        cursor = close + 1;
      } else {
        const start = cursor;
        while (cursor < source.length && !HTML_SPACE.test(source[cursor])) {
          if (/["'=<>`]/.test(source[cursor])) return null;
          cursor++;
        }
        if (cursor === start) return null;
        value = source.slice(start, cursor);
      }
    } else cursor = afterName;
    attributes.push({ name: normalizedName, value });
  }
  return { attributes, selfClosing: false };
}

export function parseHtmlAttributes(source: string): readonly HtmlSourceAttribute[] | null {
  return readAttributeSource(source)?.attributes ?? null;
}

/** Attribute substring from an opening token (not an entire '<tag>'). */
export function hasOnlyQualifiedHtmlAttributes(source: string, allowed: readonly string[]): boolean {
  const attributes = parseHtmlAttributes(source);
  return attributes !== null && new Set(attributes.map(attribute => attribute.name)).size === attributes.length &&
    attributes.every(attribute => attribute.value !== null && allowed.includes(attribute.name));
}

/** Unsupported source remains a token-owned diagnostic, not ordinary text.
 * The bridge turns this flag into the existing locked whole-source fallback. */
export function protectHtmlSource(state: StateInline, silent: boolean, markup: string): true {
  state.pos += markup.length;
  if (!silent) {
    const token = state.push("html_inline_boundary", "", 0);
    token.markup = markup;
    token.meta = { nativeUnsupportedHtml: true };
  }
  return true;
}
