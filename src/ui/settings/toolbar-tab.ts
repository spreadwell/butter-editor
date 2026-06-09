import { Setting, setIcon, Platform } from "obsidian";
import { ButterSettingTab, SubmenuEditModal } from "../settings-tab";
import { MAIN_TOOLBAR_BUTTON_DEFS } from "../toolbar";
import { TABLE_TOOLBAR_BUTTON_DEFS } from "../../editor/table-toolbar";
import { defaultTableLayout, mainLayoutFull, mainLayoutSimple, mobileLayoutDefault, mobileTableLayoutDefault, cloneLayout, collectButtonIds, locate, removeItem, newId } from "../toolbar-layout";
import type { ToolbarLayoutItem } from "../../main";

export function renderToolbar(this: ButterSettingTab, root: HTMLElement) {
    // Single tab-level Desktop/Mobile platform switcher rendered
    // FIRST so the layout settings, primary toolbar editor, and
    // table toolbar editor all re-render together when it flips.
    // The device is a tab-level concern, not a per-section one.
    const segKey = "butterToolbarSegment";
    const stored = window.sessionStorage?.getItem(segKey);
    let segment: "desktop" | "mobile" =
      stored === "desktop" || stored === "mobile"
        ? stored
        : (Platform.isMobile ? "mobile" : "desktop");

    const reRenders: Array<() => void> = [];

    const switcher = root.createDiv({
      cls: "butter-toolbar-platform-switcher",
      attr: { role: "tablist", "aria-label": "Toolbar platform" },
    });

    // Sliding accent pill - a single absolutely-positioned element
    // that translates between segments via transform. Sits behind
    // the button labels via z-index so the text stays legible during
    // the slide.
    switcher.createDiv({
      cls: "butter-toolbar-platform-switcher__indicator",
      attr: { "aria-hidden": "true" },
    });

    const makeSegBtn = (label: string, icon: string) => {
      const btn = switcher.createEl("button", {
        cls: "butter-toolbar-platform-switcher__btn",
        attr: { type: "button", role: "tab" },
      });
      const iconEl = btn.createSpan({
        cls: "butter-toolbar-platform-switcher__icon",
      });
      setIcon(iconEl, icon);
      btn.createSpan({
        cls: "butter-toolbar-platform-switcher__label",
        text: label,
      });
      return btn;
    };

    const desktopBtn = makeSegBtn("Desktop", "monitor");
    const mobileBtn = makeSegBtn("Mobile", "smartphone");

    const applyPillState = () => {
      switcher.dataset.segment = segment;
      desktopBtn.classList.toggle("is-active", segment === "desktop");
      mobileBtn.classList.toggle("is-active", segment === "mobile");
      desktopBtn.setAttribute(
        "aria-selected",
        segment === "desktop" ? "true" : "false",
      );
      mobileBtn.setAttribute(
        "aria-selected",
        segment === "mobile" ? "true" : "false",
      );
    };

    const setSegment = (next: "desktop" | "mobile") => {
      if (segment === next) return;
      segment = next;
      try { window.sessionStorage?.setItem?.(segKey, segment); } catch { /* ignore */ }
      applyPillState();
      for (const cb of reRenders) cb();
    };

    desktopBtn.addEventListener("click", () => setSegment("desktop"));
    mobileBtn.addEventListener("click", () => setSegment("mobile"));
    applyPillState();

    this.renderLayoutSection(root, () => segment, reRenders);
    this.renderPrimaryToolbarSection(root, () => segment, reRenders);
    this.renderTableToolbarSection(root, () => segment, reRenders);
  }

