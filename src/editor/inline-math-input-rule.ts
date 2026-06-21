import { InputRule } from "prosemirror-inputrules";
import type { Schema } from "prosemirror-model";
import { isInlineMathSource } from "../core/inline-math-delimiters";

export function buildInlineMathInputRule(schema: Schema): InputRule | null {
  const inlineMath = schema.nodes.inline_math;
  if (!inlineMath) return null;

  return new InputRule(
    /(^|[^\\])(\$[^\n$]*(?:\\\$[^\n$]*)*\$)$/,
    (state, match, start, end) => {
      const prefix = match[1] ?? "";
      const source = match[2] ?? "";
      if (!isInlineMathSource(source)) return null;
      const value = source.slice(1, -1);
      const replaceStart = start + prefix.length;
      if (state.doc.resolve(replaceStart).nodeBefore?.type.name === "inline_math") {
        return null;
      }
      const marks = state.selection.$from.marks();
      const node = inlineMath.create({ value, sourceRange: null }, null, marks);
      return state.tr.replaceWith(replaceStart, end, node);
    },
  );
}
