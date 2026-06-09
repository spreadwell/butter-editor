/**
 * Mobile-specific toolbar rendering for Butter Editor.
 *
 * Lives separately from `toolbar.ts` because the mobile and desktop
 * paths render through entirely different DOM shapes / interaction
 * models (mobile = bottom-of-keyboard accessory bar with bottom-sheet
 * overflow + above-anchored variants popover; desktop = sticky button
 * row with hover popovers + grid pickers). Co-locating both in one
 * file made it ~1.4k lines and hard to navigate.
 *
 * The shared button registry, command execution helpers, and the
 * `RenderCtx` type still live in `toolbar.ts` - this module imports
 * them. `createToolbar` (in `toolbar.ts`) calls `renderMobile` and
 * `installMobileLongPress` from here when `Platform.isMobile`.
 */
import { App, Modal, Notice, normalizePath, setIcon } from "obsidian";
import type { EditorView } from "prosemirror-view";
import type { Schema } from "prosemirror-model";
import type { Layout, LayoutItem } from "./toolbar-layout";
import {
  BUTTON_REGISTRY,
  type BtnDef,
  type RenderCtx,
  clearFormatting,
  execBlockCmd,
  execHistoryCmd,
  execInsertCmd,
  execListCmd,
  execMarkCmd,
  insertTable,
  isMarkActive,
  setHeading,
  openMobileColorSheet,
} from "./toolbar";
import {
  openMobileInsertDrawer,
  openMobileDrawer,
  closeMobileInsertDrawer,
} from "./insert-drawer";

/** Same check as the desktop toolbar's `isHtmlFormattingEnabled`,
 *  reachable from the mobile renderer without duplicating exports
 *  across module boundaries. Defaults to true when the plugin isn't
 *  available (test harnesses, etc.). */
function isMobileHtmlFormattingEnabled(ctx: RenderCtx): boolean {
  const plugin = ctx.app.plugins?.plugins["butter-editor"] as
    | { settings?: { enableHtmlFormatting?: boolean } }
    | undefined;
  return plugin?.settings?.enableHtmlFormatting !== false;
}

// ── Insert-flow dialogs ──

/** Mobile insert-table dialog. Replaces the desktop 6×8 hover-grid
 *  picker (which assumes mouse-hover for sizing) with two numeric
 *  steppers for rows + columns, defaulting to 3 × 3. Reuses the
 *  existing `insertTable` command - just feeds it concrete integers
 *  instead of grid coordinates. */
function openMobileInsertTableModal(app: App, schema: Schema, view: EditorView) {
  const modal = new (class extends Modal {
    private rows = 3;
    private cols = 3;
    onOpen() {
      this.titleEl.setText("Insert table");
      const wrap = this.contentEl.createDiv({ cls: "butter-mobile-stepper-wrap" });
      const stepper = (label: string, init: number, onChange: (n: number) => void) => {
        const row = wrap.createDiv({ cls: "butter-mobile-stepper-row" });
        row.createSpan({ cls: "butter-mobile-stepper-label", text: label });
        const minus = row.createEl("button", { cls: "butter-mobile-stepper-btn", text: "−" });
        const value = row.createSpan({ cls: "butter-mobile-stepper-value", text: String(init) });
        const plus = row.createEl("button", { cls: "butter-mobile-stepper-btn", text: "+" });
        let n = init;
        const set = (v: number) => {
          n = Math.max(1, Math.min(10, v));
          value.setText(String(n));
          onChange(n);
        };
        minus.addEventListener("click", () => set(n - 1));
        plus.addEventListener("click", () => set(n + 1));
      };
      stepper("Rows", this.rows, (n) => (this.rows = n));
      stepper("Columns", this.cols, (n) => (this.cols = n));
      const actions = this.contentEl.createDiv({ cls: "butter-mobile-modal-actions" });
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => this.close());
      const insert = actions.createEl("button", {
        cls: "mod-cta",
        text: "Insert",
      });
      insert.addEventListener("click", () => {
        this.close();
        insertTable(schema, view, this.rows, this.cols);
        view.focus();
      });
    }
  })(app);
  modal.open();
}

/** Mobile insert-image dialog. Replaces `prompt(...)` with an OS
 *  file picker (preferred) and a URL fallback. The picker writes
 *  the chosen file to the vault root with a unique filename and
 *  inserts a wikilink-style embed at the cursor; the URL path
 *  inserts a regular image node. */
