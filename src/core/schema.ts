import { Schema, NodeSpec, MarkSpec, Attrs } from "prosemirror-model";
import {
  tableNodes,
} from "prosemirror-tables";
import { getExtensionNodeSpecs } from "../integration/extensions";
import { sanitizeHref } from "../util/safe-url";

/** PM's `Attrs` is `Record<string, any>` — every node-spec toDOM
 *  reads `node.attrs.X` and trips no-unsafe-assignment. This narrows
 *  the read to a typed view: caller asserts the schema-declared
 *  attr shape; eslint sees `unknown` (safer) at the call site. */
function attrs<T>(a: Attrs): T {
  return a as unknown as T;
}

// Table-cell alignment is a styling-only attribute; the parser pulls
// strings from arbitrary inline HTML (e.g. `<td style="text-align:
// expression(...)">` in a hostile clipboard paste). Constrain to the
// three values markdown tables actually support.
const ALLOWED_TABLE_ALIGN = new Set(["left", "center", "right"]);

// ── Node specs ──

const basicNodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },

  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM() { return ["p", 0]; },
  },

  heading: {
    attrs: { level: { default: 1 } },
    content: "inline*",
    group: "block",
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({
      tag: `h${level}`,
      attrs: { level },
    })),
    toDOM(node) {
      const raw = Number(node.attrs.level);
      const level = Number.isFinite(raw) ? Math.max(1, Math.min(6, Math.trunc(raw))) : 1;
      return [`h${level}`, 0];
    },
  },

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM() { return ["blockquote", 0]; },
  },

  // ── Flat list-item model ──
  //
  // Inspired by Notion / Linear: each list item IS a top-level block,
  // not nested inside a `bullet_list` / `ordered_list` container. The
  // visual list is emergent - a contiguous run of `list_item` nodes
  // with the same `kind` and `depth` reads as one list. Mixed-kind
  // sequences (bullet → numbered → task) work natively without
  // breaking the list, and individual items become first-class drag
  // targets via the existing block drag-handles infrastructure.
  //
  // Attrs:
  //   `kind`     - "bullet" / "ordered" / "task". Drives the marker
  //                glyph, parsing of `- ` vs `1. ` vs `- [ ] `, and
  //                checkbox rendering.
  //   `depth`    - 0 = top-level, +1 per indent. Indentation is a
  //                visual property (padding-left), not structural
  //                nesting.
  //   `tight`    - true if the item belongs to a tight list (no blank
  //                lines between items). Drives serializer output.
  //   `checked`  - null/true/false. Only meaningful when kind="task";
  //                ignored otherwise.
  //   `start`    - explicit starting number for a contiguous run of
  //                `kind="ordered"` items at this depth. Only the
  //                FIRST item of the run uses it; subsequent items
  //                count from there. null = default 1.
  //
  // Content: `paragraph non_list_block*`. The leading paragraph is the
  // visible item text. Optional non-list blocks after it support loose
  // items with multi-paragraph / nested-callout / nested-code content.
  // The `non_list_block` group (added by post-processing below) is
  // every block-group node EXCEPT list_item - preventing direct
  // structural nesting of list_items, which is the whole point of the
  // flat model (nesting is depth, not parentage).
  list_item: {
    attrs: {
      kind: { default: "bullet" as "bullet" | "ordered" | "task" },
      depth: { default: 0 as number },
      tight: { default: true },
      checked: { default: null as null | boolean },
      start: { default: null as null | number },
    },
    content: "paragraph non_list_block*",
    group: "block",
    defining: true,
    parseDOM: [{
      tag: "div[data-butter-list-item]",
      getAttrs(dom: HTMLElement) {
        const taskState = dom.getAttribute("data-task-state");
        const startAttr = dom.getAttribute("data-start");
        return {
          kind:
            (dom.getAttribute("data-kind") as "bullet" | "ordered" | "task") ||
            "bullet",
          depth: parseInt(dom.getAttribute("data-depth") || "0", 10),
          tight: dom.getAttribute("data-tight") === "true",
          checked:
            taskState === "checked"
              ? true
              : taskState === "unchecked"
                ? false
                : null,
          start: startAttr != null ? parseInt(startAttr, 10) : null,
        };
      },
    }],
    toDOM(node) {
      const a = node.attrs as {
        kind?: string;
        depth?: number;
        tight?: boolean;
        checked?: boolean | null;
        start?: number | null;
      };
      const attrs: Record<string, unknown> = {
        "data-butter-list-item": "",
        "data-kind": a.kind,
        "data-depth": String(a.depth),
        class: "butter-list-item",
      };
      if (a.tight) attrs["data-tight"] = "true";
      if (a.checked === true) attrs["data-task-state"] = "checked";
      else if (a.checked === false)
        attrs["data-task-state"] = "unchecked";
      if (a.start != null) attrs["data-start"] = String(a.start);
      return ["div", attrs, 0];
    },
  },

  code_block: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    attrs: { language: { default: "" } },
    parseDOM: [{
      tag: "pre",
      preserveWhitespace: "full" as const,
      getAttrs(dom: HTMLElement) {
        const code = dom.querySelector("code");
        const cls = code?.className || "";
        const match = cls.match(/language-(\S+)/);
        return { language: match ? match[1] : "" };
      },
    }],
    toDOM(node) {
      const a = attrs<{ language?: string }>(node.attrs);
      const code: import("prosemirror-model").DOMOutputSpec = a.language
        ? ["code", { class: `language-${a.language}` }, 0]
        : ["code", 0];
      return ["pre", code];
    },
  },

  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM() { return ["hr"]; },
  },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM() { return ["br"]; },
  },

  // Soft break: a `\n` inside a paragraph. CommonMark treats this
  // as whitespace when rendering, but the source byte-for-byte
  // matters for users who hand-wrap prose at e.g. 80 columns. Without
  // this node, markdown-it's softbreak tokens were silently dropped
  // and the serializer emitted all paragraph text on one line. With
  // it, hand-wrapped paragraphs round-trip cleanly. A softbreak
  // renders as a `<br>` in the editor so the user visually sees the
  // line break they wrote.
  softbreak: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br[data-softbreak]" }],
    toDOM() { return ["br", { "data-softbreak": "" }]; },
  },

  image: {
    inline: true,
    group: "inline",
    attrs: {
      src: {},
      alt: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
      // null = pixel-sized (or natural). 'full' = display at full
      // column width via CSS, encoded in markdown as `|full` in the
      // alt-suffix slot so it round-trips cleanly. Set to 'full' by
      // the image context menu's "Full width" option, which also
      // splits the parent paragraph to enforce the image sitting in
      // a block by itself.
      displayMode: { default: null },
    },
    draggable: true,
    parseDOM: [{
      tag: "img[src]",
      getAttrs(dom: HTMLElement) {
        const w = dom.getAttribute("width");
        const h = dom.getAttribute("height");
        return {
          src: dom.getAttribute("src"),
          alt: dom.getAttribute("alt"),
          title: dom.getAttribute("title"),
          width: w ? parseInt(w, 10) : null,
          height: h ? parseInt(h, 10) : null,
        };
      },
    }],
    toDOM(node) {
      const attrs: Record<string, unknown> = {
        src: node.attrs.src,
        alt: node.attrs.alt,
        title: node.attrs.title,
      };
      if (node.attrs.width) attrs.width = node.attrs.width;
      if (node.attrs.height) attrs.height = node.attrs.height;
      return ["img", attrs];
    },
  },

  text: { group: "inline" },

  // ── Obsidian-specific block nodes ──

  obsidian_callout: {
    group: "block",
    // `block*` (not `block+`) - a callout with zero children is a
    // valid state representing "title-only / no body" (matches Live
    // Preview's slim look). The title lives in node attrs, so the
    // node is meaningful even with empty content.
    content: "block*",
    defining: true,
    attrs: {
      calloutType: { default: "note" },
      title: { default: "" },
      foldState: { default: "" },
    },
    parseDOM: [{
      tag: "div[data-callout]",
      getAttrs(dom: HTMLElement) {
        return {
          calloutType: dom.getAttribute("data-callout-type") || "note",
          title: dom.getAttribute("data-title") || "",
          foldState: dom.getAttribute("data-fold") || "",
        };
      },
    }],
    toDOM(node) {
      const a = attrs<{ calloutType: string }>(node.attrs);
      return [
        "div",
        {
          "data-callout": "",
          "data-callout-type": a.calloutType,
          class: "butter-callout",
        },
        0,
      ];
    },
  },

  obsidian_embed: {
    group: "block",
    atom: true,
    isolating: true,
    attrs: { src: { default: "" } },
    parseDOM: [{
      tag: "div[data-obsidian-embed]",
      getAttrs(dom: HTMLElement) {
        return { src: dom.getAttribute("data-src") || "" };
      },
    }],
    toDOM(node) {
      const a = attrs<{ src: string }>(node.attrs);
      return ["div", {
        "data-obsidian-embed": "",
        "data-src": a.src,
        class: "butter-embed-placeholder",
      }, `![[${a.src}]]`];
    },
  },

  // Inline variant - used when an `![[...]]` appears inside a
  // paragraph that also contains other content, or inside a list
  // item where lifting to block would force an empty leading
  // paragraph (breaking the list-item schema's `paragraph block*`
  // first-child requirement and producing malformed markdown).
  obsidian_embed_inline: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { src: { default: "" } },
    parseDOM: [{
      tag: "span[data-obsidian-embed-inline]",
      getAttrs(dom: HTMLElement) {
        return { src: dom.getAttribute("data-src") || "" };
      },
    }],
    toDOM(node) {
      const a = attrs<{ src: string }>(node.attrs);
      return ["span", {
        "data-obsidian-embed-inline": "",
        "data-src": a.src,
        class: "butter-embed-placeholder butter-embed-inline",
      }, `![[${a.src}]]`];
    },
  },

  math_block: {
    group: "block",
    atom: true,
    attrs: { value: { default: "" } },
    parseDOM: [{
      tag: "div[data-math-block]",
      getAttrs(dom: HTMLElement) {
        return { value: dom.getAttribute("data-value") || "" };
      },
    }],
    toDOM(node) {
      return ["div", { "data-math-block": "", class: "butter-math-block" }, node.attrs.value];
    },
  },

  block_comment: {
    group: "block",
    atom: true,
    attrs: { value: { default: "" } },
    parseDOM: [{
      tag: "div[data-block-comment]",
      getAttrs(dom: HTMLElement) {
        return { value: dom.getAttribute("data-value") || "" };
      },
    }],
    toDOM(node) {
      return ["div", {
        "data-block-comment": "",
        class: "butter-block-comment",
        style: "display:none",
      }, node.attrs.value];
    },
  },

  // ── Footnotes ──

  footnote_ref: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { label: { default: "" } },
    parseDOM: [{
      tag: "sup[data-footnote-ref]",
      getAttrs(dom: HTMLElement) {
        return { label: dom.getAttribute("data-label") || "" };
      },
    }],
    toDOM(node) {
      const a = attrs<{ label: string }>(node.attrs);
      return ["sup", {
        "data-footnote-ref": "",
        "data-label": a.label,
        class: "butter-footnote-ref",
      }, `[${a.label}]`];
    },
  },

  footnote_def: {
    group: "block",
    atom: true,
    attrs: {
      label: { default: "" },
      content: { default: "" },
    },
    parseDOM: [{
      tag: "div[data-footnote-def]",
      getAttrs(dom: HTMLElement) {
        return {
          label: dom.getAttribute("data-label") || "",
          content: dom.getAttribute("data-content") || "",
        };
      },
    }],
    toDOM(node) {
      return ["div", {
        "data-footnote-def": "",
        class: "butter-footnote-def",
      }, `[^${node.attrs.label}]: ${node.attrs.content}`];
    },
  },

  // ── Obsidian-specific inline nodes ──

  wikilink: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: {
      target: { default: "" },
      alias: { default: "" },
    },
    parseDOM: [{
      tag: "a[data-wikilink]",
      getAttrs(dom: HTMLElement) {
        return {
          target: dom.getAttribute("data-target") || "",
          alias: dom.getAttribute("data-alias") || "",
        };
      },
    }],
    toDOM(node) {
      const a = attrs<{ target: string; alias: string }>(node.attrs);
      const display = a.alias || a.target;
      return ["a", {
        "data-wikilink": "",
        "data-target": a.target,
        class: "butter-wikilink internal-link",
        href: sanitizeHref(a.target),
      }, display];
    },
  },

  obsidian_tag: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { tag: { default: "" } },
    parseDOM: [{
      tag: "a[data-obsidian-tag]",
      getAttrs(dom: HTMLElement) {
        return { tag: dom.getAttribute("data-tag") || "" };
      },
    }],
    toDOM(node) {
      const a = attrs<{ tag: string }>(node.attrs);
      return ["a", {
        "data-obsidian-tag": "",
        "data-tag": a.tag,
        class: "butter-tag tag",
        href: `#${a.tag}`,
      }, `#${a.tag}`];
    },
  },

  inline_math: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { value: { default: "" } },
    parseDOM: [{
      tag: "span[data-inline-math]",
      getAttrs(dom: HTMLElement) {
        return { value: dom.getAttribute("data-value") || "" };
      },
    }],
    toDOM(node) {
      return ["span", { "data-inline-math": "", class: "butter-inline-math" }, `$${node.attrs.value}$`];
    },
  },

  inline_footnote: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { content: { default: "" } },
    parseDOM: [{
      tag: "span[data-inline-footnote]",
      getAttrs(dom: HTMLElement) {
        return { content: dom.getAttribute("data-content") || "" };
      },
    }],
    toDOM(node) {
      return ["span", {
        "data-inline-footnote": "",
        class: "butter-inline-footnote",
      }, `^[${node.attrs.content}]`];
    },
  },

  block_id: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { id: { default: "" } },
    parseDOM: [{
      tag: "span[data-block-id]",
      getAttrs(dom: HTMLElement) {
        return { id: dom.getAttribute("data-id") || "" };
      },
    }],
    toDOM(node) {
      return ["span", {
        "data-block-id": "",
        class: "butter-block-id",
        style: "color: var(--text-faint); font-size: 0.85em",
      }, `^${node.attrs.id}`];
    },
  },

  /**
   * Raw-passthrough block. Carries unparseable source bytes verbatim
   * with a diagnostic reason. Emitted by the parser when:
   *   - A handler throws on a token (our bug, or extremely malformed
   *     input markdown-it emitted in an unexpected token shape).
   *   - The whole parse fails at a structural level and falls back.
   *   - (Future) A plugin registers an "unknown lang" construct and
   *     opts into raw preservation instead of re-serialization.
   *
   * Atomic (non-editable as PM content) so users can't accidentally
   * scramble the raw bytes. UI presents a diagnostic banner above the
   * raw text with an "edit raw" affordance. On save, emits the raw
   * attr byte-for-byte - preservation holds even for regions Butter
   * doesn't understand.
   */
  raw_block: {
    group: "block",
    atom: true,
    attrs: {
      raw: { default: "" },
      reason: { default: "" },
    },
    parseDOM: [{
      tag: "div[data-raw-block]",
      getAttrs(dom: HTMLElement) {
        return {
          raw: dom.getAttribute("data-raw") || "",
          reason: dom.getAttribute("data-reason") || "",
        };
      },
    }],
    toDOM(node) {
      const a = attrs<{ raw: string; reason: string }>(node.attrs);
      return ["div", {
        "data-raw-block": "",
        "data-raw": a.raw,
        "data-reason": a.reason,
        class: "butter-raw-block",
      }, a.raw];
    },
  },
};

