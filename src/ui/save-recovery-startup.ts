import { Notice, type App } from "obsidian";
import type { SaveRecoveryStore } from "../integration/save-recovery";
import { tx } from "../i18n";

interface RecoveryStartupHost {
  readonly app: App;
  register(callback: () => void): void;
}

/** Inspect the local journal once at startup; recovery always needs a click. */
export function installStartupSaveRecovery(
  host: RecoveryStartupHost,
  getStore: () => SaveRecoveryStore,
  openRecovery: () => void,
): void {
  let active = true;
  let started = false;
  let notice: Notice | null = null;
  host.register(() => { active = false; notice?.hide(); });
  host.app.workspace.onLayoutReady(() => {
    if (!active || started) return;
    started = true;
    void (async () => {
      let retained = false;
      let unavailable = false;
      try {
        const store = getStore();
        retained = (await store.list()).length > 0;
        unavailable = store.unreadableSlotCount > 0;
      } catch {
        unavailable = true;
      }
      if (!active || (!retained && !unavailable)) return;
      const fragment = createFragment();
      const message = createEl("p");
      message.textContent = unavailable
        ? tx("Butter could not check every recovery snapshot. Open recovery to inspect available copies.")
        : tx("Butter kept unsaved edits from an earlier session. Your original notes are unchanged.");
      fragment.appendChild(message);
      const button = createEl("button");
      button.type = "button";
      button.className = "mod-cta";
      button.textContent = tx("Recover unsaved edits");
      button.addEventListener("click", () => {
        if (!active) return;
        openRecovery();
        notice?.hide();
      });
      fragment.appendChild(button);
      notice = new Notice(fragment, 0);
    })();
  });
}
