export type NativeListCommandRecord = {
  checkCallback?: (this: unknown, checking: boolean) => unknown;
};

/** null delegates to Obsidian; false blocks a guarded Butter context. */
export type NativeListCommandHandling = boolean | null;

export const NATIVE_LIST_COMMANDS: ReadonlyArray<{
  id: string;
  cycle: boolean;
}> = [
  { id: "editor:toggle-checklist-status", cycle: false },
  { id: "editor:cycle-list-checklist", cycle: true },
];

/**
 * Bridge only the stock checklist ids. Eligibility belongs to the caller,
 * including active-pane ownership, editability, table and chrome focus guards.
 * A guarded Butter pane must never fall through to a stale native editor.
 */
export function patchNativeListCommands(
  commands: Record<string, NativeListCommandRecord | undefined> | undefined,
  canHandle: (cycle: boolean) => NativeListCommandHandling,
  toggle: (cycle: boolean) => boolean,
): Array<() => void> {
  if (!commands) return [];

  const restorers: Array<() => void> = [];
  for (const { id, cycle } of NATIVE_LIST_COMMANDS) {
    const command = commands[id];
    const originalCheck = command?.checkCallback;
    // Only a registered native check callback can be preserved/delegated.
    if (!command || typeof originalCheck !== "function") continue;
    const wrappedCheck = function (this: unknown, checking: boolean) {
      const handling = canHandle(cycle);
      if (handling === null) return originalCheck.call(this, checking);
      if (!handling) return false;
      return checking ? true : toggle(cycle);
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
