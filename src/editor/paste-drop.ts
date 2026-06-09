/**
 * Paste & drop handling for Butter PM.
 *   - URL on empty selection  → inline [host](url) link
 *   - URL on selection        → wrap selection as link
 *   - Image on clipboard      → save to vault, insert ![[name]]
 *   - HTML on clipboard       → run through MD converter, then parse + insert
 *   - File drop from OS       → save to vault, insert ![[name]]
 */
import { App, TFile, normalizePath } from "obsidian";
import { Plugin as PMPlugin, PluginKey, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Fragment, Slice, type Node as PMNode, type Schema } from "prosemirror-model";
import type { Parser } from "../core/parser-types";
import { htmlToMarkdown } from "./paste-html";
import { dropEmptyTextblocks, stripOrphanTagText } from "./paste-cleanup";

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

async function saveBlobAsAttachment(
  app: App,
  blob: Blob,
  preferredName: string,
  sourcePath: string,
): Promise<TFile | null> {
  const folderRaw = app.vault.getConfig?.("attachmentFolderPath");
  const folder = typeof folderRaw === "string" ? folderRaw : "";
  const baseDir = folder
    ? normalizePath(folder.replace(/^\/+/, ""))
    : normalizePath(sourcePath.split("/").slice(0, -1).join("/") || "");
  try {
    if (baseDir && !app.vault.getAbstractFileByPath(baseDir)) {
      await app.vault.createFolder(baseDir);
    }
  } catch {
    // Ignored: createFolder fails if the folder already exists or if
    // a parent is missing. Either way we proceed to the write below.
  }

  const ext = blob.type.split("/")[1]?.split("+")[0] || "bin";
  const base = preferredName.replace(/\.[^.]+$/, "") || "pasted";
  let name = `${base}.${ext}`;
  let i = 1;
  let path = normalizePath(baseDir ? `${baseDir}/${name}` : name);
  while (app.vault.getAbstractFileByPath(path)) {
    name = `${base}-${i++}.${ext}`;
    path = normalizePath(baseDir ? `${baseDir}/${name}` : name);
  }
  const buf = await blob.arrayBuffer();
  return await app.vault.createBinary(path, buf);
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
function insertPlainTextAsBlocks(
  view: EditorView,
  schema: Schema,
  text: string,
) {
  const paragraphs = text.split(/\r?\n\r?\n+/);
  const paraType = schema.nodes.paragraph;
  const softbreak = schema.nodes.softbreak;
  if (!paraType) {
    view.dispatch(view.state.tr.insertText(text.replace(/\n/g, " ")));
    return;
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
  if (blocks.length === 0) return;
  if (blocks.length === 1) {
    // Single-paragraph fallback: insert the inline content so it joins
    // the surrounding block naturally.
    const slice = new Slice(blocks[0].content, 0, 0);
    view.dispatch(view.state.tr.replaceSelection(slice));
    return;
  }
  const slice = new Slice(
    Fragment.fromArray(blocks),
    1,
    1,
  );
  view.dispatch(view.state.tr.replaceSelection(slice));
}

function insertMarkdown(
  view: EditorView,
  schema: Schema,
  parser: Parser,
  md: string,
) {
  try {
    const rawDoc = parser.parse(md);
    if (!rawDoc) {
      insertPlainTextAsBlocks(view, schema, md);
      return;
    }
    // Strip orphan HTML-tag text first (e.g. literal `<strong>` from
    // a clipboard that escaped unclosed-tag selection content as
    // entities). After stripping, paragraphs that held only that
    // orphan text become empty and dropEmptyTextblocks removes them.
    const doc = dropEmptyTextblocks(stripOrphanTagText(rawDoc));
    if (doc.childCount === 0) {
      // After cleanup, nothing to insert. Fall back to plain text so
      // we still respect the user's paste action.
      insertPlainTextAsBlocks(view, schema, md);
      return;
    }
    // If the parsed markdown reduces to a single inline-only paragraph,
    // insert it as inline text so it joins the current block naturally
    // (no new paragraph wrapper).
    const onlyChild =
      doc.childCount === 1 ? doc.firstChild : null;
    if (onlyChild && onlyChild.type.name === "paragraph") {
      const slice = new Slice(onlyChild.content, 0, 0);
      view.dispatch(view.state.tr.replaceSelection(slice));
      return;
    }
    // Otherwise paste as block-level content. openStart/openEnd = 1
    // lets the first and last blocks merge with the surrounding
    // paragraph if the cursor is mid-paragraph.
    const slice = new Slice(doc.content, 1, 1);
    view.dispatch(view.state.tr.replaceSelection(slice));
  } catch {
    insertPlainTextAsBlocks(view, schema, md);
  }
}

/**
 * Heuristic: does this plain-text paste look structurally markdown?
 * We route anything multi-line (or containing common markdown block
 * markers) through the parser so tables, lists, headings, etc. are
 * preserved instead of getting shredded into one-line-per-paragraph.
 */
function looksMarkdownStructural(text: string): boolean {
  if (text.includes("\n")) return true;
  return /^(#{1,6}\s|>\s|-\s|\*\s|\d+\.\s|\|\s|```|~~~)/.test(text);
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
    key: new PluginKey("butter-paste-drop"),
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

          // Image?
          const items = Array.from(e.clipboardData.items);
          const image = items.find((i) => i.type.startsWith("image/"));
          if (image) {
            const blob = image.getAsFile();
            if (!blob) return false;
            e.preventDefault();
            void (async () => {
              const file = await saveBlobAsAttachment(
                app,
                blob,
                "pasted-image",
                getSourcePath(),
              );
              if (file) {
                insertMarkdown(view, schema, parser, `![[${file.name}]]`);
              }
            })();
            return true;
          }

          const plain = e.clipboardData.getData("text/plain");
          const html = e.clipboardData.getData("text/html");
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

          // PM's own copy writes `data-pm-slice` on the HTML. When the
          // clipboard came from Butter, text/plain holds our serializer's
          // markdown (wikilinks, tags, embeds preserved). Use it instead
          // of the HTML which flattens Obsidian syntax to standard links.
          if (html && /data-pm-slice/i.test(html) && plain) {
            e.preventDefault();
            insertMarkdown(view, schema, parser, plain);
            return true;
          }

          if (html && looksRich(html)) {
            e.preventDefault();
            const md = htmlToMarkdown(html);
            insertMarkdown(view, schema, parser, md);
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

          // Plain text with structural markdown features (tables,
          // lists, headings, multi-line) - run through the parser so
          // it gets proper structure instead of PM's default "each
          // line becomes a new paragraph" behaviour. Skip when the
          // cursor is in a table cell so a TSV/multi-line paste from
          // Excel-like sources falls through to PM-tables' cell-fill
          // handler instead of our markdown parser.
          if (plain && looksMarkdownStructural(plain) && !cursorInCell) {
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

          e.preventDefault();
          void (async () => {
            const inserts: string[] = [];
            for (const f of files) {
              const saved = await saveBlobAsAttachment(
                app,
                f,
                f.name,
                getSourcePath(),
              );
              if (saved) inserts.push(`![[${saved.name}]]`);
            }
            if (inserts.length) {
              insertMarkdown(view, schema, parser, inserts.join("\n"));
            }
          })();
          return true;
        },
      },
    },
  });
}
