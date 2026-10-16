import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import linkRule from "markdown-it/lib/rules_inline/link.mjs";
import imageRule from "markdown-it/lib/rules_inline/image.mjs";
import type { Node as PMNode } from "prosemirror-model";
import { Fragment, Mark, Slice } from "prosemirror-model";
import { canEncodeButterFileUtf8 } from "./file-shell";
import { hasOnlyQualifiedHtmlAttributes, readHtmlElement, protectHtmlSource } from "./html-source-safety";

/** The complete editable label owns one native source occurrence, independently
 * of the anchor prefix that remains clickable before a nested native anchor. */
export interface LinkOccurrence {
  readonly id: string;
  readonly syntax: "inline" | "reference" | "html";
  readonly href: string;
  readonly title: string | null;
  readonly reference: string | null;
  readonly referenceForm?: "full" | "collapsed" | "shortcut" | null;
  readonly resolved?: boolean;
  readonly labelSource?: string | null;
  readonly labelSignature?: string | null;
  readonly labelOuterMarks?: readonly { readonly type: string; readonly attrs: Readonly<Record<string, unknown>> }[] | null;
}

const outerMarkNames = new Set(["strong", "em", "code", "strikethrough", "highlight", "underline", "superscript", "subscript", "kbd", "font"]);
function validOuterMarks(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  return value.every((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const mark = entry as Record<string, unknown>;
    if (typeof mark.type !== "string" || !outerMarkNames.has(mark.type) || names.has(mark.type) || !mark.attrs || typeof mark.attrs !== "object" || Array.isArray(mark.attrs)) return false;
    names.add(mark.type);
    return Object.values(mark.attrs).every(value => typeof value === "string" && canEncodeButterFileUtf8(value) && !value.includes("\0") || typeof value === "boolean" || value === null);
  });
}

export function isLinkOccurrence(value: Readonly<Record<string, unknown>>): value is Readonly<Record<string, unknown>> & LinkOccurrence {
  return typeof value.id === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value.id) &&
    ["inline", "reference", "html"].includes(String(value.syntax)) && typeof value.href === "string" &&
    (value.title === null || typeof value.title === "string") &&
    (value.reference === null || typeof value.reference === "string") &&
    [value.href, value.title ?? "", value.reference ?? ""].every(item => canEncodeButterFileUtf8(String(item)) && !/\0/.test(String(item))) &&
    !/[\r\n]/.test(value.href) &&
    typeof value.resolved === "boolean" &&
    (value.syntax === "reference" ? Boolean(value.reference) && value.href === "" && value.title === null &&
      ["full", "collapsed", "shortcut"].includes(String(value.referenceForm)) && typeof value.labelSource === "string" &&
      typeof value.labelSignature === "string" && canEncodeButterFileUtf8(value.labelSource) && !/\0/.test(value.labelSource) && validOuterMarks(value.labelOuterMarks)
      : value.reference === null && value.referenceForm === null && value.labelSource === null && value.labelSignature === null && value.labelOuterMarks === null && value.resolved === true);
}

export function linkOccurrence(node: PMNode): Mark | undefined {
  return node.marks.find(mark => mark.type.name === "link_occurrence");
}

let grammar: MarkdownIt | undefined;
let labelCodec: ((children: readonly PMNode[], footnotes: ReadonlySet<string>) => string) | undefined;
let imageAltCodec: ((node: PMNode) => string) | undefined;


export function setLinkOccurrenceLabelCodec(codec: (children: readonly PMNode[], footnotes: ReadonlySet<string>) => string): void { labelCodec = codec; }
export function setReferenceImageAltCodec(codec: (node: PMNode) => string): void { imageAltCodec = codec; }

function imageAltSignature(node: PMNode): string {
  return JSON.stringify([node.attrs.alt, node.attrs.width, node.attrs.height, node.attrs.displayMode]);
}

function referenceImageAltValue(source: string): string | null {
  if (!grammar) return null;
  // Native dimension suffixes belong only to inline destinations. Reference
  // labels retain the entire literal alt, including a `|64x40` suffix.
  return grammar.utils.unescapeAll(source);
}

export function referenceImageSource(node: PMNode): string | null {
  if (node.type.name !== "image" || node.attrs.sourceSyntax !== "reference") return null;
  const suffix = node.attrs.referenceForm === "shortcut" ? "]" : node.attrs.referenceForm === "collapsed" ? "][]" : `][${String(node.attrs.reference)}]`;
  return `![${String(node.attrs.sourceAlt)}${suffix}`;
}

export function referenceImageDisplayText(node: PMNode): string | null {
  const source = referenceImageSource(node);
  return source === null ? null : grammar?.utils.unescapeAll(source) ?? source;
}

export function prepareImageSourceEdit(node: PMNode, updated: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return (updated.src !== undefined && updated.src !== node.attrs.src || updated.title !== undefined && updated.title !== node.attrs.title)
    ? { ...node.attrs, ...updated, sourceSyntax: "inline", reference: null, referenceForm: null, resolved: true, sourceAlt: null, altSignature: null }
    : { ...node.attrs, ...updated };
}

export function isImageSourceOwnership(attrs: Readonly<Record<string, unknown>>): boolean {
  return ["inline", "reference", "html"].includes(String(attrs.sourceSyntax)) && typeof attrs.resolved === "boolean" &&
    (attrs.sourceSyntax === "reference" ? typeof attrs.reference === "string" && attrs.reference.length > 0 &&
      ["full", "collapsed", "shortcut"].includes(String(attrs.referenceForm)) && typeof attrs.sourceAlt === "string" &&
      typeof attrs.altSignature === "string" && canEncodeButterFileUtf8(attrs.reference) && canEncodeButterFileUtf8(attrs.sourceAlt) &&
      !/[\0]/.test(attrs.reference + attrs.sourceAlt) && attrs.width === null && attrs.height === null && attrs.displayMode === null
      : attrs.reference === null && attrs.referenceForm === null && attrs.sourceAlt === null && attrs.altSignature === null && attrs.resolved === true);
}

