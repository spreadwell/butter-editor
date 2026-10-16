import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { isCommentNavigationSource } from "../core/comment-navigation";
import { isCommentMarkdownNavigation, commentMarkdownNavigationFromSource } from "../core/comment-markdown-navigation";
import { parser } from "../core/parser";
import { serialize } from "../core/bridge/serializer";
import { freshenLinkOccurrenceSlice, linkOccurrence } from "../core/link-occurrence";
import { Slice } from "prosemirror-model";
import { allowsInlineMark } from "../core/inline-mark-policy";

const key = new PluginKey("butter-comment-navigation-provenance");
const pendingCleanup = new WeakMap<Transaction, readonly number[]>();
const pendingExpansion = new WeakMap<Transaction, readonly { pos: number; content: Fragment; hiddenImage?: boolean }[]>();
const preparedRelease = new WeakMap<Transaction, PMNode>();
/** A peer admission filter may certify this already prepared release rather
 * than transient source attrs that the same history event will retire. */
export function preparedCommentNavigationDoc(tr: Transaction): PMNode | undefined { return preparedRelease.get(tr); }
function sourceNode(node: PMNode): boolean {
  return (node.type.name === "wikilink" || node.type.name === "obsidian_embed_inline") && node.attrs.literalSource !== null;
}

/** Inspect only final changed ranges. Mark/attribute steps have empty position
 * maps, so their declared ranges/position also participate. Unknown extension
 * steps conservatively inspect the document; ordinary typing never does. */
function changedRanges(tr: Transaction): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < tr.steps.length; index++) {
    const step = tr.steps[index], later = tr.mapping.slice(index + 1);
    let mapped = false;
    const add = (from: number, to: number): void => {
      const start = Math.max(0, Math.min(tr.doc.content.size, later.map(from, -1)));
      ranges.push({ from: start, to: Math.max(start, Math.min(tr.doc.content.size, later.map(to, 1))) });
    };
    step.getMap().forEach((_oldFrom, _oldTo, from, to) => { mapped = true; add(from, to); });
    if (mapped) continue;
    const range = step as unknown as { from?: number; to?: number; pos?: number };
    if (typeof range.from === "number" && typeof range.to === "number") add(range.from, range.to);
    else if (typeof range.pos === "number") add(range.pos, range.pos + 1);
    else add(0, tr.doc.content.size);
  }
  return ranges;
}

/** Atom fields deliberately rebuild normal navigation attrs. Removing the
 * comment mark ends opaque-source ownership and clears its exact spelling in
 * the same history event. Inconsistent manufactured provenance is refused. */
