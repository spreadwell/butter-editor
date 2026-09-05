import type { Layout, LayoutItem } from "../ui/toolbar-layout";
import { cloneLayout, newId } from "../ui/toolbar-layout";
import type { MessageKey } from "../i18n";

export const CONTEXT_MENU_ENTRY_DEFS = [
  { id: "undo", label: "Undo", icon: "undo-2" },
  { id: "redo", label: "Redo", icon: "redo-2" },
  { id: "cut", label: "Cut", icon: "scissors" },
  { id: "copy", label: "Copy", icon: "copy" },
  { id: "paste", label: "Paste", icon: "clipboard-check" },
  { id: "paste-plain", label: "Paste as plain text", icon: "clipboard-type" },
  { id: "select-all", label: "Select all", icon: "text-select" },
  // Legacy saved layouts may still contain this synthetic entry. Normalization
  // expands it into the editable Formatting submenu below.
  { id: "formatting", label: "Formatting", icon: "paintbrush" },
  { id: "bold", label: "Bold", icon: "bold" },
  { id: "italic", label: "Italic", icon: "italic" },
  { id: "strikethrough", label: "Strikethrough", icon: "strikethrough" },
  { id: "highlight", label: "Highlight", icon: "highlighter" },
  { id: "inline-code", label: "Inline code", icon: "code-2" },
  { id: "add-link", label: "Add link", icon: "link" },
  { id: "clear-formatting", label: "Clear formatting", icon: "remove-formatting" },
  { id: "insert", label: "Insert", icon: "plus-circle" },
  { id: "spelling-actions", label: "Spelling suggestions", icon: "spell-check-2" },
  { id: "obsidian-actions", label: "Obsidian actions", icon: "app-window" },
  { id: "plugin-actions", label: "Plugin actions", icon: "plug" },
] as const satisfies readonly { id: string; label: MessageKey; icon: string }[];

export type ContextMenuEntryId = string;

/**
 * The context-menu customizer exposes the same editor buttons as Toolbar,
 * plus the native clipboard and plugin-contribution actions that only make
 * sense in a context menu. Legacy synthetic entries remain valid for saved
 * layouts, but are not offered as new actions.
 */
export const CONTEXT_MENU_NATIVE_AVAILABLE_DEFS = CONTEXT_MENU_ENTRY_DEFS
  .filter((item) =>
    ["cut", "copy", "paste", "paste-plain", "select-all", "spelling-actions", "obsidian-actions", "plugin-actions"].includes(item.id),
  )
  .map((item) => ({
    ...item,
    group: ["spelling-actions", "obsidian-actions", "plugin-actions"].includes(item.id)
      ? "Dynamic actions"
      : "Clipboard",
  }));

// Kept dependency-free because layout migration runs in small Node contract
// tests without Obsidian's runtime. The settings and renderer use Toolbar's
// canonical metadata; this list only defines which saved button IDs survive
// normalization.
const TOOLBAR_ENTRY_IDS = [
  "paragraph", "heading-1", "heading-2", "heading-3", "heading-4", "heading-5", "heading-6",
  "bold", "italic", "strikethrough", "code", "highlight", "text-color", "link",
  "clear-formatting", "bullet-list", "ordered-list", "task-list",
  "indent-list", "outdent-list", "blockquote", "code-block", "hr", "table", "image", "video",
  "insert-base-inline", "insert-base-embed", "callout-note", "callout-abstract", "callout-info",
  "callout-tip", "callout-success", "callout-question", "callout-warning", "callout-failure",
  "callout-danger", "callout-bug", "callout-example", "callout-quote", "undo", "redo",
  "insert", "turn-into", "block-actions",
] as const;

/** Deprecated v1 settings types retained solely for one-time migration. */
export type ContextMenuQuickActionId = "bold" | "italic" | "strikethrough" | "highlight" | "add-link";
export type ContextMenuQuickActionSlots = Array<ContextMenuQuickActionId | null>;
export const DEFAULT_CONTEXT_MENU_QUICK_ACTIONS: ContextMenuQuickActionSlots =
  ["bold", "italic", "strikethrough", "highlight", "add-link"];

