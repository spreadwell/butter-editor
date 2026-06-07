/**
 * Hidden CM6 EditorView that mirrors our PM document's markdown
 * serialization and runs Obsidian-registered CM6 extensions against
 * it.
 *
 * Change-detection uses two standard CM6 primitives instead of
 * monkey-patching:
 *
 *   • EditorView.updateListener  - observes every state update
 *   • An Annotation-tagged transaction for our PM→mirror sync, so
 *     the listener can distinguish our own pushes from external
 *     dispatches (e.g. Tasks' checkbox toggle → widget click →
 *     view.dispatch).
 *
 * Coordinate queries (coordsAtPos / posAtCoords) have no facet to
 * intercept, so those remain method overrides on the view instance.
 */
import {
  EditorState,
  Extension,
  Annotation,
  Transaction as CMTransaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Tag our own PM→mirror sync transactions so we can recognize them. */
export const butterSyncAnnotation = Annotation.define<boolean>();

export interface HeadlessMirrorOptions {
  initialMarkdown: string;
  extensions: Extension[];
  /** Called when the mirror's doc changed because of an external
   *  dispatch (not our PM→mirror sync). */
  onExternalChange?: (markdown: string, tr: CMTransaction) => void;
  /** Bridge to the PM view's coord queries. */
  getCoordBridge?: () => null | {
    cmPosToPMPos: (mdPos: number) => number;
    pmPosToCMPos: (pmPos: number) => number;
    coordsAtPMPos: (
      pmPos: number,
    ) => { top: number; bottom: number; left: number; right: number } | null;
    pmPosAtCoords: (coords: { x: number; y: number }) => number | null;
  };
}

export interface HeadlessMirror {
  view: EditorView;
  setMarkdown(md: string): void;
  destroy(): void;
}

export function createHeadlessMirror(
  options: HeadlessMirrorOptions,
): HeadlessMirror {
  const { initialMarkdown, extensions, onExternalChange, getCoordBridge } =
    options;

  const container = activeDocument.createElement("div");
  container.className = "butter-cm6-mirror";
  container.addClass("butter-cm6-mirror-hidden");
  container.setAttribute("aria-hidden", "true");
  activeDocument.body.appendChild(container);

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const isOurSync = update.transactions.some(
      (t) => t.annotation(butterSyncAnnotation) === true,
    );
    if (isOurSync) return;
    const lastTr = update.transactions[update.transactions.length - 1];
    if (onExternalChange) {
      try {
        onExternalChange(update.state.doc.toString(), lastTr);
      } catch (e) {
        console.error("[butter-cm6-bridge] onExternalChange failed:", e);
      }
    }
  });

  const state = EditorState.create({
    doc: initialMarkdown,
    extensions: [updateListener, ...extensions],
  });

  const view = new EditorView({ state, parent: container });

  // ── coord-query redirects ───────────────────────────────────
  // Patch CM6's two coord-bridging methods so widget-spawned tooltips
  // anchor against the LIVE PM DOM (where the widget actually visible)
  // rather than the hidden mirror's own DOM. The shimmed view object
  // isn't fully typed here — these are monkey-patched fields, not
  // statics on EditorView — so we use a typed bag for the assignment.
  const origCoordsAtPos = view.coordsAtPos.bind(view);
  const origPosAtCoords = view.posAtCoords.bind(view);

  type CoordPatch = {
    coordsAtPos: typeof view.coordsAtPos;
    posAtCoords: typeof view.posAtCoords;
  };
  const patch = view as unknown as CoordPatch;

  patch.coordsAtPos = (pos, side) => {
    const bridge = getCoordBridge?.();
    if (bridge) {
      try {
        const pmPos = bridge.cmPosToPMPos(pos);
        const coords = bridge.coordsAtPMPos(pmPos);
        if (coords) return coords;
      } catch {
        // Ignored: bridge mapping can throw on stale positions; fall
        // through to the original CM6 path.
      }
    }
    return origCoordsAtPos(pos, side);
  };

  patch.posAtCoords = ((coords: { x: number; y: number }) => {
    const bridge = getCoordBridge?.();
    if (bridge) {
      try {
        const pmPos = bridge.pmPosAtCoords(coords);
        if (pmPos != null) return bridge.pmPosToCMPos(pmPos);
      } catch {
        // Ignored: bridge mapping can throw on stale positions; fall
        // through to the original CM6 path.
      }
    }
    return origPosAtCoords(coords);
  }) as typeof view.posAtCoords;

  const setMarkdown = (md: string) => {
    if (md === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: md },
      annotations: butterSyncAnnotation.of(true),
    });
  };

  const destroy = () => {
    view.destroy();
    container.remove();
  };

  return { view, setMarkdown, destroy };
}