// ── Mark specs ──

const marks: Record<string, MarkSpec> = {
  strong: {
    parseDOM: [
      { tag: "strong" },
      { tag: "b", getAttrs: (node: HTMLElement) => node.style.fontWeight !== "normal" && null },
      { style: "font-weight=bold" },
      { style: "font-weight", getAttrs: (value: string) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
    ],
    toDOM() { return ["strong", 0]; },
  },

  em: {
    parseDOM: [
      { tag: "i" },
      { tag: "em" },
      { style: "font-style=italic" },
    ],
    toDOM() { return ["em", 0]; },
  },

  code: {
    parseDOM: [{ tag: "code" }],
    toDOM() { return ["code", 0]; },
  },

  link: {
    attrs: {
      href: {},
      title: { default: null },
    },
    inclusive: false,
    parseDOM: [{
      tag: "a[href]",
      getAttrs(dom: HTMLElement) {
        return {
          href: dom.getAttribute("href"),
          title: dom.getAttribute("title"),
        };
      },
    }],
    toDOM(node) {
      const a = attrs<{ href: string; title: string | null }>(node.attrs);
      // `butter-external-link` is the right-click hit-testing hook
      // (inline-atom-edit's contextmenu handler matches on it to
      // distinguish external links from wikilinks). Obsidian's own
      // `external-link` class triggers theme styling parity with
      // Live Preview / Reading mode.
      return [
        "a",
        {
          href: sanitizeHref(a.href),
          title: a.title,
          class: "butter-external-link external-link",
        },
        0,
      ];
    },
  },

  strikethrough: {
    parseDOM: [
      { tag: "s" },
      { tag: "del" },
      { style: "text-decoration=line-through" },
    ],
    toDOM() { return ["del", 0]; },
  },

  highlight: {
    // `html` attr remembers whether the highlight was authored as
    // `==text==` (markdown shorthand) or `<mark>text</mark>` (HTML).
    // The serializer reads this to round-trip back to the same form
    // so users don't see their `<mark>` tags rewritten on save.
    //
    // `color` is the optional background-color value (CSS color
    // literal: hex, rgb(), or named color). When set, the highlight
    // serializes as `<mark style="background-color: …">…</mark>` and
    // forces HTML form regardless of `html`. Null = no custom color
    // (uses Obsidian's theme highlight color via the `.butter-
    // highlight` class).
    attrs: {
      html: { default: false },
      color: { default: null as string | null },
    },
    parseDOM: [{
      tag: "mark",
      getAttrs(dom: HTMLElement) {
        const style = dom.getAttribute("style") || "";
        const m = /background(?:-color)?\s*:\s*([^;]+)/i.exec(style);
        const color = m ? m[1].trim() : null;
        return { html: true, color };
      },
    }],
    toDOM(node) {
      const attrs: Record<string, string> = { class: "butter-highlight" };
      if (node.attrs.color) {
        attrs.style = `background-color: ${node.attrs.color}`;
      }
      return ["mark", attrs, 0];
    },
  },

  // ── Common inline HTML tags ──
  // These are styling-only marks for HTML tags that appear in
  // Obsidian-flavored markdown notes. The serializer emits the HTML
  // form (`<font color="...">…</font>`), and the parser recognizes
  // both the HTML tags and the corresponding markdown shorthand
  // where one exists.

  underline: {
    parseDOM: [
      { tag: "u" },
      { style: "text-decoration=underline" },
    ],
    toDOM() { return ["u", 0]; },
  },

  superscript: {
    parseDOM: [{ tag: "sup" }],
    toDOM() { return ["sup", 0]; },
  },

  subscript: {
    parseDOM: [{ tag: "sub" }],
    toDOM() { return ["sub", 0]; },
  },

  kbd: {
    parseDOM: [{ tag: "kbd" }],
    toDOM() { return ["kbd", 0]; },
  },

  font: {
    attrs: {
      color: { default: "" },
      face: { default: "" },
      size: { default: "" },
    },
    parseDOM: [{
      tag: "font",
      getAttrs(dom: HTMLElement) {
        return {
          color: dom.getAttribute("color") || "",
          face: dom.getAttribute("face") || "",
          size: dom.getAttribute("size") || "",
        };
      },
    }],
    toDOM(node) {
      const a = attrs<{ color?: string; face?: string; size?: string }>(node.attrs);
      const out: Record<string, string> = {};
      if (a.color) out.color = a.color;
      if (a.face) out.face = a.face;
      if (a.size) out.size = a.size;
      return ["font", out, 0];
    },
  },

  comment: {
    attrs: { value: { default: "" } },
    inclusive: false,
    excludes: "",
    parseDOM: [{
      tag: "span[data-obsidian-comment]",
      getAttrs(dom: HTMLElement) {
        return { value: dom.getAttribute("data-value") || "" };
      },
    }],
    toDOM(node) {
      return ["span", {
        "data-obsidian-comment": "",
        class: "butter-comment",
        style: "display:none",
      }, 0];
    },
  },
};

// ── Merge table nodes ──

const tNodes = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {
    alignment: {
      default: null,
      getFromDOM(dom: HTMLElement) {
        return dom.style.textAlign || null;
      },
      setDOMAttr(value: unknown, attrs: Record<string, unknown>) {
        if (typeof value === "string" && ALLOWED_TABLE_ALIGN.has(value)) {
          attrs.style = ((attrs.style as string) || "") + `text-align: ${value};`;
        }
      },
    },
  },
});

