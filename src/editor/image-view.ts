/**
 * Image NodeView with drag-to-resize.
 *
 *   • Renders the image inside a wrapper with a resize handle in the
 *     bottom-right corner.
 *   • Dragging the handle resizes the image live; on pointerup we
 *     commit the final width (and height if the user held Shift to
 *     keep a fixed aspect-ratio disabled) to the image node's attrs
 *     via a PM transaction.
 *   • The size persists to markdown via the `|WIDTH` / `|WIDTHxHEIGHT`
 *     alt-text suffix that the parser + serializer already handle
 *     so sizing round-trips cleanly and the file stays Obsidian-
 *     standard.
 *   • Vault-relative paths are resolved through Obsidian's
 *     metadataCache so images like `![alt](attachment.png)` find the
 *     real file the same way `![[attachment.png]]` does. When the
 *     file doesn't exist, we render a "broken image" placeholder
 *     instead of letting the browser show its default broken icon
 *     and 404'ing in the console.
 */
import { type App, setIcon } from "obsidian";
import type {
  Node as PMNode,
} from "prosemirror-model";

import type {
  EditorView,
  NodeView,
} from "prosemirror-view";
import { openRichContextMenu } from "../ui/link-context-menu";


// External URL scheme - these load via the network or browser stack
// and don't go through Obsidian's vault resolution. Anything not
// matching is treated as a vault-relative path and resolved via
// metadataCache.
function isExternalUrlScheme(src: string): boolean {
  return /^(https?:|data:|blob:|file:)/i.test(src);
}

// Module-scope cache of URLs that have already failed to load this
// session. Without this, every `setViewData` (open / save / mode
// switch) rebuilds the NodeView, re-mounts the `<img>` with the
// same dead URL, fires another `net::ERR_*` line in the console,
// fires another `error` handler, swaps to the placeholder again
// - wash, rinse, repeat. By caching the URL on first failure,
// `resolveImageSrc` returns null on subsequent renders, the
// placeholder mounts directly, and no `<img>` ever tries the dead
// URL again.
//
// Cleared when the plugin reloads (module re-evaluates), which is
// also the natural recovery point for transient network failures.
const failedExternalUrls = new Set<string>();

// Quick sanity check on the raw src string. The most common way
// Butter sees a malformed src is users typing or pasting a markdown
// link INSIDE the image-link parens - `![alt](other-md-link)` - so
// the giveaway is `](` appearing in the src itself. Anything that
// matches that returns false here so we render a placeholder and
// skip the `<img>` entirely (which would otherwise 404 + trip
// Obsidian's editor-link mouseover handler with TypeErrors on every
// hover).
function srcLooksMalformed(src: string): boolean {
  if (!src || src.trim().length === 0) return true;
  if (src.includes("](")) return true;
  return false;
}

// Resolve a markdown image's `src` to a loadable URL. Returns:
//   • a URL string when the image is loadable (external URL or a
//     vault file we found)
//   • null when the src is malformed or points at a non-existent
//     vault file - caller renders a placeholder.
function resolveImageSrc(
  app: App,
  src: string,
  sourcePath: string,
): string | null {
  if (srcLooksMalformed(src)) return null;
  if (isExternalUrlScheme(src)) {
    // Don't keep trying URLs that already failed this session.
    if (failedExternalUrls.has(src)) return null;
    return src;
  }
  // Vault-relative path. Decode percent-escapes (markdown allows
  // `![alt](my%20pic.png)`) before handing to Obsidian's resolver.
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    /* keep raw src if decoding throws on bad escapes */
  }
  // Strip a leading `./` since metadataCache treats that as part of
  // the linkpath rather than a relative-to-current-dir hint.
  const linkpath = decoded.replace(/^\.\//, "");
  const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  if (!file) return null;
  return app.vault.getResourcePath(file);
}

