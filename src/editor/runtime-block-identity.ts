import { Fragment, type Node as PMNode } from "prosemirror-model";
import { nodeSemanticFingerprint } from "../core/doc-fingerprint";

function blockId(node: PMNode): string | null {
  const value = (node.attrs as { blockId?: unknown }).blockId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function acceptsBlockId(node: PMNode): boolean {
  return Object.prototype.hasOwnProperty.call(node.type.spec.attrs ?? {}, "blockId");
}

/**
 * Copy session-only block identities through a semantically unchanged tree.
 * Source provenance always comes from `next`; only the non-serialized ID is
 * retained. The function is called only for exact semantic prefix/suffix
 * matches, so nested children align one-to-one without heuristic matching.
 */
function retainTreeBlockIds(previous: PMNode, next: PMNode): PMNode {
  if (previous.type !== next.type || previous.childCount !== next.childCount) {
    return next;
  }

  let attrs = next.attrs;
  let changed = false;
  const previousId = blockId(previous);
  if (previousId && acceptsBlockId(next) && blockId(next) !== previousId) {
    attrs = { ...next.attrs, blockId: previousId };
    changed = true;
  }

  const children: PMNode[] = [];
  for (let index = 0; index < next.childCount; index++) {
    const child = retainTreeBlockIds(previous.child(index), next.child(index));
    children.push(child);
    if (child !== next.child(index)) changed = true;
  }
  return changed
    ? next.type.create(attrs, Fragment.fromArray(children), next.marks)
    : next;
}

/**
 * Preserve runtime IDs for the exact semantic prefix and suffix of an incoming
 * source generation. The changed middle remains unclaimed and receives fresh
 * IDs at the editor boundary. Prefix/suffix matching is deterministic O(n),
 * including documents with duplicate paragraphs.
 */
export function retainUnchangedBlockIds(
  previousDoc: PMNode,
  nextDoc: PMNode,
): PMNode {
  const previous = Array.from(
    { length: previousDoc.childCount },
    (_, index) => previousDoc.child(index),
  );
  const next = Array.from(
    { length: nextDoc.childCount },
    (_, index) => nextDoc.child(index),
  );
  const previousFingerprints = previous.map(nodeSemanticFingerprint);
  const nextFingerprints = next.map(nodeSemanticFingerprint);

  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previousFingerprints[prefix] === nextFingerprints[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previousFingerprints[previous.length - 1 - suffix] ===
      nextFingerprints[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix === 0 && suffix === 0) return nextDoc;
  const children = [...next];
  for (let index = 0; index < prefix; index++) {
    children[index] = retainTreeBlockIds(previous[index], next[index]);
  }
  for (let offset = 0; offset < suffix; offset++) {
    const previousIndex = previous.length - 1 - offset;
    const nextIndex = next.length - 1 - offset;
    children[nextIndex] = retainTreeBlockIds(
      previous[previousIndex],
      next[nextIndex],
    );
  }
  return nextDoc.type.create(nextDoc.attrs, Fragment.fromArray(children), nextDoc.marks);
}
