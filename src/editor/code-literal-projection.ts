import { Fragment, type Node as PMNode } from "prosemirror-model";
import { serialize } from "../core/bridge/serializer";
import { canEncodeButterFileUtf8 } from "../core/file-shell";
import { emptyLinkSource } from "../core/native-link-ownership";
import { SPECS } from "./inline-atom-specs";
import { commentNavigationSource } from "../core/comment-navigation";
import { commentMarkdownSource } from "../core/comment-markdown-navigation";
import { linkOccurrence, referenceImageDisplayText, unresolvedLinkDelimiters } from "../core/link-occurrence";

function nativeImageSource(node: PMNode): string {
  // The existing image writer owns Markdown destination/title escaping and
  // native dimension suffixes. Isolate it from surrounding mark/boundary
  // context; projection into code deliberately removes rich formatting.
  const schema = node.type.schema;
  const image = node.type.create(node.attrs);
  const paragraph = schema.nodes.paragraph.create(null, image);
  return serialize(schema.nodes.doc.create(null, paragraph)).replace(/\n+$/, "");
}

/** Code conversion is a declared literal projection, never schema cleanup.
 * Text bytes remain exact, line-break nodes become LF, and navigation/math
 * atoms become their native source spelling. Native reference metadata must
 * remain active, so a block-ID carrier cannot be literalized inside a fence. */
export function projectLiteralCodeContent(content: Fragment): Fragment | null {
  let value = "", schema: PMNode["type"]["schema"] | undefined, supported = true;
  const append = (node: PMNode): void => {
    schema ??= node.type.schema;
    if (!supported) return;
    if (node.isText) value += node.text!;
    else if (node.type.name === "hard_break" || node.type.name === "softbreak") value += "\n";
    else if (node.type.name === "block_id") supported = false;
    else if (node.type.name === "empty_link") value += emptyLinkSource(node.attrs);
    else if (node.type.name === "comment_navigation") {
      const source = commentMarkdownSource(node);
      if (source === null) supported = false; else value += source;
    }
    else if (node.type.name === "image") {
      const source = node.attrs.sourceSyntax === "reference" && node.attrs.resolved === false
        ? referenceImageDisplayText(node) : nativeImageSource(node);
      if (source === null) supported = false; else value += source;
    }
    else {
      const spec = SPECS[node.type.name];
      if (!node.isInline || !spec) supported = false;
      else value += commentNavigationSource(node) ?? spec.toSource(node);
    }
  };
  const children: PMNode[] = [];
  content.forEach(node => children.push(node));
  for (let index = 0; index < children.length; index++) {
    const owner = linkOccurrence(children[index]);
    const delimiters = owner ? unresolvedLinkDelimiters(owner) : null;
    if (!delimiters) { append(children[index]); continue; }
    // Missing definitions leave visible native reference delimiters around
    // the complete editable label. Those characters are content when code
    // deliberately removes rich formatting, including a styled label run.
    value += delimiters.prefix;
    do { append(children[index++]); } while (index < children.length && linkOccurrence(children[index])?.eq(owner!));
    index--;
    value += delimiters.suffix;
  }
  if (!supported || value.includes("\0") || !canEncodeButterFileUtf8(value)) return null;
  return value && schema ? Fragment.from(schema.text(value)) : Fragment.empty;
}