export function isEmptyLinkSourceOwnership(attrs: Readonly<Record<string, unknown>>): boolean {
  return ["inline", "reference", "html"].includes(String(attrs.sourceSyntax)) && typeof attrs.resolved === "boolean" &&
    typeof attrs.href === "string" && (attrs.title === null || typeof attrs.title === "string") &&
    [attrs.href, attrs.title ?? ""].every(value => canEncodeButterFileUtf8(String(value)) && !/\0/.test(String(value))) && !/[\r\n]/.test(attrs.href) &&
    (attrs.sourceSyntax === "reference" ? attrs.href === "" && attrs.title === null && typeof attrs.reference === "string" &&
      attrs.reference.length > 0 && attrs.referenceForm === "full" && canEncodeButterFileUtf8(attrs.reference) && !/\0/.test(attrs.reference)
      : attrs.reference === null && attrs.referenceForm === null && attrs.resolved === true);
}

function labelSignature(children: readonly PMNode[], footnotes: ReadonlySet<string>): string {
  const signature = (node: PMNode): unknown => {
    const ignored = node.type.name === "image" && node.attrs.sourceSyntax === "reference"
      ? ["sourceRange", "blockId", "src", "title", "resolved", "altSignature"] : ["sourceRange", "blockId"];
    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries<unknown>(node.attrs).filter(([key]) => !ignored.includes(key))) {
      Object.defineProperty(attrs, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return { type: node.type.name, attrs, text: node.text,
      ...(node.type.name === "footnote_ref" ? { footnoteDefined: footnotes.has(String(node.attrs.label)) } : {}),
      marks: node.marks.filter(mark => !["link", "link_occurrence"].includes(mark.type.name)).map(mark => ({ type: mark.type.name, attrs: mark.attrs })),
      content: Array.from({ length: node.childCount }, (_, index) => signature(node.child(index))) };
  };
  return JSON.stringify(children.map(signature));
}

/** Formatting may split text leaves without changing the source label/key. */
function projectedLabelSignature(value: string, outer: readonly { readonly type: string; readonly attrs: Readonly<Record<string, unknown>> }[] | null): string {
  const project = (entry: unknown): unknown => {
    if (Array.isArray(entry)) {
      const result: unknown[] = [];
      for (const item of entry.map(project)) {
        const previous = result[result.length - 1] as Record<string, unknown> | undefined;
        const current = item as Record<string, unknown> | null;
        if (previous?.type === "text" && current?.type === "text" &&
          JSON.stringify({ ...previous, text: "" }) === JSON.stringify({ ...current, text: "" })) previous.text = String(previous.text) + String(current.text);
        else result.push(item);
      }
      return result;
    }
    if (!entry || typeof entry !== "object") return entry;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(entry)) {
      if (key === "marks") {
        if (outer !== null) result[key] = (item as Array<{ type: string; attrs: unknown }>).filter(mark =>
          !outer.some(peer => peer.type === mark.type && JSON.stringify(peer.attrs) === JSON.stringify(mark.attrs)));
      } else if (key !== "footnoteDefined" || outer !== null) result[key] = project(item);
    }
    return result;
  };
  try { return JSON.stringify(project(JSON.parse(value) as unknown)); } catch { return ""; }
}

type ProjectionCache = WeakMap<PMNode, { readonly context: object; readonly result: PMNode }>;
function mapOwnerRuns(doc: PMNode, update: (owner: Mark, children: readonly PMNode[]) => readonly PMNode[], cache?: ProjectionCache, context?: object): PMNode {
  const walk = (node: PMNode): PMNode => {
    const cached = cache?.get(node); if (cached && cached.context === context) return cached.result;
    let changed = false; const children: PMNode[] = [];
    if (!node.inlineContent) {
      node.forEach(child => { const next = walk(child); changed ||= next !== child; children.push(next); });
    } else {
      let owner: Mark | undefined, run: PMNode[] = [];
      const flush = (): void => { const next = owner ? update(owner, run) : run; next.forEach((child, index) => { changed ||= child !== run[index]; children.push(child); }); run = []; };
      node.forEach(child => {
        const next = linkOccurrence(child);
        if (Boolean(owner) !== Boolean(next) || owner && next && !owner.eq(next)) flush();
        owner = next; run.push(child);
      });
      flush();
    }
    const result = changed ? node.copy(Fragment.fromArray(children)) : node;
    if (context) cache?.set(node, { context, result });
    return result;
  };
  return walk(doc);
}

/** Called only after a genuine source parse, never to bless a changed label. */
export function stampLinkOccurrenceLabels(doc: PMNode): PMNode {
  const footnotes = definitionInventory(doc).footnotes;
  const stamped = mapOwnerRuns(doc, (owner, children) => {
    if (owner.attrs.syntax !== "reference") return children;
    const next = owner.type.create({ ...owner.attrs, labelSignature: labelSignature(children, footnotes) });
    return children.map(child => child.mark(child.marks.map(mark => mark === owner ? next : mark)));
  });
  const images = (node: PMNode): PMNode => {
    if (node.type.name === "image" && node.attrs.sourceSyntax === "reference") return node.type.create({ ...node.attrs, altSignature: imageAltSignature(node) }, node.content, node.marks);
    let changed = false; const children: PMNode[] = [];
    node.forEach(child => { const next = images(child); changed ||= next !== child; children.push(next); });
    return changed ? node.copy(Fragment.fromArray(children)) : node;
  };
  return images(stamped);
}