// Render the broken-image placeholder inside `wrap`. Used both for
// upfront unresolvable srcs and for runtime load failures (external
// URLs that 404, vault path that became invalid mid-session, etc.).
//
// Two visual variants:
//   • UNSIZED - match Obsidian's own missing-attachment DOM so
//     themes style it like a missing wikilink-embed:
//       <span alt="..." src="..."
//             class="internal-embed is-loaded file-embed mod-empty-attachment">
//         "name.png" could not be found.
//       </span>
//   • SIZED (image has |W or |WxH in the alt-suffix) - a plain
//     gray rectangle holding the declared footprint with a
//     broken-image icon centered inside. Stops the "could not be
//     found" text card from rendering full-width when the user
//     declared a specific footprint.
function renderMissingPlaceholder(
  wrap: HTMLElement,
  rawSrc: string,
  alt: string | null,
  width: number | null,
  height: number | null,
) {
  wrap.replaceChildren();
  // Wipe any prior state (resize style, butter-image base).
  wrap.removeAttribute("style");
  wrap.classList.remove(
    "butter-image",
    "internal-embed",
    "is-loaded",
    "file-embed",
    "mod-empty-attachment",
    "butter-image-missing-sized",
  );
  wrap.removeAttribute("title");
  if (width || height) {
    wrap.classList.add("butter-image-missing-sized");
    // Square fallback when only one axis is declared. The placeholder
    // has no intrinsic image to size against, so an unset axis would
    // collapse to 0. `![alt|296](missing.png)` → 296×296 tile.
    const effectiveW = width ?? height!;
    const effectiveH = height ?? width!;
    wrap.style.width = `${effectiveW}px`;
    wrap.style.height = `${effectiveH}px`;
    wrap.title = rawSrc || "Image not found";
    wrap.setAttribute("alt", alt || rawSrc);
    setIcon(wrap, "image-off");
  } else {
    wrap.classList.add(
      "internal-embed",
      "is-loaded",
      "file-embed",
      "mod-empty-attachment",
    );
    wrap.setAttribute("src", rawSrc);
    wrap.setAttribute("alt", alt || rawSrc);
    wrap.textContent = `“${rawSrc}” could not be found.`;
  }
}