const ENTRY_IDS = new Set<string>([
  ...CONTEXT_MENU_ENTRY_DEFS.map((item) => item.id),
  ...TOOLBAR_ENTRY_IDS,
]);
const LEGACY_QUICK_IDS = new Set<string>(
  DEFAULT_CONTEXT_MENU_QUICK_ACTIONS.filter((id): id is ContextMenuQuickActionId => id !== null),
);

function contextButton(id: string): Extract<LayoutItem, { type: "button" }> {
  return { type: "button", id, instanceId: newId("ctx-button") };
}

export function contextMenuQuickGroup(
  children: Layout = ["bold", "italic", "strikethrough", "highlight", "link"]
    .map((id) => contextButton(id)),
): Extract<LayoutItem, { type: "submenu" }> {
  return {
    type: "submenu",
    id: newId("ctx-quick"),
    label: "Quick actions",
    icon: "zap",
    presentation: "quick",
    children,
  };
}

export function contextMenuFormattingGroup(
  includeLink = true,
): Extract<LayoutItem, { type: "submenu" }> {
  return {
    type: "submenu",
    id: newId("ctx-sub"),
    label: "Formatting",
    icon: "paintbrush",
    children: [
      contextButton("bold"),
      contextButton("italic"),
      contextButton("strikethrough"),
      contextButton("highlight"),
      contextButton("code"),
      { type: "separator", id: newId("ctx-sep") },
      ...(includeLink ? [contextButton("link")] : []),
      contextButton("clear-formatting"),
    ],
  };
}

/** Current native-like menu with an initial movable Quick actions group. */
export function contextMenuDefaultLayout(): Layout {
  return [
    contextButton("spelling-actions"),
    { type: "separator", id: newId("ctx-sep") },
    contextMenuQuickGroup([
      contextButton("bold"),
      contextButton("italic"),
      contextButton("highlight"),
      contextButton("link"),
      contextButton("code"),
    ]),
    { type: "separator", id: newId("ctx-sep") },
    contextButton("insert"),
    contextButton("turn-into"),
    contextMenuFormattingGroup(false),
    contextButton("block-actions"),
    { type: "separator", id: newId("ctx-sep") },
    contextButton("cut"),
    contextButton("copy"),
    contextButton("paste"),
    contextButton("paste-plain"),
    contextButton("select-all"),
    { type: "separator", id: newId("ctx-sep") },
    contextButton("undo"),
    contextButton("redo"),
    { type: "separator", id: newId("ctx-sep") },
    contextButton("obsidian-actions"),
    contextButton("plugin-actions"),
  ];
}

export function contextMenuSimpleLayout(): Layout {
  return [
    contextButton("spelling-actions"),
    { type: "separator", id: newId("ctx-sep") },
    contextMenuQuickGroup([
      contextButton("bold"),
      contextButton("italic"),
      contextButton("link"),
    ]),
    { type: "separator", id: newId("ctx-sep") },
    contextButton("cut"),
    contextButton("copy"),
    contextButton("paste"),
    { type: "separator", id: newId("ctx-sep") },
    contextButton("undo"),
    contextButton("redo"),
    { type: "separator", id: newId("ctx-sep") },
    contextButton("obsidian-actions"),
    contextButton("plugin-actions"),
  ];
}

export function contextMenuFullLayout(): Layout {
  const groups = [
    ["spelling-actions"],
    ["undo", "redo"],
    ["cut", "copy", "paste", "paste-plain", "select-all"],
    ["paragraph", "heading-1", "heading-2", "heading-3", "heading-4", "heading-5", "heading-6"],
    ["bold", "italic", "strikethrough", "code", "highlight", "text-color", "link", "clear-formatting"],
    ["bullet-list", "ordered-list", "task-list", "indent-list", "outdent-list", "blockquote", "code-block", "hr"],
    ["table", "image", "video", "insert-base-inline", "insert-base-embed"],
    [
      "callout-note", "callout-abstract", "callout-info", "callout-tip",
      "callout-success", "callout-question", "callout-warning", "callout-failure",
      "callout-danger", "callout-bug", "callout-example", "callout-quote",
    ],
    ["insert", "turn-into", "block-actions"],
    ["obsidian-actions", "plugin-actions"],
  ];
  const layout: LayoutItem[] = [];
  groups.forEach((group, index) => {
    if (index > 0) layout.push({ type: "separator", id: newId("ctx-sep") });
    for (const id of group) layout.push(contextButton(id));
  });
  return layout;
}

