import type MarkdownIt from "markdown-it";
import type { Node as PMNode } from "prosemirror-model";

/** A terminal source-owned comment owns its physical suffix, not file trivia. */
export function hasUnclosedHtmlCommentTail(node: PMNode): boolean {
  let tail = node;
  while (tail.lastChild) tail = tail.lastChild;
  return tail.type.name === "block_comment" && tail.attrs.nativeSyntax === "html-unclosed";
}

/** Raw HTML comment syntax is opaque: entities and Markdown remain payload. */
export function findHtmlCommentEnd(source: string, start: number, limit: number): number {
  if (!source.startsWith("<!--", start)) return -1;
  const close = source.indexOf("-->", start + 4);
  return close >= 0 && close + 3 <= limit ? close + 3 : -1;
}

/** Native-qualified hidden block codec for otherwise unrepresentable payload. */
export function hiddenBlockCommentSource(value: string): string {
  const payload = value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
  return `<div style="display:none">${payload}</div>`;
}

/** Preserve every opaque value; source artifacts are never stale UI debris. */
export function blockCommentSource(value: string, nativeSyntax = "html"): string {
  // Source-owned percent syntax preserves all native cache grammar, including
  // backlinks/embeds as well as the explicitly modeled hidden tag entries.
  if (nativeSyntax === "percent") return value === "list-break" ? "%%list-break%%" : `%%\n${value}\n%%`;
  // An authored unclosed HTML comment also hides later rendered source beyond
  // its Markdown container. Adding a closer would reveal that source.
  if (nativeSyntax === "html-unclosed" && !value.includes("-->")) return `<!--${value}`;
  if (value === "") return "<!---->";
  // New values and authored HTML are inert, including literal hashes. Native
  // percent comments would activate otherwise hidden tags in these payloads.
  return !value.includes("-->") && !value.includes("\r")
    ? `<!--${value}-->`
    : hiddenBlockCommentSource(value);
}

/** Source-owned HTML comment blocks and the exact exceptional hidden codec. */
export function htmlBlockCommentPlugin(md: MarkdownIt): void {
  md.block.ruler.before("fence", "html_block_comment", (state, startLine, endLine, silent) => {
    if (startLine >= endLine || state.sCount[startLine] - state.blkIndent >= 4) return false;
    const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    const hidden = /^<div style="display:none">([^<]*)<\/div>[ \t]*$/.exec(first);
    if (hidden) {
      if (silent) return true;
      const token = state.push("block_comment", "", 0);
      token.content = hidden[1].replace(
        /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/g,
        entity => state.md.utils.unescapeAll(entity),
      );
      token.markup = "<div>";
      token.block = true;
      token.map = [startLine, startLine + 1];
      state.line = startLine + 1;
      return true;
    }
    if (!first.startsWith("<!--")) return false;
    let lastLine = startLine;
    while (lastLine < endLine) {
      if (lastLine > startLine && state.sCount[lastLine] < state.blkIndent && !state.isEmpty(lastLine)) break;
      const line = state.src.slice(state.bMarks[lastLine] + state.tShift[lastLine], state.eMarks[lastLine]);
      if (line.includes("-->")) break;
      lastLine++;
    }
    const closed = lastLine < endLine && state.src.slice(state.bMarks[lastLine], state.eMarks[lastLine]).includes("-->");
    if (!closed) {
      if (silent) return true;
      // Native block HTML comments remain opaque through their container's
      // end even without a closing token. Preserve that entire inner value.
      const raw = state.getLines(startLine, lastLine, state.blkIndent, true);
      const token = state.push("block_comment", "", 0);
      token.content = raw.slice(raw.indexOf("<!--") + 4);
      token.markup = "<!--";
      token.meta = { nativeSyntax: "html-unclosed" };
      token.block = true;
      token.map = [startLine, lastLine];
      state.line = lastLine;
      return true;
    }
    const raw = state.getLines(startLine, lastLine + 1, state.blkIndent, false);
    const start = raw.indexOf("<!--"), end = findHtmlCommentEnd(raw, start, raw.length);
    if (end < 0) return false;
    if (!/^[ \t]*$/.test(raw.slice(end))) {
      if (silent) return true;
      // A block-start HTML comment with visible suffix is native raw HTML:
      // the suffix's caret/Markdown remain literal. Retain only this local
      // source artifact rather than reinterpreting it as an inline paragraph.
      const token = state.push("html_comment_raw", "", 0);
      token.content = raw;
      token.block = true;
      token.map = [startLine, lastLine + 1];
      state.line = lastLine + 1;
      return true;
    }
    if (silent) return true;
    const token = state.push("block_comment", "", 0);
    token.content = raw.slice(start + 4, end - 3);
    token.markup = "<!--";
    token.block = true;
    token.map = [startLine, lastLine + 1];
    state.line = lastLine + 1;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
}
