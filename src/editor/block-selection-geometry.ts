export interface BlockSelectionBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function isWhitespaceOnlyText(node: ChildNode): boolean {
  return node.nodeType === node.TEXT_NODE && !(node.textContent ?? "").trim();
}

/** Resolve an image-sized visual target only when the supplied DOM represents
 * a complete image block. Structural drag/drop geometry deliberately keeps
 * using the full row; this helper is only for hover and selection chrome. */
export function standaloneImageVisual(
  dom: HTMLElement,
  ownerWindow: typeof window,
): HTMLElement | null {
  if (dom.classList.contains("butter-image")) {
    return dom;
  }

  if (
    dom.classList.contains("butter-obsidian-embed") &&
    !dom.classList.contains("butter-obsidian-embed-inline")
  ) {
    return dom.querySelector<HTMLElement>(".butter-embed-image-resizable");
  }

  if (dom.tagName !== "P") return null;

  const imageHosts = Array.from(dom.children).filter((child): child is HTMLElement =>
    child.instanceOf(ownerWindow.HTMLElement) &&
    (
      child.classList.contains("butter-image") ||
      child.classList.contains("butter-obsidian-embed-inline")
    )
  );
  if (imageHosts.length !== 1) return null;

  const imageHost = imageHosts[0];
  const hasOtherContent = Array.from(dom.childNodes).some((child) => {
    if (child === imageHost || isWhitespaceOnlyText(child)) return false;
    return !(
      child.instanceOf(ownerWindow.HTMLElement) &&
      child.classList.contains("ProseMirror-trailingBreak")
    );
  });
  if (hasOtherContent) return null;

  if (imageHost.classList.contains("butter-image")) return imageHost;
  return imageHost.querySelector<HTMLElement>(".butter-embed-image-resizable");
}

/** Bounds for block-selection chrome. Image-only blocks use the rendered
 * image footprint; list rows omit padding that belongs to inter-row flow. */
export function blockSelectionBounds(
  dom: HTMLElement,
  ownerWindow: typeof window,
): BlockSelectionBounds {
  const imageVisual = standaloneImageVisual(dom, ownerWindow);
  if (imageVisual) return imageVisual.getBoundingClientRect();

  const rect = dom.getBoundingClientRect();
  if (!dom.classList.contains("butter-list-item")) return rect;

  const paddingTop = Number.parseFloat(ownerWindow.getComputedStyle(dom).paddingTop);
  return {
    top: rect.top + (Number.isFinite(paddingTop) ? paddingTop : 0),
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
  };
}
