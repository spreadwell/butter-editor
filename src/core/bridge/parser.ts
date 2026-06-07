import { Node as PMNode, Fragment, Mark, MarkType, NodeType } from "prosemirror-model";
import type Token from "markdown-it/lib/token.mjs";
import { schema } from "../schema";
import { metaStr, __mdit } from "./common";
import { debug } from "../../integration/debug";

const md = __mdit;

// ═══════════════════════════════════════════════
//  PARSER: markdown-it tokens -> ProseMirror doc
// ═══════════════════════════════════════════════

interface StackFrame {
  type: NodeType;
  attrs: Record<string, unknown>;
  content: PMNode[];
}

export type TokenHandler = (state: ParseState, tok: Token) => void;

export class ParseState {
  stack: StackFrame[];
  marks: readonly Mark[];

  // ── Source-preservation context (optional; null in plain parse) ──
  // When the parser is driven with source-map context, these fields
  // let push()/addNode() auto-attach a sourceRange attr to each
  // created node based on the token being processed. The main loop
  // keeps `currentTokIdx` pointing at the active token so handlers
  // don't need to know about source ranges - the ParseState threads
  // it through on their behalf.
  tokens: Token[] | null = null;
  lineStarts: number[] | null = null;
  totalLen = 0;
  currentTokIdx = -1;

  // ── Flat-list context ──
  // Tracks the markdown-it bullet_list/ordered_list nesting we're
  // currently inside, so list_item_open can stamp the right `kind`,
  // `depth`, `tight`, and `start` attrs on each emitted list_item PM
  // node. The container nodes themselves are NEVER pushed onto the PM
  // build stack - list_items live as siblings at top level (or inside
  // any "block" container), with depth carried as an attr.
  //
  // `listItemOpen` mirrors whether a list_item is currently the top
  // of the build stack. Set true on list_item_open, false on
  // list_item_close - and ALSO false when a nested bullet_list /
  // ordered_list opens inside an item (which auto-closes the item so
  // the nested-deeper list_items become flat siblings rather than
  // structural children).
  listStack: Array<{
    kind: "bullet" | "ordered";
    depth: number;
    start: number;
    firstEmitted: boolean;
  }> = [];
  listItemOpen = false;
  // Saves of (listStack, listItemOpen) pairs pushed when entering a
  // "block container" that's not itself a list (callout, blockquote,
  // and structurally any other `block+` host). Restored on the
  // matching close. Lists inside such a container start fresh at
  // depth=0, independent of the outer list nesting.
  listStackSaves: Array<{
    stack: ParseState["listStack"];
    itemOpen: boolean;
  }> = [];

  constructor() {
    this.stack = [{ type: schema.nodes.doc, attrs: {}, content: [] }];
    this.marks = Mark.none;
  }

  top(): StackFrame {
    return this.stack[this.stack.length - 1];
  }

  /**
   * Source range of the *currently-processing* token.
   *
   * - For an "open" token (nesting === 1), walk forward until the
   *   matching close at the same level and take the close's endLine.
   * - For a self-closing block token (nesting === 0), use tok.map
   *   directly - markdown-it already gives the full line range.
   * - For any token without .map (including inline sub-tokens walked
   *   via the `inline` container), return null - we don't synthesize
   *   positions, we only preserve ones the tokenizer gave us.
   */
  private currentRange(): { start: number; end: number } | null {
    if (!this.tokens || !this.lineStarts || this.currentTokIdx < 0) return null;
    const tok = this.tokens[this.currentTokIdx];
    if (!tok?.map) return null;

    const lineToOffset = (line: number): number =>
      line < this.lineStarts!.length ? this.lineStarts![line] : this.totalLen;

    if (tok.nesting === 0) {
      return { start: lineToOffset(tok.map[0]), end: lineToOffset(tok.map[1]) };
    }
    if (tok.nesting === 1) {
      // Scan forward at the same nesting level for the matching close.
      //
      // Special case: for `list_item_open`, the flat-list parser
      // emits the OUTER item as a top-level sibling of any nested
      // list_items inside it. The outer item's source range must
      // therefore END before the nested list begins, otherwise the
      // outer item's range OVERLAPS the nested items' ranges, the
      // coverage check trips on backward gaps, and parseWithSourceMap
      // bails to raw_block. Stop at the first nested
      // `bullet_list_open` / `ordered_list_open` we encounter inside
      // the item - its `tok.map[0]` becomes our end line.
      const isListItem = tok.type === "list_item_open";
      let depth = 1;
      let endLine = tok.map[1];
      for (let j = this.currentTokIdx + 1; j < this.tokens.length; j++) {
        const t = this.tokens[j];
        if (
          isListItem &&
          (t.type === "bullet_list_open" || t.type === "ordered_list_open") &&
          t.map
        ) {
          // Check we're still inside the item (not in a nested
          // callout/blockquote that's already opened a separate
          // list - those don't auto-promote to siblings).
          // The simple `level` heuristic: nested-list-inside-item
          // tokens are at level+2 (item level + paragraph_close +
          // bullet_list_open) - actually markdown-it's `level` is
          // structural. The first nested ul/ol at a level > tok.level
          // before the matching close is what we want.
          if (t.level > tok.level) {
            endLine = t.map[0];
            break;
          }
        }
        if (t.level !== tok.level) continue;
        if (t.nesting === 1) depth++;
        else if (t.nesting === -1) {
          depth--;
          if (depth === 0) {
            endLine = t.map?.[1] ?? endLine;
            break;
          }
        }
      }
      return { start: lineToOffset(tok.map[0]), end: lineToOffset(endLine) };
    }
    return null;
  }

  /** Merge the current token's sourceRange into attrs (if any). */
  private withRange(attrs: Record<string, unknown>): Record<string, unknown> {
    const r = this.currentRange();
    return r ? { ...attrs, sourceRange: r } : attrs;
  }

  push(type: NodeType, attrs: Record<string, unknown> = {}) {
    this.stack.push({ type, attrs: this.withRange(attrs), content: [] });
  }

  pop(): PMNode {
    const { type, attrs, content } = this.stack.pop()!;
    const node = this.buildNode(type, attrs, content);
    if (this.stack.length) this.top().content.push(node);
    return node;
  }

  addNode(type: NodeType, attrs: Record<string, unknown> = {}) {
    const finalAttrs = this.withRange(attrs);
    const node = this.buildNode(type, finalAttrs, []);
    // Apply active marks (set by inline mark open tokens) to the
    // created node. Without this, an inline atom (wikilink, tag,
    // math, embed, footnote ref/inline, block id, image) inside an
    // emphasis / strong / highlight range loses the surrounding
    // mark. The serializer then opens-then-closes the mark across
    // the atom - emitting `*foo *[[link]]* bar*` instead of `*foo
    // [[link]] bar*` - and the round-trip diverges.
    //
    // For block-level addNode calls (math_block, block_comment,
    // obsidian_embed, footnote_def), `this.marks` is empty (marks
    // are only opened inside `inline` token walks), so this is a
    // no-op for blocks. Only inline atoms inside marked ranges see
    // any change.
    const marked = this.marks.length > 0 ? node.mark(this.marks) : node;
    this.top().content.push(marked);
  }

