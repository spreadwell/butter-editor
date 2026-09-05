/**
 * Unified rich context menu for link UIs - used by:
 *   • Right-click on a wikilink
 *   • Right-click on an external link
 *   • Toolbar "Add link" button
 *
 * Visually identical to Butter's block context menu (same chrome
 * class, same header structure, same action-row styling) so all link
 * surfaces feel like the same thing as the right-click-on-a-block
 * menu. Different from a plain Obsidian `Menu` because it embeds
 * inputs above the action rows - Obsidian's `Menu` only supports
 * clickable items, so this popover is hand-rolled DOM that matches
 * the menu look via shared CSS classes.
 *
 * Behavior:
 *   • Enter on any input → run `onCommit(values)` then close.
 *   • Esc on any input  → run `onCancel()` then close.
 *   • Click outside the popover → run `onCancel()` then close.
 *   • Click a primary action row → optionally call `onCommit` (if
 *     `commitsBeforeAction` is set on the action) then run the
 *     action's onClick(values) then close.
 *
 * The popover is appended to `parentEl` (typically the editor's
 * parent so it sits above the edit surface) and absolutely
 * positioned. Position is auto-flipped if it would overflow the
 * viewport's right or bottom edge.
 */

import { App, setIcon } from "obsidian";
import { applyVaultFilesSuggest } from "./vault-files-suggest";
import type { VaultFileSuggestionScope } from "./vault-file-scope";
import {
  buildBlockContextMenuHeaderEl,
  type BlockMenuChrome,
} from "../editor/block-menu-spec";
import { txKnown } from "../i18n";
import { attachSurfaceMotion, dismissSurfaceWithMotion } from "./surface-motion";

export interface RichMenuField {
  /** Stable id used by callers to read the value. */
  id: string;
  /** Bold label rendered above the input row. */
  label: string;
  /** Optional Lucide icon shown left of the input. */
  icon?: string;
  initial?: string;
  placeholder?: string;
  /** When set, attach the vault-files suggester (Obsidian native
   *  AbstractInputSuggest popup with fuzzy match + folder paths). */
  autocomplete?: "vault-files";
  /** Narrow a vault-file field to the type it can actually consume. */
  suggestScope?: VaultFileSuggestionScope;
  /** Predicate paired with `autocomplete: "vault-files"`. When it
   *  returns true for the current raw input value, the dropdown is
   *  suppressed - used by the toolbar's Add Link field, which serves
   *  dual-purpose (URL or note name) and shouldn't suggest notes when
   *  the user is typing a URL. */
  suggestSkipWhen?: (raw: string) => boolean;
  /** Open vault suggestions even before the user types. */
  suggestOnEmpty?: boolean;
  /** Optional handler invoked when a vault-files suggestion is
   *  picked. Defaults to writing the file's basename into THIS
   *  input. Override when the pick should also fill OTHER fields
   *  (e.g. wikilink: pick "MyNote.md" → write basename to target,
   *  leave alias untouched). The handler receives the input element
   *  ref so it can `setValue(...)` if the default isn't right. */
  onSuggestSelect?: (
    file: { basename: string; path: string },
    input: HTMLInputElement,
  ) => void;
}

export interface RichMenuAction {
  /** Stable id (used for warning state, optional). */
  id?: string;
  label: string;
  icon: string;
  /** Render in red - used for "Clear link" / destructive ops. */
  warning?: boolean;
  /** Render with a divider above this item. */
  separatorBefore?: boolean;
  /** When true, action onClick receives the LIVE input values (so
   *  e.g. clicking "Open in new tab" can navigate to the user's
   *  edited target rather than the original). Defaults to true. */
  receivesValues?: boolean;
  /** Limit this row to selected rich-menu modes. */
  modes?: string[];
  /** Keep context-specific actions out of the menu until they apply. */
  visibleWhen?: (values: Readonly<Record<string, string>>) => boolean;
  /** Return false to reject the action and keep the editor open. */
  onClick: (
    values: Record<string, string>,
  ) => void | boolean | Promise<void | boolean>;
}

export interface RichMenuModeSwitch {
  value: string;
  options: Array<{ value: string; label: string; icon: string }>;
  onChange?: (
    value: string,
    inputs: Readonly<Record<string, HTMLInputElement>>,
    source: "user" | "inferred",
  ) => void;
  /** Infer a more suitable mode while the user types, unless the caller has locked a deliberate choice. */
  inferValue?: (values: Readonly<Record<string, string>>) => string | null;
}

