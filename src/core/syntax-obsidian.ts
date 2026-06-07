/**
 * markdown-it plugins for all Obsidian-specific syntax.
 * Each plugin registers inline or block rules that produce tokens
 * the ProseMirror parser can map to schema nodes/marks.
 */
import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type Token from "markdown-it/lib/token.mjs";

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
    if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
    // Not block math ($$)
    if (src.charCodeAt(start + 1) === 0x24) return false;

    let end = start + 1;
    while (end < state.posMax) {
      if (src.charCodeAt(end) === 0x24 /* $ */ && src.charCodeAt(end - 1) !== 0x5C /* \ */) break;
      end++;
    }
    if (end >= state.posMax) return false;
    if (end === start + 1) return false; // empty $$ → skip

    const content = src.slice(start + 1, end);
    if (!content.trim()) return false;

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
    token.meta = { target, alias };
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

  function tagRule(state: StateInline, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x23 /* # */) return false;

    // Skip when we're inside a markdown link label `[...](url)`.
    // The tag node has no link mark allowed in our schema, so a tag
    // mid-label causes the serializer to split the link into two
    // (`[before ](url)#tag[ after](url)`) on round-trip - the link
    // mark must close around the tag node and reopen after. Treating
    // `#topic` as plain text inside link labels keeps the link
    // structure intact at the cost of losing tag-atom navigability
    // for the rare "tag inside a link label" case. The user already
    // chose to write `#` inside an explicit link, so they're unlikely
    // to expect tag behavior there. markdown-it sets `linkLevel > 0`
    // while tokenizing link contents (post-`parseLinkLabel`).
    if ((state as { linkLevel?: number }).linkLevel && (state as { linkLevel?: number }).linkLevel! > 0) return false;

    // Must be preceded by whitespace or start of string
    if (start > 0) {
      const prev = src.charCodeAt(start - 1);
      if (prev !== 0x20 && prev !== 0x09 && prev !== 0x0A && prev !== 0x0D) return false;
    }

    // Scan tag characters: letters, digits, -, _, /
    let end = start + 1;
    let hasNonDigit = false;
    while (end < state.posMax) {
      const ch = src.charCodeAt(end);
      if ((ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) || ch === 0x5F || ch === 0x2D || ch === 0x2F) {
        hasNonDigit = true;
        end++;
      } else if (ch >= 0x30 && ch <= 0x39) {
        end++;
      } else {
        break;
      }
    }

    if (end === start + 1) return false; // just #
    if (!hasNonDigit) return false; // all digits

    // Advance pos before silent return (see highlight rule above).
    state.pos = end;
    if (silent) return true;

    const tag = src.slice(start + 1, end);
    const token = state.push("obsidian_tag", "", 0);
    token.content = tag;
    token.markup = "#";

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

    // Advance pos before silent return (see highlight rule above).
    state.pos = end + 2;
    if (silent) return true;

    // Emit as an open/close pair wrapping the inner text. This lets
    // prosemirror-markdown treat it as a mark with preserved content
    // (so %%…%% round-trips losslessly through parse → serialize).
    const openTok = state.push("obsidian_comment_open", "", 1);
    openTok.markup = "%%";
    const textTok = state.push("text", "", 0);
    textTok.content = content;
    const closeTok = state.push("obsidian_comment_close", "", -1);
    closeTok.markup = "%%";

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

    const lines: string[] = [];
    for (let i = startLine + 1; i < nextLine; i++) {
      lines.push(src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]));
    }

    const token = state.push("block_comment", "", 0);
    token.content = lines.join("\n");
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

    // Must be at end of line (possibly with trailing whitespace)
    const rest = src.slice(end, state.posMax).trim();
    if (rest) return false;

    // Advance pos before silent return (see highlight rule above).
    state.pos = end;
    if (silent) return true;

    const id = src.slice(start + 1, end);
    const token = state.push("block_id", "", 0);
    token.content = id;
    token.markup = "^";

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

    // Collect content: first line after ]: , plus continuation lines (indented by 4 spaces)
    const firstLineContent = src.slice(labelEnd + 2, maxPos).trim();
    const lines: string[] = [firstLineContent];

    let nextLine = startLine + 1;
    while (nextLine < endLine) {
      const ls = state.bMarks[nextLine];
      const le = state.eMarks[nextLine];
      const indent = state.tShift[nextLine];
      // Continuation lines must be indented by at least 4 spaces
      if (indent < 4) break;
      lines.push(src.slice(ls + 4, le));
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

      // Find the first inline token inside THIS blockquote's own
      // body — but bail if we encounter a nested `blockquote_open`
      // first. Without that bail, an outer `> > [!note]` shape would
      // match the inner `[!note]` against the OUTER blockquote and
      // silently consume the wrapping `>` layer (`top[N]: orig=
      // blockquote re=obsidian_callout` drift in the edit-sim
      // harness). The inner blockquote_open will get its own
      // iteration of the outer loop and convert correctly on its
      // own terms.
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
// Attribute support is per-tag: only `<font>` carries attrs (color,
// face, size). The other tags accept no attrs (any attrs in source
// are ignored on parse and lost on serialize - the user's expected
// behavior since these are styling-only tags).

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
  const tagAlternation = HTML_INLINE_MARKS.map((c) => c.tag).join("|");
  const openTagRegex = new RegExp(
    `^<(${tagAlternation})\\b([^>]*)>`,
    "i",
  );
  const closeTagRegex = new RegExp(`^</(${tagAlternation})\\s*>`, "i");
  const cfgByTag = new Map<string, HtmlMarkConfig>();
  for (const c of HTML_INLINE_MARKS) cfgByTag.set(c.tag.toLowerCase(), c);

  md.inline.ruler.before(
    "emphasis",
    "html_inline_marks",
    function rule(state: StateInline, silent: boolean): boolean {
      const src = state.src;
      const start = state.pos;
      if (src.charCodeAt(start) !== 0x3C /* < */) return false;

      // Try close tag first.
      const remaining = src.slice(start, state.posMax);
      const closeMatch = closeTagRegex.exec(remaining);
      if (closeMatch) {
        const tag = closeMatch[1].toLowerCase();
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
        state.pos = start + closeMatch[0].length;
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
        t.markup = closeMatch[0];
        return true;
      }

      // Try open tag.
      const openMatch = openTagRegex.exec(remaining);
      if (!openMatch) return false;
      const tag = openMatch[1].toLowerCase();
      const cfg = cfgByTag.get(tag);
      if (!cfg) return false;

      // Verify a matching close exists somewhere ahead. We don't
      // require strict nesting on the verification scan (the close
      // rule enforces nesting via stack); we just need to know an
      // opener-without-closer becomes literal text rather than a
      // dangling open mark token.
      const afterOpen = start + openMatch[0].length;
      const closer = `</${cfg.tag}`;
      const tail = src.slice(afterOpen, state.posMax).toLowerCase();
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
        const attrSrc = openMatch[2];
        for (const name of cfg.attrs) {
          const m = new RegExp(
            `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))`,
            "i",
          ).exec(attrSrc);
          if (m) tokenAttrs.push([name, m[1] ?? m[2] ?? m[3] ?? ""]);
        }
      }

      // nesting=0 (not 1) so state.push doesn't push a fresh delimiter
      // stack - see the close branch above for the rationale.
      const t = state.push(`${cfg.type}_open`, cfg.tag, 0);
      t.markup = openMatch[0];
      if (tokenAttrs.length) t.attrs = tokenAttrs;
      return true;
    },
  );
}

// Re-export the tag config so the bridge + serializer can look up
// the tag name + attrs without duplicating the table.
export { HTML_INLINE_MARKS };
export type { HtmlMarkConfig };

// ══════════════════════════════════════════
// Convenience: install all plugins
// ══════════════════════════════════════════

export function installObsidianPlugins(md: MarkdownIt): void {
  blockCommentPlugin(md);
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
}