  /**
   * Create a PM node with the given type / attrs / provided content.
   *
   * PM's `createAndFill` invokes `ContentMatch.fillBefore` under the
   * hood to satisfy the type's content spec when the provided content
   * is insufficient. On a schema with ~30 block types like ours, the
   * recursive search can blow the Electron stack (smaller than Node's)
   * for certain shapes - typically empty containers whose spec is
   * `block+`. The ordinary stack trace looks like:
   *
   *   RangeError: Maximum call stack size exceeded
   *     at ContentMatch.matchFragment
   *     at search
   *     at ContentMatch.fillBefore
   *     at NodeType.createAndFill
   *     at eval (map)
   *     at search (recursive)
   *     ...
   *
   * Defensive strategy:
   *   1. Try `createAndFill` normally - the common case.
   *   2. If it throws (stack overflow) or returns null (spec not
   *      satisfiable with the given content), fall back to injecting
   *      a single empty paragraph and retrying. Nearly every block
   *      container in our schema accepts `paragraph` as a valid first
   *      child, and `paragraph` content spec `inline*` satisfies
   *      without recursion.
   *   3. Last resort: `type.create()` with whatever content we have.
   *      May produce a schema-invalid node that the renderer can
   *      still mount; better than crashing the parse entirely and
   *      dropping the user's whole file into a raw_block fallback.
   */
  private buildNode(
    type: NodeType,
    attrs: Record<string, unknown>,
    content: PMNode[],
  ): PMNode {
    const fragment = Fragment.fromArray(content);
    const paraType = schema.nodes.paragraph;

    // Empty-content fast path. We split by whether the type's
    // content spec accepts an empty fragment as a valid end state
    // (e.g., `block*`, `text*`, `inline*` - true; `block+` - false):
    //   • Accepts empty: just create with empty content. Avoids
    //     fillBefore's recursive search entirely. Required for
    //     `obsidian_callout` (now `block*`) where an empty body
    //     is the legitimate "title-only" state - paragraph fill
    //     would actively introduce wrong content.
    //   • Doesn't accept empty: pre-emptive paragraph fill. PM's
    //     `createAndFill` would otherwise call `ContentMatch
    //     .fillBefore`, whose search recurses through block types
    //     and on a schema with many `block+` containers blows the
    //     Electron stack. Injecting a paragraph upfront short-
    //     circuits the search.
    if (content.length === 0) {
      const acceptsEmpty = type.contentMatch.validEnd;
      if (acceptsEmpty) {
        const node = type.create(attrs, Fragment.empty);
        return node;
      }
      if (paraType && type !== paraType) {
        try {
          const node = type.createAndFill(
            attrs,
            Fragment.fromArray([paraType.create(null)]),
          );
          if (node) return node;
        } catch { /* fall through to standard createAndFill */ }
      }
    }

    try {
      const node = type.createAndFill(attrs, fragment);
      if (node) return node;
    } catch (err) {
      debug(
        "parse",
        `buildNode: createAndFill threw on ${type.name}, trying paragraph fill`,
        err,
      );
    }
    if (content.length === 0 && paraType) {
      try {
        const node = type.createAndFill(
          attrs,
          Fragment.fromArray([paraType.create(null)]),
        );
        if (node) {
          debug("parse", `buildNode: recovered ${type.name} via paragraph fill`);
          return node;
        }
      } catch (err) {
        debug(
          "parse",
          `buildNode: paragraph fill also threw on ${type.name}`,
          err,
        );
      }
    }
    debug(
      "parse",
      `buildNode: last-resort type.create on ${type.name} (may be schema-invalid)`,
    );
    return type.create(attrs, fragment);
  }

  addText(text: string) {
    if (!text) return;
    const nodes = this.top().content;
    const last = nodes[nodes.length - 1];
    if (last?.isText && Mark.sameSet(last.marks, this.marks)) {
      nodes[nodes.length - 1] = schema.text(last.text! + text, this.marks);
    } else {
      nodes.push(schema.text(text, this.marks));
    }
  }

  openMark(type: MarkType, attrs: Record<string, unknown> = {}) {
    this.marks = type.create(attrs).addToSet(this.marks);
  }

  closeMark(type: MarkType) {
    this.marks = type.removeFromSet(this.marks);
  }
}

// ── helpers ──

