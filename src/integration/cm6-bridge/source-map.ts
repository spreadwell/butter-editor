/**
 * Source map between a ProseMirror document and its markdown
 * serialization.
 *
 * We walk the PM doc in traversal order, record each text node's
 * `(pmPos, length)`, then find that literal text in the serialized
 * markdown starting from an advancing pointer. This resolves the
 * common case (paragraphs, headings, list items, blockquote text)
 * and degrades gracefully for nodes serialized with heavy escaping
 * - we still know block boundaries.
 *
 * Given an arbitrary markdown offset we can return a nearby PM
 * position; given a PM position we can return its markdown offset.
 * Edge cases (escaped characters inside text) may be off by a few
 * characters, which is tolerable for decoration placement.
 */
import type { Node as PMNode } from "prosemirror-model";

export interface SourceSpan {
  pmFrom: number;
  pmTo: number;
  mdFrom: number;
  mdTo: number;
  isText: boolean;
}

export interface SourceMap {
  markdown: string;
  spans: SourceSpan[];
  /** Block-level index so we can locate a position fast. */
  blocks: Array<{ pmFrom: number; pmTo: number; mdFrom: number; mdTo: number }>;
}

export function buildSourceMap(
  doc: PMNode,
  markdown: string,
): SourceMap {
  const spans: SourceSpan[] = [];
  const blocks: SourceMap["blocks"] = [];

  // Text nodes first, in document order. Maintain a running cursor
  // into `markdown`: each text node's content is searched for starting
  // at the cursor, which prevents false matches on duplicate strings.
  let cursor = 0;

  // Track the innermost top-level block so we can also record block ranges.
  let currentBlock: { node: PMNode; pmFrom: number; mdFrom: number } | null =
    null;

  const closeBlock = (pmTo: number, mdTo: number) => {
    if (!currentBlock) return;
    blocks.push({
      pmFrom: currentBlock.pmFrom,
      pmTo,
      mdFrom: currentBlock.mdFrom,
      mdTo,
    });
    currentBlock = null;
  };

  doc.descendants((node, pos) => {
    // Top-level blocks: use the doc's direct children as the block index.
    // Simpler heuristic: record a block span every time we enter a textblock.
    if (node.isTextblock) {
      if (currentBlock) closeBlock(pos, cursor);
      currentBlock = { node, pmFrom: pos, mdFrom: cursor };
    }

    if (node.isText) {
      const text = node.text ?? "";
      if (!text) return true;

      // Fast path: literal match in the markdown starting at cursor.
      let idx = markdown.indexOf(text, cursor);
      let mdLen = text.length;

      if (idx < 0) {
        // Fall back to escape-aware matching. markdown-it often
        // emits `\|`, `\*`, `\[`, `\_`, `\\` etc. for characters
        // that the PM text has unescaped.
        const hit = findEscaped(markdown, cursor, text);
        if (hit) {
          idx = hit.from;
          mdLen = hit.length;
        }
      }

      if (idx >= 0) {
        spans.push({
          pmFrom: pos,
          pmTo: pos + text.length,
          mdFrom: idx,
          mdTo: idx + mdLen,
          isText: true,
        });
        cursor = idx + mdLen;
      } else {
        // Still no match - record an approximate span at cursor so
        // callers at least land nearby.
        spans.push({
          pmFrom: pos,
          pmTo: pos + text.length,
          mdFrom: cursor,
          mdTo: cursor + text.length,
          isText: true,
        });
      }
    }
    return true;
  });

  if (currentBlock) closeBlock(doc.content.size, markdown.length);

  return { markdown, spans, blocks };
}

/**
 * Escape-aware matcher: try to find `text` in `markdown` starting at
 * `start`, allowing single-char backslash escapes in the markdown
 * (e.g. `\|` matching PM text `|`, `\\` matching PM text `\`).
 * Returns the match's [from, length) in markdown.
 */
function findEscaped(
  markdown: string,
  start: number,
  text: string,
): { from: number; length: number } | null {
  for (let i = start; i <= markdown.length - text.length; i++) {
    let mi = i;
    let ti = 0;
    let consumed = 0;
    while (ti < text.length && mi < markdown.length) {
      let ch = markdown[mi];
      let advance = 1;
      if (ch === "\\" && mi + 1 < markdown.length) {
        ch = markdown[mi + 1];
        advance = 2;
      }
      if (ch !== text[ti]) break;
      mi += advance;
      consumed += advance;
      ti++;
    }
    if (ti === text.length) return { from: i, length: consumed };
  }
  return null;
}

// ═══════════════════════════════════════════
//  Lookups
// ═══════════════════════════════════════════

/**
 * Given a markdown offset, return the nearest PM position.
 *
 * Resolution order:
 *   1. Exact hit inside a text span (precise byte-level mapping).
 *   2. Snap to the adjacent edge of a nearby text span. This gives
 *      accurate placement for decorations that target markdown
 *      delimiter characters (the `**`, `` ` ``, `[`, `]` that don't
 *      appear in the PM text itself) - we pin them to the edge of
 *      their neighbouring text span instead of jumping all the way
 *      out to the block.
 *   3. Fall back to the containing block's start.
 *   4. Off the end → last valid position.
 */
const SNAP_THRESHOLD = 8;

export function mdToPM(map: SourceMap, mdOffset: number): number {
  // 1. Exact hit inside a text span.
  for (const s of map.spans) {
    if (mdOffset >= s.mdFrom && mdOffset <= s.mdTo) {
      return s.pmFrom + (mdOffset - s.mdFrom);
    }
  }

  // 2. Snap to a nearby text-span edge.
  let bestSpan: SourceSpan | null = null;
  let bestDist = SNAP_THRESHOLD + 1;
  let bestEdge: "from" | "to" = "from";
  for (const s of map.spans) {
    const distFrom = Math.abs(s.mdFrom - mdOffset);
    const distTo = Math.abs(s.mdTo - mdOffset);
    if (distFrom < bestDist) {
      bestDist = distFrom;
      bestSpan = s;
      bestEdge = "from";
    }
    if (distTo < bestDist) {
      bestDist = distTo;
      bestSpan = s;
      bestEdge = "to";
    }
  }
  if (bestSpan) {
    return bestEdge === "from" ? bestSpan.pmFrom : bestSpan.pmTo;
  }

  // 3. Containing block start.
  for (const b of map.blocks) {
    if (mdOffset >= b.mdFrom && mdOffset <= b.mdTo) {
      return b.pmFrom;
    }
  }

  // 4. Off the end.
  const last = map.blocks[map.blocks.length - 1];
  return last ? last.pmTo : 0;
}

/** PM position → nearest markdown offset. */
export function pmToMd(map: SourceMap, pmPos: number): number {
  for (const s of map.spans) {
    if (pmPos >= s.pmFrom && pmPos <= s.pmTo) {
      return s.mdFrom + (pmPos - s.pmFrom);
    }
  }
  for (const b of map.blocks) {
    if (pmPos >= b.pmFrom && pmPos <= b.pmTo) {
      return b.mdFrom;
    }
  }
  return 0;
}

/**
 * Translate a markdown range to a PM range. Callers supply the map's
 * doc size as the PM doc size to clamp the result.
 */
export function mdRangeToPM(
  map: SourceMap,
  mdFrom: number,
  mdTo: number,
  docSize: number,
): { from: number; to: number } {
  const from = Math.min(Math.max(0, mdToPM(map, mdFrom)), docSize);
  const to = Math.min(Math.max(from, mdToPM(map, mdTo)), docSize);
  return { from, to };
}
