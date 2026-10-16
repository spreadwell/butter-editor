/** Native reference IDs belong to blocks, never to invented alias carriers. */
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { canSplit, Mapping, ReplaceAroundStep, ReplaceStep, Transform } from "prosemirror-transform";
import { isHistoryTransaction } from "prosemirror-history";
import { nativeInlineSourceReference } from "../core/inline-reference-source";

const key = new PluginKey("butter-native-block-id-conservation");
const declinedCalloutConversion = new PluginKey("butter-declined-callout-title-conversion");
const containers = new Set(["blockquote", "obsidian_callout", "table", "list_item"]);
export type NativeBlockIdConservationEvent = "kept-separate" | "unrepresentable" | "callout-conversion";
const rawTitleReferences = new WeakMap<object, string | null>();

interface Owner {
  readonly node: PMNode;
  readonly pos: number;
  readonly depth: number;
}
interface Anchor {
  readonly node: PMNode;
  readonly pos: number;
  readonly carrier: PMNode;
  readonly id: string;
  readonly fromTitle?: boolean;
  readonly size: number;
}
interface Ownership {
  readonly owner: Owner;
  readonly ids: Anchor[];
}
interface OriginalAnchor {
  readonly group: Ownership;
  readonly anchor: Anchor;
}
interface OwnershipIndex {
  readonly byNode: Map<PMNode, OriginalAnchor>;
  readonly byTitleAttrs: Map<object, OriginalAnchor>;
  readonly byId: Map<string, OriginalAnchor | null>;
}

function titleReference(node: PMNode): string | null {
  if (node.type.name !== "obsidian_callout" || typeof node.attrs.title !== "string" || !node.attrs.title) return null;
  if (rawTitleReferences.has(node.attrs)) return rawTitleReferences.get(node.attrs) ?? null;
  const id = nativeInlineSourceReference(node.attrs.title);
  rawTitleReferences.set(node.attrs, id);
  return id;
}

/** A whole-block converter must not silently omit content or metadata. */
export function markBlockConversionRefusal(tr: Transaction): void {
  tr.setMeta(declinedCalloutConversion, true);
}

export const markCalloutConversionRefusal = markBlockConversionRefusal;

/** Menu callers also dispatch a declined no-step proposal for its notice. */
export function isCalloutConversionRefusal(tr: Transaction): boolean {
  return Boolean(tr.getMeta(declinedCalloutConversion));
}

function metadataOnly(node: PMNode): boolean {
  if (node.type.name !== "paragraph") return false;
  let id = false, other = false;
  node.forEach(child => {
    if (child.type.name === "block_id") id = true;
    else if (!child.isText || child.marks.length > 0 || !/^[ \t]*$/.test(child.text ?? "")) other = true;
  });
  return id && !other;
}

/** Quotes/callouts/tables own their whole body; flat list items own one item. */
function ownerships(doc: PMNode, inlineHosts = false): Ownership[] {
  const result = new Map<number, Ownership>();
  // Carry ancestors and sibling ownership through one tree walk instead of
  // repeatedly resolving positions or searching a large sibling fragment.
  const walk = (node: PMNode, pos: number, depth: number, outer?: Owner, detached?: Owner): void => {
    const own = { node, pos, depth };
    const native = outer ?? (containers.has(node.type.name) ? own : undefined);
    const titleId = inlineHosts ? null : titleReference(node);
    if (titleId) {
      const owner = native ?? own;
      let group = result.get(owner.pos);
      if (!group) { group = { owner, ids: [] }; result.set(owner.pos, group); }
      // Header metadata precedes all body carriers in native cache order.
      // It remains an attribute-owned source reference, not a new PM atom.
      group.ids.push({ node, pos: pos + 1, carrier: node, id: titleId, fromTitle: true, size: 0 });
    }
    if (node.inlineContent) {
      const owner = inlineHosts ? own : native ?? detached ?? own;
      node.forEach((child, offset) => {
        if (child.type.name !== "block_id") return;
        let group = result.get(owner.pos);
        if (!group) {
          group = { owner, ids: [] };
          result.set(owner.pos, group);
        }
        group.ids.push({ node: child, pos: pos + 1 + offset, carrier: node,
          id: child.attrs.id as string, size: child.nodeSize });
      });
      return;
    }
    let previous: Owner | undefined;
    node.forEach((child, offset) => {
      const childPos = (depth === 0 ? 0 : pos + 1) + offset;
      const metadata = metadataOnly(child);
      walk(child, childPos, depth + 1, native, metadata ? previous : undefined);
      // Detached ID-only paragraphs refer to the preceding content block;
      // repeated carriers do not create additional native aliases.
      if (!metadata) previous = { node: child, pos: childPos, depth: depth + 1 };
    });
  };
  walk(doc, -1, 0);
  return [...result.values()];
}

