/**
 * extensions-examples.ts
 *
 * Two example syntax extensions that dogfood Butter's Extension API.
 * Registered at module init; importing this file BEFORE the schema
 * or bridge is accessed makes both extensions live in the editor.
 *
 * 1) Spoiler block (`::: spoiler\ncontent\n:::`).
 *    A block-level extension that accepts arbitrary block content
 *    inside and renders as a collapsible spoiler section. Uses
 *    markdown-it's block-level plugin system.
 *
 * 2) Mention inline (`@username`).
 *    An inline-atom extension that renders `@username` as a
 *    mention atom (styleable, linkable). Pattern-search hook
 *    provided so `@username` bytes survive neighbor edits via
 *    byte-level source preservation.
 *
 * These examples are registered by default so the main.ts import
 * order takes care of itself (if this file is imported before
 * schema.ts + obsidian-md-bridge.ts, extensions land in the
 * built schema; if imported after, the runtime late-apply path
 * still wires in the extension's markdown-it rule, handlers,
 * serializer, and source pattern - but new schema node types
 * aren't possible after the schema is constructed).
 *
 * Real extensions would live in their own file; these exist to
 * prove the API works end-to-end and to serve as templates.
 */
import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { registerSyntaxExtension } from "./extensions";

// Lazy-import escape hatch - these examples need to defer the
// `./schema` import to runtime to dodge a circular-init order
// problem (extensions are registered at module-init time, before
// the schema is constructed). esbuild handles this fine; the
// declaration just tells TypeScript that `require` is in scope
// without pulling in `@types/node` for the whole plugin.
declare const require: <T = unknown>(id: string) => T;
type SchemaModule = typeof import("../core/schema");

// ═══════════════════════════════════════════════════════════════
//  1) Spoiler block -  ::: spoiler [label]
//                      inner content
//                      :::
// ═══════════════════════════════════════════════════════════════

function spoilerBlockPlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    "fence",
    "butter_spoiler",
    function spoiler(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const line = state.src.slice(start, max);
      const openMatch = /^:::\s*spoiler(?:\s+(.*?))?\s*$/.exec(line);
      if (!openMatch) return false;
      if (silent) return true;

      const label = openMatch[1] || "";
      // Find matching close
      let nextLine = startLine + 1;
      let foundClose = false;
      while (nextLine < endLine) {
        const lStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const lMax = state.eMarks[nextLine];
        const lText = state.src.slice(lStart, lMax);
        if (/^:::\s*$/.test(lText)) {
          foundClose = true;
          break;
        }
        nextLine++;
      }
      if (!foundClose) return false;

      const oldParentType = state.parentType;
      // markdown-it's ParentType union doesn't list "spoiler", but
      // assigning a string sentinel here mirrors what custom blocks do
      // — only `state.parentType === "<our-type>"` checks compare it.
      (state as unknown as { parentType: string }).parentType = "spoiler";

      const openTok = state.push("butter_spoiler_open", "div", 1);
      openTok.markup = ":::";
      openTok.map = [startLine, nextLine + 1];
      openTok.info = label;

      state.md.block.tokenize(state, startLine + 1, nextLine);

      const closeTok = state.push("butter_spoiler_close", "div", -1);
      closeTok.markup = ":::";

      state.parentType = oldParentType;
      state.line = nextLine + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
}

registerSyntaxExtension({
  name: "butter_spoiler",
  nodeSpec: {
    group: "block",
    content: "block+",
    defining: true,
    attrs: { label: { default: "" } },
    parseDOM: [
      {
        tag: "div[data-butter-spoiler]",
        getAttrs(dom: HTMLElement) {
          return { label: dom.getAttribute("data-label") || "" };
        },
      },
    ],
    toDOM(node) {
      const label = (node.attrs as { label?: string }).label ?? "";
      return [
        "div",
        {
          "data-butter-spoiler": "",
          "data-label": label,
          class: "butter-spoiler",
        },
        0,
      ];
    },
  },
  markdownItRule: spoilerBlockPlugin,
  tokenHandlers: {
    butter_spoiler_open: (s, t) => {
      // Lazy import of schema to avoid circular-import at module init.
      const { schema } = require<SchemaModule>("../core/schema");
      s.push(schema.nodes.butter_spoiler, { label: t.info || "" });
    },
    butter_spoiler_close: (s) => s.pop(),
  },
  serializer: (state, node) => {
    const n = node as { attrs: { label?: string } };
    const label = n.attrs.label ? ` ${n.attrs.label}` : "";
    state.write(`:::spoiler${label}\n`);
    state.renderContent(node);
    state.write(":::");
    state.closeBlock(node);
  },
});

// ═══════════════════════════════════════════════════════════════
//  2) Mention inline atom -  @username
// ═══════════════════════════════════════════════════════════════

function mentionInlinePlugin(md: MarkdownIt): void {
  md.inline.ruler.before("text", "butter_mention", function mention(state: StateInline, silent: boolean) {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== 0x40 /* @ */) return false;
    // Don't trigger mid-word ("foo@bar" isn't a mention).
    if (start > 0) {
      const prev = src.charCodeAt(start - 1);
      // Previous char must be whitespace or start-of-line
      if (!(prev === 0x20 || prev === 0x0a || prev === 0x09)) return false;
    }
    // Capture [A-Za-z0-9_-]+
    let pos = start + 1;
    while (pos < state.posMax) {
      const c = src.charCodeAt(pos);
      const isAlphanum =
        (c >= 0x30 && c <= 0x39) || // 0-9
        (c >= 0x41 && c <= 0x5a) || // A-Z
        (c >= 0x61 && c <= 0x7a) || // a-z
        c === 0x5f || c === 0x2d;   // _ or -
      if (!isAlphanum) break;
      pos++;
    }
    if (pos === start + 1) return false; // empty username
    const username = src.slice(start + 1, pos);
    if (!silent) {
      const tok = state.push("butter_mention", "", 0);
      tok.content = username;
      tok.markup = `@${username}`;
    }
    state.pos = pos;
    return true;
  });
}

registerSyntaxExtension({
  name: "butter_mention",
  nodeSpec: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { username: { default: "" } },
    parseDOM: [
      {
        tag: "span[data-butter-mention]",
        getAttrs(dom: HTMLElement) {
          return { username: dom.getAttribute("data-username") || "" };
        },
      },
    ],
    toDOM(node) {
      const u = (node.attrs as { username?: unknown }).username;
      const username = typeof u === "string" ? u : "";
      return [
        "span",
        {
          "data-butter-mention": "",
          "data-username": username,
          class: "butter-mention",
        },
        `@${username}`,
      ];
    },
  },
  markdownItRule: mentionInlinePlugin,
  tokenHandlers: {
    butter_mention: (s, t) => {
      const { schema } = require<SchemaModule>("../core/schema");
      s.addNode(schema.nodes.butter_mention, { username: t.content });
    },
  },
  serializer: (state, node) => {
    const u = (node as { attrs: { username?: unknown } }).attrs.username;
    state.write(`@${typeof u === "string" ? u : ""}`);
  },
  sourcePattern: (node) => {
    const u = (node as { attrs: { username?: unknown } }).attrs.username;
    return `@${typeof u === "string" ? u : ""}`;
  },
});