/** Layout settings group, filtered by the tab-level platform switcher.
   *  Desktop view shows toolbar style + position + status-bar fade;
   *  mobile view shows the mobile toolbar style. Active style is
   *  shared and appears in both views (it's the same underlying
   *  setting either way). */
  export function renderLayoutSection(this: ButterSettingTab, root: HTMLElement, getSegment: () => "desktop" | "mobile", reRenders: Array<() => void>): void {
    const container = root.createDiv({ cls: "butter-toolbar-segment-body" });

    const renderSegment = () => {
      container.empty();
      const segment = getSegment();
      const tag =
        segment === "desktop"
          ? { label: "Desktop", icon: "monitor" }
          : { label: "Mobile", icon: "smartphone" };
      const layoutItems = this.createSettingGroup(
        container,
        "Layout",
        undefined,
        undefined,
        tag,
      );

      if (segment === "desktop") {
        new Setting(layoutItems)
          .setName("Toolbar style")
          .setDesc("Attached sits as a chrome row at the edge of the pane. Detached floats as a card inside the editor.")
          .addDropdown((d) =>
            // Integrated is implemented but hidden from this dropdown
            // until the design pass for view-header layout is finalized.
            // The setting still works if set programmatically.
            d
              .addOptions({
                attached: "Attached",
                detached: "Detached",
              })
              .setValue(
                this.plugin.settings.toolbarStyle === "integrated"
                  ? "attached"
                  : this.plugin.settings.toolbarStyle,
              )
              .onChange(async (v) => {
                this.plugin.settings.toolbarStyle = v as "detached" | "attached" | "integrated";
                await this.plugin.saveSettings();
                this.plugin.applyToolbarPositionToAllViews();
              }),
          );

        new Setting(layoutItems)
          .setName("Toolbar position")
          .setDesc("Top: pins above the editor content. Bottom: pins below.")
          .addDropdown((d) =>
            d
              .addOptions({ top: "Pin to top", bottom: "Pin to bottom" })
              .setValue(this.plugin.settings.toolbarPosition)
              .onChange(async (v) => {
                this.plugin.settings.toolbarPosition = v as "top" | "bottom";
                await this.plugin.saveSettings();
                this.plugin.applyToolbarPositionToAllViews();
              }),
          );
      } else {
        new Setting(layoutItems)
          .setName("Mobile toolbar style")
          .setDesc("Detached matches Obsidian's mobile toolbar look. Attached is Butter's own style with larger buttons and frosted glass.")
          .addDropdown((d) =>
            d
              .addOptions({ detached: "Detached", attached: "Attached" })
              .setValue(this.plugin.settings.mobileToolbarStyle)
              .onChange(async (v) => {
                this.plugin.settings.mobileToolbarStyle = v as
                  | "detached"
                  | "attached";
                await this.plugin.saveSettings();
                // Re-render so the data-mobile-style attribute updates
                // on the live toolbar dom without a view reopen.
                this.plugin.applyToolbarButtonVisibilityToAllViews();
              }),
          );
      }

      // Active style applies to both desktop and mobile toolbars,
      // so render it in either segment view.
      new Setting(layoutItems)
        .setName("Active style")
        .setDesc("How active formatting buttons are highlighted.")
        .addDropdown((d) =>
          d
            .addOptions({
              filled: "Filled",
              soft: "Soft",
              outlined: "Outlined",
              underline: "Underline",
            })
            .setValue(this.plugin.settings.toolbarActiveStyle)
            .onChange(async (v) => {
              this.plugin.settings.toolbarActiveStyle = v as "underline" | "filled" | "soft" | "outlined";
              await this.plugin.saveSettings();
            }),
        );

      if (segment === "desktop") {
        new Setting(layoutItems)
          .setName("Fade status bar on toolbar hover")
          .setDesc("When the bottom toolbar overlaps the status bar, hovering toolbar buttons fades the status bar so they're reachable.")
          .addToggle((t) =>
            t
              .setValue(this.plugin.settings.statusBarHoverFade)
              .onChange(async (v) => {
                this.plugin.settings.statusBarHoverFade = v;
                await this.plugin.saveSettings();
                // If the user disables while the fade is active, force
                // it off immediately rather than waiting for the next
                // mousemove to clear the class.
                if (!v) {
                  activeDocument.body.classList.remove("butter-status-bar-hide");
                }
              }),
          );
      }
    };

    reRenders.push(renderSegment);
    renderSegment();
  }

/**
   * Native Obsidian settings group: a `setting-item-heading` row at
   * the top + a `setting-items` body underneath. Matches the markup
   * Obsidian's own appearance / about settings produce, so the
   * native CSS supplies the visual chrome (card-style background,
   * dividers between rows). No custom card classes - pure native.
   *
   * Optional `action` adds an icon button to the heading's right side
   * (rendered through `.setting-item-control`, same slot dropdowns
   * and toggles use on regular setting rows).
   */
  export function createSettingGroup(this: ButterSettingTab, parent: HTMLElement, heading: string, description?: string, action?: {
      icon: string;
      tooltip: string;
      onClick: () => void | Promise<void>;
    }, tag?: { label: string; icon?: string }): HTMLElement {
    const group = parent.createDiv({ cls: "setting-group butter-setting-group" });
    const headerEl = group.createDiv({
      cls: "setting-item setting-item-heading",
    });
    const infoEl = headerEl.createDiv({ cls: "setting-item-info" });
    const nameEl = infoEl.createDiv({
      cls: "setting-item-name",
      text: heading,
    });
    // Optional dimmed-italic suffix (icon + label) on the heading.
    // Same visual treatment as the "Experimental" preset tag - used
    // by the platform-segmented sections (Layout / Primary toolbar /
    // Table toolbar) to show whether the current view is Desktop or
    // Mobile.
    if (tag) {
      const tagEl = nameEl.createSpan({ cls: "butter-platform-tag" });
      if (tag.icon) {
        const iconEl = tagEl.createSpan({ cls: "butter-platform-tag__icon" });
        setIcon(iconEl, tag.icon);
      }
      tagEl.createSpan({
        cls: "butter-platform-tag__label",
        text: tag.label,
      });
    }
    if (description) {
      infoEl.createDiv({ cls: "setting-item-description", text: description });
    }
    if (action) {
      const controlEl = headerEl.createDiv({ cls: "setting-item-control" });
      const btn = controlEl.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": action.tooltip, type: "button" },
      });
      setIcon(btn, action.icon);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        void action.onClick();
      });
    }
    return group.createDiv({ cls: "setting-items" });
  }

