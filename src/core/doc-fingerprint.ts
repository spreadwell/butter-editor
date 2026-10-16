/**
 * Exact semantic fingerprint for save validation and conformance gates.
 *
 * Markdown parse provenance and session-only block identities are excluded;
 * exact text, marks, and every source-serializable attribute are retained.
 * Exact saves normalize the intended document once; the reparse remains raw.
 */
import type { Node as PMNode } from "prosemirror-model";
import { commentNavigationSource } from "./comment-navigation";

const TRANSIENT_NODE_ATTRS = new Set(["sourceRange", "blockId"]);

function stableSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const stable: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      stable[key] = stableSemanticValue(object[key]);
    }
    return stable;
  }
  return value;
}

function semanticNode(node: PMNode): Record<string, unknown> {
  const result: Record<string, unknown> = { type: node.type.name };
  if (node.isText) result.text = node.text ?? "";

  const attrs: Record<string, unknown> = {};
  for (const key of Object.keys(node.attrs).sort()) {
    if (TRANSIENT_NODE_ATTRS.has(key)) continue;
    if (node.type.name === "raw_block" && key === "reason") continue;
    // A hidden navigation atom carries both exact opaque spelling and its
    // resolved target. Generated atoms imply the canonical spelling; an
    // authored empty alias remains a distinct opaque payload.
    attrs[key] = stableSemanticValue(key === "literalSource" &&
      node.marks.some(mark => mark.type.name === "comment")
      ? commentNavigationSource(node) : node.attrs[key]);
  }
  if (Object.keys(attrs).length > 0) result.attrs = attrs;

  if (node.marks.length > 0) {
    result.marks = node.marks
      .map((mark) => ({
        type: mark.type.name,
        attrs: stableSemanticValue(mark.attrs),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (node.childCount > 0) {
    const content: Record<string, unknown>[] = [];
    for (let index = 0; index < node.childCount; index++) {
      content.push(semanticNode(node.child(index)));
    }
    result.content = content;
  }
  return result;
}

export function docSemanticFingerprint(doc: PMNode): string {
  return JSON.stringify(semanticNode(doc));
}

/** Exact Markdown-semantic identity for one node, excluding runtime metadata. */
export function nodeSemanticFingerprint(node: PMNode): string {
  return JSON.stringify(semanticNode(node));
}

export interface SemanticDifference {
  readonly path: string;
  readonly kind: "node-type" | "text" | "marks" | "attribute" | "children";
}

/** Locate a mismatch without retaining or logging either document's content. */
export function semanticDifference(expected: string, actual: string): SemanticDifference | null {
  type SemanticNode = {
    type?: string;
    text?: string;
    marks?: unknown;
    attrs?: Record<string, unknown>;
    content?: SemanticNode[];
  };
  const walk = (left: SemanticNode, right: SemanticNode, path: string): SemanticDifference | null => {
    if (left.type !== right.type) return { path: `${path}.type`, kind: "node-type" };
    if (left.text !== right.text) return { path: `${path}.text`, kind: "text" };
    if (JSON.stringify(left.marks) !== JSON.stringify(right.marks)) {
      return { path: `${path}.marks`, kind: "marks" };
    }
    if (JSON.stringify(left.attrs) !== JSON.stringify(right.attrs)) {
      // Attribute values and arbitrary nested keys can contain private note
      // content. The node path is enough to identify the failed contract.
      return { path: `${path}.attrs`, kind: "attribute" };
    }
    const leftChildren = left.content ?? [];
    const rightChildren = right.content ?? [];
    if (leftChildren.length !== rightChildren.length) {
      return { path: `${path}.content`, kind: "children" };
    }
    for (let index = 0; index < leftChildren.length; index++) {
      const difference = walk(leftChildren[index], rightChildren[index], `${path}.content[${index}]`);
      if (difference) return difference;
    }
    return null;
  };
  try {
    return walk(JSON.parse(expected) as SemanticNode, JSON.parse(actual) as SemanticNode, "doc");
  } catch {
    return null;
  }
}
