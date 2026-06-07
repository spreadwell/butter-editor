/**
 * Cleanup pass for parsed-paste docs. Pure PM-side helpers, no
 * obsidian dep - extracted so the paste tests can import them
 * directly without bundling the obsidian module.
 */
import { Fragment, type Node as PMNode } from "prosemirror-model";

/**
 * Matches text content that consists ONLY of HTML-tag-shaped strings
 * (open / close / self-closing) plus optional whitespace.
 *
 * Used to detect orphan-tag text that arrives as literal characters
 * in the parsed PM doc. Origin: some clipboard sources, when a
 * selection includes unclosed HTML tags, encode the unclosed portion
 * as escaped entities (`&lt;strong&gt;` etc.). The browser decodes
 * the entities into real `<` and `>` text. After our htmlToMarkdown
 * walk and markdown-it parse, these end up as plain text in PM with
 * NO marks attached (they're text, not actual mark structure).
 *
 * Conservative: ONLY matches text whose entire content is tag-shaped.
 * A text node with any real prose stays untouched.
 */
const ORPHAN_TAG_RE =
  /^\s*(?:<\/?(?:strong|em|font|u|sup|sub|kbd|mark|del|s|b|i|br|p|div|span)(?:\s[^<>]*)?\/?>\s*)+\s*$/i;

/**
 * Strip text nodes that consist only of orphan-HTML-tag text and
 * carry no marks. Operates on the parsed PM doc (after markdown-it
 * has merged adjacent text fragments into single text nodes), so
 * `<strong><font color="#548dd4">` arrives as one text node
 * regardless of how the upstream DOM was split.
 *
 * Marks-empty check: a text node carrying the `code` mark legitimately
 * may contain literal tag-shaped text (documentation about HTML).
 * We only strip unmarked text - anything with marks is preserved.
 *
 * Also strips a trailing softbreak that becomes orphaned by removing
 * its only-following text sibling.
 */
export function stripOrphanTagText(doc: PMNode): PMNode {
  return rebuild(doc);
}

function rebuild(node: PMNode): PMNode {
  if (node.isText) return node;
  // Recurse into children, building a new content array with orphan
  // text nodes filtered out.
  const filtered: PMNode[] = [];
  node.forEach((child) => {
    if (child.isText && child.marks.length === 0 && ORPHAN_TAG_RE.test(child.text ?? "")) {
      return; // strip
    }
    const next = rebuild(child);
    filtered.push(next);
  });
  // After stripping, drop a trailing softbreak that has nothing useful
  // following it - it'd serialize as a stray "\n" at end of paragraph.
  while (
    filtered.length > 0 &&
    filtered[filtered.length - 1].type.name === "softbreak"
  ) {
    filtered.pop();
  }
  // Also drop a leading softbreak (happens if orphan text was first child).
  while (filtered.length > 0 && filtered[0].type.name === "softbreak") {
    filtered.shift();
  }
  if (filtered.length === node.childCount && filtered.every((c, i) => c === node.child(i))) {
    return node;
  }
  return node.type.create(node.attrs, Fragment.fromArray(filtered), node.marks);
}

/**
 * Drop empty / whitespace-only top-level textblocks.
 *
 * After stripOrphanTagText fires, paragraphs that contained ONLY
 * orphan-tag text become empty. This pass removes those paragraphs.
 * Block-level atoms (hr, image, embed, math_block, callout, code_block)
 * are left alone since they legitimately have empty / no textContent
 * but do represent real content the user pasted.
 */
export function dropEmptyTextblocks(doc: PMNode): PMNode {
  const kept: PMNode[] = [];
  doc.forEach((child) => {
    if (child.isTextblock && child.textContent.trim().length === 0) {
      return;
    }
    kept.push(child);
  });
  if (kept.length === doc.childCount) return doc;
  return doc.type.create(doc.attrs, Fragment.fromArray(kept), doc.marks);
}