/**
   * Layout editor - two-list customizer with drag-to-reorder,
   * add/remove, and create/edit/delete submenus. Mirrors Obsidian's
   * own mobile-toolbar settings pattern: rows are full-width with
   * large tap targets so it works on both desktop and touch.
   *
   * `On toolbar` shows the current layout in order; submenu rows
   * are followed by their indented children (single-level nesting).
   * `Available` shows buttons not currently anywhere in the layout.
   * Drag-handle drag reorders within the same parent. The kebab
   * menu on each row exposes cross-level moves and deletion.
   */
  /**
   * Primary-toolbar section. Re-renders its layout editor when the
   * tab-level platform switcher (rendered in `renderToolbar`) flips
   * between Desktop and Mobile. Each platform edits its own layout
   * (`toolbarLayout` vs `mobileToolbarLayout`); the active toolbar
   * at runtime is picked by `getActiveToolbarLayout()` based on
   * `Platform.isMobile`. Letting the user edit BOTH from either
   * platform matches how Obsidian Sync moves a single `data.json`
   * between desktop and mobile - the user can prep their phone
   * toolbar from desktop and vice versa.
   */
  export function renderPrimaryToolbarSection(this: ButterSettingTab, root: HTMLElement, getSegment: () => "desktop" | "mobile", reRenders: Array<() => void>): void {
    // Container for the layout editor - we re-render this on
    // segment change. Tab-level switcher is rendered separately.
    const container = root.createDiv({ cls: "butter-toolbar-segment-body" });

    const renderSegment = () => {
      container.empty();
      const segment = getSegment();
      if (segment === "desktop") {
        this.renderLayoutEditor(
          container,
          "Primary toolbar",
          "Drag rows to reorder. Tap row actions to remove or move into a submenu. Tap an Available button's plus to add it back.",
          MAIN_TOOLBAR_BUTTON_DEFS,
          () => this.plugin.getMainToolbarLayout(),
          async (next) => {
            this.plugin.settings.toolbarLayout = next;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          },
          [
            {
              name: "Full toolbar preset",
              desc: "Every Butter feature, organized into submenus.",
              cta: true,
              build: mainLayoutFull,
            },
            {
              name: "Simple toolbar preset",
              desc: "Pared-down essentials only.",
              build: mainLayoutSimple,
            },
          ],
          { label: "Desktop", icon: "monitor" },
        );
      } else {
        this.renderLayoutEditor(
          container,
          "Primary toolbar",
          "Shown above the soft keyboard on phones and tablets. Submenus flatten on mobile, so pick a focused subset.",
          MAIN_TOOLBAR_BUTTON_DEFS,
          () => this.plugin.getMobileToolbarLayout(),
          async (next) => {
            this.plugin.settings.mobileToolbarLayout = next;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          },
          [
            {
              name: "Default toolbar preset",
              desc: "Curated thumb-friendly button strip.",
              cta: true,
              build: mobileLayoutDefault,
            },
          ],
          { label: "Mobile", icon: "smartphone" },
        );
      }
    };

    reRenders.push(renderSegment);
    renderSegment();
  }

/** Mirrors `renderPrimaryToolbarSection` for the table toolbar.
   *  Shares the same tab-level platform switcher; mobile segment
   *  edits `mobileTableToolbarLayout` and uses `mobileTableLayoutDefault`
   *  as its preset. */
  export function renderTableToolbarSection(this: ButterSettingTab, root: HTMLElement, getSegment: () => "desktop" | "mobile", reRenders: Array<() => void>): void {
    const container = root.createDiv({ cls: "butter-toolbar-segment-body" });

    const renderSegment = () => {
      container.empty();
      const segment = getSegment();
      if (segment === "desktop") {
        this.renderLayoutEditor(
          container,
          "Table toolbar",
          "Shown when the cursor is inside a table. Drag rows to reorder.",
          TABLE_TOOLBAR_BUTTON_DEFS,
          () => this.plugin.getTableToolbarLayout(),
          async (next) => {
            this.plugin.settings.tableToolbarLayout = next;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          },
          [
            {
              name: "Default table toolbar preset",
              desc: "Built-in table toolbar layout.",
              cta: true,
              build: defaultTableLayout,
            },
          ],
          { label: "Desktop", icon: "monitor" },
        );
      } else {
        this.renderLayoutEditor(
          container,
          "Table toolbar",
          "Shown when the cursor is inside a table on mobile. Replaces the main toolbar; thumb-friendly sizing.",
          TABLE_TOOLBAR_BUTTON_DEFS,
          () => this.plugin.getMobileTableToolbarLayout(),
          async (next) => {
            this.plugin.settings.mobileTableToolbarLayout = next;
            await this.plugin.saveSettings();
            this.plugin.applyToolbarButtonVisibilityToAllViews();
          },
          [
            {
              name: "Default table toolbar preset",
              desc: "Curated thumb-friendly table buttons.",
              cta: true,
              build: mobileTableLayoutDefault,
            },
          ],
          { label: "Mobile", icon: "smartphone" },
        );
      }
    };

    reRenders.push(renderSegment);
    renderSegment();
  }

