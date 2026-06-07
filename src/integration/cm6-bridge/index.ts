/**
 * Obsidian plugin-compat bridge for Butter PM.
 *
 * Flow:
 *   1. Collect Obsidian-registered CM6 extensions (filtered to exclude
 *      our own) from `workspace.editorExtensions`.
 *   2. Mount a hidden CM6 mirror view with those extensions, seeded
 *      with the current markdown serialization of our PM doc.
 *   3. On every PM transaction, re-serialize and push the new
 *      markdown into the mirror. Rebuild the PM↔markdown source map.
 *   4. Harvest decorations + atomic ranges from the mirror, translate
 *      via the source map, and surface them inside the live view.
 *   5. Custom `dispatchTransaction` on the mirror catches external
 *      widget-driven changes (e.g. Tasks' checkbox click) and
 *      propagates them back to the PM doc.
 *   6. The mirror's coordsAtPos / posAtCoords are redirected to the
 *      PM view's DOM so tooltip anchors land in the right place.
 */
import { App } from "obsidian";
import {
  Plugin as PMPlugin,
  PluginKey,
  EditorState as PMState,
  Selection,
} from "prosemirror-state";
import type { EditorView as PMView } from "prosemirror-view";
import { DecorationSet } from "prosemirror-view";
import type { Node as PMNode, Schema } from "prosemirror-model";
import type { Extension as CMExtension } from "@codemirror/state";

import { createHeadlessMirror, HeadlessMirror } from "./headless-view";
import { buildSourceMap, SourceMap, pmToMd } from "./source-map";
import { translateCMDecorations } from "./decoration-translator";
import {
  AtomicRange,
  atomicRangesPlugin,
  extractAtomicRangesPM,
} from "./atomic-ranges";

export interface CM6BridgeOptions {
  /** Plugin arrays we registered ourselves - filter them out. */
  ownExtensionArrays?: Set<readonly CMExtension[]>;
  /** Serializer for PM doc → markdown. */
  serialize: (doc: PMNode) => string;
  /** Parser for markdown → PM doc (used for mirror→PM propagation). */
  parse: (markdown: string) => PMNode | null;
  /** Our PM schema (used to build a fallback empty doc). */
  schema: Schema;
}

const decoKey = new PluginKey<DecorationSet>("butter-cm6-bridge-deco");

/**
 * Creates the full bundle of PM plugins that make up the CM6 bridge.
 * Returns two plugins so the caller can include both in the plugin
 * list: the main bridge (observes transactions, emits decorations)
 * plus the atomic-range enforcer (keymap).
 */
