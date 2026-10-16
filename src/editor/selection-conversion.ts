import { Fragment, type Node as PMNode } from "prosemirror-model";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { createHeadingWithExactInline } from "./textblock-command";

export type SelectionTarget = "paragraph" | "blockquote" | "obsidian_callout"
  | "bullet_list" | "ordered_list" | "task_list" | `h${number}`;

export function selectionTarget(id: string): SelectionTarget | null {
  if (["paragraph", "blockquote", "obsidian_callout", "bullet_list", "ordered_list", "task_list"].includes(id)
    || /^h[1-6]$/.test(id)) return id as SelectionTarget;
  return null;
}

export function hasTextSelection(state: EditorState): boolean {
  return state.selection instanceof TextSelection && !state.selection.empty;
}

const containers = new Set(["doc", "blockquote", "obsidian_callout"]);
const textblocks = new Set(["paragraph", "heading"]);
const isBreak = (node: PMNode | null): boolean =>
  node?.type.name === "hard_break" || node?.type.name === "softbreak";

/** Cut only supported structures. Special blocks are never flattened implicitly. */
function clip(node: PMNode, pos: number, from: number, to: number): PMNode | null {
  if (to <= pos || from >= pos + node.nodeSize) return null;
  if (!textblocks.has(node.type.name) && !containers.has(node.type.name)
    && node.type.name !== "list_item") throw new RangeError("Unsupported selection structure");
  if (from <= pos && to >= pos + node.nodeSize) {
    node.descendants((child) => {
      if (child.isBlock && !textblocks.has(child.type.name) && !containers.has(child.type.name)
        && child.type.name !== "list_item") throw new RangeError("Unsupported selection structure");
    });
    return node;
  }
  // A callout's title is stored on its container, outside the text range.
  // Splitting that container would duplicate the title on both sides.
  if (node.type.name === "obsidian_callout") throw new RangeError("Partial callout boundary");
  let content: Fragment;
  if (node.inlineContent) {
    let start = Math.max(0, from - pos - 1);
    let end = Math.min(node.content.size, to - pos - 1);
    if (start >= end) return null;
    // A line separator at the cut becomes the new block boundary.
    if (start > 0 && isBreak(node.nodeAt(start))) start++;
    if (end < node.content.size && isBreak(node.nodeAt(end - 1))) end--;
    content = node.content.cut(start, Math.max(start, end));
    if (!content.size) return null;
  } else {
    const children: PMNode[] = [];
    node.forEach((child, offset) => {
      const part = clip(child, pos + 1 + offset, from, to);
      if (part) children.push(part);
    });
    if (!children.length) return null;
    content = Fragment.fromArray(children);
  }
  const result = node.type.create({ ...node.attrs, sourceRange: null }, content, node.marks);
  if (!node.type.validContent(content)) throw new RangeError("Unsupported partial container");
  return result;
}

/** Convert one explicit text range in a single undoable transaction. */
export function convertTextSelection(target: SelectionTarget, calloutType = "note"): Command {
  return (state, dispatch) => {
    if (!hasTextSelection(state)) return false;
    const { from, to, $from, $to, anchor, head } = state.selection;
    let depth = $from.sharedDepth(to);
    while (depth > 0 && !containers.has($from.node(depth).type.name)) depth--;
    const parent = $from.node(depth);
    // Do not escape a table, code block, or other unsupported ancestor.
    for (const resolved of [$from, $to]) {
      for (let d = depth + 1; d <= resolved.depth; d++) {
        const name = resolved.node(d).type.name;
        if (!textblocks.has(name) && !containers.has(name) && name !== "list_item") return false;
      }
    }
    const start = $from.start(depth);
    const before: PMNode[] = [], selected: PMNode[] = [], after: PMNode[] = [];
    let replaceFrom = -1, replaceTo = -1;
    try {
      parent.forEach((node, offset) => {
        const pos = start + offset;
        if (pos + node.nodeSize <= from || pos >= to) return;
        const middle = clip(node, pos, from, to);
        if (!middle) return;
        if (replaceFrom < 0) replaceFrom = pos;
        replaceTo = pos + node.nodeSize;
        const left = clip(node, pos, pos, from);
        const right = clip(node, pos, to, pos + node.nodeSize);
        if (left) before.push(left);
        selected.push(middle);
        if (right) after.push(right);
      });
      if (!selected.length) return false;
      const wrapping = target === "blockquote" || target === "obsidian_callout";
      const list = target.endsWith("_list");
      const kind = target === "ordered_list" ? "ordered" : target === "task_list" ? "task" : "bullet";
      const convert = (node: PMNode): PMNode[] => {
        if (node.type.name === "list_item") {
          if (Number(node.attrs.depth) !== 0 || node.childCount !== 1) {
            throw new RangeError("List hierarchy requires block conversion");
          }
          return convert(node.firstChild!);
        }
        if (containers.has(node.type.name)) {
          const children: PMNode[] = [];
          node.forEach((child) => children.push(...convert(child)));
          return [node.type.create({ ...node.attrs, sourceRange: null }, children)];
        }
        if (!textblocks.has(node.type.name)) throw new RangeError("Unsupported conversion");
        if (list) {
          const lines: Fragment[] = [];
          let lineStart = 0;
          node.forEach((child, offset) => {
            if (isBreak(child)) {
              lines.push(node.content.cut(lineStart, offset));
              lineStart = offset + child.nodeSize;
            }
          });
          lines.push(node.content.cut(lineStart));
          return lines.map((line) => state.schema.nodes.list_item.create(
            { kind, depth: 0, checked: kind === "task" ? false : null },
            state.schema.nodes.paragraph.create(null, line),
          ));
        }
        const type = target === "paragraph" ? state.schema.nodes.paragraph : state.schema.nodes.heading;
        return [target === "paragraph" ? type.create(null, node.content)
          : createHeadingWithExactInline(type, { level: Number(target.slice(1)) }, node.content)];
      };
      // Partial flat-list runs cannot acquire an orphaned indentation level.
      const next = state.doc.nodeAt(replaceTo);
      if (next?.type.name === "list_item" && Number(next.attrs.depth) > 0) return false;
      if (selected[0].type.name === "list_item" && Number(selected[0].attrs.depth) > 0) return false;
      const converted: PMNode[] = [];
      if (wrapping) {
        converted.push(state.schema.nodes[target].create(
          target === "obsidian_callout" ? { calloutType } : null,
          selected,
        ));
      } else {
        for (const node of selected) {
          for (const convertedNode of convert(node)) {
            converted.push(convertedNode);
          }
        }
      }
      const replacement = Fragment.fromArray([...before, ...converted, ...after]);
      const tr = state.tr.replaceWith(replaceFrom, replaceTo, replacement);
      for (const node of [...before, ...converted, ...after]) node.check();
      const convertedFrom = replaceFrom + Fragment.fromArray(before).size;
      const convertedTo = convertedFrom + Fragment.fromArray(converted).size;
      const first = TextSelection.near(tr.doc.resolve(convertedFrom), 1).from;
      const last = TextSelection.near(tr.doc.resolve(convertedTo), -1).to;
      tr.setSelection(TextSelection.create(tr.doc, anchor <= head ? first : last, anchor <= head ? last : first));
      if (dispatch) dispatch(closeHistory(tr).scrollIntoView());
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  };
}
