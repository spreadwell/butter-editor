import { Plugin, PluginKey, type EditorState } from "prosemirror-state";

/** A fresh file reload invalidates deferred UI edits, even when the reloaded
 * bytes or runtime block IDs coincide. Own save reconciliation is not a reload. */
export const SOURCE_RELOAD_META = "butter-source-reload";
const key = new PluginKey<symbol>("butter-source-generation");

export function sourceGenerationPlugin(): Plugin<symbol> {
  return new Plugin<symbol>({
    key,
    state: {
      init: () => Symbol("source-generation"),
      apply: (tr, generation) => tr.getMeta(SOURCE_RELOAD_META) === true
        ? Symbol("source-generation") : generation,
    },
  });
}

export function sourceGeneration(state: EditorState): symbol | null {
  return key.getState(state) ?? null;
}
