export type NativeLinkCommandRecord = {
  checkCallback?: (this: unknown, checking: boolean) => unknown;
};

/** null delegates to native behavior; false guards an active Butter pane. */
export type NativeLinkCommandHandling = boolean | null;

export const NATIVE_LINK_COMMAND_ID = "editor:insert-link";

/**
 * Obsidian's link hotkey runs its command before PM receives the DOM keydown.
 * Obsidian registration synthesizes a native check from its editor callback.
 * Preserve that check's receiver and policy outside Butter. An incomplete
 * record without a check must retain its original native dispatch path.
 */
export function patchNativeLinkCommands(
  commands: Record<string, NativeLinkCommandRecord | undefined> | undefined,
  canOpen: () => NativeLinkCommandHandling,
  open: () => boolean,
): Array<() => void> {
  const command = commands?.[NATIVE_LINK_COMMAND_ID];
  const originalCheck = command?.checkCallback;
  if (!command || typeof originalCheck !== "function") return [];
  const wrappedCheck = function (this: unknown, checking: boolean) {
    const handling = canOpen();
    if (handling === null) return originalCheck.call(this, checking);
    if (!handling) return false;
    return checking ? true : open();
  };
  command.checkCallback = wrappedCheck;
  return [() => {
    if (command.checkCallback !== wrappedCheck) return;
    command.checkCallback = originalCheck;
  }];
}
