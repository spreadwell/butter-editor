/**
 * Paste & drop handling for Butter PM.
 *   - URL on empty selection  → inline [host](url) link
 *   - URL on selection        → wrap selection as link
 *   - Image on clipboard      → save to vault, insert ![[name]]
 *   - HTML on clipboard       → run through MD converter, then parse + insert
 *   - File drop from OS       → save to vault, insert ![[name]]
 */
import { App, TFile } from "obsidian";
import {
  Plugin as PMPlugin,
  NodeSelection,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type SelectionBookmark,
  type Transaction,
} from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { dropPoint } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import { Fragment, Slice, type Node as PMNode, type Schema } from "prosemirror-model";
import type { Parser } from "../core/parser-types";
import { htmlToMarkdown } from "./paste-html";
import { dropEmptyTextblocks, stripOrphanTagText } from "./paste-cleanup";
import { recordError } from "../integration/debug";

// True when the current selection is inside a table cell. Used to
// recognize "paste into existing table cell" so PM-tables' native
// paste handler (which fills cells from a clipboard table fragment)
// can take over instead of our generic HTML→markdown converter.
function inTableCell(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const role = ($from.node(d).type.spec as { tableRole?: string }).tableRole;
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
}

// ═══════════════════════════════════════════
//  URL + attachment helpers
// ═══════════════════════════════════════════

const URL_RE = /^https?:\/\/\S+$/i;
const isUrl = (s: string) => URL_RE.test(s.trim());

type PendingAttachmentTarget =
  | { kind: "selection"; bookmark: SelectionBookmark }
  | {
      kind: "position";
      pos: number;
      activation: SelectionBookmark;
      intervened: boolean;
    };

interface ResolvedAttachmentTarget {
  insertion: Selection | number;
  selectInserted: boolean;
}

interface PendingAttachmentMeta {
  add?: { id: string; target: PendingAttachmentTarget };
  remove?: string;
}

const pasteDropKey = new PluginKey<Map<string, PendingAttachmentTarget>>(
  "butter-paste-drop",
);
let pendingAttachmentSequence = 0;

function registerPendingAttachment(
  view: EditorView,
  target: PendingAttachmentTarget,
  category: "paste" | "drop",
): string | null {
  const id = `attachment-${++pendingAttachmentSequence}`;
  try {
    view.dispatch(
      view.state.tr
        .setMeta(
          pasteDropKey,
          { add: { id, target } } satisfies PendingAttachmentMeta,
        )
        .setMeta("addToHistory", false),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pasteDropKey.getState(view.state)?.has(id)) {
      recordError(
        category,
        `Attachment target registered, but its view update failed: ${message}`,
      );
      return id;
    }
    recordError(category, `Attachment target registration failed: ${message}`);
    return null;
  }
  return id;
}

function resolvePendingAttachment(
  view: EditorView,
  id: string,
): ResolvedAttachmentTarget | null {
  if (view.isDestroyed) return null;
  const target = pasteDropKey.getState(view.state)?.get(id);
  if (!target) return null;
  if (target.kind === "position") {
    let selectInserted = false;
    try {
      selectInserted =
        !target.intervened &&
        view.state.selection.eq(target.activation.resolve(view.state.doc));
    } catch {
      // An unresolvable activation selection means the user/editor state has
      // diverged. Preserve the live selection instead of moving it on finish.
    }
    return { insertion: target.pos, selectInserted };
  }
  try {
    return {
      insertion: target.bookmark.resolve(view.state.doc),
      selectInserted: false,
    };
  } catch {
    return null;
  }
}

