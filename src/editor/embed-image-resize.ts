export interface EmbedSize {
  target: string;
  width: number | null;
  height: number | null;
}

/** Native Obsidian's live image resize stops at 20 CSS pixels. */
export const IMAGE_RESIZE_MIN_WIDTH = 20;

/** Resolve only the attachment rendered by this embed node. A note embed may
 * contain any number of images inside its `.markdown-embed-content`; those
 * descendants belong to the embedded note and must never reclassify the note
 * embed itself as an image block. */
export function findRenderedImageAttachment(
  mount: ParentNode,
): HTMLImageElement | null {
  for (const image of Array.from(mount.querySelectorAll<HTMLImageElement>("img"))) {
    const imageHost = image.closest<HTMLElement>(".image-embed");
    if (!imageHost || !mount.contains(imageHost)) continue;
    if (imageHost.closest(".markdown-embed-content")) continue;
    return image;
  }
  return null;
}

/** Parse Obsidian's terminal image-size suffix without treating a
 * normal embed alias as a dimension. */
export function parseEmbedSize(raw: string): EmbedSize {
  const match = /^(.*?)\|(\d+)(?:x(\d+))?$/.exec(raw);
  if (!match) return { target: raw, width: null, height: null };
  return {
    target: match[1],
    width: Number.parseInt(match[2], 10),
    height: match[3] ? Number.parseInt(match[3], 10) : null,
  };
}

/** A non-numeric pipe suffix is an alias. Obsidian's embed syntax has
 * only one suffix slot, so adding a size would overwrite that alias. */
export function canResizeEmbedSource(raw: string): boolean {
  const sized = parseEmbedSize(raw);
  return sized.width !== null || !raw.includes("|");
}

/** Return the source stored inside ![[...]] after a resize. */
export function resizeEmbedSource(
  raw: string,
  width: number,
  height: number | null,
): string {
  const sized = parseEmbedSize(raw);
  const suffix = height == null ? `${width}` : `${width}x${height}`;
  return `${sized.target}|${suffix}`;
}
