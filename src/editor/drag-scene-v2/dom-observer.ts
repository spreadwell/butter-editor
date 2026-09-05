import type { EditorView } from "prosemirror-view";

type PmDomObserver = {
  stop: () => void;
  start: () => void;
  forceFlush?: () => void;
  flush?: () => void;
  queue?: MutationRecord[];
};

const observerSuppression = new WeakMap<
  EditorView,
  { observer: PmDomObserver; depth: number }
>();

/** Hold ProseMirror's DOM observer while Drag Scene owns presentation-only
 * classes and styles. Nested holds share one stop/start lifecycle. */
export function beginObserverSuppression(view: EditorView): () => void {
  const existing = observerSuppression.get(view);
  if (existing) {
    existing.depth += 1;
  } else {
    const observer = (view as EditorView & { domObserver?: PmDomObserver })
      .domObserver;
    if (!observer) return () => {};
    observer.forceFlush?.();
    observer.flush?.();
    observer.stop();
    if (observer.queue) observer.queue.length = 0;
    observerSuppression.set(view, { observer, depth: 1 });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const state = observerSuppression.get(view);
    if (!state) return;
    state.depth -= 1;
    if (state.depth > 0) return;
    observerSuppression.delete(view);
    state.observer.start();
  };
}