const cleanString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

function normalizeCommand(candidate: Record<string, unknown>): LayoutItem | null {
  const commandId = cleanString(candidate.commandId, "");
  if (!commandId) return null;
  return {
    type: "command",
    id: cleanString(candidate.id, newId("ctx-command")),
    commandId,
    label: cleanString(candidate.label, commandId),
    icon: cleanString(candidate.icon, "terminal"),
  };
}

/** Canonicalize retired action IDs without dropping user placements. */
const canonicalButtonId = (id: string): string => {
  if (id === "block-types") return "turn-into";
  if (id === "insert-link-md") return "link";
  return id;
};
const SINGLETON_BUTTON_IDS = new Set(["spelling-actions", "plugin-actions", "obsidian-actions"]);

function normalizeChildren(
  value: unknown,
  options: { quick: boolean; seenSingletons: Set<string>; seenIds: Set<string> },
): Layout {
  if (!Array.isArray(value)) return [];
  const result: Layout = [];
  let pendingSeparator: string | null = null;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.type === "separator") {
      if (!options.quick && result.length > 0 && pendingSeparator === null) {
        pendingSeparator = cleanString(candidate.id, newId("ctx-sep"));
      }
      continue;
    }
    let normalized: LayoutItem | null = null;
    if (candidate.type === "command") {
      normalized = normalizeCommand(candidate);
    } else if (candidate.type === "button" && typeof candidate.id === "string") {
      const id = canonicalButtonId(candidate.id);
      if (!ENTRY_IDS.has(id) || id === "formatting") continue;
      if (options.quick && SINGLETON_BUTTON_IDS.has(id)) continue;
      if (id === "obsidian-actions" || id === "spelling-actions") continue;
      if (SINGLETON_BUTTON_IDS.has(id)) {
        if (options.seenSingletons.has(id)) continue;
        options.seenSingletons.add(id);
      }
      normalized = {
        type: "button",
        id,
        instanceId: cleanString(candidate.instanceId, newId("ctx-button")),
      };
    }
    if (!normalized) continue;
    const placementId = normalized.type === "button"
      ? normalized.instanceId ?? normalized.id
      : normalized.id;
    if (options.seenIds.has(placementId)) {
      if (normalized.type === "button") normalized.instanceId = newId("ctx-button");
      else normalized.id = newId("ctx-command");
    }
    options.seenIds.add(normalized.type === "button" ? normalized.instanceId ?? normalized.id : normalized.id);
    if (pendingSeparator && result.length > 0) {
      if (options.seenIds.has(pendingSeparator)) pendingSeparator = newId("ctx-sep");
      options.seenIds.add(pendingSeparator);
      result.push({ type: "separator", id: pendingSeparator });
    }
    pendingSeparator = null;
    result.push(normalized);
    if (options.quick && result.length === 5) break;
  }
  return result;
}

/** Sanitize the editable context-menu tree. Context menus support one nesting
 * level, reusable actions, repeatable Quick groups, and singleton dynamic slots. */
