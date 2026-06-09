import { SiblingInfo, DragContext, DropSlot, BlockHit } from "./types";
import { HANDLE_HEIGHT } from "./constants";


import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";





// ── Constants ────────────────────────────────────────────────


export function listItemHandleInset(node: PMNode, dom: HTMLElement): number {
  if (node.type.name !== "list_item") return 0;
  const depth = (node.attrs.depth as number) ?? 0;
  if (depth <= 0) return 0;
  const padLeft = parseFloat(getComputedStyle(dom).paddingLeft) || 0;
  return (padLeft * depth) / (depth + 1);
}

/** Vertical handle placement keyed to the FIRST LINE of content.
 *
 *  Strategy for all text-bearing blocks: measure the actual glyph rect
 *  of the first character with a DOM Range. That gives the visual
 *  center of the first line — works for single-line paragraphs,
 *  multi-line paragraphs (where the box center is far from line 1),
 *  list items (where the glyph baseline matches the bullet), and
 *  headings (where line-height varies by font size).
 *
 *  Falls back to padding + line-height estimate when no text is
 *  present, and finally to box-top + clamped height for blocks
 *  without text at all (e.g. empty image lines, separators). */
export function handlePlacementFor(
  _node: PMNode,
  dom: HTMLElement,
  rect: DOMRect,
): { top: number; height: number } {
  let glyphCenter: number | null = null;
  const walker = activeDocument.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
  const firstText = walker.nextNode() as Text | null;
  if (firstText && firstText.length > 0) {
    try {
      const range = activeDocument.createRange();
      range.setStart(firstText, 0);
      range.setEnd(firstText, 1);
      const r = range.getBoundingClientRect();
      if (r.height > 0) glyphCenter = r.top + r.height / 2;
    } catch { /* */ }
  }
  if (glyphCenter != null) {
    return { top: glyphCenter - HANDLE_HEIGHT / 2, height: HANDLE_HEIGHT };
  }
  return {
    top: rect.top + rect.height / 2 - HANDLE_HEIGHT / 2,
    height: HANDLE_HEIGHT,
  };
}

export function collectSiblings(
  view: EditorView,
  parent: PMNode,
  basePos: number,
): SiblingInfo[] {
  const siblings: SiblingInfo[] = [];
  // `index` is DENSE over the siblings we actually keep — it must equal
  // each sibling's position in the returned array, NOT the PM child
  // index. Zero-height / display:none blocks (e.g. a top-level
  // `block_comment`, which renders `display:none`) are skipped as
  // siblings; if we still advanced `index` for them, every block below
  // would carry a gapped index. Consumers that use `index` as an array
  // offset (predictPostDropDraggedRect's `newIdx` into `nonDragged`)
  // would then overshoot by one per skipped block, throwing the drop
  // filler and ghost-landing that far down. Nothing needs the true PM
  // child index — insertion is computed from `sib.pos` (absolute), and
  // every other use of `index` is an ordinal `>=` / map key. So only
  // advance it when a sibling is actually pushed.
  let index = 0;
  parent.forEach((child, offset) => {
    const absPos = basePos + offset;
    const dom = view.nodeDOM(absPos);
    if (dom instanceof HTMLElement) {
      const rect = dom.getBoundingClientRect();
      if (rect.height > 0) {
        siblings.push({ pos: absPos, node: child, dom, rect, index, dragIdx: -1 });
        index++;
      }
    }
  });
  return siblings;
}

export function stampDragIndexes(
  view: EditorView,
  siblings: SiblingInfo[],
): void {
  suppressObserver(view, () => {
    for (const sib of siblings) {
      sib.dragIdx = nextDragIdx++;
      sib.dom.setAttribute("data-butter-drag-idx", String(sib.dragIdx));
    }
  });
}

export function clearDragIndexes(
  view: EditorView,
  siblings: SiblingInfo[],
): void {
  suppressObserver(view, () => {
    for (const sib of siblings) {
      sib.dom.removeAttribute("data-butter-drag-idx");
    }
  });
}

