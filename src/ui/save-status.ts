/**
 * Status-bar save indicator.
 *
 * Save outcomes are shown as icons:
 *   - clean: subtle `check` icon. The last save round-tripped cleanly
 *     through the structural fingerprint guard. Default state.
 *   - blocked: `triangle-alert` icon; click opens recovery actions.
 *   - normalized: retained legacy reporting state; click opens its diff.
 *
 * Any unresolved blocked editor session takes precedence over clean saves
 * from other panes. Reports bind their session and captured edit generation.
 */

import type { Plugin } from "obsidian";
import { setIcon } from "obsidian";
import { tx } from "../i18n";

export type SaveState =
  | { kind: "clean" }
  | {
      kind: "blocked";
      reason: string;
    }
  | {
      kind: "normalized";
      original: string;
      saved: string;
      reason: string;
    };

/** Scalar ownership only: neither document content nor view objects. */
export interface SaveStatusOwner {
  readonly id: string;
  readonly generation: number;
}

export class SaveStatusSessions {
  private blocked = new Map<string, { generation: number; state: Extract<SaveState, { kind: "blocked" }> }>();
  private latest: SaveState = { kind: "clean" };

  report(state: SaveState, owner?: SaveStatusOwner): SaveState {
    if (owner) {
      const previous = this.blocked.get(owner.id);
      if (state.kind === "blocked") {
        if (!previous || previous.generation <= owner.generation) {
          this.blocked.delete(owner.id);
          this.blocked.set(owner.id, { generation: owner.generation, state });
        }
      } else if (previous && previous.generation <= owner.generation) {
        this.blocked.delete(owner.id);
      }
    }
    if (!owner || state.kind !== "blocked") this.latest = state;
    return this.get();
  }

  resolveRetained(owner: SaveStatusOwner): SaveState {
    const previous = this.blocked.get(owner.id);
    if (previous && previous.generation <= owner.generation) this.blocked.delete(owner.id);
    return this.get();
  }

  get(): SaveState {
    // Most recently reported unresolved failure remains the visible action;
    // that action opens the journal containing all retained sessions.
    const pending = [...this.blocked.values()];
    return pending[pending.length - 1]?.state ?? this.latest;
  }
}

export interface SaveStatusController {
  set(state: SaveState): void;
  get(): SaveState;
  destroy(): void;
}

export function installSaveStatus(
  plugin: Plugin,
  onClickNormalized: (state: Extract<SaveState, { kind: "normalized" }>) => void,
  onClickBlocked?: (state: Extract<SaveState, { kind: "blocked" }>) => void,
): SaveStatusController {
  const el = plugin.addStatusBarItem();
  el.addClass("butter-status-save");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  // Save-state changes are status-bar updates - polite live region so
  // screen readers announce them (clean → normalized → clean) without
  // interrupting the user's current focus.
  el.setAttribute("aria-live", "polite");

  let state: SaveState = { kind: "clean" };

  const render = () => {
    el.empty();
    el.setAttribute("tabindex", state.kind === "clean" ? "-1" : "0");
    el.setAttribute("aria-disabled", state.kind === "clean" ? "true" : "false");
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
        state.kind === "blocked"
          ? tx("Butter - save blocked (click to recover unsaved edits)")
          : "Butter - saved with structural normalization (click for details)",
      );
    }
  };

  const activate = () => {
    if (state.kind === "normalized") onClickNormalized(state);
    else if (state.kind === "blocked") onClickBlocked?.(state);
  };
  el.addEventListener("click", activate);
  el.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
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