function stripTrailingNL(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

function cellAlign(tok: Token): string | null {
  const m = (tok.attrGet("style") || "").match(/text-align:\s*(\w+)/);
  return m ? m[1] : null;
}

// ── token handler table ──

function buildHandlers(): Record<string, TokenHandler> {
  const h: Record<string, TokenHandler> = {};

  // ── Flat-list helpers ──
  //
  // `autoCloseDirectItem` - pop the open list_item if it's the
  // current PM stack top. Called when a sibling list_item or a
  // sibling/nested ul/ol opens, OR when a containing block (like a
  // callout) closes. The "directly on stack top" check matters: if
  // the item has a sub-container (callout, blockquote) inside, the
  // top is THAT, not the item, and we must not pop the wrong node.
  //
  // `enterBlockContainer` / `leaveBlockContainer` - save and reset
  // the flat-list parsing context so any list that opens INSIDE a
  // block container (callout, blockquote, table cell) starts at
  // depth=0. Without this, a list inside a callout that's inside an
  // outer item would inherit depth=1 and produce visually-wrong
  // indentation when serialized.
  const autoCloseDirectItem = (s: ParseState) => {
    if (s.listItemOpen && s.top().type.name === "list_item") {
      s.pop();
      s.listItemOpen = false;
    }
  };
  const enterBlockContainer = (s: ParseState) => {
    s.listStackSaves.push({ stack: s.listStack, itemOpen: s.listItemOpen });
    s.listStack = [];
    s.listItemOpen = false;
  };
  const leaveBlockContainer = (s: ParseState) => {
    const saved = s.listStackSaves.pop();
    if (saved) {
      s.listStack = saved.stack;
      s.listItemOpen = saved.itemOpen;
    }
  };

  // Block open/close pairs
  h.blockquote_open = (s) => {
    s.push(schema.nodes.blockquote);
    enterBlockContainer(s);
  };
  h.blockquote_close = (s) => {
    autoCloseDirectItem(s);
    leaveBlockContainer(s);
    s.pop();
  };
  h.paragraph_open = (s) => s.push(schema.nodes.paragraph);
  h.paragraph_close = (s) => s.pop();
  h.heading_open = (s, t) =>
    s.push(schema.nodes.heading, { level: +t.tag.slice(1) });
  h.heading_close = (s) => s.pop();
  // ── Flat list handlers ──
  //
  // markdown-it produces standard nested ul/ol/li tokens. We collapse
  // those into a flat sequence of `list_item` PM nodes carrying `kind`
  // + `depth` attrs - Notion's model. The containers leave NO nodes in
  // the doc; they only push a context onto `s.listStack` so the next
  // list_item_open can stamp the right attrs.
  //
  // Auto-close: when a nested ul/ol opens DIRECTLY inside an open
  // list_item (PM stack top IS the item), we pop the parent item
  // before pushing the nested list's context. The parent's content
  // (paragraph + any non-list blocks before the nested list) is
  // committed; the nested items become flat siblings at higher depth.
  //
  // The "directly inside" check matters: if the nested list opens
  // inside a callout or blockquote that's inside the item, the item
  // is NOT the stack top (the callout/blockquote is), and we MUST
  // NOT auto-close - the nested list belongs to the callout's body,
  // not as a sibling of the outer item. The callout/blockquote
  // handlers separately save and reset `listStack` so depth restarts
  // at 0 inside the new container.
  h.bullet_list_open = (s) => {
    autoCloseDirectItem(s);
    s.listStack.push({
      kind: "bullet",
      depth: s.listStack.length,
      start: 1,
      firstEmitted: false,
    });
  };
  h.bullet_list_close = (s) => {
    autoCloseDirectItem(s);
    s.listStack.pop();
  };
  h.ordered_list_open = (s, t) => {
    autoCloseDirectItem(s);
    s.listStack.push({
      kind: "ordered",
      depth: s.listStack.length,
      start: +(t.attrGet("start") || 1),
      firstEmitted: false,
    });
  };
  h.ordered_list_close = (s) => {
    autoCloseDirectItem(s);
    s.listStack.pop();
  };
  h.list_item_open = (s) => {
    // Close any sibling list_item still open before opening a new one.
    autoCloseDirectItem(s);
    const ctx = s.listStack[s.listStack.length - 1];
    if (!ctx) {
      // Defensive: list_item without a containing list. Push with
      // defaults so the doc stays well-formed.
      s.push(schema.nodes.list_item, {});
      s.listItemOpen = true;
      return;
    }
    // Only the FIRST item in an ordered run with a non-default start
    // carries the explicit `start` attr; subsequent items count up.
    const isFirst = !ctx.firstEmitted;
    ctx.firstEmitted = true;
    s.push(schema.nodes.list_item, {
      kind: ctx.kind,
      depth: ctx.depth,
      tight: true,
      start:
        isFirst && ctx.kind === "ordered" && ctx.start !== 1
          ? ctx.start
          : null,
    });
    s.listItemOpen = true;
  };
  h.list_item_close = (s) => {
    if (s.listItemOpen) {
      s.pop();
      s.listItemOpen = false;
    }
  };
  h.table_open = (s) => s.push(schema.nodes.table);
  h.table_close = (s) => s.pop();
  h.tr_open = (s) => s.push(schema.nodes.table_row);
  h.tr_close = (s) => s.pop();
  h.th_open = (s, t) =>
    s.push(schema.nodes.table_header, { alignment: cellAlign(t) });
  h.th_close = (s) => s.pop();
  h.td_open = (s, t) =>
    s.push(schema.nodes.table_cell, { alignment: cellAlign(t) });
  h.td_close = (s) => s.pop();

  // Ignored wrappers
  h.thead_open = h.thead_close = h.tbody_open = h.tbody_close = () => {};

  // Callouts - block container; lists inside start fresh.
  h.obsidian_callout_open = (s, t) => {
    s.push(schema.nodes.obsidian_callout, {
      calloutType: metaStr(t, "calloutType") || "note",
      title: metaStr(t, "title") || "",
      foldState: metaStr(t, "foldState") || "",
    });
    enterBlockContainer(s);
  };
  h.obsidian_callout_close = (s) => {
    autoCloseDirectItem(s);
    leaveBlockContainer(s);
    s.pop();
  };

  // Self-closing blocks
  h.fence = (s, t) => {
    s.push(schema.nodes.code_block, { language: t.info || "" });
    s.addText(stripTrailingNL(t.content));
    s.pop();
  };
  h.code_block = (s, t) => {
    s.push(schema.nodes.code_block);
    s.addText(stripTrailingNL(t.content));
    s.pop();
  };
  h.hr = (s) => s.addNode(schema.nodes.horizontal_rule);

  // Leaf block nodes
  h.math_block = (s, t) =>
    s.addNode(schema.nodes.math_block, { value: t.content });
  h.block_comment = (s, t) =>
    s.addNode(schema.nodes.block_comment, { value: t.content });
  h.obsidian_embed = (s, t) =>
    s.addNode(schema.nodes.obsidian_embed, { src: t.content });
  h.footnote_def = (s, t) =>
    s.addNode(schema.nodes.footnote_def, {
      label: metaStr(t, "label"),
      content: t.content,
    });

  // Inline container.
  //
  // markdown-it's "inline" token wraps the entire inline content of
  // a block. It has a line-range `.map` pointing at the block's
  // entire source span. If we let that range leak through to inline
  // children during the handler iteration, every softbreak / embed /
  // inline atom added via `addNode` would inherit `sourceRange =
  // {start: block.start, end: block.end}` via the usual
  // `withRange` merge - and the preservation hook in SerState would
  // later emit the WHOLE paragraph's bytes every time it encountered
  // one of those atoms. Nasty source-duplication bug.
  //
  // Suppress the outer range while iterating inline children by
  // stashing currentTokIdx to -1 (which makes currentRange() return
  // null). Atoms that need a specific sourceRange (wikilinks, tags,
  // inline math, etc.) still get one later via
  // populateInlineSourceRanges's pattern search. Atoms that don't
  // have a source pattern (softbreak, hardbreak) correctly end up
  // with `sourceRange: null` and the preservation hook skips them.
  h.inline = (s, t) => {
    if (!t.children) return;
    const savedIdx = s.currentTokIdx;
    s.currentTokIdx = -1;
    try {
      for (const c of t.children) {
        const fn = handlers[c.type];
        if (fn) fn(s, c);
      }
    } finally {
      s.currentTokIdx = savedIdx;
    }
  };

  // Inline marks (open/close)
  h.strong_open = (s) => s.openMark(schema.marks.strong);
  h.strong_close = (s) => s.closeMark(schema.marks.strong);
  h.em_open = (s) => s.openMark(schema.marks.em);
  h.em_close = (s) => s.closeMark(schema.marks.em);
  h.s_open = (s) => s.openMark(schema.marks.strikethrough);
  h.s_close = (s) => s.closeMark(schema.marks.strikethrough);
  h.highlight_open = (s) => s.openMark(schema.marks.highlight);
  h.highlight_close = (s) => s.closeMark(schema.marks.highlight);
  h.obsidian_comment_open = (s) => s.openMark(schema.marks.comment);
  h.obsidian_comment_close = (s) => s.closeMark(schema.marks.comment);

  // Common inline HTML tags. Each becomes a PM mark; <font> carries
  // attrs (color/face/size). <mark> aliases to the existing highlight
  // mark - visually equivalent, serializes back as `<mark>` since
  // that's how it was authored.
  h.html_font_open = (s, t) => {
    const attrs: Record<string, string> = { color: "", face: "", size: "" };
    for (const [name, value] of (t.attrs) ?? []) {
      if (name === "color" || name === "face" || name === "size") {
        attrs[name] = value;
      }
    }
    s.openMark(schema.marks.font, attrs);
  };
  h.html_font_close = (s) => s.closeMark(schema.marks.font);
  h.html_underline_open = (s) => s.openMark(schema.marks.underline);
  h.html_underline_close = (s) => s.closeMark(schema.marks.underline);
  h.html_sup_open = (s) => s.openMark(schema.marks.superscript);
  h.html_sup_close = (s) => s.closeMark(schema.marks.superscript);
  h.html_sub_open = (s) => s.openMark(schema.marks.subscript);
  h.html_sub_close = (s) => s.closeMark(schema.marks.subscript);
  h.html_kbd_open = (s) => s.openMark(schema.marks.kbd);
  h.html_kbd_close = (s) => s.closeMark(schema.marks.kbd);
  // <mark> opens the highlight mark. We deliberately DON'T set the
  // `html: true` attr here - the form choice is cosmetic, and keeping
  // the attr breaks round-trip when overlap forces HTML form:
  // a doc with `==` highlight (html=false) serializes as `<mark>`,
  // re-parses as html=true, mark.eq() fails, save guard fires.
  // Dropping the flag means a user-authored `<mark>` source normalizes
  // to `==` on first save - one-time, same shape as Butter's other
  // first-save normalizations.
  h.html_mark_open = (s, t) => {
    // `<mark>` opens highlight. When the tag carries `style="background-
    // color: …"`, capture that color so the user's custom highlight
    // colour survives round-trip. Whitespace + casing on the property
    // name are normalised; both `background` and `background-color`
    // are accepted because Obsidian's own MarkdownRenderer treats the
    // shorthand as the highlight colour.
    let color: string | null = null;
    for (const [name, value] of (t.attrs) ?? []) {
      if (name === "style") {
        const m = /background(?:-color)?\s*:\s*([^;]+)/i.exec(value);
        if (m) color = m[1].trim();
      }
    }
    // We deliberately DON'T set the `html: true` attr (form choice is
    // cosmetic for plain highlights; see longer rationale in the
    // serializer notes). Color, when present, forces HTML form on
    // serialize regardless.
    s.openMark(schema.marks.highlight, color ? { color } : undefined);
  };
  h.html_mark_close = (s) => s.closeMark(schema.marks.highlight);
  // <strong> / <em> map to the same PM marks as `**` / `*`. The
  // serializer emits these HTML forms only when a mark instance
  // overlaps another mark in the same paragraph (CommonMark emphasis
  // pairs require strict nesting; HTML tags survive cross-overlap via
  // the any-match close rule in htmlInlineTagsPlugin). On parse, both
  // forms produce identical PM marks - there's no `html` attr because
  // the serializer recomputes overlap each time, so the form choice
  // re-emerges from the doc structure rather than being persisted.
  h.html_strong_open = (s) => s.openMark(schema.marks.strong);
  h.html_strong_close = (s) => s.closeMark(schema.marks.strong);
  h.html_em_open = (s) => s.openMark(schema.marks.em);
  h.html_em_close = (s) => s.closeMark(schema.marks.em);
  // <s> and <del> both open the strikethrough mark (HTML5 treats
  // them with subtly different semantics, but we collapse to one
  // PM mark for simplicity - the serializer always emits <s> on
  // overlap). Without these handlers, a serialized `<s>...</s>`
  // round-trips as literal text inside whatever surrounded it.
  h.html_s_open = (s) => s.openMark(schema.marks.strikethrough);
  h.html_s_close = (s) => s.closeMark(schema.marks.strikethrough);
  h.html_del_open = (s) => s.openMark(schema.marks.strikethrough);
  h.html_del_close = (s) => s.closeMark(schema.marks.strikethrough);
  h.link_open = (s, t) =>
    s.openMark(schema.marks.link, {
      href: t.attrGet("href"),
      title: t.attrGet("title") || null,
    });
  h.link_close = (s) => s.closeMark(schema.marks.link);

  // code_inline: single token -> open mark, add text, close mark
  h.code_inline = (s, t) => {
    s.openMark(schema.marks.code);
    s.addText(t.content);
    s.closeMark(schema.marks.code);
  };

  // Inline leaf nodes
  // Heading-internal hard/soft breaks (from setext-style multi-line
  // headings like `text\ntext\n---`) collapse to a single space.
  // Multi-line heading content otherwise re-parses as a heading + a
  // paragraph after one save cycle and trips the round-trip guard:
  // ATX serialization (`## ` + inline) emits the embedded newline
  // verbatim, then `## first\nsecond` re-parses as h2 + paragraph.
  // Collapsing at parse time keeps the doc's inline shape stable.
  h.hardbreak = (s) => {
    if (s.top().type.name === "heading") s.addText(" ");
    else s.addNode(schema.nodes.hard_break);
  };
  h.softbreak = (s) => {
    if (s.top().type.name === "heading") s.addText(" ");
    else s.addNode(schema.nodes.softbreak);
  };
  h.text = (s, t) => {
    // Inside a table cell, GFM convention encodes a cell-internal
    // line break as `<br>` (LP and Reading mode use this; our cell
    // serializer also emits `<br>` for softbreaks/hardbreaks). Our
    // markdown-it instance is configured `html: false` so `<br>`
    // doesn't tokenize as `html_inline` - it stays as part of a
    // `text` token. Detect it here when we're parsing inline
    // content inside a `table_header` / `table_cell` and split on
    // the `<br>` markers, inserting softbreak nodes between
    // segments. Round-trip then preserves the user's Shift+Enter.
    const topName = s.top().type.name;
    const inCell = topName === "table_cell" || topName === "table_header";
    if (inCell && /<br\s*\/?>/i.test(t.content)) {
      const parts = t.content.split(/<br\s*\/?>/i);
      parts.forEach((part, i) => {
        if (i > 0) s.addNode(schema.nodes.softbreak);
        if (part) s.addText(part);
      });
      return;
    }
    s.addText(t.content);
  };

  h.image = (s, t) => {
    const rawAlt: string = t.children?.[0]?.content ?? "";
    // `|full` (case-insensitive) marks Butter's full-column-width
    // display mode. Lives in the same alt-suffix slot as `|WIDTH`
    // so it survives round-trip through any Obsidian-aware parser.
    // Non-Butter renderers see "alt|full" as alt text - image still
    // shows, just at natural size.
    const fullMatch = rawAlt.match(/^(.*?)\|full$/i);
    if (fullMatch) {
      s.addNode(schema.nodes.image, {
        src: t.attrGet("src"),
        alt: fullMatch[1] || null,
        title: t.attrGet("title") || null,
        width: null,
        height: null,
        displayMode: "full",
      });
      return;
    }
    const m = rawAlt.match(/^(.*?)\|(\d+)(?:x(\d+))?$/);
    s.addNode(schema.nodes.image, m
      ? {
          src: t.attrGet("src"), alt: m[1] || null,
          title: t.attrGet("title") || null,
          width: parseInt(m[2], 10),
          height: m[3] ? parseInt(m[3], 10) : null,
          displayMode: null,
        }
      : {
          src: t.attrGet("src"), alt: rawAlt || null,
          title: t.attrGet("title") || null,
          width: null, height: null,
          displayMode: null,
        });
  };

  h.wikilink = (s, t) =>
    s.addNode(schema.nodes.wikilink, {
      target: metaStr(t, "target") || t.content,
      alias: metaStr(t, "alias"),
    });
  h.obsidian_tag = (s, t) =>
    s.addNode(schema.nodes.obsidian_tag, { tag: t.content });
  h.inline_math = (s, t) =>
    s.addNode(schema.nodes.inline_math, { value: t.content });
  h.obsidian_embed_inline = (s, t) =>
    s.addNode(schema.nodes.obsidian_embed_inline, { src: t.content });
  h.inline_footnote = (s, t) =>
    s.addNode(schema.nodes.inline_footnote, { content: t.content });
  h.footnote_ref = (s, t) =>
    s.addNode(schema.nodes.footnote_ref, { label: t.content });
  h.block_id = (s, t) =>
    s.addNode(schema.nodes.block_id, { id: t.content });

  return h;
}

// Mutable handler table - extension handlers are added via the
// late-apply hook registered below, which fires both for
// pre-bridge-init registrations (catchup) and for runtime ones.
export const handlers: Record<string, TokenHandler> = { ...buildHandlers() };

// ── Task-list post-processing ──

// Matches the task-item marker at the start of a list item's first
// paragraph. Accepts EITHER `[X] content` (the GFM-canonical form
// with whitespace after the bracket-pair) OR `[X]` at end of string
// (an EMPTY task item - common when the user just toggled a list
// to tasks via `- [ ]` and hasn't typed anything yet). Without the
// `|$` alternative, an empty task item round-trips as a regular
// bullet with literal text `[ ]`, which the fingerprint check
// catches as structural drift and the save guard refuses.
// `m[0]` consumes both the bracket-pair AND the trailing whitespace
// run so removePrefixFromParagraph trims them as a single chunk.
const TASK_RE = /^\[([ xX])\](\s+|$)/;

function removePrefixFromParagraph(para: PMNode, n: number): PMNode {
  const children: PMNode[] = [];
  let remaining = n;
  para.forEach((child) => {
    if (remaining <= 0) { children.push(child); return; }
    if (child.isText) {
      const text = child.text ?? "";
      if (text.length <= remaining) { remaining -= text.length; return; }
      children.push(schema.text(text.slice(remaining), child.marks));
      remaining = 0;
      return;
    }
    children.push(child);
    remaining = 0;
  });
  return para.type.create(para.attrs, Fragment.fromArray(children), para.marks);
}

function transformTaskItems(node: PMNode): PMNode {
  let changed = false;
  const mapped: PMNode[] = [];
  node.forEach((child) => {
    const next = transformTaskItems(child);
    if (next !== child) changed = true;
    mapped.push(next);
  });
  const base = changed
    ? node.type.create(node.attrs, Fragment.fromArray(mapped), node.marks)
    : node;
  if (base.type.name !== "list_item") return base;
  const first = base.firstChild;
  if (!first || first.type.name !== "paragraph") return base;
  const m = first.textContent.match(TASK_RE);
  if (!m) return base;
  const checked = m[1].toLowerCase() === "x";
  const newFirst = removePrefixFromParagraph(first, m[0].length);
  const newChildren: PMNode[] = [newFirst];
  for (let i = 1; i < base.childCount; i++) newChildren.push(base.child(i));
  // Promote bullet → task when we detect the `[ ]` / `[x]` prefix.
  // (markdown-it parses task list items as plain bullet items; the
  // bracket prefix tells us they're really tasks.)
  return base.type.create(
    { ...base.attrs, kind: "task", checked },
    Fragment.fromArray(newChildren),
    base.marks,
  );
}

// ── Public parse ──

export function parse(markdown: string): PMNode | null {
  const tokens = md.parse(markdown, {});
  const state = new ParseState();
  // No source-map context - nodes get no sourceRange attrs.
  for (let i = 0; i < tokens.length; i++) {
    state.currentTokIdx = i;
    const tok = tokens[i];
    const fn = handlers[tok.type];
    if (fn) fn(state, tok);
  }
  while (state.stack.length > 1) state.pop();
  const doc = state.pop();
  return transformTaskItems(doc);
}

/**
 * Source-preserving parse: returns the PM doc AND character-offset
 * ranges for every top-level block - captured in a single pass over
 * the token stream, not bolted on after.
 *
 * Each range is extended to cover the inter-block whitespace that
 * follows it, so `originalBody.slice(range.start, range.end)` for
 * every range concatenates back to the full body. The first range
 * absorbs any leading content; the last absorbs everything to EOF.
 *
 * `blockRanges.length === doc.childCount` when the parse is clean.
 * Callers should verify this and disable preservation on mismatch.
 */
export interface SourceMapResult {
  doc: PMNode;
  blockRanges: Array<{ start: number; end: number }>;
}

/**
 * Wrap a source string in a single raw_block doc so unparseable
 * content still round-trips byte-identically. Used as the error-
 * recovery fallback when parsing throws or produces structural
 * garbage the schema rejects.
 */
function rawBlockFallback(
  markdown: string,
  reason: string,
): SourceMapResult {
  const rawNode = schema.nodes.raw_block.create({
    raw: markdown,
    reason,
    sourceRange: { start: 0, end: markdown.length },
  });
  const doc = schema.nodes.doc.create(null, [rawNode]);
  return { doc, blockRanges: [{ start: 0, end: markdown.length }] };
}

export function parseWithSourceMap(markdown: string): SourceMapResult | null {
  try {
    const result = parseWithSourceMapInner(markdown);
    if (result) {
      // Post-parse byte-coverage check: reconstruct the input from the
      // content-only block ranges + the inter-block gap bytes. Any
      // missed byte means the parse lost structural info (common
      // cases: pure-whitespace input yielding an empty paragraph
      // without a token map; HTML blocks emitted in a token shape we
      // don't fully cover). Rather than silently corrupt on save, fall
      // back to a whole-file raw_block - source preservation holds.
      //
      // Reconstruction = leading-whitespace + block[0].content +
      // gap[0,1] + block[1].content + ... + block[n-1].content +
      // trailing-whitespace.
      //   leading  = markdown.slice(0, firstBlock.start)
      //   gap[i,j] = markdown.slice(block[i].end, block[j].start)
      //   trailing = markdown.slice(lastBlock.end, markdown.length)
      let covered = "";
      let coverageOk = true;
      const n = result.doc.childCount;
      if (n === 0) {
        coverageOk = markdown.length === 0;
      } else {
        for (let i = 0; i < n; i++) {
          const r = result.doc.child(i).attrs.sourceRange as
            | { start: number; end: number }
            | null;
          if (!r || r.start < 0 || r.end < r.start || r.end > markdown.length) {
            coverageOk = false;
            break;
          }
          if (i === 0) covered += markdown.slice(0, r.start); // leading
          covered += markdown.slice(r.start, r.end); // content
          if (i < n - 1) {
            const nextR = result.doc.child(i + 1).attrs.sourceRange as
              | { start: number; end: number }
              | null;
            if (!nextR || nextR.start < r.end) {
              coverageOk = false;
              break;
            }
            covered += markdown.slice(r.end, nextR.start); // gap
          } else {
            covered += markdown.slice(r.end, markdown.length); // trailing
          }
        }
      }
      if (!coverageOk || covered !== markdown) {
        console.warn(
          "[butter-pmx] parse did not cover every byte of input",
          {
            inputBytes: markdown.length,
            childCount: result.doc.childCount,
            firstUncoveredIndex: covered.length,
          },
        );
        return rawBlockFallback(
          markdown,
          "parse did not cover every byte of the input",
        );
      }
    }
    return result;
  } catch (err) {
    // Any parse-time exception - markdown-it tokenizer throwing, a
    // handler throwing on a malformed token shape, schema validation
    // refusing to create a node - falls through to a full-file raw
    // block. Bytes preserve verbatim on save; user sees a diagnostic.
    //
    // Log the full stack to the console so the dev can see WHERE the
    // failure happened. Without this, the diagnostic banner only
    // shows name + message, which is rarely enough to debug.
    const errObj = err instanceof Error ? err : new Error(String(err));
    console.error(
      "[butter-pmx] parseWithSourceMap threw - falling back to raw_block. Input length:",
      markdown.length,
    );
    console.error(errObj);
    const reason = `${errObj.name}: ${errObj.message}`;
    return rawBlockFallback(markdown, reason);
  }
}

/**
 * Expected source pattern for an inline atom node. When the atom's
 * attrs match its canonical markdown form (which they do for every
 * construct in Butter's schema - proven by 92/92 round-trip tests),
 * this pattern appears verbatim in the parent block's source bytes.
 * We search for it to recover the atom's byte range for byte-level
 * preservation within edited blocks.
 */
// Extension-registered inline-atom source patterns. Ordered list so
// multiple extensions can contribute patterns for the same node type
// (e.g., two extensions that both render variations of a `mention`
// atom). The lookup iterates in registration order; the first pattern
// that returns a non-null string wins. Falls through to the built-in
// switch after all extensions abstain.
export const extensionSourcePatterns: Array<{
  name: string;
  fn: (node: unknown) => string | null;
}> = [];

function inlineAtomPattern(node: PMNode): string | null {
  // Try extension patterns. Each pattern is gated on its registered
  // node type so an extension's pattern fn isn't called for unrelated
  // nodes (which could return a misleading truthy default).
  for (const { name, fn } of extensionSourcePatterns) {
    if (node.type.name !== name) continue;
    try {
      const p = fn(node);
      if (p) return p;
    } catch { /* skip and try the next */ }
  }
  switch (node.type.name) {
    case "wikilink": {
      const target = (node.attrs.target as string) || "";
      const alias = (node.attrs.alias as string) || "";
      return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
    }
    case "obsidian_tag":
      return `#${node.attrs.tag as string}`;
    case "inline_math":
      return `$${node.attrs.value as string}$`;
    case "obsidian_embed_inline":
      return `![[${node.attrs.src as string}]]`;
    case "inline_footnote":
      return `^[${node.attrs.content as string}]`;
    case "footnote_ref":
      return `[^${node.attrs.label as string}]`;
    case "block_id":
      return `^${node.attrs.id as string}`;
    case "image": {
      const src = (node.attrs.src as string) || "";
      const alt = (node.attrs.alt as string) || "";
      const title = (node.attrs.title as string) || "";
      const width = node.attrs.width as number | null;
      const height = node.attrs.height as number | null;
      const displayMode = node.attrs.displayMode as string | null;
      let altStr = alt;
      if (displayMode === "full") {
        altStr = altStr ? `${altStr}|full` : "|full";
      } else if (width) {
        const sizeSuffix = height ? `|${width}x${height}` : `|${width}`;
        altStr = altStr ? `${altStr}${sizeSuffix}` : sizeSuffix;
      }
      return `![${altStr}](${src}${title ? ` "${title}"` : ""})`;
    }
    default:
      return null;
  }
}

/**
 * Post-parse walk: for each inline atom in the doc, find its
 * expected source pattern in the containing block's source bytes
 * and store the character range on the atom's `sourceRange` attr.
 *
 * Order-preserving: advances a cursor through the block's source
 * so two identical patterns (`#tag` + `#tag`) map to their correct
 * positions by appearance order. Falls through gracefully if the
 * pattern isn't found (atom keeps sourceRange: null).
 *
 * Recurses through block containers (callouts, lists, blockquotes,
 * list_items). Each inner textblock is searched within ITS OWN
 * source range, scoped to the block - so an atom in a nested
 * paragraph inside a callout gets the correct absolute byte range.
 */
function populateInlineSourceRanges(
  doc: PMNode,
  originalBody: string,
): PMNode {
  return rebuildForInlineRanges(doc, originalBody);
}

function rebuildForInlineRanges(
  node: PMNode,
  originalBody: string,
): PMNode {
  if (node.isText) return node;

  if (node.isTextblock) {
    return rebuildTextblock(node, originalBody);
  }

  // Container - recurse into children and rebuild if any changed.
  let changed = false;
  const newChildren: PMNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    const next = rebuildForInlineRanges(c, originalBody);
    if (next !== c) changed = true;
    newChildren.push(next);
  }
  if (!changed) return node;
  return node.type.create(
    node.attrs,
    Fragment.fromArray(newChildren),
    node.marks,
  );
}

