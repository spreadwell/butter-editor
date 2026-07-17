/**
 * ProseMirror doc -> Markdown serializer.
 *
 * Butter edition: delegates to obsidian-md-bridge (custom bridge,
 * no prosemirror-markdown dependency).
 */
export { serializer, type CanonicalFormOptions } from "./obsidian-md-bridge";