export interface RichMenuOptions {
  app: App;
  /** Anchor element the menu attaches to. Used to position the
   *  popover near the originating click and to look up the parent
   *  container. Caller normally passes the inline atom DOM or the
   *  toolbar button. */
  anchor: HTMLElement;
  /** Mouse event for positional anchoring; if omitted falls back to
   *  the anchor element's bounding box. */
  event?: MouseEvent;
  chrome: BlockMenuChrome;
  /** Optional segmented mode switch rendered above the fields. */
  modeSwitch?: RichMenuModeSwitch;
  fields?: RichMenuField[];
  actions: RichMenuAction[];
  /** Run when the user commits via Enter. Receives the current input
   *  values keyed by field id. */
  /** Return false to reject the values and leave the editor open. */
  onCommit?: (values: Record<string, string>) => void | boolean;
  /** Run when the user dismisses without committing (Esc, click
   *  outside). */
  onCancel?: () => void;
  /** Move keyboard focus to the first field on open. Defaults to
   *  `true` (sensible for "create a new thing" surfaces like the
   *  toolbar's Add Link button). Set `false` for right-click context
   *  menus on existing items - the user expected to navigate the
   *  menu's actions, not start typing into a field. */
  autoFocusFirstField?: boolean;
  /** Additional class for a specialized rich-menu surface. */
  className?: string;
}

export interface RichMenuHandle {
  close: () => void;
  /** Read the current input values without closing. */
  values: () => Record<string, string>;
}

/**
 * Open the unified link / inline-atom rich context menu. See module
 * docstring for behavior. Returns a handle so the caller can close
 * the popover programmatically (rare - usually it manages its own
 * lifecycle).
 */
