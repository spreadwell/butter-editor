export type VaultFileSuggestionScope = "markdown" | "image" | "video" | "all";

const IMAGE_EXTENSIONS = new Set([
  "avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "webp",
]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);

export function extensionMatchesVaultSuggestionScope(
  rawExtension: string,
  scope: VaultFileSuggestionScope,
): boolean {
  const extension = rawExtension.toLowerCase();
  if (scope === "markdown") return extension === "md";
  if (scope === "image") return IMAGE_EXTENSIONS.has(extension);
  if (scope === "video") return VIDEO_EXTENSIONS.has(extension);
  return true;
}

/** Infer the narrowest safe attachment family for a resolved embed source.
 *  Unsuffixed note links and unfamiliar attachment types remain generic. */
export function suggestionScopeForEmbedSource(
  rawSource: string,
): VaultFileSuggestionScope {
  const target = rawSource.split("|", 1)[0].split("#", 1)[0].trim();
  const extension = target.match(/\.([^.\\/]+)$/u)?.[1] ?? "";
  if (extensionMatchesVaultSuggestionScope(extension, "image")) return "image";
  if (extensionMatchesVaultSuggestionScope(extension, "video")) return "video";
  return "all";
}
