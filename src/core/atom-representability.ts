import { isInlineMathSource } from "./inline-math-delimiters";
import { __mdit } from "./bridge/common";
import { canEncodeButterFileUtf8 } from "./file-shell";

/** The block parser runs before inline tokenization. A lexically valid
 * delimiter pair can still become several blocks when its payload contains
 * a blank line, heading, or list marker. Validate the actual source grammar. */
function isSingleInlinePayload(source: string, type: string, value: string): boolean {
  if (/[\r\0]/.test(value) || !canEncodeButterFileUtf8(value)) return false;
  const tokens = __mdit.parse(`${source}\n`, {});
  return tokens.length === 3 && tokens[0].type === "paragraph_open" &&
    tokens[1].type === "inline" && tokens[2].type === "paragraph_close" &&
    tokens[1].children?.length === 1 && tokens[1].children[0].type === type &&
    tokens[1].children[0].content === value;
}

export function isRepresentableWikilinkTarget(value: string): boolean {
  return (
    value.length > 0 &&
    canEncodeButterFileUtf8(value) &&
    !/[\r\n\0|]/.test(value) &&
    !value.endsWith("]") &&
    !value.includes("[[") &&
    !value.includes("]]")
  );
}

export function isRepresentableWikilinkAlias(value: string): boolean {
  return (
    canEncodeButterFileUtf8(value) &&
    !/[\r\n\0]/.test(value) &&
    !value.endsWith("]") &&
    !value.includes("[[") &&
    !value.includes("]]")
  );
}

export function isRepresentableEmbedSource(value: string): boolean {
  return value.length > 0 && canEncodeButterFileUtf8(value) && !/[\r\n\0]/.test(value) &&
    !value.endsWith("]") && !value.includes("]]");
}

export function isRepresentableInlineMath(value: string): boolean {
  return isInlineMathSource(`$${value}$`) &&
    isSingleInlinePayload(`$${value}$`, "inline_math", value);
}

export function isRepresentableFootnoteLabel(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function isRepresentableInlineFootnote(value: string): boolean {
  if (!value || /[\r\0]/.test(value)) return false;
  let depth = 0;
  for (const char of value) {
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      if (depth === 0) return false;
      depth -= 1;
    }
  }
  return depth === 0 && isSingleInlinePayload(`^[${value}]`, "inline_footnote", value);
}
