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
 * up to 3 new paragraphs - pre-atom (trimmed), atom-only, post-
 * atom (trimmed) - so the atom sits alone in its own block.
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
 * Whitespace handling: the leading/trailing whitespace of the new
 * pre/post paragraphs is trimmed because markdown-it trims it on
 * re-parse anyway. Without trimming, every split paragraph would
 * lose 1-2 chars of textContent on round-trip and the save guard's
 * fingerprint check would fail.
 *
 * Drag interlock: the plugin SKIPS its work when a Butter drag is
 * in progress (the `butter-is-dragging` body class is set). Splits
 * happening mid-drag corrupt the drag's tracked positions and have
 * been observed to cause save round-trip failures. The next post-
 * drag transaction triggers any needed splits cleanly.
 *
 * Gated on the `splitFullWidthImages` setting - users who want
 * strict source preservation can turn it off and the plugin
 * becomes a no-op.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { Schema } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";

const key = new PluginKey("butter-auto-split-images");

function shouldBeBlockLevel(node: PMNode): boolean {
  if (node.type.name === "image") {
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

// Trim leading whitespace from the first text node in a fragment,
// dropping the node entirely if it goes to zero length. Returns the
// resulting children array.
function trimLeadingWhitespace(children: PMNode[], schema: Schema): PMNode[] {
  if (children.length === 0) return children;
  const first = children[0];
  if (!first.isText) return children;
  const trimmed = first.text!.replace(/^[ \t]+/, "");
  if (trimmed === first.text) return children;
  if (trimmed.length === 0) return children.slice(1);
  return [
    schema.text(trimmed, first.marks),
    ...children.slice(1),
  ];
}

// Trim trailing whitespace from the last text node in a children
// array, dropping the node if it goes to zero length.
function trimTrailingWhitespace(children: PMNode[], schema: Schema): PMNode[] {
  if (children.length === 0) return children;
  const last = children[children.length - 1];
  if (!last.isText) return children;
  const trimmed = last.text!.replace(/[ \t]+$/, "");
  if (trimmed === last.text) return children;
  if (trimmed.length === 0) return children.slice(0, -1);
  return [
    ...children.slice(0, -1),
    schema.text(trimmed, last.marks),
  ];
}

export function autoSplitImagesPlugin(
  schema: Schema,
  isEnabled: () => boolean,
) {
  return new Plugin({
    key,
    appendTransaction(_trs, _oldState, newState) {
      if (!isEnabled()) return null;
      // Skip while a drag is in progress - splitting paragraphs
      // mid-drag invalidates the drag's tracked positions and has
      // been observed to corrupt save round-trips. The next post-
      // drag transaction handles any needed splits.
      if (
        typeof document !== "undefined" &&
        activeDocument.body?.classList?.contains("butter-is-dragging")
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
      newState.doc.forEach((child, offset) => {
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
      });
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

        // Trim trailing ws from pre, leading ws from post. Markdown-
        // it trims these on re-parse, so leaving them in causes a
        // textContent delta the save guard rejects.
        const trimmedPre = trimTrailingWhitespace(preChildren, schema);
        const trimmedPost = trimLeadingWhitespace(postChildren, schema);

        const replacement: PMNode[] = [];
        if (trimmedPre.length > 0) {
          replacement.push(para.create(null, trimmedPre));
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
        if (trimmedPost.length > 0) {
          replacement.push(para.create(null, trimmedPost));
        }
        const paraEnd = paraPos + paraNode.nodeSize;
        tr.replaceWith(paraPos, paraEnd, replacement);
      }
      return tr.docChanged ? tr : null;
    },
  });
}
