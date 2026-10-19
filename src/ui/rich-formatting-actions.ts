/** Authoring HTML formatting is opt-in; existing content stays independent. */
const HTML_MARKS = new Set(["font", "underline", "superscript", "subscript", "kbd"]);

export function isFormattingMarkAllowed(
  markName: string | undefined,
  enableHtmlFormatting: boolean | undefined,
): boolean {
  return enableHtmlFormatting !== false || !HTML_MARKS.has(markName ?? "");
}

export function isFormattingActionAllowed(
  action: { kind?: string; markName?: string },
  enableHtmlFormatting: boolean | undefined,
): boolean {
  return (enableHtmlFormatting !== false || action.kind !== "alignment") &&
    isFormattingMarkAllowed(action.markName, enableHtmlFormatting);
}
