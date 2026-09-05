export type NativeSearchCommandRecord = {
  checkCallback?: (checking: boolean) => unknown;
};

export type NativeSearchAction = "find" | "replace";

export const NATIVE_SEARCH_COMMANDS: Array<{
  id: string;
  action: NativeSearchAction;
}> = [
  { id: "editor:open-search", action: "find" },
  { id: "editor:open-search-replace", action: "replace" },
];

/**
 * Route Obsidian's stock current-file search commands into Butter only while a
 * Butter editor owns the active pane. The original callbacks remain untouched
 * for Source, Live Preview, Reading, Canvas, and third-party editor views.
 */
export function patchNativeSearchCommands(
  commands: Record<string, NativeSearchCommandRecord | undefined> | undefined,
  canOpen: (action: NativeSearchAction) => boolean,
  open: (action: NativeSearchAction) => void,
): Array<() => void> {
  if (!commands) return [];

  const restorers: Array<() => void> = [];
  for (const { id, action } of NATIVE_SEARCH_COMMANDS) {
    const command = commands[id];
    if (!command) continue;
    const originalCheck = command.checkCallback;
    const wrappedCheck = (checking: boolean) => {
      if (canOpen(action)) {
        if (!checking) open(action);
        return true;
      }
      return originalCheck?.(checking);
    };

    command.checkCallback = wrappedCheck;
    restorers.push(() => {
      if (command.checkCallback === wrappedCheck) {
        command.checkCallback = originalCheck;
      }
    });
  }

  return restorers;
}
