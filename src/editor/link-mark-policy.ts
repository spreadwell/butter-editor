import type { Attrs, Mark, MarkType, Node as PMNode } from "prosemirror-model";
import type { Command, Transaction } from "prosemirror-state";
import { toggleMark } from "prosemirror-commands";
import { allowsInlineMarkType } from "../core/inline-mark-policy";
import { createInlineLinkOccurrence, projectLinkOccurrences } from "../core/link-occurrence";

/** Explicit link actions reconcile the immediate PM projection as well as the
 * durable source owner; save normalization is not an implicit editing command. */
export function projectExternalLinkTransaction(tr: Transaction): Transaction {
  const projected = projectLinkOccurrences(tr.doc), linkType = tr.doc.type.schema.marks.link;
  projected.descendants((node, position) => {
    if (!node.isInline || !node.isLeaf) return;
    const current = tr.doc.nodeAt(position);
    const desired = linkType.isInSet(node.marks), actual = current && linkType.isInSet(current.marks);
    if (!desired && !actual || desired && actual && desired.eq(actual)) return;
    tr.removeMark(position, position + node.nodeSize, linkType);
    if (desired) tr.addMark(position, position + node.nodeSize, desired);
  });
  return tr;
}

// These atoms own navigation targets. An outer web link would introduce
// competing destinations and nested anchors in Markdown/HTML renderers.
export function acceptsExternalLink(node: PMNode): boolean {
  const linkType = node.type.schema.marks.link;
  return node.isInline && Boolean(linkType) && allowsInlineMarkType(node, linkType);
}

/** Apply links to eligible leaves without replacing navigation atoms. */
export function addExternalLinkMark(tr: Transaction, from: number, to: number, mark: Mark): Transaction {
  if (mark.type.name !== "link") throw new Error("External link policy requires a link mark");
  const ranges: Array<{ from: number; to: number }> = [];
  tr.doc.nodesBetween(from, to, (node, position, parent) => {
    if (!node.isInline || !node.isLeaf || !acceptsExternalLink(node) || !parent?.type.allowsMarkType(mark.type)) return;
    const start = Math.max(from, position);
    const end = Math.min(to, position + node.nodeSize);
    if (end <= start) return;
    const prior = ranges[ranges.length - 1];
    if (prior?.to === start) prior.to = end;
    else ranges.push({ from: start, to: end });
  });
  const ownerType = tr.doc.type.schema.marks.link_occurrence;
  const template = ownerType && ranges.length ? createInlineLinkOccurrence(tr.doc, String(mark.attrs.href), typeof mark.attrs.title === "string" ? mark.attrs.title : null) : null;
  const used = new Set<string>();
  if (template) tr.doc.descendants(node => {
    const owner = ownerType.isInSet(node.marks);
    if (owner) used.add(String(owner.attrs.id));
  });
  let ordinal = template ? Number(String(template.attrs.id).slice(1)) : 0;
  for (const range of ranges) {
    if (ownerType) {
      while (used.has(`g${ordinal}`)) ordinal++;
      const id = `g${ordinal++}`;
      used.add(id);
      tr.removeMark(range.from, range.to, ownerType);
      tr.addMark(range.from, range.to, ownerType.create({ ...template!.attrs, id }));
    }
    tr.addMark(range.from, range.to, mark);
  }
  return projectExternalLinkTransaction(tr);
}

/** PM toggle semantics with one navigation owner for every selected atom. */
export function toggleExternalLink(markType: MarkType, attrs?: Attrs): Command {
  return (state, dispatch, view) => {
    const { selection } = state;
    if (selection.empty) {
      const active = Boolean(markType.isInSet(state.storedMarks ?? selection.$from.marks()));
      return toggleMark(markType, attrs)(state, dispatch ? tr => {
        const ownerType = state.schema.marks.link_occurrence;
        if (ownerType) {
          tr.removeStoredMark(ownerType);
          if (!active) tr.addStoredMark(createInlineLinkOccurrence(tr.doc, String(attrs?.href ?? ""), typeof attrs?.title === "string" ? attrs.title : null));
        }
        dispatch(tr);
      } : undefined, view);
    }
    let eligible = false;
    let active = false;
    for (const range of selection.ranges) {
      state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, _position, parent) => {
        if (!node.isInline || !node.isLeaf || !acceptsExternalLink(node) || !parent?.type.allowsMarkType(markType)) return;
        eligible = true;
        if (markType.isInSet(node.marks)) active = true;
      });
    }
    if (!eligible) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const range of selection.ranges) {
      if (active) {
        tr.removeMark(range.$from.pos, range.$to.pos, markType);
        const ownerType = state.schema.marks.link_occurrence;
        if (ownerType) tr.removeMark(range.$from.pos, range.$to.pos, ownerType);
      }
      else addExternalLinkMark(tr, range.$from.pos, range.$to.pos, markType.create(attrs));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}
