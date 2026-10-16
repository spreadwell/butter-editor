import { Fragment, Slice, type Node as PMNode, type Schema } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { allowsInlineMark } from "../core/inline-mark-policy";
import { canEncodeButterFileUtf8 } from "../core/file-shell";
import { nodeSemanticFingerprint } from "../core/doc-fingerprint";
import { hasValidCommentNavigationProvenance } from "../core/comment-navigation";
import { hasValidCommentMarkdownNavigation } from "../core/comment-markdown-navigation";
import { freshenLinkOccurrenceSlice, hasValidLinkOccurrences, isLinkOccurrence, linkOccurrence } from "../core/link-occurrence";
import { sanitizeHref } from "../util/safe-url";
import { prepareNativeBlockIdConservation } from "./native-block-id-conservation";

export const INTERNAL_SLICE_ATTRIBUTE = "data-butter-exact-slice";
const MAX_CAPSULE_LENGTH = 8 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_NODES = 100_000;
const transient = new Set(["sourceRange", "blockId"]);
const key = new PluginKey("butter-exact-internal-clipboard");
type JSONRecord = Record<string, unknown>;
type Capsule = { readonly version: 1; readonly content: unknown; readonly openStart: number; readonly openEnd: number };
type Pending = { readonly kind: "invalid" } | { readonly kind: "slice"; readonly slice: Slice };
interface PasteTicket { readonly before: PMNode; readonly selected: Slice; readonly incoming: Slice; }

function record(value: unknown): value is JSONRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactJSONValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !value.includes("\0") && canEncodeButterFileUtf8(value);
  if (Array.isArray(value)) return value.length <= MAX_NODES && value.every(item => exactJSONValue(item, depth + 1));
  return record(value) && Object.keys(value).every(name => name !== "__proto__" && name !== "constructor" &&
    name !== "prototype" && exactJSONValue(value[name], depth + 1));
}

function cleanAttrs(value: unknown, declared: Readonly<Record<string, unknown>> | undefined): JSONRecord | null {
  if (value === undefined) return {};
  if (!record(value)) return null;
  const attrs: JSONRecord = {};
  for (const name of Object.keys(value)) {
    if (transient.has(name)) continue;
    if (!declared || !Object.prototype.hasOwnProperty.call(declared, name) || !exactJSONValue(value[name])) return null;
    attrs[name] = value[name];
  }
  return attrs;
}

function safeTransportHref(value: unknown): value is string {
  return typeof value === "string" && (value === "" || sanitizeHref(value) === value.trim());
}

/** Private JSON is a transport, never a schema/provenance authority. */
function cleanNodeJSON(value: unknown, schema: Schema, depth: number, budget: { nodes: number }): JSONRecord | null {
  if (!record(value) || ++budget.nodes > MAX_NODES || depth > MAX_DEPTH || typeof value.type !== "string") return null;
  const type = schema.nodes[value.type];
  if (!type || type === schema.topNodeType || Object.keys(value).some(name => !["type", "attrs", "text", "marks", "content"].includes(name))) return null;
  const attrs = cleanAttrs(value.attrs, type.spec.attrs);
  if (!attrs) return null;
  const result: JSONRecord = { type: value.type, attrs };
  if (type.isText) {
    if (typeof value.text !== "string" || !value.text || !exactJSONValue(value.text) || value.content !== undefined) return null;
    result.text = value.text;
  } else if (value.text !== undefined) return null;
  if (value.marks !== undefined) {
    if (!Array.isArray(value.marks) || value.marks.length > Object.keys(schema.marks).length) return null;
    const marks: JSONRecord[] = [], names = new Set<string>();
    for (const mark of value.marks) {
      if (!record(mark) || typeof mark.type !== "string" || names.has(mark.type) ||
        Object.keys(mark).some(name => name !== "type" && name !== "attrs")) return null;
      const markType = schema.marks[mark.type];
      if (!markType) return null;
      const markAttrs = cleanAttrs(mark.attrs, markType.spec.attrs);
      if (!markAttrs || mark.type === "link" && !safeTransportHref(markAttrs.href) || mark.type === "link_occurrence" &&
        (!isLinkOccurrence(markAttrs) || markAttrs.syntax !== "reference" &&
          !safeTransportHref(markAttrs.href))) return null;
      names.add(mark.type); marks.push({ type: mark.type, attrs: markAttrs });
    }
    result.marks = marks;
  }
  if (value.content !== undefined) {
    if (!Array.isArray(value.content) || type.isLeaf) return null;
    const children: JSONRecord[] = [];
    for (const child of value.content) {
      const clean = cleanNodeJSON(child, schema, depth + 1, budget);
      if (!clean) return null;
      children.push(clean);
    }
    result.content = children;
  }
  return result;
}

