/**
 * Tell the workspace that the note in a tab is gone once its view has closed.
 *
 * Obsidian's own file views finish closing by unloading their file, and that
 * unload is what asks the workspace to announce the active leaf again
 * (`active-leaf-change`, then `file-open` when the active file changed). A
 * view that closes without it is only missed when the tab outlives the view:
 * the note is closed into an empty tab, or deleted while open. The status
 * bar, the sidebar panes and every plugin listening for `file-open` then go
 * on showing a note that is no longer open, and opening that same note again
 * announces nothing, because the workspace still believes it is the open one.
 *
 * The request is debounced by Obsidian, so it is answered after the tab has
 * its next view, and a view that announces for itself folds into the same one.
 */
import type { Constructor, View, Workspace } from "obsidian";

type AnnouncingWorkspace = Workspace & { requestActiveLeafEvents?: () => void };

export function announceClosedView<T extends View>(
  workspace: AnnouncingWorkspace | null | undefined,
  view: T,
  type: Constructor<T>,
): void {
  if (typeof workspace?.getActiveViewOfType !== "function") return;
  // Another tab's note is still the open one; nothing has changed for it.
  if (workspace.getActiveViewOfType(type) !== view) return;
  if (typeof workspace.requestActiveLeafEvents !== "function") return;
  workspace.requestActiveLeafEvents();
}
