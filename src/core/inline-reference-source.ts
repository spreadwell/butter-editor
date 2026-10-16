import { __mdit, metaStr } from "./bridge/common";

/** Read metadata from an explicitly raw native inline source field (a callout
 * title). Never inspect decoded/plain editor text for a new reference. */
export function nativeInlineSourceReference(source: string): string | null {
  if (!source || /[\r\n]/.test(source)) return null;
  let id: string | null = null;
  for (const inline of __mdit.parseInline(source, {})) {
    for (const token of inline.children ?? []) {
      if (token.type === "block_id") id = token.content;
      else if (token.type === "obsidian_comment_close") {
        const hidden = metaStr(token, "nativeBlockId");
        if (hidden) id = hidden;
      }
    }
  }
  return id;
}
