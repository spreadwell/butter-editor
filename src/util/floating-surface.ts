export function bindFloatingSurfaceReposition(reposition: () => void): () => void {
  let frame: number | null = null;
  let disposed = false;

  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      if (!disposed) reposition();
    });
  };

  activeDocument.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);

  return () => {
    disposed = true;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    activeDocument.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
  };
}

export function placeFixedPopoverAtAnchor(
  popover: HTMLElement,
  anchor: HTMLElement,
  options: { gap?: number; margin?: number } = {},
): void {
  const gap = options.gap ?? 6;
  const margin = options.margin ?? 8;
  const anchorRect = anchor.getBoundingClientRect();

  popover.addClass("butter-pos-fixed");
  popover.setCssProps({
    "--butter-pos-left": "0px",
    "--butter-pos-top": "0px",
  });

  const popoverRect = popover.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const belowTop = anchorRect.bottom + gap;
  const aboveTop = anchorRect.top - gap - popoverRect.height;
  const hasRoomAbove = aboveTop >= margin;
  const overflowsBelow = belowTop + popoverRect.height > viewportHeight - margin;
  const rawTop = overflowsBelow && hasRoomAbove ? aboveTop : belowTop;
  const maxTop = Math.max(margin, viewportHeight - popoverRect.height - margin);
  const maxLeft = Math.max(margin, viewportWidth - popoverRect.width - margin);

  popover.setCssProps({
    "--butter-pos-left": `${Math.max(margin, Math.min(anchorRect.left, maxLeft))}px`,
    "--butter-pos-top": `${Math.max(margin, Math.min(rawTop, maxTop))}px`,
  });
}

export function bindFixedPopoverToAnchor(
  popover: HTMLElement,
  anchor: HTMLElement,
  options: { gap?: number; margin?: number } = {},
): () => void {
  const reposition = () => placeFixedPopoverAtAnchor(popover, anchor, options);
  reposition();
  const unbindFloating = bindFloatingSurfaceReposition(reposition);
  const resizeObserver = new ResizeObserver(reposition);
  resizeObserver.observe(popover);
  resizeObserver.observe(anchor);

  return () => {
    unbindFloating();
    resizeObserver.disconnect();
  };
}