export function collectTopLevelSiblings(view: EditorView): SiblingInfo[] {
  return collectSiblings(view, view.state.doc, 0);
}

export function collectContainerSiblings(
  view: EditorView,
  ctx: DragContext,
): SiblingInfo[] {
  const contentStart = ctx.containerPos + 1;
  return collectSiblings(view, ctx.containerNode, contentStart);
}

export function isContainer(node: PMNode): boolean {
  const name = node.type.name;
  return (
    (name === "obsidian_callout" || name === "blockquote") &&
    node.childCount > 0
  );
}

/** Walk the doc depth-first, emitting one `DropSlot` per visual
 *  insertion point (between any two adjacent visible blocks, plus at
 *  the start and end of each container). Slots are returned in visual
 *  document order — adjacent slots are adjacent in Y, so a direction-
 *  gated cascade over the flat list naturally produces linear feel
 *  when dragging past or through nested containers.
 *
 *  Dragged blocks are SKIPPED as slot anchors (no "before-dragged"
 *  slot is emitted — those would map to no-op positions) but still
 *  occupy layout. The siblings-by-container map includes them so
 *  reflow can compute gap-closure correctly. */
export function collectDropSlots(
  view: EditorView,
  draggedSet: Set<number>,
): { slots: DropSlot[]; siblingsByContainer: Map<number, SiblingInfo[]> } {
  const slots: DropSlot[] = [];
  const siblingsByContainer = new Map<number, SiblingInfo[]>();

  function walk(parent: PMNode, basePos: number, ctx: DragContext | null): void {
    const ctxKey = ctx?.containerPos ?? -1;
    const siblings = collectSiblings(view, parent, basePos);
    siblingsByContainer.set(ctxKey, siblings);

    let lastNonDragged: SiblingInfo | null = null;
    for (const sib of siblings) {
      const isDragged = draggedSet.has(sib.pos);
      const childIsContainer = isContainer(sib.node);
      if (!isDragged) {
        slots.push({
          context: ctx,
          indexInContainer: sib.index,
          triggerEl: sib.dom,
          triggerRect: sib.rect,
          triggerEdge: "top",
          isContainerEntry: childIsContainer,
        });
        lastNonDragged = sib;
      }
      // Recurse into containers (unless the container itself is being
      // dragged — then its children move with it as a unit).
      if (!isDragged && childIsContainer) {
        walk(sib.node, sib.pos + 1, {
          containerPos: sib.pos,
          containerNode: sib.node,
          containerDom: sib.dom,
        });
      }
    }

    // After-last slot in this container — "insert at end".
    if (siblings.length > 0) {
      const lastIdx = siblings[siblings.length - 1].index;
      if (ctx) {
        // Nested container: trigger off the container's outer bottom
        // so the slot owns the range up to the container's bottom edge,
        // giving a graceful exit zone.
        slots.push({
          context: ctx,
          indexInContainer: lastIdx + 1,
          triggerEl: ctx.containerDom!,
          triggerRect: ctx.containerDom!.getBoundingClientRect(),
          triggerEdge: "bottom",
          isContainerEntry: false,
        });
      } else if (lastNonDragged) {
        // Doc root: trigger off the last visible block's bottom.
        slots.push({
          context: null,
          indexInContainer: lastIdx + 1,
          triggerEl: lastNonDragged.dom,
          triggerRect: lastNonDragged.rect,
          triggerEdge: "bottom",
          isContainerEntry: false,
        });
      }
    } else if (ctx) {
      // Empty container: one slot at index 0 anchored to container's top.
      slots.push({
        context: ctx,
        indexInContainer: 0,
        triggerEl: ctx.containerDom!,
        triggerRect: ctx.containerDom!.getBoundingClientRect(),
        triggerEdge: "top",
        isContainerEntry: false,
      });
    }
  }

  walk(view.state.doc, 0, null);
  return { slots, siblingsByContainer };
}

