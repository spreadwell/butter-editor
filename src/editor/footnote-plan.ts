import type { Node as PMNode } from "prosemirror-model";
import { commentMarkdownFootnotes } from "../core/comment-markdown-navigation";
import { blockCommentFootnotes } from "../core/source-footnotes";

export interface FootnoteReferencePresentation {
  kind: "reference" | "inline";
  label: string | null;
  ordinal: number | null;
  occurrence: number;
  resolved: boolean;
  display: string;
}

export interface FootnoteDefinitionPresentation {
  ordinal: number | null;
  referenceIndexes: number[];
}

export interface FootnotePresentationPlan {
  references: FootnoteReferencePresentation[];
  definitions: Map<string, FootnoteDefinitionPresentation>;
  virtualInlineDefinitions: { ordinal: number; referenceIndex: number; content: string }[];
}

/** Compute Obsidian-style numbering without changing Markdown identity. */
export function planFootnotePresentation(doc: PMNode): FootnotePresentationPlan {
  const definitionLabels = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "footnote_def") {
      definitionLabels.add(String(node.attrs.label ?? ""));
    }
  });

  const definitions = new Map<string, FootnoteDefinitionPresentation>();
  for (const label of definitionLabels) {
    definitions.set(label, { ordinal: null, referenceIndexes: [] });
  }

  const ordinalByLabel = new Map<string, number>();
  const occurrencesByLabel = new Map<string, number>();
  const references: FootnoteReferencePresentation[] = [];
  const virtualInlineDefinitions: FootnotePresentationPlan["virtualInlineDefinitions"] = [];
  let nextOrdinal = 1;

  const addReference = (label: string): void => {
    const resolved = definitionLabels.has(label);
    if (!resolved) {
      references.push({ kind: "reference", label, ordinal: null, occurrence: 0, resolved: false, display: label });
      return;
    }
    let ordinal = ordinalByLabel.get(label);
    if (ordinal === undefined) {
      ordinal = nextOrdinal++;
      ordinalByLabel.set(label, ordinal);
      definitions.get(label)!.ordinal = ordinal;
    }
    const occurrence = occurrencesByLabel.get(label) ?? 0;
    occurrencesByLabel.set(label, occurrence + 1);
    const referenceIndex = references.length;
    definitions.get(label)!.referenceIndexes.push(referenceIndex);
    references.push({ kind: "reference", label, ordinal, occurrence, resolved: true,
      display: occurrence === 0 ? `[${ordinal}]` : `[${ordinal}-${occurrence}]` });
  };

  doc.descendants((node) => {
    if (node.type.name === "inline_footnote") {
      const ordinal = nextOrdinal++;
      references.push({
        kind: "inline",
        label: null,
        ordinal,
        occurrence: 0,
        resolved: true,
        display: `[${ordinal}]`,
      });
      return;
    }
    if (node.type.name === "footnote_ref") addReference(String(node.attrs.label ?? ""));
    else for (const entry of node.type.name === "block_comment" ? blockCommentFootnotes(node) : commentMarkdownFootnotes(node)) {
      if (entry.kind === "reference") addReference(entry.label);
      else {
        const ordinal = nextOrdinal++, referenceIndex = references.length;
        references.push({ kind: "inline", label: null, ordinal, occurrence: 0, resolved: true, display: `[${ordinal}]` });
        virtualInlineDefinitions.push({ ordinal, referenceIndex, content: entry.content });
      }
    }
  });

  return { references, definitions, virtualInlineDefinitions };
}
