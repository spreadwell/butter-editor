import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { HANDLE_HEIGHT, HANDLE_OFFSET_TOP } from "./constants";
import type { BlockHit, DragContext, SiblingInfo } from "./types";

export function listItemHandleInset(node: PMNode, dom: HTMLElement): number {
  if (node.type.name !== "list_item") return 0;
  const depth = (node.attrs.depth as number) ?? 0;
  if (depth <= 0) return 0;
  const paddingLeft = parseFloat(getComputedStyle(dom).paddingLeft) || 0;
  return (paddingLeft * depth) / (depth + 1);
}

const MEDIA_EMBED_EXTENSION =
  /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp|m4v|mkv|mov|mp4|ogv|webm)(?:$|[?#])/i;

function isMediaBlock(node: PMNode): boolean {
  if (node.type.name === "image") return true;
  if (node.type.name !== "obsidian_embed") return false;
  const source = String(node.attrs.src ?? "").split("|", 1)[0].trim();
  return MEDIA_EMBED_EXTENSION.test(source);
}

/** Align a handle with the first rendered line, or the upper edge of media. */
export function handlePlacementFor(
  node: PMNode,
  dom: HTMLElement,
  rect: DOMRect,
): { top: number; height: number } {
  if (isMediaBlock(node)) {
    const mediaRect = dom
      .querySelector<HTMLElement>("img, video")
      ?.getBoundingClientRect();
    const visualTop = mediaRect && mediaRect.height > 0
      ? Math.max(rect.top, mediaRect.top)
      : rect.top;
    return { top: visualTop + HANDLE_OFFSET_TOP, height: HANDLE_HEIGHT };
  }

  let glyphCenter: number | null = null;
  const ownerDocument = dom.ownerDocument ?? activeDocument;
  const ownerNodeFilter = ownerDocument.defaultView?.NodeFilter ?? NodeFilter;
  const walker = ownerDocument.createTreeWalker(dom, ownerNodeFilter.SHOW_TEXT);
  const firstText = walker.nextNode() as Text | null;
  if (firstText && firstText.length > 0) {
    try {
      const range = ownerDocument.createRange();
      range.setStart(firstText, 0);
      range.setEnd(firstText, 1);
      const glyph = range.getBoundingClientRect();
      if (glyph.height > 0) glyphCenter = glyph.top + glyph.height / 2;
    } catch { /* detached text node */ }
  }

  return {
    top: glyphCenter == null
      ? rect.top + rect.height / 2 - HANDLE_HEIGHT / 2 + HANDLE_OFFSET_TOP
      : glyphCenter - HANDLE_HEIGHT / 2 + HANDLE_OFFSET_TOP,
    height: HANDLE_HEIGHT,
  };
}

export function collectSiblings(
  view: Pick<EditorView, "nodeDOM">,
  parent: PMNode,
  basePos: number,
): SiblingInfo[] {
  const siblings: SiblingInfo[] = [];
  parent.forEach((child, offset) => {
    const pos = basePos + offset;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    if (rect.height <= 0) return;
    siblings.push({
      pos,
      node: child,
      dom,
      rect,
      index: siblings.length,
    });
  });
  return siblings;
}

export function collectTopLevelSiblings(view: EditorView): SiblingInfo[] {
  return collectSiblings(view, view.state.doc, 0);
}

export function isContainer(node: PMNode): boolean {
  return node.type.name === "obsidian_callout" || node.type.name === "blockquote";
}

export function findContainerContext(
  view: EditorView,
  clientX: number,
  clientY: number,
  excludedPositions?: Set<number>,
): DragContext | null {
  const search = (parent: PMNode, basePos: number): DragContext | null => {
    let pos = basePos;
    for (let index = 0; index < parent.childCount; index++) {
      const child = parent.child(index);
      if (excludedPositions?.has(pos)) {
        pos += child.nodeSize;
        continue;
      }
      if (isContainer(child)) {
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement) {
          const rect = dom.getBoundingClientRect();
          if (
            clientX >= rect.left && clientX <= rect.right &&
            clientY >= rect.top && clientY <= rect.bottom
          ) {
            const deeper = search(child, pos + 1);
            if (deeper) return deeper;
            return { containerPos: pos, containerNode: child, containerDom: dom };
          }
        }
      }
      pos += child.nodeSize;
    }
    return null;
  };
  return search(view.state.doc, 0);
}

function blockAtY(
  siblings: SiblingInfo[],
  clientY: number,
): SiblingInfo | null {
  if (siblings.length === 0) return null;
  if (clientY < siblings[0].rect.top) return null;
  if (clientY > siblings[siblings.length - 1].rect.bottom) return null;
  let nearest: SiblingInfo | null = null;
  let nearestDistance = Infinity;
  for (const sibling of siblings) {
    if (clientY >= sibling.rect.top && clientY <= sibling.rect.bottom) {
      return sibling;
    }
    const distance = clientY < sibling.rect.top
      ? sibling.rect.top - clientY
      : clientY - sibling.rect.bottom;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = sibling;
    }
  }
  return nearest;
}

function pickNearestSibling(
  siblings: SiblingInfo[],
  clientY: number,
  context: DragContext | null,
): BlockHit | null {
  for (const sibling of siblings) {
    if (clientY >= sibling.rect.top && clientY <= sibling.rect.bottom) {
      return { ...sibling, context };
    }
  }
  let closest: SiblingInfo | null = null;
  let closestDistance = Infinity;
  for (const sibling of siblings) {
    const distance = Math.abs(clientY - (sibling.rect.top + sibling.rect.height / 2));
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = sibling;
    }
  }
  return closest ? { ...closest, context } : null;
}

function resolveHandleTarget(
  view: EditorView,
  topHit: BlockHit,
  clientY: number,
): BlockHit {
  let current = topHit;
  while (isContainer(current.node)) {
    const siblings = collectSiblings(view, current.node, current.pos + 1);
    const child = blockAtY(siblings, clientY);
    if (!child) break;
    const inherentQuoteParagraph =
      current.node.type.name === "blockquote" &&
      siblings[0]?.pos === child.pos &&
      child.node.type.name === "paragraph";
    if (inherentQuoteParagraph) break;
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
  const editorRect = view.dom.getBoundingClientRect();
  const probeX = Math.min(
    Math.max(clientX, editorRect.left + 1),
    editorRect.right - 1,
  );
  let topHit: BlockHit | null = null;
  const coords = view.posAtCoords({ left: probeX, top: clientY });
  if (coords) {
    const resolved = view.state.doc.resolve(
      Math.max(0, Math.min(coords.pos, view.state.doc.content.size)),
    );
    if (resolved.depth >= 1) {
      const pos = resolved.before(1);
      const node = view.state.doc.nodeAt(pos);
      const dom = view.nodeDOM(pos);
      if (node && dom instanceof HTMLElement) {
        topHit = { pos, node, dom, rect: dom.getBoundingClientRect(), context: null };
      }
    }
  }

  if (!topHit) {
    return pickNearestSibling(collectTopLevelSiblings(view), clientY, null);
  }
  return isContainer(topHit.node)
    ? resolveHandleTarget(view, topHit, clientY)
    : topHit;
}
