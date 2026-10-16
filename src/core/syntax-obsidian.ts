/**
 * markdown-it plugins for all Obsidian-specific syntax.
 * Each plugin registers inline or block rules that produce tokens
 * the ProseMirror parser can map to schema nodes/marks.
 */
import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import { isObsidianTagCharacter } from "./tag-characters";
import { nativeSingleLineSetextPlugin } from "./native-setext";
import { nativeDelimiterPlugin } from "./native-delimiters";
import { nativeHtmlCodeLinksPlugin, nativeLinkOwnershipPlugin } from "./native-link-ownership";
import { linkOccurrencePlugin } from "./link-occurrence";
import { hasNativeBlockIdSourceBoundary } from "./block-id-boundary";
import { htmlBlockCommentPlugin, findHtmlCommentEnd } from "./html-comments";
import { hasOnlyQualifiedHtmlAttributes, parseHtmlAttributes, protectHtmlSource, readHtmlElement } from "./html-source-safety";
import { isNativeHtmlSourceBlock, nativeHtmlBlockPayload } from "./native-html-block-source";
import { nativeSourceTags, nativeSourceFootnoteReferences } from "./source-tags";
import { nativeSourceNavigation } from "./comment-navigation";
import { nativeSourceMarkdownNavigation, commentMarkdownNavigationPlugin } from "./comment-markdown-navigation";
import { setSourceFootnoteGrammar } from "./source-footnotes";
import type Token from "markdown-it/lib/token.mjs";
import {
  findInlineMathClose,
  isValidInlineMathOpenAt,
} from "./inline-math-delimiters";

type MarkdownItBlockRule = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

function stripIndentColumns(line: string, columns: number): string {
  let offset = 0;
  let column = 0;
  while (offset < line.length && column < columns) {
    if (line[offset] === " ") {
      column += 1;
      offset += 1;
    } else if (line[offset] === "\t") {
      column += 4 - (column % 4);
      offset += 1;
    } else {
      break;
    }
  }
  return line.slice(offset);
}

/**
 * Markdown-it intentionally consumes reference definitions into `env` and
 * emits no token. Butter needs an explicit source artifact so editing a
 * containing paragraph/list/blockquote/callout cannot delete untouched
 * definitions. Wrap the built-in CommonMark rule, preserving its parsing and
 * precedence behavior, and add one zero-width semantic token at the exact
 * container level where the definition was authored.
 */
export function referenceDefinitionPlugin(md: MarkdownIt): void {
  const ruler = md.block.ruler as unknown as {
    __rules__: Array<{ name: string; fn: MarkdownItBlockRule }>;
  };
  const referenceRule = ruler.__rules__.find(
    (rule) => rule.name === "reference",
  );
  if (!referenceRule) {
    throw new Error("Markdown-it reference rule unavailable");
  }
  const original = referenceRule.fn;
  referenceRule.fn = function retainedReferenceDefinition(
    state,
    startLine,
    endLine,
    silent,
  ) {
    const blockIndent = state.blkIndent;
    const matched = original.call(
      this,
      state,
      startLine,
      endLine,
      silent,
    );
    if (!matched || silent) return matched;

    const lastLine = state.line;
    const lines: string[] = [];
    for (let line = startLine; line < lastLine; line++) {
      const sourceLine = state.src.slice(
        state.bMarks[line],
        state.eMarks[line],
      );
      // On the first line, tShift points past a list marker (or ordinary
      // optional indentation) to the definition itself. On continuation
      // lines, remove only the container indentation so the definition's own
      // two-or-more-space continuation indentation remains authored data.
      lines.push(line === startLine
        ? state.src.slice(
            state.bMarks[line] + state.tShift[line],
            state.eMarks[line],
          )
        : stripIndentColumns(sourceLine, blockIndent));
    }
    const token = state.push("reference_definition", "", 0);
    token.content = lines.join("\n");
    token.map = [startLine, lastLine];
    return true;
  };
}

// ══════════════════════════════════════════
// 1. Highlights  ==text==
// ══════════════════════════════════════════

export function highlightPlugin(md: MarkdownIt) {
  md.inline.ruler.before("emphasis", "highlight", highlightRule);

  function highlightRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x3D /* = */ || src.charCodeAt(start + 1) !== 0x3D) return false;

    // Find closing ==
    let end = start + 2;
    while (end < state.posMax - 1) {
      if (src.charCodeAt(end) === 0x3D && src.charCodeAt(end + 1) === 0x3D) break;
      end++;
    }
    if (end >= state.posMax - 1) return false;
    if (end === start + 2) return false; // empty

    // Advance pos BEFORE the silent branch: markdown-it's skipToken
    // asserts `state.pos` moves on a `true` return, and throws "inline
    // rule didn't increment state.pos" otherwise. Silent calls come
    // from parseLinkLabel while tokenizing the `[…]` part of a link
    // if a highlight sits inside link text, we used to throw there.
    state.pos = end + 2;
    if (silent) return true;

    const tokenOpen = state.push("highlight_open", "mark", 1);
    tokenOpen.markup = "==";

    // Recursively tokenize the inner content so other inline rules
    // (HTML inline tags <sup>/<sub>/<kbd>/<font>/<u>, em/strong,
    // wikilinks, math, etc.) fire inside the highlight scope.
    // Pushing one raw `text` token here would make `==<sup>x</sup>==`
    // re-parse as highlight wrapping literal `<sup>x</sup>` text,
    // dropping the sup mark on round-trip.
    const oldPos = state.pos;
    const oldPosMax = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.pos = oldPos;
    state.posMax = oldPosMax;

    const tokenClose = state.push("highlight_close", "mark", -1);
    tokenClose.markup = "==";

    return true;
  }
}

// ══════════════════════════════════════════
// 2. Inline math  $...$
// ══════════════════════════════════════════

export function inlineMathPlugin(md: MarkdownIt) {
  md.inline.ruler.after("escape", "inline_math", inlineMathRule);

  function inlineMathRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (!isValidInlineMathOpenAt(src, start)) return false;

    const end = findInlineMathClose(src, start, state.posMax);
    if (end < 0 || end >= state.posMax) return false;
    if (end === start + 1) return false; // empty $$ → skip

    const content = src.slice(start + 1, end);
    if (!content.trim() || content !== content.trim()) return false;

    // Advance pos before silent return (see highlight rule above).
    state.pos = end + 1;
    if (silent) return true;

    const token = state.push("inline_math", "", 0);
    token.content = content;
    token.markup = "$";

    return true;
  }
}

// ══════════════════════════════════════════
// 3. Block math  $$...$$
// ══════════════════════════════════════════