interface DefinitionInventory { references: Record<string, { href: string; title: string }>; footnotes: Set<string>; nodes: readonly PMNode[]; }
const definitionNodes = new WeakMap<PMNode, readonly PMNode[]>();
const parsedDefinitions = new WeakMap<PMNode, Record<string, { href: string; title: string }>>();
let lastDefinitions: DefinitionInventory | undefined;
function definitionInventory(doc: PMNode): DefinitionInventory {
  const gather = (node: PMNode): readonly PMNode[] => {
    const cached = definitionNodes.get(node); if (cached) return cached;
    const entries = ["reference_definition", "footnote_def"].includes(node.type.name) ? [node] : [];
    node.forEach(child => entries.push(...gather(child)));
    definitionNodes.set(node, entries); return entries;
  };
  const nodes = gather(doc);
  if (lastDefinitions && nodes.length === lastDefinitions.nodes.length && nodes.every((node, index) => node === lastDefinitions!.nodes[index])) return lastDefinitions;
  const references = Object.create(null) as Record<string, { href: string; title: string }>;
  const footnotes = new Set<string>();
  for (const node of nodes) {
    if (node.type.name === "reference_definition" && grammar) {
      let parsed = parsedDefinitions.get(node);
      if (!parsed) { parsed = Object.create(null) as Record<string, { href: string; title: string }>; grammar.block.parse(String(node.attrs.raw), grammar, { references: parsed }, []); parsedDefinitions.set(node, parsed); }
      for (const [label, target] of Object.entries(parsed)) if (!(label in references)) references[label] = target;
    }
    if (node.type.name === "footnote_def") footnotes.add(String(node.attrs.label));
  }
  return lastDefinitions = { references, footnotes, nodes };
}

export function linkOccurrenceFootnoteDefinitions(doc: PMNode): ReadonlySet<string> { return definitionInventory(doc).footnotes; }

export function isNativeNestedLinkAnchor(node: PMNode, footnotes: ReadonlySet<string>): boolean {
  return !node.marks.some(mark => mark.type.name === "comment") && (["obsidian_tag", "wikilink", "inline_footnote"].includes(node.type.name) ||
    node.type.name === "footnote_ref" && footnotes.has(String(node.attrs.label)));
}

export function resolvedLinkOccurrenceDestination(doc: PMNode, owner: Mark): { href: string; title: string | null } | null {
  if (!isLinkOccurrence(owner.attrs)) return null;
  if (owner.attrs.syntax !== "reference") return { href: owner.attrs.href, title: owner.attrs.title };
  const definition = definitionInventory(doc).references[grammar?.utils.normalizeReference(owner.attrs.reference!) ?? owner.attrs.reference!];
  return definition ? { href: definition.href, title: definition.title || null } : null;
}

export function unresolvedLinkDelimiters(owner: Mark): { prefix: string; suffix: string } | null {
  if (owner.type.name !== "link_occurrence" || owner.attrs.syntax !== "reference" || owner.attrs.resolved !== false) return null;
  const key = grammar?.utils.unescapeAll(String(owner.attrs.reference)) ?? String(owner.attrs.reference);
  return { prefix: "[", suffix: owner.attrs.referenceForm === "shortcut" ? "]" : owner.attrs.referenceForm === "collapsed" ? "][]" : `][${key}]` };
}

export function createInlineLinkOccurrence(doc: PMNode, href: string, title: string | null = null): Mark {
  const used = new Set<string>();
  doc.descendants(node => { const owner = linkOccurrence(node); if (owner) used.add(String(owner.attrs.id)); });
  let ordinal = 0;
  while (used.has(`g${++ordinal}`)) { /* Allocate only on an explicit new-link action. */ }
  return doc.type.schema.marks.link_occurrence.create({ id: `g${ordinal}`, syntax: "inline", href: grammar?.normalizeLink(href) ?? href, title: title || null, reference: null });
}

const unownedLinks = new WeakMap<PMNode, boolean>();
function hasUnownedLinks(node: PMNode): boolean {
  const cached = unownedLinks.get(node); if (cached !== undefined) return cached;
  let found = Boolean(node.marks.some(mark => mark.type.name === "link") && !linkOccurrence(node));
  node.forEach(child => { if (!found && hasUnownedLinks(child)) found = true; });
  unownedLinks.set(node, found); return found;
}
export function seedLinkOccurrences(doc: PMNode): PMNode {
  if (!hasUnownedLinks(doc)) return doc;
  const used = new Set<string>();
  doc.descendants(node => { const owner = linkOccurrence(node); if (owner) used.add(String(owner.attrs.id)); });
  let ordinal = 0;
  const walk = (node: PMNode): PMNode => {
    if (!node.inlineContent) {
      const children: PMNode[] = []; let changed = false;
      node.forEach(child => { const next = walk(child); children.push(next); changed ||= next !== child; });
      return changed ? node.copy(Fragment.fromArray(children)) : node;
    }
    const children: PMNode[] = []; let changed = false;
    let prior: Mark | undefined, owner: Mark | undefined;
    node.forEach(child => {
      const actual = child.marks.find(mark => mark.type.name === "link");
      if (!actual || linkOccurrence(child)) { prior = undefined; children.push(child); return; }
      if (!prior?.eq(actual)) {
        let id: string; do { id = `generated${++ordinal}`; } while (used.has(id)); used.add(id);
        const fields = actual.attrs as { readonly href: string; readonly title: string | null };
        owner = node.type.schema.marks.link_occurrence.create({ id, syntax: "inline", href: fields.href, title: fields.title, reference: null });
      }
      prior = actual;
      children.push(child.mark(owner!.addToSet(child.marks))); changed = true;
    });
    return changed ? node.copy(Fragment.fromArray(children)) : node;
  };
  return walk(doc);
}

