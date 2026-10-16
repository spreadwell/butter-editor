export interface ButterFileSource {
  readonly body: string;
  readonly frontmatter: string;
  readonly lineEnding: "\n" | "\r\n" | "\r";
  readonly originalHasBOM: boolean;
  readonly originalTrailingNewlines: number;
}

const FRONTMATTER_SOURCE_RE =
  /^---(?:\r\n?|\n)([\s\S]*?)(?:\r\n?|\n)---(?:\r\n?|\n)*/;

/** The exact file-to-body boundary shared by loading and verified saving. */
export function splitButterFileSource(source: string): ButterFileSource {
  const originalHasBOM = source.charCodeAt(0) === 0xfeff;
  const data = originalHasBOM ? source.slice(1) : source;
  // Keep the established CRLF preference for mixed files, then recognize
  // bare CR before falling back to LF.
  const lineEnding = data.includes("\r\n") ? "\r\n" : data.includes("\r") ? "\r" : "\n";
  // All newlines following the closing fence belong to the preserved header.
  const frontmatter = data.match(FRONTMATTER_SOURCE_RE)?.[0] ?? "";
  const body = data.slice(frontmatter.length);
  const normalizedBody = body.replace(/\r\n?|\n/g, "\n");
  const originalTrailingNewlines = normalizedBody.match(/\n*$/)?.[0].length ?? 0;
  return { body, frontmatter, lineEnding, originalHasBOM, originalTrailingNewlines };
}

/** UTF-8 preserves every Unicode scalar value, but replaces lone surrogates. */
export function canEncodeButterFileUtf8(source: string): boolean {
  for (let index = 0; index < source.length; index++) {
    const unit = source.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = source.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