export function blockMathPlugin(md: MarkdownIt) {
  md.block.ruler.before("fence", "math_block", mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote"],
  });

  function mathBlockRule(
    state: StateBlock, startLine: number, endLine: number, silent: boolean,
  ): boolean {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const maxPos = state.eMarks[startLine];

    if (startPos + 2 > maxPos) return false;
    const src = state.src;
    if (src.charCodeAt(startPos) !== 0x24 || src.charCodeAt(startPos + 1) !== 0x24) return false;

    // Opening line may have content after $$
    const openExtra = src.slice(startPos + 2, maxPos).trim();

    // Find closing $$
    let nextLine = startLine + 1;
    let found = false;
    while (nextLine < endLine) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      const line = src.slice(lineStart, lineMax).trim();
      if (line === "$$") { found = true; break; }
      nextLine++;
    }
    if (!found) return false;
    if (silent) return true;

    // Collect content between $$ fences
    const lines: string[] = [];
    if (openExtra) lines.push(openExtra);
    for (let i = startLine + 1; i < nextLine; i++) {
      lines.push(src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]));
    }

    const token = state.push("math_block", "", 0);
    token.content = lines.join("\n");
    token.markup = "$$";
    token.map = [startLine, nextLine + 1];

    state.line = nextLine + 1;
    return true;
  }
}

// ══════════════════════════════════════════
// 4. Wikilinks  [[target]] [[target|alias]]
// ══════════════════════════════════════════

export function wikilinkPlugin(md: MarkdownIt) {
  md.inline.ruler.before("link", "wikilink", wikilinkRule);

  function wikilinkRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5B /* [ */ || src.charCodeAt(start + 1) !== 0x5B) return false;

    let end = start + 2;
    let depth = 1;
    while (end < state.posMax - 1 && depth > 0) {
      if (src.charCodeAt(end) === 0x5B && src.charCodeAt(end + 1) === 0x5B) { depth++; end += 2; continue; }
      if (src.charCodeAt(end) === 0x5D && src.charCodeAt(end + 1) === 0x5D) { depth--; if (depth === 0) break; end += 2; continue; }
      end++;
    }
    if (depth !== 0) return false;

    const inner = src.slice(start + 2, end);
    if (!inner) return false;

    // Advance pos before silent return (see highlight rule above).
    state.pos = end + 2;
    if (silent) return true;

    const pipeIdx = inner.indexOf("|");
    const target = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
    const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : "";

    const token = state.push("wikilink", "", 0);
    token.content = inner;
    token.meta = { target, alias, rawNavigationStart: start, rawNavigationEnd: end + 2,
      rawNavigationSource: src.slice(start, end + 2) };
    token.markup = "[[";

    return true;
  }
}

// ══════════════════════════════════════════
// 5. Embeds  ![[...]]
// ══════════════════════════════════════════

export function embedPlugin(md: MarkdownIt) {
  // Inline rule: tokenize ![[...]] inside paragraphs
  md.inline.ruler.before("wikilink", "obsidian_embed_inline", embedInlineRule);
  // Core rule: lift embed-only paragraphs to block-level embed tokens
  md.core.ruler.after("inline", "obsidian_embed_block", embedBlockRule);

  function embedInlineRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x21 /* ! */ ||
        src.charCodeAt(start + 1) !== 0x5B /* [ */ ||
        src.charCodeAt(start + 2) !== 0x5B) return false;

    let end = start + 3;
    while (end < state.posMax - 1) {
      if (src.charCodeAt(end) === 0x5D && src.charCodeAt(end + 1) === 0x5D) break;
      end++;
    }
    if (end >= state.posMax - 1) return false;

    const inner = src.slice(start + 3, end);
    if (!inner) return false;

    // Advance pos before silent return (see highlight rule above).
    state.pos = end + 2;
    if (silent) return true;

    const token = state.push("obsidian_embed_inline", "", 0);
    token.content = inner;
    token.markup = "![[";
    token.meta = { rawNavigationStart: start, rawNavigationEnd: end + 2,
      rawNavigationSource: src.slice(start, end + 2) };

    return true;
  }

  // After inline parsing, check if a paragraph contains ONLY an embed token.
  // If so, replace the entire paragraph with a block-level obsidian_embed token.
  //
  // EXCEPTION: don't lift when the paragraph is inside a list item.
  // list_item's schema requires `paragraph block*` as its first child
  // lifting an embed-only paragraph to a block would force the
  // ProseMirror parser to synthesize an empty leading paragraph to
  // satisfy the schema, which then serializes as `- \n\n  ![[…]]`
  // (empty bullet + indented embed on next line). Keeping the embed
  // inline inside its paragraph serializes cleanly as `- ![[…]]`.
  function embedBlockRule(state: StateCore): void {
    const tokens: Token[] = state.tokens;

    // Walk once, tracking current list_item depth. A paragraph
    // inside a list_item (open but not yet closed) is ineligible
    // for the block lift.
    const liftable = new Set<number>(); // indices of paragraph_close eligible for lift
    let listDepth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "list_item_open") listDepth++;
      else if (t.type === "list_item_close") listDepth--;
      else if (t.type === "paragraph_close" && listDepth === 0) {
        liftable.add(i);
      }
    }

    // Walk backwards (so splices further up don't shift indices
    // we've already passed).
    for (let i = tokens.length - 1; i >= 2; i--) {
      if (!liftable.has(i)) continue;
      const inlineToken = tokens[i - 1];
      if (inlineToken.type !== "inline" || !inlineToken.children) continue;

      // Check if the inline content is exactly one embed token
      const children = inlineToken.children.filter(
        (c: Token) => !(c.type === "text" && !c.content.trim()),
      );
      if (children.length !== 1 || children[0].type !== "obsidian_embed_inline") continue;

      // Replace paragraph_open + inline + paragraph_close with embed block token
      const embedToken = new state.Token("obsidian_embed", "", 0);
      embedToken.content = children[0].content;
      embedToken.markup = "![[";
      embedToken.map = tokens[i - 2].map;

      tokens.splice(i - 2, 3, embedToken);
      i -= 2; // adjust index
    }
  }
}

// ══════════════════════════════════════════
// 6. Tags  #tag #nested/tag
// ══════════════════════════════════════════

