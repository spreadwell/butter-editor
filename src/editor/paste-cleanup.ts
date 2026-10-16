/**
 * Cleanup pass for parsed-paste docs. Pure PM-side helpers, no
 * obsidian dep - extracted so the paste tests can import them
 * directly without bundling the obsidian module.
 */
import { Fragment, type Node as PMNode } from "prosemirror-model";

/**
 * Drop empty / whitespace-only top-level paragraphs.
 *
 * Inline atoms inside a paragraph (images, embeds, math, footnote refs) are
 * meaningful even though `textContent` is empty. Structural textblocks such
 * as an empty fenced code block or heading are also authored content, so only
 * an actually empty paragraph is eligible for removal.
 */
export function dropEmptyTextblocks(doc: PMNode): PMNode {
  const kept: PMNode[] = [];
  doc.forEach((child) => {
    if (child.type.name === "paragraph") {
      let meaningful = false;
      child.forEach((inline) => {
        if (!inline.isText || inline.textContent.trim().length > 0) {
          meaningful = true;
        }
      });
      if (!meaningful) return;
    }
    kept.push(child);
  });
  if (kept.length === doc.childCount) return doc;
  return doc.type.create(doc.attrs, Fragment.fromArray(kept), doc.marks);
}
