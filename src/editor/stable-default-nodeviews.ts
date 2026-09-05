import {
  DOMSerializer,
  type Attrs,
  type DOMOutputSpec,
  type Node as PMNode,
  type Schema,
} from "prosemirror-model";
import type { NodeView, NodeViewConstructor } from "prosemirror-view";

/**
 * Parse provenance and drag identity do not affect a node's rendered DOM.
 * ProseMirror normally includes every node attr in `sameMarkup`, so a source
 * reload that merely shifts these values would otherwise rebuild unchanged
 * block wrappers. These default-equivalent NodeViews let ProseMirror update
 * the existing wrapper while it continues to own child reconciliation.
 */
const NON_RENDERED_ATTRS = new Set(["sourceRange", "blockId"]);

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(rightObject, key) &&
      valuesEqual(leftObject[key], rightObject[key]));
}

export function hasSameRenderedNodeMarkup(
  previous: PMNode,
  next: PMNode,
): boolean {
  if (previous.type !== next.type || previous.marks.length !== next.marks.length) {
    return false;
  }
  for (let index = 0; index < previous.marks.length; index++) {
    if (!previous.marks[index].eq(next.marks[index])) return false;
  }

  const keys = new Set([
    ...Object.keys(previous.attrs),
    ...Object.keys(next.attrs),
  ]);
  for (const key of keys) {
    if (NON_RENDERED_ATTRS.has(key)) continue;
    if (!valuesEqual(previous.attrs[key], next.attrs[key])) return false;
  }
  return true;
}

type RenderSpec = (
  document: Document,
  structure: DOMOutputSpec,
  xmlNamespace: string | null,
  blockArraysIn: Attrs,
) => { dom: Node; contentDOM?: HTMLElement };

/** Build default DOM for every schema node while stabilizing metadata-only updates. */
export function stableDefaultNodeViews(
  schema: Schema,
): Record<string, NodeViewConstructor> {
  const views: Record<string, NodeViewConstructor> = {};
  const renderSpec = DOMSerializer.renderSpec.bind(DOMSerializer) as unknown as RenderSpec;

  for (const [name, type] of Object.entries(schema.nodes)) {
    if (name === "doc" || name === "text" || !type.spec.toDOM) continue;
    views[name] = (initialNode, view): NodeView => {
      const rendered = renderSpec(
        view.dom.ownerDocument,
        type.spec.toDOM!(initialNode),
        null,
        initialNode.attrs,
      );
      let currentNode = initialNode;
      return {
        dom: rendered.dom as HTMLElement,
        contentDOM: rendered.contentDOM,
        update(nextNode) {
          if (!hasSameRenderedNodeMarkup(currentNode, nextNode)) return false;
          currentNode = nextNode;
          return true;
        },
      };
    };
  }
  return views;
}
