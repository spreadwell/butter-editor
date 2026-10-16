/** Raw native caret boundary, before entity decoding or inline tokenization. */
export function hasNativeBlockIdSourceBoundary(source: string, caret: number): boolean {
  if (caret === 0 || /\s/.test(source[caret - 1])) return true;
  // A completed escape of a literal backslash grants a native syntax boundary,
  // even when attached to preceding text. An odd run escapes the caret itself.
  let start = caret;
  while (start > 0 && source[start - 1] === "\\") start--;
  const backslashes = caret - start;
  return backslashes > 0 && backslashes % 2 === 0;
}
