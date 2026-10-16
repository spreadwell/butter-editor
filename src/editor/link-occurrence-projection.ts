import { Mark, type Node as PMNode } from "prosemirror-model";
import { AllSelection, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Transform, AddMarkStep, RemoveMarkStep, ReplaceStep } from "prosemirror-transform";
import { freshenDuplicateLinkOccurrences, hasValidLinkOccurrences, linkOccurrence, projectLinkOccurrences } from "../core/link-occurrence";
import { preparedCommentNavigationDoc } from "./comment-navigation-provenance";

const key = new PluginKey("butter-link-occurrence-projection");

/** Minimal same-position source projection: preserve text, selection and every
 * requested user mark while reconciling derived anchors/reference images. */
export function prepareLinkOccurrenceProjection(doc: PMNode, intent?: Transaction): Transform | null {
  if (!hasValidLinkOccurrences(doc)) return null;
  const target = projectLinkOccurrences(freshenDuplicateLinkOccurrences(prepareWholeWrapperFormatting(doc, intent)));
  if (target === doc || target.eq(doc)) return new Transform(doc);
  const tr = new Transform(doc);
  doc.descendants((node, pos) => {
    if (!node.isInline || !node.isLeaf) return;
    const expected = target.nodeAt(pos);
    if (!expected || expected.type !== node.type || expected.nodeSize !== node.nodeSize || expected.text !== node.text) return;
    if (["image", "empty_link"].includes(node.type.name) && JSON.stringify(expected.attrs) !== JSON.stringify(node.attrs)) tr.setNodeMarkup(pos, undefined, expected.attrs, expected.marks);
    else if (!Mark.sameSet(node.marks, expected.marks)) {
      for (const name of ["link", "link_occurrence"]) {
        const type = doc.type.schema.marks[name];
        const before = type.isInSet(node.marks), after = type.isInSet(expected.marks);
        if (before && after && before.eq(after) || !before && !after) continue;
        if (before) tr.removeMark(pos, pos + node.nodeSize, type);
        if (after) tr.addMark(pos, pos + node.nodeSize, after);
      }
    }
  });
  return tr.doc.eq(target) ? tr : null;
}

/** Only an actual selection containing the visible source wrapper can place
 * new uniform formatting outside an unresolved implicit reference. A partial
 * or label-only selection never acquires extra delimiter formatting/binding. */
function prepareWholeWrapperFormatting(doc: PMNode, intent?: Transaction): PMNode {
  if (!intent || !intent.steps.every(step => step instanceof AddMarkStep || step instanceof RemoveMarkStep)) return doc;
  const formats = new Set(["strong", "em", "strikethrough", "highlight", "code", "underline", "subscript", "superscript", "kbd", "font"]);
  const tr = new Transform(doc);
  for (const step of intent.steps) {
    if (!(step instanceof AddMarkStep) || !formats.has(step.mark.type.name)) continue;
    doc.nodesBetween(Math.max(0, step.from), Math.min(doc.content.size, step.to), (node, pos) => {
      if (!node.inlineContent) return;
      let owner: Mark | undefined, from = 0, to = 0, children: PMNode[] = [];
      const flush = (): void => {
        if (!owner || owner.attrs.syntax !== "reference" || owner.attrs.resolved || owner.attrs.referenceForm === "full" ||
          !(intent.selection instanceof AllSelection || step.from < from && step.to > to) ||
          !children.every(child => step.mark.isInSet(child.marks))) return;
        const current = tr.doc.nodeAt(from);
        const liveOwner = current && linkOccurrence(current) || owner;
        const outer = liveOwner.attrs.labelOuterMarks as Array<{ type: string; attrs: Readonly<Record<string, unknown>> }>;
        if (outer.some(mark => mark.type === step.mark.type.name && JSON.stringify(mark.attrs) === JSON.stringify(step.mark.attrs))) return;
        tr.addMark(from, to, owner.type.create({ ...liveOwner.attrs, labelOuterMarks: [...outer, { type: step.mark.type.name, attrs: step.mark.attrs }] }));
      };
      node.forEach((child, offset) => {
        const next = linkOccurrence(child);
        if (Boolean(owner) !== Boolean(next) || owner && next && !owner.eq(next)) { flush(); children = []; }
        if (!children.length) from = pos + 1 + offset;
        owner = next; to = pos + 1 + offset + child.nodeSize; children.push(child);
      });
      flush(); return false;
    });
  }
  return tr.doc;
}

function touchesOwnership(tr: Transaction): boolean {
  const relevant = (doc: PMNode, from: number, to: number): boolean => {
    let found = false;
    const start = Math.max(0, Math.min(from, doc.content.size)), end = Math.max(start, Math.min(to, doc.content.size));
    doc.nodesBetween(start, end, node => {
      if (linkOccurrence(node) || ["image", "empty_link"].includes(node.type.name) && node.attrs.sourceSyntax === "reference" ||
        ["reference_definition", "footnote_def"].includes(node.type.name)) found = true;
    });
    // A zero-width boundary edit can split/join an adjacent occurrence.
    for (const at of [start, end]) {
      const resolved = doc.resolve(at);
      if (resolved.nodeBefore && linkOccurrence(resolved.nodeBefore) || resolved.nodeAfter && linkOccurrence(resolved.nodeAfter)) found = true;
    }
    return found;
  };
  return tr.steps.some((step, index) => {
    let found = false;
    step.getMap().forEach((oldFrom, oldTo, newFrom, newTo) => {
      found ||= relevant(tr.docs[index], oldFrom, oldTo) || relevant(index + 1 < tr.docs.length ? tr.docs[index + 1] : tr.doc, newFrom, newTo);
    });
    if (!found && "from" in step && "to" in step && typeof step.from === "number" && typeof step.to === "number") found = relevant(tr.docs[index], step.from, step.to) || relevant(tr.doc, step.from, step.to);
    return found;
  });
}