export function renderLayoutEditor(this: ButterSettingTab, root: HTMLElement, title: string, desc: string, defs: ReadonlyArray<{
      id: string;
      label: string;
      group: string;
      icon: string;
    }>, getLayout: () => ToolbarLayoutItem[], saveLayout: (layout: ToolbarLayoutItem[]) => Promise<void>, presets: ReadonlyArray<{
      name: string;
      desc: string;
      cta?: boolean;
      build: () => ToolbarLayoutItem[];
    }>, tag?: { label: string; icon?: string }) {
    const defLookup = new Map(defs.map((d) => [d.id, d]));

    // Single setting-group card holding both the preset rows and
    // the button-by-button customizer. Keeps everything related to
    // configuring this toolbar in one visual container.
    const items = this.createSettingGroup(
      root,
      title,
      undefined,
      undefined,
      tag,
    );

    for (const p of presets) {
      const row = new Setting(items).setName(p.name).setDesc(p.desc);
      row.addButton((b) => {
        b.setButtonText("Apply").onClick(async () => {
          await saveLayout(p.build());
          rerender();
        });
        if (p.cta) b.setCta();
      });
    }

    // "Customize buttons" intro row sits between the presets and the
    // drag/drop customizer below. Plain setting-item (no `.setHeading()`)
    // so it aligns horizontally with the preset rows above instead of
    // adopting the native heading row's competing chrome. The
    // `sliders-horizontal` icon flags it as the customization
    // entry-point distinct from the preset rows above.
    const customizeRow = new Setting(items)
      .setName("Customize buttons")
      .setDesc(desc);
    const customizeIcon = createSpan({ cls: "butter-customize-icon" });
    setIcon(customizeIcon, "sliders-horizontal");
    customizeRow.nameEl.prepend(customizeIcon);

    const wrap = items.createDiv({ cls: "butter-layout-editor" });

    const rerender = () => {
      wrap.empty();
      const layout = cloneLayout(getLayout());

      // ── ON TOOLBAR list ──
      const onWrap = wrap.createDiv({ cls: "butter-layout-list" });
      onWrap.createEl("div", {
        cls: "butter-layout-list-label",
        text: "On toolbar",
      });
      const onList = onWrap.createDiv({
        cls: "butter-layout-rows",
        attr: { "data-list": "on" },
      });

      const renderRow = (
        item: ToolbarLayoutItem,
        parentArr: ToolbarLayoutItem[],
        index: number,
        depth: number,
      ) => {
        const row = onList.createDiv({
          cls: "butter-layout-row",
          attr: {
            "data-item-id": item.id,
            "data-depth": String(depth),
            "data-type": item.type,
          },
        });
        if (depth > 0) row.classList.add("is-nested");

        const handle = row.createEl("button", {
          cls: "butter-layout-handle clickable-icon",
          attr: { "aria-label": "Drag to reorder", type: "button" },
        });
        setIcon(handle, "grip-vertical");
        handle.dataset.dragHandle = "1";

        const icon = row.createDiv({ cls: "butter-layout-icon" });
        const label = row.createDiv({ cls: "butter-layout-label" });

        if (item.type === "separator") {
          row.classList.add("is-separator");
          // Keep the icon slot empty (don't remove it) so the label
          // text aligns horizontally with other rows' labels - the
          // icon column reserves the same left indent across every
          // row type. The label itself takes a muted-italic style
          // that reads as "divider marker" without competing with
          // the surrounding rows visually.
          label.setText("Divider");
          label.classList.add("butter-layout-sep-label");
        } else if (item.type === "submenu") {
          setIcon(icon, item.icon || "more-horizontal");
          label.setText(item.label || "Submenu");
          row.classList.add("is-submenu");
        } else {
          const def = defLookup.get(item.id);
          setIcon(icon, def?.icon ?? "circle-help");
          label.setText(def?.label ?? item.id);
        }

        const actions = row.createDiv({ cls: "butter-layout-row-actions" });

        if (item.type === "submenu") {
          const editBtn = actions.createEl("button", {
            cls: "butter-layout-action clickable-icon",
            attr: { "aria-label": "Edit submenu", type: "button" },
          });
          setIcon(editBtn, "pencil");
          editBtn.addEventListener("click", (e) => {
            e.preventDefault();
            this.openSubmenuEditModal(item, async () => {
              await saveLayout(layout);
              rerender();
            });
          });
        }

        // Cross-level move: top-level button can be moved into a
        // submenu; child can be moved out to top-level.
        if (item.type === "button") {
          const submenus = layout.filter(
            (i) => i.type === "submenu",
          );
          if (depth === 0 && submenus.length > 0) {
            const moveBtn = actions.createEl("button", {
              cls: "butter-layout-action clickable-icon",
              attr: { "aria-label": "Move into submenu", type: "button" },
            });
            setIcon(moveBtn, "folder-input");
            moveBtn.addEventListener("click", (e) => {
              e.preventDefault();
              this.openMoveToSubmenuMenu(moveBtn, submenus, async (subId) => {
                const targetSub = layout.find(
                  (i) => i.type === "submenu" && i.id === subId,
                ) as Extract<ToolbarLayoutItem, { type: "submenu" }> | undefined;
                if (!targetSub) return;
                const idx = parentArr.findIndex((i) => i.id === item.id);
                if (idx < 0) return;
                parentArr.splice(idx, 1);
                targetSub.children.push(item);
                await saveLayout(layout);
                rerender();
              });
            });
          }
          if (depth > 0) {
            const moveOutBtn = actions.createEl("button", {
              cls: "butter-layout-action clickable-icon",
              attr: {
                "aria-label": "Move out of submenu",
                type: "button",
              },
            });
            setIcon(moveOutBtn, "folder-output");
            moveOutBtn.addEventListener("click", (e) => {
              e.preventDefault();
              const idx = parentArr.findIndex((i) => i.id === item.id);
              if (idx < 0) return;
              parentArr.splice(idx, 1);
              layout.push(item);
              void (async () => {
                await saveLayout(layout);
                rerender();
              })();
            });
          }
        }

        const removeBtn = actions.createEl("button", {
          cls: "butter-layout-action clickable-icon mod-danger",
          attr: { "aria-label": "Remove from toolbar", type: "button" },
        });
        setIcon(removeBtn, "x");
        removeBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const idx = parentArr.findIndex((i) => i.id === item.id);
          if (idx < 0) return;
          parentArr.splice(idx, 1);
          void (async () => {
            await saveLayout(layout);
            rerender();
          })();
        });

        // Wire drag-to-reorder. Supports any-depth drops: drop a
        // row before/after another row (at the target's level), or
        // drop a row INTO a submenu (becomes its last child). See
        // `wireDrag()` below.
        this.wireDrag(handle, row, layout, item.id, async () => {
          await saveLayout(layout);
          rerender();
        });
      };

      for (let i = 0; i < layout.length; i++) {
        const item = layout[i];
        renderRow(item, layout, i, 0);
        if (item.type === "submenu") {
          for (let j = 0; j < item.children.length; j++) {
            renderRow(item.children[j], item.children, j, 1);
          }
          if (item.children.length === 0) {
            const empty = onList.createDiv({
              cls: "butter-layout-row is-nested is-empty",
            });
            empty.createDiv({
              cls: "butter-layout-empty",
              text: "Empty submenu - add buttons via their Move actions.",
            });
          }
        }
      }

      // Add-controls row - Obsidian-style buttons with icon + label.
      const addRow = onWrap.createDiv({ cls: "butter-layout-add-row" });
      const buildAddBtn = (
        icon: string,
        label: string,
        onClick: (e: MouseEvent) => void,
      ) => {
        const btn = addRow.createEl("button", {
          cls: "butter-layout-add-btn",
          attr: { type: "button" },
        });
        const iconWrap = btn.createSpan({ cls: "butter-layout-add-btn-icon" });
        setIcon(iconWrap, icon);
        btn.createSpan({ text: label });
        btn.addEventListener("click", onClick);
      };
      buildAddBtn("folder", "Submenu", (e) => {
        e.preventDefault();
        this.openSubmenuEditModal(
          {
            type: "submenu",
            id: newId("sub"),
            label: "New submenu",
            icon: "more-horizontal",
            children: [],
          },
          async (created) => {
            layout.push(created);
            await saveLayout(layout);
            rerender();
          },
          /* isNew */ true,
        );
      });
      buildAddBtn("minus", "Divider", (e) => {
        e.preventDefault();
        layout.push({ type: "separator", id: newId("sep") });
        void (async () => {
          await saveLayout(layout);
          rerender();
        })();
      });

      // ── AVAILABLE list ──
      const used = collectButtonIds(layout);
      const available = defs.filter((d) => !used.has(d.id));
      if (available.length > 0) {
        const availWrap = wrap.createDiv({ cls: "butter-layout-list" });
        availWrap.createEl("div", {
          cls: "butter-layout-list-label",
          text: "Available",
        });
        const availList = availWrap.createDiv({ cls: "butter-layout-rows" });
        for (const def of available) {
          const row = availList.createDiv({
            cls: "butter-layout-row is-available",
          });
          const icon = row.createDiv({ cls: "butter-layout-icon" });
          setIcon(icon, def.icon);
          row.createDiv({ cls: "butter-layout-label", text: def.label });
          const addBtn = row.createEl("button", {
            cls: "butter-layout-action clickable-icon mod-add",
            attr: { "aria-label": `Add ${def.label}`, type: "button" },
          });
          setIcon(addBtn, "plus");
          addBtn.addEventListener("click", (e) => {
            e.preventDefault();
            layout.push({ type: "button", id: def.id });
            void (async () => {
              await saveLayout(layout);
              rerender();
            })();
          });
        }
      }
    };

    rerender();
  }

