/** Authoring HTML marks is opt-in; parsing existing marks stays independent. */
const HTML_MARKS = new Set(["font", "underline", "superscript", "subscript", "kbd"]);

export function isFormattingMarkAllowed(
  markName: string | undefined,
  enableHtmlFormatting: boolean | undefined,
): boolean {
  return enableHtmlFormatting !== false || !HTML_MARKS.has(markName ?? "");
}
