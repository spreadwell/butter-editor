/**
 * obsidian-md-bridge.ts
 *
 * Purpose-built ProseMirror ↔ markdown-it bridge for Obsidian.
 * Replaces prosemirror-markdown with a single module that owns:
 *
 *   - Parser: markdown-it tokens → PM tree, with source ranges
 *     attached to every block + inline-atom node during the walk.
 *   - Serializer: PM tree → markdown, canonical synthesis for all
 *     schema constructs without bracket/escape workarounds.
 *   - Source preservation: serializeWithSourcePreservation splices
 *     original bytes for unedited nodes (reference identity against
 *     the parse-time doc) and synthesizes only the rest.
 *   - Error recovery: parse failures + byte-coverage gaps fall
 *     through to a whole-file raw_block so bytes are never lost.
 *   - Incremental parse: in-block edits reparse only the affected
 *     block, preserving sibling references.
 *   - Extension wiring: reads the registry in ./extensions via a
 *     late-apply hook that lands runtime additions in the live
 *     handler tables.
 *
 * See EXTENSIONS.md + the invariant / benchmark / preservation
 * tests under ../ for end-to-end coverage.
 */

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

/** Token.meta is typed `any` in markdown-it. We attach our own
 *  Obsidian-syntax data to it via the syntax plugins, so the read
 *  side narrows through this helper. */
function metaStr(t: Token, key: string): string {
  const m = t.meta as Record<string, unknown> | null | undefined;
  const v = m ? m[key] : undefined;
  return typeof v === "string" ? v : "";
}


import { installObsidianPlugins } from "../syntax-obsidian";



// ═══════════════════════════════════════════════
//  Shared markdown-it instance
// ═══════════════════════════════════════════════

const md = new MarkdownIt("commonmark", { html: false })
  .enable("strikethrough")
  .enable("table");
installObsidianPlugins(md);
export const __mdit = md;
export { metaStr };
// Extension markdown-it rules are applied via the late-apply hook
// below (both for pre-registered extensions at bridge-init AND for
// any extensions registered at runtime after the bridge loads).

//
// User-configurable serializer marker choices. All optional; falsy
// fields fall back to the canonical defaults below. Applied at
// emit time inside SerState - mark specs stay constant; renderers
// override per-state when an option is provided.

export interface CanonicalFormOptions {
  /** Bullet marker for unordered lists. Default: `-`. */
  bullet?: "-" | "*" | "+";
  /** Italic (em) marker. Default: `*`. */
  italic?: "*" | "_";
  /** Bold (strong) marker. Default: `**`. */
  bold?: "**" | "__";
  /** Code-block fence character. Default: triple backtick. */
  codeFence?: "```" | "~~~";
  /** Horizontal rule string. Default: `---`. */
  horizontalRule?: "---" | "***" | "___";
}

export const CANONICAL_DEFAULTS: Required<CanonicalFormOptions> = {
  bullet: "-",
  italic: "*",
  bold: "**",
  codeFence: "```",
  horizontalRule: "---",
};