export function openRichContextMenu(opts: RichMenuOptions): RichMenuHandle {
  const parent =
    (activeDocument.body) ?? (activeDocument.documentElement);
  const dom = activeWindow.createDiv();
  dom.className = "menu butter-block-context-menu butter-rich-menu";
  attachSurfaceMotion(dom, "popover");
  if (opts.className) dom.addClass(opts.className);
  dom.setAttribute("role", "dialog");
  dom.addClass("butter-pos-fixed");

  // Header sits flush against the menu's outer edges, matching the
  // block context menu's structure (where the header is a child of
  // .menu, not of .menu-scroll). Body content (fields + separator +
  // actions) goes into a wrapper that mirrors Obsidian's .menu-scroll
  // padding so action items line up with the block menu's items
  // exactly.
  dom.appendChild(buildBlockContextMenuHeaderEl(opts.chrome));
  const body = activeWindow.createDiv();
  body.className = "butter-rich-menu-body";
  dom.appendChild(body);

  // Fields
  const inputEls: Record<string, HTMLInputElement> = {};
  const actionEls: Array<{ el: HTMLElement; action: RichMenuAction }> = [];
  const getValues = (): Record<string, string> => {
    const values: Record<string, string> = {};
    for (const id of Object.keys(inputEls)) values[id] = inputEls[id].value;
    return values;
  };
  const refreshActionVisibility = () => {
    const values = getValues();
    for (const { el, action } of actionEls) {
      const modeVisible = !action.modes
        || action.modes.includes(opts.modeSwitch?.value ?? "");
      const contextVisible = !action.visibleWhen || action.visibleWhen(values);
      el.classList.toggle("butter-hidden", !modeVisible || !contextVisible);
    }
  };
  let selectMode: ((
    value: string,
    announce?: boolean,
    source?: "user" | "inferred",
  ) => void) | undefined;
  if (opts.modeSwitch) {
    const switchEl = activeWindow.createDiv({
      cls: "butter-rich-menu-mode-switch butter-toolbar-platform-switcher butter-link-mode-switch",
    });
    switchEl.setAttribute("role", "tablist");
    switchEl.createDiv({
      cls: "butter-toolbar-platform-switcher__indicator",
      attr: { "aria-hidden": "true" },
    });
    const buttons = new Map<string, HTMLButtonElement>();
    selectMode = (
      value: string,
      announce = true,
      source: "user" | "inferred" = "user",
    ) => {
      opts.modeSwitch!.value = value;
      switchEl.dataset.mode = value;
      switchEl.dataset.segment = value === opts.modeSwitch!.options[0]?.value
        ? "desktop"
        : "mobile";
      for (const [candidate, button] of buttons) {
        const selected = candidate === value;
        button.classList.toggle("is-active", selected);
        button.setAttribute("aria-selected", selected ? "true" : "false");
        button.tabIndex = selected ? 0 : -1;
      }
      if (announce) opts.modeSwitch?.onChange?.(value, inputEls, source);
      refreshActionVisibility();
    };
    for (const option of opts.modeSwitch.options) {
      const button = activeWindow.createEl("button", {
        cls: "butter-rich-menu-mode-button butter-toolbar-platform-switcher__btn",
        attr: { type: "button", role: "tab", "aria-label": txKnown(option.label) },
      });
      const icon = button.createSpan({
        cls: "butter-rich-menu-mode-icon butter-toolbar-platform-switcher__icon",
      });
      setIcon(icon, option.icon);
      button.createSpan({
        cls: "butter-toolbar-platform-switcher__label",
        text: txKnown(option.label),
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        selectMode?.(option.value, true, "user");
        inputEls.target?.focus();
      });
      buttons.set(option.value, button);
      switchEl.appendChild(button);
    }
    body.appendChild(switchEl);
    selectMode(opts.modeSwitch.value, false);
  }
  if (opts.fields && opts.fields.length > 0) {
    const fieldsRoot = activeWindow.createDiv();
    fieldsRoot.className = "butter-rich-menu-fields";
    for (const field of opts.fields) {
      // Layout per field:
      //   [icon] [label]   ← header row, icon next to the label
      //   [        input        ]   ← input alone on its own row, full width
      const fieldEl = activeWindow.createDiv();
      fieldEl.className = "butter-rich-menu-field";
      const headerEl = activeWindow.createDiv();
      headerEl.className = "butter-rich-menu-field-header";
      if (field.icon) {
        const iconEl = activeWindow.createDiv();
        iconEl.className = "butter-rich-menu-field-icon";
        setIcon(iconEl, field.icon);
        headerEl.appendChild(iconEl);
      }
      const labelEl = activeWindow.createDiv();
      labelEl.className = "butter-rich-menu-field-label";
    labelEl.textContent = txKnown(field.label);
      headerEl.appendChild(labelEl);
      fieldEl.appendChild(headerEl);
      const input = activeWindow.createEl("input");
      input.type = "text";
      input.className = "butter-inline-atom-edit-input butter-rich-menu-input";
      input.spellcheck = false;
      input.value = field.initial ?? "";
      input.addEventListener("input", () => {
        const inferred = opts.modeSwitch?.inferValue?.(getValues());
        if (inferred && inferred !== opts.modeSwitch?.value) {
          selectMode?.(inferred, true, "inferred");
        } else {
          refreshActionVisibility();
        }
      });
    if (field.placeholder) input.placeholder = txKnown(field.placeholder);
      if (field.autocomplete === "vault-files") {
        applyVaultFilesSuggest(opts.app, input, {
          scope: field.suggestScope,
          skipWhen: field.suggestSkipWhen,
          showOnEmpty: field.suggestOnEmpty,
          onSelect: (file) => {
            if (field.onSuggestSelect) {
              field.onSuggestSelect({
                basename: file.basename,
                path: file.path,
              }, input);
            } else {
              input.value = file.basename;
              // Fire 'input' so dependent fields (placeholders that
              // reference this field's value, etc.) refresh.
              input.dispatchEvent(new Event("input"));
            }
          },
        });
      }
      fieldEl.appendChild(input);
      fieldsRoot.appendChild(fieldEl);
      inputEls[field.id] = input;
    }
    body.appendChild(fieldsRoot);
  }

  const flashInvalid = () => {
    for (const input of Object.values(inputEls)) {
      input.addClass("butter-inline-atom-edit-input-error");
      window.setTimeout(
        () => input.removeClass("butter-inline-atom-edit-input-error"),
        400,
      );
    }
  };

  let closed = false;
  const close = (immediate = false) => {
    if (closed) return;
    closed = true;
    activeDocument.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", onScroll, true);
    if (immediate) dom.remove();
    else dismissSurfaceWithMotion(dom, () => dom.remove());
  };

  // Action rows
  const hasFields = opts.fields && opts.fields.length > 0;
  if (opts.actions.length > 0 && hasFields) {
    // Visual separator between the input section and the actions.
    const sep = activeWindow.createDiv();
    sep.className = "menu-separator";
    body.appendChild(sep);
  }
  let lastSepEmitted = hasFields; // already added one above
  for (const action of opts.actions) {
    if (action.separatorBefore && !lastSepEmitted) {
      const sep = activeWindow.createDiv();
      sep.className = "menu-separator";
      body.appendChild(sep);
      lastSepEmitted = true;
    }
    const actionEl = activeWindow.createDiv();
    actionEl.className = "menu-item tappable butter-rich-menu-action";
    if (action.warning) actionEl.classList.add("is-warning");
    actionEl.setAttribute("role", "menuitem");
    actionEl.setAttribute("tabindex", "0");
    actionEl.setAttribute("aria-label", txKnown(action.label));
    actionEls.push({ el: actionEl, action });
    const iconEl = activeWindow.createDiv();
    iconEl.className = "menu-item-icon";
    setIcon(iconEl, action.icon);
    actionEl.appendChild(iconEl);
    const titleEl = activeWindow.createDiv();
    titleEl.className = "menu-item-title";
    titleEl.textContent = txKnown(action.label);
    actionEl.appendChild(titleEl);
    actionEl.addEventListener("mousedown", (e) => {
      // Prevent the click-outside dismiss handler from firing before
      // our click runs. Action item still receives click via the
      // click listener below.
      e.preventDefault();
    });
    actionEl.addEventListener("click", (e) => {
      e.preventDefault();
      void (async () => {
        const recv = action.receivesValues ?? true;
        const accepted = await action.onClick(recv ? getValues() : {});
        if (accepted === false) {
          flashInvalid();
          return;
        }
        close();
      })();
    });
    body.appendChild(actionEl);
    lastSepEmitted = false;
  }
  refreshActionVisibility();

  parent.appendChild(dom);

  // Position - start at the mouse / anchor, then nudge into the
  // viewport if the popover would overflow.
  const positionFromEvent = () => {
    if (opts.event) {
      return { x: opts.event.clientX, y: opts.event.clientY + 4 };
    }
    const r = opts.anchor.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 4 };
  };
  const reposition = () => {
    const { x, y } = positionFromEvent();
    placePopover(dom, x, y);
  };
  reposition();
  window.addEventListener("resize", reposition);
  const onScroll = (event: Event) => {
    const target = event.target as Node | null;
    const ownerWindow = activeDocument.defaultView;
    if (
      ownerWindow
      && target?.instanceOf(ownerWindow.Node)
      && (
        dom.contains(target)
        || (target.instanceOf(ownerWindow.Element)
          && Boolean(target.closest(".butter-suggest-host-vault")))
      )
    ) return;
    if (opts.onCancel) opts.onCancel();
    close(true);
  };
  window.addEventListener("scroll", onScroll, true);

  // Focus the first input on the next tick so the popover's own
  // mounting doesn't fight the focus. Skipped for right-click
  // context menus on existing items - the user popped the menu to
  // act on the link, not necessarily to edit its text.
  if (opts.autoFocusFirstField !== false) {
    window.setTimeout(() => {
      const firstField = opts.fields?.[0];
      if (firstField) {
        const inp = inputEls[firstField.id];
        inp.focus();
        inp.select();
        if (firstField.autocomplete === "vault-files" && firstField.suggestOnEmpty) {
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }, 0);
  }

  // Click-outside dismisses - capture phase so we beat any handlers
  // that might re-focus the editor and trigger a save side-effect.
  const onDown = (ev: MouseEvent) => {
    if (ev.target instanceof Node && dom.contains(ev.target)) return;
    if (opts.onCancel) opts.onCancel();
    close();
  };
  activeDocument.addEventListener("mousedown", onDown, true);

  // Per-input keyboard handlers - Enter commits, Esc cancels. Stop
  // propagation so other plugins / Obsidian don't react to the same
  // keypress (e.g. Esc closing other UI).
  for (const input of Object.values(inputEls)) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const accepted = opts.onCommit?.(getValues());
        if (accepted === false) {
          flashInvalid();
          return;
        }
        close();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (opts.onCancel) opts.onCancel();
        close();
      }
    });
  }

  return {
    close,
    values: getValues,
  };
}

/** Pin the popover near (clientX, clientY), flipping into the
 *  viewport if it would overflow on the right or bottom. */
function placePopover(el: HTMLElement, clientX: number, clientY: number): void {
  // Force a layout to read the current bounding box.
  el.setCssProps({
    "--butter-pos-left": "0px",
    "--butter-pos-top": "0px",
  });
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = clientX;
  let y = clientY;
  if (x + rect.width > vw - 8) x = Math.max(8, vw - rect.width - 8);
  if (y + rect.height > vh - 8) y = Math.max(8, clientY - rect.height - 8);
  el.setCssProps({
    "--butter-pos-left": `${x}px`,
    "--butter-pos-top": `${y}px`,
  });
}
