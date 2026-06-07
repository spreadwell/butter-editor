/**
 * extensions.ts
 *
 * Extension API for adding new markdown syntax to Butter PMX.
 *
 * Third-party code (a community plugin, a future feature module,
 * anyone who wants to teach Butter a new syntax) registers a
 * ButterSyntaxExtension before the editor mounts. Extensions plug
 * into four places:
 *
 *   1. Schema (ProseMirror NodeSpec added to the schema's node map)
 *   2. Tokenizer (markdown-it rule registered on the shared instance)
 *   3. Parser (token-handler table for the new token types)
 *   4. Serializer (PM node → markdown handler for the new node type)
 *
 * Plus an OPTIONAL source-pattern hook for byte-level preservation:
 * if your extension adds an inline atom, provide `sourcePattern` so
 * its bytes can be recovered from the containing block's source.
 *
 * What the Extension API covers in v1:
 *   • Block node extensions (custom block-level syntax).
 *   • Inline atom extensions (custom inline syntax rendered as atoms).
 *   • Both share one shape - set `nodeSpec.inline` + `nodeSpec.atom`
 *     for inline, `nodeSpec.group = "block"` for block.
 *
 * What's NOT in v1 (documented but deferred):
 *   • Mark extensions (strong/em-style marks): structurally more
 *     intricate because they span multiple tokens and need
 *     open/close markup tracking. Add via PR with care.
 *   • Editor extensions (PM plugins): register those directly in
 *     main.ts's plugin array. Not a syntax concern.
 *   • NodeView extensions: pass via the EditorView `nodeViews`
 *     option. Orthogonal to the syntax/parsing pipeline.
 *
 * Example:
 *
 *   import { registerSyntaxExtension } from "./extensions";
 *
 *   registerSyntaxExtension({
 *     name: "spoiler",
 *     nodeSpec: {
 *       group: "block",
 *       content: "block+",
 *       defining: true,
 *       attrs: { label: { default: "" } },
 *       parseDOM: [{ tag: "div[data-spoiler]" }],
 *       toDOM(node) {
 *         return ["div", { "data-spoiler": node.attrs.label }, 0];
 *       },
 *     },
 *     markdownItRule: (md) => { / * install block-level ::: spoiler parser * / },
 *     tokenHandlers: {
 *       spoiler_open: (s, t) => s.push(schema.nodes.spoiler, { label: t.info }),
 *       spoiler_close: (s) => s.pop(),
 *     },
 *     serializer: (state, node) => {
 *       state.write(`::: spoiler ${node.attrs.label}\n`);
 *       state.renderContent(node);
 *       state.write(":::");
 *       state.closeBlock(node);
 *     },
 *   });
 *
 * Call `registerSyntaxExtension()` at module-load time, BEFORE the
 * editor view is constructed. After construction, the extension's
 * schema / tokenizer / handlers are frozen - re-registering later
 * is a no-op.
 */
import type { NodeSpec } from "prosemirror-model";
import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

/**
 * Minimal, schema-agnostic aliases. Extensions receive the live
 * ParseState + SerState via these opaque types - we don't re-export
 * the internal classes because they're implementation detail of the
 * bridge. Extensions use ParseState's `push` / `pop` / `addNode` /
 * `addText` / `openMark` / `closeMark` API (defined in
 * obsidian-md-bridge.ts), and SerState's `write` / `text` /
 * `renderContent` / `closeBlock` / `wrapBlock` API.
 */
export type ParseStateLike = {
  push(type: unknown, attrs?: Record<string, unknown>): void;
  pop(): unknown;
  addNode(type: unknown, attrs?: Record<string, unknown>): void;
  addText(text: string): void;
  openMark(type: unknown, attrs?: Record<string, unknown>): void;
  closeMark(type: unknown): void;
};

export type SerStateLike = {
  write(s: string): void;
  text(text: string, escape?: boolean): void;
  renderContent(parent: unknown): void;
  renderInline(parent: unknown): void;
  closeBlock(node: unknown): void;
  wrapBlock(
    delim: string,
    firstDelim: string | null,
    node: unknown,
    fn: () => void,
  ): void;
};

export type TokenHandler = (state: ParseStateLike, tok: Token) => void;
export type NodeSerializer = (
  state: SerStateLike,
  node: unknown,
  parent?: unknown,
  index?: number,
) => void;