// Merge extension-registered node specs LAST so they participate in
// the sourceRange post-processing below (every non-text, non-doc
// node gets a sourceRange attr automatically). Name collisions with
// built-in specs win the built-in - the registry's registerSyntax
// Extension() guards against double-registration within extensions
// themselves, but built-ins always dominate.
const extNodes = getExtensionNodeSpecs();
const allNodes = { ...extNodes, ...basicNodes, ...tNodes };

/**
 * Source preservation is a first-class property of the PMX schema.
 *
 * Every block-level node and inline-atom node carries a `sourceRange`
 * attribute - `{ start: number, end: number }` character offsets into
 * the original file body - set at parse time by the bridge.
 *
 * The range travels with the node through PM transactions. When an
 * edit mutates a node's content, a companion plugin invalidates the
 * range (sets it to null). At save time, nodes with valid ranges emit
 * their original bytes unchanged; nodes with null ranges serialize
 * fresh. This is the mechanism that makes "bytes you didn't touch
 * stay byte-identical" literally true.
 *
 * Excluded: `doc` (never needs a range - it's the container) and
 * `text` (PM doesn't allow attrs on text nodes; inline ranges live
 * on their marks + atom siblings instead).
 */
const NO_SOURCE_RANGE = new Set(["doc", "text"]);
for (const [name, spec] of Object.entries(allNodes)) {
  if (NO_SOURCE_RANGE.has(name)) continue;
  const existingAttrs = (spec).attrs || {};
  (spec).attrs = {
    ...existingAttrs,
    sourceRange: { default: null as { start: number; end: number } | null },
  };
}

