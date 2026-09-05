import { isInlineMathSource } from "./inline-math-delimiters";

export function isRepresentableWikilinkTarget(value: string): boolean {
  return (
    value.length > 0 &&
    !/[\r\n|]/.test(value) &&
    !value.includes("[[") &&
    !value.includes("]]")
  );
}

export function isRepresentableWikilinkAlias(value: string): boolean {
  return (
    !/[\r\n]/.test(value) &&
    !value.includes("[[") &&
    !value.includes("]]")
  );
}

export function isRepresentableEmbedSource(value: string): boolean {
  return value.length > 0 && !/[\r\n]/.test(value) && !value.includes("]]");
}

export function isRepresentableInlineMath(value: string): boolean {
  return isInlineMathSource(`$${value}$`);
}

export function isRepresentableFootnoteLabel(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function isRepresentableInlineFootnote(value: string): boolean {
  if (!value || /[\r\n]/.test(value)) return false;
  let depth = 0;
  for (const char of value) {
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      if (depth === 0) return false;
      depth -= 1;
    }
  }
  return depth === 0;
}