function openMobileInsertImageDialog(
  app: App,
  schema: Schema,
  view: EditorView,
) {
  const modal = new (class extends Modal {
    onOpen() {
      this.titleEl.setText("Insert image");
      const wrap = this.contentEl.createDiv({ cls: "butter-mobile-image-options" });
      // OS file picker - preferred mobile path
      const pickBtn = wrap.createEl("button", {
        cls: "butter-mobile-image-option mod-cta",
        text: "Pick from device",
      });
      pickBtn.addEventListener("click", () => {
        const input = activeDocument.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.addClass("butter-mobile-file-input");
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          if (!file) return;
          this.close();
          void insertImageFromFile(app, schema, view, file);
        });
        activeDocument.body.appendChild(input);
        input.click();
        // Detached after change fires (or never, if user cancels);
        // safe to leave attached briefly.
        window.setTimeout(() => input.remove(), 60_000);
      });
      // URL fallback
      const urlRow = wrap.createDiv({ cls: "butter-mobile-image-url-row" });
      urlRow.createSpan({ text: "Or paste URL:" });
      const urlInput = urlRow.createEl("input", { type: "url" });
      urlInput.placeholder = "Example: https://…";
      const urlBtn = urlRow.createEl("button", { text: "Insert URL" });
      urlBtn.addEventListener("click", () => {
        const src = urlInput.value.trim();
        if (!src) return;
        this.close();
        view.dispatch(
          view.state.tr.replaceSelectionWith(
            schema.nodes.image.create({ src, alt: "" }),
          ),
        );
        view.focus();
      });
    }
  })(app);
  modal.open();
}

/** Save a File picked via the OS file picker into the vault root,
 *  generate a unique name, and insert a wikilink embed at the
 *  cursor. Vault root is the simplest safe target - keeps the
 *  insert-image flow non-destructive (no folder creation, no
 *  rename collisions) and matches Obsidian's default attachment
 *  location for users who haven't customized it. */
async function insertImageFromFile(
  app: App,
  schema: Schema,
  view: EditorView,
  file: File,
): Promise<void> {
  try {
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\..+/, "");
    const name = normalizePath(`pasted-${stamp}.${ext}`);
    const buffer = await file.arrayBuffer();
    await app.vault.createBinary(name, buffer);
    const embedType = schema.nodes.obsidian_embed;
    if (embedType) {
      view.dispatch(
        view.state.tr.replaceSelectionWith(embedType.create({ src: name })),
      );
    } else {
      // Schema doesn't expose obsidian_embed (shouldn't happen in
      // Butter - defensive fallback to image node).
      view.dispatch(
        view.state.tr.replaceSelectionWith(
          schema.nodes.image.create({ src: name, alt: "" }),
        ),
      );
    }
    view.focus();
  } catch (err) {
    new Notice(`Failed to save image: ${(err as Error).message ?? err}`);
  }
}

// ── Item / button rendering ──

