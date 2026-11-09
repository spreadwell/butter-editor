import type { TFile } from "obsidian";
import type { EditorView } from "prosemirror-view";
import { editorPositionToSource, planEditorSourceEdit, type EditorSourceHost } from "../core/editor-source-edit";
import { applyEditorSourceTransaction } from "./editor-shim";
import { parser } from "../core/parser";

export interface TaskToggleAPI {
  executeToggleTaskDoneCommand(line: string, path: string): string;
}

/** Optional Tasks public API. The transformation owns no writer or history;
 * installation uses the same exact-source operation as other Editor plugins.
 * null means no integration applies; true also covers a visible atomic refusal. */
export function toggleTaskWithAPI(
  view: EditorView, position: number, host: EditorSourceHost,
  getFile: () => TFile | null, getProvider: () => unknown,
  refused: (reason: unknown) => void,
): boolean | null {
  const provider = getProvider();
  if (!provider) return null;
  const item = view.state.doc.nodeAt(position);
  if (item?.type.name !== "list_item" || item.attrs.kind !== "task") return null;
  let installing: EditorView["state"]["doc"] | null = null;
  try {
    if (!view.editable || view.isDestroyed || view.composing || item.firstChild?.type.name !== "paragraph") {
      throw new Error("Task editor unavailable");
    }
    const file = getFile(), path = file?.path, snapshot = host.snapshot(), api = (provider as { apiV1?: TaskToggleAPI }).apiV1;
    if (!file || typeof api?.executeToggleTaskDoneCommand !== "function") throw new Error("Tasks API unavailable");
    const certify = (doc: EditorView["state"]["doc"]) => host.certify(doc);
    const cursor = editorPositionToSource(view.state, snapshot, position + 2, certify);
    const start = snapshot.text.lastIndexOf("\n", cursor - 1) + 1;
    const newline = snapshot.text.indexOf("\n", cursor);
    let end = newline < 0 ? snapshot.text.length : newline;
    const replacement = api.executeToggleTaskDoneCommand(snapshot.text.slice(start, end), path!);
    if (typeof replacement !== "string") throw new Error("Tasks returned an unsupported result");
    if (replacement) {
      const parsed = parser.parseWithSourceMap(replacement)?.doc;
      let tasks = 0, incompatible = false;
      parsed?.descendants(node => {
        if (node.type.name !== "list_item") return;
        tasks++;
        if (node.attrs.kind !== "task" || typeof node.attrs.checked !== "boolean") incompatible = true;
      });
      if (!parsed || !tasks || incompatible) throw new Error("Tasks status is not representable by this editor");
    }
    // Native Tasks removes the line ending for an empty non-final result.
    if (!replacement && newline >= 0) end++;
    if (getProvider() !== provider || getFile() !== file || file.path !== path || snapshot.doc !== view.state.doc ||
      host.snapshot().text !== snapshot.text) throw new Error("Task target changed");
    const tr = planEditorSourceEdit(view.state, snapshot, start, end, replacement, certify);
    if (tr) {
      if (view.state.doc !== snapshot.doc) throw new Error("Task target changed");
      installing = view.state.doc;
      applyEditorSourceTransaction(view, snapshot, tr, host);
    }
  } catch (error) {
    // A view listener can throw after updateState committed the valid edit.
    // Do not falsely tell the user that their task was left unchanged.
    if (installing && view.state.doc !== installing) console.error("[butter-editor] Task editor listener failed after state changed:", error);
    else refused(error);
  }
  return true;
}
