/**
 * Pre-serialize PM doc normalization.
 *
 * Markdown can not represent every PM tree shape the schema admits.
 * When a user edit produces an unrepresentable shape (block_id in
 * the middle of a paragraph, orphan-nested list_item, heading with
 * softbreaks, embed-inline alone in a paragraph, text node with
 * embedded newline), the serializer either emits invalid markdown
 * or output that reparses to a structurally different doc — the
 * save guard fires.
 *
 * This module rewrites those shapes into their canonical equivalents
 * BEFORE serialization. The user's in-memory PM tree is NOT touched
 * (the normalizer is pure: input doc, output doc). The save pipeline
 * passes the normalized doc to both serializer and fingerprint, so
 * the fingerprint divergence check sees the SAME shape on both sides
 * of the round-trip. Drift can only fire on genuine serializer bugs.
 *
 * Each normalization is idempotent. Each is documented with the bug
 * class that motivated it.
 *
 * Apply rules (in order):
 *   1. Block_id mid-paragraph → hoist all block_ids to the end of
 *      their containing paragraph.
 *   2. List_item with depth>0 and no preceding depth-(N-1) sibling
 *      → clamp depth to whatever has a real ancestor chain (down to
 *      0). Round-trip-safe: orphan reparses as list_item depth=0
 *      instead of code_block.
 *   3. Heading with inline softbreak/hardbreak nodes → flatten to
 *      spaces in the text content.
 *   4. Heading content with leading/trailing whitespace on the
 *      first/last unmarked text node → strip. Markdown-it strips
 *      both on heading reparse.
 *   5. Paragraph containing ONLY an obsidian_embed_inline → replace
 *      with a top-level obsidian_embed block node. Markdown-it
 *      auto-promotes the inline form when isolated, so we make the
 *      tree match.
 *   6. Text node with embedded `\n` → split into text + softbreak
 *      + text alternations. Round-trips cleanly; the original
 *      shape reparses with the softbreak as an explicit node.
 *
 * All other PM shapes pass through unchanged.
 */

import { Fragment, Node as PMNode } from "prosemirror-model";
import type { Schema } from "prosemirror-model";

// ── Per-node normalizers ─────────────────────────────────────────

function hoistBlockIdsToEnd(children: PMNode[]): PMNode[] {
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
}

function clampOrphanListItemDepth(
  child: PMNode,
  idx: number,
  parent: PMNode,
): PMNode {
  if (child.type.name !== "list_item") return child;
  const depth = (child.attrs.depth as number | undefined) ?? 0;
  if (depth === 0) return child;
  // Walk backward to find the highest existing-ancestor depth.
  let effectiveDepth = depth;
  while (effectiveDepth > 0) {
    let hasAncestor = false;
    for (let j = idx - 1; j >= 0; j--) {
      const prev = parent.child(j);
      if (prev.type.name !== "list_item") break;
      const pd = (prev.attrs.depth as number | undefined) ?? 0;
      if (pd < effectiveDepth - 1) break;
      if (pd === effectiveDepth - 1) {
        hasAncestor = true;
        break;
      }
    }
    if (hasAncestor) break;
    effectiveDepth--;
  }
  if (effectiveDepth === depth) return child;
  return child.type.create(
    { ...child.attrs, depth: effectiveDepth },
    child.content,
    child.marks,
  );
}

function isBreakNode(n: PMNode): boolean {
  return n.type.name === "softbreak" || n.type.name === "hard_break";
}

// Detect a list_item whose only child paragraph has no inline
// content at all (truly empty `- `). When emitted inside a callout
// body, markdown-it interprets the bare `- ` as a setext-style HR
// or empty bullet that doesn't round-trip back into a list_item.
// Production users rarely leave a list_item truly empty across a
// save (the scheduler's idle window catches transient empties);
// when they do, dropping the empty li is the only way to make the
// document survive the round-trip. Outside containers (top-level)
// empty list_items DO round-trip cleanly via `- \n`, so we only
// drop them when they live inside a container.
function isEmptyListItem(node: PMNode): boolean {
  if (node.type.name !== "list_item") return false;
  if (node.childCount !== 1) return false;
  const p = node.child(0);
  if (p.type.name !== "paragraph") return false;
  if (p.childCount > 0) return false;
  return true;
}

