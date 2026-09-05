/**
 * Pre-serialize PM doc normalization.
 *
 * Markdown can not represent every PM tree shape the schema admits.
 * When a user edit produces an unrepresentable shape (block_id in
 * the middle of a paragraph, orphan-nested list_item, embed-inline
 * alone in a paragraph, text node with
 * embedded newline), the serializer either emits invalid markdown
 * or output that reparses to a structurally different doc — the
 * save guard fires.
 *
 * This module rewrites those shapes into their canonical equivalents
 * BEFORE serialization. The normalizer itself is pure (input doc, output
 * doc). Its explicit presentation mode applies every durable, visible rewrite
 * while retaining editing ephemera that Markdown cannot encode: transient
 * empty paragraphs and emphasis-edge whitespace marks. The view reconciles
 * that presentation target before a successful write, while the default
 * persisted target remains the sole serializer/fingerprint input.
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
 *   3. Paragraph containing ONLY an obsidian_embed_inline → replace
 *      with a top-level obsidian_embed block node. Markdown-it
 *      auto-promotes the inline form when isolated, so we make the
 *      tree match.
 *   4. Text node with embedded `\n` → split into text + softbreak
 *      + text alternations. Round-trips cleanly; the original
 *      shape reparses with the softbreak as an explicit node.
 *   5. Plain text `$...$` that matches Butter's inline math delimiter
 *      rules -> inline_math atom. Currency-shaped dollars stay text.
 *   6. Top-level empty paragraphs -> dropped. Blank lines are markdown
 *      gaps, not durable empty paragraph blocks.
 *
 * All other PM shapes pass through unchanged.
 */

import { Fragment, Node as PMNode } from "prosemirror-model";
import type { Schema } from "prosemirror-model";
import {
  findInlineMathClose,
  isValidInlineMathOpenAt,
} from "./inline-math-delimiters";
import {
  flatListLayoutFor,
  listItemCanRepresentLooseNestedEdge,
  listItemHasSyntheticLeadingParagraph,
  listItemIsMarkerOnly,
  listItemRequiresLooseParentEdge,
  listKind,
  orderedListStart,
} from "./list-layout";
import { __mdit } from "./bridge/common";

export interface NormalizeDocForSaveOptions {
  /**
   * `persisted` is the exact Markdown-representable tree (the default).
   * `presentation` retains non-persistable editing ephemera in the live PM
   * state. The save boundary proves that normalizing the presentation target
   * in persisted mode is exactly equal to the persisted target before write.
   */
  readonly mode?: "persisted" | "presentation";
}

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

function insertRequiredTagBoundaries(node: PMNode, schema: Schema): PMNode {
  if (!node.inlineContent || node.childCount < 2) return node;
  const children: PMNode[] = [];
  let changed = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type.name === "obsidian_tag" && children.length > 0) {
      const previous = children[children.length - 1];
      const hasBoundary =
        previous.type.name === "softbreak" ||
        previous.type.name === "hard_break" ||
        (previous.isText && /\s$/.test(previous.text ?? ""));
      if (!hasBoundary) {
        children.push(schema.text(" "));
        changed = true;
      }
    }
    children.push(child);
  }
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

function canonicalizeDestinationValue(value: unknown): string {
  // The parser delegates destination normalization to Markdown-it. Use that
  // exact owner here as well so invalid percent escapes, Unicode, and URI
  // punctuation cannot drift between PM attrs and reparsed attrs.
  return __mdit.normalizeLink(typeof value === "string" ? value : "");
}

