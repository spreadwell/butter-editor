export const isWhitespaceCode = (ch: number) =>
  ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D;

export const isDigitCode = (ch: number) => ch >= 0x30 && ch <= 0x39;

export function isEscapedDollar(src: string, pos: number): boolean {
  let backslashes = 0;
  for (let i = pos - 1; i >= 0 && src.charCodeAt(i) === 0x5C /* \ */; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

export function isValidInlineMathOpenAt(src: string, pos: number): boolean {
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
  if (isEscapedDollar(src, pos)) return false;
  const next = pos + 1 < src.length ? src.charCodeAt(pos + 1) : NaN;
  if (next === 0x24 /* $ */) return false;
  if (isWhitespaceCode(next)) return false;
  return true;
}

export function isValidInlineMathCloseAt(
  src: string,
  pos: number,
  posMax = src.length,
): boolean {
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
  if (isEscapedDollar(src, pos)) return false;
  const prev = src.charCodeAt(pos - 1);
  const next = pos + 1 < posMax ? src.charCodeAt(pos + 1) : NaN;
  return !isWhitespaceCode(prev) && next !== 0x24 /* $ */ && !isDigitCode(next);
}

export function findInlineMathClose(
  src: string,
  start: number,
  posMax = src.length,
): number {
  for (let pos = start + 1; pos < posMax; pos++) {
    if (src.charCodeAt(pos) !== 0x24 /* $ */ || isEscapedDollar(src, pos)) {
      continue;
    }
    // Match the tokenizer: the first unescaped dollar after an opener
    // must be a valid close. This keeps currency like "$350 ... $700"
    // from reaching forward into a later real math expression.
    return isValidInlineMathCloseAt(src, pos, posMax) ? pos : -1;
  }
  return -1;
}

export function isInlineMathSource(src: string): boolean {
  if (src.length < 3) return false;
  if (!isValidInlineMathOpenAt(src, 0)) return false;
  const close = src.length - 1;
  if (!isValidInlineMathCloseAt(src, close)) return false;
  const value = src.slice(1, -1);
  return !!value.trim() && value === value.trim();
}