/** Reconcile only the anchor projection. Label text, formatting, source class,
 * target ownership, and occurrence boundaries are never discarded. */
const imageProjections: ProjectionCache = new WeakMap();
const referenceProjections: ProjectionCache = new WeakMap();
const anchorProjections: ProjectionCache = new WeakMap();
export function projectLinkOccurrences(doc: PMNode): PMNode {
  doc = seedLinkOccurrences(doc);
  const inventory = definitionInventory(doc), { references, footnotes } = inventory;
  const projectImages = (node: PMNode): PMNode => {
    const cached = imageProjections.get(node); if (cached?.context === inventory) return cached.result;
    if (node.type.name === "image" && node.attrs.sourceSyntax === "reference" && isImageSourceOwnership(node.attrs)) {
      const key = grammar?.utils.normalizeReference(String(node.attrs.reference)) ?? String(node.attrs.reference);
      const target = references[key];
      const signature = imageAltSignature(node), edited = signature !== node.attrs.altSignature;
      const alt = !edited && Boolean(target) !== node.attrs.resolved ? referenceImageAltValue(String(node.attrs.sourceAlt)) : null;
      const baseline = alt === null ? node.attrs : { ...node.attrs, alt: alt || null };
      const attrs = { ...baseline, src: target?.href ?? "", title: target?.title || null, resolved: Boolean(target),
        ...(!edited && alt !== null ? { altSignature: JSON.stringify([baseline.alt, baseline.width, baseline.height, baseline.displayMode]) } : {}),
        ...(edited && imageAltCodec ? { sourceAlt: imageAltCodec(node), referenceForm: "full", altSignature: signature } : {}) };
      const result = JSON.stringify(attrs) === JSON.stringify(node.attrs) ? node : node.type.create(attrs, node.content, node.marks);
      imageProjections.set(node, { context: inventory, result }); return result;
    }
    if (node.type.name === "empty_link" && node.attrs.sourceSyntax === "reference" && isEmptyLinkSourceOwnership(node.attrs)) {
      const key = grammar?.utils.normalizeReference(String(node.attrs.reference)) ?? String(node.attrs.reference);
      const resolved = Boolean(references[key]);
      const result = node.attrs.resolved === resolved ? node : node.type.create({ ...node.attrs, resolved }, node.content, node.marks);
      imageProjections.set(node, { context: inventory, result }); return result;
    }
    let changed = false; const children: PMNode[] = [];
    node.forEach(child => { const next = projectImages(child); changed ||= next !== child; children.push(next); });
    const result = changed ? node.copy(Fragment.fromArray(children)) : node;
    imageProjections.set(node, { context: inventory, result }); return result;
  };
  doc = projectImages(doc);
  doc = mapOwnerRuns(doc, (owner, children) => {
    if (owner.attrs.syntax !== "reference" || !isLinkOccurrence(owner.attrs)) return children;
    const signature = labelSignature(children, footnotes);
    const edited = signature !== owner.attrs.labelSignature;
    if (edited && !labelCodec) return children;
    const key = grammar?.utils.normalizeReference(owner.attrs.reference!) ?? owner.attrs.reference!;
    const outer = (owner.attrs.labelOuterMarks ?? []).filter(mark => children.every(child =>
      child.marks.some(peer => peer.type.name === mark.type && JSON.stringify(peer.attrs) === JSON.stringify(mark.attrs))));
    const clean = children.map(child => child.mark(child.marks.filter(mark => !outer.some(peer => peer.type === mark.type.name && JSON.stringify(peer.attrs) === JSON.stringify(mark.attrs)))));
    const contentEdited = projectedLabelSignature(signature, null) !== projectedLabelSignature(String(owner.attrs.labelSignature), null);
    const sourceUnchanged = projectedLabelSignature(signature, outer) === projectedLabelSignature(String(owner.attrs.labelSignature), outer);
    const next = owner.type.create({ ...owner.attrs, resolved: Boolean(references[key]),
      ...(edited ? { referenceForm: contentEdited || !sourceUnchanged && Boolean(references[key]) ? "full" : owner.attrs.referenceForm,
        labelSource: sourceUnchanged ? owner.attrs.labelSource : labelCodec!(clean, footnotes), labelSignature: signature, labelOuterMarks: outer } : {}) });
    return next.eq(owner) ? children : children.map(child => child.mark(child.marks.map(mark => mark === owner ? next : mark)));
  }, referenceProjections, inventory);
  const walk = (node: PMNode): PMNode => {
    const cached = anchorProjections.get(node); if (cached?.context === inventory) return cached.result;
    if (!node.inlineContent) {
      let changed = false;
      const children: PMNode[] = [];
      node.forEach(child => { const next = walk(child); children.push(next); changed ||= next !== child; });
      const result = changed ? node.copy(Fragment.fromArray(children)) : node;
      anchorProjections.set(node, { context: inventory, result }); return result;
    }
    let prior: Mark | undefined, cut = false, changed = false;
    const children: PMNode[] = [];
    const visiblePrefixes = new Map<Mark, boolean>();
    let run: PMNode[] = [], runOwner: Mark | undefined;
    const inspectPrefix = (): void => {
      if (!runOwner) { run = []; return; }
      let visible = false;
      for (const child of run) {
        if (child.marks.some(mark => mark.type.name === "comment")) continue;
        if (["obsidian_tag", "wikilink", "inline_footnote"].includes(child.type.name) ||
          child.type.name === "footnote_ref" && footnotes.has(String(child.attrs.label))) break;
        if (child.isText && Boolean(child.text) || ["softbreak", "hard_break", "image", "inline_math", "obsidian_embed_inline"].includes(child.type.name)) visible = true;
      }
      visiblePrefixes.set(runOwner, visible); run = [];
    };
    node.forEach(child => { const owner = linkOccurrence(child); if (Boolean(owner) !== Boolean(runOwner) || owner && runOwner && !owner.eq(runOwner)) inspectPrefix(); runOwner = owner; run.push(child); });
    inspectPrefix();
    node.forEach(child => {
      const owner = linkOccurrence(child);
      if (!owner) { prior = undefined; children.push(child); return; }
      if (!prior?.eq(owner)) cut = false;
      prior = owner;
      if (!isLinkOccurrence(owner.attrs)) { children.push(child); return; }
      const hidden = child.marks.some(mark => mark.type.name === "comment");
      if (!hidden && (child.type.name === "obsidian_tag" || child.type.name === "wikilink" || child.type.name === "inline_footnote" ||
        child.type.name === "footnote_ref" && footnotes.has(String(child.attrs.label)))) cut = true;
      let marks: readonly Mark[] = child.marks.filter(mark => mark.type.name !== "link");
      const target = owner.attrs.syntax === "reference" ? references[grammar?.utils.normalizeReference(owner.attrs.reference!) ?? owner.attrs.reference!] : { href: owner.attrs.href, title: owner.attrs.title };
      const ownsAnchor = ["wikilink", "obsidian_tag", "footnote_ref", "inline_footnote", "block_id", "comment_navigation", "empty_link"].includes(child.type.name);
      if (!cut && target && !ownsAnchor && (!hidden || visiblePrefixes.get(owner))) marks = node.type.schema.marks.link.create({ href: target.href, title: target.title || null }).addToSet(marks);
      const next = Mark.sameSet(child.marks, marks) ? child : child.mark(marks);
      changed ||= next !== child;
      children.push(next);
    });
    const result = changed ? node.copy(Fragment.fromArray(children)) : node;
    anchorProjections.set(node, { context: inventory, result }); return result;
  };
  return walk(doc);
}