function normalizeLinkAndImageAttrs(node: PMNode): PMNode {
  if (!node.inlineContent || node.childCount === 0) return node;
  const children: PMNode[] = [];
  let changed = false;

  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    let next = child;

    if (child.type.name === "image") {
      const width = Number.isFinite(child.attrs.width) && child.attrs.width > 0
        ? Math.floor(child.attrs.width as number)
        : null;
      const height = width !== null &&
          Number.isFinite(child.attrs.height) && child.attrs.height > 0
        ? Math.floor(child.attrs.height as number)
        : null;
      const attrs = {
        ...child.attrs,
        src: canonicalizeDestinationValue(child.attrs.src),
        alt: child.attrs.alt ? String(child.attrs.alt) : null,
        title: child.attrs.title ? String(child.attrs.title) : null,
        width,
        height,
        displayMode: child.attrs.displayMode === "full" ? "full" : null,
      };
      if (JSON.stringify(attrs) !== JSON.stringify(child.attrs)) {
        next = child.type.create(attrs, child.content, child.marks);
        changed = true;
      }
    }

    const marks = next.marks.map((mark) => {
      if (mark.type.name !== "link") return mark;
      const attrs = {
        ...mark.attrs,
        href: canonicalizeDestinationValue(mark.attrs.href),
        title: mark.attrs.title ? String(mark.attrs.title) : null,
      };
      if (JSON.stringify(attrs) === JSON.stringify(mark.attrs)) return mark;
      changed = true;
      return mark.type.create(attrs);
    });
    if (marks.some((mark, markIndex) => mark !== next.marks[markIndex])) {
      next = next.mark(marks);
    }
    children.push(next);
  }

  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

const WHITESPACE_EXPELLING_MARKS = new Set([
  "strong",
  "em",
  "strikethrough",
]);

const markExpelsWhitespace = (mark: PMNode["marks"][number]): boolean =>
  WHITESPACE_EXPELLING_MARKS.has(mark.type.name) ||
  (mark.type.name === "highlight" && !mark.attrs.color && !mark.attrs.html);

function normalizeExpelledMarkWhitespace(node: PMNode, schema: Schema): PMNode {
  if (!node.inlineContent || node.childCount === 0) return node;
  const children: PMNode[] = [];
  let changed = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (
      !child.isText ||
      !child.text ||
      child.marks.some((mark) => mark.type.name === "comment") ||
      !child.marks.some(markExpelsWhitespace)
    ) {
      children.push(child);
      continue;
    }
    const match = /^(\s*)(.*?)(\s*)$/s.exec(child.text);
    if (!match || (!match[1] && !match[3])) {
      children.push(child);
      continue;
    }
    const outerMarks = child.marks.filter(
      (mark) => !markExpelsWhitespace(mark),
    );
    if (match[1]) children.push(schema.text(match[1], outerMarks));
    if (match[2]) children.push(schema.text(match[2], child.marks));
    if (match[3]) children.push(schema.text(match[3], outerMarks));
    changed = true;
  }
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

