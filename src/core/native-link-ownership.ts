import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import Token from "markdown-it/lib/token.mjs";

function protectEntities(value: string): string {
  return value.replace(/&(?=(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);)/g, "&amp;");
}

/** Shared destination/title spelling for visible and zero-width links. */
export function markdownLinkDestination(value: string, hasTitle = false): string {
  const raw = protectEntities(value).replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
  if (!raw && hasTitle) return "<>";
  return /[\s()<>\\]/.test(raw) ? `<${raw.replace(/([<>\\])/g, "\\$1")}>` : raw;
}

export function markdownLinkTitle(value: string): string {
  return protectEntities(value).replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/(["\\])/g, "\\$1");
}

export function emptyLinkSource(attrs: { readonly href?: unknown; readonly title?: unknown; readonly sourceSyntax?: unknown; readonly reference?: unknown }): string {
  if (attrs.sourceSyntax === "reference") return `[][${typeof attrs.reference === "string" ? attrs.reference : ""}]`;
  if (attrs.sourceSyntax === "html") {
    const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<a href="${escape(typeof attrs.href === "string" ? attrs.href : "")}"${typeof attrs.title === "string" && attrs.title ? ` title="${escape(attrs.title)}"` : ""}></a>`;
  }
  const title = typeof attrs.title === "string" && attrs.title ? ` "${markdownLinkTitle(attrs.title)}"` : "";
  const href = markdownLinkDestination(typeof attrs.href === "string" ? attrs.href : "", Boolean(title));
  return `[](${href}${title})`;
}

interface RawLink { readonly end: number; readonly href: string; }
interface RawSourceCache {
  source: string;
  limit: number;
  rejectedDomain?: { readonly start: number; readonly end: number; readonly underscore: number };
  rejectedEmailLocal?: { readonly start: number; readonly end: number };
}

const asciiDomain = /^[A-Za-z0-9_.-]$/;
const asciiEmailLocal = /^[A-Za-z0-9+_.-]$/;
const inlineSyntaxBoundary = /^[\n\r!#$%&*+\-:<=>@[\\\]^_`{}~]$/;

function rawUrlAt(source: string, start: number, limit: number, cache: RawSourceCache): RawLink | null {
  const prefix = /^(?:https?:\/\/|www\.)/i.exec(source.slice(start, start + 8));
  if (!prefix) return null;
  const hostStart = start + (prefix[0].toLowerCase() === "www." ? 0 : prefix[0].length);
  const rejected = cache.rejectedDomain;
  if (rejected && hostStart >= rejected.start && hostStart <= rejected.underscore && hostStart < rejected.end) return null;
  let hostEnd = hostStart;
  while (hostEnd < limit && asciiDomain.test(source[hostEnd])) {
    // Repeated dots end the domain; a previously complete host can still
    // own a following path, while an incomplete host remains literal.
    if (source[hostEnd] === "." && source[hostEnd + 1] === ".") break;
    hostEnd++;
  }
  const host = source.slice(hostStart, hostEnd);
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.some(label => !label)) return null;
  if (labels.slice(-2).some(label => label.includes("_"))) {
    // Every later www prefix before this final underscore has the same
    // rejected suffix. Cache it once rather than rescanning a long host.
    cache.rejectedDomain = { start: hostStart, end: hostEnd, underscore: hostStart + host.lastIndexOf("_") };
    return null;
  }
  // A final domain dot is native URL text. Punctuation after the domain is
  // trimmed independently, including unmatched closing parentheses.
  let end = hostEnd;
  while (end < limit && !/[\s<]/.test(source[end])) end++;
  const entity = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);$/.exec(source.slice(hostEnd, end));
  if (entity) end -= entity[0].length;
  while (end > hostEnd && /[!*,.:;?_~]/.test(source[end - 1])) end--;
  let balance = 0;
  for (let index = hostEnd; index < end; index++) {
    if (source[index] === "(") balance++;
    else if (source[index] === ")") balance--;
  }
  while (end > hostEnd && source[end - 1] === ")" && balance < 0) { end--; balance++; }
  const text = source.slice(start, end);
  return { end, href: prefix[0].toLowerCase() === "www." ? "http://" + text : text };
}

function rawEmailAt(source: string, start: number, limit: number): { link: RawLink | null; localEnd: number } {
  let localEnd = start;
  while (localEnd < limit && asciiEmailLocal.test(source[localEnd])) localEnd++;
  if (localEnd === start || source[localEnd] !== "@") return { link: null, localEnd };
  let end = localEnd + 1;
  while (end < limit && asciiDomain.test(source[end])) end++;
  const domain = source.slice(localEnd + 1, end).replace(/\.$/, "");
  if (!domain.includes(".") || /[-_]$/.test(domain) || !domain.split(".").every(Boolean)) return { link: null, localEnd };
  if (source[end - 1] === ".") end--;
  return { link: { end, href: "mailto:" + source.slice(start, end) }, localEnd };
}

/** HTML code is an ordinary native inline styling scope, unlike backticks.
 * Its authored raw URL/email syntax owns navigation before entities, escapes
 * or delimiter rules run. Generated literal code uses escaped punctuation,
 * so it cannot acquire an unintended link through decoded text.
 */
export function nativeHtmlCodeLinksPlugin(md: MarkdownIt): void {
  const scopes = new WeakMap<StateInline, { scanned: number; code: number; opaque: number }>();
  const sources = new WeakMap<StateInline, RawSourceCache>();
  md.inline.ruler.before("text", "native_html_code_links", (state, silent) => {
    // Link-label lookahead must see its raw closing bracket. The eventual
    // linked-label parse already excludes autolinks through linkLevel.
    if (silent) return false;
    const scope = scopes.get(state) ?? { scanned: 0, code: 0, opaque: 0 };
    for (; scope.scanned < state.tokens.length; scope.scanned++) {
      const token = state.tokens[scope.scanned];
      if (token.type === "html_code_open") scope.code++;
      else if (token.type === "html_code_close") scope.code = Math.max(0, scope.code - 1);
      if (token.type === "obsidian_comment_open" || token.type === "html_comment_open" && token.markup === "<!--") scope.opaque++;
      else if (token.type === "obsidian_comment_close" || token.type === "html_comment_close" && token.markup === "-->") scope.opaque = Math.max(0, scope.opaque - 1);
    }
    scopes.set(state, scope);
    if (!scope.code || scope.opaque || (state as StateInline & { readonly linkLevel: number }).linkLevel > 0) return false;
    let cache = sources.get(state);
    if (!cache || cache.source !== state.src || cache.limit !== state.posMax) {
      cache = { source: state.src, limit: state.posMax };
      sources.set(state, cache);
    }
    let rejectedLocalEnd = state.pos;
    for (let start = state.pos; start < state.posMax; start++) {
      let link = rawUrlAt(state.src, start, state.posMax, cache);
      if (!link && start >= rejectedLocalEnd && asciiEmailLocal.test(state.src[start])) {
        const rejected = cache.rejectedEmailLocal;
        if (rejected && start >= rejected.start && start < rejected.end) rejectedLocalEnd = rejected.end;
        else {
          const email = rawEmailAt(state.src, start, state.posMax);
          link = email.link;
          rejectedLocalEnd = email.localEnd;
          if (!link && state.src[email.localEnd] !== "@") cache.rejectedEmailLocal = { start, end: email.localEnd };
        }
      }
      if (link) {
        if (!silent) {
          state.pending += state.src.slice(state.pos, start);
          const decode = (text: string): string => text.replace(
            /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/g,
            entity => md.utils.unescapeAll(entity),
          );
          const open = state.push("link_open", "a", 1);
          open.attrSet("href", md.normalizeLink(decode(link.href)));
          open.markup = "native-html-code-link";
          state.push("text", "", 0).content = decode(state.src.slice(start, link.end));
          state.push("link_close", "a", -1).markup = "native-html-code-link";
        }
        state.pos = link.end;
        return true;
      }
      if (inlineSyntaxBoundary.test(state.src[start])) return false;
    }
    return false;
  });
}

interface LinkFrame {
  readonly open: Token;
  readonly outputIndex: number;
  visible: boolean;
  cut: boolean;
}

interface InlineScope {
  readonly open: Token;
  readonly owner: LinkFrame | undefined;
  expired: boolean;
}

function isScope(token: Token, edge: "open" | "close"): boolean {
  return edge === "open"
    ? /^(?:strong|em|s|highlight|html_.*|obsidian_comment)_open$/.test(token.type)
    : /^(?:strong|em|s|highlight|html_.*|obsidian_comment)_close$/.test(token.type);
}

function reconstructsAfterAnchor(token: Token): boolean {
  // Native rendering uses del/mark for Markdown strike/highlight. Those are
  // normal DOM containers, while the HTML formatting-element reconstruction
  // set preserves strong/em/u/code/font/s across a nested anchor's boundary.
  return /^(?:strong|em|html_(?:strong|em|underline|code|font|s))_open$/.test(token.type);
}

function emptyToken(open: Token): Token {
  const token = new Token("empty_link", "a", 0);
  token.attrs = open.attrs;
  token.meta = open.meta as unknown;
  token.level = open.level;
  // No source range is copied: a nonempty authored label is not the empty
  // codec. Its whole unchanged block may still preserve its original bytes.
  return token;
}

/** Native tag anchors terminate an external label's navigation permanently.
 * Interpret only resolved raw-source tags, after boundary/mark resolution.
 * Escaped/entity/code hashes and image alt labels remain literal. Empty
 * external prefixes retain their inactive href/title in a zero-width atom.
 */
export function nativeLinkOwnershipPlugin(md: MarkdownIt): void {
  md.core.ruler.after("obsidian_tag_boundaries", "native_link_ownership", state => {
    const definitions = new Set(state.tokens.filter(token => token.type === "footnote_def").map(token => (token.meta as { label?: string } | null)?.label));
    for (const inline of state.tokens) {
      if (inline.type !== "inline" || !inline.children) continue;
      const output: Token[] = [], links: LinkFrame[] = [], scopes: InlineScope[] = [];
      for (let tokenIndex = 0; tokenIndex < inline.children.length; tokenIndex++) {
        const token = inline.children[tokenIndex];
        if (token.type === "html_inline_boundary" && (token.meta as { nativeFootnoteCarrier?: unknown } | null)?.nativeFootnoteCarrier) continue;
        if (token.type === "link_open") {
          links.push({ open: token, outputIndex: output.length, visible: false, cut: false });
          output.push(token);
          continue;
        }
        if (token.type === "link_close") {
          const link = links.pop();
          if (link && !link.cut && !link.visible) {
            const content = output.slice(link.outputIndex + 1).some(child => child.content.length > 0 ||
              ["wikilink", "obsidian_tag", "comment_navigation", "footnote_ref", "obsidian_embed_inline"].includes(child.type));
            output[link.outputIndex] = content && (link.open.meta as { linkOccurrence?: unknown } | null)?.linkOccurrence
              ? new Token("link_owned_empty_prefix", "", 0) : emptyToken(link.open);
          }
          else if (!link?.cut) output.push(token);
          continue;
        }
        const link = links[links.length - 1];
        const rawComment = scopes.some(scope => !scope.expired && scope.open.type === "obsidian_comment_open");
        const nestedAnchor = token.type === "obsidian_tag" || token.type === "wikilink" || token.type === "inline_footnote" ||
          token.type === "footnote_ref" && definitions.has(token.content);
        const anchorBreak = token.type === "html_inline_boundary" && (token.meta as { nativeAnchorBreak?: boolean } | null)?.nativeAnchorBreak;
        if (anchorBreak) {
          let next = tokenIndex + 1;
          let footnoteCarrier = false;
          while (next < inline.children.length && (isScope(inline.children[next], "open") || isScope(inline.children[next], "close") ||
            inline.children[next].type === "html_inline_boundary" && (inline.children[next].meta as { nativeFootnoteCarrier?: unknown } | null)?.nativeFootnoteCarrier === "open" ||
            ["text", "text_special"].includes(inline.children[next].type) && !inline.children[next].content)) {
            if ((inline.children[next].meta as { nativeFootnoteCarrier?: unknown } | null)?.nativeFootnoteCarrier === "open") footnoteCarrier = true;
            next++;
          }
          const target = inline.children[next];
          // The neutral codec is qualified at an actual nested anchor. A
          // standalone authored anchor cannot silently discard navigation on
          // ordinary label text through this source projection.
          // A bare footnote after the neutral anchor retains native intrinsic
          // superscript, unlike a nested footnote carrier. The current rich
          // model has no separate provenance for that DOM scope; keep this
          // authored source protected instead of collapsing the two states.
          if (!target || !["obsidian_tag", "wikilink"].includes(target.type) &&
            !(footnoteCarrier && (target.type === "inline_footnote" || target.type === "footnote_ref" && definitions.has(target.content)))) {
            token.meta = { nativeUnsupportedAnchor: true }; output.push(token); continue;
          }
        }
        if ((nestedAnchor || anchorBreak) && !rawComment && link && !link.cut) {
          link.cut = true;
          for (let index = scopes.length - 1; index >= 0; index--) {
            const scope = scopes[index];
            if (scope.owner !== link || scope.expired || reconstructsAfterAnchor(scope.open)) continue;
            scope.expired = true;
            output.push(new Token(scope.open.type.replace(/_open$/, "_close"), scope.open.tag, scope.open.nesting === 1 ? -1 : 0));
          }
          if (link.visible) output.push(new Token("link_close", "a", -1));
          else output[link.outputIndex] = (link.open.meta as { linkOccurrence?: unknown } | null)?.linkOccurrence
            ? new Token("link_owned_empty_prefix", "", 0) : emptyToken(link.open);
        }
        if (anchorBreak) continue;
        if (isScope(token, "open")) scopes.push({ open: token, owner: link?.cut ? undefined : link, expired: false });
        else if (isScope(token, "close")) {
          const openType = token.type.replace(/_close$/, "_open");
          let index = scopes.length - 1;
          while (index >= 0 && scopes[index].open.type !== openType) index--;
          const scope = index >= 0 ? scopes.splice(index, 1)[0] : undefined;
          if (scope?.expired) continue;
        } else if (!scopes.some(scope => !scope.expired && /^(?:obsidian_comment|html_comment)_open$/.test(scope.open.type)) &&
          ((["text", "text_special", "code_inline"].includes(token.type) && token.content.length > 0) ||
          ["softbreak", "hardbreak", "image", "wikilink", "inline_math", "inline_footnote", "footnote_ref", "obsidian_embed_inline"].includes(token.type))) {
          for (const owner of links) if (!owner.cut) owner.visible = true;
        }
        output.push(token);
      }
      inline.children = output.filter(token => token.type !== "link_owned_empty_prefix");
    }
  });
}