const validatedNodes = new WeakMap<PMNode, boolean>();
export function hasValidLinkOccurrences(doc: PMNode): boolean {
  const cached = validatedNodes.get(doc); if (cached !== undefined) return cached;
  const owner = linkOccurrence(doc);
  let valid = !(owner && !isLinkOccurrence(owner.attrs) || doc.type.name === "image" && !isImageSourceOwnership(doc.attrs) ||
    doc.type.name === "empty_link" && !isEmptyLinkSourceOwnership(doc.attrs));
  doc.forEach(child => { if (valid && !hasValidLinkOccurrences(child)) valid = false; });
  validatedNodes.set(doc, valid); return valid;
}

export interface LinkOccurrenceRange { readonly from: number; readonly to: number; readonly mark: Mark; }

/** Find one complete contiguous occurrence without combining an adjacent
 * equal-target label. This also reaches the inactive tag-owned label tail. */
export function linkOccurrenceRange(doc: PMNode, position: number): LinkOccurrenceRange | null {
  const resolved = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
  if (!resolved.parent.inlineContent) return null;
  const anchor = (resolved.nodeAfter && linkOccurrence(resolved.nodeAfter)) || (resolved.nodeBefore && linkOccurrence(resolved.nodeBefore));
  if (!anchor) return null;
  let start = -1, end = -1, found: LinkOccurrenceRange | null = null;
  const flush = (): void => { if (start >= 0 && position >= start && position <= end && !found) found = { from: start, to: end, mark: anchor }; start = -1; end = -1; };
  resolved.parent.forEach((child, offset) => {
    if (linkOccurrence(child)?.eq(anchor)) {
      const from = resolved.start() + offset, to = from + child.nodeSize;
      if (start < 0) start = from;
      end = to;
    } else flush();
  });
  flush(); return found;
}

function mapInlineOwners(doc: PMNode, allocate: (owner: Mark, first: boolean) => Mark): PMNode {
  const walk = (node: PMNode): PMNode => {
    if (node.inlineContent || node.firstChild?.isInline) {
      let prior: Mark | undefined, changed = false;
      const children: PMNode[] = [];
      node.forEach(child => {
        const owner = linkOccurrence(child);
        const next = owner ? allocate(owner, !prior?.eq(owner)) : undefined;
        prior = owner;
        const replacement = next && !next.eq(owner!) ? child.mark(child.marks.map(mark => mark === owner ? next : mark)) : child;
        changed ||= replacement !== child;
        children.push(replacement);
      });
      return changed ? node.copy(Fragment.fromArray(children)) : node;
    }
    const children: PMNode[] = [];
    let changed = false;
    node.forEach(child => { const next = walk(child); children.push(next); changed ||= next !== child; });
    return changed ? node.copy(Fragment.fromArray(children)) : node;
  };
  return walk(doc);
}

/** IDs are an explicit boundary encoding. Canonical ordinals keep exact
 * fingerprints deterministic while retaining adjacent equal-target owners. */
