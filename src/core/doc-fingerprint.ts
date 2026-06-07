/**
 * Structural fingerprint for the save-path round-trip check.
 *
 * Walks a PM doc capturing every node's type and non-text child
 * structure, plus a tolerance-quantized total text length. Two docs
 * produce the same fingerprint iff they would round-trip through
 * markdown serialize → reparse as the "same" doc by the rules below.
 *
 * Catches the class of bug where corruption introduces stray text
 * nodes around an atom, or where canonical/preservation serialize
 * silently drops content. The save guard fingerprints the doc both
 * before and after a serialize→reparse cycle and refuses to write
 * normalized content when they diverge.
 *
 * This module is extracted from `main.ts` so the test harnesses
 * (`test-edit-simulation-roundtrip.mjs` and friends) use the SAME
 * fingerprint logic as the production save guard. A failure in the
 * test implies a failure at save time, and vice versa.
 *
 * Tolerant of normal edit drift:
 *   - Text content values are not compared (user typing is fine)
 *   - Marks are not compared (formatting toggles are fine)
 *   - Attribute values are not compared (resize, rename, etc)
 *
 * Intolerant of structural changes that round-trip would never
 * produce legitimately:
 *   - Adding/removing atoms
 *   - Adding/removing text around atoms
 *   - Block-type conversions (paragraph ↔ heading, etc)
 *   - Split or merged blocks (text length check catches the
 *     material ones)
 */

import type { Node as PMNode } from "prosemirror-model";

type Shape = { t: string; c?: number; children?: Shape[] };

// Adjacent same-type list blocks (`bullet_list, bullet_list` or
// `ordered_list, ordered_list`) are a doc-state anomaly: the
// serializer can only emit them as ONE merged list (CommonMark
// merges adjacent same-type lists by spec), so re-parse yields a
// single list. The fingerprint comparison treats them as
// equivalent — collapses adjacent same-type lists into one before
// comparing — so the round-trip guard accepts these saves instead
// of false-positiving on a layout artifact.
function mergeAdjacentLists(children: Shape[]): Shape[] {
  const result: Shape[] = [];
  for (const child of children) {
    const last = result[result.length - 1];
    const isList = child.t === "bullet_list" || child.t === "ordered_list";
    if (last && isList && last.t === child.t) {
      last.children = [
        ...(last.children ?? []),
        ...(child.children ?? []),
      ];
      if (child.c) last.c = 1;
    } else {
      result.push(child);
    }
  }
  return result;
}

// Excluded from the structural fingerprint because they have no
// visible effect on the doc's meaning AND don't survive markdown
// round-trip:
//   - block_comments — invisible meta-nodes used as list-separators
//     between adjacent same-type lists. The serializer auto-injects
//     them; only the reparsed doc has them.
//   - Paragraphs with no children (click-to-spawn ephemerals).
//   - Paragraphs with no text content AND children that are ONLY
//     break atoms (softbreak/hard_break). Markdown-it strips
//     trailing blank lines, so reparse drops them.
function isEmptyTransient(node: PMNode): boolean {
  if (node.type.name === "block_comment") return true;
  if (node.type.name !== "paragraph") return false;
  if (node.textContent.length !== 0) return false;
  if (node.childCount === 0) return true;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.type.name !== "softbreak" && c.type.name !== "hard_break") {
      return false;
    }
  }
  return true;
}

const isBreakNode = (n: PMNode) =>
  n.type.name === "softbreak" || n.type.name === "hard_break";

// Leading/trailing softbreak/hardbreak atoms inside a textblock
// don't round-trip: markdown-it strips trailing whitespace at
// paragraph parse and treats leading whitespace as no-op.
function trimEdgeBreaks(children: PMNode[]): PMNode[] {
  let start = 0;
  let end = children.length;
  while (start < end && isBreakNode(children[start])) start++;
  while (end > start && isBreakNode(children[end - 1])) end--;
  return start === 0 && end === children.length
    ? children
    : children.slice(start, end);
}

// Headings collapse internal soft/hard breaks to spaces during
// serialization, so a multi-line heading round-trips back as a
// single-line heading. Strip ALL break atoms from heading inline
// content so the fingerprint accepts that.
const stripAllBreaks = (children: PMNode[]): PMNode[] =>
  children.filter((c) => !isBreakNode(c));

// Paragraph-level block_id nodes are end-of-block metadata in
// Obsidian syntax (`^abc123`). The PM schema models them as inline
// atoms, but a merge / inline edit can move a block_id into the
// middle of a paragraph — the serializer hoists it back to the end
// at write time (only end-of-block placement is parseable). The
// fingerprint must apply the same normalization so the EDITED doc's
// shape matches what the REPARSED doc shows. Without this, a merge
// that orphans a mid-paragraph block_id reports false-positive
// structural drift even though the round-trip is clean.
const hoistBlockIdsToEnd = (children: PMNode[]): PMNode[] => {
  let hasMid = false;
  const main: PMNode[] = [];
  const tail: PMNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type.name === "block_id") {
      if (i < children.length - 1) hasMid = true;
      tail.push(c);
    } else {
      main.push(c);
    }
  }
  return hasMid ? [...main, ...tail] : children;
};

// Single-child equivalences: certain inline-atom nodes are also
// available as block nodes, and markdown-it promotes the inline
// form to the block form when it's the only child of an isolated
// paragraph. Visually identical — the user can't tell a `paragraph
// > obsidian_embed_inline` from a top-level `obsidian_embed`. The
// fingerprint normalizes the inline-as-only-child case to its
// block counterpart so round-trip doesn't false-positive on this
// auto-promotion (e.g. when a user splits a paragraph just before
// an `![[embed]]` and the second half becomes paragraph-of-just-
// embed → reparses as block embed).
const INLINE_TO_BLOCK_PROMOTION: Record<string, string> = {
  obsidian_embed_inline: "obsidian_embed",
};

