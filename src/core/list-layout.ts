import type { Node as PMNode } from "prosemirror-model";

export type FlatListKind = "bullet" | "ordered" | "task";

export const MAX_ORDERED_LIST_START = 999_999_999;

export interface FlatListLayoutEntry {
  rawDepth: number;
  effectiveDepth: number;
  parentIndex: number | null;
  runStartIndex: number;
  continuation: boolean;
  requiresOrderedRunBreak: boolean;
  requiredColumns: number;
  tightBefore: boolean;
  markerNumber: number | null;
  markerWidth: number;
  orderedDelimiter: "." | ")" | null;
}

const layoutCache = new WeakMap<
  PMNode,
  ReadonlyArray<FlatListLayoutEntry | null>
>();

export function listKind(node: PMNode): FlatListKind {
  const kind: unknown = node.attrs.kind;
  return kind === "ordered" || kind === "task" ? kind : "bullet";
}

export function listRawDepth(node: PMNode): number {
  return Number.isFinite(node.attrs.depth)
    ? Math.max(0, Math.floor(node.attrs.depth as number))
    : 0;
}

/**
 * Whether a leading empty paragraph exists only to satisfy the flat-list
 * schema before a non-paragraph first block.
 *
 * Task checkboxes are paragraph content in Markdown even though the parser
 * stores their checked state on the list item and leaves the paragraph
 * empty. Their paragraph is therefore source-represented, not a synthetic
 * carrier, and must retain its own block edge before following content.
 */
export function listItemHasSyntheticLeadingParagraph(
  node: PMNode,
): boolean {
  return node.type.name === "list_item" &&
    listKind(node) !== "task" &&
    node.childCount > 1 &&
    node.firstChild?.type.name === "paragraph" &&
    node.firstChild.childCount === 0;
}

/**
 * Whether this item can express an authored loose-list edge before one of
 * its flat-model nested children.
 *
 * A real nonempty paragraph and an empty task paragraph (whose checkbox is
 * source content) can be separated from nested list content by a blank line.
 * A marker-only bullet/ordered item cannot: the blank detaches its would-be
 * child. A schema-only carrier before code, quote, or other block-first
 * content is likewise not a representable loose edge.
 */
export function listItemCanRepresentLooseNestedEdge(
  node: PMNode,
): boolean {
  return node.type.name === "list_item" &&
    node.firstChild?.type.name === "paragraph" &&
    !listItemHasSyntheticLeadingParagraph(node) &&
    !listItemIsMarkerOnly(node);
}

export function orderedListStart(value: unknown): number {
  return Number.isFinite(value)
    ? Math.min(
        MAX_ORDERED_LIST_START,
        Math.max(0, Math.floor(value as number)),
      )
    : 1;
}

export function listItemIsMarkerOnly(node: PMNode): boolean {
  return node.type.name === "list_item" &&
    listKind(node) !== "task" &&
    node.childCount === 1 &&
    node.firstChild?.type.name === "paragraph" &&
    node.firstChild.childCount === 0;
}

/**
 * Whether the first nested list block needs a blank line after its owning
 * item's paragraph. CommonMark does not let a non-1 ordered marker or an
 * empty marker interrupt paragraph continuation, so a tight edge cannot
 * represent these structures.
 */
export function listItemRequiresLooseParentEdge(
  parent: PMNode,
  index: number,
  entry: FlatListLayoutEntry | null = flatListLayoutFor(parent)[index],
): boolean {
  if (
    !entry ||
    entry.parentIndex === null ||
    entry.parentIndex !== index - 1
  ) {
    return false;
  }
  const owner = parent.child(entry.parentIndex);
  const trailingBlock = owner.lastChild;
  if (trailingBlock?.type.name !== "paragraph" || trailingBlock.childCount === 0) {
    return false;
  }
  const node = parent.child(index);
  return listItemIsMarkerOnly(node) ||
    (listKind(node) === "ordered" && entry.markerNumber !== 1);
}

/** Task items are CommonMark bullet-list items with checkbox content. */
export function listKindsShareRun(
  left: FlatListKind,
  right: FlatListKind,
): boolean {
  if (left === "ordered" || right === "ordered") {
    return left === "ordered" && right === "ordered";
  }
  return true;
}

/**
 * One linear interpretation of Butter's flat list model. This resolves
 * orphaned depths, ancestry, run continuity, numbering, and tightness so
 * normalization, serialization, and UI numbering cannot disagree.
 */