export function findContainerContext(
  view: EditorView,
  clientX: number,
  clientY: number,
  excludedPositions?: Set<number>,
): DragContext | null {
  // Recursively find the deepest container at the pointer position.
  // A container in `excludedPositions` (and any descendant of one) is
  // skipped — used during drag to keep the dragged container from
  // becoming its own drop target, which would otherwise let the
  // padded-context-dom logic inflate the source's content area.
  function search(
    parent: PMNode,
    basePos: number,
  ): DragContext | null {
    let pos = basePos;
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i);
      if (excludedPositions?.has(pos)) {
        pos += child.nodeSize;
        continue;
      }
      if (isContainer(child)) {
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
          const rect = dom.getBoundingClientRect();
          if (
            clientY >= rect.top &&
            clientY <= rect.bottom &&
            clientX >= rect.left &&
            clientX <= rect.right
          ) {
            // Check for a deeper container inside this one.
            const deeper = search(child, pos + 1);
            if (deeper) return deeper;
            return {
              containerPos: pos,
              containerNode: child,
              containerDom: dom,
            };
          }
        }
      }
      pos += child.nodeSize;
    }
    return null;
  }

  return search(view.state.doc, 0);
}

/** The child block at clientY within a container's child list. Returns
 *  the containing child, or the NEAREST child when clientY falls in an
 *  inter-block gap — so the gaps between nested handles map to a child,
 *  not to the container. Returns null when clientY is above the first
 *  child or below the last: that region is the container's own chrome
 *  (a callout title, bottom padding), which belongs to the container. */
function blockAtY(siblings: SiblingInfo[], clientY: number): SiblingInfo | null {
  if (siblings.length === 0) return null;
  if (clientY < siblings[0].rect.top) return null;
  if (clientY > siblings[siblings.length - 1].rect.bottom) return null;
  let nearest: SiblingInfo | null = null;
  let nearestDist = Infinity;
  for (const sib of siblings) {
    if (clientY >= sib.rect.top && clientY <= sib.rect.bottom) return sib;
    const d = clientY < sib.rect.top ? sib.rect.top - clientY : clientY - sib.rect.bottom;
    if (d < nearestDist) { nearestDist = d; nearest = sib; }
  }
  return nearest;
}

/** Nearest sibling by vertical position — exhaustive-scan fallback for
 *  when the browser can't resolve a position at the pointer. */
function pickNearestSibling(
  siblings: SiblingInfo[],
  clientY: number,
  context: DragContext | null,
): BlockHit | null {
  for (const sib of siblings) {
    if (clientY >= sib.rect.top && clientY <= sib.rect.bottom) {
      return { pos: sib.pos, node: sib.node, dom: sib.dom, rect: sib.rect, context };
    }
  }
  let closest: SiblingInfo | null = null;
  let closestDist = Infinity;
  for (const sib of siblings) {
    const mid = sib.rect.top + sib.rect.height / 2;
    const dist = Math.abs(clientY - mid);
    if (dist < closestDist) {
      closestDist = dist;
      closest = sib;
    }
  }
  if (closest) {
    return { pos: closest.pos, node: closest.node, dom: closest.dom, rect: closest.rect, context };
  }
  return null;
}

/** Within a top-level container, descend to the block the pointer is
 *  over, purely by ROW (clientY). At each level blockAtY picks the child
 *  whose row contains clientY — or the nearest child across an
 *  inter-block gap — and we step into it; if clientY is over the
 *  container's own chrome (title row, bottom padding) blockAtY returns
 *  null and we stop, grabbing the container.
 *
 *  X is intentionally ignored. The whole row, gutter included, belongs
 *  to the block at that Y, so a nested block's handle is grabbable
 *  across the full gutter without the container stealing it when the
 *  pointer drifts left. (An earlier version gated the descent on an
 *  X midpoint between the container's and child's handle columns, but
 *  inside a callout those columns sit only ~2px apart — the callout
 *  indent ≈ the handle offset — so the nested handle had no left margin
 *  and clipped to the callout the instant the pointer moved left.) Each
 *  container is instead reached over its OWN title / chrome row. */