export function tagPlugin(md: MarkdownIt) {
  md.inline.ruler.push("obsidian_tag", tagRule);
  md.core.ruler.after("inline", "obsidian_tag_boundaries", resolveTagBoundaries);

  function resolveTagBoundaries(state: StateCore): void {
    const literalizeLabelTags = (tokens: Token[]): void => {
      for (const token of tokens) {
        if (token.type === "obsidian_tag_candidate") {
          token.type = "text";
          token.content = `#${token.content}`;
          token.markup = "";
        }
        if (token.children) literalizeLabelTags(token.children);
      }
    };
    for (const inline of state.tokens) {
      if (inline.type !== "inline" || !inline.children) continue;
      let boundary = true;
      for (let index = 0; index < inline.children.length; index++) {
        const token = inline.children[index];
        if (token.type === "link_occurrence_open" || token.type === "link_occurrence_close") continue;
        // These delimiters have no visible width. Native emphasis tokens are
        // resolved by inline2 before this core pass, so unmatched delimiters
        // remain ordinary text and cannot create a fictitious tag boundary.
        if (token.type === "image" && token.children) literalizeLabelTags(token.children);
        if (/^(?:html_.*|strong|em|s|highlight|link|obsidian_comment)_(?:open|close)$/.test(token.type) ||
          token.type === "html_inline_boundary") {
          // Native Obsidian starts a new tag-scanning segment after resolved
          // syntax, even when that segment follows non-whitespace content.
          boundary = true;
          continue;
        }
        if ((token.type === "text" || token.type === "text_special") && !token.content) continue;
        if (token.type === "obsidian_tag_candidate") {
          token.type = boundary ? "obsidian_tag" : "text";
          if (!boundary) {
            token.content = `#${token.content}`;
            token.markup = "";
          } else {
            // Delimiter pairing may leave part of a prospective underscore
            // closing run as visible tag characters in the same scope.
            const tail = Number((token.meta as { tagUnderscoreTail?: number } | null)?.tagUnderscoreTail ?? 0);
            const next = inline.children[index + 1];
            if (tail && next?.type === "text") {
              const leftovers = /^_+/.exec(next.content)?.[0] ?? "";
              const length = Math.min(tail, leftovers.length);
              token.content += leftovers.slice(0, length);
              next.content = next.content.slice(length);
            }
          }
        }
        // Decoded entity whitespace is visible text, but does not establish
        // the raw source boundary used by native Obsidian's tag scanner.
        boundary = ["softbreak", "hardbreak", "code_inline", "wikilink", "obsidian_embed_inline", "inline_math", "footnote_ref", "inline_footnote", "image"].includes(token.type) ||
          ((token.type === "text" || token.type === "text_special") && token.info !== "entity" && /\s$/.test(token.content));
      }
    }
  }

  function tagRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x23 /* # */) return false;

    // Resolved raw tags also own native navigation inside external labels.
    // The later ownership pass ends that link at its first genuine tag.

    // Scan the exact native character domain by complete Unicode code point.
    let end = start + 1;
    let hasNonDigit = false;
    while (end < state.posMax) {
      const point = src.codePointAt(end);
      if (point === undefined) break;
      const character = String.fromCodePoint(point);
      if (!isObsidianTagCharacter(character)) break;
      if (point < 0x30 || point > 0x39) hasNonDigit = true;
      end += character.length;
    }

    if (end === start + 1) return false; // just #
    if (!hasNonDigit) return false; // all digits

    // Underscores also belong to tag names. Give a prospective native
    // emphasis close its source bytes when an underscore opener exists;
    // the resolved core pass keeps unmatched remainder as tag text.
    const underscoreTail = /_+$/.exec(src.slice(start + 1, end))?.[0] ?? "";
    const closingStart = end - underscoreTail.length;
    const closesEmphasis = underscoreTail && closingStart > start + 1 &&
      state.delimiters.some((delimiter) => delimiter.marker === 0x5F && delimiter.open) &&
      state.scanDelims(closingStart, false).can_close;
    if (closesEmphasis) end = closingStart;

    // Advance pos before silent return (see highlight rule above).
    state.pos = end;
    if (silent) return true;

    const tag = src.slice(start + 1, end);
    // Only a raw source # reaches this rule. Escapes/entities remain text;
    // the core pass resolves this candidate's boundary after native marks.
    const token = state.push("obsidian_tag_candidate", "", 0);
    token.content = tag;
    token.markup = "#";
    token.meta = { rawTagStart: start, ...(closesEmphasis ? { tagUnderscoreTail: underscoreTail.length } : {}) };

    return true;
  }
}

// ══════════════════════════════════════════
// 7. Inline footnotes  ^[content]
// ══════════════════════════════════════════

export function inlineFootnotePlugin(md: MarkdownIt) {
  md.inline.ruler.after("escape", "inline_footnote", footnoteRule);

  function footnoteRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5E /* ^ */ || src.charCodeAt(start + 1) !== 0x5B /* [ */) return false;

    let depth = 1;
    let end = start + 2;
    while (end < state.posMax && depth > 0) {
      const ch = src.charCodeAt(end);
      if (ch === 0x5B) depth++;
      else if (ch === 0x5D) depth--;
      if (depth > 0) end++;
    }
    if (depth !== 0) return false;

    const content = src.slice(start + 2, end);
    if (!content) return false;

    // Advance pos before silent return (see highlight rule above).
    state.pos = end + 1;
    if (silent) return true;

    const token = state.push("inline_footnote", "", 0);
    token.content = content;
    token.markup = "^[";
    token.meta = { rawInlineFootnoteStart: start };

    return true;
  }
}

// ══════════════════════════════════════════
// 8. Inline comments  %%text%%
// ══════════════════════════════════════════