export function normalizeContextMenuLayout(value: unknown): Layout {
  if (!Array.isArray(value)) return contextMenuDefaultLayout();
  const result: Layout = [];
  const seenSingletons = new Set<string>();
  const seenIds = new Set<string>();
  let pendingSeparator: string | null = null;

  const append = (item: LayoutItem) => {
    if (pendingSeparator && result.length > 0) {
      if (seenIds.has(pendingSeparator)) pendingSeparator = newId("ctx-sep");
      seenIds.add(pendingSeparator);
      result.push({ type: "separator", id: pendingSeparator });
    }
    pendingSeparator = null;
    const placementId = item.type === "button" ? item.instanceId ?? item.id : item.id;
    if (seenIds.has(placementId)) {
      if (item.type === "button") item.instanceId = newId("ctx-button");
      else item.id = newId(item.type === "command" ? "ctx-command" : "ctx-item");
    }
    seenIds.add(item.type === "button" ? item.instanceId ?? item.id : item.id);
    result.push(item);
  };

  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.type === "separator") {
      if (result.length > 0 && pendingSeparator === null) {
        pendingSeparator = cleanString(candidate.id, newId("ctx-sep"));
      }
      continue;
    }
    if (candidate.type === "command") {
      const command = normalizeCommand(candidate);
      if (command) append(command);
      continue;
    }
    if (candidate.type === "button" && typeof candidate.id === "string") {
      if (candidate.id === "formatting") {
        const formatting = contextMenuFormattingGroup();
        formatting.children = normalizeChildren(formatting.children, {
          quick: false,
          seenSingletons,
          seenIds,
        });
        append(formatting);
      } else {
        const id = canonicalButtonId(candidate.id);
        if (!ENTRY_IDS.has(id)) continue;
        if (SINGLETON_BUTTON_IDS.has(id)) {
          if (seenSingletons.has(id)) continue;
          seenSingletons.add(id);
        }
        append({
          type: "button",
          id,
          instanceId: cleanString(candidate.instanceId, newId("ctx-button")),
        });
      }
      continue;
    }
    if (candidate.type !== "submenu" || !Array.isArray(candidate.children)) continue;
    const quick = candidate.presentation === "quick";
    const submenu: Extract<LayoutItem, { type: "submenu" }> = {
      type: "submenu",
      id: cleanString(candidate.id, newId(quick ? "ctx-quick" : "ctx-sub")),
      label: quick ? "Quick actions" : cleanString(candidate.label, "Submenu"),
      icon: quick ? "zap" : cleanString(candidate.icon, "more-horizontal"),
      ...(quick ? { presentation: "quick" as const } : {}),
      children: normalizeChildren(candidate.children, {
        quick,
        seenSingletons,
        seenIds,
      }),
    };
    append(submenu);
  }
  return result;
}

/** Converts the v1 separate quick-action settings into the special tree node. */
export function migrateLegacyContextMenuLayout(
  layout: unknown,
  quickActions: unknown,
  quickEnabled: unknown,
): Layout {
  const normalized = normalizeContextMenuLayout(layout);
  const withoutQuick = normalizeContextMenuLayout(
    normalized.filter(
      (item) => !(item.type === "submenu" && item.presentation === "quick"),
    ),
  );
  if (quickEnabled === false) return withoutQuick;
  const slots = normalizeContextMenuQuickActions(quickActions);
  const children = slots
    .filter((id): id is ContextMenuQuickActionId => id !== null)
    .map((id) => contextButton(id));
  return normalizeContextMenuLayout([contextMenuQuickGroup(children), { type: "separator", id: newId("ctx-sep") }, ...withoutQuick]);
}

/** V3 exposes Obsidian's contextual sections as a movable dynamic slot. */
export function migrateContextMenuLayoutV3(layout: unknown): Layout {
  const normalized = normalizeContextMenuLayout(layout);
  if (normalized.some((item) => item.type === "button" && item.id === "obsidian-actions")) {
    return normalized;
  }
  return normalizeContextMenuLayout([
    contextButton("obsidian-actions"),
    { type: "separator", id: newId("ctx-sep") },
    ...normalized,
  ]);
}

/** V4 adds Chromium spelling results as a movable dynamic section without
 * replacing or otherwise reordering an existing customized menu. */
export function migrateContextMenuLayoutV4(layout: unknown): Layout {
  const normalized = normalizeContextMenuLayout(layout);
  if (normalized.some((item) => item.type === "button" && item.id === "spelling-actions")) {
    return normalized;
  }
  return normalizeContextMenuLayout([
    contextButton("spelling-actions"),
    { type: "separator", id: newId("ctx-sep") },
    ...normalized,
  ]);
}

export function normalizeContextMenuQuickActions(value: unknown): ContextMenuQuickActionSlots {
  if (!Array.isArray(value)) return [...DEFAULT_CONTEXT_MENU_QUICK_ACTIONS];
  const result: ContextMenuQuickActionSlots = [];
  const seen = new Set<string>();
  for (let index = 0; index < 5; index += 1) {
    const candidate: unknown = value[index];
    if (typeof candidate === "string" && LEGACY_QUICK_IDS.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate as ContextMenuQuickActionId);
    } else result.push(null);
  }
  return result;
}

export function cloneContextMenuLayout(layout: Layout): Layout {
  return cloneLayout(layout);
}