function dropEmptyListItems(
  parent: PMNode,
  schema: Schema,
): PMNode | null {
  // Empty list_items never survive a round-trip — markdown-it
  // interprets the bare `- ` differently depending on context
  // (heading underline inside a callout, list-item continuation
  // outside, or just dropped if nested). Real users only have an
  // empty list_item transiently (just pressed Enter, about to
  // type); the save scheduler's 1500ms idle window means it's
  // very unlikely to fire during that transient state. Drop them
  // at save time to keep the round-trip safe. Applies to ALL
  // parent contexts (top-level doc, callout body, blockquote body,
  // even nested list_item content) — the drop is universal.
  let changed = false;
  const kids: PMNode[] = [];
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (isEmptyListItem(c)) {
      changed = true;
      continue;
    }
    kids.push(c);
  }
  if (!changed) return null;
  // Container with no children: insert empty paragraph so the
  // schema remains satisfied (block+ requirement).
  if (
    kids.length === 0 &&
    (parent.type.name === "obsidian_callout" ||
      parent.type.name === "blockquote")
  ) {
    const para = schema.nodes.paragraph;
    if (para) kids.push(para.create());
  }
  if (kids.length === 0) return null;
  return parent.copy(Fragment.fromArray(kids));
}

function normalizeHeadingInline(
  heading: PMNode,
  schema: Schema,
): PMNode {
  if (heading.type.name !== "heading") return heading;
  const children: PMNode[] = [];
  for (let i = 0; i < heading.childCount; i++) {
    children.push(heading.child(i));
  }
  // Flatten softbreak/hardbreak to spaces in unmarked text runs.
  const out: PMNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push(schema.text(buf));
      buf = "";
    }
  };
  for (const n of children) {
    if (isBreakNode(n)) {
      buf += " ";
    } else if (n.isText && n.marks.length === 0) {
      buf += n.text!;
    } else {
      flush();
      out.push(n);
    }
  }
  flush();
  // Trim leading on first unmarked-text-at-start, trailing on last
  // unmarked-text-at-end. Never at mark boundaries (preserves
  // `**bold** word` separator so reparse doesn't lose the close).
  if (out.length > 0 && out[0].isText && out[0].marks.length === 0) {
    const trimmed = out[0].text!.replace(/^[ \t]+/, "");
    out[0] = trimmed ? schema.text(trimmed) : null as unknown as PMNode;
  }
  const lastIdx = out.length - 1;
  if (
    lastIdx >= 0 &&
    out[lastIdx] &&
    out[lastIdx].isText &&
    out[lastIdx].marks.length === 0
  ) {
    const trimmed = out[lastIdx].text!.replace(/[ \t]+$/, "");
    out[lastIdx] = trimmed ? schema.text(trimmed) : null as unknown as PMNode;
  }
  const cleaned = out.filter((n) => n != null);
  // Build comparison signatures to skip rebuild when nothing changed.
  const sameLength = cleaned.length === heading.childCount;
  if (sameLength) {
    let allSame = true;
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] !== heading.child(i)) {
        allSame = false;
        break;
      }
    }
    if (allSame) return heading;
  }
  return heading.copy(Fragment.fromArray(cleaned));
}

function splitTextOnNewlines(
  text: PMNode,
  schema: Schema,
): PMNode[] | null {
  if (!text.isText) return null;
  const s = text.text!;
  if (!s.includes("\n")) return null;
  const softbreak = schema.nodes.softbreak;
  if (!softbreak) return null;
  const lines = s.split(/\r?\n/);
  const out: PMNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(softbreak.create());
    // Preserve the original marks on each split text segment.
    if (line) out.push(schema.text(line, text.marks));
  });
  return out;
}

