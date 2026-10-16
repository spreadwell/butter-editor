import { Notice } from "obsidian";
import { tx } from "../i18n";
import type { SaveStatusOwner } from "./save-status";

/** Session-only UI bookkeeping. It never admits, retries, or awaits a save. */
export class SaveFailureNotices {
  private incidents = new Map<string, { generation: number; resolved: boolean }>();
  private visible: { id: string; notice: Notice } | null = null;

  constructor(private recover: () => void, private report: () => void) {}

  blocked(owner: SaveStatusOwner): void {
    const previous = this.incidents.get(owner.id);
    if (previous) {
      if (previous.resolved && owner.generation < previous.generation) return;
      if (!previous.resolved) {
        previous.generation = Math.max(previous.generation, owner.generation);
        return;
      }
    }
    const fragment = createFragment();
    const content = fragment.createDiv({ cls: "butter-save-failure-notice" });
    content.createEl("strong", { text: tx("Butter could not save this note") });
    content.createEl("p", { text: tx("Keep this note open. Use Recover unsaved edits to inspect available copies, or copy your unsaved work somewhere safe.") });
    content.createEl("p", {
      cls: "butter-save-failure-report-hint",
      text: tx("Report anonymously to help improve saving. Nothing is sent until you submit."),
    });
    const actions = content.createDiv({ cls: "butter-save-failure-actions" });
    let notice: Notice;
    const action = (text: string, callback: () => void, primary = false) => {
      const button = actions.createEl("button", { text, attr: { type: "button" } });
      if (primary) button.addClass("mod-cta");
      button.addEventListener("click", event => {
        event.stopPropagation();
        if (this.visible?.notice === notice) this.hide();
        callback();
      });
    };
    action(tx("Recover unsaved edits"), this.recover);
    action(tx("Report anonymously"), this.report, true);
    action(tx("Close"), () => {});
    // Persistent, dismissible, and never focused: recovery stays within reach.
    notice = new Notice(fragment, 0);
    this.hide();
    this.visible = { id: owner.id, notice };
    // Only a successfully rendered prompt marks the incident as shown.
    this.incidents.delete(owner.id);
    this.incidents.set(owner.id, { generation: owner.generation, resolved: false });
    // Avoid retaining an unlimited number of closed editor identities.
    if (this.incidents.size > 100) this.incidents.delete(this.incidents.keys().next().value!);
  }

  saved(owner: SaveStatusOwner): void {
    const previous = this.incidents.get(owner.id);
    if (!previous || previous.generation > owner.generation) return;
    previous.generation = owner.generation;
    previous.resolved = true;
    if (this.visible?.id === owner.id) this.hide();
  }

  private hide(): void {
    this.visible?.notice.hide();
    this.visible = null;
  }

  dispose(): void {
    this.hide();
    this.incidents.clear();
  }
}