export function canonicalizeLinkOccurrences(doc: PMNode): PMNode {
  let ordinal = 0, active: Mark | undefined;
  return mapInlineOwners(doc, (owner, first) => {
    if (first) active = owner.type.create({ ...owner.attrs, id: `l${++ordinal}` });
    return active!;
  });
}

export function freshenDuplicateLinkOccurrences(doc: PMNode): PMNode {
  const runs = occurrenceRuns(doc);
  const used = new Set(runs.map(owner => String(owner.attrs.id))), assigned = new Set<string>();
  if (used.size === runs.length) return doc;
  let next = 0, active: Mark | undefined;
  return mapInlineOwners(doc, (owner, first) => {
    if (first) {
      const current = String(owner.attrs.id);
      if (!assigned.has(current)) { assigned.add(current); active = owner; }
      else {
        let id: string;
        do { id = `r${++next}`; } while (used.has(id));
        used.add(id); assigned.add(id); active = owner.type.create({ ...owner.attrs, id });
      }
    }
    return active!;
  });
}

const occurrenceRunCache = new WeakMap<PMNode, readonly Mark[]>();
/** Immutable subtree inventory. Ordinary label typing examines only the new
 * path and its inline siblings, rather than walking every leaf in the note. */
function occurrenceRuns(node: PMNode): readonly Mark[] {
  const cached = occurrenceRunCache.get(node); if (cached) return cached;
  const runs: Mark[] = [];
  if (node.inlineContent || node.firstChild?.isInline) {
    let prior: Mark | undefined;
    node.forEach(child => { const owner = linkOccurrence(child); if (owner && !prior?.eq(owner)) runs.push(owner); prior = owner; });
  } else node.forEach(child => { runs.push(...occurrenceRuns(child)); });
  occurrenceRunCache.set(node, runs); return runs;
}

/** Source-slice eligibility ignores only the absolute numbering shift caused
 * by an earlier occurrence. Exact relative runs, cardinality, payload, marks,
 * source class and all other attrs must still match the loaded block. */
export function linkOccurrenceShapeEquals(left: PMNode, right: PMNode): boolean {
  return left.eq(right) || canonicalizeLinkOccurrences(left).eq(canonicalizeLinkOccurrences(right));
}

/** Freshen before fitting: PM must not merge an imported occurrence with an
 * adjacent current occurrence just because their source IDs happen to match. */
export function freshenLinkOccurrenceSlice(doc: PMNode, slice: Slice): Slice {
  const used = new Set<string>();
  doc.descendants(node => { const owner = linkOccurrence(node); if (owner) used.add(String(owner.attrs.id)); });
  let next = 0, active: Mark | undefined;
  const schema = doc.type.schema;
  const wrapper = schema.nodes.doc.create(null, slice.content);
  const projected = mapOwnerRuns(wrapper, (owner, children) => {
    if (owner.attrs.syntax !== "reference" || !isLinkOccurrence(owner.attrs)) return children;
    const footnotes = definitionInventory(doc).footnotes;
    const signature = labelSignature(children, footnotes);
    if (signature === owner.attrs.labelSignature || !labelCodec) return children;
    const outer = (owner.attrs.labelOuterMarks ?? []).filter(mark => children.every(child =>
      child.marks.some(peer => peer.type.name === mark.type && JSON.stringify(peer.attrs) === JSON.stringify(mark.attrs))));
    const clean = children.map(child => child.mark(child.marks.filter(mark => !outer.some(peer => peer.type === mark.type.name && JSON.stringify(peer.attrs) === JSON.stringify(mark.attrs)))));
    const next = owner.type.create({ ...owner.attrs, referenceForm: "full", labelSource: labelCodec(clean, footnotes), labelSignature: signature, labelOuterMarks: outer });
    return children.map(child => child.mark(child.marks.map(mark => mark === owner ? next : mark)));
  });
  const fresh = mapInlineOwners(projected, (owner, first) => {
    if (first) {
      let id: string;
      do { id = `p${++next}`; } while (used.has(id));
      used.add(id);
      active = owner.type.create({ ...owner.attrs, id });
    }
    return active!;
  });
  return fresh === wrapper ? slice : new Slice(fresh.content, slice.openStart, slice.openEnd);
}

/** Same inline state and grammar, with one native distinction: genuine wiki
 * and footnote tokens can be contained by a Markdown label. A nested ordinary
 * Markdown link remains an independent anchor rather than a guessed label. */
function htmlAttributes(md: MarkdownIt, source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z][A-Za-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const key = match[1].toLowerCase();
    if (!(key in result)) result[key] = (match[2] ?? match[3] ?? match[4]).replace(/&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/g, entity => md.utils.unescapeAll(entity));
  }
  return result;
}

function ordinalOwner(state: StateInline, fields: Omit<LinkOccurrence, "id">): LinkOccurrence {
  const env = state.env as { butterLinkOccurrenceOrdinal?: number };
  return { ...fields, id: `l${env.butterLinkOccurrenceOrdinal = (env.butterLinkOccurrenceOrdinal ?? 0) + 1}` };
}

/** Native HTML anchors/images are cache-inert source classes. They keep
 * ordinary editable label content without becoming Markdown backlinks. */
