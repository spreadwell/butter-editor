/**
 * Butter's bounded extension seam.
 *
 * There is one ProseMirror schema and one editable document model. Extensions
 * may contribute schema specs before that schema is constructed, bridge
 * behavior for Markdown parsing/serialization, and per-editor ProseMirror
 * plugins/NodeViews. They cannot mutate a live schema or introduce another
 * editable projection.
 */
import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type {
  Mark,
  MarkSpec as ProseMirrorMarkSpec,
  Node as PMNode,
  NodeSpec,
} from "prosemirror-model";
import type { Plugin as PMPlugin } from "prosemirror-state";
import type { NodeViewConstructor } from "prosemirror-view";

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

export type TokenHandler = (state: ParseStateLike, token: Token) => void;
export type NodeSerializer = (
  state: SerStateLike,
  node: PMNode,
  parent?: PMNode,
  index?: number,
) => void;

/** Markdown delimiters for one external ProseMirror mark. */
export interface MarkSerializer {
  open: string | ((mark: Mark, parent: PMNode, index: number) => string);
  close: string | ((mark: Mark, parent: PMNode, index: number) => string);
  escape?: boolean;
  expel?: boolean | ((mark: Mark) => boolean);
  rank?: number;
}

/**
 * A single extension registration. `name` identifies the extension; schema
 * node and mark names are the keys of `nodes` and `marks`.
 *
 * Runtime factories are invoked once for each new Butter editor. Returning
 * fresh PM plugins lets ProseMirror own their state and view/destroy lifecycle.
 * NodeViews likewise use ProseMirror's native update/destroy lifecycle.
 */
export interface ButterExtension {
  name: string;

  /** Immutable after schema construction. Register these at module bootstrap. */
  nodes?: Readonly<Record<string, NodeSpec>>;
  marks?: Readonly<Record<string, ProseMirrorMarkSpec>>;

  /** Install Markdown-it rules. May be registered after schema freeze only
   * when every emitted node/mark type already exists in Butter's schema. */
  installMarkdown?: (markdownIt: MarkdownIt) => void;
  tokenHandlers?: Readonly<Record<string, TokenHandler>>;
  nodeSerializers?: Readonly<Record<string, NodeSerializer>>;
  markSerializers?: Readonly<Record<string, MarkSerializer>>;
  sourcePatterns?: Readonly<
    Record<string, (node: PMNode) => string | null>
  >;

  /** Per-editor factories. Registrations affect future editors, never mutate
   * the plugin set or NodeViews of an already-mounted editor. */
  createPlugins?: () => readonly PMPlugin[];
  createNodeViews?: () => Readonly<Record<string, NodeViewConstructor>>;
}

export type ExtensionRuntimePhase = "plugins" | "nodeViews";

export interface ExtensionRuntimeFailure {
  extension: string;
  phase: ExtensionRuntimePhase;
  error: Error;
}

export interface ButterEditorContributions {
  plugins: PMPlugin[];
  nodeViews: Record<string, NodeViewConstructor>;
  failures: ExtensionRuntimeFailure[];
}

const registered: ButterExtension[] = [];
let schemaFrozen = false;

type BridgeApplyHandler = (extension: ButterExtension) => void;
let bridgeApplyHandler: BridgeApplyHandler | null = null;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isPMPlugin(value: unknown): value is PMPlugin {
  return typeof value === "object" && value !== null && "spec" in value;
}

function hasSchemaContributions(extension: ButterExtension): boolean {
  return Object.keys(extension.nodes ?? {}).length > 0 ||
    Object.keys(extension.marks ?? {}).length > 0;
}

/**
 * Register an extension. Duplicate names and post-freeze schema additions are
 * rejected atomically, so a caller never receives a misleading partial
 * registration.
 */
export function registerButterExtension(extension: ButterExtension): boolean {
  const name = extension.name.trim();
  if (!name || registered.some((item) => item.name === name)) return false;
  if (schemaFrozen && hasSchemaContributions(extension)) return false;

  const stored: ButterExtension = {
    ...extension,
    name,
    nodes: extension.nodes ? { ...extension.nodes } : undefined,
    marks: extension.marks ? { ...extension.marks } : undefined,
    tokenHandlers: extension.tokenHandlers
      ? { ...extension.tokenHandlers }
      : undefined,
    nodeSerializers: extension.nodeSerializers
      ? { ...extension.nodeSerializers }
      : undefined,
    markSerializers: extension.markSerializers
      ? { ...extension.markSerializers }
      : undefined,
    sourcePatterns: extension.sourcePatterns
      ? { ...extension.sourcePatterns }
      : undefined,
  };
  registered.push(stored);

  if (bridgeApplyHandler) {
    try {
      bridgeApplyHandler(stored);
    } catch (error) {
      console.warn(`[butter] extension "${name}" bridge apply failed:`, error);
    }
  }
  return true;
}

