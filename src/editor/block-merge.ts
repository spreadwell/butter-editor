import { Fragment, type Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import type { MessageKey } from "../i18n";

export interface MergeMenuItem {
  id: string;
  title: MessageKey;
  icon: string;
  /** Selection always has at least two nodes by the time this is asked. */
  appliesTo: (nodes: PMNode[]) => boolean;
  /** Mutate the document and focus. Multi-block selection is cleared by the menu. */
  run: (view: EditorView, nodes: { pos: number; node: PMNode }[]) => void;
}

function isInlineCarrier(node: PMNode): boolean {
  if (node.type.name === "paragraph" || node.type.name === "heading") return true;
  if (node.type.name === "list_item") {
    return node.firstChild?.type.name === "paragraph";
  }
  return false;
}

function inlineContentOf(node: PMNode): Fragment {
  if (node.type.name === "list_item") return node.firstChild!.content;
  return node.content;
}

function replaceSelectedBlocksWith(
  view: EditorView,
  nodes: { pos: number; node: PMNode }[],
  merged: PMNode,
): void {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const start = first.pos;
  const end = last.pos + last.node.nodeSize;
  const totalSize = nodes.reduce((sum, { node }) => sum + node.nodeSize, 0);
  const tr = view.state.tr;

  if (totalSize === end - start) {
    tr.replaceWith(start, end, merged);
  } else {
    for (let index = nodes.length - 1; index >= 0; index--) {
      const { pos, node } = nodes[index];
      tr.delete(pos, pos + node.nodeSize);
    }
    tr.insert(first.pos, merged);
  }
  view.dispatch(tr);
  view.focus();
}

function combineIntoParagraph(
  view: EditorView,
  nodes: { pos: number; node: PMNode }[],
): void {
  const softbreakType = view.state.schema.nodes.softbreak;
  if (!softbreakType) return;
  const parts: PMNode[] = [];
  nodes.forEach(({ node }, index) => {
    if (index > 0) parts.push(softbreakType.create());
    inlineContentOf(node).forEach((child) => parts.push(child));
  });
  replaceSelectedBlocksWith(
    view,
    nodes,
    view.state.schema.nodes.paragraph.create(null, Fragment.fromArray(parts)),
  );
}

function combineQuoteBlocks(
  view: EditorView,
  nodes: { pos: number; node: PMNode }[],
): void {
  const children: PMNode[] = [];
  for (const { node } of nodes) node.content.forEach((child) => children.push(child));
  replaceSelectedBlocksWith(
    view,
    nodes,
    view.state.schema.nodes.blockquote.create(null, Fragment.fromArray(children)),
  );
}

export const MERGE_MENU_ITEMS: MergeMenuItem[] = [
  {
    id: "combine-into-paragraph",
    title: "Combine into paragraph",
    icon: "merge",
    appliesTo: (nodes) => nodes.every(isInlineCarrier),
    run: combineIntoParagraph,
  },
  {
    id: "combine-quote-blocks",
    title: "Combine quote blocks",
    icon: "merge",
    appliesTo: (nodes) => nodes.every((node) => node.type.name === "blockquote"),
    run: combineQuoteBlocks,
  },
];
