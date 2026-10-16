import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import type { AtomSpec } from "./inline-atom-specs";
import { prepareImageSourceEdit } from "../core/link-occurrence";

export type AtomFieldEditResult =
  | { status: "unchanged" }
  | { status: "invalid" }
  | { status: "changed"; node: PMNode };

/** Compare with the values read back from the actual initialized controls.
 * Browsers remove CR/LF from inputs and normalize CR in textareas. An
 * untouched form must retain the original node, including opaque payload
 * bytes, marks, and source metadata, rather than commit that projection. */
export function prepareAtomFieldEdit(
  spec: AtomSpec,
  original: PMNode,
  live: PMNode | null,
  values: Readonly<Record<string, string>>,
  initialControlValues: Readonly<Record<string, string>>,
  context: { doc: PMNode; pos: number; validate: (candidate: PMNode) => boolean },
): AtomFieldEditResult {
  if (!live || live.type.name !== spec.typeName || !live.eq(original)) {
    return { status: "invalid" };
  }
  if (Object.keys(initialControlValues).every(
    (key) => (values[key] ?? "") === initialControlValues[key],
  )) return { status: "unchanged" };
  const next = spec.fromFields?.({ ...values }, live);
  if (!next) return { status: "invalid" };
  const prepared = next.type.name === "image"
    ? next.type.create(prepareImageSourceEdit(live, next.attrs), next.content, next.marks) : next;
  const marked = prepared.mark(live.marks);
  // Opaque LF payloads can be valid in a paragraph and invalid in a
  // table/list. The owning view certifies the actual replacement with its
  // current production save policy before any transaction is dispatched.
  const candidate = context.doc.replace(context.pos, context.pos + live.nodeSize,
    new Slice(Fragment.from(marked), 0, 0));
  if (!context.validate(candidate)) return { status: "invalid" };
  return { status: "changed", node: marked };
}
