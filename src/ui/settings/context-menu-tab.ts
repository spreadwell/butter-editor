import { Setting, setIcon } from "obsidian";
import type { ButterSettingTab } from "../settings-tab";
import type { ToolbarLayoutItem } from "../../main";
import {
  CONTEXT_MENU_ENTRY_DEFS,
  CONTEXT_MENU_NATIVE_AVAILABLE_DEFS,
  cloneContextMenuLayout,
  contextMenuDefaultLayout,
  contextMenuFullLayout,
  contextMenuQuickGroup,
  contextMenuSimpleLayout,
  normalizeContextMenuLayout,
  type ContextMenuEntryId,
} from "../../editor/context-menu-layout";
import { MAIN_TOOLBAR_BUTTON_DEFS } from "../toolbar";
import { countButtonPlacements, groupActionDefinitions, layoutItemKey, locate, newId } from "../toolbar-layout";
import { commandActionIcon, commandActionLabel } from "../command-actions";
import { tx, txKnown, type MessageKey } from "../../i18n";
import { createAvailableActionCatalog, createAvailableActionCategory } from "./available-action-catalog";

type ContextPreset = {
  name: MessageKey;
  desc: MessageKey;
  layout: () => ToolbarLayoutItem[];
};

const PRESETS: readonly ContextPreset[] = [
  {
    name: "Simple",
    desc: "Clipboard essentials, formatting, and compatible plugin actions.",
    layout: contextMenuSimpleLayout,
  },
  {
    name: "Default",
    desc: "Native-like groups with a five-slot Quick actions section.",
    layout: contextMenuDefaultLayout,
  },
  {
    name: "Full",
    desc: "Every built-in action exposed directly in one long menu.",
    layout: contextMenuFullLayout,
  },
];

const CONTEXT_MENU_AVAILABLE_DEFS = [
  ...MAIN_TOOLBAR_BUTTON_DEFS,
  ...CONTEXT_MENU_NATIVE_AVAILABLE_DEFS,
];

const QUICK_BUILTIN_IDS = new Set<ContextMenuEntryId>(
  CONTEXT_MENU_AVAILABLE_DEFS
    .filter((definition) =>
      !["spelling-actions", "plugin-actions", "obsidian-actions"].includes(definition.id),
    )
    .map((definition) => definition.id),
);
const SINGLETON_CONTEXT_ACTIONS = new Set<ContextMenuEntryId>([
  "plugin-actions",
  "obsidian-actions",
  "spelling-actions",
]);

