import type { Node as PMNode } from "prosemirror-model";
import { normalizeTablesInDoc } from "../editor/table-normalize";
import { normalize } from "./normalize";
import {
  preflightExactSave,
  type SavePreflightBlocked,
  type SavePreflightOk,
  type SavePreflightRuntime,
  type SavePreflightStage,
} from "./save-preflight";
import type { CanonicalFormOptions } from "./serializer";
import { canEncodeButterFileUtf8, splitButterFileSource } from "./file-shell";
import { parser } from "./parser";
import { docSemanticFingerprint, semanticDifference } from "./doc-fingerprint";
import { isWholeSourceFallback } from "./raw-block-safety";
import { hasValidCommentNavigationProvenance } from "./comment-navigation";
import { hasValidCommentMarkdownNavigation } from "./comment-markdown-navigation";
import { hasUnclosedHtmlCommentTail } from "./html-comments";
import { hasValidLinkOccurrences } from "./link-occurrence";

/** The file policy shared by the editor, conformance tests and diagnostics. */
export interface ButterSavePolicy {
  readonly originalBody: string;
  readonly originalDoc: PMNode | null;
  readonly preserveOriginalSource: boolean;
  readonly preserveSource: boolean;
  readonly originalTrailingNewlines: number;
  readonly canonicalOptions?: CanonicalFormOptions;
  readonly normalizeHeadingGap?: boolean;
  readonly condenseBlankLines?: boolean;
  readonly closeUnclosedFences?: boolean;
  readonly frontmatter?: string;
  readonly lineEnding?: "\n" | "\r\n" | "\r";
  readonly originalHasBOM?: boolean;
}

export type ButterSaveResult =
  | (SavePreflightOk & { readonly text: string })
  | SavePreflightBlocked;

const failureMessages: Readonly<Record<SavePreflightStage, string>> = {
  availability: "selected save path is unavailable",
  normalize: "save normalization failed",
  fingerprint: "semantic verification failed",
  serialize: "serialization failed",
  finalize: "file finalization failed",
  reparse: "saved source could not be parsed",
  compare: "exact semantic fingerprint mismatch",
};

/** Caught parser/schema errors can contain note text or file paths. Generic
 * diagnostics expose only the typed stage and content-free semantic locator. */
export function describeButterSaveFailure(result: SavePreflightBlocked): string {
  return result.attempts.map(attempt => `${attempt.path}/${attempt.stage}: ${failureMessages[attempt.stage]}` +
    (attempt.difference ? ` at ${attempt.difference.path} (${attempt.difference.kind})` : "")).join(" | ");
}

export function preservesSource(policy: ButterSavePolicy): boolean {
  return Boolean(policy.preserveOriginalSource && policy.preserveSource && policy.originalDoc);
}

export function finalizeButterSaveBody(body: string, policy: ButterSavePolicy, normalizedDoc?: PMNode): string {
  const trailing = preservesSource(policy) ? policy.originalTrailingNewlines : 1;
  const normalizedEol = body.replace(/\r\n?|\n/g, "\n");
  // An unclosed authored HTML comment owns its exact terminal payload. Its
  // serialized tail can contain zero or several LF, including one left after
  // removing a quote/list prefix. File-shell newline policy cannot rewrite
  // those opaque bytes. The caller supplies the actual normalized document.
  const finalized = normalizedDoc && hasUnclosedHtmlCommentTail(normalizedDoc) ? normalizedEol
    : normalizedEol.replace(/\n*$/, "") + "\n".repeat(trailing);
  if (!policy.normalizeHeadingGap && !policy.condenseBlankLines && !policy.closeUnclosedFences) {
    return finalized;
  }
  return normalize(finalized, {
    headingGap: Boolean(policy.normalizeHeadingGap),
    condenseBlanks: Boolean(policy.condenseBlankLines),
    closeUnclosedFences: Boolean(policy.closeUnclosedFences),
  });
}

export function assembleButterSaveText(body: string, policy: ButterSavePolicy): string {
  let text = ((policy.frontmatter ?? "") + body).replace(/\r\n?|\n/g, "\n");
  if (policy.lineEnding && policy.lineEnding !== "\n") {
    text = text.replace(/\n/g, policy.lineEnding);
  }
  return policy.originalHasBOM ? `\ufeff${text}` : text;
}

/**
 * The complete product save decision. Only the verified candidate's bytes are
 * assembled into the native file shell. No caller may substitute a different
 * serializer, a normalized reparse, an old body, or an unverified fallback.
 */
