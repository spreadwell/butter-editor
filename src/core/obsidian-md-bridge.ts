import { Node as PMNode } from "prosemirror-model";
import { __mdit } from "./bridge/common";
import * as bridgeParser from "./bridge/parser";
import * as bridgeSerializer from "./bridge/serializer";
import { handlers, extensionSourcePatterns, parse, parseWithSourceMap, parseIncrementally, type SourceMapResult } from "./bridge/parser";
import { markSpecs, nodeSer, serialize, serializeWithSourcePreservation } from "./bridge/serializer";
import { setBridgeExtensionHandler, type ButterExtension } from "../integration/extensions";
import type { CanonicalFormOptions } from "./bridge/common";

const md = __mdit;


// ── Late-apply hook: wire extensions into live tables ──────────
// Handles both pre-bridge-init registrations (caught up by
// setBridgeExtensionHandler's initial loop) AND runtime registrations.
//
// Schema additions are NOT applied here - the PM schema is immutable
// after construction. An extension introducing a brand-new schema
// node name must register before ./schema evaluates its module body
// (i.e., via side-effect imports ordered before `import ./schema`).
setBridgeExtensionHandler((extension: ButterExtension) => {
  if (extension.installMarkdown) {
    try {
      extension.installMarkdown(md);
    } catch (err) {
      console.warn(
        `[butter] extension "${extension.name}" Markdown installer failed:`,
        err,
      );
    }
  }
  for (const [name, handler] of Object.entries(
    extension.tokenHandlers ?? {},
  )) {
    if (handlers[name]) {
      console.warn(
        `[butter] extension "${extension.name}" token handler "${name}" conflicts with an existing handler; keeping the existing owner.`,
      );
    } else {
      handlers[name] = handler;
    }
  }
  for (const [name, serializer] of Object.entries(
    extension.nodeSerializers ?? {},
  )) {
    if (nodeSer[name]) {
      console.warn(
        `[butter] extension "${extension.name}" node serializer "${name}" conflicts with an existing serializer; keeping the existing owner.`,
      );
    } else {
      nodeSer[name] = serializer;
    }
  }
  for (const [name, serializer] of Object.entries(
    extension.markSerializers ?? {},
  )) {
    if (markSpecs[name]) {
      console.warn(
        `[butter] extension "${extension.name}" mark serializer "${name}" conflicts with an existing serializer; keeping the existing owner.`,
      );
    } else {
      markSpecs[name] = serializer;
    }
  }
  for (const [name, pattern] of Object.entries(
    extension.sourcePatterns ?? {},
  )) {
    extensionSourcePatterns.push({
      name,
      fn: (node) => pattern(node as PMNode),
    });
  }
});


export const parser = {
  ...bridgeParser,
  /** Parse markdown into a ProseMirror doc. */
  parse(markdown: string): PMNode | null {
    return parse(markdown);
  },

  /**
   * Source-preserving parse (first-class).
   *
   * Returns the PM doc AND per-block character-offset ranges in a
   * single pass - no double-tokenize, no external shim. The ranges
   * are 1:1 with `doc.childCount` when the parse is clean; callers
   * disable preservation on mismatch.
   */
  parseWithSourceMap(markdown: string): SourceMapResult | null {
    return parseWithSourceMap(markdown);
  },

  /**
   * Incremental parse - when the change between `oldBody` and
   * `newBody` is contained within a single top-level block, reparse
   * only that block and splice it into `oldDoc`. Surrounding blocks
   * keep their JS references (source-preservation invariant stays
   * intact: unedited blocks remain reference-identical).
   *
   * Returns `null` when the change spans multiple blocks, crosses a
   * block boundary, or produces an incompatibly-shaped reparse; the
   * caller should fall back to a full `parseWithSourceMap`.
   *
   * This is an optimization hook, not a correctness prerequisite
   * the full parse is already fast (see test-bench.mjs). Useful for
   * very large docs where even a 50ms full parse is noticeable, or
   * as the foundation for live-incremental-editing features.
   */
  parseIncrementally(
    oldBody: string,
    newBody: string,
    oldDoc: PMNode,
  ): SourceMapResult | null {
    return parseIncrementally(oldBody, newBody, oldDoc);
  },
};

export const serializer = {
  ...bridgeSerializer,
  /** Plain serialize - used for round-trip tests and anywhere the
   *  caller wants Butter to re-synthesize the entire doc from scratch.
   *  Optional `options` configure canonical-form preferences (bullet
   *  marker, italic/bold style, fence/HR character). */
  serialize(doc: PMNode, options?: CanonicalFormOptions): string {
    return serialize(doc, options);
  },

  /** Source-preserving serialize - emits original bytes for nodes
   *  still reference-identical to the parse-time doc, synthesizes
   *  fresh for any node whose content (text or structure) has
   *  diverged. `options` apply only to the synthesized blocks; the
   *  preserved bytes pass through unchanged regardless. */
  serializeWithSourcePreservation(
    doc: PMNode,
    originalBody: string,
    originalDoc: PMNode,
    options?: CanonicalFormOptions,
  ): string {
    return serializeWithSourcePreservation(doc, originalBody, originalDoc, options);
  },
};


export type { SourceMapResult, CanonicalFormOptions };