function renderMobileItem(item: LayoutItem, ctx: RenderCtx, list: HTMLElement) {
  if (item.type === "separator") {
    const sep = activeDocument.createElement("div");
    sep.classList.add("mobile-toolbar-separator");
    list.appendChild(sep);
    return;
  }
  if (item.type === "submenu") {
    // Render as a single button with the submenu's icon/label.
    // Tap (or long-press) opens a popover ABOVE the button with
    // the children - same picker UX as desktop, just anchored
    // upward since the mobile toolbar sits at the bottom of the
    // viewport. The "long-press for variants" framing comes for
    // free since tap and long-press both fire `click` after the
    // touch ends.
    const el = activeDocument.createElement("div");
    el.classList.add(
      "mobile-toolbar-option",
      "clickable-icon",
      "butter-mobile-submenu",
    );
    el.setAttribute("aria-label", item.label || "Submenu");
    el.dataset.submenuId = item.id;
    setIcon(el, item.icon || "more-horizontal");
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openMobileVariantsPopover(item, el, ctx);
    });
    list.appendChild(el);
    return;
  }
  if (item.type === "overflow") {
    // Explicit overflow placeholder. Render is handled by the
    // auto-injected button at the end of `renderMobile`; an
    // explicit one here just reserves a spot in the user's layout
    // so they can position the More button mid-bar if they want.
    const el = activeDocument.createElement("div");
    el.classList.add(
      "mobile-toolbar-option",
      "clickable-icon",
      "butter-mobile-overflow",
    );
    el.setAttribute("aria-label", "More");
    setIcon(el, "more-horizontal");
    el.addEventListener("click", (e) => {
      e.preventDefault();
      openMobileToolbarSheet(ctx);
    });
    list.appendChild(el);
    return;
  }
  // Mobile button id
  const def = BUTTON_REGISTRY.get(item.id);
  if (!def) return;
  if (def.markName && !ctx.schema.marks[def.markName]) return;
  if (def.kind !== "list" && def.nodeName && !ctx.schema.nodes[def.nodeName]) return;
  // Mirror the desktop gate: HTML-only toolbar buttons hide when the
  // user disables HTML formatting in settings. Same setting check;
  // applyToolbarButtonVisibility rebuilds the mobile bar on toggle.
  const htmlOk = isMobileHtmlFormattingEnabled(ctx);
  if (def.id === "text-color" && !htmlOk) return;
  const el = activeDocument.createElement("div");
  // `.clickable-icon` carries Obsidian's hover / active / focused
  // icon-color cascade - pulling the bar into the host app's theme
  // automatically. With it, "detached" style mirrors Obsidian's own
  // mobile toolbar 1:1 without our CSS having to hard-code colors.
  el.classList.add("mobile-toolbar-option", "clickable-icon");
  el.setAttribute("aria-label", def.label);
  el.dataset.btnId = def.id;
  setIcon(el, def.icon);
  ctx.buttonMap.set(def.id, el);
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const view = ctx.getView();
    if (!view) return;
    // Mobile-specific insert flows replace the desktop hover-grid /
    // prompt-dialog UI with thumb-friendly modals.
    if (def.id === "table") {
      openMobileInsertTableModal(ctx.app, ctx.schema, view);
      return;
    }
    if (def.id === "image" || def.nodeName === "image") {
      openMobileInsertImageDialog(ctx.app, ctx.schema, view);
      return;
    }
    if (def.id === "text-color") {
      openMobileColorSheet(ctx.app, ctx.schema, view, "text");
      return;
    }
    if (def.id === "clear-formatting") {
      clearFormatting(view, ctx.schema);
      return;
    }
    // Mirror the desktop highlight UX: tap toggles `==text==` and,
    // when HTML formatting is enabled and the tap is adding (not
    // removing) the highlight, immediately opens the color sheet so
    // the user can refine to a custom colour with one more tap.
    if (def.id === "highlight") {
      const highlightMark = ctx.schema.marks.highlight;
      const wasActive = highlightMark
        ? isMarkActive(view.state, highlightMark)
        : false;
      execMarkCmd(def, ctx.schema, view);
      if (!wasActive && htmlOk) {
        openMobileColorSheet(ctx.app, ctx.schema, view, "highlight");
      }
      return;
    }
    // Insert button - opens the mobile insert drawer (slash-menu
    // as a 2-col grid). Same affordance the auto-appended `+` used
    // to provide, now a customizable layout item so it can be
    // moved / hidden via the toolbar customizer.
    if (def.id === "insert") {
      openMobileInsertDrawer(view, ctx.schema, ctx.app);
      return;
    }
    // Block-context buttons - open the unified mobile drawer in
    // the appropriate mode, scoped to the block at the current
    // selection. The drawer module handles all the keyboard-swap
    // / fake-cursor / refocus mechanics; we just resolve the
    // block and hand it over.
    if (def.id === "turn-into" || def.id === "block-actions") {
      const blockCtx = resolveCurrentBlock(view, ctx.serializeNode);
      if (!blockCtx) return; // No top-level block - nothing to act on.
      openMobileDrawer(view, ctx.schema, ctx.app, {
        mode: def.id === "turn-into" ? "turn-into" : "block-actions",
        blockContext: blockCtx,
      });
      return;
    }
    if (def.kind === "mark") execMarkCmd(def, ctx.schema, view);
    else if (def.kind === "block") execBlockCmd(def, ctx.schema, view);
    else if (def.kind === "list") execListCmd(def, ctx.schema, view);
    else if (def.kind === "insert") execInsertCmd(def, ctx.schema, view, ctx.app);
    else if (def.kind === "heading") setHeading(ctx.schema, view, def.headingLevel ?? 0);
    else if (def.kind === "history") execHistoryCmd(def, view);
  });
  list.appendChild(el);
}