/**
 * Freeze and return the external schema additions. This is called exactly once
 * by schema.ts before constructing Butter's single ProseMirror Schema.
 */
export function getExtensionSchemaSpecs(): {
  nodes: Record<string, NodeSpec>;
  marks: Record<string, ProseMirrorMarkSpec>;
} {
  schemaFrozen = true;
  const nodes: Record<string, NodeSpec> = {};
  const marks: Record<string, ProseMirrorMarkSpec> = {};
  for (const extension of registered) {
    for (const [name, spec] of Object.entries(extension.nodes ?? {})) {
      if (!(name in nodes)) nodes[name] = { ...spec };
    }
    for (const [name, spec] of Object.entries(extension.marks ?? {})) {
      if (!(name in marks)) marks[name] = { ...spec };
    }
  }
  return { nodes, marks };
}

/** Internal bridge hook. Replacing it replays registrations in order. */
export function setBridgeExtensionHandler(handler: BridgeApplyHandler): void {
  bridgeApplyHandler = handler;
  for (const extension of registered) {
    try {
      handler(extension);
    } catch (error) {
      console.warn(
        `[butter] extension "${extension.name}" bridge catch-up failed:`,
        error,
      );
    }
  }
}

/**
 * Materialize fresh per-editor contributions. A bad factory is isolated to its
 * extension and phase; later extensions still load. ProseMirror then owns the
 * lifecycle of every successfully returned plugin and NodeView.
 */
export function materializeButterEditorExtensions(): ButterEditorContributions {
  const plugins: PMPlugin[] = [];
  const nodeViews: Record<string, NodeViewConstructor> = {};
  const failures: ExtensionRuntimeFailure[] = [];
  const pluginKeys = new Set<object>();

  const fail = (
    extension: ButterExtension,
    phase: ExtensionRuntimePhase,
    error: unknown,
  ): void => {
    const normalized = asError(error);
    failures.push({ extension: extension.name, phase, error: normalized });
    console.warn(
      `[butter] extension "${extension.name}" ${phase} factory failed:`,
      normalized,
    );
  };

  for (const extension of registered) {
    if (extension.createPlugins) {
      try {
        const created: unknown = extension.createPlugins();
        if (!Array.isArray(created)) {
          throw new TypeError("createPlugins() must return an array");
        }
        const pending: PMPlugin[] = [];
        const pendingKeys = new Set<object>();
        for (const candidate of created as unknown[]) {
          if (!isPMPlugin(candidate)) {
            throw new TypeError("createPlugins() returned a non-Plugin value");
          }
          const plugin = candidate;
          const key = plugin.spec.key;
          if (key && (pluginKeys.has(key) || pendingKeys.has(key))) {
            throw new Error("duplicate ProseMirror PluginKey instance");
          }
          if (key) pendingKeys.add(key);
          pending.push(plugin);
        }
        for (const key of pendingKeys) pluginKeys.add(key);
        plugins.push(...pending);
      } catch (error) {
        fail(extension, "plugins", error);
      }
    }

    if (extension.createNodeViews) {
      try {
        const created = extension.createNodeViews();
        if (!created || typeof created !== "object") {
          throw new TypeError("createNodeViews() must return an object");
        }
        const pending: Array<[string, NodeViewConstructor]> = [];
        const pendingNames = new Set<string>();
        for (const [name, constructor] of Object.entries(created)) {
          if (typeof constructor !== "function") {
            throw new TypeError(`NodeView "${name}" is not a function`);
          }
          if (name in nodeViews || pendingNames.has(name)) {
            throw new Error(`duplicate NodeView: ${name}`);
          }
          pendingNames.add(name);
          pending.push([name, constructor]);
        }
        for (const [name, constructor] of pending) {
          nodeViews[name] = constructor;
        }
      } catch (error) {
        fail(extension, "nodeViews", error);
      }
    }
  }

  return { plugins, nodeViews, failures };
}

export function listExtensions(): string[] {
  return registered.map((extension) => extension.name);
}

export function isExtensionSchemaFrozen(): boolean {
  return schemaFrozen;
}
