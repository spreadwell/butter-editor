import type { App, Editor, MarkdownFileInfo, Menu } from "obsidian";
import type { Node as PMNode } from "prosemirror-model";
import type { Layout } from "../ui/toolbar-layout";
import type {
  FeatureAnnouncement,
  FeatureDiscoverySurface,
} from "../ui/feature-discovery";

export interface GeneralContextMenuHost {
  app: App;
  getEditor: () => Editor | null;
  getInfo: () => MarkdownFileInfo;
  getContextMenuLayout?: () => Layout;
  getPendingFeatureAnnouncement?: (
    surface: FeatureDiscoverySurface,
  ) => FeatureAnnouncement | null;
  acknowledgeFeatureAnnouncement?: (id: string) => Promise<void> | void;
  openContextMenuSettings?: () => void;
  serializeNode?: (node: PMNode) => string;
}

/**
 * Give compatible Obsidian plugins the same public editor-menu hook used by
 * native Markdown editors. A separator is inserted lazily only if a listener
 * actually contributes an item, so vaults without compatible contributions do
 * not get a dangling divider.
 */
export function emitEditorMenuContributions(
  menu: Menu,
  host: GeneralContextMenuHost | undefined,
  options: { separatorBefore?: boolean } = {},
): boolean {
  const editor = host?.getEditor();
  if (!host || !editor) return false;

  const originalAddItem = menu.addItem.bind(menu);
  const originalAddSeparator = menu.addSeparator.bind(menu);
  let contributionStarted = false;
  const beginContribution = () => {
    if (contributionStarted) return;
    contributionStarted = true;
    if (options.separatorBefore !== false) originalAddSeparator();
  };

  // Plugin callbacks run synchronously while the menu is still being built.
  // Temporarily wrapping the same Menu instance preserves API identity while
  // avoiding an empty plugin section when every listener declines to add one.
  menu.addItem = (callback) => {
    beginContribution();
    return originalAddItem(callback);
  };
  menu.addSeparator = () => {
    if (!contributionStarted) {
      beginContribution();
      return menu;
    }
    return originalAddSeparator();
  };

  try {
    host.app.workspace.trigger("editor-menu", menu, editor, host.getInfo());
  } finally {
    menu.addItem = originalAddItem;
    menu.addSeparator = originalAddSeparator;
  }
  return contributionStarted;
}