export function cm6BridgePlugins(
  app: App,
  options: CM6BridgeOptions,
): PMPlugin[] {
  const { serialize, parse, schema, ownExtensionArrays } = options;

  // ── shared state ─────────────────────────────────────────────
  let mirror: HeadlessMirror | null = null;
  let sourceMap: SourceMap | null = null;
  let lastMarkdown = "";
  let pmView: PMView | null = null;
  let atomicRanges: AtomicRange[] = [];

  // ── helpers ─────────────────────────────────────────────────
  const collectExtensions = (): CMExtension[] => {
    const raw = app.workspace.editorExtensions as unknown;
    if (!Array.isArray(raw)) return [];
    const own = ownExtensionArrays ?? new Set<unknown>();
    const out: CMExtension[] = [];
    for (const entry of raw as unknown[]) {
      if (own.has(entry)) continue;
      if (Array.isArray(entry)) {
        out.push(...(entry as readonly CMExtension[]));
      } else if (entry) {
        out.push(entry as CMExtension);
      }
    }
    return out;
  };

  const ensureMirror = (initialMd: string) => {
    if (mirror) return;
    try {
      mirror = createHeadlessMirror({
        initialMarkdown: initialMd,
        extensions: collectExtensions(),
        onExternalChange: (newMarkdown) => {
          if (!pmView) return;
          // Replace the PM doc with the reparsed markdown. This is
          // the simplest way to faithfully apply an arbitrary
          // extension-driven change (e.g. a checkbox toggle that
          // rewrote `- [ ]` to `- [x]`). Selection is snapshot &
          // restored where possible; the typical case (clicking a
          // widget) has a collapsed selection, which is fine to lose.
          const newDoc = parse(newMarkdown);
          if (!newDoc) return;
          const priorSelHead = pmView.state.selection.head;
          try {
            const newState = PMState.create({
              doc: newDoc,
              schema,
              plugins: pmView.state.plugins,
            });
            pmView.updateState(newState);
            const clamped = Math.min(priorSelHead, newDoc.content.size);
            try {
              const sel = Selection.near(pmView.state.doc.resolve(clamped));
              pmView.dispatch(pmView.state.tr.setSelection(sel));
            } catch {
              // Ignored: best-effort selection restore after external
              // change. Falls back to default cursor position.
            }
            lastMarkdown = newMarkdown;
          } catch (e) {
            console.error("[butter-cm6-bridge] onExternalChange apply:", e);
          }
        },
        getCoordBridge: () => {
          if (!pmView || !sourceMap) return null;
          const map = sourceMap;
          const view = pmView;
          return {
            cmPosToPMPos: (mdPos: number) => {
              const clamped = Math.min(
                Math.max(0, mdPos),
                map.markdown.length,
              );
              const blocks = map.blocks;
              const docSize = view.state.doc.content.size;
              // Inline in the existing lookup with tolerance.
              const spans = map.spans;
              for (const s of spans) {
                if (clamped >= s.mdFrom && clamped <= s.mdTo) {
                  return s.pmFrom + (clamped - s.mdFrom);
                }
              }
              for (const b of blocks) {
                if (clamped >= b.mdFrom && clamped <= b.mdTo) return b.pmFrom;
              }
              return Math.min(docSize, 0);
            },
            pmPosToCMPos: (pmPos: number) => pmToMd(map, pmPos),
            coordsAtPMPos: (pmPos) => {
              try {
                return view.coordsAtPos(pmPos) ?? null;
              } catch {
                return null;
              }
            },
            pmPosAtCoords: (coords) => {
              try {
                const hit = view.posAtCoords({
                  left: coords.x,
                  top: coords.y,
                });
                return hit?.pos ?? null;
              } catch {
                return null;
              }
            },
          };
        },
      });
      lastMarkdown = initialMd;
    } catch (e) {
      console.error("[butter-cm6-bridge] failed to mount mirror:", e);
      mirror = null;
    }
  };

  const syncMirror = (md: string) => {
    if (!mirror) return;
    if (md === lastMarkdown) return;
    try {
      mirror.setMarkdown(md);
      lastMarkdown = md;
    } catch (e) {
      console.error("[butter-cm6-bridge] mirror sync failed:", e);
    }
  };

  const rebuildDecorations = (state: PMState): DecorationSet => {
    if (!mirror) return DecorationSet.empty;
    if (!sourceMap) return DecorationSet.empty;
    try {
      const decos = translateCMDecorations({
        cmView: mirror.view,
        sourceMap,
        pmDoc: state.doc,
      });
      atomicRanges = extractAtomicRangesPM(
        mirror.view,
        sourceMap,
        state.doc.content.size,
      );
      return decos;
    } catch (e) {
      console.error("[butter-cm6-bridge] translate failed:", e);
      return DecorationSet.empty;
    }
  };

  // ── main decoration plugin ──────────────────────────────────
  const decoPlugin = new PMPlugin<DecorationSet>({
    key: decoKey,
    state: {
      init(_, state) {
        const md = safeSerialize(serialize, state.doc);
        sourceMap = buildSourceMap(state.doc, md);
        ensureMirror(md);
        return rebuildDecorations(state);
      },
      apply(tr, old, _oldState, newState) {
        if (!tr.docChanged) return old;
        const md = safeSerialize(serialize, newState.doc);
        sourceMap = buildSourceMap(newState.doc, md);
        syncMirror(md);
        return rebuildDecorations(newState);
      },
    },
    props: {
      decorations(state) {
        return decoKey.getState(state);
      },
    },
    view(view) {
      pmView = view;
      return {
        update() {
          // The state.apply callback already refreshes source map +
          // mirror + decorations. Nothing needed here.
        },
        destroy() {
          mirror?.destroy();
          mirror = null;
          pmView = null;
        },
      };
    },
  });

  // ── atomic ranges enforcer ──────────────────────────────────
  const atomicPlugin = atomicRangesPlugin(() => atomicRanges);

  return [decoPlugin, atomicPlugin];
}

function safeSerialize(
  serialize: (doc: PMNode) => string,
  doc: PMNode,
): string {
  try {
    return serialize(doc);
  } catch {
    return "";
  }
}

// Keep the old name for back-compat with existing callers.
export function cm6BridgePlugin(app: App, options: CM6BridgeOptions): PMPlugin {
  const [deco] = cm6BridgePlugins(app, options);
  return deco;
}