function validSlice(slice: Slice): boolean {
  let valid = true;
  const walk = (fragment: Fragment, left: number, right: number): void => {
    fragment.forEach((node, _offset, index) => {
      const openLeft = index === 0 ? left : 0, openRight = index === fragment.childCount - 1 ? right : 0;
      if ((!openLeft && !openRight && !node.type.validContent(node.content)) ||
        node.isInline && node.marks.some(mark => !allowsInlineMark(node, mark))) valid = false;
      // Node.check also verifies mark-set ordering/exclusion. Open edge blocks
      // alone may have incomplete content, so their children are checked here.
      if (!openLeft && !openRight) { try { node.check(); } catch { valid = false; } }
      if (openLeft && node.isLeaf || openRight && node.isLeaf) valid = false;
      walk(node.content, Math.max(0, openLeft - 1), Math.max(0, openRight - 1));
    });
  };
  walk(slice.content, slice.openStart, slice.openEnd);
  slice.content.forEach(node => { if (!hasValidLinkOccurrences(node)) valid = false; });
  const doc = { descendants: slice.content.descendants.bind(slice.content) } as Pick<PMNode, "descendants">;
  return valid && hasValidCommentNavigationProvenance(doc as PMNode) && hasValidCommentMarkdownNavigation(doc as PMNode);
}

export function decodeInternalClipboardSlice(encoded: string, schema: Schema): Slice | null {
  if (encoded.length > MAX_CAPSULE_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!record(value) || Object.keys(value).some(name => !["version", "content", "openStart", "openEnd"].includes(name)) ||
      value.version !== 1 || !Array.isArray(value.content) || !Number.isInteger(value.openStart) || !Number.isInteger(value.openEnd)) return null;
    const openStart = value.openStart as number, openEnd = value.openEnd as number;
    if (openStart < 0 || openEnd < 0 || openStart > MAX_DEPTH || openEnd > MAX_DEPTH) return null;
    const nodes: JSONRecord[] = [], budget = { nodes: 0 };
    for (const node of value.content) {
      const clean = cleanNodeJSON(node, schema, 0, budget);
      if (!clean) return null;
      nodes.push(clean);
    }
    const slice = Slice.fromJSON(schema, { content: nodes, openStart, openEnd });
    return validSlice(slice) ? slice : null;
  } catch { return null; }
}

/** Retain every source-serializable field; discard session identities/ranges. */
export function encodeInternalClipboardSlice(slice: Slice, schema: Schema): string | null {
  const encoded = JSON.stringify({ version: 1, content: slice.content.toJSON() ?? [],
    openStart: slice.openStart, openEnd: slice.openEnd } satisfies Capsule);
  const clean = decodeInternalClipboardSlice(encoded, schema);
  return clean ? JSON.stringify({ version: 1, content: clean.content.toJSON() ?? [],
    openStart: clean.openStart, openEnd: clean.openEnd } satisfies Capsule) : null;
}

export interface InternalClipboardFormats {
  readonly html: string;
  readonly text: string;
  readonly slice: Slice;
}

/** Public PM serialization owns transforms, ordinary HTML and plain text. */
export function serializeInternalClipboard(view: EditorView, selected: Slice): InternalClipboardFormats | null {
  if (view.isDestroyed) return null;
  try {
    const { dom, text, slice } = view.serializeForClipboard(selected);
    const encoded = encodeInternalClipboardSlice(slice, view.state.schema);
    if (!encoded) return null;
    dom.setAttribute(INTERNAL_SLICE_ATTRIBUTE, encoded);
    return { html: dom.outerHTML, text, slice };
  } catch { return null; }
}

/** Async menu Copy/Cut writes both interoperable formats atomically. Callers
 * must revalidate their captured selection/occurrences before any Cut delete. */
