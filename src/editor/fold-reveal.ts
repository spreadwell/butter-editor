import type { EditorView } from "prosemirror-view";

export const REVEAL_CALLOUT_EVENT = "butter-reveal-callout";

export function revealCalloutPosition(view: EditorView, pos: number): void {
  const resolved = view.state.doc.resolve(pos);
  for (let depth = 1; depth <= resolved.depth; depth++) {
    if (resolved.node(depth).type.name !== "obsidian_callout") continue;
    const dom = view.nodeDOM(resolved.before(depth));
    const ownerWindow = view.dom.ownerDocument.win as Window & { Event: typeof Event };
    const event = new ownerWindow.Event(REVEAL_CALLOUT_EVENT);
    dom?.dispatchEvent(event);
  }
}
