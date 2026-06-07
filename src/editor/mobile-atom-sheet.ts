/**
 * Mobile sheet for inline-atom interactions.
 *
 * Desktop right-click opens a popover (`openRichContextMenu`) that
 * embeds inline edit fields next to action rows. That works well
 * with mouse + keyboard but feels like a "weird floating widget" on
 * touch — small targets, anchored to a tiny atom DOM element,
 * doesn't match Obsidian's mobile chrome.
 *
 * Mobile tap routes through two native Obsidian primitives instead:
 *   1. `Menu` — auto-renders as a slide-up bottom drawer on mobile.
 *      Used for navigation + edit-affordance actions.
 *   2. `Modal` — full-width sheet on mobile, used when the user
 *      picks "Edit…" so we can render the same field form with
 *      touch-friendly inputs and a real save button.
 *
 * Why two surfaces instead of cramming both into one Modal: the
 * drawer-for-actions / modal-for-form split IS the native mobile
 * pattern across Obsidian (file long-press → drawer of actions;
 * "Rename" action → modal with an input + Save). Matching it
 * gives every editor surface the same muscle memory.
 */

import { App, Menu, Modal, setIcon } from "obsidian";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import type { AtomSpec, AtomField } from "./inline-atom-specs";
import { applyVaultFilesSuggest } from "../ui/vault-files-suggest";

/** A single action row in the bottom drawer. The drawer is built
 *  from an array of these so the caller can tailor the action set
 *  per atom type (wikilink has "Open in new tab" etc.; tags have
 *  "Search this tag"; inline math has no nav actions). */
export interface MobileSheetAction {
  /** Display label shown in the drawer row. */
  label: string;
  /** Lucide icon name shown at the row's left. */
  icon: string;
  /** Run when the action is tapped. Receives the current node so
   *  the handler can read attrs without recomputing position. */
  onClick: () => void;
  /** Renders the row in red, used for destructive actions like
   *  "Clear link". */
  warning?: boolean;
  /** Visual divider above this row (separates nav from destructive). */
  separatorBefore?: boolean;
}

export interface OpenMobileAtomDrawerOptions {
  app: App;
  editorView: EditorView;
  pos: number;
  node: PMNode;
  spec: AtomSpec;
  /** The atom DOM element that was tapped. Used to position the
   *  drawer relative to the tap point on desktop; on mobile the
   *  drawer slides up from the bottom regardless of position. */
  anchor: HTMLElement;
  /** Header info shown at the top of the drawer — icon + title +
   *  sub-line (matches the desktop right-click chrome). Rendered
   *  inside .menu-scroll so the native .menu-grabber stays in
   *  place and the mobile drawer styling stays native. */
  chrome: {
    icon: string;
    title: string;
    sub: string;
  };
  /** Per-atom action list — nav at the top, destructive (warning:
   *  true) at the bottom. The helper inserts "Edit…" between the
   *  nav and destructive groups automatically, so Clear-style
   *  destructive actions always land last. */
  actions: MobileSheetAction[];
}

/** Open the mobile bottom-drawer for an inline atom. Renders a
 *  plain Obsidian `Menu` with zero chrome customization — that's
 *  the trick. Obsidian's native mobile CSS keys off the standard
 *  menu DOM (`.menu`, `.menu-grabber`, `.menu-scroll`,
 *  `.menu-group`, `.menu-item.tappable`); the moment you add a
 *  custom class or inject a non-standard header div, you lose the
 *  slide-up drawer styling and get a desktop-style floating
 *  popover positioned at the bottom of the screen. So: no custom
 *  classes, no header injection, just native items via `addItem`.
 *
 *  Group actions via `data-section` (the same way Obsidian's own
 *  menus organize nav / edit / destructive sections — visible as
 *  subtle dividers in both desktop and mobile chrome). */
export function openMobileAtomDrawer(opts: OpenMobileAtomDrawerOptions): void {
  const menu = new Menu();

  // Split actions into nav (non-destructive) and danger (warning:
  // true). Edit always lands between them so the destructive items
  // are the LAST things in the drawer.
  const navActions = opts.actions.filter((a) => !a.warning);
  const dangerActions = opts.actions.filter((a) => a.warning);

  const addAction = (action: MobileSheetAction, section: string) => {
    menu.addItem((item) => {
      item.setTitle(action.label);
      item.setIcon(action.icon);
      if (action.warning) {
        (item as unknown as { setWarning?: (w: boolean) => unknown })
          .setWarning?.(true);
      }
      (item as unknown as { setSection?: (s: string) => unknown })
        .setSection?.(section);
      item.onClick(() => action.onClick());
    });
  };

  for (const a of navActions) addAction(a, "nav");

  menu.addItem((item) => {
    item.setTitle("Edit…");
    item.setIcon("pencil");
    (item as unknown as { setSection?: (s: string) => unknown })
      .setSection?.("edit");
    item.onClick(() => {
      new MobileAtomEditModal(opts).open();
    });
  });

  for (const a of dangerActions) addAction(a, "danger");

  const rect = opts.anchor.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left + rect.width / 2, y: rect.bottom + 4 });

  // Inject the header AFTER show so the menu's internal DOM
  // (.menu-grabber + .menu-scroll) is fully created. Placing the
  // header INSIDE .menu-scroll (above the items) keeps the native
  // .menu-grabber at the very top — required for the mobile
  // slide-up affordance.
  injectDrawerHeader(menu, opts.chrome);
}

