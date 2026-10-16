import { Plugin, PluginKey, type PluginSpec } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { SOURCE_RELOAD_META } from "./source-generation";

type ColorKind = "text" | "highlight";
interface ColorPreview {
  token: symbol;
  decorations: DecorationSet;
}
interface PreviewAction {
  token: symbol;
  color?: string | null;
  kind?: ColorKind;
  clear?: boolean;
}
const key = new PluginKey<ColorPreview | null>("butter-toolbar");

/** Color choices are presentation until Apply. A metadata-only transaction
 * redraws decorations without changing the sole document, stored marks,
 * history or save generation. Native source/selection edits expire the preview. */
export function colorPreviewPlugin(spec: Pick<PluginSpec<ColorPreview | null>, "view"> = {}): Plugin<ColorPreview | null> {
  return new Plugin<ColorPreview | null>({
    key,
    state: {
      init: () => null,
      apply(tr, preview, previous) {
        if (tr.docChanged || tr.getMeta(SOURCE_RELOAD_META) === true ||
          !tr.selection.eq(previous.selection) || tr.storedMarks !== previous.storedMarks) return null;
        const action = tr.getMeta(key) as PreviewAction | undefined;
        if (!action) return preview;
        if (action.clear) return preview?.token === action.token ? null : preview;
        if (!action.kind) return preview;
        const { from, to } = tr.selection;
        const color = action.color ?? (action.kind === "text" ? "var(--text-normal)" : "var(--background-primary)");
        const style = action.kind === "text" ? `color:${color}` : `background-color:${color}`;
        return { token: action.token, decorations: from === to ? DecorationSet.empty
          : DecorationSet.create(tr.doc, [Decoration.inline(from, to, { class: "butter-color-preview", style })]) };
      },
    },
    props: { decorations: state => key.getState(state)?.decorations ?? null },
    view(view) {
      const lifecycle = spec.view?.(view);
      return {
        update(current, previous) {
          const preview = key.getState(current.state);
          if (current.editable === false && preview) clearColorPreview(current, preview.token);
          lifecycle?.update?.(current, previous);
        },
        destroy() { lifecycle?.destroy?.(); },
      };
    },
  });
}

export function showColorPreview(view: EditorView, token: symbol, kind: ColorKind, color: string | null): void {
  if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { token, kind, color } satisfies PreviewAction).setMeta("addToHistory", false));
}

/** Cleanup can run after a reload/read-only transition: it only removes this
 * surface's presentation, never restores old content or another picker. */
export function clearColorPreview(view: EditorView, token: symbol): void {
  if (!view.isDestroyed && key.getState(view.state)?.token === token) {
    view.dispatch(view.state.tr.setMeta(key, { token, clear: true } satisfies PreviewAction).setMeta("addToHistory", false));
  }
}