export function inlineCommentPlugin(md: MarkdownIt) {
  md.inline.ruler.push("obsidian_comment", commentRule);

  function commentRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x25 /* % */ || src.charCodeAt(start + 1) !== 0x25) return false;

    let end = start + 2;
    while (end < state.posMax - 1) {
      if (src.charCodeAt(end) === 0x25 && src.charCodeAt(end + 1) === 0x25) break;
      end++;
    }
    if (end >= state.posMax - 1) return false;

    const content = src.slice(start + 2, end);
    // Native inline %% comments end on the same physical source line.
    // Rich-created hidden LF payloads use the standard hidden-span codec;
    // loading visible multiline percent text must not silently hide it.
    if (/[\r\n]/.test(content)) return false;

    // Advance pos before silent return (see highlight rule above).
    state.pos = end + 2;
    if (silent) return true;

    // Emit as an open/close pair wrapping the inner text. This lets
    // prosemirror-markdown treat it as a mark with preserved content
    // (so %%…%% round-trips losslessly through parse → serialize).
    const openTok = state.push("obsidian_comment_open", "", 1);
    openTok.markup = "%%";
    // Native metadata scanning recognizes genuine source tags inside an
    // otherwise opaque percent comment. Keep only that source-owned meaning
    // as hidden tag atoms; embedded marks/links/HTML remain literal payload.
    let offset = 0;
    const owned = [
      ...nativeSourceTags(md, content).map(tag => ({ ...tag, kind: "obsidian_tag" as const })),
      ...nativeSourceNavigation(md, content),
      ...nativeSourceFootnoteReferences(md, content),
      ...nativeSourceMarkdownNavigation(md, content).map(item => ({ ...item, kind: "comment_navigation" as const })),
    ].sort((left, right) => left.start - right.start || right.end - left.end);
    for (const item of owned) {
      if (item.start < offset) continue;
      if (item.start > offset) state.push("text", "", 0).content = content.slice(offset, item.start);
      const token = state.push(item.kind, "", 0);
      if (item.kind === "obsidian_tag") {
        token.content = item.tag; token.markup = "#";
        token.meta = { rawTagStart: start + 2 + item.start };
      } else if (item.kind === "footnote_ref") {
        token.content = item.label; token.markup = "[^";
        token.meta = { rawFootnoteStart: start + 2 + item.start };
      } else if (item.kind === "comment_navigation") {
        token.meta = { ...item, kind: item.source.startsWith("!") ? "image" : "link", start: start + 2 + item.start, end: start + 2 + item.end };
      } else {
        token.content = item.kind === "wikilink" ? item.source.slice(2, -2) : item.src ?? "";
        token.meta = { target: item.target, alias: item.alias, rawNavigationSource: item.source };
        token.markup = item.kind === "wikilink" ? "[[" : "![[";
      }
      offset = item.end;
    }
    if (offset < content.length) state.push("text", "", 0).content = content.slice(offset);
    const closeTok = state.push("obsidian_comment_close", "", -1);
    closeTok.markup = "%%";

    // Obsidian's metadata reader recognizes a terminal, unescaped native
    // block ID inside a single-line authored comment. Keep the opaque text
    // unchanged; the bridge separately represents the actual reference.
    // This evidence belongs to the raw %% token, never decoded HTML/text.
    if (!/[\r\n]/.test(content) && !/\s$/.test(content) && /\^[A-Za-z0-9-]+/.test(content)) {
      const nativeId = /\^([A-Za-z0-9-]+)$/.exec(content);
      if (nativeId && hasNativeBlockIdSourceBoundary(content, nativeId.index)) {
        closeTok.meta = { nativeBlockId: nativeId[1] };
      } else {
        // Genuine native Markdown closing delimiters can surround metadata
        // inside the comment. Reuse resolved source tokens to distinguish
        // balanced closers from literal/unmatched markers, code and HTML.
        // No %% pair can be inside this payload: its first pair closed the
        // outer comment, so this analysis cannot recursively open a comment.
        for (const inline of md.parseInline(content, {})) {
          for (const token of inline.children ?? []) {
            if (token.type === "block_id") closeTok.meta = { nativeBlockId: token.content };
          }
        }
      }
    }

    return true;
  }
}

// ══════════════════════════════════════════
// 9. Block comments  %%\n...\n%%
// ══════════════════════════════════════════

export function blockCommentPlugin(md: MarkdownIt) {
  md.block.ruler.before("fence", "block_comment", blockCommentRule, {
    alt: ["paragraph", "reference", "blockquote"],
  });

  function blockCommentRule(
    state: StateBlock, startLine: number, endLine: number, silent: boolean,
  ): boolean {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const maxPos = state.eMarks[startLine];
    const src = state.src;

    if (startPos + 2 > maxPos) return false;
    if (src.charCodeAt(startPos) !== 0x25 || src.charCodeAt(startPos + 1) !== 0x25) return false;

    const lineContent = src.slice(startPos, maxPos).trim();

    // Single-line block_comment forms (sentinels Butter recognizes):
    //
    //   `%% %%`            - empty, invisible separator (any whitespace)
    //   `%%list-break%%`   - labeled list-break separator (descriptive)
    //
    // Both parse as block_comment so the NodeView's `display: none`
    // hides them in the editor. The labeled form makes the source
    // self-documenting without changing the in-editor render.
    //
    // The parser is intentionally specific - it does NOT swallow
    // arbitrary `%%text%%` lines as block_comments. A line like
    // `%%TODO%%` keeps its existing behavior (paragraph + inline
    // comment mark) because we don't want to change semantics for
    // any unrelated user-authored comment. Only the empty form and
    // the documented `list-break` sentinel are recognized here.
    if (
      lineContent.length >= 4 &&
      lineContent.startsWith("%%") &&
      lineContent.endsWith("%%") &&
      (/^%%\s*%%$/.test(lineContent) ||
        /^%%\s*list-break\s*%%$/i.test(lineContent))
    ) {
      if (silent) return true;
      const isLabeled = /list-break/i.test(lineContent);
      const token = state.push("block_comment", "", 0);
      token.content = isLabeled ? "list-break" : "";
      token.meta = { nativeTags: [], nativeSyntax: "percent" };
      token.markup = "%%";
      token.map = [startLine, startLine + 1];
      state.line = startLine + 1;
      return true;
    }

    // Multi-line form: `%%` alone on opening line, content lines,
    // `%%` alone on closing line. The historical case - supports
    // user-authored multi-line comments.
    if (lineContent !== "%%") return false;

    // Find closing %%
    let nextLine = startLine + 1;
    let found = false;
    while (nextLine < endLine) {
      const ls = state.bMarks[nextLine] + state.tShift[nextLine];
      const le = state.eMarks[nextLine];
      if (src.slice(ls, le).trim() === "%%") { found = true; break; }
      nextLine++;
    }
    if (!found) return false;
    if (silent) return true;

    const token = state.push("block_comment", "", 0);
    token.content = state.getLines(startLine + 1, nextLine, state.blkIndent, false);
    token.meta = { nativeTags: nativeSourceTags(md, token.content, true).map(value => value.tag), nativeSyntax: "percent" };
    token.markup = "%%";
    token.map = [startLine, nextLine + 1];

    state.line = nextLine + 1;
    return true;
  }
}

// ══════════════════════════════════════════
// 10. Block IDs  ^block-id  (at end of block)
// ══════════════════════════════════════════