function rebuildTextblock(
  block: PMNode,
  originalBody: string,
): PMNode {
  const blockRange = block.attrs.sourceRange as
    | { start: number; end: number }
    | null;
  if (!blockRange || blockRange.start < 0 || blockRange.end < blockRange.start)
    return block;

  const blockSource = originalBody.slice(blockRange.start, blockRange.end);
  let cursor = 0;
  let anyChanged = false;
  const newChildren: PMNode[] = [];

  block.forEach((child) => {
    // Text nodes are inline AND `isAtom`-true in PM's model (they're
    // leaves), but their attrs are immutable and `type.create()` on
    // them throws. Filter them out explicitly even though the pattern
    // lookup below should also return null for them.
    if (child.isText || !(child.isInline && child.isAtom)) {
      newChildren.push(child);
      return;
    }
    const pattern = inlineAtomPattern(child);
    if (!pattern) {
      newChildren.push(child);
      return;
    }
    const idx = blockSource.indexOf(pattern, cursor);
    if (idx < 0) {
      newChildren.push(child);
      return;
    }
    const absStart = blockRange.start + idx;
    const absEnd = absStart + pattern.length;
    const prev = child.attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (prev && prev.start === absStart && prev.end === absEnd) {
      newChildren.push(child);
    } else {
      anyChanged = true;
      newChildren.push(
        child.type.create(
          { ...child.attrs, sourceRange: { start: absStart, end: absEnd } },
          child.content,
          child.marks,
        ),
      );
    }
    cursor = idx + pattern.length;
  });

  if (!anyChanged) return block;
  return block.type.create(
    block.attrs,
    Fragment.fromArray(newChildren),
    block.marks,
  );
}