/** Resolve the top-level block at the current selection. Returns
 *  the block's PM position, the node, and its DOM element, plus
 *  the markdown serializer for Copy actions. Returns null when
 *  selection has no top-level ancestor (e.g. doc root) - in which
 *  case the caller should bail out with no action. */
function resolveCurrentBlock(
  view: EditorView,
  serializeNode?: (node: import("prosemirror-model").Node) => string,
): {
  pos: number;
  node: import("prosemirror-model").Node;
  blockDom?: HTMLElement;
  serializeNode?: (node: import("prosemirror-model").Node) => string;
} | null {
  const sel = view.state.selection;
  // `NodeSelection`-style: cursor IS the block boundary already.
  const $from = sel.$from;
  if ($from.depth === 0) return null;
  // Walk to depth 1 (top-level child of doc).
  const node = $from.node(1);
  const pos = $from.before(1);
  const dom = view.nodeDOM(pos);
  return {
    pos,
    node,
    blockDom: dom instanceof HTMLElement ? dom : undefined,
    serializeNode,
  };
}

/** Mobile variants popover. Position is computed by `setPopover`,
 *  which we override for mobile by stamping `top` to anchor ABOVE
 *  the button (toolbar is at the bottom of the viewport, so the
 *  popover would clip off-screen if anchored below). Children are
 *  rendered as mobile-toolbar-option buttons, vertically stacked,
 *  one tap closes the popover and dispatches the action. */
function openMobileVariantsPopover(
  item: Extract<LayoutItem, { type: "submenu" }>,
  anchor: HTMLElement,
  ctx: RenderCtx,
) {
  ctx.closePopover();
  const popup = activeDocument.createElement("div");
  popup.classList.add("butter-mobile-variants-popover");
  for (const child of item.children) {
    if (child.type === "separator") {
      const sep = activeDocument.createElement("div");
      sep.classList.add("butter-mobile-variants-sep");
      popup.appendChild(sep);
      continue;
    }
    if (child.type === "submenu" || child.type === "overflow") {
      // No nested submenus / overflow inside variant pickers
      // would create a popover-on-popover stack on mobile.
      continue;
    }
    const def = BUTTON_REGISTRY.get(child.id);
    if (!def) continue;
    const row = activeDocument.createElement("div");
    row.classList.add("butter-mobile-variant-row");
    const icon = activeDocument.createElement("span");
    icon.classList.add("butter-mobile-variant-icon");
    setIcon(icon, def.icon);
    const label = activeDocument.createElement("span");
    label.classList.add("butter-mobile-variant-label");
    label.textContent = def.label;
    row.appendChild(icon);
    row.appendChild(label);
    row.addEventListener("click", (e) => {
      e.preventDefault();
      ctx.closePopover();
      const view = ctx.getView();
      if (!view) return;
      if (def.kind === "mark") execMarkCmd(def, ctx.schema, view);
      else if (def.kind === "block") execBlockCmd(def, ctx.schema, view);
      else if (def.kind === "list") execListCmd(def, ctx.schema, view);
      else if (def.kind === "insert") execInsertCmd(def, ctx.schema, view, ctx.app);
      else if (def.kind === "heading") setHeading(ctx.schema, view, def.headingLevel ?? 0);
      else if (def.kind === "history") execHistoryCmd(def, view);
    });
    popup.appendChild(row);
  }
  // Anchor above the button. setPopover skips its default
  // top/left assignment when the popup already has `position` set.
  const aRect = anchor.getBoundingClientRect();
  // Render once off-screen so we can read its height, then place.
  popup.addClass("butter-mobile-popup-placed");
  popup.addClass("butter-mobile-popup-measure");
  popup.setCssProps({
    "--butter-pos-left": "0px",
    "--butter-pos-top": "0px",
  });
  activeDocument.body.appendChild(popup);
  const pHeight = popup.getBoundingClientRect().height;
  popup.remove();
  popup.removeClass("butter-mobile-popup-measure");
  const popupWidth = 220;
  const desiredLeft = aRect.left + aRect.width / 2 - popupWidth / 2;
  const left = Math.max(8, Math.min(window.innerWidth - popupWidth - 8, desiredLeft));
  popup.setCssProps({
    "--butter-pos-top": `${Math.max(8, aRect.top - pHeight - 8)}px`,
    "--butter-pos-width": `${popupWidth}px`,
    "--butter-pos-left": `${left}px`,
  });
  ctx.setPopover(popup, anchor);
}