export function blockIdPlugin(md: MarkdownIt) {
  md.inline.ruler.push("block_id", blockIdRule);
  md.core.ruler.after("obsidian_tag_boundaries", "block_id_boundaries", resolveBlockIdBoundaries);

  function resolveBlockIdBoundaries(state: StateCore): void {
    const literalize = (token: Token): void => {
      token.type = "text";
      token.content = `^${token.content}`;
      token.markup = "";
    };
    const literalizePayload = (tokens: Token[]): void => {
      for (const token of tokens) {
        if (token.type === "block_id_candidate") literalize(token);
        if (token.children) literalizePayload(token.children);
      }
    };
    const nativeClosingMark = (token: Token): boolean =>
      /^(?:strong|em|s|highlight|link)_close$/.test(token.type) || token.type === "link_occurrence_close" &&
        (token.meta as { resolved?: boolean } | null)?.resolved !== false;
    const nativeBoundary = (token: Token): boolean =>
      nativeClosingMark(token) || /^(?:strong|em|s|highlight|link)_open$/.test(token.type) ||
      /^html_.*_(?:open|close)$/.test(token.type) ||
      ["html_inline_boundary", "code_inline", "inline_math", "wikilink", "obsidian_tag", "obsidian_embed_inline",
        "footnote_ref", "inline_footnote", "image", "empty_link", "softbreak", "hardbreak", "obsidian_comment_close"].includes(token.type);
    for (const inline of state.tokens) {
      if (inline.type !== "inline" || !inline.children) continue;
      const tokens = inline.children;
      const terminalSuffix = new Array<boolean>(tokens.length + 1);
      terminalSuffix[tokens.length] = true;
      for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];
        terminalSuffix[index] = terminalSuffix[index + 1] && (nativeClosingMark(token) ||
          (token.type === "text" && /^\s*$/.test(token.content)));
      }
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.type === "image" && token.children) literalizePayload(token.children);
        if (token.type !== "block_id_candidate") continue;
        const rawBoundary = Boolean((token.meta as { rawBlockIdBoundary?: boolean } | null)?.rawBlockIdBoundary);
        let before = index - 1;
        while (before >= 0 && !tokens[before].content &&
          (tokens[before].type === "text" || tokens[before].type === "text_special" || tokens[before].type === "link_occurrence_close")) before--;
        const boundary = rawBoundary || (before >= 0 && nativeBoundary(tokens[before]));
        // Obsidian recognizes trailing IDs inside native Markdown formatting,
        // including link labels. HTML closing tags remain authored source after
        // an ID, so an ID inside <code> or other HTML scopes stays literal.
        const terminal = terminalSuffix[index + 1];
        if (boundary && terminal) token.type = "block_id";
        else literalize(token);
      }
    }
  }

  function blockIdRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;

    if (src.charCodeAt(start) !== 0x5E /* ^ */) return false;
    // Not a footnote ^[
    if (src.charCodeAt(start + 1) === 0x5B) return false;

    // Scan block ID chars: alphanumeric, dash
    let end = start + 1;
    while (end < state.posMax) {
      const ch = src.charCodeAt(end);
      if ((ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) ||
          (ch >= 0x30 && ch <= 0x39) || ch === 0x2D) {
        end++;
      } else {
        break;
      }
    }
    if (end === start + 1) return false;

    // Advance pos before silent return (see highlight rule above).
    state.pos = end;
    if (silent) return true;

    const id = src.slice(start + 1, end);
    const token = state.push("block_id_candidate", "", 0);
    token.content = id;
    token.markup = "^";
    token.meta = { rawBlockIdBoundary: hasNativeBlockIdSourceBoundary(src, start) };

    return true;
  }
}

// ══════════════════════════════════════════
// 12. Reference footnotes  [^id] and [^id]: content
// ══════════════════════════════════════════

export function footnoteRefPlugin(md: MarkdownIt) {
  md.inline.ruler.after("escape", "footnote_ref", footnoteRefRule);

  function footnoteRefRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;

    if (src.charCodeAt(start) !== 0x5B /* [ */) return false;
    if (src.charCodeAt(start + 1) !== 0x5E /* ^ */) return false;

    // Find closing ]
    let end = start + 2;
    while (end < state.posMax) {
      if (src.charCodeAt(end) === 0x5D /* ] */) break;
      // Only allow simple label chars: alphanumeric, dash, underscore
      const ch = src.charCodeAt(end);
      if (!((ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) ||
            (ch >= 0x30 && ch <= 0x39) || ch === 0x2D || ch === 0x5F)) return false;
      end++;
    }
    if (end >= state.posMax) return false;
    if (end === start + 2) return false; // empty [^]

    const label = src.slice(start + 2, end);
    // Advance pos before silent return (see highlight rule above).
    state.pos = end + 1;
    if (silent) return true;

    const token = state.push("footnote_ref", "", 0);
    token.content = label;
    token.markup = "[^";
    token.meta = { rawFootnoteStart: start };

    return true;
  }
}

export function footnoteDefPlugin(md: MarkdownIt) {
  md.block.ruler.before("reference", "footnote_def", footnoteDefRule, {
    alt: ["paragraph", "reference"],
  });

  function footnoteDefRule(
    state: StateBlock, startLine: number, endLine: number, silent: boolean,
  ): boolean {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const maxPos = state.eMarks[startLine];
    const src = state.src;

    // Must start with [^
    if (startPos + 4 > maxPos) return false;
    if (src.charCodeAt(startPos) !== 0x5B || src.charCodeAt(startPos + 1) !== 0x5E) return false;

    // Find ]:
    let labelEnd = startPos + 2;
    while (labelEnd < maxPos) {
      if (src.charCodeAt(labelEnd) === 0x5D) break;
      labelEnd++;
    }
    if (labelEnd >= maxPos) return false;
    if (src.charCodeAt(labelEnd + 1) !== 0x3A /* : */) return false;

    const label = src.slice(startPos + 2, labelEnd);
    if (!label) return false;

    if (silent) return true;

    // Continuations need four content columns beyond this block container's
    // own indent. Physical list/quote prefix columns are structural syntax,
    // not footnote indentation; counting them would swallow later siblings.
    const firstLineContent = src.slice(labelEnd + 2, maxPos).trim();
    const lines: string[] = [firstLineContent];

    let nextLine = startLine + 1;
    while (nextLine < endLine) {
      const continuationIndent = state.blkIndent + 4;
      if (state.sCount[nextLine] < continuationIndent) break;
      lines.push(state.getLines(nextLine, nextLine + 1, continuationIndent, false));
      nextLine++;
    }

    const token = state.push("footnote_def", "", 0);
    token.content = lines.join("\n").trim();
    token.meta = { label };
    token.map = [startLine, nextLine];

    state.line = nextLine;
    return true;
  }
}

// ══════════════════════════════════════════
// 13. Callouts  > [!type] title
// ══════════════════════════════════════════