function cancelPendingAttachment(
  view: EditorView,
  id: string,
  category: "paste" | "drop",
): void {
  if (view.isDestroyed || !pasteDropKey.getState(view.state)?.has(id)) return;
  try {
    view.dispatch(
      view.state.tr
        .setMeta(pasteDropKey, { remove: id } satisfies PendingAttachmentMeta)
        .setMeta("addToHistory", false),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordError(category, `Attachment target cleanup failed: ${message}`);
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function looksRich(html: string): boolean {
  return /<(p|h[1-6]|ul|ol|table|blockquote|pre|strong|em|a |img |code)\b/i.test(
    html,
  );
}

export function shouldDeferToProseMirrorClipboard(html: string): boolean {
  // ProseMirror only treats this as slice metadata when it is an actual
  // element attribute. Querying the inert parsed document avoids deferring
  // for prose, comments, or another attribute value that merely mentions the
  // string "data-pm-slice".
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.querySelector("[data-pm-slice]") !== null;
  } catch {
    return false;
  }
}

export async function saveBlobAsAttachment(
  app: App,
  blob: Blob,
  preferredName: string,
  sourcePath: string,
  preserveExactName = false,
): Promise<TFile | null> {
  const nameParts = preferredName.split(/[\\/]/);
  const cleanName = nameParts[nameParts.length - 1]?.trim() || "attachment";
  const ext = blob.type.split("/")[1]?.split("+")[0] || "bin";
  const filename = preserveExactName ? cleanName : `${cleanName}.${ext}`;
  // Obsidian owns attachment-folder semantics (`./`, vault root, named
  // folders), parent creation, and collision handling. Keeping that policy in
  // FileManager also makes popouts and source-relative paths agree with native
  // paste/drop behavior.
  const path = await app.fileManager.getAvailablePathForAttachment(
    filename,
    sourcePath,
  );
  const buf = await blob.arrayBuffer();
  return await app.vault.createBinary(path, buf);
}

export function attachmentEmbed(
  app: App,
  file: TFile,
  sourcePath: string,
): string {
  const link = app.fileManager.generateMarkdownLink(file, sourcePath);
  return link.startsWith("!") ? link : `!${link}`;
}

async function rollbackAttachments(
  app: App,
  files: readonly TFile[],
  category: "paste" | "drop",
): Promise<void> {
  for (const file of files) {
    try {
      // Only remove the exact file object this activation created. A path may
      // have been deleted and recreated while the async write was pending;
      // that replacement belongs to somebody else.
      if (app.vault.getAbstractFileByPath(file.path) !== file) {
        recordError(
          category,
          `Attachment rollback skipped because ${file.path} is no longer the created file`,
        );
        continue;
      }
      await app.fileManager.trashFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordError(
        category,
        `Attachment rollback failed for ${file.path}: ${message}`,
      );
    }
  }
}

// ═══════════════════════════════════════════
//  Insert helpers
// ═══════════════════════════════════════════

/** Insert plain text without trapping multi-line content into a single
 *  text node. PM's `tr.insertText("a\n\nb")` keeps the `\n\n` chars
 *  literally in one text node - the serializer then emits `\n\n` inline,
 *  which inside a blockquote/callout `> ` prefix becomes `> \n> \n`
 *  (a paragraph break). Reparse splits the single in-memory paragraph
 *  into N paragraphs and the round-trip guard rejects the save. Map
 *  the input to schema-aware blocks instead: split on blank lines for
 *  paragraph breaks; within each block, split on single newlines and
 *  insert softbreak nodes between segments. */
type InsertionTarget = Selection | number;

function dispatchInsertion(
  view: EditorView,
  target: InsertionTarget | undefined,
  pendingAttachmentId?: string,
  apply?: (transaction: Transaction) => Transaction,
  selectInserted = false,
): boolean {
  const preserveLiveState =
    target !== undefined &&
    typeof target !== "number" &&
    !view.state.selection.eq(target);
  const liveBookmark = preserveLiveState
      ? view.state.selection.getBookmark()
      : null;
  const liveStoredMarks = preserveLiveState ? view.state.storedMarks : null;
  let tr = view.state.tr;
  if (target !== undefined && typeof target !== "number") {
    tr.setSelection(target);
  }
  if (pendingAttachmentId) {
    tr = closeHistory(tr);
    tr.setMeta(
      pasteDropKey,
      { remove: pendingAttachmentId } satisfies PendingAttachmentMeta,
    );
  }
  if (apply) tr = apply(tr);
  if (!tr.docChanged) return false;
  if (liveBookmark) {
    try {
      tr.setSelection(liveBookmark.map(tr.mapping).resolve(tr.doc));
      tr.setStoredMarks(liveStoredMarks);
    } catch {
      // If another plugin made the old selection unresolvable, retain the
      // insertion transaction's valid selection rather than aborting content.
    }
  }
  try {
    view.dispatch(tr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // EditorView installs the new state before every DOM/plugin view update.
    // A later update can throw even though the insertion is already canonical.
    // Treat an exact committed transaction document as consumed so attachment
    // cleanup can never trash a file that the note now references.
    const pendingState = pasteDropKey.getState(view.state);
    const committed = pendingAttachmentId
      ? pendingState !== undefined && !pendingState.has(pendingAttachmentId)
      : view.state.doc.eq(tr.doc);
    if (!committed) {
      recordError("paste-drop", `Insertion dispatch failed: ${message}`);
      return false;
    }
    recordError(
      "paste-drop",
      `Insertion committed, but its view update failed: ${message}`,
    );
  }
  if (pendingAttachmentId && !view.isDestroyed) {
    try {
      // The insertion transaction's closeHistory meta separates it from edits
      // made while the file write was pending. This trailing barrier keeps the
      // next keystroke out of the attachment's Undo event.
      view.dispatch(closeHistory(view.state.tr).setMeta("addToHistory", false));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordError(
        "paste-drop",
        `Attachment history barrier failed after commit: ${message}`,
      );
    }
  }
  if (selectInserted && !view.isDestroyed && typeof view.focus === "function") {
    try {
      view.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordError("drop", `Dropped attachment focus failed: ${message}`);
    }
  }
  return true;
}

function replaceInsertionTarget(
  view: EditorView,
  transaction: Transaction,
  slice: Slice,
  target: InsertionTarget | undefined,
  selectInserted: boolean,
): Transaction {
  if (typeof target !== "number") return transaction.replaceSelection(slice);

  // Match ProseMirror's native drop geometry: first project the pointer hit to
  // a schema-valid drop point, then select the inserted node/range only when
  // no user transaction intervened during the async attachment write.
  const insertPos = dropPoint(transaction.doc, target, slice) ?? target;
  const pos = transaction.mapping.map(insertPos);
  const isNode =
    slice.openStart === 0 &&
    slice.openEnd === 0 &&
    slice.content.childCount === 1;
  const beforeInsert = transaction.doc;
  if (isNode) {
    transaction.replaceRangeWith(
      pos,
      pos,
      slice.content.firstChild as PMNode,
    );
  } else {
    transaction.replaceRange(pos, pos, slice);
  }
  if (!selectInserted || transaction.doc.eq(beforeInsert)) return transaction;

  const $pos = transaction.doc.resolve(pos);
  const insertedNode = slice.content.firstChild;
  if (
    isNode &&
    insertedNode &&
    NodeSelection.isSelectable(insertedNode) &&
    $pos.nodeAfter?.sameMarkup(insertedNode)
  ) {
    return transaction.setSelection(new NodeSelection($pos));
  }

  let end = transaction.mapping.map(insertPos);
  const maps = transaction.mapping.maps;
  maps[maps.length - 1]?.forEach(
    (_from, _to, _newFrom, newTo) => { end = newTo; },
  );
  const $end = transaction.doc.resolve(end);
  const custom = view.someProp(
    "createSelectionBetween",
    (factory) => factory(view, $pos, $end),
  );
  return transaction.setSelection(
    custom ?? TextSelection.between($pos, $end),
  );
}

function insertPlainTextAsBlocks(
  view: EditorView,
  schema: Schema,
  text: string,
  selection?: InsertionTarget,
  pendingAttachmentId?: string,
  selectInserted = false,
): boolean {
  const paragraphs = text.split(/\r?\n\r?\n+/);
  const paraType = schema.nodes.paragraph;
  const softbreak = schema.nodes.softbreak;
  if (!paraType) {
    return dispatchInsertion(
      view,
      selection,
      pendingAttachmentId,
      (transaction) => typeof selection === "number"
        ? transaction.insertText(text.replace(/\n/g, " "), selection, selection)
        : transaction.insertText(text.replace(/\n/g, " ")),
      selectInserted,
    );
  }
  const blocks: PMNode[] = [];
  for (const p of paragraphs) {
    if (!p) continue;
    const lines = p.split(/\r?\n/);
    // Trim trailing whitespace from the LAST line in each paragraph
    // and trailing whitespace from intermediate lines. Markdown-it
    // strips trailing whitespace from paragraph text on reparse,
    // so leaving it in the in-memory doc would cause a textContent
    // mismatch every time we save (the round-trip guard would
    // refuse the save).
    const inline: PMNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0 && softbreak) inline.push(softbreak.create());
      const isLastLine = i === lines.length - 1;
      const trimmed = isLastLine ? line.replace(/[ \t]+$/, "") : line;
      if (trimmed) inline.push(schema.text(trimmed));
    });
    if (inline.length > 0) blocks.push(paraType.create(null, inline));
  }
  if (blocks.length === 0) return false;
  if (blocks.length === 1) {
    // Single-paragraph fallback: insert the inline content so it joins
    // the surrounding block naturally.
    const slice = new Slice(blocks[0].content, 0, 0);
    return dispatchInsertion(
      view,
      selection,
      pendingAttachmentId,
      (transaction) =>
        replaceInsertionTarget(
          view,
          transaction,
          slice,
          selection,
          selectInserted,
        ),
      selectInserted,
    );
  }
  const slice = new Slice(
    Fragment.fromArray(blocks),
    1,
    1,
  );
  return dispatchInsertion(
    view,
    selection,
    pendingAttachmentId,
    (transaction) =>
      replaceInsertionTarget(
        view,
        transaction,
        slice,
        selection,
        selectInserted,
      ),
    selectInserted,
  );
}