export function commentNavigationProvenancePlugin(onRejected?: () => void, validate?: (doc: PMNode) => boolean): Plugin {
  return new Plugin({
    key,
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(key)) return true;
      let valid = true;
      const cleanup = new Set<number>();
      const expansions = new Map<number, Fragment>();
      const hiddenImages = new Set<number>();
      const inspect = (node: PMNode, pos: number): void => {
        if (node.type.name === "image" && node.attrs.sourceSyntax !== "html" && node.marks.some(mark => mark.type.name === "comment")) {
          const old = state.doc.nodeAt(tr.mapping.invert().map(pos, 1));
          if (!old || old.type !== node.type || JSON.stringify(old.attrs) !== JSON.stringify(node.attrs) ||
            old.marks.some(mark => mark.type.name === "comment")) return;
          const source = node.attrs.sourceSyntax === "reference"
            ? `![${String(node.attrs.sourceAlt)}][${String(node.attrs.reference)}]`
            : serialize(node.type.schema.nodes.doc.create(null, node.type.schema.nodes.paragraph.create(null, node.mark([])))).replace(/\n$/, "");
          const attrs = commentMarkdownNavigationFromSource(source, "span");
          if (!attrs || attrs.kind !== "image") { valid = false; return; }
          const type = node.type.schema.nodes.comment_navigation;
          const unmarked = type.create(attrs);
          const hidden = unmarked.mark(node.marks.filter(mark => allowsInlineMark(unmarked, mark)));
          expansions.set(pos, Fragment.from(hidden)); hiddenImages.add(pos);
          return;
        }
        if (node.type.name === "comment_navigation") {
          if (!isCommentMarkdownNavigation(node.attrs)) { valid = false; return; }
          if (node.marks.some(mark => mark.type.name === "comment")) return;
          const old = state.doc.nodeAt(tr.mapping.invert().map(pos, 1));
          if (!old || old.type !== node.type || JSON.stringify(old.attrs) !== JSON.stringify(node.attrs) ||
            !old.marks.some(mark => mark.type.name === "comment")) { valid = false; return; }
          // Resolve against the current document's genuine definitions. A
          // standalone source parse would change reference ownership or hide
          // a footnote that the explicit release should expose.
          const definitions: PMNode[] = [];
          tr.doc.descendants(candidate => { if (["reference_definition", "footnote_def"].includes(candidate.type.name)) { definitions.push(candidate); return false; } });
          const context = definitions.length ? `\n\n${serialize(tr.doc.type.create(null, Fragment.fromArray(definitions)))}` : "";
          const parsed = parser.parse((node.attrs.source as string) + context);
          if (!parsed || parsed.firstChild?.type.name !== "paragraph" || Array.from({ length: parsed.childCount - 1 }, (_, index) => parsed.child(index + 1)).some(candidate =>
            !["reference_definition", "footnote_def"].includes(candidate.type.name))) { valid = false; return; }
          const children: PMNode[] = [];
          let represented = false;
          parsed.firstChild.forEach(child => {
            if (node.attrs.kind === "image" ? child.type.name === "image" : child.type.name === "empty_link" ||
              child.marks.some(mark => mark.type.name === "link") || Boolean(linkOccurrence(child))) represented = true;
            let marks = child.marks;
            for (const mark of node.marks) if (allowsInlineMark(child, mark)) marks = mark.addToSet(marks);
            children.push(child.mark(marks));
          });
          if (!represented) { valid = false; return; }
          expansions.set(pos, freshenLinkOccurrenceSlice(tr.doc, new Slice(Fragment.fromArray(children), 0, 0)).content);
          return;
        }
        if (!sourceNode(node)) return;
        const kind = node.type.name as "wikilink" | "obsidian_embed_inline";
        if (!isCommentNavigationSource(kind, node.attrs, node.attrs.literalSource)) { valid = false; return; }
        if (node.marks.some(mark => mark.type.name === "comment")) return;
        // A real mark-removal edit may leave the old opaque attrs on the
        // surviving node until appendTransaction performs deliberate cleanup.
        const oldPos = tr.mapping.invert().map(pos, 1), old = state.doc.nodeAt(oldPos);
        if (!old || old.type !== node.type || old.attrs.literalSource !== node.attrs.literalSource ||
          !old.marks.some(mark => mark.type.name === "comment")) valid = false;
        else cleanup.add(pos);
      };
      for (const { from, to } of changedRanges(tr)) {
        if (from < to) tr.doc.nodesBetween(from, to, inspect);
        else {
          const node = tr.doc.nodeAt(from);
          if (node) inspect(node, from);
        }
      }
      if (valid && (cleanup.size || expansions.size)) {
        const prepared = new Transform(tr.doc);
        for (const pos of [...new Set([...cleanup, ...expansions.keys()])].sort((a, b) => b - a)) {
          const node = prepared.doc.nodeAt(pos);
          if (!node) { valid = false; break; }
          const content = expansions.get(pos);
          if (content) prepared.replaceWith(pos, pos + node.nodeSize, content);
          else prepared.setNodeMarkup(pos, undefined, { ...node.attrs, literalSource: null }, node.marks);
        }
        if (valid && validate && !validate(prepared.doc)) valid = false;
        if (valid) preparedRelease.set(tr, prepared.doc);
      }
      if (valid && cleanup.size) pendingCleanup.set(tr, [...cleanup]);
      if (valid && expansions.size) pendingExpansion.set(tr, [...expansions].map(([pos, content]) => ({ pos, content, hiddenImage: hiddenImages.has(pos) })));
      if (!valid) onRejected?.();
      return valid;
    },
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some(tr => tr.docChanged) || transactions.some(tr => tr.getMeta(key))) return null;
      const tr = newState.tr;
      const expansion = new Map<number, Fragment>();
      const hiddenImages = new Set<number>();
      const cleanup: number[] = [];
      for (let index = 0; index < transactions.length; index++) for (const oldPos of pendingCleanup.get(transactions[index]) ?? []) {
        let pos = oldPos;
        for (let after = index + 1; after < transactions.length; after++) pos = transactions[after].mapping.map(pos, 1);
        cleanup.push(pos);
      }
      for (let index = 0; index < transactions.length; index++) for (const item of pendingExpansion.get(transactions[index]) ?? []) {
        let pos = item.pos;
        for (let after = index + 1; after < transactions.length; after++) pos = transactions[after].mapping.map(pos, 1);
        expansion.set(pos, item.content);
        if (item.hiddenImage) hiddenImages.add(pos);
      }
      for (const pos of [...new Set([...cleanup, ...expansion.keys()])].sort((a, b) => b - a)) {
        const node = tr.doc.nodeAt(pos), content = expansion.get(pos);
        if (content && hiddenImages.has(pos) && node?.type.name === "image" && node.marks.some(mark => mark.type.name === "comment")) {
          tr.replaceWith(pos, pos + node.nodeSize, content); continue;
        }
        if (!node || node.marks.some(mark => mark.type.name === "comment")) continue;
        if (content && node.type.name === "comment_navigation") tr.replaceWith(pos, pos + node.nodeSize, content);
        else if (sourceNode(node)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, literalSource: null }, node.marks);
      }
      return tr.docChanged ? tr.setMeta(key, true) : null;
    },
  });
}
