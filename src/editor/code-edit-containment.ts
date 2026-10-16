import { Plugin } from "prosemirror-state";
import type { EditorView, ViewMutationRecord } from "prosemirror-view";

export const CODE_EDITING_ATTRIBUTE = "data-butter-code-editing";

interface CodeEditRegistration {
  view: EditorView;
  shell: HTMLElement;
  isActive: () => boolean;
  owners: HTMLElement[];
}

interface ContainmentClaim {
  token: symbol;
  previousValue: string | null;
}

interface ContainmentOwner {
  count: number;
  token: symbol;
}

const containmentClaims = new WeakMap<HTMLElement, ContainmentClaim>();
const containmentMutationValues = new WeakMap<HTMLElement, string | null>();

/** Only this presentation attribute on a claimed outer wrapper is not content. */
export function isCodeEditContainmentMutation(
  mutation: ViewMutationRecord,
  dom: Node,
): boolean {
  if (mutation.type !== "attributes" || mutation.target !== dom ||
      mutation.attributeName !== CODE_EDITING_ATTRIBUTE) return false;
  const element = dom as HTMLElement;
  return containmentMutationValues.has(element) &&
    element.getAttribute(CODE_EDITING_ATTRIBUTE) === containmentMutationValues.get(element);
}

/** Edit-mode code needs its top-level block outside paint containment and its
 * callout ancestors open for floating controls. Track exact NodeViews, rather
 * than scanning renderer output or changing the doc. */
export class CodeEditContainment {
  private readonly registrations = new Map<symbol, CodeEditRegistration>();
  private owners = new Map<HTMLElement, ContainmentOwner>();
  private view: EditorView | null = null;
  private binding: symbol | null = null;
  private stopped = false;
  private refreshing = false;
  private refreshAgain = false;

  register(view: EditorView, shell: HTMLElement, isActive: () => boolean): () => void {
    if (this.stopped || (this.view && this.view !== view)) return () => {};
    const token = Symbol("code-edit-node-view");
    // A constructor has no final DOM parent yet. One post-update refresh owns
    // the complete PM reconciliation, including bulk insertion/replacement.
    this.registrations.set(token, { view, shell, isActive, owners: [] });
    if (this.refreshing) this.refreshAgain = true;
    return () => {
      const registration = this.registrations.get(token);
      if (!registration) return;
      this.registrations.delete(token);
      if (this.refreshing) {
        this.refreshAgain = true;
        return;
      }
      // Capture each count record before an attribute write can cause a new
      // binding/reconciliation. That newer owner has already excluded us.
      const owners = registration.owners.map(owner => ({ owner, owned: this.owners.get(owner) }));
      for (const { owner, owned } of owners) {
        if (!owned || this.owners.get(owner) !== owned) continue;
        if (owned.count > 1) owned.count--;
        else {
          this.owners.delete(owner);
          this.releaseOwner(owner, owned.token);
        }
      }
    };
  }

  /** Ensure an initial binding after construction. A plugin binding has
   * already reconciled the DOM, so this must not replace its lease or rescan. */
  attach(view: EditorView): void {
    if (this.stopped || (this.view && this.view !== view) || this.binding) return;
    this.view = view;
    this.binding = Symbol("code-edit-binding");
    this.refresh();
  }

  /** Plugin views are recreated by reconfiguration even when the editor and
   * its NodeViews survive. Each binding owns only its temporary presentation. */
  bind(view: EditorView): () => void {
    if (this.stopped || (this.view && this.view !== view)) return () => {};
    this.view = view;
    const binding = Symbol("code-edit-binding");
    this.binding = binding;
    this.refresh(view);
    return () => {
      if (this.binding !== binding) return;
      this.binding = null;
      this.clearOwners();
    };
  }

  refresh(view: EditorView | null = this.view): void {
    if (this.stopped || !view || view !== this.view || !this.binding) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const binding: symbol | null = this.binding;
        if (!binding) return;
        const next = new Map<HTMLElement, number>();
        if (!view.isDestroyed) {
          for (const [token, registration] of Array.from(this.registrations)) {
            if (registration.view !== view) continue;
            let active = false;
            try { active = registration.isActive(); } catch { /* retired registration */ }
            if (this.stopped || this.registrations.get(token) !== registration) continue;
            const owners = active ? this.paintOwners(registration.shell, view.dom) : [];
            registration.owners = owners;
            for (const owner of owners) next.set(owner, (next.get(owner) ?? 0) + 1);
          }
        }
        if (this.stopped) return;
        if (this.binding !== binding) {
          this.refreshAgain = true;
          continue;
        }
        for (const [owner, owned] of this.owners) {
          if (!next.has(owner)) this.releaseOwner(owner, owned.token);
        }
        if (this.stopped) return;
        if (this.binding !== binding) {
          this.refreshAgain = true;
          continue;
        }
        this.owners = new Map();
        for (const [owner, count] of next) this.owners.set(owner, { count, token: binding });
        for (const owner of next.keys()) {
          if (this.stopped) return;
          if (this.binding !== binding) {
            this.refreshAgain = true;
            break;
          }
          const previous = containmentClaims.get(owner);
          if (previous?.token !== binding) {
            containmentClaims.set(owner, {
              token: binding,
              previousValue: previous ? previous.previousValue : owner.getAttribute(CODE_EDITING_ATTRIBUTE),
            });
          }
          if (owner.getAttribute(CODE_EDITING_ATTRIBUTE) !== "true") {
            containmentMutationValues.set(owner, "true");
            owner.setAttribute(CODE_EDITING_ATTRIBUTE, "true");
          }
        }
      } while (this.refreshAgain && !this.stopped);
    } finally {
      this.refreshing = false;
    }
  }

  private paintOwners(shell: HTMLElement, root: HTMLElement): HTMLElement[] {
    if (shell === root || shell.ownerDocument !== root.ownerDocument) return [];
    const owners = new Set<HTMLElement>();
    let owner = shell;
    while (true) {
      if (owner !== shell && owner.classList.contains("butter-callout-view")) owners.add(owner);
      const parent = owner.parentElement;
      if (parent === root) {
        owners.add(owner);
        return Array.from(owners);
      }
      // Reject the whole path if it belongs to a detached/foreign editor.
      if (!parent || parent.classList.contains("ProseMirror")) return [];
      owner = parent;
    }
  }

  private releaseOwner(owner: HTMLElement, token: symbol): void {
    const claim = containmentClaims.get(owner);
    if (claim?.token !== token) return;
    containmentClaims.delete(owner);
    // A newer external value is not this registry's write to undo.
    if (owner.getAttribute(CODE_EDITING_ATTRIBUTE) !== "true") return;
    if (claim.previousValue === "true") return;
    containmentMutationValues.set(owner, claim.previousValue);
    if (claim.previousValue === null) owner.removeAttribute(CODE_EDITING_ATTRIBUTE);
    else owner.setAttribute(CODE_EDITING_ATTRIBUTE, claim.previousValue);
  }

  private clearOwners(): void {
    const owners = this.owners;
    this.owners = new Map();
    for (const registration of this.registrations.values()) registration.owners = [];
    for (const [owner, owned] of owners) this.releaseOwner(owner, owned.token);
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.binding = null;
    this.view = null;
    this.registrations.clear();
    this.clearOwners();
  }
}

/** ProseMirror calls plugin updates after it reconciles/reparents NodeViews. */
export function codeEditContainmentPlugin(registry: CodeEditContainment): Plugin {
  return new Plugin({
    view(view) {
      const detach = registry.bind(view);
      return {
        update(view) { registry.refresh(view); },
        destroy: detach,
      };
    },
  });
}