/** Mobile overflow sheet - opens from the `⋯` button (auto-injected
 *  or explicit `{type:"overflow"}` in the layout). Lists every
 *  action in the current layout as full-width rows with label +
 *  icon, big tap targets, slide-in from the bottom. Tap a row
 *  dispatches the action; tap the backdrop dismisses. */
function openMobileToolbarSheet(ctx: RenderCtx) {
  ctx.closePopover();
  // Auto-close the soft keyboard so the sheet has the bottom
  // half of the screen to itself. Without this the sheet rises
  // above the keyboard, leaving most of its content out of
  // reach. Blurring the contenteditable triggers Capacitor /
  // Android's keyboardWillHide; the mobile-toolbar visibility
  // logic (`installMobileToolbarBehavior` in main.ts) hides the
  // bar along with it, leaving a clean stage for the sheet.
  const view = ctx.getView();
  if (view) view.dom.blur();
  if (activeDocument.activeElement instanceof HTMLElement) {
    activeDocument.activeElement.blur();
  }
  const layout = ctx.getLayout();

  const backdrop = activeDocument.createElement("div");
  backdrop.classList.add("butter-mobile-sheet-backdrop");
  const sheet = activeDocument.createElement("div");
  sheet.classList.add("butter-mobile-sheet");
  sheet.setAttribute("role", "dialog");

  const title = activeDocument.createElement("div");
  title.classList.add("butter-mobile-sheet-title");
  title.textContent = "More actions";
  sheet.appendChild(title);

  const list = activeDocument.createElement("div");
  list.classList.add("butter-mobile-sheet-list");

  // Defined here so callbacks (addRow.click) capture a stable
  // reference; the actual `backdrop.classList` work happens at
  // call time, after backdrop is fully built.
  const close = () => {
    backdrop.classList.remove("is-open");
    window.setTimeout(() => backdrop.remove(), 200);
  };

  const dispatchDef = (def: BtnDef) => {
    const view = ctx.getView();
    if (!view) return;
    if (def.kind === "mark") execMarkCmd(def, ctx.schema, view);
    else if (def.kind === "block") execBlockCmd(def, ctx.schema, view);
    else if (def.kind === "list") execListCmd(def, ctx.schema, view);
    else if (def.kind === "insert") execInsertCmd(def, ctx.schema, view, ctx.app);
    else if (def.kind === "heading") setHeading(ctx.schema, view, def.headingLevel ?? 0);
    else if (def.kind === "history") execHistoryCmd(def, view);
  };

  const addRow = (def: BtnDef) => {
    const row = activeDocument.createElement("div");
    row.classList.add("butter-mobile-sheet-row");
    const icon = activeDocument.createElement("span");
    icon.classList.add("butter-mobile-sheet-icon");
    setIcon(icon, def.icon);
    const label = activeDocument.createElement("span");
    label.classList.add("butter-mobile-sheet-label");
    label.textContent = def.label;
    row.appendChild(icon);
    row.appendChild(label);
    row.addEventListener("click", () => {
      close();
      dispatchDef(def);
    });
    list.appendChild(row);
  };

  const addItems = (items: LayoutItem[]) => {
    for (const item of items) {
      if (item.type === "separator") {
        const sep = activeDocument.createElement("div");
        sep.classList.add("butter-mobile-sheet-sep");
        list.appendChild(sep);
        continue;
      }
      if (item.type === "submenu") {
        addItems(item.children);
        continue;
      }
      if (item.type === "overflow") continue;
      const def = BUTTON_REGISTRY.get(item.id);
      if (!def) continue;
      if (def.markName && !ctx.schema.marks[def.markName]) continue;
      if (def.nodeName && !ctx.schema.nodes[def.nodeName]) continue;
      addRow(def);
    }
  };
  addItems(layout);

  sheet.appendChild(list);
  backdrop.appendChild(sheet);
  activeDocument.body.appendChild(backdrop);
  // Slide-in animation: append, then next frame add `is-open`.
  window.requestAnimationFrame(() => backdrop.classList.add("is-open"));

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
}

// ── Public entrypoints (consumed by `createToolbar` in toolbar.ts) ──