function injectDrawerHeader(
  menu: Menu,
  chrome: { icon: string; title: string; sub: string },
): void {
  const menuAny = menu as unknown as { dom?: HTMLElement };
  const root = menuAny.dom;
  if (!root) return;
  // Find the .menu-scroll container. If it doesn't exist (older
  // Obsidian builds), fall back to the menu root just after the
  // grabber.
  const scroll = root.querySelector<HTMLElement>(".menu-scroll");
  const parent = scroll ?? root;
  const firstChild = parent.firstChild;

  const header = parent.createDiv({
    cls: "butter-mobile-drawer-header",
  });
  // Insert at the TOP of the scroll container (or below grabber
  // when falling back to root).
  if (firstChild && firstChild !== header) {
    parent.insertBefore(header, firstChild);
  }
  const iconEl = header.createDiv({
    cls: "butter-mobile-drawer-header-icon",
  });
  setIcon(iconEl, chrome.icon);
  const text = header.createDiv({
    cls: "butter-mobile-drawer-header-text",
  });
  text.createDiv({
    cls: "butter-mobile-drawer-header-title",
    text: chrome.title,
  });
  if (chrome.sub) {
    text.createDiv({
      cls: "butter-mobile-drawer-header-sub",
      text: chrome.sub,
    });
  }
}

/** Form-based edit modal for an inline atom. Renders one labeled
 *  input per field from the atom's spec, with Save / Cancel
 *  buttons. Save commits a `replaceWith` transaction on the live
 *  node (re-resolving by position so a stale reference after
 *  another transaction is handled gracefully). */
export class MobileAtomEditModal extends Modal {
  private inputs: Record<string, HTMLInputElement> = {};
  private opts: OpenMobileAtomDrawerOptions;

  constructor(opts: OpenMobileAtomDrawerOptions) {
    super(opts.app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    const { spec, node } = this.opts;
    if (!spec.fields || !spec.toFields || !spec.fromFields) {
      // No field schema means no editable form — bail with a
      // helpful message so the user understands.
      titleEl.setText(spec.label);
      contentEl.createEl("p", {
        text: "This element has no editable fields.",
      });
      this.addCloseButton(contentEl);
      return;
    }
    titleEl.setText(`Edit ${spec.label.toLowerCase()}`);
    const initial = spec.toFields(node);

    const form = contentEl.createDiv({ cls: "butter-mobile-edit-form" });
    for (const field of spec.fields) {
      this.renderField(form, field, initial[field.name] ?? "");
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = btnRow.createEl("button", {
      text: "Save",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", () => this.commit());

    // Focus the first field so users on mobile can start typing
    // immediately without an extra tap.
    const firstId = spec.fields[0]?.name;
    if (firstId) window.setTimeout(() => this.inputs[firstId]?.focus(), 0);
  }

  private renderField(
    parent: HTMLElement,
    field: AtomField,
    value: string,
  ): void {
    const fieldEl = parent.createDiv({ cls: "butter-mobile-edit-field" });
    fieldEl.createDiv({
      cls: "butter-mobile-edit-field-label",
      text: field.label,
    });
    const input = fieldEl.createEl("input", {
      cls: "butter-mobile-edit-input",
      attr: {
        type: "text",
        placeholder:
          typeof field.placeholder === "function"
            ? field.placeholder({ [field.name]: value })
            : (field.placeholder ?? ""),
      },
    });
    input.value = value;
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.commit();
      }
    });
    // Wire up the same vault-files suggester the desktop popover
    // uses (Obsidian's native AbstractInputSuggest popup with fuzzy
    // match + folder paths). Users get a searchable list of every
    // markdown file as they type, no need to remember exact names.
    if (field.autocomplete === "vault-files") {
      applyVaultFilesSuggest(this.opts.app, input, {
        onSelect: (file) => {
          input.value = file.basename;
          // Fire input so any dependent placeholder updates (alias
          // field defaults to target's value, etc).
          input.dispatchEvent(new Event("input"));
          input.focus();
        },
      });
    }
    this.inputs[field.name] = input;
  }

  private addCloseButton(parent: HTMLElement): void {
    const btnRow = parent.createDiv({ cls: "modal-button-container" });
    const btn = btnRow.createEl("button", { text: "Close", cls: "mod-cta" });
    btn.addEventListener("click", () => this.close());
  }

  private commit(): void {
    const { spec, editorView, pos, node } = this.opts;
    if (!spec.fromFields) {
      this.close();
      return;
    }
    const values: Record<string, string> = {};
    for (const [k, input] of Object.entries(this.inputs)) {
      values[k] = input.value;
    }
    const next = spec.fromFields(values, editorView.state.schema);
    if (!next) {
      // Parse failed — flash the inputs red briefly so the user
      // knows the input wasn't accepted, but keep the modal open
      // so they can fix it.
      this.flashError();
      return;
    }
    const live = editorView.state.doc.nodeAt(pos);
    if (!live || live.type.name !== spec.typeName) {
      // Node moved or was deleted while the modal was open —
      // nothing safe to commit against.
      this.close();
      return;
    }
    const tr = editorView.state.tr.replaceWith(pos, pos + live.nodeSize, next);
    editorView.dispatch(tr);
    editorView.focus();
    this.close();
    // Suppress the implicit dep so the linter doesn't grumble about
    // `node` being unused — it's captured for the type-name check
    // above via `live.type.name !== spec.typeName`.
    void node;
  }

  private flashError(): void {
    for (const input of Object.values(this.inputs)) {
      input.addClass("butter-mobile-edit-input-error");
      window.setTimeout(
        () => input.removeClass("butter-mobile-edit-input-error"),
        400,
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