export async function writeInternalClipboardSlice(view: EditorView, selected: Slice): Promise<boolean> {
  const formats = serializeInternalClipboard(view, selected);
  const window = view.dom.ownerDocument.defaultView;
  if (!formats || !window?.navigator.clipboard?.write || !window.ClipboardItem) return false;
  try {
    await window.navigator.clipboard.write([new window.ClipboardItem({
      "text/html": new window.Blob([formats.html], { type: "text/html" }),
      "text/plain": new window.Blob([formats.text], { type: "text/plain" }),
    })]);
    return true;
  } catch { return false; }
}

interface Payload { readonly key: string; readonly text?: string; }
function sourcePayloadNode(node: PMNode): PMNode {
  const reference = linkOccurrence(node)?.attrs.syntax === "reference";
  const marks = reference ? node.marks.filter(mark => mark.type.name !== "link").map(mark =>
    mark.type.name === "link_occurrence" ? mark.type.create({ ...mark.attrs, resolved: false }) : mark) : node.marks;
  // A receiving document supplies reference definitions. The native source
  // key/form/label and all user marks remain intended clipboard content;
  // current href/title/resolution are a derived projection certified by the
  // complete save policy, rather than copied destination authority.
  if (node.type.name === "image" && node.attrs.sourceSyntax === "reference") {
    return node.type.create({ ...node.attrs, src: "", title: null, resolved: false }, node.content, marks);
  }
  return reference ? node.mark(marks) : node;
}
function payloads(fragment: Fragment, openStart = 0, openEnd = 0): Payload[] {
  const result: Payload[] = [];
  const walk = (content: Fragment, left: number, right: number, codeLanguage?: string): void => {
    let run = "", marks = "";
    const flush = (): void => { if (run) result.push({ key: "text:" + marks, text: run }); run = ""; };
    content.forEach((node, _offset, index) => {
      if (node.isText) {
        const signature = codeLanguage !== undefined ? "block-code:" + codeLanguage : JSON.stringify(sourcePayloadNode(node).marks.map(mark => mark.toJSON() as unknown));
        if (marks !== signature) flush();
        marks = signature; run += node.text ?? ""; return;
      }
      flush();
      if (node.isLeaf) result.push({ key: "atom:" + nodeSemanticFingerprint(sourcePayloadNode(node)) });
      else {
        const openLeft = index === 0 ? left : 0, openRight = index === content.childCount - 1 ? right : 0;
        // A complete selected callout owns its title/fold/type. An open body
        // slice merely uses the callout as insertion context, not content.
        if (!openLeft && !openRight && node.type.name === "obsidian_callout") {
          result.push({ key: "owner:" + nodeSemanticFingerprint(node.copy(Fragment.empty)) });
        }
        walk(node.content, Math.max(0, openLeft - 1), Math.max(0, openRight - 1),
          node.type.name === "code_block" ? String(node.attrs.language) : undefined);
      }
    });
    flush();
  };
  walk(fragment, openStart, openEnd);
  return result;
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  for (let start = 0; (start = value.indexOf(needle, start)) >= 0; start += needle.length) count++;
  return count;
}

/** Independent of the save oracle: PM fitting must not erase copied text,
 * mark intervals or atoms before a valid but incomplete doc is certified.
 * Table filling may repeat incoming content; it must retain every occurrence. */
export function conservesInternalClipboardPayload(before: PMNode, selected: Slice, incoming: Slice, after: PMNode): boolean {
  const original = payloads(before.content), removed = payloads(selected.content, selected.openStart, selected.openEnd),
    inserted = payloads(incoming.content, incoming.openStart, incoming.openEnd), current = payloads(after.content);
  for (const payload of inserted) {
    const count = (values: Payload[]): number => values.reduce((sum, value) => sum + (value.key !== payload.key ? 0 :
      payload.text === undefined ? 1 : value.text === undefined ? 0 : occurrences(value.text, payload.text)), 0);
    if (count(current) < count(original) - count(removed) + count(inserted)) return false;
  }
  return true;
}

/** Standard HTML/plain text remain interoperable. Only our recognized capsule
 * replaces HTML's lossy whitespace parse, before later paste transforms run.
 * Table/external handlePaste owners keep their dispatch semantics; the filter
 * certifies their actual transaction against the owning view's current policy. */