/** Render the mobile main toolbar into `dom`. Clears existing
 *  children, stamps shared chrome classes (`butter-mobile-toolbar`
 *  + `butter-mobile-bar`), builds the row + the swap-back pill +
 *  the auto-overflow `⋯` button. Called once on mount and on every
 *  rebuild (settings-tab edits). */
export function renderMobile(
  dom: HTMLElement,
  ctx: RenderCtx,
  getMobileStyle: () => "detached" | "attached",
  getLayout: () => Layout,
): void {
  ctx.closePopover();
  dom.innerHTML = "";
  ctx.buttonMap.clear();
  // Use ONLY `.butter-mobile-toolbar`; intentionally drop the
  // generic `.mobile-toolbar` class. Obsidian's own native mobile
  // toolbar carries that class, and we rely on a CSS suppression
  // rule (`body.butter-mobile-active .mobile-toolbar { display:
  // none }`) to hide the native bar inside Butter views - keeping
  // the class here would hide our own bar too. The internal
  // `.mobile-toolbar-options-list` wrapper class stays since CSS
  // scopes it under `.butter-mobile-toolbar`.
  //
  // `.butter-mobile-bar` is the shared CHROME class - also stamped
  // on the table toolbar's outer (see `table-toolbar.ts`). All
  // visual rules (size, padding, gap, button geometry, native vs
  // butter style) live under `.butter-mobile-bar` so the two bars
  // share one CSS path and can't visually drift. The bar-specific
  // `.butter-mobile-toolbar` / `.butter-mobile-table-toolbar`
  // classes carry only visibility + positioning.
  dom.classList.add("butter-mobile-toolbar", "butter-mobile-bar");
  const style = getMobileStyle();
  // Mobile toolbar style ("detached" vs "attached") drives the DOM
  // shape AND chrome rules. CSS scopes via this attribute.
  dom.dataset.mobileStyle = style;
  if (style === "attached") {
    renderButterMain(dom, ctx, getLayout);
  } else {
    renderNativeMain(dom, ctx, getLayout);
  }
}

/** Native main bar - Obsidian-style two-pill layout, both on the
 *  RIGHT (predictable-position policy: any toolbar action - swap,
 *  overflow, drawer-close - appears in the same right slot):
 *    [list-container > list (the main scrolling pill)]
 *    [right chrome pill - one of: overflow `⋯`, swap-to-table]
 *  CSS picks which child of the right pill is visible based on
 *  the body-class state machine. The default state shows the
 *  overflow `⋯`; in-table state shows the swap toggle.
 *  Reuses Obsidian's `.mobile-toolbar-options-container` class
 *  family so host themes targeting the native bar cascade to ours. */
function renderNativeMain(
  dom: HTMLElement,
  ctx: RenderCtx,
  getLayout: () => Layout,
): void {
  const container = activeDocument.createElement("div");
  container.classList.add("mobile-toolbar-options-container");
  dom.appendChild(container);

  // Main pill - scrollable list of formatting buttons.
  const listWrap = activeDocument.createElement("div");
  listWrap.classList.add("mobile-toolbar-options-list-container");
  const list = activeDocument.createElement("div");
  list.classList.add("mobile-toolbar-options-list");
  listWrap.appendChild(list);
  container.appendChild(listWrap);
  const layout = getLayout();
  for (const item of layout) {
    renderMobileItem(item, ctx, list);
  }
  installOverscrollRubberBand(list);

  // Right chrome pill - holds (in order of priority): swap-to-
  // table toggle (when caret in cell + prefer-main), overflow
  // `⋯` (default state). CSS shows exactly one at a time via the
  // body-class state machine.
  const hasExplicitOverflow = layout.some((i) => i.type === "overflow");
  if (!hasExplicitOverflow) {
    const rightFloat = activeDocument.createElement("div");
    rightFloat.classList.add(
      "mobile-toolbar-floating-options",
      "butter-mobile-chrome-pill",
    );

    const swapBack = activeDocument.createElement("button");
    swapBack.className =
      "mobile-toolbar-option clickable-icon butter-mobile-swap-btn";
    swapBack.setAttribute("aria-label", "Switch to table toolbar");
    setIcon(swapBack, "table");
    swapBack.addEventListener("click", (e) => {
      e.preventDefault();
      activeDocument.body.classList.remove("butter-mobile-prefer-main");
    });
    rightFloat.appendChild(swapBack);

    const more = activeDocument.createElement("div");
    more.classList.add(
      "mobile-toolbar-option",
      "clickable-icon",
      "butter-mobile-overflow",
      "butter-mobile-overflow-auto",
    );
    more.setAttribute("aria-label", "More");
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (e) => {
      e.preventDefault();
      openMobileToolbarSheet(ctx);
    });
    rightFloat.appendChild(more);

    container.appendChild(rightFloat);
  }
}

