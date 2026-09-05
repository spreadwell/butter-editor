import type { Node as PMNode } from "prosemirror-model";
import { docSemanticFingerprint } from "./doc-fingerprint";
import { normalizeDocForSave } from "./doc-normalize";
import { parser } from "./parser";
import { serializer, type CanonicalFormOptions } from "./serializer";

export type SaveCandidatePath = "source-preserving" | "canonical";

export type SavePreflightStage =
  | "normalize"
  | "fingerprint"
  | "availability"
  | "serialize"
  | "finalize"
  | "reparse"
  | "compare";

export interface SavePreflightInput {
  readonly currentDoc: PMNode;
  readonly originalBody: string;
  readonly originalDoc: PMNode | null;
  readonly canonicalOptions?: CanonicalFormOptions;
  readonly primaryPath: SaveCandidatePath;
  /**
   * Optional second path for explicit diagnostic/migration callers. Product
   * saves omit this: a source-preserving failure must never silently rewrite
   * the note canonically (and vice versa).
   */
  readonly fallbackPath?: SaveCandidatePath;

  /**
   * Applies the complete file-shell policy to a serialized Markdown body.
   * The same function is called for every candidate path before validation.
   */
  readonly finalizeBody: (serializedBody: string) => string;

  /**
   * Optional production normalization boundary. It is invoked exactly once,
   * before either serializer is attempted. The default is the existing
   * save-path normalization used by Butter Editor.
   */
  readonly normalizeDoc?: (doc: PMNode) => PMNode;
}

export interface SavePreflightRuntime {
  readonly serializeCanonical: (
    doc: PMNode,
    options?: CanonicalFormOptions,
  ) => string;
  readonly serializeSourcePreserving: (
    doc: PMNode,
    originalBody: string,
    originalDoc: PMNode,
    options?: CanonicalFormOptions,
  ) => string;
  readonly parseBody: (body: string) => PMNode | null;
  readonly semanticFingerprint: (doc: PMNode) => string;
}

export interface SavePreflightPassedAttempt {
  readonly ok: true;
  readonly path: SaveCandidatePath;
  readonly stage: "compare";
  readonly candidate: string;
  readonly reparsedDoc: PMNode;
  readonly expectedFingerprint: string;
  readonly actualFingerprint: string;
}

export interface SavePreflightFailedAttempt {
  readonly ok: false;
  readonly path: SaveCandidatePath;
  readonly stage: SavePreflightStage;
  readonly error: string;
  readonly candidate?: string;
  readonly expectedFingerprint?: string;
  readonly actualFingerprint?: string;
}

export type SavePreflightAttempt =
  | SavePreflightPassedAttempt
  | SavePreflightFailedAttempt;

export interface SavePreflightOk {
  readonly ok: true;
  readonly path: SaveCandidatePath;
  readonly candidate: string;
  readonly normalizedDoc: PMNode;
  readonly reparsedDoc: PMNode;
  readonly attempts: readonly SavePreflightAttempt[];
}

export interface SavePreflightBlocked {
  readonly ok: false;
  readonly blocked: true;
  readonly attempts: readonly SavePreflightFailedAttempt[];
}

export type SavePreflightResult = SavePreflightOk | SavePreflightBlocked;

const defaultRuntime: SavePreflightRuntime = {
  serializeCanonical(doc, options) {
    return serializer.serialize(doc, options);
  },
  serializeSourcePreserving(doc, originalBody, originalDoc, options) {
    return serializer.serializeWithSourcePreservation(
      doc,
      originalBody,
      originalDoc,
      options,
    );
  },
  parseBody(body) {
    return parser.parseWithSourceMap(body)?.doc ?? null;
  },
  semanticFingerprint: docSemanticFingerprint,
};

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "Error"
      ? error.message
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function freezeAttempts<T extends SavePreflightAttempt>(
  attempts: readonly T[],
): readonly T[] {
  return Object.freeze(attempts.slice());
}

/**
 * Pure, fail-closed save decision boundary.
 *
 * It never writes, mutates view/baseline state, or treats the old body as a
 * successful fallback. A candidate is returned only after that exact finalized
 * string reparses to the exact semantic fingerprint of the once-normalized
 * current document.
 */