function parseWithSourceMapInner(markdown: string): SourceMapResult | null {
  // Empty / whitespace-only fast path. If we let the ordinary flow
  // run on these inputs, markdown-it produces no tokens ⇒
  // state.stack stays at just the doc frame ⇒ state.pop() calls
  // doc.createAndFill with empty content, which triggers PM's
  // ContentMatch.fillBefore to search for a filling sequence that
  // satisfies `block+`. Against our ~30 block node types that search
  // can recurse until it blows the stack (observed in Electron on
  // new / blank notes). Our buildNode catch recovers, but the
  // synthetic paragraph it inserts has null sourceRange, which the
  // downstream coverage check rejects → whole-file raw_block
  // fallback for what should be a trivial parse.
  //
  // Build the minimal valid doc directly - one empty paragraph with
  // sourceRange {0, length} - no createAndFill recursion possible,
  // coverage check passes trivially. Covers empty, "\n", "\n\n\n",
  // and any pure-whitespace content. Semantically equivalent to the
  // full parse result; serialize path treats the sourceRange as the
  // original whitespace bytes for preservation.
  if (markdown.length === 0 || /^\s*$/.test(markdown)) {
    const emptyPara = schema.nodes.paragraph.create({
      sourceRange: { start: 0, end: markdown.length },
    });
    const doc = schema.nodes.doc.create(null, [emptyPara]);
    return {
      doc,
      blockRanges: [{ start: 0, end: markdown.length }],
    };
  }

  const tokens = md.parse(markdown, {});

  // Pre-compute line-start byte offsets so ParseState can convert
  // markdown-it's 0-indexed line numbers to character positions in
  // O(1) during the token walk.
  const lineStarts: number[] = [0];
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOffset = (line: number) =>
    line < lineStarts.length ? lineStarts[line] : markdown.length;

  // Drive the walk with source-map context so push/addNode auto-
  // attach sourceRange attrs to created nodes.
  const state = new ParseState();
  state.tokens = tokens;
  state.lineStarts = lineStarts;
  state.totalLen = markdown.length;

  for (let i = 0; i < tokens.length; i++) {
    state.currentTokIdx = i;
    const tok = tokens[i];
    const fn = handlers[tok.type];
    if (fn) fn(state, tok);
  }

  while (state.stack.length > 1) state.pop();
  const doc = transformTaskItems(state.pop());

  // ── Populate inline-atom sourceRanges via pattern search ──
  // markdown-it's inline tokens don't carry character positions, so
  // we post-process: for each inline atom (wikilink, tag, math,
  // embed, footnote ref, etc.), compute its expected source pattern
  // and search for it in the containing block's source bytes. This
  // is the byte-level preservation story for WITHIN an edited block.
  const docWithInlineRanges = populateInlineSourceRanges(doc, markdown);

  // ── Collect top-level block ranges (content-only) ──
  // Each block's sourceRange is [contentStart, contentEnd) as
  // reported by ParseState.currentRange() - the actual block bytes
  // including the content's line-ending \n, exclusive of any
  // inter-block blank lines.
  //
  // This is the CONTENT-ONLY model (contrast: earlier versions widened
  // each range to absorb trailing whitespace up to the next block's
  // start). The serializer reconstructs the full file by interleaving
  // content with computed inter-block gaps (see serializeWithSource-
  // Preservation). Keeping content and gaps separate means dragged
  // blocks don't carry their original neighbors' whitespace with them
  // - gaps are a property of the block-PAIR, not the block.
  const blockRanges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < docWithInlineRanges.childCount; i++) {
    const r = docWithInlineRanges.child(i).attrs.sourceRange as
      | { start: number; end: number }
      | null;
    blockRanges.push(r ?? { start: -1, end: -1 });
  }

  // Silence unused-helper warning - lineOffset is kept around in case
  // callers want to do their own line math.
  void lineOffset;

  return { doc: docWithInlineRanges, blockRanges };
}

