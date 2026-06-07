/**
 * Status-bar save indicator.
 *
 * Two visual states (icon-only, no labels):
 *   - clean: subtle `check` icon. The last save round-tripped cleanly
 *     through the structural fingerprint guard. Default state.
 *   - normalized: `triangle-alert` icon, warning color. The last save
 *     produced output that doesn't re-parse to the same structural
 *     fingerprint as the in-memory PM doc. Click → opens the diff
 *     modal so the user can see what changed.
 *
 * The indicator reflects the ACTIVE view's last save. Switching to
 * a different file rolls the state to whatever that file's view
 * reports (clean by default until a save fires).
 */

import type { Plugin } from "obsidian";
import { setIcon } from "obsidian";

export type SaveState =
  | { kind: "clean" }
  | {
      kind: "normalized";
      original: string;
      saved: string;
      reason: string;
    };

export interface SaveStatusController {
  set(state: SaveState): void;
  get(): SaveState;
  destroy(): void;
}

export function installSaveStatus(
  plugin: Plugin,
  onClickNormalized: (state: Extract<SaveState, { kind: "normalized" }>) => void,
): SaveStatusController {
  const el = plugin.addStatusBarItem();
  el.addClass("butter-status-save");
  el.setAttribute("role", "button");
  // Save-state changes are status-bar updates - polite live region so
  // screen readers announce them (clean → normalized → clean) without
  // interrupting the user's current focus.
  el.setAttribute("aria-live", "polite");

  let state: SaveState = { kind: "clean" };

  const render = () => {
    el.empty();
    el.removeClass("butter-status-save-clean");
    el.removeClass("butter-status-save-normalized");
    if (state.kind === "clean") {
      el.addClass("butter-status-save-clean");
      setIcon(el, "check");
      el.setAttribute("aria-label", "Butter - saved");
    } else {
      el.addClass("butter-status-save-normalized");
      setIcon(el, "triangle-alert");
      el.setAttribute(
        "aria-label",
        "Butter - saved with structural normalization (click for details)",
      );
    }
  };

  el.addEventListener("click", () => {
    if (state.kind === "normalized") onClickNormalized(state);
  });

  render();

  return {
    set(next) {
      state = next;
      render();
    },
    get() {
      return state;
    },
    destroy() {
      el.detach();
    },
  };
}
