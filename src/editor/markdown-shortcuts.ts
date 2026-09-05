export interface MarkdownShortcutSettings {
  bold: boolean;
  italic: boolean;
  highlight: boolean;
  strikethrough: boolean;
  inlineCode: boolean;
  inlineMath: boolean;
  wikilinks: boolean;
  markdownLinks: boolean;
  tags: boolean;
  headings: boolean;
  blockquotes: boolean;
  bulletLists: boolean;
  numberedLists: boolean;
  taskLists: boolean;
  codeBlocks: boolean;
  horizontalRules: boolean;
}

export type MarkdownShortcutKey = keyof MarkdownShortcutSettings;

/**
 * Approachable shortcuts offered by the welcome walkthrough. Inline math and
 * horizontal rules remain opt-in because they are less common and easier to
 * trigger unintentionally while writing ordinary text.
 */
export const COMMON_MARKDOWN_SHORTCUT_KEYS = [
  "bold",
  "italic",
  "highlight",
  "strikethrough",
  "inlineCode",
  "wikilinks",
  "markdownLinks",
  "tags",
  "headings",
  "blockquotes",
  "bulletLists",
  "numberedLists",
  "taskLists",
  "codeBlocks",
] as const satisfies readonly MarkdownShortcutKey[];

/** Conservative defaults for non-Markdown-oriented users. */
export const DEFAULT_MARKDOWN_SHORTCUT_SETTINGS: Readonly<MarkdownShortcutSettings> = {
  bold: false,
  italic: false,
  highlight: false,
  strikethrough: false,
  inlineCode: false,
  inlineMath: false,
  wikilinks: false,
  markdownLinks: false,
  tags: false,
  headings: false,
  blockquotes: false,
  bulletLists: false,
  numberedLists: false,
  taskLists: false,
  codeBlocks: false,
  horizontalRules: false,
};

export function allMarkdownShortcutSettings(
  enabled: boolean,
): MarkdownShortcutSettings {
  const settings: MarkdownShortcutSettings = { ...DEFAULT_MARKDOWN_SHORTCUT_SETTINGS };
  for (const key of Object.keys(settings) as MarkdownShortcutKey[]) settings[key] = enabled;
  return settings;
}

export function normalizeMarkdownShortcutSettings(
  value: unknown,
  legacyEnabled = false,
): MarkdownShortcutSettings {
  const fallback = allMarkdownShortcutSettings(legacyEnabled);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(fallback) as MarkdownShortcutKey[]) {
    if (typeof record[key] === "boolean") fallback[key] = record[key];
  }
  return fallback;
}

export function anyMarkdownShortcutEnabled(
  settings: MarkdownShortcutSettings,
): boolean {
  return Object.values(settings).some(Boolean);
}

export function allCommonMarkdownShortcutsEnabled(
  settings: MarkdownShortcutSettings,
): boolean {
  return COMMON_MARKDOWN_SHORTCUT_KEYS.every((key) => settings[key]);
}

export function withCommonMarkdownShortcuts(
  settings: MarkdownShortcutSettings,
  enabled: boolean,
): MarkdownShortcutSettings {
  const next = { ...settings };
  for (const key of COMMON_MARKDOWN_SHORTCUT_KEYS) next[key] = enabled;
  return next;
}