export function calloutPlugin(md: MarkdownIt) {
  // Retag blockquote_open / blockquote_close tokens whose first
  // inline content begins with `[!type]` into obsidian_callout_open /
  // obsidian_callout_close, and strip the `[!type] title` prefix
  // from the first inline so the callout's body is editable PM
  // content (paragraphs, lists, code blocks - the normal inner
  // structure of a blockquote).
  md.core.ruler.after("block", "obsidian_callout", calloutCoreRule);

  function calloutCoreRule(state: StateCore): void {
    const tokens: Token[] = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open") continue;

      // Match the closing blockquote.
      let closeIdx = -1;
      let depth = 1;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].type === "blockquote_open") depth++;
        if (tokens[j].type === "blockquote_close") {
          depth--;
          if (depth === 0) { closeIdx = j; break; }
        }
      }
      if (closeIdx < 0) continue;

      // Match only this blockquote's first inline token. A nested
      // blockquote owns its callout marker and is converted separately,
      // so the outer quote retains its wrapping layer.
      let firstInlineIdx = -1;
      for (let j = i + 1; j < closeIdx; j++) {
        if (tokens[j].type === "blockquote_open") break;
        if (tokens[j].type === "inline" && tokens[j].content) {
          firstInlineIdx = j;
          break;
        }
      }
      if (firstInlineIdx < 0) continue;

      const firstContent = tokens[firstInlineIdx].content;
      // Match `[!type][+/-]? optional title` followed by end-of-string
      // or a newline. Softbreaks inside the paragraph are represented
      // as literal `\n` in markdown-it's inline.content.
      const match = firstContent.match(
        /^\[!([^\]\s]+)\]([+-])?([^\n]*)(?:\n([\s\S]*))?$/,
      );
      if (!match) continue;

      const calloutType = match[1].toLowerCase();
      const foldState = match[2] || "";
      const title = (match[3] || "").trim();
      const body = match[4] ?? "";

      // Rewrite the outer tokens.
      tokens[i].type = "obsidian_callout_open";
      tokens[i].tag = "";
      tokens[i].meta = { calloutType, foldState, title };
      tokens[closeIdx].type = "obsidian_callout_close";
      tokens[closeIdx].tag = "";

      // Strip the header line from the first inline so PM renders
      // only the body content inside the callout. Don't pre-parse
      // children here - markdown-it's default `inline` core rule
      // runs AFTER this plugin and will parse `.content` into
      // `.children` itself. Pre-parsing causes the body to be
      // duplicated (our children + the core rule's children both
      // end up in the token).
      if (body.length > 0) {
        tokens[firstInlineIdx].content = body;
        tokens[firstInlineIdx].children = [];
      } else {
        // No body content - remove the wrapping textblock trio so
        // the callout can still hold content (or be empty → we'll
        // insert an empty paragraph on parse). The inline is at
        // firstInlineIdx; its open is at firstInlineIdx - 1, close
        // at firstInlineIdx + 1.
        //
        // The trio is normally paragraph_open / inline /
        // paragraph_close. But markdown-it sometimes parses the
        // first line of a callout body as a SETEXT HEADING when the
        // SECOND line is `-` or `=` (an empty list_item like
        // `> [!note]\n> -` becomes heading-with-[!note]-text +
        // setext-`-`-underline). When that happens, the wrapping
        // trio is heading_open / inline / heading_close. We must
        // strip the heading trio too — leaving it in place produces
        // a `callout > heading(empty)` shape that's both wrong
        // (the empty list_item is lost) and round-trip-unsafe.
        const openIdx = firstInlineIdx - 1;
        const closeIdxTrio = firstInlineIdx + 1;
        const openTok = tokens[openIdx]?.type;
        const closeTok = tokens[closeIdxTrio]?.type;
        const isParaTrio =
          openTok === "paragraph_open" && closeTok === "paragraph_close";
        const isHeadingTrio =
          openTok === "heading_open" && closeTok === "heading_close";
        if (isParaTrio || isHeadingTrio) {
          tokens.splice(openIdx, 3);
          closeIdx -= 3;
        } else {
          tokens[firstInlineIdx].content = "";
        }
      }

      // Don't skip past the callout's closing tag - we want the
      // outer loop to continue through the tokens INSIDE this
      // callout so nested `blockquote_open` tokens that themselves
      // start with `[!type]` get retagged too. The outer token has
      // already been converted to `obsidian_callout_open`, so it
      // won't re-match on the next iteration.
      //
      // This is what enables nested callouts like:
      //   > [!note]
      //   > outer
      //   > > [!warning]
      //   > > inner
      // to round-trip correctly. Before this change, the inner
      // `[!warning]` was parsed as a plain blockquote containing
      // bracket-text, then serialized with backslash-escaped
      // brackets and lost its callout identity.
    }
  }
}

// ══════════════════════════════════════════
// 14. Common inline HTML tags
// ══════════════════════════════════════════
//
// `<font color="…">…</font>`, `<u>…</u>`, `<sup>…</sup>`,
// `<sub>…</sub>`, `<mark>…</mark>`, `<kbd>…</kbd>` - recognized as
// paired inline delimiters and emitted as standard mark open/close
// tokens. Markdown-it's default html:false otherwise treats these as
// literal text. Each tag produces a single-token open/close pair so
// the bridge can map them straight to PM marks.
//
// Why a custom plugin rather than enabling html:true: html:true
// emits `html_inline` tokens for every chunk of literal HTML, with
// no pairing - the bridge would have to walk those tokens, match
// opens to closes, identify supported tags, and rewrite. This plugin
// does the recognition + pairing during tokenization, which the
// existing mark machinery already handles cleanly.
//
// Attribute support is explicit. Unmodeled styling/class/data attributes
// belong to authored source and must not disappear on a rich-text save.

interface HtmlMarkConfig {
  /** HTML tag name (lowercase, no angle brackets). */
  tag: string;
  /** PM token type prefix - emits `${type}_open` and `${type}_close`. */
  type: string;
  /** Attribute names to capture from the open tag's HTML attributes.
   *  Captured into `token.attrs` as `[ [name, value], ... ]`. */
  attrs?: readonly string[];
}

const HTML_INLINE_MARKS: readonly HtmlMarkConfig[] = [
  { tag: "font", type: "html_font", attrs: ["color", "face", "size"] },
  { tag: "u",    type: "html_underline" },
  { tag: "sup",  type: "html_sup" },
  { tag: "sub",  type: "html_sub" },
  { tag: "mark", type: "html_mark", attrs: ["style"] },
  { tag: "kbd",  type: "html_kbd" },
  // Inline HTML code is a styling mark, unlike opaque backtick code spans.
  // Other inline marks/atoms can remain meaningful between these tags.
  { tag: "code", type: "html_code" },
  // Only the exact native hidden style below is modeled. Other raw spans are
  // retained as protected source; escaped/code-literal spans remain text.
  { tag: "span", type: "html_comment", attrs: ["style"] },
  // <strong> / <em> / <s> / <del> as HTML form for overlap-with-
  // other-marks cases - CommonMark emphasis pairing requires nested
  // marks, but PM stores marks as a set so the editor can produce
  // overlapping ranges. The serializer detects overlap and routes
  // the offending mark through its HTML form so the structure round-
  // trips. The bridge maps these tokens onto the same strong/em/
  // strikethrough PM marks as the markdown form.
  { tag: "strong", type: "html_strong" },
  { tag: "em",     type: "html_em" },
  { tag: "s",      type: "html_s" },
  { tag: "del",    type: "html_del" },
];