export function preflightButterSave(
  currentDoc: PMNode,
  policy: ButterSavePolicy,
  runtimeOverrides: Partial<SavePreflightRuntime> = {},
): ButterSaveResult {
  const primaryPath = preservesSource(policy) ? "source-preserving" : "canonical";
  if (!hasValidCommentNavigationProvenance(currentDoc) || !hasValidCommentMarkdownNavigation(currentDoc) ||
    !hasValidLinkOccurrences(currentDoc)) {
    return {
      ok: false,
      blocked: true,
      attempts: Object.freeze([{
        ok: false as const,
        path: primaryPath,
        stage: "normalize" as const,
        error: "inconsistent source-owned navigation provenance",
      }]),
    };
  }
  let tableNormalized: PMNode;
  try {
    tableNormalized = normalizeTablesInDoc(currentDoc, currentDoc.type.schema);
  } catch (error) {
    return {
      ok: false,
      blocked: true,
      attempts: Object.freeze([{
        ok: false as const,
        path: primaryPath,
        stage: "normalize" as const,
        error: error instanceof Error ? error.message : String(error),
      }]),
    };
  }
  // Whole-source recovery remains locked until the loader supplies a trusted
  // new baseline. Local opaque atoms belong to the ordinary document: deleting
  // a selected occurrence is user intent, not disappearance of a parse-failure
  // file. The command layer and normalization conservation tests prevent
  // accidental omission before this exact representation check.
  if (policy.originalDoc && isWholeSourceFallback(policy.originalDoc) &&
    (!isWholeSourceFallback(tableNormalized) ||
      tableNormalized.firstChild!.attrs.raw !== policy.originalDoc.firstChild!.attrs.raw)) {
    return {
      ok: false,
      blocked: true,
      attempts: Object.freeze([{
        ok: false as const,
        path: "source-preserving" as const,
        stage: "compare" as const,
        error: "loaded whole-source recovery document changed outside a trusted reparse",
      }]),
    };
  }
  const result = preflightExactSave({
    currentDoc: tableNormalized,
    originalBody: policy.originalBody,
    originalDoc: policy.originalDoc,
    canonicalOptions: policy.canonicalOptions,
    primaryPath,
    finalizeBody: (body, normalizedDoc) => {
      let finalized = finalizeButterSaveBody(body, policy, normalizedDoc);
      // At the beginning of a headerless file, two --- rules can become a
      // YAML header on reopening. Choose an equivalent first-rule spelling
      // before verification, without rewriting opaque/raw source.
      if (!policy.frontmatter && tableNormalized.firstChild?.type.name === "horizontal_rule" &&
        finalized.startsWith("---\n") &&
        splitButterFileSource(assembleButterSaveText(finalized, policy)).frontmatter) {
        finalized = "***" + finalized.slice(3);
      }
      return finalized;
    },
  }, runtimeOverrides);
  if (!result.ok) return result;
  const text = assembleButterSaveText(result.candidate, policy);
  if (!canEncodeButterFileUtf8(text)) {
    return { ok: false, blocked: true, attempts: Object.freeze([{
      ok: false as const, path: result.path, stage: "finalize" as const,
      error: "assembled file contains an unpaired UTF-16 surrogate; UTF-8 cannot preserve it",
    }]) };
  }
  const loadedBody = splitButterFileSource(text).body.replace(/\r\n?|\n/g, "\n");
  if (loadedBody === result.candidate) return { ...result, text };
  // Certify the body that the actual loader will receive, not just the
  // pre-assembly body. Ordinary EOL/BOM restoration needs no second parse.
  let expectedFingerprint: string;
  let actualFingerprint: string;
  try {
    const reparsed = runtimeOverrides.parseBody
      ? runtimeOverrides.parseBody(loadedBody)
      : parser.parseWithSourceMap(loadedBody)?.doc ?? null;
    if (!reparsed) throw new Error("assembled file body reparse returned null");
    const fingerprint = runtimeOverrides.semanticFingerprint ?? docSemanticFingerprint;
    expectedFingerprint = fingerprint(result.normalizedDoc);
    actualFingerprint = fingerprint(reparsed);
  } catch (error) {
    return { ok: false, blocked: true, attempts: Object.freeze([{
      ok: false as const, path: result.path, stage: "reparse" as const,
      error: error instanceof Error ? error.message : String(error), candidate: result.candidate,
    }]) };
  }
  if (actualFingerprint !== expectedFingerprint) {
    return { ok: false, blocked: true, attempts: Object.freeze([{
      ok: false as const, path: result.path, stage: "compare" as const,
      error: "assembled file changed the verified body at the load boundary",
      candidate: result.candidate, expectedFingerprint, actualFingerprint,
      difference: semanticDifference(expectedFingerprint, actualFingerprint) ?? undefined,
    }]) };
  }
  return { ...result, text };
}
