import type { Mark, MarkType, Node as PMNode } from "prosemirror-model";

const NAVIGATION_ATOMS = new Set([
  "wikilink", "obsidian_tag", "footnote_ref", "inline_footnote", "block_id", "comment_navigation",
]);

/** Native trailing block IDs are metadata; navigation atoms own one target. */
export function allowsInlineMark(node: PMNode, mark: Mark): boolean {
  return allowsInlineMarkType(node, mark.type);
}

export function allowsInlineMarkType(node: PMNode, markType: MarkType): boolean {
  if (node.type.name === "block_id" || node.type.name === "empty_link") return false;
  return markType.name !== "link" || !NAVIGATION_ATOMS.has(node.type.name);
}