function normalizeFlatListChildren(
  parent: PMNode,
): PMNode | null {
  const layout = flatListLayoutFor(parent);
  const hasRepresentableNestedEdgeByOwner = new Array<boolean>(
    parent.childCount,
  ).fill(false);
  const runStats = new Map<
    number,
    {
      count: number;
      hasMultipleBlocks: boolean;
      hasLooseItem: boolean;
      hasRepresentableNestedEdge: boolean;
      requiresLooseContainer: boolean;
    }
  >();

  for (let index = 0; index < parent.childCount; index++) {
    const child = parent.child(index);
    const entry = layout[index];
    if (!entry || child.type.name !== "list_item") continue;

    const stats = runStats.get(entry.runStartIndex) ?? {
      count: 0,
      hasMultipleBlocks: false,
      hasLooseItem: false,
      hasRepresentableNestedEdge: false,
      requiresLooseContainer: false,
    };
    stats.count += 1;
    // The schema inserts an empty leading paragraph when authored Markdown
    // starts a list item with another block (for example indented code). That
    // carrier has no source representation and must not make a one-block item
    // semantically loose by itself.
    const hasSyntheticLeadingParagraph =
      listItemHasSyntheticLeadingParagraph(child);
    const representedBlockCount = child.childCount -
      (hasSyntheticLeadingParagraph ? 1 : 0);
    stats.hasMultipleBlocks ||= representedBlockCount > 1;
    stats.hasLooseItem ||= child.attrs.tight === false;
    runStats.set(entry.runStartIndex, stats);
  }

  // A one-item run can still carry observable looseness when its represented
  // paragraph owns nested flat-list children. Preserve that authored state;
  // canonical serialization has a real parent-to-child edge on which to emit
  // the blank line. Block-first schema carriers are excluded by the shared
  // representability predicate.
  for (let index = 0; index < parent.childCount; index++) {
    const entry = layout[index];
    if (entry?.parentIndex === null || entry?.parentIndex === undefined) {
      continue;
    }
    const owner = parent.child(entry.parentIndex);
    if (!listItemCanRepresentLooseNestedEdge(owner)) continue;
    const ownerEntry = layout[entry.parentIndex];
    if (!ownerEntry) continue;
    hasRepresentableNestedEdgeByOwner[entry.parentIndex] = true;
    runStats.get(ownerEntry.runStartIndex)!.hasRepresentableNestedEdge = true;
  }

  // Flat descendants are siblings in the PM model, but Markdown reparses
  // them inside their owning list item. When a first nested marker cannot
  // interrupt the owner's paragraph, the required blank line makes that
  // owner's containing list loose. Retain that representable ancestor state
  // even for a one-item run instead of normalizing it back to tight.
  for (let index = 0; index < parent.childCount; index++) {
    const entry = layout[index];
    if (!entry || !listItemRequiresLooseParentEdge(parent, index, entry)) {
      continue;
    }
    const ownerEntry = layout[entry.parentIndex!];
    if (!ownerEntry) continue;
    runStats.get(ownerEntry.runStartIndex)!.requiresLooseContainer = true;
  }

  let changed = false;
  const children: PMNode[] = [];

  for (let index = 0; index < parent.childCount; index++) {
    const child = parent.child(index);
    const entry = layout[index];
    if (!entry || child.type.name !== "list_item") {
      children.push(child);
      continue;
    }

    const kind = listKind(child);
    const normalizedStart = kind === "ordered"
      ? entry.continuation
        ? null
        : orderedListStart(child.attrs.start)
      : null;
    const stats = runStats.get(entry.runStartIndex)!;
    // CommonMark tightness belongs to the containing list, not to an
    // individual item. Any item with multiple block children necessarily
    // makes the whole run loose because Markdown must separate those blocks
    // with a blank line. A one-item list whose sole block merely carries a
    // stale `tight: false` attribute has no distinct loose source form, so it
    // canonicalizes to tight unless a nested marker requires a blank parent
    // edge that makes the containing list observably loose.
    // A marker-only bullet/ordered item has no loose paragraph edge of its own
    // and reparses tight even when sibling items are loose. A task checkbox is
    // source paragraph content, so task items retain the run-derived value.
    // Marker-only non-task items can still own a tight nested edge.
    const normalizedTight = listItemIsMarkerOnly(child) &&
        !hasRepresentableNestedEdgeByOwner[index]
      ? true
      : !(
          stats.hasMultipleBlocks ||
          stats.requiresLooseContainer ||
          (stats.hasLooseItem &&
            (stats.count > 1 || stats.hasRepresentableNestedEdge))
        );
    if (
      entry.effectiveDepth !== entry.rawDepth ||
      child.attrs.start !== normalizedStart ||
      child.attrs.tight !== normalizedTight
    ) {
      children.push(child.type.create(
        {
          ...child.attrs,
          depth: entry.effectiveDepth,
          start: normalizedStart,
          tight: normalizedTight,
        },
        child.content,
        child.marks,
      ));
      changed = true;
    } else {
      children.push(child);
    }
  }

  return changed ? parent.copy(Fragment.fromArray(children)) : null;
}