export function imageView(app: App, getSourcePath: () => string) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => {
    const wrap = activeDocument.createElement("span");
    wrap.className = "butter-image";
    wrap.contentEditable = "false";

    const rawSrc = (node.attrs.src as string) || "";
    const resolved = resolveImageSrc(app, rawSrc, getSourcePath());

    let img: HTMLImageElement | null = null;

    // Swap the wrap's contents to the missing-placeholder form. Used
    // both upfront (unresolvable src) and after `<img>.onerror` for
    // external URLs that 404 at load time. When triggered by an
    // error event, we mark the URL as known-broken so subsequent
    // NodeView rebuilds (every `setViewData` triggers one) skip
    // straight to the placeholder without re-firing the network
    // request and re-logging the error.
    const fallToPlaceholder = () => {
      img = null;
      if (rawSrc && isExternalUrlScheme(rawSrc)) {
        failedExternalUrls.add(rawSrc);
      }
      renderMissingPlaceholder(
        wrap,
        rawSrc,
        node.attrs.alt as string | null,
        node.attrs.width as number | null,
        node.attrs.height as number | null,
      );
    };

    if (resolved !== null) {
      img = activeDocument.createElement("img");
      img.src = resolved;
      const initAttrs = node.attrs as { alt?: string; title?: string };
      if (initAttrs.alt) img.alt = initAttrs.alt;
      if (initAttrs.title) img.title = initAttrs.title;
      applySize(img, node);
      applyDisplayMode(wrap, node);
      // External URL or vault file that exists right now but might
      // 404 in transit - `error` fires when the browser gives up on
      // the load. Swap to the same placeholder we'd have shown if
      // the src had failed `resolveImageSrc` upfront.
      img.addEventListener("error", fallToPlaceholder);
      wrap.appendChild(img);
    } else {
      fallToPlaceholder();
    }

    const handle = activeDocument.createElement("span");
    handle.className = "butter-image-resize-handle";
    handle.setAttribute("aria-label", "Drag to resize");
    handle.contentEditable = "false";
    // Hide the resize handle in full-width mode - dragging would
    // pull the image out of full-width and back to a fixed pixel
    // width, which is confusing UX. Users pick presets via the
    // right-click menu in that mode.
    if (resolved !== null && (node.attrs as { displayMode?: string | null }).displayMode !== "full") {
      wrap.appendChild(handle);
    }

    // Right-click context menu — opens an inline edit panel so the
    // user can change source (file picker or URL), alt text, and size
    // (presets or custom px) all in one place. Replaces the older
    // size-only submenu so the GUI covers every attribute people
    // commonly want to tweak without resorting to markdown.
    wrap.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openImageContextMenu(app, view, getPos, node, ev, wrap);
    });

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let naturalRatio = 1;

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !img) return;
      const dx = e.clientX - startX;
      const nextW = Math.max(32, Math.round(startW + dx));
      const keepRatio = !e.shiftKey;
      const nextH = keepRatio
        ? Math.round(nextW / naturalRatio)
        : Math.max(16, Math.round(startH + (e.clientY - startY)));
      img.width = nextW;
      img.height = nextH;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragging || !img) return;
      dragging = false;
      handle.releasePointerCapture?.(e.pointerId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);

      const pos = getPos();
      if (pos == null) return;
      const width = img.width;
      const keepRatio = !e.shiftKey;
      const height = keepRatio ? null : img.height;

      const attrs = { ...node.attrs, width, height, sourceRange: null };
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, attrs));
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = img.offsetWidth || img.naturalWidth || 200;
      startH = img.offsetHeight || img.naturalHeight || 150;
      naturalRatio =
        img.naturalWidth && img.naturalHeight
          ? img.naturalWidth / img.naturalHeight
          : startH > 0
            ? startW / startH
            : 1;
      handle.setPointerCapture?.(e.pointerId);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    };

    handle.addEventListener("pointerdown", onPointerDown);

    return {
      dom: wrap,
      update(updated) {
        if (updated.type.name !== "image") return false;
        // Always compare against the LIVE attrs (refreshed on every
        // update, not the closure-captured original) so subsequent
        // updates don't see stale values and skip work.
        const ua = updated.attrs as { displayMode?: string | null; src?: string; alt?: string; title?: string; width?: number | null; height?: number | null };
        const na = node.attrs as { displayMode?: string | null; src?: string; width?: number | null; height?: number | null };
        // displayMode flips between full / fixed change the resize-
        // handle attachment AND the wrap classes. Rebuild on change.
        if (ua.displayMode !== na.displayMode) {
          return false;
        }
        // Size changed but we're in the broken-placeholder state
        // (no `<img>` to update inline). Rebuild so the placeholder
        // re-renders with the new declared footprint.
        const sizeChanged = ua.width !== na.width || ua.height !== na.height;
        if (sizeChanged && !img) return false;
        // Cheap path: src unchanged, just refresh attrs on the
        // existing img if we have one.
        if (ua.src === na.src) {
          if (!img) return true; // broken-state DOM is static (no size change either)
          img.alt = ua.alt ?? "";
          if (ua.title) img.title = ua.title;
          applySize(img, updated);
          applyDisplayMode(wrap, updated);
          // Mutate the closure-captured node ref so the NEXT update
          // compares against the values we just applied, not the
          // original constructor args. Without this, the second
          // edit's `na` is still the very first attrs — comparisons
          // get wrong, optimizations misfire.
          node = updated;
          return true;
        }
        // Src changed - re-resolve. If the resolution outcome flips
        // (was-broken → now-loadable, or vice versa) we have to
        // rebuild the NodeView wholesale. Returning false tells PM
        // to do that.
        const nextResolved = resolveImageSrc(
          app, ua.src ?? "", getSourcePath(),
        );
        if ((nextResolved === null) !== (resolved === null)) return false;
        if (img && nextResolved !== null) {
          img.src = nextResolved;
          img.alt = ua.alt ?? "";
          if (ua.title) img.title = ua.title;
          applySize(img, updated);
          applyDisplayMode(wrap, updated);
        }
        return true;
      },
      stopEvent(event) {
        return event.target === handle || handle.contains(event.target as Node);
      },
      ignoreMutation(mutation) {
        // Size mutations during drag are us, not the editor.
        return mutation.target === img || mutation.target === handle;
      },
      destroy() {
        // If the NodeView tears down mid-drag, the window-level pointer
        // listeners installed in onPointerDown would leak. Remove them
        // unconditionally - removeEventListener is a no-op for handlers
        // that aren't registered, so this is safe even on a clean
        // teardown where pointerup already fired.
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        handle.removeEventListener("pointerdown", onPointerDown);
      },
    };
  };
}

function applySize(img: HTMLImageElement, node: PMNode) {
  const a = node.attrs as { displayMode?: string | null; width?: number | null; height?: number | null };
  // Full-width display mode - let CSS drive sizing; clear any
  // pixel width/height that might be lingering on the element.
  if (a.displayMode === "full") {
    img.removeAttribute("width");
    img.removeAttribute("height");
    return;
  }
  if (a.width) img.width = a.width;
  else img.removeAttribute("width");
  if (a.height) img.height = a.height;
  else img.removeAttribute("height");
}