export function flatListLayoutFor(
  parent: PMNode,
): ReadonlyArray<FlatListLayoutEntry | null> {
  const cached = layoutCache.get(parent);
  if (cached) return cached;

  const layout = new Array<FlatListLayoutEntry | null>(
    parent.childCount,
  ).fill(null);
  const ancestors: Array<{
    index: number;
    rawDepth: number;
    entry: FlatListLayoutEntry;
  }> = [];
  const lastKindAtDepth: Array<FlatListKind | undefined> = [];
  const lastOrderedNumberAtDepth: Array<number | undefined> = [];
  const orderedDelimiterAtDepth: Array<"." | ")" | undefined> = [];
  const runStartAtDepth: Array<number | undefined> = [];
  const runTightAtDepth: Array<boolean | undefined> = [];

  for (let index = 0; index < parent.childCount; index++) {
    const child = parent.child(index);
    if (child.type.name !== "list_item") {
      ancestors.length = 0;
      lastKindAtDepth.length = 0;
      lastOrderedNumberAtDepth.length = 0;
      orderedDelimiterAtDepth.length = 0;
      runStartAtDepth.length = 0;
      runTightAtDepth.length = 0;
      continue;
    }

    const rawDepth = listRawDepth(child);
    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1].rawDepth >= rawDepth
    ) {
      ancestors.pop();
    }

    const directParent = ancestors[ancestors.length - 1];
    const effectiveDepth = ancestors.length;
    const kind = listKind(child);
    const previousKind = lastKindAtDepth[effectiveDepth];
    const sharesPreviousRun =
      previousKind !== undefined && listKindsShareRun(previousKind, kind);
    const hasExplicitOrderedStart =
      kind === "ordered" && child.attrs.start != null;
    const continuation = sharesPreviousRun && !hasExplicitOrderedStart;
    const runStartIndex = continuation
      ? runStartAtDepth[effectiveDepth] ?? index
      : index;
    const requiresOrderedRunBreak =
      sharesPreviousRun && kind === "ordered" && hasExplicitOrderedStart;
    const runTight = child.attrs.tight !== false &&
      (!continuation || runTightAtDepth[effectiveDepth] !== false);
    const nested = effectiveDepth > 0;
    const markerNumber = kind === "ordered"
      ? continuation
        ? Math.min(
            (lastOrderedNumberAtDepth[effectiveDepth] ?? 0) + 1,
            MAX_ORDERED_LIST_START,
          )
        : orderedListStart(child.attrs.start)
      : null;
    const markerWidth = markerNumber === null
      ? 2
      : `${markerNumber}. `.length;
    const previousOrderedDelimiter =
      orderedDelimiterAtDepth[effectiveDepth] ?? ".";
    const orderedDelimiter = kind === "ordered"
      ? requiresOrderedRunBreak
        ? previousOrderedDelimiter === "." ? ")" : "."
        : continuation
          ? previousOrderedDelimiter
          : "."
      : null;
    const requiredColumns = directParent
      ? directParent.entry.requiredColumns + directParent.entry.markerWidth
      : 0;
    const entry: FlatListLayoutEntry = {
      rawDepth,
      effectiveDepth,
      parentIndex: directParent?.index ?? null,
      runStartIndex,
      continuation,
      requiresOrderedRunBreak,
      requiredColumns,
      // The first item of a nested run attaches directly to its parent row.
      // Later items use cumulative run tightness: a marker-only item may
      // project tight itself, but cannot erase a prior loose edge.
      tightBefore: continuation
        ? runTight
        : nested,
      markerNumber,
      markerWidth,
      orderedDelimiter,
    };

    layout[index] = entry;
    lastKindAtDepth.length = effectiveDepth + 1;
    lastOrderedNumberAtDepth.length = effectiveDepth + 1;
    orderedDelimiterAtDepth.length = effectiveDepth + 1;
    runStartAtDepth.length = effectiveDepth + 1;
    runTightAtDepth.length = effectiveDepth + 1;
    lastKindAtDepth[effectiveDepth] = kind;
    lastOrderedNumberAtDepth[effectiveDepth] = markerNumber ?? undefined;
    orderedDelimiterAtDepth[effectiveDepth] = orderedDelimiter ?? undefined;
    runStartAtDepth[effectiveDepth] = runStartIndex;
    runTightAtDepth[effectiveDepth] = runTight;
    ancestors.push({ index, rawDepth, entry });
  }

  layoutCache.set(parent, layout);
  return layout;
}