function unwrapSolePromotedAtom(node: PMNode): PMNode | null {
  if (node.type.name !== "paragraph" || node.childCount !== 1) return null;
  const only = node.child(0);
  const target = INLINE_TO_BLOCK_PROMOTION[only.type.name];
  if (!target) return null;
  return only;
}

function walk(node: PMNode): Shape {
  // Apply the paragraph-of-just-embed → block-embed normalization
  // at the start of walk so both edited and reparsed produce the
  // same shape name for the equivalent doc state.
  const promoted = unwrapSolePromotedAtom(node);
  if (promoted) {
    return { t: INLINE_TO_BLOCK_PROMOTION[promoted.type.name] };
  }
  const shape: Shape = { t: node.type.name };
  if (!node.isText && node.childCount > 0) {
    const all: PMNode[] = [];
    for (let i = 0; i < node.childCount; i++) all.push(node.child(i));
    const filtered = node.type.name === "heading"
      ? stripAllBreaks(all)
      : node.isTextblock
      ? hoistBlockIdsToEnd(trimEdgeBreaks(all))
      : all;
    let textCount = 0;
    const nonTextChildren: Shape[] = [];
    for (const child of filtered) {
      if (child.isText) {
        textCount++;
      } else if (!isEmptyTransient(child)) {
        nonTextChildren.push(walk(child));
      }
    }
    if (textCount > 0) shape.c = 1;
    if (nonTextChildren.length > 0) {
      shape.children = mergeAdjacentLists(nonTextChildren);
    }
  }
  return shape;
}

/**
 * Fingerprint a PM doc. Two docs with the same fingerprint are
 * considered round-trip-equivalent by the save guard.
 */
export function docAtomFingerprint(doc: PMNode): string {
  const topShapeRaw: Shape[] = [];
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (!isEmptyTransient(child)) {
      topShapeRaw.push(walk(child));
    }
  }
  const topShape = mergeAdjacentLists(topShapeRaw);
  // textLen tolerance: serialize-merge of adjacent same-type lists
  // can shift a couple of boundary characters. Tolerate small
  // deltas — anything larger than 8 chars is still material.
  //
  // Trim trailing whitespace per TOP-LEVEL BLOCK before counting:
  // markdown-it strips trailing whitespace from paragraph text on
  // reparse. Per-node trim was wrong (asymmetric across mark
  // boundaries); per-block textContent.replace is symmetric.
  let textLenRaw = 0;
  for (let i = 0; i < doc.childCount; i++) {
    textLenRaw += doc.child(i).textContent.replace(/[ \t]+$/, "").length;
  }
  const textLen = Math.round(textLenRaw / 8) * 8;
  return JSON.stringify({ shape: topShape, textLen });
}

/**
 * Walk two fingerprint JSON strings and find the first place they
 * diverge. Returns a path like "top[3].bullet_list[1]" plus short
 * snippets of orig/re values at that point. Used by the round-trip
 * guard error reporter so the user can see WHICH block broke instead
 * of just "fingerprints differ."
 */
export function firstFingerprintDivergence(
  origFp: string,
  reFp: string,
): { path: string; orig: string; re: string } {
  let origObj: { shape: Shape[]; textLen: number };
  let reObj: { shape: Shape[]; textLen: number };
  try {
    origObj = JSON.parse(origFp) as { shape: Shape[]; textLen: number };
    reObj = JSON.parse(reFp) as { shape: Shape[]; textLen: number };
  } catch {
    return {
      path: "<parse-fp-failed>",
      orig: origFp.slice(0, 100),
      re: reFp.slice(0, 100),
    };
  }
  if (origObj.textLen !== reObj.textLen) {
    return {
      path: "textLen",
      orig: String(origObj.textLen),
      re: String(reObj.textLen),
    };
  }
  const walkPair = (
    a: Shape,
    b: Shape,
    path: string,
  ): { path: string; orig: string; re: string } | null => {
    if (a.t !== b.t) {
      return { path, orig: a.t, re: b.t };
    }
    if (a.c !== b.c) {
      return {
        path: `${path}.text-marker`,
        orig: String(a.c ?? "none"),
        re: String(b.c ?? "none"),
      };
    }
    const ac = a.children || [];
    const bc = b.children || [];
    if (ac.length !== bc.length) {
      return {
        path: `${path}.${a.t}.childCount`,
        orig: `${ac.length} (${ac.map((s) => s.t).join(",")})`,
        re: `${bc.length} (${bc.map((s) => s.t).join(",")})`,
      };
    }
    for (let i = 0; i < ac.length; i++) {
      const sub = walkPair(ac[i], bc[i], `${path}.${a.t}[${i}]`);
      if (sub) return sub;
    }
    return null;
  };
  const aTop = origObj.shape;
  const bTop = reObj.shape;
  if (aTop.length !== bTop.length) {
    return {
      path: "top.length",
      orig: `${aTop.length} (${aTop.map((s) => s.t).join(",")})`,
      re: `${bTop.length} (${bTop.map((s) => s.t).join(",")})`,
    };
  }
  for (let i = 0; i < aTop.length; i++) {
    const sub = walkPair(aTop[i], bTop[i], `top[${i}]`);
    if (sub) return sub;
  }
  return { path: "<no-diff-found>", orig: "?", re: "?" };
}
