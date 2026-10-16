import { Fragment, type Mark, type Node as PMNode } from "prosemirror-model";
import { canEncodeButterFileUtf8 } from "../core/file-shell";
import { projectLiteralCodeContent } from "./code-literal-projection";

interface FieldSpan {
  readonly from: number;
  readonly to: number;
  readonly inlineFrom: number;
  readonly inlineTo: number;
  readonly node: PMNode;
}

function fieldSpans(content: Fragment): { text: string; spans: FieldSpan[] } | null {
  let text = "", supported = true;
  const spans: FieldSpan[] = [];
  content.forEach((node, offset) => {
    const projection = node.isText ? null : projectLiteralCodeContent(Fragment.from(node.mark(
      node.marks.filter(mark => mark.type.name !== "link" && mark.type.name !== "link_occurrence"))));
    let literal = node.isText ? node.text! : "";
    projection?.forEach(child => { literal += child.text ?? ""; });
    if (!node.isText && !projection) { supported = false; return; }
    spans.push({ from: text.length, to: text.length + literal.length, inlineFrom: offset,
      inlineTo: offset + node.nodeSize, node });
    text += literal;
  });
  return supported ? { text, spans } : null;
}

/** The field shows native atom spellings; DOM textBetween omits those atoms. */
export function linkLabelFieldText(content: Fragment): string | null {
  return fieldSpans(content)?.text ?? null;
}

/** A textarea normalizes CR/CRLF before the user edits it. An untouched label
 * and additions surrounding its complete control projection retain original
 * bytes. A changed ambiguous projection is refused rather than treating DOM
 * normalization as user permission to rewrite an opaque payload. */
export function preserveLinkControlText(value: string, control: string, original: string): string | null {
  if (control === original) return value;
  if (value === control) return original;
  const start = control ? value.indexOf(control) : -1;
  return start >= 0 && value.indexOf(control, start + 1) < 0
    ? value.slice(0, start) + original + value.slice(start + control.length) : null;
}

/** Apply literal field edits while retaining each unchanged character's marks
 * and every complete structured atom. Editing an atom's spelling requires its
 * explicit editor; ambiguous duplicate insertion is refused rather than guessed.
 * The bounded comparison runs only on form submission, never ordinary typing. */
export function prepareLinkLabelContent(content: Fragment, value: string): Fragment | null {
  const field = fieldSpans(content);
  if (!field || !canEncodeButterFileUtf8(value) || value.includes("\0")) return null;
  const { text, spans } = field;
  if (value === text) return content;
  const mapping = new Int32Array(text.length).fill(-1);
  // A literal intact label surrounded by new text has an unambiguous identity.
  // Repeated edge whitespace must remain on its original mark interval, rather
  // than being matched to a same-looking space in the newly typed prefix.
  const intact = text ? value.indexOf(text) : -1;
  const surrounded = intact >= 0 && value.indexOf(text, intact + 1) < 0;
  if (surrounded) for (let at = 0; at < text.length; at++) mapping[at] = intact + at;
  else {
    let prefix = 0, suffix = 0;
    while (prefix < text.length && prefix < value.length && text[prefix] === value[prefix]) { mapping[prefix] = prefix; prefix++; }
    while (suffix < text.length - prefix && suffix < value.length - prefix &&
      text[text.length - 1 - suffix] === value[value.length - 1 - suffix]) {
      mapping[text.length - 1 - suffix] = value.length - 1 - suffix; suffix++;
    }
    const before = text.slice(prefix, text.length - suffix), after = value.slice(prefix, value.length - suffix);
    if ((before.length + 1) * (after.length + 1) > 2_000_000) return null;
    const columns = after.length + 1, lengths = new Uint32Array((before.length + 1) * columns);
    for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
      lengths[i * columns + j] = before[i] === after[j] ? lengths[(i + 1) * columns + j + 1] + 1 :
        Math.max(lengths[(i + 1) * columns + j], lengths[i * columns + j + 1]);
    }
    let i = 0, j = 0;
    while (i < before.length && j < after.length) {
      if (before[i] === after[j]) { mapping[prefix + i] = prefix + j; i++; j++; }
      else if (lengths[(i + 1) * columns + j] >= lengths[i * columns + j + 1]) i++;
      else j++;
    }
  }
  const occurrences = (source: string, needle: string): number => {
    let count = 0;
    for (let at = 0; needle && (at = source.indexOf(needle, at)) >= 0; at += needle.length) count++;
    return count;
  };
  for (const span of spans) if (!span.node.isText) {
    const spelling = text.slice(span.from, span.to), start = mapping[span.from];
    if (start < 0 || occurrences(value, spelling) !== occurrences(text, spelling)) return null;
    for (let at = span.from; at < span.to; at++) if (mapping[at] !== start + at - span.from) return null;
  }
  const inlinePosition = (offset: number): number | null => {
    if (offset === text.length) return content.size;
    for (const span of spans) {
      if (offset === span.from) return span.inlineFrom;
      if (offset === span.to) return span.inlineTo;
      if (offset > span.from && offset < span.to) return span.node.isText ? span.inlineFrom + offset - span.from : null;
    }
    return null;
  };
  const marksAt = (offset: number): readonly Mark[] => {
    const span = spans.find(item => offset >= item.from && offset < item.to) ?? spans[spans.length - 1];
    return span?.node.marks.filter(mark => mark.type.name !== "link" && mark.type.name !== "link_occurrence") ?? [];
  };
  const edits: Array<{ from: number; to: number; value: string; fieldAt: number }> = [];
  let oldCursor = 0, newCursor = 0;
  const edit = (oldEnd: number, newEnd: number): boolean => {
    if (oldCursor === oldEnd && newCursor === newEnd) return true;
    const from = inlinePosition(oldCursor), to = inlinePosition(oldEnd);
    if (from === null || to === null) return false;
    edits.push({ from, to, value: value.slice(newCursor, newEnd), fieldAt: oldCursor });
    return true;
  };
  for (let at = 0; at < mapping.length; at++) if (mapping[at] >= 0) {
    if (!edit(at, mapping[at])) return null;
    oldCursor = at + 1; newCursor = mapping[at] + 1;
  }
  if (!edit(text.length, value.length)) return null;
  let result = content;
  const schema = spans[0]?.node.type.schema;
  for (const change of edits.reverse()) {
    if (!schema) return null;
    const inserted = change.value ? Fragment.from(schema.text(change.value, marksAt(change.fieldAt))) : Fragment.empty;
    result = result.cut(0, change.from).append(inserted).append(result.cut(change.to));
  }
  return result;
}