export function renderContextMenu(this: ButterSettingTab, root: HTMLElement): void {
  const applyLayout = async (layout: ToolbarLayoutItem[]): Promise<void> => {
    this.plugin.settings.contextMenuLayout = normalizeContextMenuLayout(layout);
    this.plugin.settings.contextMenuLayoutVersion = 4;
    await this.plugin.saveSettings();
    this.refreshSettingsUi();
  };

  const presetItems = this.createSettingGroup(
    root,
    "Presets",
  );
  for (const preset of PRESETS) {
    const row = new Setting(presetItems).setName(tx(preset.name)).setDesc(tx(preset.desc));
    row.addButton((button) => {
      button.setButtonText(txKnown("Apply")).onClick(() => applyLayout(preset.layout()));
      if (preset.name === "Default") button.setCta();
    });
  }

  const layoutItems = this.createSettingGroup(
    root,
    "Menu layout",
  );
  new Setting(layoutItems)
    .setName(txKnown("Reset to defaults"))
    .setDesc(txKnown("Restore the unified default menu tree."))
    .addButton((button) => button
      .setButtonText(txKnown("Reset"))
      .setIcon("rotate-ccw")
      .onClick(() => applyLayout(contextMenuDefaultLayout())));

  const layoutEditor = layoutItems.createDiv({ cls: "butter-layout-editor" });
  const definitionLookup = new Map(
    [...CONTEXT_MENU_ENTRY_DEFS, ...CONTEXT_MENU_AVAILABLE_DEFS]
      .map((definition) => [definition.id, definition]),
  );
  let renderLayout = () => {};
  const availableCategoryOpen = new Map<string, boolean>();

  const commitLayout = async (layout: ToolbarLayoutItem[]): Promise<void> => {
    this.plugin.settings.contextMenuLayout = normalizeContextMenuLayout(layout);
    this.plugin.settings.contextMenuLayoutVersion = 4;
    renderLayout();
    await this.plugin.saveSettings();
  };

  const openBuiltinPicker = (
    anchor: HTMLElement,
    ids: readonly ContextMenuEntryId[],
    onChoose: (id: ContextMenuEntryId) => void,
  ): void => {
    const popup = activeWindow.createDiv({ cls: "butter-layout-popup-menu" });
    for (const id of ids) {
      const definition = definitionLookup.get(id);
      if (!definition) continue;
      const item = popup.createDiv({ cls: "butter-layout-popup-menu-item" });
      const icon = item.createDiv({ cls: "butter-layout-popup-menu-icon" });
      setIcon(icon, definition.icon);
      item.createDiv({ cls: "butter-layout-popup-menu-label", text: txKnown(definition.label) });
      item.addEventListener("click", () => {
        cleanup();
        onChoose(id);
      });
    }
    const rect = anchor.getBoundingClientRect();
    popup.addClass("butter-pos-fixed");
    popup.setCssProps({
      "--butter-pos-top": `${rect.bottom + 4}px`,
      "--butter-pos-left": `${Math.max(8, Math.min(window.innerWidth - 228, rect.left))}px`,
    });
    activeDocument.body.appendChild(popup);
    const dismiss = (event: MouseEvent) => {
      if (!popup.contains(event.target as Node)) cleanup();
    };
    const cleanup = () => {
      popup.remove();
      activeDocument.removeEventListener("mousedown", dismiss);
      window.removeEventListener("scroll", cleanup, true);
    };
    window.setTimeout(() => {
      activeDocument.addEventListener("mousedown", dismiss);
      window.addEventListener("scroll", cleanup, true);
    }, 0);
  };

  renderLayout = (): void => {
    layoutEditor.empty();
    const layout = cloneContextMenuLayout(this.plugin.getContextMenuLayout());
    const shownWrap = layoutEditor.createDiv({ cls: "butter-layout-list" });
    shownWrap.createDiv({ cls: "butter-layout-list-label", text: txKnown("In menu") });
    const shownRows = shownWrap.createDiv({
      cls: "butter-layout-rows",
      attr: { "data-list": "on" },
    });

    const canDropInto = (
      submenu: Extract<ToolbarLayoutItem, { type: "submenu" }>,
      dragged: ToolbarLayoutItem,
    ): boolean => {
      if (dragged.type === "submenu" || dragged.type === "overflow") return false;
      if (dragged.type === "button" && dragged.id === "obsidian-actions") return false;
      if (submenu.presentation !== "quick") return true;
      if (dragged.type === "separator") return false;
      if (dragged.type === "button" && !QUICK_BUILTIN_IDS.has(dragged.id)) return false;
      const alreadyInside = submenu.children.some(
        (child) => layoutItemKey(child) === layoutItemKey(dragged),
      );
      return alreadyInside || submenu.children.length < 5;
    };

    const renderRow = (
      item: ToolbarLayoutItem,
      parent: ToolbarLayoutItem[],
      depth: number,
    ): void => {
      const quick = item.type === "submenu" && item.presentation === "quick";
      const itemKey = layoutItemKey(item);
      const row = shownRows.createDiv({
        cls: `butter-layout-row${item.type === "separator" ? " is-separator" : ""}${depth ? " is-nested" : ""}${quick ? " is-quick-actions" : ""}`,
        attr: {
          "data-item-id": itemKey,
          "data-depth": String(depth),
          "data-type": item.type,
        },
      });
      const handle = row.createEl("button", {
        cls: "butter-layout-handle clickable-icon",
        attr: { type: "button", "aria-label": txKnown("Drag to reorder") },
      });
      setIcon(handle, "grip-vertical");
      handle.dataset.dragHandle = "1";
      const icon = row.createDiv({ cls: "butter-layout-icon" });
      const label = row.createDiv({ cls: "butter-layout-label" });

      if (item.type === "separator") {
        label.setText(txKnown("Divider"));
        label.classList.add("butter-layout-sep-label");
      } else if (item.type === "button") {
        const definition = definitionLookup.get(item.id);
        setIcon(icon, definition?.icon ?? "circle-help");
        label.setText(definition ? txKnown(definition.label) : item.id);
        if (SINGLETON_CONTEXT_ACTIONS.has(item.id)) {
          label.createSpan({ cls: "butter-context-dynamic-label", text: ` · ${txKnown("dynamic")}` });
        }
      } else if (item.type === "command") {
        setIcon(icon, commandActionIcon(this.app, item));
        label.setText(commandActionLabel(this.app, item));
        row.classList.add("is-command");
        if (!this.app.commands?.commands?.[item.commandId]) row.classList.add("is-missing");
      } else if (item.type === "submenu") {
        setIcon(icon, quick ? "zap" : item.icon || "more-horizontal");
        label.setText(txKnown(quick ? "Quick actions" : item.label || "Submenu"));
        if (quick) {
          label.createSpan({
            cls: "butter-context-quick-capacity",
            text: ` ${item.children.length}/5`,
          });
        }
      }

      const actions = row.createDiv({ cls: "butter-layout-row-actions" });
      if (item.type === "submenu" && !quick) {
        const edit = actions.createEl("button", {
          cls: "butter-layout-action clickable-icon",
          attr: { type: "button", "aria-label": txKnown("Edit submenu") },
        });
        setIcon(edit, "pencil");
        edit.addEventListener("click", () => this.openSubmenuEditModal(item, async (updated) => {
          const found = locate(layout, itemKey);
          if (!found) return;
          found.parent[found.index] = updated;
          await commitLayout(layout);
        }));
      }
      if (item.type === "submenu" && quick && item.children.length < 5) {
        const quickIds = Array.from(QUICK_BUILTIN_IDS);
        const addBuiltin = actions.createEl("button", {
          cls: "butter-layout-action clickable-icon",
          attr: { type: "button", "aria-label": txKnown("Add built-in quick action") },
        });
        setIcon(addBuiltin, "plus");
        addBuiltin.addEventListener("click", () => openBuiltinPicker(addBuiltin, quickIds, (id) => {
          item.children.push({ type: "button", id, instanceId: newId("ctx-button") });
          void commitLayout(layout);
        }));
        const addCommand = actions.createEl("button", {
          cls: "butter-layout-action clickable-icon",
          attr: { type: "button", "aria-label": txKnown("Add command quick action") },
        });
        setIcon(addCommand, "terminal");
        addCommand.addEventListener("click", () => this.openCommandPicker((command) => {
          const commandItem: Extract<ToolbarLayoutItem, { type: "command" }> = {
            type: "command",
            id: newId("ctx-command"),
            commandId: command.id,
            label: command.name,
            icon: command.icon || "terminal",
          };
          this.openCommandActionEditModal(commandItem, async (configured) => {
            item.children.push(configured);
            await commitLayout(layout);
          });
        }));
      }
      if (item.type === "command") {
        const edit = actions.createEl("button", {
          cls: "butter-layout-action clickable-icon",
          attr: { type: "button", "aria-label": txKnown("Edit command action") },
        });
        setIcon(edit, "pencil");
        edit.addEventListener("click", () => this.openCommandActionEditModal(item, async (updated) => {
          const found = locate(layout, itemKey);
          if (!found) return;
          found.parent[found.index] = updated;
          await commitLayout(layout);
        }));
      }

      if ((item.type === "button" || item.type === "command" || item.type === "separator") && depth === 0) {
        const submenus = layout.filter(
          (entry): entry is Extract<ToolbarLayoutItem, { type: "submenu" }> =>
            entry.type === "submenu" && canDropInto(entry, item),
        );
        if (submenus.length) {
          const move = actions.createEl("button", {
            cls: "butter-layout-action clickable-icon",
            attr: { type: "button", "aria-label": txKnown("Move into submenu") },
          });
          setIcon(move, "folder-input");
          move.addEventListener("click", () => this.openMoveToSubmenuMenu(move, submenus, async (submenuId) => {
            const target = layout.find(
              (entry): entry is Extract<ToolbarLayoutItem, { type: "submenu" }> =>
                entry.type === "submenu" && entry.id === submenuId,
            );
            const index = parent.findIndex((entry) => layoutItemKey(entry) === itemKey);
            if (!target || index < 0 || !canDropInto(target, item)) return;
            parent.splice(index, 1);
            target.children.push(item);
            await commitLayout(layout);
          }));
        }
      } else if (depth > 0) {
        const moveOut = actions.createEl("button", {
          cls: "butter-layout-action clickable-icon",
          attr: { type: "button", "aria-label": txKnown("Move out of submenu") },
        });
        setIcon(moveOut, "folder-output");
        moveOut.addEventListener("click", () => {
          const index = parent.findIndex((entry) => layoutItemKey(entry) === itemKey);
          if (index < 0) return;
          parent.splice(index, 1);
          layout.push(item);
          void commitLayout(layout);
        });
      }

      const remove = actions.createEl("button", {
        cls: "butter-layout-action clickable-icon mod-danger",
        attr: { type: "button", "aria-label": txKnown("Remove from context menu") },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        const index = parent.findIndex((entry) => layoutItemKey(entry) === itemKey);
        if (index >= 0) parent.splice(index, 1);
        void commitLayout(layout);
      });

      this.wireDrag(handle, row, layout, itemKey, () => commitLayout(layout), { canDropInto });
    };

    for (const item of layout) {
      renderRow(item, layout, 0);
      if (item.type !== "submenu") continue;
      for (const child of item.children) renderRow(child, item.children, 1);
      if (item.children.length === 0) {
        const empty = shownRows.createDiv({
          cls: "butter-layout-row is-nested is-empty",
          attr: { "data-empty-for": item.id, "data-depth": "1", "data-type": "empty" },
        });
        empty.createDiv({
          cls: "butter-layout-empty",
          text: item.presentation === "quick"
            ? "Empty Quick actions group — add up to five actions."
            : "Empty submenu — move actions here.",
        });
      }
    }

    const addRow = shownWrap.createDiv({ cls: "butter-layout-add-row" });
    const addControl = (icon: string, label: string, onClick: () => void) => {
      const button = addRow.createEl("button", { cls: "butter-layout-add-btn", attr: { type: "button" } });
      const iconEl = button.createSpan({ cls: "butter-layout-add-btn-icon" });
      setIcon(iconEl, icon);
      button.createSpan({ text: label });
      button.addEventListener("click", onClick);
    };
    addControl("terminal", "Command", () => this.openCommandPicker((command) => {
      const item: Extract<ToolbarLayoutItem, { type: "command" }> = {
        type: "command",
        id: newId("ctx-command"),
        commandId: command.id,
        label: command.name,
        icon: command.icon || "terminal",
      };
      this.openCommandActionEditModal(item, async (configured) => {
        layout.push(configured);
        await commitLayout(layout);
      });
    }));
    addControl("folder", "Submenu", () => this.openSubmenuEditModal({
      type: "submenu",
      id: newId("ctx-sub"),
      label: "New submenu",
      icon: "more-horizontal",
      children: [],
    }, async (created) => {
      layout.push(created);
      await commitLayout(layout);
    }, true));
    addControl("zap", "Quick actions", () => {
      layout.push(contextMenuQuickGroup([]));
      void commitLayout(layout);
    });
    addControl("minus", "Divider", () => {
      layout.push({ type: "separator", id: newId("ctx-sep") });
      void commitLayout(layout);
    });

    const usageCounts = countButtonPlacements(layout);
    const available = CONTEXT_MENU_AVAILABLE_DEFS.filter(
      (definition) =>
        !SINGLETON_CONTEXT_ACTIONS.has(definition.id) || !usageCounts.has(definition.id),
    );
    if (available.length > 0) {
      const availableWrap = createAvailableActionCatalog(
        layoutEditor,
        txKnown("Available actions"),
        available.length,
      );
      for (const [group, definitions] of groupActionDefinitions(available)) {
        const category = createAvailableActionCategory(
          availableWrap,
          txKnown(group),
          definitions.length,
          availableCategoryOpen.get(group) === true,
          (open) => { availableCategoryOpen.set(group, open); },
        );
        const availableRows = category.createDiv({ cls: "butter-layout-rows" });
        for (const definition of definitions) {
          const row = availableRows.createDiv({ cls: "butter-layout-row is-available" });
          const icon = row.createDiv({ cls: "butter-layout-icon" });
          setIcon(icon, definition.icon);
          const label = row.createDiv({ cls: "butter-layout-label", text: txKnown(definition.label) });
          const usageCount = usageCounts.get(definition.id) ?? 0;
          if (usageCount > 0) {
            label.createSpan({ cls: "butter-layout-usage-count", text: ` · ${usageCount}` });
          }
          const add = row.createEl("button", {
            cls: "butter-layout-action clickable-icon mod-add",
            attr: { type: "button", "aria-label": `${txKnown("Show")} ${txKnown(definition.label)}` },
          });
          setIcon(add, "plus");
          add.addEventListener("click", () => {
            layout.push({ type: "button", id: definition.id, instanceId: newId("ctx-button") });
            void commitLayout(layout);
          });
        }
      }
    }
  };
  renderLayout();
}
