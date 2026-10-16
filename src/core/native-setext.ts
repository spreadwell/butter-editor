import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

type BlockRule = (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean;

/** Obsidian recognizes a Setext underline only immediately after one source
 * line. Retain the stock marker/container grammar, but never let its paragraph
 * scan promote multiple lines (including opaque math/footnote payloads). */
export function nativeSingleLineSetextPlugin(md: MarkdownIt): void {
  const ruler = md.block.ruler as unknown as {
    __rules__: Array<{ name: string; fn: BlockRule }>;
  };
  const original = ruler.__rules__.find(rule => rule.name === "lheading")?.fn;
  if (!original) throw new Error("Markdown-it Setext rule unavailable");
  md.block.ruler.at("lheading", (state, startLine, endLine, silent) =>
    original(state, startLine, Math.min(endLine, startLine + 2), silent));
}