function resolveHandleTarget(
  view: EditorView,
  topHit: BlockHit,
  clientY: number,
): BlockHit {
  let current = topHit;
  while (isContainer(current.node)) {
    const siblings = collectSiblings(view, current.node, current.pos + 1);
    const child = blockAtY(siblings, clientY);
    if (!child) break; // over the container's own chrome → grab it
    // First paragraph of a blockquote is inherent to the quote — never
    // descend into it; grabbing it grabs the quote.
    const isInherentFirstPara =
      current.node.type.name === "blockquote" &&
      siblings[0]?.pos === child.pos &&
      child.node.type.name === "paragraph";
    if (isInherentFirstPara) break;
    current = {
      pos: child.pos,
      node: child.node,
      dom: child.dom,
      rect: child.rect,
      context: {
        containerPos: current.pos,
        containerNode: current.node,
        containerDom: current.dom,
      },
    };
  }
  return current;
}

export function findBlockUnderPointer(
  view: EditorView,
  clientX: number,
  clientY: number,
): BlockHit | null {
  // Probe the top-level block at the pointer's Y. The pointer usually
  // sits in the left gutter (handle zone, no text), so probe at the
  // content-column edge with the pointer's Y rather than measuring every
  // top-level block — collecting all siblings here ran
  // getBoundingClientRect on the whole document on every pointer move
  // (O(doc) forced layout, the dominant hover cost in large notes).
  const editorRect = view.dom.getBoundingClientRect();
  const probeX = Math.min(
    Math.max(clientX, editorRect.left + 1),
    editorRect.right - 1,
  );
  let topHit: BlockHit | null = null;
  const coords = view.posAtCoords({ left: probeX, top: clientY });
  if (coords) {
    const $pos = view.state.doc.resolve(
      Math.max(0, Math.min(coords.pos, view.state.doc.content.size)),
    );
    if ($pos.depth >= 1) {
      const topPos = $pos.before(1);
      const topNode = view.state.doc.nodeAt(topPos);
      const dom = view.nodeDOM(topPos);
      if (topNode && dom instanceof HTMLElement) {
        topHit = {
          pos: topPos,
          node: topNode,
          dom,
          rect: dom.getBoundingClientRect(),
          context: null,
        };
      }
    }
  }

  // Last resort: the browser couldn't resolve a position (empty doc,
  // pointer outside any row). Fall back to the exhaustive scan.
  if (!topHit) {
    return pickNearestSibling(collectTopLevelSiblings(view), clientY, null);
  }

  // A non-container top-level block is the target directly.
  if (!isContainer(topHit.node)) return topHit;

  // Container: descend by row to the nested block the pointer is over.
  // The whole row (gutter included) belongs to the block at that Y, so
  // nested handles don't get stolen by the outer container. The
  // container is reached over its own title / chrome row. See
  // resolveHandleTarget.
  return resolveHandleTarget(view, topHit, clientY);
}

// ── Drop filler ──────────────────────────────────────────────
// A visible placeholder shown in the gap that the dragged block
// will fall into. Lives on document.body, position:fixed, sized
// and positioned to match the open gap.

export function suppressObserver(view: EditorView, fn: () => void): void {
  const obs = (view as EditorView & { domObserver?: { stop: () => void, start: () => void } }).domObserver;
  if (obs) {
    obs.stop();
    try { fn(); } finally { obs.start(); }
  } else {
    fn();
  }
}

// ── Injected stylesheet for transforms ───────────────────────
// Instead of setting inline style.transform on PM-managed elements
// (which PM's MutationObserver strips), we inject a <style> element
// and write CSS rules targeting data-butter-drag-idx attributes.
// PM's observer only watches its own DOM subtree — it has zero
// visibility into stylesheet changes.


export let nextDragIdx = 0;