function insertMarkdown(
  view: EditorView,
  schema: Schema,
  parser: Parser,
  md: string,
  selection?: InsertionTarget,
  pendingAttachmentId?: string,
  selectInserted = false,
): boolean {
  let doc: PMNode | null = null;
  try {
    const rawDoc = parser.parse(md);
    if (rawDoc) {
      // Strip orphan HTML-tag text first (e.g. literal `<strong>` from
      // a clipboard that escaped unclosed-tag selection content as
      // entities). After stripping, paragraphs that held only that
      // orphan text become empty and dropEmptyTextblocks removes them.
      doc = dropEmptyTextblocks(stripOrphanTagText(rawDoc));
    }
  } catch {
    // Parser/converter failures have a deterministic plain-text fallback. Do
    // not wrap transaction dispatch in this catch: retrying after a dispatch
    // failure could apply the same user activation twice.
  }
  if (!doc || doc.childCount === 0) {
    // After cleanup, nothing remains. Fall back to plain text so we still
    // respect the user's paste action.
    return insertPlainTextAsBlocks(
      view,
      schema,
      md,
      selection,
      pendingAttachmentId,
      selectInserted,
    );
  }
  // If the parsed markdown reduces to a single inline-only paragraph,
  // insert it as inline text so it joins the current block naturally
  // (no new paragraph wrapper).
  const onlyChild = doc.childCount === 1 ? doc.firstChild : null;
  if (onlyChild && onlyChild.type.name === "paragraph") {
    const slice = new Slice(onlyChild.content, 0, 0);
    return dispatchInsertion(
      view,
      selection,
      pendingAttachmentId,
      (transaction) =>
        replaceInsertionTarget(
          view,
          transaction,
          slice,
          selection,
          selectInserted,
        ),
      selectInserted,
    );
  }
  // Otherwise paste as block-level content. Only a plain paragraph is safe to
  // open and merge with surrounding text. `openStart`/`openEnd` describe nodes
  // cut through at a slice boundary; opening every non-leaf block flattens
  // lists, callouts, headings, and code blocks. Atomic and structural blocks
  // therefore remain closed.
  const slice = new Slice(
    doc.content,
    doc.firstChild?.type === schema.nodes.paragraph ? 1 : 0,
    doc.lastChild?.type === schema.nodes.paragraph ? 1 : 0,
  );
  return dispatchInsertion(
    view,
    selection,
    pendingAttachmentId,
    (transaction) =>
      replaceInsertionTarget(
        view,
        transaction,
        slice,
        selection,
        selectInserted,
      ),
    selectInserted,
  );
}

