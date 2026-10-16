/** Physical UTF-8 source and Obsidian's BOM-stripped text projection are distinct. */
export function decodeNativeFileBytes(bytes: ArrayBuffer): string {
  // ignoreBOM means the decoder exposes U+FEFF instead of consuming the marker.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function nativeFileTextProjection(source: string): string {
  return source.startsWith("\ufeff") ? source.slice(1) : source;
}

export function nativeFileTextMatchesSource(source: string, projection: string): boolean {
  return projection === source || projection === nativeFileTextProjection(source);
}

export function nativeFileBytesEqualText(bytes: ArrayBuffer, text: string): boolean {
  const actual = new Uint8Array(bytes);
  const expected = new TextEncoder().encode(text);
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
