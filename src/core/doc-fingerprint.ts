/**
 * Exact semantic fingerprint for save validation and conformance gates.
 *
 * Markdown parse provenance and session-only block identities are excluded;
 * exact text, marks, and every source-serializable attribute are retained.
 * Callers normalize both documents before comparing documented Markdown
 * representational equivalences.
 */
import type { Node as PMNode } from "prosemirror-model";

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
    attrs[key] = stableSemanticValue(node.attrs[key]);
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