/** Open a small floating menu anchored to `anchor` listing each
   *  available submenu. Tap a row to invoke `onPick(submenuId)`. */
  export function openMoveToSubmenuMenu(this: ButterSettingTab, anchor: HTMLElement, submenus: Array<Extract<ToolbarLayoutItem, { type: "submenu" }>>, onPick: (submenuId: string) => void | Promise<void>) {
    const menu = activeDocument.createElement("div");
    menu.classList.add("butter-layout-popup-menu");
    for (const sub of submenus) {
      const item = menu.createDiv({ cls: "butter-layout-popup-menu-item" });
      const icn = item.createDiv({ cls: "butter-layout-popup-menu-icon" });
      setIcon(icn, sub.icon || "more-horizontal");
      item.createDiv({
        cls: "butter-layout-popup-menu-label",
        text: sub.label || "Submenu",
      });
      item.addEventListener("click", (e) => {
        e.preventDefault();
        cleanup();
        void onPick(sub.id);
      });
    }
    const rect = anchor.getBoundingClientRect();
    menu.addClass("butter-pos-fixed");
    menu.setCssProps({
      "--butter-pos-top": `${rect.bottom + 4}px`,
      "--butter-pos-left": `${Math.max(8, rect.right - 220)}px`,
    });
    activeDocument.body.appendChild(menu);
    const dismiss = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) cleanup();
    };
    // Close on any scroll - the menu is position:fixed so it would
    // otherwise stay glued to the viewport while its anchor button
    // scrolls away. `true` (capture) so we catch scrolls on inner
    // scrollable containers (the settings pane), not just window.
    const dismissOnScroll = () => cleanup();
    const cleanup = () => {
      menu.remove();
      activeDocument.removeEventListener("mousedown", dismiss);
      activeDocument.removeEventListener("touchstart", dismiss as unknown as EventListener);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
    window.setTimeout(() => {
      activeDocument.addEventListener("mousedown", dismiss);
      activeDocument.addEventListener("touchstart", dismiss as unknown as EventListener);
      window.addEventListener("scroll", dismissOnScroll, true);
    }, 0);
  }

