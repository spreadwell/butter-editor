import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceAroundStep, ReplaceStep } from "prosemirror-transform";
import { isHistoryTransaction } from "prosemirror-history";
import { prepareNativeBlockIdConservation } from "./native-block-id-conservation";

const key = new PluginKey("butter-structural-save-admission");
type AdmissionCheck = (tr: Transaction, state: EditorState, notify: boolean) => boolean;
type StructuralRefusal = "heading" | "code" | "structure";
const checks = new WeakMap<Plugin, AdmissionCheck>();
type DeclaredCodeCheck = (tr: Transaction, state: EditorState, notify: boolean) => boolean;
const codeChecks = new WeakMap<Plugin, DeclaredCodeCheck>();
const codeRefusals = new WeakMap<Plugin, () => void>();

function isOpaqueLineFeed(node: PMNode): boolean {
  if (node.isText) return Boolean(node.text?.includes("\n") && node.marks.some(mark =>
    mark.type.name === "code" || mark.type.name === "comment"));
  if (node.type.name === "inline_math") return Boolean((node.attrs.value as string | undefined)?.includes("\n"));
  if (node.type.name === "inline_footnote") return Boolean((node.attrs.content as string | undefined)?.includes("\n"));
  return false;
}

function hasOpaqueLineFeed(heading: PMNode): boolean {
  if (heading.type.name !== "heading") return false;
  let found = false;
  heading.forEach(node => { if (isOpaqueLineFeed(node)) found = true; });
  return found;
}

/** Only structural changes can move a previously valid opaque inline payload
 * into a heading representation that cannot encode its exact line feeds.
 * Typing, inline marks, selection and nonstructural ID deletion do no scan. */
function unclosedComment(node: PMNode | null | undefined): boolean {
  return node?.type.name === "block_comment" && node.attrs.nativeSyntax === "html-unclosed";
}

/** An unclosed authored HTML comment owns the rest of its Markdown container.
 * New siblings after it cannot remain distinct nodes on reopen. Inspect only
 * siblings at affected boundaries; ordinary inline typing never walks a note. */
function hasUnclosedCommentBoundary(doc: PMNode, pos: number): boolean {
  const resolved = doc.resolve(pos);
  for (let depth = resolved.depth; depth >= 0; depth--) {
    const parent = resolved.node(depth), index = resolved.index(depth);
    if (index < parent.childCount && index + 1 < parent.childCount && unclosedComment(parent.child(index))) return true;
    if (index > 0 && index < parent.childCount && unclosedComment(parent.child(index - 1))) return true;
  }
  return false;
}

function certificationReason(tr: Transaction): "heading" | "structure" | null {
  for (let index = 0; index < tr.steps.length; index++) {
    const step = tr.steps[index];
    if (!(step instanceof ReplaceAroundStep || step instanceof ReplaceStep)) continue;
    if (step instanceof ReplaceStep) {
      let insertsBlock = false, insertsOpaqueLineFeed = false;
      step.slice.content.descendants(node => {
        if (node.isBlock) insertsBlock = true;
        if (isOpaqueLineFeed(node)) insertsOpaqueLineFeed = true;
      });
      const before = tr.docs[index];
      const $from = before.resolve(step.from), $to = before.resolve(step.to);
      if (!insertsBlock && $from.sameParent($to) && $from.parent.inlineContent &&
        !(insertsOpaqueLineFeed && $from.parent.type.name === "heading")) continue;
    }
    let reason: "heading" | "structure" | null = null;
    const later = tr.mapping.slice(index + 1);
    step.getMap().forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      if (reason) return;
      const from = Math.max(0, Math.min(tr.doc.content.size, later.map(newFrom, -1)));
      const to = Math.max(from, Math.min(tr.doc.content.size, later.map(newTo, 1)));
      // A join may have a zero-width changed range inside the resulting
      // heading; ancestor inspection also covers that structural seam.
      for (const pos of [from, to]) {
        if (hasUnclosedCommentBoundary(tr.doc, pos)) reason = "structure";
        const resolved = tr.doc.resolve(pos);
        for (let depth = resolved.depth; depth > 0; depth--) {
          if (!reason && hasOpaqueLineFeed(resolved.node(depth))) reason = "heading";
        }
      }
      if (from < to) tr.doc.nodesBetween(from, to, (node, pos) => {
        if (unclosedComment(node) && hasUnclosedCommentBoundary(tr.doc, pos)) reason = "structure";
        if (!reason && hasOpaqueLineFeed(node)) reason = "heading";
        return !reason;
      });
    });
    if (reason) return reason;
  }
  return null;
}

/** Decline an unrepresentable structural edit before it enters state/history.
 * The owning view supplies its CURRENT shared save policy. Reference repairs
 * are simulated first so certification never judges a transient merged owner.
 * A declined command is still consumed by its UI/keymap; the callback explains
 * why the document remains unchanged. */
export function structuralSaveAdmissionPlugin(
  validate: (preparedDoc: PMNode) => boolean,
  onRejected?: (reason: StructuralRefusal) => void,
): Plugin {
  const check: AdmissionCheck = (tr, state, notify) => {
    if (!tr.docChanged || isHistoryTransaction(tr)) return true;
    const reason = certificationReason(tr);
    if (!reason) return true;
    const plan = prepareNativeBlockIdConservation(state.doc, tr.doc, tr.mapping);
    if (plan && validate(plan.doc)) return true;
    if (notify) onRejected?.(reason);
    return false;
  };
  const plugin = new Plugin({
    key,
    filterTransaction(tr, state) {
      return check(tr, state, true);
    },
  });
  checks.set(plugin, check);
  codeChecks.set(plugin, (tr, state, notify) => {
    const plan = prepareNativeBlockIdConservation(state.doc, tr.doc, tr.mapping);
    if (plan && validate(plan.doc)) return true;
    if (notify) onRejected?.("code");
    return false;
  });
  codeRefusals.set(plugin, () => onRejected?.("code"));
  return plugin;
}

/** Certify an explicitly prepared mutation against the containing view's
 * current production save policy and final native reference plan. */
export function allowsPreparedSaveTransaction(state: EditorState, tr: Transaction, notify = true): boolean {
  const plugin = key.get(state);
  return plugin ? codeChecks.get(plugin)?.(tr, state, notify) ?? true : true;
}

export function allowsDeclaredCodeTransaction(state: EditorState, tr: Transaction, notify = true): boolean {
  return allowsPreparedSaveTransaction(state, tr, notify);
}

export function notifyCodeConversionRefusal(state: EditorState): void {
  const plugin = key.get(state);
  if (plugin) codeRefusals.get(plugin)?.();
}

/** Input rules must decline before dispatch so the native input handler can
 * insert the triggering character literally. A veto after dispatch would
 * consume that character while leaving the attempted formatting unchanged. */
export function allowsStructuralSaveTransaction(state: EditorState, tr: Transaction): boolean {
  const plugin = key.get(state);
  return plugin ? checks.get(plugin)?.(tr, state, true) ?? true : true;
}