function changesSourceOwnership(tr: Transaction): boolean {
  const different = (left: PMNode | null, right: PMNode | null): boolean => {
    const before = left && linkOccurrence(left), after = right && linkOccurrence(right);
    if (before && after ? !before.eq(after) : Boolean(before) !== Boolean(after)) return true;
    if (left?.type.name === "reference_definition" || right?.type.name === "reference_definition") return left !== right;
    if (left?.type.name === "image" || right?.type.name === "image") return !left || !right || left.type !== right.type || JSON.stringify(left.attrs) !== JSON.stringify(right.attrs);
    return false;
  };
  return tr.steps.some((step, index) => {
    const before = tr.docs[index], after = tr.docs[index + 1] ?? tr.doc, map = step.getMap();
    const inspect = (from: number, to: number, old: boolean): boolean => {
      const doc = old ? before : after, other = old ? after : before;
      const mapping = old ? map : map.invert();
      let changed = false;
      const compare = (node: PMNode, pos: number): void => {
        if (changed || !linkOccurrence(node) && !["image", "reference_definition"].includes(node.type.name)) return;
        const peer = other.nodeAt(Math.max(0, Math.min(other.content.size, mapping.map(pos, 1))));
        changed = old ? different(node, peer) : different(peer, node);
      };
      const start = Math.max(0, Math.min(doc.content.size, from)), end = Math.max(start, Math.min(doc.content.size, to));
      doc.nodesBetween(start, end, compare);
      for (const pos of [start, end]) {
        const resolved = doc.resolve(pos);
        if (resolved.nodeAfter) compare(resolved.nodeAfter, pos);
        if (resolved.nodeBefore) compare(resolved.nodeBefore, pos - resolved.nodeBefore.nodeSize);
      }
      return changed;
    };
    let changed = false;
    map.forEach((oldFrom, oldTo, newFrom, newTo) => { changed ||= inspect(oldFrom, oldTo, true) || inspect(newFrom, newTo, false); });
    if (!changed && "from" in step && "to" in step && typeof step.from === "number" && typeof step.to === "number") changed = inspect(step.from, step.to, true) || inspect(step.from, step.to, false);
    return changed;
  });
}

/** Ordinary text edits use the already qualified literal label codec. They
 * cannot alter source kind, target/key, occurrence boundaries or atoms. */
function inlineTextOnly(tr: Transaction): boolean {
  return tr.steps.length > 0 && tr.steps.every((step, index) => {
    if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd) return false;
    let plain = true;
    step.slice.content.forEach(node => { if (!node.isText || /[\r\n\0]/.test(node.text ?? "")) plain = false; });
    const doc = tr.docs[index], from = doc.resolve(step.from), to = doc.resolve(step.to);
    if (!plain || !from.sameParent(to) || !from.parent.inlineContent) return false;
    doc.nodesBetween(step.from, step.to, node => { if (node.isInline && !node.isText) plain = false; });
    return plain;
  });
}

/** Certify the complete prepared occurrence projection before the triggering
 * edit commits, then apply it in that edit's history event. Unrelated typing
 * never invokes reference parsing or the save oracle through this plugin. */
export function linkOccurrenceProjectionPlugin(validate?: (doc: PMNode) => boolean, onRejected?: () => void): Plugin {
  const prepared = new WeakMap<Transaction, Transform>();
  return new Plugin({
    key,
    filterTransaction(tr) {
      if (!tr.docChanged || tr.getMeta(key) || !touchesOwnership(tr)) return true;
      const projection = prepareLinkOccurrenceProjection(preparedCommentNavigationDoc(tr) ?? tr.doc, tr);
      // Formatting an owned label can change native scope at a nested anchor
      // even when no derived owner attrs change. Certify those deliberate
      // mark operations before commit; ordinary text typing stays scoped and
      // never invokes the whole-note oracle through this plugin.
      const formatted = tr.steps.some(step => (step instanceof AddMarkStep || step instanceof RemoveMarkStep) && step.mark.type.name !== "link_occurrence");
      const ownershipChanged = changesSourceOwnership(tr);
      if (!projection || (ownershipChanged || formatted || projection.steps.length > 0 && !inlineTextOnly(tr)) && validate && !validate(projection.doc)) { onRejected?.(); return false; }
      prepared.set(tr, projection);
      return true;
    },
    appendTransaction(transactions, _oldState, state) {
      const transaction = [...transactions].reverse().find(tr => prepared.has(tr));
      const projection = transaction && prepared.get(transaction);
      if (!projection?.steps.length) return null;
      const tr = state.tr;
      // Append plugins may already have repaired peer source provenance.
      // Reprepare from their final immutable doc rather than replay stale steps.
      const final = prepareLinkOccurrenceProjection(state.doc, transaction);
      if (!final?.steps.length) return null;
      for (const step of final.steps) tr.step(step);
      return tr.setMeta(key, true);
    },
  });
}
