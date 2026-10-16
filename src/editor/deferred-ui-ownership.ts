import type { EditorView } from "prosemirror-view";
import { sourceGeneration } from "./source-generation";

interface EditingIntent {
  requestEditing?: () => void;
  onRejected?: () => void;
}

const editingIntents = new WeakMap<EditorView, EditingIntent>();

/** The owning Butter view can end its mobile keyboard lock for an explicit
 * action. Its existing editable policy still decides licensing/read-only. */
export function registerDeferredUiEditingIntent(
  view: EditorView,
  requestEditing?: () => void,
  onRejected?: () => void,
): () => void {
  const intent = { requestEditing, onRejected };
  editingIntents.set(view, intent);
  return () => {
    if (editingIntents.get(view) === intent) editingIntents.delete(view);
  };
}

export interface DeferredUiOwnership {
  canMutate(options?: { explicit?: boolean; quiet?: boolean }): boolean;
  /** Advance only immediately after this surface's own synchronous dispatch. */
  advance(): void;
}

/** A dialog/palette represents the captured source and selection, even when
 * Obsidian later reuses the same PM view for another file. Unrelated edits or
 * selection moves invalidate it; only its own previews advance its snapshot. */
export function captureDeferredUiOwnership(
  view: EditorView,
  getSourcePath?: () => string,
  onRejected?: () => void,
): DeferredUiOwnership {
  const generation = sourceGeneration(view.state);
  const path = getSourcePath?.();
  let doc = view.state.doc;
  let selection = view.state.selection;
  let storedMarks = view.state.storedMarks;
  let notified = false;
  const current = () => !view.isDestroyed &&
    sourceGeneration(view.state) === generation &&
    view.state.doc === doc && view.state.selection.eq(selection) &&
    view.state.storedMarks === storedMarks &&
    (!getSourcePath || getSourcePath() === path);
  return {
    canMutate({ explicit = false, quiet = false } = {}) {
      if (current()) {
        if (explicit && view.editable === false) editingIntents.get(view)?.requestEditing?.();
        if (current() && view.editable !== false) return true;
      }
      if (!quiet && !notified) {
        notified = true;
        (onRejected ?? editingIntents.get(view)?.onRejected)?.();
      }
      return false;
    },
    advance() {
      if (view.isDestroyed || sourceGeneration(view.state) !== generation) return;
      doc = view.state.doc;
      selection = view.state.selection;
      storedMarks = view.state.storedMarks;
    },
  };
}