function applyDisplayMode(wrap: HTMLElement, node: PMNode) {
  const mode = (node.attrs as { displayMode?: string | null }).displayMode;
  if (mode === "full") {
    wrap.classList.add("butter-image-full-width");
    wrap.setAttribute("data-display-mode", "full");
  } else {
    wrap.classList.remove("butter-image-full-width");
    wrap.removeAttribute("data-display-mode");
  }
}

// ── Image edit context menu ────────────────────────────────
//
// Right-click on an image opens the shared rich-context menu (same
// chrome + cursor-anchored positioning + Enter-to-commit as the
// wikilink / tag / embed / math / footnote menus). Fields:
//   - Source (file picker via AbstractInputSuggest, or raw URL)
//   - Alt text
//   - Width (px)  — empty = natural width
//   - Height (px) — empty = aspect-ratio from width
// Drag-the-corner-handle still works for size; this is the GUI path.
function openImageContextMenu(
  app: App,
  view: EditorView,
  getPos: () => number | undefined,
  node: PMNode,
  e: MouseEvent,
  imageDom: HTMLElement,
): void {
  const currentSrc = (node.attrs.src as string) ?? "";
  const currentAlt = (node.attrs.alt as string) ?? "";
  const currentWidth = node.attrs.width as number | null;
  const currentHeight = node.attrs.height as number | null;

  const commit = (values: Record<string, string>): boolean => {
    const newSrc = values.src.trim();
    if (!newSrc) return false;
    const parseDim = (raw: string): number | null => {
      const n = parseInt(raw.trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const newWidth = parseDim(values.width);
    const newHeight = parseDim(values.height);
    const newAlt = values.alt.trim() || null;
    if (
      newSrc === currentSrc &&
      newAlt === (currentAlt || null) &&
      newWidth === currentWidth &&
      newHeight === currentHeight
    ) return false;
    const pos = getPos();
    if (pos == null) return false;
    const liveNode = view.state.doc.nodeAt(pos);
    if (!liveNode || liveNode.type.name !== "image") return false;
    const newAttrs: Record<string, unknown> = {
      ...liveNode.attrs,
      src: newSrc,
      alt: newAlt,
      width: newWidth,
      height: newHeight,
      // Custom width clears the full-width display mode (user
      // explicitly picked a pixel size).
      displayMode: newWidth != null ? null : liveNode.attrs.displayMode,
      sourceRange: null,
    };
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, newAttrs));
    return true;
  };

  openRichContextMenu({
    app,
    anchor: imageDom,
    event: e,
    autoFocusFirstField: false,
    chrome: {
      icon: "image",
      title: "Image",
      sub: truncateSrcForHeader(currentSrc),
    },
    fields: [
      {
        id: "src",
        label: "Source",
        icon: "image",
        initial: currentSrc,
        placeholder: "file.png or https://…",
        autocomplete: "vault-files",
        suggestSkipWhen: (raw) => /^(https?:|data:|blob:|file:)/i.test(raw),
        onSuggestSelect: (file) => {
          // Image src is the full vault path (not just basename) so
          // metadataCache can resolve it independent of the open
          // file's location.
          const input = activeDocument.querySelector<HTMLInputElement>(
            ".butter-rich-menu-fields input[type='text']",
          );
          if (input) {
            input.value = file.path;
            input.dispatchEvent(new Event("input"));
          }
        },
      },
      {
        id: "alt",
        label: "Alt text",
        icon: "text",
        initial: currentAlt,
        placeholder: "Description for accessibility",
      },
      {
        id: "width",
        label: "Width (px)",
        icon: "scaling",
        initial: currentWidth != null ? String(currentWidth) : "",
        placeholder: "natural",
      },
      {
        id: "height",
        label: "Height (px)",
        icon: "scaling",
        initial: currentHeight != null ? String(currentHeight) : "",
        placeholder: "aspect ratio",
      },
    ],
    actions: [],
    onCommit: (values) => {
      commit(values);
      view.focus();
    },
  });
}

/** Shrink a long src to a header-friendly preview. The rich menu's
 *  header already ellipsizes overflow but capping here gives the
 *  ellipsis predictable width across screen sizes. */
function truncateSrcForHeader(src: string): string {
  const max = 40;
  return src.length > max ? src.slice(0, max - 1) + "…" : src;
}