export function internalClipboardPlugin(validate: (preparedDoc: PMNode) => boolean, onRejected?: () => void): Plugin {
  const pending = new WeakMap<EditorView, Pending>();
  const tickets = new WeakMap<PMNode, PasteTicket>();
  const reject = (): true => { onRejected?.(); return true; };
  const certified = (tr: Transaction, state: EditorState, ticket: PasteTicket): boolean => {
    try {
      tr.doc.check();
      const plan = prepareNativeBlockIdConservation(state.doc, tr.doc, tr.mapping);
      return Boolean(plan && conservesInternalClipboardPayload(ticket.before, ticket.selected, ticket.incoming, plan.doc) && validate(plan.doc));
    } catch { return false; }
  };
  const copy = (view: EditorView, event: ClipboardEvent, cut: boolean): boolean => {
    if (view.state.selection.empty) return false;
    if (cut && !view.editable) { event.preventDefault(); return true; }
    if (!event.clipboardData) return false;
    event.preventDefault();
    try {
      const formats = serializeInternalClipboard(view, view.state.selection.content());
      if (!formats) return reject();
      event.clipboardData.clearData();
      event.clipboardData.setData("text/html", formats.html);
      event.clipboardData.setData("text/plain", formats.text);
      if (event.clipboardData.getData("text/html") !== formats.html || event.clipboardData.getData("text/plain") !== formats.text) return reject();
      if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
      return true;
    } catch { return reject(); }
  };
  return new Plugin({
    key,
    filterTransaction(tr, state) {
      if (!tr.docChanged) return true;
      const ticket = tickets.get(state.doc);
      if (!ticket) return true;
      tickets.delete(state.doc);
      if (certified(tr, state, ticket)) return true;
      onRejected?.(); return false;
    },
    props: {
      handleDOMEvents: { copy: (view, event) => copy(view, event, false), cut: (view, event) => copy(view, event, true) },
      transformPastedHTML(html, view) {
        pending.delete(view);
        try {
          const dom = new DOMParser().parseFromString(html, "text/html");
          const elements = dom.querySelectorAll(`[${INTERNAL_SLICE_ATTRIBUTE}]`);
          if (!elements.length) return html;
          const encoded = elements.length === 1 ? elements[0].getAttribute(INTERNAL_SLICE_ATTRIBUTE) : null;
          const slice = encoded === null ? null : decodeInternalClipboardSlice(encoded, view.state.schema);
          pending.set(view, slice ? { kind: "slice", slice } : { kind: "invalid" });
          queueMicrotask(() => pending.delete(view));
          return slice ? html : "<p></p>";
        } catch {
          // A recognized carrier that fails inert parsing must never degrade
          // into a different ordinary HTML import.
          if (html.includes(INTERNAL_SLICE_ATTRIBUTE)) {
            pending.set(view, { kind: "invalid" });
            queueMicrotask(() => pending.delete(view));
            return "<p></p>";
          }
          return html;
        }
      },
      transformPasted(slice, view, plain) {
        if (plain) { pending.delete(view); return slice; }
        const value = pending.get(view);
        // A copied label keeps its complete occurrence interval, but import
        // receives a fresh owner so fitting cannot merge it into a neighbor.
        return freshenLinkOccurrenceSlice(view.state.doc, value?.kind === "slice" ? value.slice : slice);
      },
      handlePaste(view, _event, slice) {
        const value = pending.get(view);
        pending.delete(view);
        if (!value) return false;
        if (value.kind === "invalid" || !view.editable || !validSlice(slice)) return reject();
        const ticket: PasteTicket = { before: view.state.doc, selected: view.state.selection.content(), incoming: slice };
        // Stock replacement is checked early, but a table owner may fit a
        // different transaction. Its actual dispatch is checked by the filter.
        const $from = view.state.selection.$from;
        let inTable = false;
        for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.spec.tableRole) inTable = true;
        try {
          if (!inTable && !certified(view.state.tr.replaceSelection(slice), view.state, ticket)) return reject();
        } catch { return reject(); }
        tickets.set(view.state.doc, ticket);
        queueMicrotask(() => tickets.delete(ticket.before));
        return false;
      },
    },
  });
}