function dropTopLevelEmptyParagraphs(doc: PMNode): PMNode | null {
  if (doc.type.name !== "doc" || doc.childCount <= 1) return null;
  let changed = false;
  const kids: PMNode[] = [];
  for (let i = 0; i < doc.childCount; i++) {
    const c = doc.child(i);
    if (c.type.name === "paragraph" && c.childCount === 0) {
      changed = true;
      continue;
    }
    kids.push(c);
  }
  if (!changed || kids.length === 0) return null;
  return doc.copy(Fragment.fromArray(kids));
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

function splitTextOnInlineMathSyntax(
  text: PMNode,
  schema: Schema,
): PMNode[] | null {
  if (!text.isText) return null;
  if (text.marks.some((mark) => mark.type.name === "code")) return null;
  const s = text.text!;
  if (!s.includes("$")) return null;
  const inlineMath = schema.nodes.inline_math;
  if (!inlineMath) return null;

  let changed = false;
  const out: PMNode[] = [];
  let plainStart = 0;
  let pos = 0;
  while (pos < s.length) {
    if (!isValidInlineMathOpenAt(s, pos)) {
      pos++;
      continue;
    }
    const close = findInlineMathClose(s, pos);
    if (close < 0) {
      pos++;
      continue;
    }
    const value = s.slice(pos + 1, close);
    if (!value.trim() || value !== value.trim()) {
      pos++;
      continue;
    }
    if (plainStart < pos) {
      out.push(schema.text(s.slice(plainStart, pos), text.marks));
    }
    out.push(inlineMath.create({ value, sourceRange: null }, null, text.marks));
    changed = true;
    pos = close + 1;
    plainStart = pos;
  }
  if (!changed) return null;
  if (plainStart < s.length) {
    out.push(schema.text(s.slice(plainStart), text.marks));
  }
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
    if (c.isText && c.text!.includes("$")) {
      const split = splitTextOnInlineMathSyntax(c, schema);
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

function isEmptyParagraph(node: PMNode): boolean {
  return node.type.name === "paragraph" && node.childCount === 0;
}

/**
 * Canonicalize transient empty paragraphs that Markdown cannot encode as
 * durable child blocks. Blank source lines separate blocks; they do not create
 * empty paragraph nodes between them.
 *
 * A list_item is the one schema-sensitive case: it must start with a
 * paragraph. When its first real block is not a paragraph, retain one empty
 * leading paragraph as the schema/parser filler. A sole empty paragraph is
 * also representable as a bare list marker. Blockquotes similarly retain one
 * empty paragraph when it is their only content (`> `).
 */
function normalizeContainerEmptyParagraphs(
  node: PMNode,
  schema: Schema,
): PMNode {
  const kind = node.type.name;
  if (
    kind !== "obsidian_callout" &&
    kind !== "blockquote" &&
    kind !== "list_item"
  ) {
    return node;
  }

  const nonEmpty: PMNode[] = [];
  let emptyCount = 0;
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (isEmptyParagraph(child)) emptyCount += 1;
    else nonEmpty.push(child);
  }
  if (emptyCount === 0) return node;

  if (kind === "obsidian_callout") {
    return node.copy(Fragment.fromArray(nonEmpty));
  }

  if (nonEmpty.length === 0) {
    // Both blockquote (`block+`) and list_item (`paragraph block*`) need one
    // child, and their sole empty paragraph has an exact Markdown form.
    const paragraph = schema.nodes.paragraph;
    return emptyCount === 1 || !paragraph
      ? node
      : node.copy(Fragment.from(paragraph.create()));
  }

  if (kind === "list_item" && nonEmpty[0].type.name !== "paragraph") {
    // The parser already supplies exactly one leading empty paragraph for
    // block-first list items. Retain that node and its ancestors by identity;
    // rebuilding an already-canonical carrier needlessly forfeits the item's
    // source-preservation range on a no-op save. For tasks this paragraph is
    // also the source-backed checkbox content, so preserving it is semantic.
    if (emptyCount === 1 && isEmptyParagraph(node.firstChild!)) {
      return node;
    }
    const paragraph = schema.nodes.paragraph;
    if (paragraph) nonEmpty.unshift(paragraph.create());
  }
  return node.copy(Fragment.fromArray(nonEmpty));
}

/**
 * Derive flat-list attrs from the persisted projection without deleting the
 * presentation tree's empty paragraphs. This keeps depth, numbering, and
 * tightness identical on disk and on screen even when an empty editor block
 * temporarily sits between list rows. Only list attrs are transferred back;
 * presentation children and their reference identities are retained.
 */
function normalizeFlatListChildrenForPresentation(
  parent: PMNode,
  schema: Schema,
): PMNode | null {
  let layoutParent = parent.type.name === "doc"
    ? dropTopLevelEmptyParagraphs(parent) ?? parent
    : normalizeContainerEmptyParagraphs(parent, schema);

  let projectedChildrenChanged = false;
  const projectedChildren: PMNode[] = [];
  for (let index = 0; index < layoutParent.childCount; index++) {
    const child = layoutParent.child(index);
    const projected = child.type.name === "list_item"
      ? normalizeContainerEmptyParagraphs(child, schema)
      : child;
    projectedChildrenChanged ||= projected !== child;
    projectedChildren.push(projected);
  }
  if (projectedChildrenChanged) {
    layoutParent = layoutParent.copy(Fragment.fromArray(projectedChildren));
  }

  const normalizedLayout =
    normalizeFlatListChildren(layoutParent) ?? layoutParent;
  const normalizedListItems: PMNode[] = [];
  for (let index = 0; index < normalizedLayout.childCount; index++) {
    const child = normalizedLayout.child(index);
    if (child.type.name === "list_item") normalizedListItems.push(child);
  }
  if (normalizedListItems.length === 0) return null;

  let listIndex = 0;
  let changed = false;
  const presentationChildren: PMNode[] = [];
  for (let index = 0; index < parent.childCount; index++) {
    const child = parent.child(index);
    if (child.type.name !== "list_item") {
      presentationChildren.push(child);
      continue;
    }
    const normalized = normalizedListItems[listIndex++];
    if (!normalized) {
      throw new Error("presentation list projection lost a list item");
    }
    const normalizedAttrs = normalized.attrs as Record<string, unknown>;
    const normalizedDepth = typeof normalizedAttrs.depth === "number"
      ? normalizedAttrs.depth
      : 0;
    const normalizedStart = typeof normalizedAttrs.start === "number"
      ? normalizedAttrs.start
      : null;
    const normalizedTight = normalizedAttrs.tight !== false;
    if (
      child.attrs.depth !== normalizedDepth ||
      child.attrs.start !== normalizedStart ||
      child.attrs.tight !== normalizedTight
    ) {
      presentationChildren.push(child.type.create(
        {
          ...child.attrs,
          depth: normalizedDepth,
          start: normalizedStart,
          tight: normalizedTight,
        },
        child.content,
        child.marks,
      ));
      changed = true;
    } else {
      presentationChildren.push(child);
    }
  }
  if (listIndex !== normalizedListItems.length) {
    throw new Error("presentation list projection added a list item");
  }
  return changed ? parent.copy(Fragment.fromArray(presentationChildren)) : null;
}

function normalizeCodeBlockLanguage(node: PMNode): PMNode {
  if (node.type.name !== "code_block") return node;
  const language = String(node.attrs.language ?? "")
    .replace(/\0/g, "\uFFFD")
    .replace(/\r\n?|\n/g, " ")
    .trim();
  return language === node.attrs.language
    ? node
    : node.type.create(
        { ...node.attrs, language },
        node.content,
        node.marks,
      );
}

// ── Top-level walk ───────────────────────────────────────────────

/**
 * Apply all save-time normalizations to a PM doc. Returns a new
 * doc; the input is not mutated. Idempotent — normalize(normalize(d))
 * === normalize(d) in structure (reference identity preserved when
 * nothing changes).
 */
export function normalizeDocForSave(
  doc: PMNode,
  options: NormalizeDocForSaveOptions = {},
): PMNode {
  const schema = doc.type.schema;
  const presentation = options.mode === "presentation";
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
    // Empty source lines are separators, not durable nested paragraph nodes.
    // Canonicalize transient Enter/split shapes before parent list tightness is
    // derived so the layout calculation observes the representable tree.
    if (!presentation) {
      current = normalizeContainerEmptyParagraphs(current, schema);
    }
    current = normalizeCodeBlockLanguage(current);
    // Apply node-shape-specific normalizations.
    // 0. Drop empty list_items — they never survive round-trip
    //    (bare `- ` is interpreted differently per context).
    // 1. Canonicalize link/image attrs to values CommonMark can represent.
    current = normalizeLinkAndImageAttrs(current);
    // 2. CommonMark emphasis-like marks cannot own edge whitespace.
    if (!presentation) {
      current = normalizeExpelledMarkWhitespace(current, schema);
    }
    // 3. Inline Obsidian tags require a whitespace/start boundary.
    current = insertRequiredTagBoundaries(current, schema);
    // 4. Textblock text-with-newline split into softbreak runs. Heading
    // whitespace is preserved by numeric-entity encoding in the serializer.
    const textSplit = normalizeTextNodesInInline(current, schema);
    if (textSplit) current = textSplit;
    // 6. Paragraph block_id hoist.
    if (current.type.name === "paragraph" && current.childCount > 1) {
      const kids: PMNode[] = [];
      for (let i = 0; i < current.childCount; i++) kids.push(current.child(i));
      const hoisted = hoistBlockIdsToEnd(kids);
      if (hoisted !== kids) {
        current = current.copy(Fragment.fromArray(hoisted));
      }
    }
    // 8. Resolve flat-list ancestry in one linear pass. Explicit ordered-run
    //    boundaries remain in the `start` attr; the shared serializer layout
    //    represents them by alternating CommonMark `.` / `)` delimiters.
    const normalizedLists = presentation
      ? normalizeFlatListChildrenForPresentation(current, schema)
      : normalizeFlatListChildren(current);
    if (normalizedLists) current = normalizedLists;
    return current;
  };

  // Top-level pass: walk + apply container-level transforms (orphan-
  // li clamp needs parent context; embed-inline promote replaces the
  // node entirely).
  const topChildren: PMNode[] = [];
  let topChildrenChanged = false;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const walked = walk(child);
    topChildrenChanged ||= walked !== child;
    topChildren.push(walked);
  }
  // Build a temporary parent so we can apply position-aware ops.
  const tempDoc = topChildrenChanged
    ? doc.copy(Fragment.fromArray(topChildren))
    : doc;

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

  // 5. Drop transient top-level empty paragraphs before deriving list runs.
  // Markdown blank lines are separators, not paragraph nodes; once removed,
  // formerly separated list items may become one run and must be normalized in
  // that final adjacency rather than against the transient editor tree.
  const withoutEmptyParagraphs = presentation
    ? afterPromote
    : dropTopLevelEmptyParagraphs(afterPromote) ?? afterPromote;

  // 6. Resolve top-level flat-list structure after every order-changing
  // normalization. Inner containers were handled by `walk`; this is the same
  // owner and linear pass.
  const normalizedTopLists = presentation
    ? normalizeFlatListChildrenForPresentation(withoutEmptyParagraphs, schema)
    : normalizeFlatListChildren(withoutEmptyParagraphs);
  return normalizedTopLists ?? withoutEmptyParagraphs;
}