/** Butter main bar - solid full-width keyboard-chrome layout:
 *    [list (formatting buttons + auto-appended `+` at end)]
 *    [chrome divider]
 *    [swap toggle (right, conditionally shown - same role as the
 *     native overflow's right-side slot)]
 *  Reads as a continuation of the soft keyboard rather than a
 *  floating UI. The `+` insert button opens the mobile insert
 *  drawer (see `insert-drawer.ts`), which swaps the keyboard for
 *  a 2-column slash-menu picker without moving the bar. */
function renderButterMain(
  dom: HTMLElement,
  ctx: RenderCtx,
  getLayout: () => Layout,
): void {
  const row = activeDocument.createElement("div");
  row.classList.add("butter-mobile-bar-row");
  dom.appendChild(row);

  // Main button list - scrolls horizontally if too many for the
  // visible width.
  const list = activeDocument.createElement("div");
  list.classList.add("butter-mobile-bar-list", "mobile-toolbar-options-list");
  row.appendChild(list);
  const layout = getLayout();
  for (const item of layout) {
    renderMobileItem(item, ctx, list);
  }
  installOverscrollRubberBand(list);
  // Legacy auto-append: existing user layouts saved before the
  // `insert` button became a layout item don't have it explicitly.
  // Keep the trailing fallback so they still see a `+` until
  // they next customize. New default layouts (mobileLayoutDefault)
  // include `insert` as a real button — the fallback then skips.
  const hasExplicitOverflow = layout.some((i) => i.type === "overflow");
  const hasExplicitInsert = layout.some(
    (i) => i.type === "button" && i.id === "insert",
  );
  if (!hasExplicitOverflow && !hasExplicitInsert) {
    const insertBtn = activeDocument.createElement("div");
    insertBtn.classList.add(
      "mobile-toolbar-option",
      "clickable-icon",
      "butter-mobile-insert-btn",
    );
    insertBtn.setAttribute("aria-label", "Insert block");
    setIcon(insertBtn, "plus");
    insertBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const view = ctx.getView();
      if (!view) return;
      openMobileInsertDrawer(view, ctx.schema, ctx.app);
    });
    list.appendChild(insertBtn);
  }

  // Right-side chrome - predictable slot for toolbar actions. CSS
  // picks at most one of three buttons via body classes, in priority:
  //   1. close-drawer (`x`)     - when the insert drawer is open
  //   2. swap-to-table (table)  - when caret is in a cell + user
  //                               has manually preferred main
  //   3. close-keyboard (▽)     - default; dismisses the on-screen
  //                               keyboard by blurring whatever's
  //                               currently focused.
  const chrome = activeDocument.createElement("div");
  chrome.classList.add("butter-mobile-bar-chrome");

  const swapBack = activeDocument.createElement("button");
  swapBack.className =
    "mobile-toolbar-option clickable-icon butter-mobile-swap-btn";
  swapBack.setAttribute("aria-label", "Switch to table toolbar");
  setIcon(swapBack, "table");
  swapBack.addEventListener("click", (e) => {
    e.preventDefault();
    activeDocument.body.classList.remove("butter-mobile-prefer-main");
  });
  chrome.appendChild(swapBack);

  const closeBtn = activeDocument.createElement("button");
  closeBtn.className =
    "mobile-toolbar-option clickable-icon butter-mobile-close-btn";
  closeBtn.setAttribute("aria-label", "Close insert drawer");
  setIcon(closeBtn, "x");
  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    closeMobileInsertDrawer();
    const view = ctx.getView();
    if (view) window.setTimeout(() => view.focus(), 0);
  });
  chrome.appendChild(closeBtn);

  const hideKbBtn = activeDocument.createElement("button");
  hideKbBtn.className =
    "mobile-toolbar-option clickable-icon butter-mobile-hide-kb-btn";
  hideKbBtn.setAttribute("aria-label", "Hide keyboard");
  setIcon(hideKbBtn, "chevron-down");
  // Use pointerdown rather than click so we blur BEFORE the editor
  // re-focuses on tap. Otherwise the browser refocuses the editable
  // element and the keyboard pops right back up.
  hideKbBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const active = activeDocument.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  chrome.appendChild(hideKbBtn);

  row.appendChild(chrome);
}

