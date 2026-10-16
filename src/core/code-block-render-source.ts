import { Fragment, type Node as PMNode } from "prosemirror-model";
import { serializer } from "./serializer";

/** Render a single exact code node with the same qualified source codec as
 * file saves. Renderer callers must not wrap opaque code in a fixed fence. */
export function codeBlockRenderSource(node: PMNode, content = node.textContent): string {
  if (node.type.name !== "code_block") throw new Error("Expected a code block");
  const schema = node.type.schema;
  const block = node.copy(content ? Fragment.from(schema.text(content)) : Fragment.empty);
  return serializer.serialize(schema.nodes.doc.create(null, block));
}
