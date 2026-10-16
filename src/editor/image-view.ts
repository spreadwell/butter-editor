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
import { openRichContextMenu, type RichMenuField } from "../ui/link-context-menu";
import {
  attachImageBodyPlacementDrag,
  imageLayoutActions,
} from "./image-placement";
import { IMAGE_RESIZE_MIN_WIDTH } from "./embed-image-resize";
import { attachImageEditButton } from "./image-edit-button";
import { captureBlockMenuMutation } from "./block-menu-ownership";
import { markBlockConversionRefusal } from "./native-block-id-conservation";
import { prepareImageSourceEdit, referenceImageDisplayText } from "../core/link-occurrence";


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

export function imageView(app: App, getSourcePath: () => string, validateEdit: (candidate: PMNode) => boolean) {
  return (
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView => {
    const wrap = activeWindow.createSpan();
    wrap.className = "butter-image";
    wrap.contentEditable = "false";

    // A removed reference definition exposes literal native image syntax,
    // rather than a broken image or a newly active inline destination.
    const referenceText = referenceImageDisplayText(node);
    if (referenceText !== null && node.attrs.resolved === false) {
      wrap.className = "butter-image-reference-literal";
      wrap.textContent = referenceText;
      const openContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        openImageContextMenu(app, view, getPos, node, event, wrap, validateEdit);
      };
      wrap.addEventListener("contextmenu", openContextMenu);
      const detachEditButton = attachImageEditButton(wrap, openContextMenu);
      return {
        dom: wrap,
        update(updated) {
          if (updated.type.name !== "image" || updated.attrs.resolved !== false) return false;
          const text = referenceImageDisplayText(updated);
          if (text === null) return false;
          // Keep the control and its event listeners while refreshing only
          // the literal source presentation before that control.
          if (node !== updated) {
            wrap.firstChild!.textContent = text;
            node = updated;
          }
          return true;
        },
        stopEvent: event => Boolean((event.target as Element | null)?.closest?.(".butter-image-edit-button")),
        ignoreMutation: mutation => mutation.type !== "selection",
        destroy() {
          wrap.removeEventListener("contextmenu", openContextMenu);
          detachEditButton();
        },
      };
    }

    // Standalone and inline Markdown images share one schema node. Mark the
    // mixed-content form explicitly so its resize corner can sit on the image
    // bounds instead of following the standalone selector frame into the text
    // line's clipped overflow area.
    const syncInlinePlacementClass = (currentNode: PMNode) => {
      try {
        const pos = getPos();
        if (typeof pos !== "number") return;
        const $pos = view.state.doc.resolve(pos);
        const parent = $pos.parent;
        const inline = parent.inlineContent &&
          !(parent.childCount === 1 && parent.firstChild === currentNode);
        wrap.classList.toggle("butter-image-inline", inline);
      } catch {
        // A NodeView can be queried while a replacement transaction is
        // detaching it. The next mounted view receives the correct class.
      }
    };
    syncInlinePlacementClass(node);

    const rawSrc = (node.attrs.src as string) || "";
    const resolved = resolveImageSrc(app, rawSrc, getSourcePath());

    let img: HTMLImageElement | null = null;
    let detachPlacementDrag: (() => void) | null = null;

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
      img = activeWindow.createEl("img");
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
      detachPlacementDrag = attachImageBodyPlacementDrag({ image: img, view, getPos });
    } else {
      fallToPlaceholder();
    }

    const ownedImg = img;
    const handle = activeWindow.createSpan();
    handle.className = "butter-image-resize-handle";
    handle.setAttribute("aria-label", "Drag to resize");
    handle.contentEditable = "false";
    // Hide the resize handle in full-width mode - dragging would
    // pull the image out of full-width and back to a fixed pixel
    // width, which is confusing UX. Users pick presets via the
    // right-click menu in that mode.
    if (resolved !== null && node.attrs.sourceSyntax !== "reference" && (node.attrs as { displayMode?: string | null }).displayMode !== "full") {
      wrap.appendChild(handle);
    }

    // Right-click context menu — opens an inline edit panel so the
    // user can change source (file picker or URL), alt text, and size
    // (presets or custom px) all in one place. Replaces the older
    // size-only submenu so the GUI covers every attribute people
    // commonly want to tweak without resorting to markdown.
    const openContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      openImageContextMenu(app, view, getPos, node, ev, wrap, validateEdit);
    };
    wrap.addEventListener("contextmenu", openContextMenu);
    const detachEditButton = attachImageEditButton(wrap, openContextMenu);

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let startWidthAttribute: string | null = null;
    let startHeightAttribute: string | null = null;
    let naturalRatio = 1;
    let resizeCurrent: (() => boolean) | null = null;
    const resizeBody = wrap.ownerDocument.body;

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !img) return;
      const dx = e.clientX - startX;
      const nextW = Math.max(IMAGE_RESIZE_MIN_WIDTH, Math.round(startW + dx));
      const keepRatio = !e.shiftKey;
      const nextH = keepRatio
        ? Math.round(nextW / naturalRatio)
        : Math.max(16, Math.round(startH + (e.clientY - startY)));
      img.width = nextW;
      img.height = nextH;
    };

    const finishResize = (e: PointerEvent, commit: boolean) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("is-resizing");
      resizeBody.classList.remove("butter-is-image-resizing");
      handle.releasePointerCapture?.(e.pointerId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      if (!img) return;

      const restoreSize = () => {
        if (!img) return;
        if (startWidthAttribute === null) img.removeAttribute("width");
        else img.setAttribute("width", startWidthAttribute);
        if (startHeightAttribute === null) img.removeAttribute("height");
        else img.setAttribute("height", startHeightAttribute);
      };

      if (!commit) {
        restoreSize();
        return;
      }

      const pos = getPos();
      if (pos == null || !resizeCurrent?.()) {
        restoreSize();
        return;
      }
      const width = img.width;
      const keepRatio = !e.shiftKey;
      const height = keepRatio ? null : img.height;

      if (!commitImageAttributes(view, pos, node, { ...node.attrs, width, height, sourceRange: null }, validateEdit)) {
        restoreSize();
      }
    };

    const onPointerUp = (e: PointerEvent) => finishResize(e, true);
    const onPointerCancel = (e: PointerEvent) => finishResize(e, false);

    const onPointerDown = (e: PointerEvent) => {
      if (!img) return;
      const pos = getPos();
      if (pos == null) return;
      resizeCurrent = captureBlockMenuMutation(view, [{ pos, node }]);
      if (!resizeCurrent()) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      handle.classList.add("is-resizing");
      resizeBody.classList.add("butter-is-image-resizing");
      startX = e.clientX;
      startY = e.clientY;
      startW = img.offsetWidth || img.naturalWidth || 200;
      startH = img.offsetHeight || img.naturalHeight || 150;
      startWidthAttribute = img.getAttribute("width");
      startHeightAttribute = img.getAttribute("height");
      naturalRatio =
        img.naturalWidth && img.naturalHeight
          ? img.naturalWidth / img.naturalHeight
          : startH > 0
            ? startW / startH
            : 1;
      handle.setPointerCapture?.(e.pointerId);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    };

    handle.addEventListener("pointerdown", onPointerDown);

    return {
      dom: wrap,
      update(updated) {
        if (updated.type.name !== "image") return false;
        syncInlinePlacementClass(updated);
        // Always compare against the LIVE attrs (refreshed on every
        // update, not the closure-captured original) so subsequent
        // updates don't see stale values and skip work.
        const ua = updated.attrs as { displayMode?: string | null; src?: string; alt?: string; title?: string; width?: number | null; height?: number | null };
        const na = node.attrs as { displayMode?: string | null; src?: string; width?: number | null; height?: number | null };
        // Resolution/source changes own a fresh image and error handler. An
        // old URL's error event must never render or cache the new target.
        if (ua.src !== na.src || updated.attrs.resolved === false ||
          updated.attrs.sourceSyntax !== node.attrs.sourceSyntax) return false;
        // displayMode flips between full / fixed change the resize-
        // handle attachment AND the wrap classes. Rebuild on change.
        if (ua.displayMode !== na.displayMode) {
          return false;
        }
        // Size changed but we're in the broken-placeholder state
        // (no `<img>` to update inline). Rebuild so the placeholder
        // re-renders with the new declared footprint.
        const sizeChanged = ua.width !== na.width || ua.height !== na.height;
        if (!img && (sizeChanged || ua.alt !== node.attrs.alt || ua.title !== node.attrs.title)) return false;
        // Cheap path: src unchanged, just refresh attrs on the
        // existing img if we have one.
        if (ua.src === na.src) {
          if (!img) { node = updated; return true; }
          img.alt = ua.alt ?? "";
          if (ua.title != null) img.title = ua.title;
          else img.removeAttribute("title");
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
        return false;
      },
      stopEvent(event) {
        const target = event.target as Node | null;
        return target === handle || handle.contains(target) ||
          Boolean(target?.instanceOf(Element) &&
            target.closest(".butter-image-edit-button"));
      },
      ignoreMutation(mutation) {
        // This leaf's presentation is owned by its immutable PM node. Resize,
        // loading/error and control DOM changes cannot become document input.
        return mutation.type !== "selection";
      },
      destroy() {
        // If the NodeView tears down mid-drag, the window-level pointer
        // listeners installed in onPointerDown would leak. Remove them
        // unconditionally - removeEventListener is a no-op for handlers
        // that aren't registered, so this is safe even on a clean
        // teardown where pointerup already fired.
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        if (dragging) {
          dragging = false;
          resizeBody.classList.remove("butter-is-image-resizing");
        }
        handle.classList.remove("is-resizing");
        handle.removeEventListener("pointerdown", onPointerDown);
        wrap.removeEventListener("contextmenu", openContextMenu);
        ownedImg?.removeEventListener("error", fallToPlaceholder);
        detachEditButton();
        detachPlacementDrag?.();
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

function commitImageAttributes(
  view: EditorView, pos: number, original: PMNode,
  updated: Readonly<Record<string, unknown>>, validateEdit: (candidate: PMNode) => boolean,
): boolean {
  if (!captureBlockMenuMutation(view, [{ pos, node: original }])()) return false;
  const attrs = prepareImageSourceEdit(original, updated);
  const tr = view.state.tr.setNodeMarkup(pos, undefined, attrs);
  if (!validateEdit(tr.doc)) {
    const refused = view.state.tr;
    markBlockConversionRefusal(refused);
    view.dispatch(refused);
    return false;
  }
  const before = view.state.doc;
  view.dispatch(tr);
  return view.state.doc !== before;
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
  validateEdit: (candidate: PMNode) => boolean,
): void {
  const currentSrc = (node.attrs.src as string) ?? "";
  const currentAlt = (node.attrs.alt as string) ?? "";
  const currentWidth = node.attrs.width as number | null;
  const currentHeight = node.attrs.height as number | null;
  const followsReference = node.attrs.sourceSyntax === "reference";
  const menuPos = getPos();
  if (menuPos == null) return;
  const ownsMenu = captureBlockMenuMutation(view, [{ pos: menuPos, node }]);
  let initialControlValues: Readonly<Record<string, string>> | null = null;
  const renderedRect = imageDom.querySelector("img")?.getBoundingClientRect();
  const layoutActions = imageLayoutActions(
    view,
    getPos() ?? -1,
    renderedRect ? { width: renderedRect.width, height: renderedRect.height } : undefined,
  );

  const commit = (values: Record<string, string>): boolean => {
    if (!ownsMenu()) return false;
    if (followsReference && values.src === currentSrc &&
      ((values.width ?? "").trim() || (values.height ?? "").trim())) return false;
    if (initialControlValues && Object.keys(initialControlValues).every(key => values[key] === initialControlValues![key])) return true;
    const newSrc = values.src;
    const parseDim = (raw: string = ""): number | null | undefined => {
      const value = raw.trim();
      if (!value) return null;
      const n = Number(value);
      return /^[0-9]+$/.test(value) && Number.isSafeInteger(n) && n > 0 ? n : undefined;
    };
    const newWidth = parseDim(values.width);
    const newHeight = parseDim(values.height);
    if (newWidth === undefined || newHeight === undefined) return false;
    const newAlt = values.alt || null;
    if (
      newSrc === currentSrc &&
      newAlt === (currentAlt || null) &&
      newWidth === currentWidth &&
      newHeight === currentHeight
    ) return true;
    const pos = getPos();
    if (pos == null) return false;
    const liveNode = view.state.doc.nodeAt(pos);
    if (!liveNode || liveNode !== node) return false;
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
    return commitImageAttributes(view, pos, node, newAttrs, validateEdit);
  };

  openRichContextMenu({
    app,
    anchor: imageDom,
    event: e,
    autoFocusFirstField: false,
    chrome: {
      icon: "image",
      title: "Image",
      sub: followsReference && node.attrs.resolved === true
        ? "To resize, use the current image directly. It will stop following its reference definition."
        : truncateSrcForHeader(currentSrc),
    },
    fields: ([
      {
        id: "src",
        label: "Source",
        icon: "image",
        initial: currentSrc,
        placeholder: "file.png or https://…",
        autocomplete: "vault-files",
        suggestScope: "image",
        suggestSkipWhen: (raw) => /^(https?:|data:|blob:|file:)/i.test(raw),
        onSuggestSelect: (file, input) => {
          // Image src is the full vault path (not just basename) so
          // metadataCache can resolve it independent of the open
          // file's location.
          input.value = file.path;
          input.dispatchEvent(new Event("input"));
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
    ] satisfies RichMenuField[]).filter(field => !followsReference || !["width", "height"].includes(field.id)),
    actions: [
      ...(followsReference && node.attrs.resolved === true ? [{
        id: "image-use-direct",
        label: "Use current image directly",
        icon: "link",
        separatorBefore: true,
        receivesValues: false,
        onClick: () => {
          if (!ownsMenu()) return false;
          const accepted = commitImageAttributes(view, menuPos, node, {
            ...node.attrs, sourceSyntax: "inline", reference: null, referenceForm: null,
            resolved: true, sourceAlt: null, altSignature: null, sourceRange: null,
          }, validateEdit);
          if (accepted) view.focus();
          return accepted;
        },
      }] : []),
      ...layoutActions.map((action) => ({
      id: `image-layout-${action.id}`,
      label: action.label,
      icon: action.icon,
      separatorBefore: action === layoutActions[0],
      receivesValues: false,
      onClick: () => {
        if (!ownsMenu()) return false;
        const changed = action.run();
        view.focus();
        return changed;
      },
      })),
    ],
    onFieldsReady: values => { initialControlValues = { ...values }; },
    onCommit: (values) => {
      const accepted = commit(values);
      if (accepted) view.focus();
      return accepted;
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
