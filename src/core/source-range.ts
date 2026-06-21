export interface SourceRange {
  start: number;
  end: number;
}

export function isValidSourceRange(
  range: unknown,
  sourceLength?: number,
): range is SourceRange {
  if (
    !range ||
    typeof range !== "object" ||
    typeof (range as SourceRange).start !== "number" ||
    typeof (range as SourceRange).end !== "number"
  ) {
    return false;
  }
  const { start, end } = range as SourceRange;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end < start) return false;
  return sourceLength == null || end <= sourceLength;
}

export function clearSourceRange<T extends Record<string, unknown>>(
  attrs: T,
): T & { sourceRange: null } {
  return { ...attrs, sourceRange: null };
}