// ═══════════════════════════════════════════════
//  INCREMENTAL PARSE
// ═══════════════════════════════════════════════

/**
 * Common-prefix + common-suffix diff. Returns the byte range that
 * changed between `oldBody` and `newBody`. For a single contiguous
 * edit this is exact. For multi-region edits, this returns the
 * smallest range that covers all the changes - which means the
 * incremental parser sees them as one big change and (usually)
 * falls back to full parse.
 */
function findChangedByteRange(oldBody: string, newBody: string): {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
} {
  let prefix = 0;
  const maxPrefix = Math.min(oldBody.length, newBody.length);
  while (prefix < maxPrefix && oldBody[prefix] === newBody[prefix]) prefix++;

  let oldEnd = oldBody.length;
  let newEnd = newBody.length;
  while (
    oldEnd > prefix &&
    newEnd > prefix &&
    oldBody[oldEnd - 1] === newBody[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  return { oldStart: prefix, oldEnd, newStart: prefix, newEnd };
}

/**
 * Incremental parse. When the diff fits inside exactly one
 * top-level block, reparse that block in isolation and splice the
 * result into oldDoc. Surviving blocks keep their JS references
 * (source-preservation invariant: unedited blocks are reference-
 * identical → emit original bytes on save).
 *
 * Returns null to signal "fall back to full parseWithSourceMap" on:
 *   - changes spanning multiple blocks,
 *   - changes at block boundaries we can't cleanly handle,
 *   - reparse producing an unexpected number of blocks,
 *   - any parse error in the isolated sub-parse.
 */
export function parseIncrementally(
  oldBody: string,
  newBody: string,
  oldDoc: PMNode,
): SourceMapResult | null {
  if (oldBody === newBody) {
    // No-op change - trivially reuse oldDoc. Recompute blockRanges
    // from the doc's existing sourceRange attrs.
    const blockRanges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < oldDoc.childCount; i++) {
      const r = oldDoc.child(i).attrs.sourceRange as
        | { start: number; end: number }
        | null;
      blockRanges.push(r ?? { start: -1, end: -1 });
    }
    return { doc: oldDoc, blockRanges };
  }

  const { oldStart, oldEnd, newStart, newEnd } = findChangedByteRange(
    oldBody,
    newBody,
  );

  // Identify the block in oldDoc whose sourceRange strictly contains
  // the changed byte range [oldStart, oldEnd).
  //
  // Pure insertions at block boundaries (oldStart === oldEnd and
  // equals block.start or block.end) are ambiguous - could be the
  // end of this block or the start of the next. Fall back to full
  // parse for safety; markdown-it determines the structural
  // assignment correctly in the global context.
  let targetIdx = -1;
  for (let i = 0; i < oldDoc.childCount; i++) {
    const r = oldDoc.child(i).attrs.sourceRange as
      | { start: number; end: number }
      | null;
    if (!r) return null; // missing range ⇒ fall back
    if (r.start <= oldStart && oldEnd <= r.end) {
      const insertionAtBoundary =
        oldStart === oldEnd &&
        (oldStart === r.start || oldStart === r.end);
      if (insertionAtBoundary) return null;
      targetIdx = i;
      break;
    }
  }
  if (targetIdx < 0) return null; // change crosses a block boundary

  const target = oldDoc.child(targetIdx);
  const targetRange = target.attrs.sourceRange as { start: number; end: number };

  // Compute the block's new byte range in newBody.
  const delta = (newEnd - newStart) - (oldEnd - oldStart);
  const newBlockStart = targetRange.start;
  const newBlockEnd = targetRange.end + delta;
  const newBlockBody = newBody.slice(newBlockStart, newBlockEnd);

  // Parse the isolated block's new body. It should produce exactly
  // one top-level block of the same shape; if not, fall back.
  const subResult = parseWithSourceMap(newBlockBody);
  if (!subResult || subResult.doc.childCount !== 1) return null;

  const newBlock = subResult.doc.firstChild!;

  // Structural change detection: if the sub-parsed block's TYPE differs
  // from the original (e.g., was list_item, edit dropped the marker so
  // now parses as paragraph), the full-document context might absorb
  // this content into a sibling block (markdown-it merges adjacent
  // paragraph-like content into list-item continuations). Falling back
  // to full parse is the safe choice; otherwise our spliced doc has a
  // shape that diverges from what a from-scratch parse would produce.
  if (newBlock.type !== target.type) return null;
  // Same defense for list_item shape: if the kind/depth/checked/start
  // attrs differ, the marker structure changed and a full parse would
  // re-evaluate the surrounding list context.
  if (target.type.name === "list_item") {
    const t = target.attrs as {
      kind?: unknown; depth?: unknown; checked?: unknown; start?: unknown;
    };
    const n = newBlock.attrs as {
      kind?: unknown; depth?: unknown; checked?: unknown; start?: unknown;
    };
    if (
      t.kind !== n.kind ||
      t.depth !== n.depth ||
      t.checked !== n.checked ||
      t.start !== n.start
    ) {
      return null;
    }
  }
  // Adjust the new block's sourceRange to point into newBody, not
  // into the sliced sub-body.
  const shiftedNewBlock = newBlock.type.create(
    {
      ...newBlock.attrs,
      sourceRange: { start: newBlockStart, end: newBlockEnd },
    },
    newBlock.content,
    newBlock.marks,
  );

  // Rebuild the doc's children: copy everything before targetIdx
  // verbatim (reference-preserving), substitute the new block,
  // then copy everything after - with sourceRanges shifted by delta.
  const newChildren: PMNode[] = [];
  const blockRanges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < oldDoc.childCount; i++) {
    if (i < targetIdx) {
      newChildren.push(oldDoc.child(i));
      const r = oldDoc.child(i).attrs.sourceRange as {
        start: number;
        end: number;
      };
      blockRanges.push(r);
    } else if (i === targetIdx) {
      newChildren.push(shiftedNewBlock);
      blockRanges.push({ start: newBlockStart, end: newBlockEnd });
    } else {
      const r = oldDoc.child(i).attrs.sourceRange as {
        start: number;
        end: number;
      };
      const shifted = { start: r.start + delta, end: r.end + delta };
      newChildren.push(
        oldDoc.child(i).type.create(
          { ...oldDoc.child(i).attrs, sourceRange: shifted },
          oldDoc.child(i).content,
          oldDoc.child(i).marks,
        ),
      );
      blockRanges.push(shifted);
    }
  }

  // Byte-coverage sanity: reconstruct newBody from content-only ranges
  // interleaved with inter-block gaps (leading + content + gap + ... +
  // trailing). If the assembled bytes don't match newBody exactly, the
  // delta math was off - fall back to full parse.
  let covered = "";
  const nRanges = blockRanges.length;
  if (nRanges === 0) {
    if (newBody.length !== 0) return null;
  } else {
    for (let i = 0; i < nRanges; i++) {
      const r = blockRanges[i];
      if (i === 0) covered += newBody.slice(0, r.start);
      covered += newBody.slice(r.start, r.end);
      if (i < nRanges - 1) {
        covered += newBody.slice(r.end, blockRanges[i + 1].start);
      } else {
        covered += newBody.slice(r.end, newBody.length);
      }
    }
    if (covered !== newBody) return null;
  }

  const newDoc = oldDoc.type.create(
    oldDoc.attrs,
    Fragment.fromArray(newChildren),
    oldDoc.marks,
  );
  return { doc: newDoc, blockRanges };
}

// ═══════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════
