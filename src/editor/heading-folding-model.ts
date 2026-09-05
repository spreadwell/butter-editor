import type { Node as PMNode } from "prosemirror-model";

export interface HeadingFoldProjectionEntry {
  node: PMNode;
  pos: number;
  blockId: string | null;
  level: number | null;
  foldable: boolean;
  collapsed: boolean;
  hidden: boolean;
}

function headingLevel(node: PMNode): number | null {
  if (node.type.name !== "heading") return null;
  const raw = Number(node.attrs.level);
  return Number.isFinite(raw)
    ? Math.max(1, Math.min(6, Math.trunc(raw)))
    : 1;
}

function blockId(node: PMNode): string | null {
  const value = (node.attrs as { blockId?: unknown }).blockId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Project root heading visibility in one linear pass. A collapsed heading
 * hides every following root block until the next heading of equal or higher
 * rank. Nested collapsed headings remain in state while hidden so expanding a
 * parent restores the exact nested view state.
 */
export function projectHeadingFolds(
  doc: PMNode,
  requestedCollapsedIds: ReadonlySet<string>,
): HeadingFoldProjectionEntry[] {
  const entries: HeadingFoldProjectionEntry[] = [];
  doc.forEach((node, pos) => {
    entries.push({
      node,
      pos,
      blockId: blockId(node),
      level: headingLevel(node),
      foldable: false,
      collapsed: false,
      hidden: false,
    });
  });

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.level == null || entry.blockId == null) continue;
    const next = entries[index + 1];
    entry.foldable = Boolean(
      next && (next.level == null || next.level > entry.level),
    );
  }

  const collapsedLevels: number[] = [];
  for (const entry of entries) {
    if (entry.level != null) {
      while (
        collapsedLevels.length > 0 &&
        collapsedLevels[collapsedLevels.length - 1] >= entry.level
      ) {
        collapsedLevels.pop();
      }
    }

    entry.hidden = collapsedLevels.length > 0;
    entry.collapsed = Boolean(
      entry.foldable &&
      entry.blockId &&
      requestedCollapsedIds.has(entry.blockId),
    );
    if (entry.collapsed && entry.level != null) {
      collapsedLevels.push(entry.level);
    }
  }

  return entries;
}

/** Return the root block run represented by one heading section. */
export function headingSectionPositions(
  doc: PMNode,
  headingPos: number,
): number[] {
  const entries = projectHeadingFolds(doc, new Set());
  const start = entries.findIndex((entry) => entry.pos === headingPos);
  if (start < 0) return [];
  const heading = entries[start];
  if (heading.level == null || !heading.foldable) return [];

  const positions = [heading.pos];
  for (let index = start + 1; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.level != null && entry.level <= heading.level) break;
    positions.push(entry.pos);
  }
  return positions;
}