function htmlNavigationPlugin(md: MarkdownIt): void {
  const stacks = new WeakMap<StateInline, LinkOccurrence[]>();
  md.inline.ruler.before("html_inline_marks", "native_html_navigation", (state, silent) => {
    const source = state.src.slice(state.pos, state.posMax);
    // A closed anchor without a target ends native DOM navigation without
    // ending the complete Markdown/HTML source label. The writer uses it only
    // immediately before a nested native anchor, after closing local styles.
    if (source.startsWith("<a></a>") && (state as StateInline & { readonly linkLevel: number }).linkLevel > 0) {
      state.pos += 7;
      if (!silent) {
        const boundary = state.push("html_inline_boundary", "", 0);
        boundary.markup = "<a></a>";
        boundary.meta = { nativeAnchorBreak: true };
      }
      return true;
    }
    // A targetless carrier around one genuine footnote preserves the native
    // number's original DOM scope after the outer anchor's style seam. It
    // owns neither a cached target nor a second editable source occurrence.
    if (source.startsWith("<a>") && /^(?:\[\^|\^\[)/.test(source.slice(3)) &&
      (state as StateInline & { readonly linkLevel: number }).linkLevel > 0) {
      let preceding = state.tokens.length - 1;
      while (preceding >= 0 && (/^(?:strong|em|s|highlight|html_.*|obsidian_comment)_(?:open|close)$/.test(state.tokens[preceding].type) ||
        ["text", "text_special"].includes(state.tokens[preceding].type) && !state.tokens[preceding].content)) preceding--;
      const before = state.tokens[preceding];
      const end = source.indexOf("</a>", 3);
      if (!state.pending && before?.type === "html_inline_boundary" &&
        (before.meta as { nativeAnchorBreak?: boolean } | null)?.nativeAnchorBreak && end > 3) {
        const tokens: typeof state.tokens = [];
        // Reuse the actual bounded inline grammar. A carrier owns exactly one
        // token, never a prefix of authored anchor content or a guessed label.
        md.inline.parse(source.slice(3, end), md, { ...state.env }, tokens);
        const footnote = tokens.length === 1 ? tokens[0] : undefined;
        const definitions = (state.env as { butterNativeCarrierFootnotes?: ReadonlySet<string> }).butterNativeCarrierFootnotes;
        if (footnote?.type === "inline_footnote" || footnote?.type === "footnote_ref" && definitions?.has(footnote.content)) {
          const start = state.pos;
          state.pos += end + 4;
          if (!silent) {
            const open = state.push("html_inline_boundary", "", 0);
            open.markup = "<a>"; open.meta = { nativeFootnoteCarrier: "open" };
            footnote.meta = { ...(footnote.meta as object | null),
              ...(footnote.type === "footnote_ref" ? { rawFootnoteStart: start + 3 } : { rawInlineFootnoteStart: start + 3 }) };
            state.tokens.push(footnote);
            const close = state.push("html_inline_boundary", "", 0);
            close.markup = "</a>"; close.meta = { nativeFootnoteCarrier: "close" };
          }
          return true;
        }
      }
    }
    const close = /^<\/a\s*>/i.exec(source);
    const stack = stacks.get(state) ?? [];
    if (close && stack.length) {
      state.pos += close[0].length;
      if (!silent) {
        state.push("link_close", "a", -1);
        state.push("link_occurrence_close", "", 0);
        stack.pop();
        (state as StateInline & { linkLevel: number }).linkLevel--;
      }
      return true;
    }
    const open = /^<(a|img)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(source);
    // Raw targetless anchors affect native DOM navigation and footnote
    // presentation even when they own no cached href. Outside the qualified
    // codec, preserve the complete note as protected source rather than
    // interpreting hidden markup as visible text or guessing its scope.
    if (close || open?.[1].toLowerCase() === "a" && htmlAttributes(md, open[2]).href === undefined) {
      const markup = close?.[0] ?? open![0];
      state.pos += markup.length;
      if (!silent) {
        const boundary = state.push("html_inline_boundary", "", 0);
        boundary.markup = markup; boundary.meta = { nativeUnsupportedAnchor: true };
      }
      return true;
    }
    if (!open) return false;
    const kind = open[1].toLowerCase(), attrs = htmlAttributes(md, open[2]);
    if (!hasOnlyQualifiedHtmlAttributes(open[2], kind === "a" ? ["href", "title"] : ["src", "alt", "title", "width", "height"]) ||
      kind === "a" && readHtmlElement(state.src, state.pos, state.posMax)?.selfClosing ||
      kind === "img" && [attrs.width, attrs.height].some(value => value !== undefined &&
        (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))))) return protectHtmlSource(state, silent, open[0]);
    const href = attrs[kind === "a" ? "href" : "src"];
    if (href !== undefined && /[\r\n\0]/.test(href)) return protectHtmlSource(state, silent, open[0]);
    if (href === undefined || !md.validateLink(href)) return false;
    if (kind === "a" && !/<\/a\s*>/i.test(source.slice(open[0].length))) return false;
    state.pos += open[0].length;
    if (silent) return true;
    if (kind === "img") {
      const image = state.push("image", "img", 0);
      image.attrs = Object.entries(attrs);
      image.content = attrs.alt ?? "";
      image.meta = { linkOccurrence: { syntax: "html", reference: null } };
      return true;
    }
    const owner = ordinalOwner(state, { syntax: "html", href, title: attrs.title ?? null, reference: null });
    state.push("link_occurrence_open", "", 0).meta = owner;
    const link = state.push("link_open", "a", 1);
    link.attrs = [["href", href], ...(attrs.title ? [["title", attrs.title] as [string, string]] : [])];
    link.meta = { linkOccurrence: owner };
    stack.push(owner);
    stacks.set(state, stack);
    (state as StateInline & { linkLevel: number }).linkLevel++;
    return true;
  });
}