function normalizeTextNodesInInline(
  parent: PMNode,
  schema: Schema,
): PMNode | null {
  if (!parent.isTextblock) return null;
  // Code-content textblocks (code_block, math_block, block_comment)
  // legitimately carry embedded newlines in their single text child —
  // that's the code/math/comment payload. Splitting into softbreak
  // runs would corrupt them. Skip the normalization for these.
  if (parent.type.spec.code) return null;
  if (parent.type.name === "math_block" || parent.type.name === "block_comment") return null;
  let changed = false;
  const out: PMNode[] = [];
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c.isText && c.text!.includes("\n")) {
      const split = splitTextOnNewlines(c, schema);
      if (split) {
        out.push(...split);
        changed = true;
        continue;
      }
    }
    out.push(c);
  }
  if (!changed) return null;
  return parent.copy(Fragment.fromArray(out));
}

function promoteSoleEmbedInline(
  paragraph: PMNode,
  schema: Schema,
): PMNode | null {
  if (paragraph.type.name !== "paragraph") return null;
  if (paragraph.childCount !== 1) return null;
  const only = paragraph.child(0);
  if (only.type.name !== "obsidian_embed_inline") return null;
  const blockType = schema.nodes.obsidian_embed;
  if (!blockType) return null;
  // Block-embed accepts the same attrs subset (src, alt, width,
  // height). Copy whatever the inline carried; missing attrs get
  // schema defaults.
  const attrs: Record<string, unknown> = {};
  for (const key of Object.keys(blockType.spec.attrs ?? {})) {
    if (key in only.attrs) attrs[key] = only.attrs[key];
  }
  // sourceRange transfers if present, otherwise null (will canonical-
  // emit at save time).
  if ("sourceRange" in only.attrs) {
    attrs.sourceRange = only.attrs.sourceRange;
  }
  return blockType.create(attrs);
}

// ── Top-level walk ───────────────────────────────────────────────

/**
 * Apply all save-time normalizations to a PM doc. Returns a new
 * doc; the input is not mutated. Idempotent — normalize(normalize(d))
 * === normalize(d) in structure (reference identity preserved when
 * nothing changes).
 */
export function normalizeDocForSave(doc: PMNode): PMNode {
  const schema = doc.type.schema;
  // Walk inner nodes recursively so deep block_id-mid-paragraph or
  // softbreak-in-heading shapes inside containers (blockquote,
  // callout, list_item body) also get normalized.
  const walk = (node: PMNode): PMNode => {
    if (node.isLeaf) return node;
    // First recurse into children.
    let childrenChanged = false;
    const newChildren: PMNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      const w = walk(c);
      if (w !== c) childrenChanged = true;
      newChildren.push(w);
    }
    let current = childrenChanged
      ? node.copy(Fragment.fromArray(newChildren))
      : node;
    // Apply node-shape-specific normalizations.
    // 0. Drop empty list_items — they never survive round-trip
    //    (bare `- ` is interpreted differently per context).
    const dropped = dropEmptyListItems(current, schema);
    if (dropped) current = dropped;
    // 1. Heading inline flatten + trim.
    if (current.type.name === "heading") {
      current = normalizeHeadingInline(current, schema);
    }
    // 2. Textblock text-with-newline split into softbreak runs.
    const textSplit = normalizeTextNodesInInline(current, schema);
    if (textSplit) current = textSplit;
    // 3. Paragraph block_id hoist.
    if (current.type.name === "paragraph" && current.childCount > 1) {
      const kids: PMNode[] = [];
      for (let i = 0; i < current.childCount; i++) kids.push(current.child(i));
      const hoisted = hoistBlockIdsToEnd(kids);
      if (hoisted !== kids) {
        current = current.copy(Fragment.fromArray(hoisted));
      }
    }
    return current;
  };

  // Top-level pass: walk + apply container-level transforms (orphan-
  // li clamp needs parent context; embed-inline promote replaces the
  // node entirely).
  const topChildren: PMNode[] = [];
  for (let i = 0; i < doc.childCount; i++) {
    topChildren.push(walk(doc.child(i)));
  }
  // Build a temporary parent so we can apply position-aware ops.
  const tempDoc = doc.copy(Fragment.fromArray(topChildren));

  // 4. Embed-inline-alone-in-paragraph → embed block.
  const promoted: PMNode[] = [];
  let promoteChanged = false;
  for (let i = 0; i < tempDoc.childCount; i++) {
    const c = tempDoc.child(i);
    const p = promoteSoleEmbedInline(c, schema);
    if (p) {
      promoted.push(p);
      promoteChanged = true;
    } else {
      promoted.push(c);
    }
  }
  const afterPromote = promoteChanged
    ? doc.copy(Fragment.fromArray(promoted))
    : tempDoc;

  // 5. Orphan-li depth clamp (must walk in final order so positions
  // match the surrounding context after any earlier transforms).
  const clamped: PMNode[] = [];
  let clampChanged = false;
  for (let i = 0; i < afterPromote.childCount; i++) {
    const c = afterPromote.child(i);
    const cc = clampOrphanListItemDepth(c, i, afterPromote);
    if (cc !== c) clampChanged = true;
    clamped.push(cc);
  }
  const afterClamp = clampChanged
    ? doc.copy(Fragment.fromArray(clamped))
    : afterPromote;

  // 6. Drop empty list_items at the top level (the walker handles
  // them inside containers via the per-node pass, but a top-level
  // empty list_item needs this final pass).
  const topDropped = dropEmptyListItems(afterClamp, schema);
  return topDropped ?? afterClamp;
}