export function htmlInlineTagsPlugin(md: MarkdownIt) {
  // Keep the existing code/hidden-comment codecs ahead of this rule. A
  // complete standalone HTML block owns all of its source, so unsupported
  // attributes do not force unrelated Markdown into whole-file recovery.
  md.block.ruler.before("paragraph", "native_html_source_block", (state, startLine, endLine, silent) => {
    if (startLine >= endLine || state.sCount[startLine] - state.blkIndent >= 4) return false;
    const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    if (!first.startsWith("<")) return false;
    let nextLine = startLine;
    while (nextLine < endLine && !state.isEmpty(nextLine) && state.sCount[nextLine] >= state.blkIndent) nextLine++;
    const source = state.getLines(startLine, nextLine, state.blkIndent, true);
    if (!isNativeHtmlSourceBlock(source)) return false;
    if (silent) return true;
    const token = state.push("native_html_source_block", "", 0);
    token.content = nativeHtmlBlockPayload(source);
    token.block = true;
    token.map = [startLine, nextLine];
    state.line = nextLine;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.inline.ruler.before("emphasis", "html_opaque_comment", (state, silent) => {
    const start = state.pos;
    const end = findHtmlCommentEnd(state.src, start, state.posMax);
    if (end < 0) return false;
    state.pos = end;
    if (!silent) {
      state.push("html_comment_open", "", 0).markup = "<!--";
      const text = state.push("text", "", 0);
      // HTML comments contain raw opaque payload, not decoded entities or
      // Markdown. They never synthesize native block metadata.
      text.content = state.src.slice(start + 4, end - 3);
      state.push("html_comment_close", "", 0).markup = "-->";
    }
    return true;
  });
  // Native <pre><code> is the lossless block-code form when a payload contains
  // literal CR controls that fenced Markdown would normalize to LF. Accept
  // only this complete one-line codec; nested HTML and arbitrary attributes
  // retain their existing source interpretation, and neighbors cannot enter
  // the code payload. Entity decoding is HTML-only, never Markdown unescaping.
  md.block.ruler.before("fence", "html_code_block", (state, startLine, endLine, silent) => {
    if (startLine >= endLine || state.sCount[startLine] - state.blkIndent >= 4) return false;
    const source = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    const match = /^<pre><code(?: class="language-([^"<>]*)")?>([^<]*)<\/code><\/pre>[ \t]*$/.exec(source);
    if (!match) return false;
    if (silent) return true;
    const decode = (value: string): string => value.replace(
      /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/g,
      (entity) => state.md.utils.unescapeAll(entity),
    );
    const token = state.push("html_code_block", "pre", 0);
    token.content = decode(match[2]);
    token.info = decode(match[1] ?? "");
    token.block = true;
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
  // A complete, empty native span is a semantic-neutral source boundary.
  // Adjacent math atoms need one because closing/opening dollars otherwise
  // merge into a different math delimiter. Styled/nonempty spans are not
  // accepted by this rule.
  md.inline.ruler.before("emphasis", "html_inline_boundary", (state, silent) => {
    const markup = "<span></span>";
    if (!state.src.startsWith(markup, state.pos) || state.pos + markup.length > state.posMax) return false;
    state.pos += markup.length;
    if (!silent) {
      const token = state.push("html_inline_boundary", "", 0);
      token.markup = markup;
    }
    return true;
  });
  // Raw spans inside native opaque %% payload still establish cache-tag
  // boundaries. This token-only analysis never accepts arbitrary span markup
  // as a rich editor mark or drops its literal opaque bytes.
  md.inline.ruler.before("html_inline_boundary", "html_comment_source_span_boundary", (state, silent) => {
    if (!(state.env as { butterNativeCommentSource?: boolean }).butterNativeCommentSource) return false;
    if (state.src[state.pos] !== "<") return false;
    const prefix = /^<\/?span(?=[\s/>])/i.exec(state.src.slice(state.pos, state.posMax));
    if (!prefix) return false;
    if (state.src[state.pos + 1] === "/" && !/^<\/span\s*>/i.test(state.src.slice(state.pos, state.posMax))) return false;
    let end = state.pos + prefix[0].length, quote = "";
    for (; end < state.posMax; end++) {
      const character = state.src[end];
      if (quote) { if (character === quote) quote = ""; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === "<" || character === "\r" || character === "\n") return false;
      if (character === ">") break;
    }
    if (end >= state.posMax || quote) return false;
    const markup = state.src.slice(state.pos, end + 1);
    state.pos = end + 1;
    if (!silent) state.push("html_inline_boundary", "", 0).markup = markup;
    return true;
  });
  // Recognize source-authored break syntax before text/entity decoding. Doing
  // this in the bridge's text handler would turn escaped literal `<br>` into
  // an unintended break and make safe text emission impossible.
  md.inline.ruler.before("emphasis", "html_inline_breaks", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3C) return false;
    const match = /^<br\s*(\/?)>/i.exec(state.src.slice(state.pos, state.posMax));
    if (!match) return false;
    state.pos += match[0].length;
    if (!silent) {
      const token = state.push(match[1] ? "softbreak" : "hardbreak", "br", 0);
      token.markup = match[0];
    }
    return true;
  });
  // Flat open/close tokens - emit `${type}_open` and `${type}_close` as
  // independent points in the inline stream rather than recursing into
  // a clamped sub-state. This lets markdown delimiters (e.g. `**`) and
  // HTML tag boundaries cross arbitrarily:
  //
  //   `<font>**bold</font> still bold**`
  //
  // produces `font_open`, strong-opener `**`, `bold`, `font_close`,
  // ` still bold`, strong-closer `**` in one flat stream. Emphasis
  // post-processing pairs the `**` delimiters; the bridge's set-based
  // mark handling assigns both marks to text runs as appropriate.
  //
  // Pairing of HTML opens/closes uses a stack on the inline state:
  // an `<X>` open emits `X_open` and pushes; `</X>` close only emits
  // `X_close` if the stack top matches (well-nested closes only - an
  // orphan or out-of-order close is left as literal text by returning
  // false).
  const cfgByTag = new Map<string, HtmlMarkConfig>();
  for (const c of HTML_INLINE_MARKS) cfgByTag.set(c.tag.toLowerCase(), c);

  md.inline.ruler.before(
    "emphasis",
    "html_inline_marks",
    function rule(state: StateInline, silent: boolean): boolean {
      const src = state.src;
      const start = state.pos;
      if (src.charCodeAt(start) !== 0x3C /* < */) return false;

      const element = readHtmlElement(src, start, state.posMax);
      if (!element) return false;
      // Try close tag first. An unmatched real close reaches the final source
      // guard instead of becoming newly visible literal markup.
      if (element.closing) {
        const tag = element.name;
        const cfg = cfgByTag.get(tag);
        if (!cfg) return false;
        const stateAny = state as unknown as {
          __butterHtmlStack?: string[];
        };
        const stack = stateAny.__butterHtmlStack || [];
        // Any-match (not strict-LIFO): pop the LAST occurrence of this
        // tag from anywhere in the stack. This handles cross-tag
        // overlap like `<font>**a<em>b</font>c**d</em>` - the `</font>`
        // here closes mid-stack while `em` is still on top. Marks are
        // stored set-wise on PM text runs, so closing in non-LIFO order
        // simply removes the mark from the active set on subsequent
        // text. Strict-LIFO would have rejected this and stranded a
        // dangling html_*_open token, so we'd lose the mark entirely.
        const idx = stack.lastIndexOf(tag);
        if (idx < 0) return false;
        state.pos = element.end;
        if (silent) return true;
        stack.splice(idx, 1);
        stateAny.__butterHtmlStack = stack;
        // nesting=0 (not -1) so state.push doesn't pop the delimiter
        // stack. We need emphasis delimiters inside and outside the
        // html region to share the same `state.delimiters` array so
        // they can pair across the boundary. The bridge dispatches on
        // token type name (`html_X_close`), not nesting, so this is
        // safe - tokens still carry the open/close semantics.
        const t = state.push(`${cfg.type}_close`, cfg.tag, 0);
        t.markup = element.markup;
        return true;
      }

      const tag = element.name;
      const cfg = cfgByTag.get(tag);
      if (!cfg) return false;
      const attributes = parseHtmlAttributes(element.attributes)!;
      // The comment source analyzer owns raw opaque bytes and only inspects
      // their native metadata. It must not turn those bytes into a load lock.
      if (!(state.env as { butterNativeCommentSource?: boolean }).butterNativeCommentSource) {
        if (element.selfClosing || !hasOnlyQualifiedHtmlAttributes(element.attributes, cfg.attrs ?? [])) {
          return protectHtmlSource(state, silent, element.markup);
        }
        if (cfg.type === "html_comment" &&
          (attributes.length !== 1 || !/^\s*display\s*:\s*none\s*;?\s*$/i.test(attributes[0].value ?? ""))) {
          return protectHtmlSource(state, silent, element.markup);
        }
        if (cfg.type === "html_mark" && attributes.some(attribute =>
          !/^\s*background(?:-color)?\s*:\s*[^;]+;?\s*$/i.test(attribute.value ?? ""))) {
          return protectHtmlSource(state, silent, element.markup);
        }
      }

      // Verify a matching close exists somewhere ahead. We don't
      // require strict nesting on the verification scan (the close
      // rule enforces nesting via stack); we just need to know an
      // opener-without-closer becomes literal text rather than a
      // dangling open mark token.
      const afterOpen = element.end;
      const closer = `</${cfg.tag}`;
      // A supported HTML mark can cross a native Markdown delimiter's
      // recursive range. Only closer existence may inspect the enclosing
      // source; actual token consumption remains bounded by posMax.
      const nativeSource = (state as StateInline & {
        __butterNativeDelimiterSource?: { source: string; end: number };
      }).__butterNativeDelimiterSource;
      const tail = (nativeSource?.source ?? src).slice(afterOpen, nativeSource?.end ?? state.posMax).toLowerCase();
      if (tail.indexOf(closer) < 0) return false;

      state.pos = afterOpen;
      if (silent) return true;

      const stateAny = state as unknown as { __butterHtmlStack?: string[] };
      const stack = stateAny.__butterHtmlStack || [];
      stack.push(tag);
      stateAny.__butterHtmlStack = stack;

      // Parse attributes off the open tag.
      const tokenAttrs: [string, string][] = [];
      if (cfg.attrs && cfg.attrs.length) {
        for (const { name, value: rawValue } of attributes) {
          if (cfg.attrs.includes(name) && rawValue !== null) {
            // HTML attributes decode entities but do not treat backslashes
            // as Markdown escapes. Decode only the entity-shaped pieces.
            const value = rawValue.replace(
              /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/g,
              (entity) => state.md.utils.unescapeAll(entity),
            );
            tokenAttrs.push([name, value]);
          }
        }
      }

      // nesting=0 (not 1) so state.push doesn't push a fresh delimiter
      // stack - see the close branch above for the rationale.
      const t = state.push(`${cfg.type}_open`, cfg.tag, 0);
      t.markup = element.markup;
      if (tokenAttrs.length) t.attrs = tokenAttrs;
      return true;
    },
  );
  // Every qualified codec above gets first refusal. Stock text already stops
  // at '<'; this final lexical rule sees only remaining actual raw elements,
  // never text obtained by entity decoding, an escape or opaque code/comment.
  md.inline.ruler.after("html_inline", "html_source_safety", (state, silent) => {
    if ((state.env as { butterNativeCommentSource?: boolean }).butterNativeCommentSource) return false;
    const element = readHtmlElement(state.src, state.pos, state.posMax);
    return element ? protectHtmlSource(state, silent, element.markup) : false;
  });
}

// Re-export the tag config so the bridge + serializer can look up
// the tag name + attrs without duplicating the table.
export { HTML_INLINE_MARKS };
export type { HtmlMarkConfig };

// ══════════════════════════════════════════
// Convenience: install all plugins
// ══════════════════════════════════════════

export function installObsidianPlugins(md: MarkdownIt): void {
  nativeSingleLineSetextPlugin(md);
  referenceDefinitionPlugin(md);
  blockCommentPlugin(md);
  htmlBlockCommentPlugin(md);
  blockMathPlugin(md);
  footnoteDefPlugin(md);
  calloutPlugin(md);
  highlightPlugin(md);
  inlineMathPlugin(md);
  wikilinkPlugin(md);
  embedPlugin(md);
  tagPlugin(md);
  footnoteRefPlugin(md);
  inlineFootnotePlugin(md);
  inlineCommentPlugin(md);
  blockIdPlugin(md);
  htmlInlineTagsPlugin(md);
  nativeDelimiterPlugin(md);
  nativeHtmlCodeLinksPlugin(md);
  commentMarkdownNavigationPlugin(md);
  linkOccurrencePlugin(md);
  setSourceFootnoteGrammar(md);
  nativeLinkOwnershipPlugin(md);
}
