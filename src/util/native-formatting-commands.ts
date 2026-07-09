export type NativeFormattingCommandRecord = {
  checkCallback?: (checking: boolean) => unknown;
};

export type FormattingHotkeyLike = {
  key?: unknown;
  code?: unknown;
  modifiers?: unknown;
  ctrlKey?: unknown;
  metaKey?: unknown;
  shiftKey?: unknown;
  altKey?: unknown;
};

export const NATIVE_FORMATTING_COMMANDS: Array<{
  id: string;
  markName: string;
}> = [
  { id: "editor:toggle-bold", markName: "strong" },
  { id: "editor:toggle-italics", markName: "em" },
  { id: "editor:toggle-code", markName: "code" },
  { id: "editor:toggle-strikethrough", markName: "strikethrough" },
  { id: "editor:toggle-highlight", markName: "highlight" },
];

export function markNameForFormattingHotkey(
  eventLike?: FormattingHotkeyLike | null,
  hotkeyLike?: FormattingHotkeyLike | null,
): string | null {
  const modifierSource = hotkeyLike?.modifiers ?? eventLike?.modifiers;
  const modifierText = Array.isArray(modifierSource)
    ? modifierSource.join(" ")
    : typeof modifierSource === "string"
      ? modifierSource
      : "";
  const hasPrimaryMod =
    eventLike?.ctrlKey === true ||
    eventLike?.metaKey === true ||
    /\b(mod|ctrl|control|cmd|command|meta)\b/i.test(modifierText);
  if (!hasPrimaryMod) return null;
  if (eventLike?.altKey === true || /\b(alt|option)\b/i.test(modifierText)) return null;

  const hasShift =
    eventLike?.shiftKey === true || /\bshift\b/i.test(modifierText);
  const rawKey =
    typeof hotkeyLike?.key === "string"
      ? hotkeyLike.key
      : typeof eventLike?.key === "string"
        ? eventLike.key
        : typeof eventLike?.code === "string"
          ? eventLike.code.replace(/^Key/i, "")
          : "";
  const key = rawKey.toLowerCase();

  if (!hasShift) {
    if (key === "b") return "strong";
    if (key === "i") return "em";
  } else {
    if (key === "s") return "strikethrough";
    if (key === "h") return "highlight";
  }
  return null;
}

export function patchNativeFormattingCommands(
  commands: Record<string, NativeFormattingCommandRecord | undefined> | undefined,
  canToggle: (markName: string) => boolean,
  toggle: (markName: string) => boolean,
): Array<() => void> {
  if (!commands) return [];

  const restorers: Array<() => void> = [];
  for (const { id, markName } of NATIVE_FORMATTING_COMMANDS) {
    const command = commands[id];
    if (!command) continue;
    const originalCheck = command.checkCallback;
    const wrappedCheck = (checking: boolean) => {
      if (canToggle(markName)) {
        if (!checking) return toggle(markName);
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