/**
 * Inspect a doc and return a list of normalization actions that
 * would be applied. Used by validateDocForRoundTrip + diagnostic
 * tooling. Each item describes the violation in plain English.
 */
export function describeNormalizations(doc: PMNode): string[] {
  const violations: string[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name === "paragraph") {
      let midBlockId = false;
      for (let i = 0; i < node.childCount - 1; i++) {
        if (node.child(i).type.name === "block_id") {
          midBlockId = true;
          break;
        }
      }
      if (midBlockId) {
        violations.push(`paragraph @${pos}: block_id mid-content (will hoist to end)`);
      }
      if (
        node.childCount === 1 &&
        node.child(0).type.name === "obsidian_embed_inline"
      ) {
        violations.push(`paragraph @${pos}: sole embed_inline (will promote to embed block)`);
      }
    }
    if (node.type.name === "heading") {
      let hasBreak = false;
      for (let i = 0; i < node.childCount; i++) {
        if (
          node.child(i).type.name === "softbreak" ||
          node.child(i).type.name === "hard_break"
        ) {
          hasBreak = true;
          break;
        }
      }
      if (hasBreak) {
        violations.push(`heading @${pos}: softbreak/hard_break in content (will flatten to space)`);
      }
    }
    if (node.isText && node.text && node.text.includes("\n")) {
      // Only flag text in textblocks where the newline is a parser
      // quirk, not legitimate content. Code/math content textblocks
      // legitimately carry newlines and are skipped by the normalizer.
      const inCodeContent =
        parent && (parent.type.spec.code || parent.type.name === "math_block" || parent.type.name === "block_comment");
      if (!inCodeContent) {
        violations.push(`text @${pos}: embedded newline (will split into text+softbreak runs)`);
      }
    }
  });
  // List_item orphans are top-level only.
  for (let i = 0; i < doc.childCount; i++) {
    const c = doc.child(i);
    if (c.type.name !== "list_item") continue;
    const depth = (c.attrs.depth as number | undefined) ?? 0;
    if (depth === 0) continue;
    let hasImmediateParent = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = doc.child(j);
      if (prev.type.name !== "list_item") break;
      const pd = (prev.attrs.depth as number | undefined) ?? 0;
      if (pd < depth - 1) break;
      if (pd === depth - 1) {
        hasImmediateParent = true;
        break;
      }
    }
    if (!hasImmediateParent) {
      violations.push(`list_item @top[${i}]: depth=${depth} but no depth-${depth - 1} sibling (will clamp)`);
    }
  }
  return violations;
}