export function linkOccurrencePlugin(md: MarkdownIt): void {
  grammar = md;
  htmlNavigationPlugin(md);
  // Definition presence affects whether a native footnote is an anchor. Bind
  // the carrier grammar to the real block inventory before inline parsing.
  md.core.ruler.before("inline", "native_footnote_carrier_context", state => {
    (state.env as { butterNativeCarrierFootnotes?: ReadonlySet<string> }).butterNativeCarrierFootnotes =
      new Set(state.tokens.filter(token => token.type === "footnote_def").map(token => String((token.meta as { label?: string } | null)?.label)));
  });
  // The native block grammar leaves a task marker in its first inline token.
  // Restore that structural prefix before link/tag ownership resolution; it
  // must not become a missing shortcut reference. Ordinary `[x]` prose stays
  // in the inline grammar, including a later paragraph of the same item.
  md.core.ruler.before("obsidian_tag_boundaries", "native_task_link_boundary", state => {
    state.tokens.forEach((token, index) => {
      if (token.type !== "inline" || state.tokens[index - 1]?.type !== "paragraph_open" || state.tokens[index - 2]?.type !== "list_item_open") return;
      const task = /^\[([ xX])\](?:[ \t]|$)/.exec(token.content), children = token.children;
      if (!task || !children || children[0]?.type !== "link_occurrence_open") return;
      const owner = children[0].meta as LinkOccurrence;
      if (owner.syntax !== "reference" || owner.referenceForm !== "shortcut" || owner.labelSource !== task[1]) return;
      const end = children.findIndex(child => child.type === "link_occurrence_close");
      if (end < 0) return;
      const prefix = new state.Token("text", "", 0); prefix.content = task[0].slice(0, 3);
      children.splice(0, end + 1, prefix);
    });
  });
  for (const [name, rule] of [["link", linkRule], ["image", imageRule]] as const) {
    md.inline.ruler.at(name, (state, silent) => {
      if (name === "link" && !silent && (state as StateInline & { readonly linkLevel: number }).linkLevel > 0) return false;
      const start = state.pos, first = state.tokens.length;
      const offset = name === "image" ? 1 : 0;
      if (state.src[start + offset] !== "[") return false;
      // This pure helper receives StateInline explicitly. Preserve its exact
      // identity for the synchronous paired override/restoration below.
      const helpers: {
        parseLinkLabel: (this: void, ...args: Parameters<MarkdownIt["helpers"]["parseLinkLabel"]>) =>
          ReturnType<MarkdownIt["helpers"]["parseLinkLabel"]>;
      } = md.helpers;
      const original = helpers.parseLinkLabel;
      md.helpers.parseLinkLabel = (inner, pos) => original(inner, pos, false);
      let accepted: boolean, end = -1;
      const env = state.env as { references?: Record<string, { href: string; title: string }>; butterLinkOccurrenceOrdinal?: number };
      const references = env.references;
      let unresolved = false;
      try {
        end = original(state, start + offset, false);
        if (end >= 0 && state.src[end + 1] !== "(") {
          const suffixEnd = state.src[end + 1] === "[" ? original(state, end + 1, false) : -1;
          {
            const raw = suffixEnd >= 0 ? state.src.slice(end + 2, suffixEnd) || state.src.slice(start + offset + 1, end) : state.src.slice(start + offset + 1, end);
            const key = md.utils.normalizeReference(raw);
            const full = suffixEnd >= 0 && state.src.slice(end + 2, suffixEnd).length > 0;
            const eligible = raw.length > 0 && (name !== "image" || full || !/[[\]]/.test(raw.replace(/\\[\s\S]/g, "")));
            if (eligible && !references?.[key]) { env.references = { ...references, [key]: { href: "", title: "" } }; unresolved = true; }
          }
        }
        accepted = rule(state, silent);
      } finally { md.helpers.parseLinkLabel = original; env.references = references; }
      if (!accepted || silent || end < 0) return accepted;
      const tokens = state.tokens.slice(first);
      const token = tokens.find(item => item.type === (name === "image" ? "image" : "link_open"));
      if (!token) return true;
      const suffix = state.src.slice(end + 1, state.pos);
      const inline = suffix.startsWith("(") && suffix.endsWith(")");
      const key = inline ? null : suffix.startsWith("[") && suffix.length > 2 ? suffix.slice(1, -1) : state.src.slice(start + offset + 1, end);
      const nonemptyLink = name === "link" && end > start + 1;
      const owner: LinkOccurrence = { id: nonemptyLink ? `l${env.butterLinkOccurrenceOrdinal = (env.butterLinkOccurrenceOrdinal ?? 0) + 1}` : "empty",
        syntax: inline ? "inline" : "reference", href: inline ? token.attrGet(name === "image" ? "src" : "href") ?? "" : "",
        title: inline ? token.attrGet("title") : null, reference: key,
        referenceForm: inline ? null : suffix === "[]" ? "collapsed" : suffix.startsWith("[") ? "full" : "shortcut",
        resolved: !unresolved, labelSource: inline ? null : state.src.slice(start + offset + 1, end), labelSignature: inline ? null : "", labelOuterMarks: inline ? null : [] };
      token.meta = { ...(token.meta as object | null), linkOccurrence: owner };
      if (nonemptyLink) {
        const open = new state.Token("link_occurrence_open", "", 0); open.meta = owner;
        const close = new state.Token("link_occurrence_close", "", 0); close.meta = owner;
        state.tokens.splice(state.tokens.indexOf(token), 0, open);
        state.tokens.push(close);
        if (unresolved) {
          const startIndex = state.tokens.indexOf(token);
          state.tokens.splice(startIndex, 1);
          const closeIndex = state.tokens.lastIndexOf(tokens[tokens.length - 1]);
          if (state.tokens[closeIndex]?.type === "link_close") state.tokens.splice(closeIndex, 1);
        }
      }
      return true;
    });
  }
}