/** Springy "rubber band" overscroll for horizontal toolbar lists.
 *  When the user drags past either edge, the list translates by a
 *  damped offset (asymptotic to MAX_PULL) and snaps back on
 *  release. Mimics iOS-native scroll bounce on Android too
 *  Chromium has no native equivalent for horizontal overscroll. */
export function installOverscrollRubberBand(el: HTMLElement): void {
  const MAX_PULL = 80; // px - asymptotic max overdrag
  const RESIST = 0.55; // higher = more resistance, less drag
  const SNAP_MS = 280;

  // Damping curve - small overdrag → small offset; grows
  // sub-linearly toward the asymptote so the bar never escapes
  // beyond MAX_PULL no matter how hard the user pulls.
  const rubberBand = (d: number): number =>
    (d * MAX_PULL) / (MAX_PULL + Math.abs(d) * RESIST);

  let lastTouchX = 0;
  let overdrag = 0;
  let snapTimeout: number | null = null;

  el.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      lastTouchX = e.touches[0].clientX;
      overdrag = 0;
      // Cancel any in-flight snap-back so a new drag starts clean.
      if (snapTimeout !== null) {
        window.clearTimeout(snapTimeout);
        snapTimeout = null;
      }
      el.style.removeProperty("transition");
    },
    { passive: true },
  );

  el.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 1) return;
      const x = e.touches[0].clientX;
      const dx = x - lastTouchX;
      lastTouchX = x;

      const max = el.scrollWidth - el.clientWidth;
      const atLeft = el.scrollLeft <= 0;
      const atRight = el.scrollLeft >= max - 1;

      // Accumulate overdrag only when at an edge AND finger is
      // moving in the over-drag direction. Within normal scroll
      // range, native scroll handles it and we reset.
      if (atLeft && dx > 0) {
        overdrag = Math.max(0, overdrag + dx);
      } else if (atRight && dx < 0) {
        overdrag = Math.min(0, overdrag + dx);
      } else {
        if (overdrag !== 0) {
          overdrag = 0;
          el.style.removeProperty("transform");
        }
        return;
      }

      el.style.transform = `translateX(${rubberBand(overdrag)}px)`;
    },
    { passive: true },
  );

  const release = () => {
    if (overdrag === 0) return;
    el.style.transition = `transform ${SNAP_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
    el.style.removeProperty("transform");
    overdrag = 0;
    snapTimeout = window.setTimeout(() => {
      el.style.removeProperty("transition");
      snapTimeout = null;
    }, SNAP_MS + 40);
  };
  el.addEventListener("touchend", release, { passive: true });
  el.addEventListener("touchcancel", release, { passive: true });
}

/** Long-press on the toolbar's empty space (not on a button) opens
 *  the layout customizer. Faster path than going to Settings →
 *  Toolbar on a phone. Safe-guarded by a 500ms hold + 8px move
 *  tolerance so accidental drag-scrolls don't fire it. */
export function installMobileLongPress(dom: HTMLElement, app: App): void {
  let lpTimer: number | null = null;
  let lpStart = { x: 0, y: 0 };
  const lpCancel = () => {
    if (lpTimer !== null) {
      window.clearTimeout(lpTimer);
      lpTimer = null;
    }
  };
  dom.addEventListener("pointerdown", (e: PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest(".mobile-toolbar-option")) return;
    lpStart = { x: e.clientX, y: e.clientY };
    lpTimer = window.setTimeout(() => {
      lpTimer = null;
      const plugin = (app as unknown as {
        plugins?: { plugins?: Record<string, { openSettings?: (s: string) => void }> };
      }).plugins?.plugins?.["butter-editor"];
      plugin?.openSettings?.("toolbar");
    }, 500);
  });
  dom.addEventListener("pointermove", (e: PointerEvent) => {
    if (lpTimer === null) return;
    const dx = e.clientX - lpStart.x;
    const dy = e.clientY - lpStart.y;
    if (Math.hypot(dx, dy) > 8) lpCancel();
  });
  dom.addEventListener("pointerup", lpCancel);
  dom.addEventListener("pointercancel", lpCancel);
}
