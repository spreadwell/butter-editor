/**
 * Auto-split full-width inline images into their own paragraph.
 *
 * Images and wikilink embeds without a `|WIDTH` size hint render
 * full-column-wide. When such an atom sits inside a paragraph that
 * also contains other inline content (text, marks, etc.), the
 * visual result is awkward: the image takes a full row but the
 * surrounding text is technically inline, so deletion / cursor
 * navigation / copy behaves inconsistently.
 *
 * This plugin watches every transaction and, when a paragraph ends
 * up with mixed content where one or more children are "block-class"
 * (full-width-rendering) inline atoms, replaces the paragraph with
 * up to 3 new paragraphs - pre-atom, atom-only, post-atom - so the
 * atom sits alone in its own block without deleting text or marks.
 *
 * Block-class inline atoms:
 *   • `image` with `width === null` (no explicit pixel width set;
 *     `displayMode: 'full'` images also fall here since their width
 *     is null)
 *   • `obsidian_embed_inline` whose `src` lacks a `|N` numeric size
 *     suffix - covers both attachment embeds (`![[pic.png]]`) and
 *     note transclusions (`![[Other Note]]`).
 *
 * Sized inline images / embeds (`![alt|150](pic)`,
 * `![[pic|150x150]]`) stay inline since the user has explicitly
 * scoped the visual size.
 *
 * Reference images retain their authored definition binding and native alt
 * grammar. Marked atoms retain their complete source owner/provenance; splitting
 * a linked occurrence across paragraphs would change native cardinality. Both
 * stay inline. The serializer owns faithful edge-whitespace spelling.
 *
 * Drag interlock: the plugin SKIPS its work when a Butter drag is
 * in progress (the Drag Scene body class is set). Splits
 * happening mid-drag corrupt the drag's tracked positions and have
 * been observed to cause save round-trip failures. The next post-
 * drag transaction triggers any needed splits cleanly.
 *
 * Gated on the `splitFullWidthImages` setting - users who want
 * strict source preservation can turn it off and the plugin
 * becomes a no-op.
 */
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { isHistoryTransaction } from "prosemirror-history";
import type { Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import { changedRangesInFinalDoc } from "./changed-ranges";
import { RAW_BLOCK_SYNC_META } from "../core/raw-block-safety";

const key = new PluginKey("butter-auto-split-images");

function shouldBeBlockLevel(node: PMNode): boolean {
  if (node.marks.length) return false;
  if (node.type.name === "image") {
    if (node.attrs.sourceSyntax === "reference") return false;
    // Pixel-sized → keep inline. width=null covers both natural and
    // full-width display modes; both render full-column-wide.
    return node.attrs.width == null;
  }
  if (node.type.name === "obsidian_embed_inline") {
    const src = (node.attrs.src as string) || "";
    // |N or |NxM suffix → sized → keep inline. Anything else
    // (no pipe, or non-numeric suffix) renders full-width.
    return !/\|\d/.test(src);
  }
  return false;
}

export function autoSplitImagesPlugin(
  schema: Schema,
  isEnabled: () => boolean,
) {
  return new Plugin({
    key,
    appendTransaction(transactions, _oldState, newState) {
      if (!isEnabled()) return null;
      // History and trusted source/save reconciliation restore an accepted
      // placement. Their bounding replacements can include unchanged inline
      // layouts; those ranges do not request new automatic placement.
      if (transactions.some(tr => {
        // Later append rounds contain only unseen suffix transactions. PM
        // binds each appended transaction to the initiating root operation.
        const root = (tr.getMeta("appendedTransaction") as Transaction | undefined) ?? tr;
        return isHistoryTransaction(tr) || tr.getMeta(RAW_BLOCK_SYNC_META) === true ||
          isHistoryTransaction(root) || root.getMeta(RAW_BLOCK_SYNC_META) === true;
      })) return null;
      const changedRanges = changedRangesInFinalDoc(transactions, newState.doc);
      if (changedRanges.length === 0) return null;
      // Skip while a drag is in progress - splitting paragraphs
      // mid-drag invalidates the drag's tracked positions and has
      // been observed to corrupt save round-trips. The next post-
      // drag transaction handles any needed splits.
      if (
        typeof document !== "undefined" &&
        activeDocument.body?.classList?.contains("butter-is-drag-scene-v2")
      ) {
        return null;
      }

      // Walk top-level paragraphs and collect work items. We process
      // top-level paragraphs only - splitting inside list-item /
      // blockquote / callout content is more invasive than the spec
      // asked for and harder to make safe.
      const work: Array<{
        paraPos: number;
        paraNode: PMNode;
        atomIdx: number;
      }> = [];
      const visited = new Set<number>();
      const inspectParagraph = (child: PMNode, offset: number) => {
        if (visited.has(offset)) return;
        visited.add(offset);
        if (child.type.name !== "paragraph") return;
        // Trivial case: paragraph IS just the atom - already isolated.
        if (
          child.childCount === 1 &&
          shouldBeBlockLevel(child.firstChild!)
        ) return;
        // Find the first block-class atom in this paragraph.
        let atomIdx = -1;
        for (let i = 0; i < child.childCount; i++) {
          if (shouldBeBlockLevel(child.child(i))) {
            atomIdx = i;
            break;
          }
        }
        if (atomIdx < 0) return;
        work.push({ paraPos: offset, paraNode: child, atomIdx });
      };
      for (const range of changedRanges) {
        newState.doc.nodesBetween(range.from, range.to, (child, offset, parent) => {
          if (parent !== newState.doc) return false;
          inspectParagraph(child, offset);
          return false;
        });
      }
      if (work.length === 0) return null;

      // Apply replacements in REVERSE order so earlier paragraph
      // positions stay valid (each replacement may change the
      // document length).
      const tr = newState.tr;
      for (let i = work.length - 1; i >= 0; i--) {
        const { paraPos, paraNode, atomIdx } = work[i];
        const para = schema.nodes.paragraph;
        const preChildren: PMNode[] = [];
        const postChildren: PMNode[] = [];
        let atom: PMNode | null = null;
        paraNode.forEach((c, _o, idx) => {
          if (idx < atomIdx) preChildren.push(c);
          else if (idx === atomIdx) atom = c;
          else postChildren.push(c);
        });
        if (!atom) continue;

        const replacement: PMNode[] = [];
        if (preChildren.length > 0) {
          replacement.push(para.create(null, preChildren));
        }
        // When the isolated atom is a wikilink-embed, switch to the
        // BLOCK-level `obsidian_embed` schema node - that's what
        // markdown-it produces for `![[…]]` alone on a line. Without
        // this swap, our paragraph-wrapped inline embed serializes
        // identically to the block form, but re-parse produces
        // `obsidian_embed` and the structural fingerprint diverges.
        // For markdown images (`![alt](src)`), keep them as inline
        // atoms inside a paragraph - markdown-it parses them that
        // way regardless of whether they're alone on their line.
        const atomNode: PMNode = atom;
        let atomBlock: PMNode;
        if (atomNode.type.name === "obsidian_embed_inline") {
          atomBlock = schema.nodes.obsidian_embed.create({
            src: (atomNode.attrs as { src?: string }).src ?? "",
          });
        } else {
          atomBlock = para.create(null, atomNode);
        }
        replacement.push(atomBlock);
        if (postChildren.length > 0) {
          replacement.push(para.create(null, postChildren));
        }
        const paraEnd = paraPos + paraNode.nodeSize;
        tr.replaceWith(paraPos, paraEnd, replacement);
      }
      return tr.docChanged ? tr : null;
    },
  });
}