/**
 * A syntax extension - covers block-level and inline-atom additions.
 *
 * `nodeSpec` shape determines whether it's a block or an inline atom:
 *   • Block: `group: "block"`, `content: "..."`
 *   • Inline atom: `inline: true, atom: true, group: "inline"`
 *
 * `sourceRange` is added automatically to the `attrs` map so your
 * extension participates in Butter's byte-level source-preservation
 * story. Inline-atom extensions SHOULD provide `sourcePattern`
 * a function returning the expected markdown source bytes for a
 * node - so the parser's pattern-search pass can recover byte
 * ranges for preservation under edits.
 */
export interface ButterSyntaxExtension {
  /** Schema node name. Must be unique across registrations. */
  name: string;

  /** ProseMirror NodeSpec. sourceRange attr is auto-added by schema.ts. */
  nodeSpec: NodeSpec;

  /** Install markdown-it plugin rules for recognizing your syntax.
   *  Runs once at bridge initialization. */
  markdownItRule?: (md: MarkdownIt) => void;

  /** Token-handler table. Keys are markdown-it token types your
   *  rule emits (e.g. "spoiler_open", "spoiler_close"). Handlers
   *  call state.push/pop/addNode/addText/openMark/closeMark to
   *  build the PM tree. */
  tokenHandlers?: Record<string, TokenHandler>;

  /** Serialize a PM node of this extension's type back to markdown. */
  serializer?: NodeSerializer;

  /** Return the expected source pattern for an inline-atom node.
   *  Used by the post-parse pattern search to populate `sourceRange`.
   *  Return null if the pattern can't be reconstructed from attrs. */
  sourcePattern?: (node: unknown) => string | null;
}

const registered: ButterSyntaxExtension[] = [];

/**
 * Late-apply hook. The bridge registers a function here during its
 * module init; thereafter, any `registerSyntaxExtension()` call
 * triggers that function with the new extension so its handlers,
 * serializer, source pattern, and markdown-it rule land in the
 * live bridge tables.
 *
 * Schema node specs are NOT applied this way - ProseMirror schemas
 * are immutable after construction. Late-registered extensions that
 * introduce a brand-new schema node name get their handlers/etc.
 * wired but cannot be rendered in the editor until the schema (and
 * therefore the editor view) is rebuilt. Use early-registration
 * (import extension modules before schema.ts imports) for new node
 * types; use late-registration for enhancements that map to existing
 * node types.
 */
type LateApplyHandler = (ext: ButterSyntaxExtension) => void;
let lateApplyHandler: LateApplyHandler | null = null;

/**
 * Register a syntax extension.
 *
 * Returns true if the registration landed, false if an extension
 * with the same name is already registered (first-wins).
 *
 * Before the bridge has finished its module init: the extension is
 * stored in the registry and picked up when the bridge builds its
 * schema / handlers / serializer tables.
 *
 * After the bridge has finished its module init: the extension's
 * markdown-it rule, token handlers, serializer, and source pattern
 * are applied IMMEDIATELY to the live bridge. Schema additions still
 * require an editor rebuild (the PM schema is immutable).
 */
export function registerSyntaxExtension(ext: ButterSyntaxExtension): boolean {
  // Guard against duplicate name overwrites - first-registration wins.
  if (registered.some((e) => e.name === ext.name)) return false;
  registered.push(ext);
  // If the bridge has already initialized, wire the extension in NOW.
  if (lateApplyHandler) {
    try {
      lateApplyHandler(ext);
    } catch (err) {
      console.warn(
        `[butter] extension "${ext.name}" lateApplyHandler threw:`,
        err,
      );
    }
  }
  return true;
}

/** Internal: called by the bridge to receive the late-apply hook.
 *  Idempotent - subsequent calls replace the handler, which is how
 *  bridge re-initialization (rare) can rewire late-apply without
 *  orphaning already-registered extensions. */
export function setBridgeLateApplyHandler(fn: LateApplyHandler): void {
  lateApplyHandler = fn;
  // Apply handler to any extensions that registered before the bridge
  // was ready - fires them in registration order.
  for (const ext of registered) {
    try {
      fn(ext);
    } catch (err) {
      console.warn(
        `[butter] extension "${ext.name}" lateApplyHandler threw during catch-up:`,
        err,
      );
    }
  }
}

/** Internal: called by schema.ts to get extension node specs. */
export function getExtensionNodeSpecs(): Record<string, NodeSpec> {
  const out: Record<string, NodeSpec> = {};
  for (const ext of registered) out[ext.name] = ext.nodeSpec;
  return out;
}

/** Debug: list all currently-registered extensions by name. */
export function listExtensions(): string[] {
  return registered.map((e) => e.name);
}