/** Modal for create / edit submenu (icon + label).
   *  Mutates `item` in place and calls onSave when committed. */
  export function openSubmenuEditModal(this: ButterSettingTab, item: Extract<ToolbarLayoutItem, { type: "submenu" }>, onSave: (
      updated: Extract<ToolbarLayoutItem, { type: "submenu" }>,
    ) => void | Promise<void>, isNew = false) {
    const modal = new SubmenuEditModal(this.app, item, isNew, async (updated) => {
      await onSave(updated);
    });
    modal.open();
  }

/** Pointer-event drag-to-reorder with cross-level support.
   *
   * Drop targets fall into three kinds:
   *   • `before` ref-row → insert as the previous sibling of the
   *     ref-row's parent (depth-aware - a ref-row inside a submenu
   *     means we drop into the submenu's children).
   *   • `after`  ref-row → same but after.
   *   • `into`   submenu-row → append as the submenu's last child.
   *
   * Visual: blue line at the top/bottom edge of the ref-row for
   * before/after; accent-tinted background on the submenu row for
   * into. Both work on touch + mouse via pointer events. */
  export function wireDrag(this: ButterSettingTab, handle: HTMLElement, row: HTMLElement, rootLayout: ToolbarLayoutItem[], draggedItemId: string, onCommit: () => void | Promise<void>) {
    const initDrag = (startY: number, pointerType: string) => {
      const list = row.parentElement!;
      const startRect = row.getBoundingClientRect();
      const draggedIsSubmenu = row.dataset.type === "submenu";

      let preventScroll: ((e: TouchEvent) => void) | null = null;
      if (pointerType === "touch") {
        preventScroll = (e) => e.preventDefault();
        activeDocument.addEventListener("touchmove", preventScroll, { passive: false });
      }

      const startListHeight = list.getBoundingClientRect().height;
      list.style.minHeight = `${startListHeight}px`;

      const findScroller = (start: HTMLElement): HTMLElement | null => {
        let cur: HTMLElement | null = start.parentElement;
        while (cur) {
          const style = window.getComputedStyle(cur);
          if ((style.overflowY === "auto" || style.overflowY === "scroll") && cur.scrollHeight > cur.clientHeight) {
            return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      };
      const scroller = findScroller(list);

      const sourceRows = [row];
      if (draggedIsSubmenu) {
        let next = row.nextElementSibling as HTMLElement | null;
        while (next && next.classList.contains("is-nested")) {
          sourceRows.push(next);
          next = next.nextElementSibling as HTMLElement | null;
        }
      }

      const placeholder = activeDocument.createElement("div");
      placeholder.className = "butter-layout-row-placeholder";
      if (row.classList.contains("is-nested")) placeholder.classList.add("is-nested");
      
      let totalHeight = 0;
      sourceRows.forEach(r => totalHeight += r.offsetHeight);
      placeholder.style.height = `${totalHeight}px`;

      const ghost = activeDocument.createElement("div");
      ghost.classList.add("butter-layout-row-ghost");
      ghost.setCssProps({
        "--butter-pos-width": `${startRect.width}px`,
        "--butter-pos-left": `${startRect.left}px`,
        "--butter-pos-top": `${startRect.top}px`,
      });
      
      sourceRows.forEach(r => {
        const clone = r.cloneNode(true) as HTMLElement;
        clone.classList.remove("is-dragging");
        ghost.appendChild(clone);
        r.hide();
      });
      activeDocument.body.appendChild(ghost);

      row.before(placeholder);

      const flipSwap = (action: () => void) => {
        action();
      };

      type DropTarget = { kind: "before" | "after"; refRowId: string } | { kind: "into"; submenuId: string };
      let target: DropTarget | null = null;
      let lastPointerY = startY;
      let currentIntoSubmenu: HTMLElement | null = null;

      const processMove = (pointerY: number) => {
        lastPointerY = pointerY;
        ghost.style.top = `${startRect.top + pointerY - startY}px`;

        const elements = Array.from(list.children).filter(
          c => c.classList.contains("butter-layout-row") && (c as HTMLElement).style.display !== "none" && c !== placeholder
        ) as HTMLElement[];

        let targetKind: "before" | "after" | "into" | null = null;
        let targetEl: HTMLElement | null = null;

        if (currentIntoSubmenu) {
           const headerRect = currentIntoSubmenu.getBoundingClientRect();
           const placeholderRect = placeholder.getBoundingClientRect();
           if (pointerY >= headerRect.top && pointerY <= placeholderRect.bottom) {
               targetKind = "into";
               targetEl = currentIntoSubmenu;
           }
        }

        if (!targetKind) {
           for (let i = 0; i < elements.length; i++) {
              const el = elements[i];
              const rect = el.getBoundingClientRect();
              
              if (!draggedIsSubmenu && el.dataset.type === "submenu") {
                const margin = rect.height * 0.3;
                if (pointerY >= rect.top + margin && pointerY <= rect.bottom - margin) {
                  targetKind = "into";
                  targetEl = el;
                  break;
                }
              }

              const mid = rect.top + rect.height / 2;
              if (pointerY < mid) {
                targetKind = "before";
                targetEl = el;
                break;
              }
           }
        }

        if (!targetKind && elements.length > 0) {
           targetKind = "after";
           targetEl = elements[elements.length - 1];
        }

        if (targetKind && targetEl) {
           let desiredNextSibling: Node | null = null;
           let desiredIsNested = false;

           if (targetKind === "into") {
              desiredIsNested = true;
              let next = targetEl.nextElementSibling as HTMLElement | null;
              while (next && next.classList.contains("is-nested") && next.style.display !== "none" && next !== placeholder) {
                 next = next.nextElementSibling as HTMLElement | null;
              }
              desiredNextSibling = next; 
           } else if (targetKind === "before") {
              desiredNextSibling = targetEl;
              desiredIsNested = targetEl.classList.contains("is-nested");
           } else if (targetKind === "after") {
              desiredNextSibling = targetEl.nextElementSibling;
              desiredIsNested = targetEl.classList.contains("is-nested");
              if (targetEl.dataset.type === "submenu") {
                 let next = targetEl.nextElementSibling as HTMLElement | null;
                 while (next && next.classList.contains("is-nested") && next.style.display !== "none" && next !== placeholder) {
                    next = next.nextElementSibling as HTMLElement | null;
                 }
                 desiredNextSibling = next;
                 desiredIsNested = false;
              }
           }

           if (placeholder.nextSibling !== desiredNextSibling || placeholder.classList.contains("is-nested") !== desiredIsNested) {
              flipSwap(() => {
                 if (desiredNextSibling) {
                    list.insertBefore(placeholder, desiredNextSibling);
                 } else {
                    list.appendChild(placeholder);
                 }
                 placeholder.classList.toggle("is-nested", desiredIsNested);
              });
           }

           if (targetKind === "into") {
              if (currentIntoSubmenu !== targetEl) {
                  currentIntoSubmenu?.classList.remove("is-drop-into");
                  targetEl.classList.add("is-drop-into");
                  currentIntoSubmenu = targetEl;
              }
              target = { kind: "into", submenuId: targetEl.dataset.itemId! };
           } else {
              if (currentIntoSubmenu) {
                  currentIntoSubmenu.classList.remove("is-drop-into");
                  currentIntoSubmenu = null;
              }
              target = { kind: targetKind, refRowId: targetEl.dataset.itemId! };
           }
        }
      };

      const EDGE_ZONE_PX = 60;
      const SCROLL_SPEED_PX = 12;
      let autoScrollDir: -1 | 0 | 1 = 0;
      let autoScrollFrame: number | null = null;
      const tickAutoScroll = () => {
        if (!scroller || autoScrollDir === 0) {
          autoScrollFrame = null;
          return;
        }
        const before = scroller.scrollTop;
        scroller.scrollTop = before + autoScrollDir * SCROLL_SPEED_PX;
        if (scroller.scrollTop === before) {
          autoScrollDir = 0;
          autoScrollFrame = null;
          return;
        }
        processMove(lastPointerY);
        autoScrollFrame = window.requestAnimationFrame(tickAutoScroll);
      };

      const onMove = (mv: PointerEvent) => {
        processMove(mv.clientY);
        if (scroller) {
          const rect = scroller.getBoundingClientRect();
          if (mv.clientY < rect.top + EDGE_ZONE_PX) autoScrollDir = -1;
          else if (mv.clientY > rect.bottom - EDGE_ZONE_PX) autoScrollDir = 1;
          else autoScrollDir = 0;
          if (autoScrollDir !== 0 && autoScrollFrame === null) {
            autoScrollFrame = window.requestAnimationFrame(tickAutoScroll);
          }
        }
      };

      const onUp = (): void => {
        activeDocument.removeEventListener("pointermove", onMove);
        activeDocument.removeEventListener("pointerup", onUp);
        if (preventScroll) {
          activeDocument.removeEventListener("touchmove", preventScroll);
        }
        autoScrollDir = 0;
        if (autoScrollFrame !== null) {
          cancelAnimationFrame(autoScrollFrame);
          autoScrollFrame = null;
        }

        list.style.removeProperty("min-height");
        const isNestedNow = placeholder.classList.contains("is-nested");
        const insertNode = placeholder.nextSibling;
        sourceRows.forEach(r => {
          r.classList.toggle("is-nested", isNestedNow);
          if (insertNode) list.insertBefore(r, insertNode);
          else list.appendChild(r);
          r.show();
        });

        ghost.remove();
        placeholder.remove();
        if (currentIntoSubmenu) currentIntoSubmenu.classList.remove("is-drop-into");

        if (!target) return;

        const removed = removeItem(rootLayout, draggedItemId);
        if (!removed) return;

        if (target.kind === "into") {
          const found = locate(rootLayout, target.submenuId);
          if (!found) return;
          const sub = found.parent[found.index];
          if (sub.type !== "submenu") return;
          sub.children.push(removed);
        } else {
          const ref = locate(rootLayout, target.refRowId);
          if (!ref) return;
          const insertAt = target.kind === "before" ? ref.index : ref.index + 1;
          ref.parent.splice(insertAt, 0, removed);
        }

        void onCommit();
      };

      activeDocument.addEventListener("pointermove", onMove);
      activeDocument.addEventListener("pointerup", onUp);
      
      processMove(startY);
    };

    handle.addEventListener("pointerdown", (downEv) => {
      if (downEv.pointerType === "touch") return;
      downEv.preventDefault();
      handle.setPointerCapture(downEv.pointerId);
      initDrag(downEv.clientY, downEv.pointerType);
    });

    const LONG_PRESS_MS = 400;
    const MOVE_TOLERANCE = 8;
    let longPressTimer: number | null = null;
    let pressStartY = 0;
    let pressStartX = 0;
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    row.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "touch") return;
      const t = ev.target as HTMLElement;
      if (t.closest(".butter-layout-row-actions")) return;
      pressStartY = ev.clientY;
      pressStartX = ev.clientX;
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        try { navigator.vibrate?.(10); } catch { /* haptics unsupported */ }
        row.setPointerCapture(ev.pointerId);
        initDrag(pressStartY, "touch");
      }, LONG_PRESS_MS);
    });
    row.addEventListener("pointermove", (ev) => {
      if (longPressTimer === null || ev.pointerType !== "touch") return;
      const dx = Math.abs(ev.clientX - pressStartX);
      const dy = Math.abs(ev.clientY - pressStartY);
      if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) cancelLongPress();
    });
    row.addEventListener("pointerup", cancelLongPress);
    row.addEventListener("pointercancel", cancelLongPress);
  }