export function preflightExactSave(
  input: SavePreflightInput,
  runtimeOverrides: Partial<SavePreflightRuntime> = {},
): SavePreflightResult {
  const runtime: SavePreflightRuntime = {
    ...defaultRuntime,
    ...runtimeOverrides,
  };
  const attempts: SavePreflightAttempt[] = [];
  const paths: SaveCandidatePath[] = [input.primaryPath];
  if (input.fallbackPath && input.fallbackPath !== input.primaryPath) {
    paths.push(input.fallbackPath);
  }

  let normalizedDoc: PMNode;
  try {
    normalizedDoc = (input.normalizeDoc ?? normalizeDocForSave)(input.currentDoc);
  } catch (error) {
    const failure: SavePreflightFailedAttempt = {
      ok: false,
      path: paths[0],
      stage: "normalize",
      error: errorText(error),
    };
    return {
      ok: false,
      blocked: true,
      attempts: freezeAttempts([failure]),
    };
  }

  let expectedFingerprint: string;
  try {
    expectedFingerprint = runtime.semanticFingerprint(normalizedDoc);
  } catch (error) {
    const failure: SavePreflightFailedAttempt = {
      ok: false,
      path: paths[0],
      stage: "fingerprint",
      error: errorText(error),
    };
    return {
      ok: false,
      blocked: true,
      attempts: freezeAttempts([failure]),
    };
  }

  // Options are copied once so neither serializer receives the caller's object.
  const canonicalOptions: CanonicalFormOptions | undefined =
    input.canonicalOptions === undefined
      ? undefined
      : Object.freeze({ ...input.canonicalOptions });

  for (const path of paths) {
    if (path === "source-preserving" && input.originalDoc === null) {
      attempts.push({
        ok: false,
        path,
        stage: "availability",
        error: "source-preserving serialization requires an original document",
        expectedFingerprint,
      });
      continue;
    }

    let serializedBody: string;
    try {
      serializedBody =
        path === "canonical"
          ? runtime.serializeCanonical(normalizedDoc, canonicalOptions)
          : runtime.serializeSourcePreserving(
              normalizedDoc,
              input.originalBody,
              input.originalDoc!,
              canonicalOptions,
            );
    } catch (error) {
      attempts.push({
        ok: false,
        path,
        stage: "serialize",
        error: errorText(error),
        expectedFingerprint,
      });
      continue;
    }

    let candidate: string;
    try {
      candidate = input.finalizeBody(serializedBody);
      if (typeof candidate !== "string") {
        throw new TypeError("save finalizer returned a non-string candidate");
      }
    } catch (error) {
      attempts.push({
        ok: false,
        path,
        stage: "finalize",
        error: errorText(error),
        expectedFingerprint,
      });
      continue;
    }

    let reparsedDoc: PMNode | null;
    try {
      reparsedDoc = runtime.parseBody(candidate);
    } catch (error) {
      attempts.push({
        ok: false,
        path,
        stage: "reparse",
        error: errorText(error),
        candidate,
        expectedFingerprint,
      });
      continue;
    }
    if (reparsedDoc === null) {
      attempts.push({
        ok: false,
        path,
        stage: "reparse",
        error: "reparse returned null",
        candidate,
        expectedFingerprint,
      });
      continue;
    }

    let actualFingerprint: string;
    try {
      actualFingerprint = runtime.semanticFingerprint(reparsedDoc);
    } catch (error) {
      attempts.push({
        ok: false,
        path,
        stage: "compare",
        error: errorText(error),
        candidate,
        expectedFingerprint,
      });
      continue;
    }

    if (actualFingerprint !== expectedFingerprint) {
      attempts.push({
        ok: false,
        path,
        stage: "compare",
        error: "exact semantic fingerprint mismatch",
        candidate,
        expectedFingerprint,
        actualFingerprint,
      });
      continue;
    }

    const passedAttempt: SavePreflightPassedAttempt = {
      ok: true,
      path,
      stage: "compare",
      candidate,
      reparsedDoc,
      expectedFingerprint,
      actualFingerprint,
    };
    attempts.push(passedAttempt);
    return {
      ok: true,
      path,
      candidate,
      normalizedDoc,
      reparsedDoc,
      attempts: freezeAttempts(attempts),
    };
  }

  return {
    ok: false,
    blocked: true,
    attempts: freezeAttempts(
      attempts.filter(
        (attempt): attempt is SavePreflightFailedAttempt => !attempt.ok,
      ),
    ),
  };
}