// Add the `non_list_block` group to every node currently in the
// `block` group, EXCEPT `list_item`. This is what `list_item.content`
// references (`paragraph non_list_block*`) to allow loose items with
// rich block content (nested callouts, code blocks, blockquotes, etc.)
// while STRUCTURALLY forbidding direct nesting of list_items inside
// other list_items - nesting is expressed via the `depth` attr on
// flat sibling list_items, not via the document tree.
//
// Post-processing rather than per-node group declaration so future
// extension nodes that just declare `group: "block"` automatically
// participate without each having to remember to add
// `"non_list_block"` to their group string.
for (const [name, spec] of Object.entries(allNodes)) {
  if (name === "list_item") continue;
  const group = (spec).group;
  if (typeof group !== "string") continue;
  if (!group.split(/\s+/).includes("block")) continue;
  if (group.split(/\s+/).includes("non_list_block")) continue;
  (spec).group = `${group} non_list_block`;
}

// Add `blockId` attr to every block-level node. The ID is a
// session-local stable identifier — generated in memory (via parser
// or auto-stamper plugin), never serialized to markdown. Used by
// the drag engine to correlate blocks across transactions so the
// settle FLIP animation can find the same block before/after.
// Default null means existing call sites that construct nodes
// without an ID don't break; the stamper plugin fills in later.
for (const [, spec] of Object.entries(allNodes)) {
  const group = (spec).group;
  if (typeof group !== "string" || !group.split(/\s+/).includes("block")) continue;
  const existing = (spec).attrs ?? {};
  if ((existing as Record<string, unknown>).blockId) continue;
  (spec).attrs = { ...existing, blockId: { default: null } };
}

export const schema = new Schema({ nodes: allNodes, marks });