/** The deterministic owner for a text/plain clipboard payload.
 *
 * Most plain text must stay plain text. Returning `native-text` lets
 * ProseMirror's clipboard parser insert it with the marks at the destination
 * cursor. Markdown parsing is reserved for an unambiguous block construct at
 * the beginning of the payload (or after a blank-line block boundary). This
 * keeps line-wrapped prose from being reinterpreted merely because it contains
 * newlines.
 *
 * Applications that intentionally put Markdown on the clipboard can remove
 * all ambiguity by also providing text/markdown (or text/x-markdown); that
 * explicit MIME is handled separately below.
 */
export type PlainTextPastePolicy = "native-text" | "markdown-structure";

function isMarkdownTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

export function classifyPlainTextPaste(text: string): PlainTextPastePolicy {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return "native-text";

  // YAML/properties is only unambiguous when it has a complete opening and
  // closing fence at the beginning of the clipboard payload.
  if (
    lines[first].trim() === "---" &&
    lines.slice(first + 1).some((line) => line.trim() === "---")
  ) {
    return "markdown-structure";
  }

  // A Markdown table needs both a pipe-bearing header and its delimiter row.
  // A prose line containing a lone pipe is not enough.
  for (let i = first; i + 1 < lines.length; i++) {
    if (!lines[i].includes("|")) continue;
    if (isMarkdownTableDelimiter(lines[i + 1])) {
      return "markdown-structure";
    }
  }

  const blockMarker = /^(?: {0,3})(?:#{1,6}(?:[ \t]+|$)|>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+|(?:`{3,}|~{3,})(?:[ \t]*\S.*)?$|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$|\[[^\]\n]+\]:[ \t]+\S)/;
  for (let i = first; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const atBlockBoundary = i === first || lines[i - 1].trim().length === 0;
    if (atBlockBoundary && blockMarker.test(lines[i])) {
      return "markdown-structure";
    }
  }

  return "native-text";
}

// True when a plain-text payload looks like HTML - starts with a tag
// and contains at least one structural / commonly-pasted element. Some
// clipboard sources (especially copying from contenteditable elements
// in browsers / Electron) write the rendered HTML to `text/plain`
// without populating `text/html`. Without this fallback the paste
// handler would return false, PM's default paste would dump the raw
// HTML into a single text node, and the resulting doc fails save
// round-trip (markdown-it transforms / strips tags on reparse,
// producing a different doc shape).
function looksLikeHtmlInPlain(text: string): boolean {
  if (!/^\s*<\w+[\s>]/.test(text)) return false;
  return /<\/?(p|h[1-6]|ul|ol|li|table|tr|td|th|div|span|strong|em|b|i|a|img|br|hr|font|u|sup|sub|kbd|mark|code|pre|blockquote)\b/i
    .test(text);
}

function insertLink(
  view: EditorView,
  schema: Schema,
  href: string,
  text: string,
) {
  const linkMark = schema.marks.link;
  if (linkMark) {
    const node = schema.text(text, [linkMark.create({ href })]);
    view.dispatch(view.state.tr.replaceSelectionWith(node, false));
  } else {
    view.dispatch(view.state.tr.insertText(`[${text}](${href})`));
  }
}

function wrapSelectionWithLink(
  view: EditorView,
  schema: Schema,
  href: string,
) {
  const linkMark = schema.marks.link;
  if (!linkMark) {
    const { from, to } = view.state.selection;
    const sel = view.state.doc.textBetween(from, to);
    view.dispatch(
      view.state.tr.insertText(`[${sel}](${href})`, from, to),
    );
    return;
  }
  const { from, to } = view.state.selection;
  view.dispatch(view.state.tr.addMark(from, to, linkMark.create({ href })));
}

// ═══════════════════════════════════════════
//  Plugin
// ═══════════════════════════════════════════

export function pasteDropPlugin(
  app: App,
  schema: Schema,
  parser: Parser,
  getSourcePath: () => string,
  serializeDoc?: (doc: PMNode) => string,
) {
  return new PMPlugin({
    key: pasteDropKey,
    state: {
      init: () => new Map<string, PendingAttachmentTarget>(),
      apply(transaction, anchors) {
        let next = anchors;
        if (anchors.size > 0 && transaction.docChanged) {
          next = new Map();
          for (const [id, target] of anchors) {
            next.set(
              id,
              target.kind === "selection"
                ? { kind: "selection", bookmark: target.bookmark.map(transaction.mapping) }
                : {
                    kind: "position",
                    pos: transaction.mapping.map(target.pos, -1),
                    activation: target.activation.map(transaction.mapping),
                    intervened:
                      target.intervened ||
                      transaction.docChanged ||
                      transaction.selectionSet,
                  },
            );
          }
        }
        const meta = transaction.getMeta(pasteDropKey) as
          | PendingAttachmentMeta
          | undefined;
        if (meta?.add || meta?.remove) {
          if (next === anchors) next = new Map(anchors);
          if (meta.remove) next.delete(meta.remove);
          if (meta.add) next.set(meta.add.id, meta.add.target);
        }
        return next;
      },
    },
    props: {
      clipboardTextSerializer: serializeDoc
        ? (slice) => {
            const wrap = schema.node("doc", null, slice.content);
            return serializeDoc(wrap);
          }
        : undefined,
      handleDOMEvents: {
        paste: (view, event) => {
          const e = event;
          if (!e.clipboardData) return false;

          const plain = e.clipboardData.getData("text/plain");
          const html = e.clipboardData.getData("text/html");
          const explicitMarkdown =
            e.clipboardData.getData("text/markdown") ||
            e.clipboardData.getData("text/x-markdown");

          // This check must precede every Butter specialization, including URL
          // and image handling. Otherwise copying a linked URL or image inside
          // Butter could be reinterpreted instead of using the exact PM slice.
          if (html && shouldDeferToProseMirrorClipboard(html)) return false;

          // Image?
          const items = Array.from(e.clipboardData.items);
          const image = items.find((i) => i.type.startsWith("image/"));
          if (image) {
            const blob = image.getAsFile();
            if (!blob) return false;
            const sourcePath = getSourcePath();
            const pendingId = registerPendingAttachment(
              view,
              {
                kind: "selection",
                bookmark: view.state.selection.getBookmark(),
              },
              "paste",
            );
            if (!pendingId) return false;
            e.preventDefault();
            void (async () => {
              let consumed = false;
              let savedFile: TFile | null = null;
              try {
                try {
                  savedFile = await saveBlobAsAttachment(
                    app,
                    blob,
                    "pasted-image",
                    sourcePath,
                  );
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  recordError("paste", `Clipboard image save failed: ${message}`);
                }
                if (savedFile) {
                  const target = resolvePendingAttachment(view, pendingId);
                  if (target !== null) {
                    try {
                      consumed = insertMarkdown(
                        view,
                        schema,
                        parser,
                        attachmentEmbed(app, savedFile, sourcePath),
                        target.insertion,
                        pendingId,
                        target.selectInserted,
                      );
                    } catch (error) {
                      const message =
                        error instanceof Error ? error.message : String(error);
                      recordError(
                        "paste",
                        `Clipboard image insertion failed: ${message}`,
                      );
                    }
                  } else {
                    recordError(
                      "paste",
                      "Clipboard image was saved, but its editor target no longer exists",
                    );
                  }
                }
              } finally {
                if (!consumed) {
                  cancelPendingAttachment(view, pendingId, "paste");
                  if (savedFile) {
                    await rollbackAttachments(app, [savedFile], "paste");
                  }
                }
              }
            })().catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              recordError("paste", `Async clipboard image task failed: ${message}`);
            });
            return true;
          }

          const { empty } = view.state.selection;

          if (plain && isUrl(plain)) {
            e.preventDefault();
            const url = plain.trim();
            if (empty) {
              insertLink(view, schema, url, hostname(url));
            } else {
              wrapSelectionWithLink(view, schema, url);
            }
            return true;
          }

          // Pasting a table fragment into an existing table cell:
          // delegate to PM-tables' built-in paste handler (it fills
          // the destination cells from the clipboard table). Without
          // this, our HTML→markdown converter produces a markdown
          // table that gets parsed as a NEW table block and inserted
          // inside the cell, doubling the visible table size.
          const cursorInCell = inTableCell(view.state);
          const htmlHasTable = !!html && /<table\b/i.test(html);
          if (cursorInCell && htmlHasTable) {
            return false;
          }

          if (html && looksRich(html)) {
            e.preventDefault();
            const md = htmlToMarkdown(html);
            insertMarkdown(view, schema, parser, md);
            return true;
          }

          // An explicit Markdown MIME is an application-level promise about
          // the payload, so it may use the Markdown parser without guessing
          // from ordinary prose. HTML remains preferred above when the source
          // supplied a rich representation.
          if (explicitMarkdown && !cursorInCell) {
            e.preventDefault();
            insertMarkdown(view, schema, parser, explicitMarkdown);
            return true;
          }

          // text/html missing, but text/plain is shaped like HTML
          // copy from a contenteditable / DOM-source-view source that
          // didn't populate text/html. Recover by running the plain
          // text through htmlToMarkdown.
          if (
            !html &&
            plain &&
            looksLikeHtmlInPlain(plain) &&
            !cursorInCell
          ) {
            e.preventDefault();
            const md = htmlToMarkdown(plain);
            insertMarkdown(view, schema, parser, md);
            return true;
          }

          // Only unambiguous block-shaped Markdown is parsed from text/plain.
          // Ordinary one- or multi-line prose falls through to ProseMirror,
          // which inserts it as text and inherits the destination marks. Skip
          // this in table cells so TSV/cell-fill stays owned by PM-tables.
          if (
            plain &&
            classifyPlainTextPaste(plain) === "markdown-structure" &&
            !cursorInCell
          ) {
            e.preventDefault();
            insertMarkdown(view, schema, parser, plain);
            return true;
          }

          return false;
        },
        drop: (view, event) => {
          const e = event;
          if (!e.dataTransfer) return false;
          const files = Array.from(e.dataTransfer.files);
          if (!files.length) return false;
          const sourcePath = getSourcePath();

          const hit = typeof view.posAtCoords === "function" &&
            Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
            ? view.posAtCoords({ left: e.clientX, top: e.clientY })
            : null;
          const pendingId = registerPendingAttachment(
            view,
            hit
              ? {
                  kind: "position",
                  pos: hit.pos,
                  activation: view.state.selection.getBookmark(),
                  intervened: false,
                }
              : {
                  kind: "selection",
                  bookmark: view.state.selection.getBookmark(),
                },
            "drop",
          );
          if (!pendingId) return false;
          e.preventDefault();
          void (async () => {
            let consumed = false;
            const savedFiles: TFile[] = [];
            try {
              for (const f of files) {
                try {
                  const saved = await saveBlobAsAttachment(
                    app,
                    f,
                    f.name,
                    sourcePath,
                    true,
                  );
                  if (saved) savedFiles.push(saved);
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  recordError(
                    "drop",
                    `Dropped attachment save failed (${f.name}): ${message}`,
                  );
                }
              }
              const target = resolvePendingAttachment(view, pendingId);
              if (savedFiles.length && target !== null) {
                try {
                  consumed = insertMarkdown(
                    view,
                    schema,
                    parser,
                    savedFiles
                      .map((file) => attachmentEmbed(app, file, sourcePath))
                      .join("\n"),
                    target.insertion,
                    pendingId,
                    target.selectInserted,
                  );
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  recordError(
                    "drop",
                    `Dropped attachment insertion failed: ${message}`,
                  );
                }
              } else if (savedFiles.length) {
                recordError(
                  "drop",
                  "Dropped attachments were saved, but their editor target no longer exists",
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              recordError("drop", `Dropped attachment handling failed: ${message}`);
            } finally {
              if (!consumed) {
                cancelPendingAttachment(view, pendingId, "drop");
                await rollbackAttachments(app, savedFiles, "drop");
              }
            }
          })().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            recordError("drop", `Async dropped-attachment task failed: ${message}`);
          });
          return true;
        },
      },
    },
  });
}
