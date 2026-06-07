/**
 * Markdown -> ProseMirror parser.
 *
 * PMX edition: delegates to obsidian-md-bridge (custom bridge,
 * no prosemirror-markdown dependency).
 */
export { parser, type SourceMapResult } from "./obsidian-md-bridge";
