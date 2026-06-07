/**
 * Translate a CM6 DecorationSet (produced by extensions running in
 * the hidden mirror view) into ProseMirror decorations that we render
 * inside the live PM view.
 *
 * Widgets: re-parent the CM6 widget's DOM into a PM widget decoration.
 * Marks:   apply as PM inline decorations (class/attributes).
 * Replace: render widget DOM AND add a "hide-original" class so the
 *          underlying markdown text disappears visually.
 * Line:    resolve the CM6 line's source range, map to PM, apply as
 *          either an inline decoration on the affected text or (if
 *          the line covers an entire top-level block) a node
 *          decoration.
 */
import type { EditorView as CMView } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { Decoration as PMDecoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

import { SourceMap, mdToPM, mdRangeToPM } from "./source-map";

export interface TranslateInput {
  cmView: CMView;
  sourceMap: SourceMap;
  pmDoc: PMNode;
}

function* iterateCMDecorations(view: CMView) {
  const providers = view.state.facet(EditorView.decorations);
  for (const p of providers) {
    const set = typeof p === "function" ? p(view) : p;
    if (!set) continue;
    const iter = set.iter();
    while (iter.value) {
      yield { from: iter.from, to: iter.to, value: iter.value };
      iter.next();
    }
  }
}

function resolveLineRange(
  markdown: string,
  at: number,
): { from: number; to: number } {
  const from = markdown.lastIndexOf("\n", at - 1) + 1;
  const nextNewline = markdown.indexOf("\n", at);
  const to = nextNewline === -1 ? markdown.length : nextNewline;
  return { from, to };
}

export function translateCMDecorations(
  input: TranslateInput,
): DecorationSet {
  const { cmView, sourceMap, pmDoc } = input;
  const docSize = pmDoc.content.size;
  const decos: PMDecoration[] = [];

  for (const d of iterateCMDecorations(cmView)) {
    interface CMSpec {
      widget?: { toDOM(view: CMView): HTMLElement; destroy?: (dom: HTMLElement) => void };
      class?: string;
      line?: boolean;
      attributes?: Record<string, string>;
    }
    const rawSpec = (d.value as unknown as { spec?: CMSpec }).spec;
    const spec: CMSpec = rawSpec ?? {};
    const widget = spec.widget;
    const isReplace = widget !== undefined;

    const { from: pmFrom, to: pmTo } = mdRangeToPM(
      sourceMap,
      d.from,
      d.to,
      docSize,
    );
    const ambiguous = pmFrom === pmTo && d.from !== d.to;

    // ── Widget (replace or point) ──
    if (widget) {
      let dom: HTMLElement;
      try {
        dom = widget.toDOM(cmView);
      } catch {
        continue;
      }
      dom.classList.add("butter-cm6-widget");
      (dom as unknown as { __butterWidget?: typeof widget }).__butterWidget = widget;

      if (isReplace && !ambiguous && pmTo > pmFrom) {
        decos.push(
          PMDecoration.inline(pmFrom, pmTo, {
            class: "butter-cm6-hidden",
          }),
        );
      }

      decos.push(
        PMDecoration.widget(pmFrom, () => dom, {
          side: -1,
          ignoreSelection: true,
          destroy: (node: Node) => {
            const carrier = node as unknown as { __butterWidget?: typeof widget };
            const w = carrier.__butterWidget;
            if (w?.destroy && node.instanceOf(HTMLElement)) {
              w.destroy(node);
            }
          },
        }),
      );
      continue;
    }

    // ── Line decoration ──
    if (spec.class && spec.line) {
      // CM6 line decos are anchored at a single position but apply to
      // the whole source-line. Resolve the line's range, map both
      // ends to PM, and pick the best PM representation.
      const { from: mdLineFrom, to: mdLineTo } = resolveLineRange(
        sourceMap.markdown,
        d.from,
      );
      const pmLineFrom = Math.min(
        Math.max(0, mdToPM(sourceMap, mdLineFrom)),
        docSize,
      );
      const pmLineTo = Math.min(
        Math.max(pmLineFrom, mdToPM(sourceMap, mdLineTo)),
        docSize,
      );

      const containing = findContainingBlock(pmDoc, pmLineFrom);
      if (containing && containing.from === pmLineFrom - 1 && containing.to === pmLineTo + 1) {
        // The entire source line is exactly one top-level block:
        // use a node decoration for the cleanest visual.
        decos.push(
          PMDecoration.node(containing.from, containing.to, {
            class: `butter-cm6-line ${spec.class}`,
          }),
        );
      } else if (pmLineTo > pmLineFrom) {
        // Inline application across the line's text range (e.g. a
        // single line inside a code block).
        decos.push(
          PMDecoration.inline(pmLineFrom, pmLineTo, {
            class: `butter-cm6-line ${spec.class}`,
          }),
        );
      } else if (containing) {
        decos.push(
          PMDecoration.node(containing.from, containing.to, {
            class: `butter-cm6-line ${spec.class}`,
          }),
        );
      }
      continue;
    }

    // ── Mark decoration ──
    if (!ambiguous && pmTo > pmFrom && spec.class) {
      decos.push(
        PMDecoration.inline(pmFrom, pmTo, {
          class: `butter-cm6-mark ${spec.class}`,
          ...(spec.attributes ?? {}),
        }),
      );
    }
  }

  return DecorationSet.create(pmDoc, decos);
}

function findContainingBlock(
  doc: PMNode,
  pos: number,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, nodePos) => {
    if (found) return false;
    if (
      node.isBlock &&
      node.isTextblock &&
      pos >= nodePos &&
      pos <= nodePos + node.nodeSize
    ) {
      found = { from: nodePos, to: nodePos + node.nodeSize };
      return false;
    }
    return !node.isTextblock;
  });
  return found;
}