/** Distinct trailing metadata carriers also need distinct inline hosts.
 * Keeping two paragraphs inside one quote preserves its one native owner;
 * merging their ID atoms into one paragraph cannot retain both source forms.
 */
function carriers(doc: PMNode): Ownership[] {
  return ownerships(doc, true);
}

function carrierConflicts(old: OwnershipIndex, current: PMNode): Ownership[] {
  return carriers(current).filter(group => {
    if (group.ids.length < 2) return false;
    const sources = group.ids.map(anchor => previousFor(anchor, old)?.group);
    // Preserve any authored existing carrier form instead of rewriting it
    // because an unrelated structural edit occurred elsewhere.
    return !sources[0] || sources.some(source => source !== sources[0]);
  });
}

/** No document scan for ordinary typing, marks, selection or ID deletion. */
function mayCombineOwners(transactions: readonly Transaction[]): boolean {
  return transactions.some(tr => tr.steps.some((step, index) => {
    if (step instanceof ReplaceAroundStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    let insertsId = false, insertsBlock = false;
    step.slice.content.descendants(node => {
      if (node.type.name === "block_id") insertsId = true;
      if (node.isBlock) insertsBlock = true;
    });
    if (insertsId || insertsBlock) return true;
    const before = tr.docs[index];
    const $from = before.resolve(step.from), $to = before.resolve(step.to);
    return !$from.sameParent($to) || !$from.parent.inlineContent;
  }));
}

function conservedGroups(old: Ownership[], current: PMNode): Ownership[] {
  const byNode = new Map<PMNode, boolean>();
  const byTitleAttrs = new Map<object, boolean>();
  const byId = new Map<string, boolean | null>();
  for (const group of old) {
    // Native evidence: one item caches its first ID; other native owners
    // cache their last. Existing inactive source carriers are not new anchors.
    const active = group.owner.node.type.name === "list_item" ? group.ids[0] : group.ids[group.ids.length - 1];
    for (const anchor of group.ids) {
      const valid = anchor === active;
      byNode.set(anchor.node, valid);
      if (anchor.fromTitle) byTitleAttrs.set(anchor.node.attrs, valid);
      const id = anchor.id;
      byId.set(id, byId.has(id) ? null : valid);
    }
  }
  return ownerships(current).map(group => {
    const ids = group.ids.filter(anchor => {
      const known = byNode.get(anchor.node) ?? (anchor.fromTitle ? byTitleAttrs.get(anchor.node.attrs) : undefined) ?? byId.get(anchor.id);
      return known !== false;
    });
    const active = group.owner.node.type.name === "list_item" ? group.ids[0] : group.ids[group.ids.length - 1];
    // A moved inactive source carrier may acquire native ownership. Allow that
    // promotion only when it cannot suppress a surviving protected reference.
    // Existing inactive aliases retain their authored bytes and appearance.
    if (ids.length > 0 && !ids.includes(active)) {
      ids.push(active);
      ids.sort((left, right) => left.pos - right.pos);
    }
    return { ...group, ids };
  }).filter(group => group.ids.length > 1);
}

function matchingAttrs(left: PMNode, right: PMNode): boolean {
  return left.type === right.type && Object.keys(left.attrs).every(name =>
    name === "sourceRange" || name === "blockId" || left.attrs[name] === right.attrs[name]);
}

function ownershipIndex(groups: Ownership[]): OwnershipIndex {
  const byNode = new Map<PMNode, OriginalAnchor>();
  const byTitleAttrs = new Map<object, OriginalAnchor>();
  const byId = new Map<string, OriginalAnchor | null>();
  for (const group of groups) for (const anchor of group.ids) {
    const original = { group, anchor };
    byNode.set(anchor.node, original);
    if (anchor.fromTitle) byTitleAttrs.set(anchor.node.attrs, original);
    const id = anchor.id;
    byId.set(id, byId.has(id) ? null : original);
  }
  return { byNode, byTitleAttrs, byId };
}

function previousFor(anchor: Anchor, old: OwnershipIndex): OriginalAnchor | undefined {
  return old.byNode.get(anchor.node) ?? (anchor.fromTitle ? old.byTitleAttrs.get(anchor.node.attrs) : undefined)
    ?? old.byId.get(anchor.id) ?? undefined;
}

function leafPositions(doc: PMNode): Map<PMNode, number[]> {
  const result = new Map<PMNode, number[]>();
  doc.descendants((node, pos) => {
    if (!node.isLeaf) return;
    const positions = result.get(node) ?? [];
    positions.push(pos + node.nodeSize);
    result.set(node, positions);
  });
  return result;
}

function batchMapping(transactions: readonly Transaction[]): Mapping {
  const mapping = new Mapping();
  for (const tr of transactions) mapping.appendMapping(tr.mapping);
  return mapping;
}

/** An item's active ID may precede additional owned paragraphs or quotes. */
function partitionPoint(group: Ownership, index: number, old: OwnershipIndex, mapping: Mapping,
  currentLeaves: Map<PMNode, number[]>): number {
  const anchor = group.ids[index];
  const minimum = anchor.pos + anchor.size;
  const maximum = group.ids[index + 1].pos;
  const original = previousFor(anchor, old);
  if (!original) return minimum;
  const previous = original.group;
  const mappedEnd = mapping.map(previous.owner.pos + previous.owner.node.nodeSize - 1, -1);
  if (mappedEnd >= minimum && mappedEnd <= maximum) return mappedEnd;
  // Whole-fragment conversions replace the old range. Retained leaf nodes
  // still reveal the end of that native owner's body inside the new wrapper.
  let boundary = minimum;
  previous.owner.node.descendants((node, offset) => {
    const end = previous.owner.pos + 1 + offset + node.nodeSize;
    // Earlier source carriers moved beyond this anchor are new ownership;
    // they must not extend its old body merely because the leaf is retained.
    if (node.isLeaf && end > original.anchor.pos + original.anchor.size) {
      for (const candidate of currentLeaves.get(node) ?? []) {
        if (candidate >= minimum && candidate <= maximum) boundary = Math.max(boundary, candidate);
      }
    }
  });
  return boundary;
}

function emptySplitBranch(node: PMNode): boolean {
  if (node.type.name === "paragraph") return node.content.size === 0;
  if (!["blockquote", "obsidian_callout", "list_item"].includes(node.type.name)) return false;
  if (node.type.name === "obsidian_callout" && node.attrs.title) return false;
  let empty = true;
  node.forEach(child => { if (!emptySplitBranch(child)) empty = false; });
  return empty;
}

/** Build the exact repair before accepting an edit, without data/UI plugins. */
function prepareRepair(previous: PMNode, current: PMNode, inputMapping: Mapping): Transform | null {
  const tr = new Transform(current);
  for (const nativeOwnership of [true, false]) {
    const stageStart = tr.steps.length;
    const oldGroups = nativeOwnership ? ownerships(previous) : carriers(previous);
    const old = ownershipIndex(oldGroups);
    const conflicts = nativeOwnership ? conservedGroups(oldGroups, tr.doc) : carrierConflicts(old, tr.doc);
    const currentLeaves = leafPositions(tr.doc);
    const mapping = new Mapping();
    mapping.appendMapping(inputMapping);
    mapping.appendMapping(tr.mapping);
    for (let work = conflicts.length - 1; work >= 0; work--) {
      const { owner, ids } = conflicts[work];
      if (["table", "table_cell", "table_header"].includes(owner.node.type.name) || ids.some(anchor =>
        anchor.pos <= owner.pos || anchor.pos >= owner.pos + owner.node.nodeSize - 1)) return null;
      const first = previousFor(ids[0], old)?.group;
      for (let index = ids.length - 2; index >= 0; index--) {
        const at = partitionPoint({ owner, ids }, index, old, mapping, currentLeaves);
        const $at = tr.doc.resolve(at);
        const depth = $at.depth - owner.depth + 1;
        if (depth < 1) return null;
        const next = previousFor(ids[index + 1], old)?.group;
        const restoreRoot = first && next && first.owner.node !== next.owner.node && matchingAttrs(owner.node, first.owner.node) &&
          owner.node.type === next.owner.node.type;
        const types = [];
        for (let nodeDepth = owner.depth; nodeDepth <= $at.depth; nodeDepth++) {
          const present = $at.node(nodeDepth);
          const original = nodeDepth === owner.depth && restoreRoot ? next.owner.node : present;
          const attrs: Record<string, unknown> = { ...original.attrs, sourceRange: null, blockId: null };
          if (nodeDepth === owner.depth && restoreRoot) attrs.blockId = next.owner.node.attrs.blockId;
          // The original title belongs to its first owner, not every copy.
          if (!(nodeDepth === owner.depth && restoreRoot) && present.type.name === "obsidian_callout") attrs.title = "";
          types.push({ type: original.type, attrs });
        }
        if (!canSplit(tr.doc, at, depth, types)) return null;
        tr.split(at, depth, types);
        const $right = tr.doc.resolve(tr.mapping.slice(stageStart).map(at, 1));
        const right = $right.node(owner.depth);
        if (!right.inlineContent && right.childCount > 1 && right.firstChild && emptySplitBranch(right.firstChild)) {
          const without = right.content.cut(right.firstChild.nodeSize);
          if (right.type.validContent(without)) {
            const firstPos = $right.start(owner.depth);
            tr.delete(firstPos, firstPos + right.firstChild.nodeSize);
          }
        }
        tr.setNodeAttribute(owner.pos, "sourceRange", null);
      }
    }
  }
  return tr;
}

function idCounts(doc: PMNode): Map<string, number> {
  const result = new Map<string, number>();
  for (const group of ownerships(doc)) for (const anchor of group.ids) result.set(anchor.id, (result.get(anchor.id) ?? 0) + 1);
  return result;
}

function introducesDuplicate(previous: PMNode, current: PMNode): boolean {
  const old = idCounts(previous);
  return [...idCounts(current)].some(([id, count]) => count > 1 && count > (old.get(id) ?? 0));
}

function activeReferences(doc: PMNode): Map<string, Anchor> {
  const result = new Map<string, Anchor>();
  for (const group of ownerships(doc)) {
    const active = group.owner.node.type.name === "list_item" ? group.ids[0] : group.ids[group.ids.length - 1];
    // Native cache resolves repeated strings to the LAST native owner globally.
    result.set(active.id, active);
  }
  return result;
}

function retargetsSurvivingReference(previous: PMNode, current: PMNode, mapping: Mapping): boolean {
  const present = new Set<PMNode>();
  current.descendants(node => { if (node.type.name === "block_id") present.add(node); });
  const next = activeReferences(current);
  const byNode = new Map<PMNode, Anchor>(), byAttrs = new Map<object, Anchor>();
  const byBlockId = new Map<string, Anchor>(), byPos = new Map<number, Anchor>();
  for (const group of ownerships(current)) for (const anchor of group.ids) {
    if (!anchor.fromTitle) continue;
    byNode.set(anchor.node, anchor);
    byAttrs.set(anchor.node.attrs, anchor);
    if (typeof anchor.node.attrs.blockId === "string") byBlockId.set(anchor.node.attrs.blockId, anchor);
    byPos.set(anchor.pos, anchor);
  }
  return [...activeReferences(previous)].some(([id, active]) => {
    if (!active.fromTitle) return present.has(active.node) && next.get(id)?.node !== active.node;
    const origin = byNode.get(active.node) ?? byAttrs.get(active.node.attrs) ??
      (typeof active.node.attrs.blockId === "string" ? byBlockId.get(active.node.attrs.blockId) : undefined) ??
      byPos.get(mapping.map(active.pos, 1));
    const activeNow = next.get(id);
    return Boolean(origin?.id === id && (!activeNow?.fromTitle || activeNow.node !== origin.node));
  });
}

/** Explicit title editing and whole-block deletion remain allowed. Keeping
 * the body while removing its container must not silently discard its title. */
function losesSurvivingCalloutTitle(previous: PMNode, current: PMNode, mapping: Mapping): boolean {
  const nodes = new Set<PMNode>(), attrs = new Set<object>(), ids = new Set<string>();
  current.descendants(node => {
    if (node.isLeaf) nodes.add(node);
    if (node.type.name !== "obsidian_callout") return;
    nodes.add(node);
    attrs.add(node.attrs);
    if (typeof node.attrs.blockId === "string") ids.add(node.attrs.blockId);
  });
  let lost = false;
  const walk = (node: PMNode, pos: number): boolean => {
    let retained = node.isLeaf && nodes.has(node);
    node.forEach((child, offset) => { retained = walk(child, pos + 1 + offset) || retained; });
    if (node.type.name !== "obsidian_callout" || !node.attrs.title) return retained;
    if (nodes.has(node) || attrs.has(node.attrs) || (typeof node.attrs.blockId === "string" && ids.has(node.attrs.blockId))) return retained;
    const mapped = mapping.map(pos, 1);
    if (current.nodeAt(mapped)?.type.name === "obsidian_callout") return retained;
    if (retained || !mapping.mapResult(pos + 1, 1).deletedAcross) lost = true;
    return retained;
  };
  walk(previous, -1);
  return lost;
}

/** The exact final reference plan, shared by transaction admission checks.
 * Simulating it never mutates editor state or history or emits a notice. */
export function prepareNativeBlockIdConservation(
  previous: PMNode, current: PMNode, mapping: Mapping,
): Transform | null {
  if (introducesDuplicate(previous, current)) return null;
  const repair = prepareRepair(previous, current, mapping);
  const fullMapping = new Mapping();
  fullMapping.appendMapping(mapping);
  if (repair) fullMapping.appendMapping(repair.mapping);
  return repair && !losesSurvivingCalloutTitle(previous, repair.doc, fullMapping) &&
    !retargetsSurvivingReference(previous, repair.doc, fullMapping) ? repair : null;
}

export function nativeBlockIdConservationPlugin(
  onEvent?: (event: NativeBlockIdConservationEvent) => void,
): Plugin {
  return new Plugin({
    key,
    filterTransaction(tr, state) {
      if (tr.getMeta(declinedCalloutConversion)) {
        onEvent?.("callout-conversion");
        return false;
      }
      // Undo/redo restores previously accepted states, including an authored
      // duplicate baseline after explicit ID deletion. It is not a new paste.
      if (tr.getMeta(key) || isHistoryTransaction(tr) || !mayCombineOwners([tr])) return true;
      if (prepareNativeBlockIdConservation(state.doc, tr.doc, tr.mapping)) return true;
      onEvent?.(losesSurvivingCalloutTitle(state.doc, tr.doc, tr.mapping) ? "callout-conversion" : "unrepresentable");
      return false;
    },
    appendTransaction(transactions, oldState, newState) {
      if (transactions.some(tr => tr.getMeta(key) || isHistoryTransaction(tr)) || !mayCombineOwners(transactions)) return null;
      const repair = prepareRepair(oldState.doc, newState.doc, batchMapping(transactions));
      if (!repair || !repair.docChanged) return null;
      const tr = newState.tr;
      for (const step of repair.steps) tr.step(step);
      onEvent?.("kept-separate");
      return tr.setMeta(key, true);
    },
  });
}
