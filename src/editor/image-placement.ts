import { setIcon } from "obsidian";
import { Fragment, type Node as PMNode, type Schema } from "prosemirror-model";
import { NodeSelection, type EditorState, type SelectionBookmark, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { deselectSelectedLeaf, resolveInterBlockGap } from "./click-to-spawn";
import { canResizeEmbedSource, parseEmbedSize, resizeEmbedSource } from "./embed-image-resize";
import { linkOccurrence, linkOccurrenceRange } from "../core/link-occurrence";
import { markBlockConversionRefusal } from "./native-block-id-conservation";
import { sourceGeneration } from "./source-generation";

const DRAG_THRESHOLD_PX = 5;

interface SourceRange {
  from: number;
  to: number;
  node: PMNode;
}

export interface ImageRenderedSize {
  width: number;
  height: number;
}

export interface ImageLayoutAction {
  id: "standalone" | "inline-previous" | "inline-next";
  label: string;
  icon: string;
  run(): boolean;
}

function isImageNode(node: PMNode | null | undefined): node is PMNode {
  const name = node?.type.name;
  return name === "image" || name === "obsidian_embed" || name === "obsidian_embed_inline";
}

function imageAsInline(node: PMNode, schema: Schema, renderedSize?: ImageRenderedSize): PMNode | null {
  if (node.type.name === "image") {
    // Reference image dimensions belong to the literal alt, rather than native
    // sizing syntax. Placement must keep the current definition dependency.
    if (node.attrs.sourceSyntax === "reference" || node.attrs.width != null || !renderedSize?.width) return node;
    // Explicit inline placement must survive the auto-split pass. Recording
    // the image's current rendered width both preserves its visual footprint
    // and emits standard Obsidian-compatible image-size Markdown.
    return node.type.create({
      ...node.attrs,
      width: Math.max(1, Math.round(renderedSize.width)),
      height: null,
      displayMode: null,
      sourceRange: null,
    }, null, node.marks);
  }
  const type = schema.nodes.obsidian_embed_inline;
  if (!type) return null;
  const rawSrc = String(node.attrs.src ?? "");
  const sized = parseEmbedSize(rawSrc);
  const src = node.attrs.literalSource == null && sized.width == null && renderedSize?.width && canResizeEmbedSource(rawSrc)
    ? resizeEmbedSource(rawSrc, Math.max(1, Math.round(renderedSize.width)), null)
    : rawSrc;
  return type.create({ ...node.attrs, src }, null, node.marks);
}

function imageAsStandalone(node: PMNode, schema: Schema, parent: PMNode): PMNode | null {
  if (node.type.name === "image") {
    return schema.nodes.paragraph?.create(null, node) ?? null;
  }
  // A list_item must begin with a paragraph and the parser deliberately
  // keeps embeds inline there. Other block containers use the canonical
  // block embed node when the image occupies its own line.
  if (parent.type.name === "list_item" || node.marks.length || node.attrs.literalSource != null) {
    const inline = imageAsInline(node, schema);
    return inline ? schema.nodes.paragraph?.create(null, inline) ?? null : null;
  }
  return schema.nodes.obsidian_embed?.create({ src: String(node.attrs.src ?? "") }) ?? null;
}

function sourceRange(state: EditorState, pos: number): SourceRange | null {
  if (!Number.isSafeInteger(pos) || pos < 0 || pos >= state.doc.content.size) return null;
  const node = state.doc.nodeAt(pos);
  if (!isImageNode(node)) return null;
  if (node.type.name === "obsidian_embed") return { from: pos, to: pos + node.nodeSize, node };

  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.inlineContent) return { from: pos, to: pos + node.nodeSize, node };
  const parent = $pos.parent;
  const parentPos = $pos.before();
  const soleChild = parent.childCount === 1 && parent.firstChild === node;
  const mustKeepLeadingParagraph =
    $pos.depth > 1 &&
    $pos.node($pos.depth - 1).type.name === "list_item" &&
    $pos.index($pos.depth - 1) === 0;
  return soleChild && !mustKeepLeadingParagraph
    ? { from: parentPos, to: parentPos + parent.nodeSize, node }
    : { from: pos, to: pos + node.nodeSize, node };
}

function mapAfterDelete(tr: Transaction, pos: number, source: SourceRange): number {
  return tr.mapping.map(pos, pos <= source.from ? -1 : 1);
}

interface ScrollSnapshot {
  element: Element;
  left: number;
  top: number;
}

function dispatchImageMove(
  view: EditorView,
  tr: Transaction,
  selectionBookmark?: SelectionBookmark,
): boolean {
  const before = view.state.doc;
  if (selectionBookmark) {
    try {
      tr.setSelection(selectionBookmark.map(tr.mapping).resolve(tr.doc));
    } catch {
      // The prior selection may belong to content removed by an unusual
      // structural conversion. ProseMirror's mapped fallback remains valid.
    }
  }

  // Pure transaction tests use a minimal EditorView-shaped harness without
  // DOM. Selection mapping still applies there; viewport preservation is a
  // browser-only concern.
  if (!view.dom) {
    view.dispatch(tr);
    return view.state.doc !== before;
  }

  const snapshots: ScrollSnapshot[] = [];
  let element: Element | null = view.dom;
  while (element) {
    if (element.instanceOf(HTMLElement) && (
      element.scrollTop !== 0 ||
      element.scrollLeft !== 0 ||
      element.scrollHeight > element.clientHeight ||
      element.scrollWidth > element.clientWidth
    )) {
      snapshots.push({ element, left: element.scrollLeft, top: element.scrollTop });
    }
    element = element.parentElement;
  }
  const scrolling = view.dom.ownerDocument.scrollingElement;
  if (scrolling && !snapshots.some((entry) => entry.element === scrolling)) {
    snapshots.push({ element: scrolling, left: scrolling.scrollLeft, top: scrolling.scrollTop });
  }
  const restore = () => {
    for (const snapshot of snapshots) {
      snapshot.element.scrollLeft = snapshot.left;
      snapshot.element.scrollTop = snapshot.top;
    }
  };

  view.dispatch(tr);
  restore();
  // Native embed NodeViews finish their delegated render asynchronously.
  // Reassert the viewport across the next two layouts so that delayed image
  // mount/reflow cannot invoke browser scroll anchoring after the move.
  const ownerWindow = view.dom.ownerDocument.defaultView;
  ownerWindow?.requestAnimationFrame(() => {
    restore();
    ownerWindow.requestAnimationFrame(restore);
  });
  return view.state.doc !== before;
}

function canPlaceImage(view: EditorView): boolean {
  return !view.isDestroyed && view.editable !== false;
}

function ownsImagePlacement(view: EditorView, doc: PMNode, pos: number, node: PMNode): boolean {
  return canPlaceImage(view) && view.state.doc === doc && view.state.doc.nodeAt(pos) === node;
}

function canMoveCompleteImageOwner(view: EditorView, pos: number, node: PMNode): boolean {
  if (!linkOccurrence(node)) return true;
  const owner = linkOccurrenceRange(view.state.doc, pos);
  if (!owner || owner.from === pos && owner.to === pos + node.nodeSize) return true;
  // Moving one leaf out of a complete source label would split one native
  // occurrence into several. Preserve that owner rather than invent aliases.
  const refusal = view.state.tr;
  markBlockConversionRefusal(refusal);
  view.dispatch(refusal);
  return false;
}

export function moveImageInline(
  view: EditorView,
  sourcePos: number,
  targetPos: number,
  renderedSize?: ImageRenderedSize,
  selectionBookmark?: SelectionBookmark,
): boolean {
  if (!canPlaceImage(view) || !Number.isSafeInteger(targetPos) || targetPos < 0 || targetPos > view.state.doc.content.size) return false;
  const source = sourceRange(view.state, sourcePos);
  if (!source || (targetPos >= source.from && targetPos <= source.to)) return false;
  if (!canMoveCompleteImageOwner(view, sourcePos, source.node)) return false;
  const inline = imageAsInline(source.node, view.state.schema, renderedSize);
  if (!inline) return false;

  const tr = view.state.tr.delete(source.from, source.to);
  const mapped = mapAfterDelete(tr, targetPos, source);
  const $target = tr.doc.resolve(Math.max(0, Math.min(mapped, tr.doc.content.size)));
  if (!$target.parent.inlineContent) return false;
  const index = $target.index();
  if (!$target.parent.canReplaceWith(index, index, inline.type, inline.marks)) return false;
  tr.insert(mapped, inline);
  return dispatchImageMove(view, tr, selectionBookmark);
}

export function moveImageStandalone(
  view: EditorView,
  sourcePos: number,
  targetPos: number,
  selectionBookmark?: SelectionBookmark,
): boolean {
  if (!canPlaceImage(view) || !Number.isSafeInteger(targetPos) || targetPos < 0 || targetPos > view.state.doc.content.size) return false;
  const source = sourceRange(view.state, sourcePos);
  if (!source || (targetPos >= source.from && targetPos <= source.to)) return false;
  if (!canMoveCompleteImageOwner(view, sourcePos, source.node)) return false;

  const tr = view.state.tr.delete(source.from, source.to);
  const mapped = mapAfterDelete(tr, targetPos, source);
  const $target = tr.doc.resolve(Math.max(0, Math.min(mapped, tr.doc.content.size)));
  const standalone = imageAsStandalone(source.node, view.state.schema, $target.parent);
  if (!standalone) return false;
  const index = $target.index();
  if (!$target.parent.canReplaceWith(index, index, standalone.type)) return false;
  tr.insert(mapped, standalone);
  return dispatchImageMove(view, tr, selectionBookmark);
}

function blockBoundaryFor(view: EditorView, clientY: number) {
  const gap = resolveInterBlockGap(view, clientY);
  if (!gap) return null;
  return {
    pos: gap.insertPos,
    top: gap.midY,
    left: gap.left,
    width: gap.width,
    gutterWidth: gap.gutterWidth,
  };
}

function inlineTargetFor(view: EditorView, clientX: number, clientY: number) {
  const hit = activeDocument.elementFromPoint(clientX, clientY);
  if (!(hit instanceof Element) || !view.dom.contains(hit)) return null;
  const textblock = hit.closest("p, h1, h2, h3, h4, h5, h6");
  if (!(textblock instanceof HTMLElement) || !view.dom.contains(textblock)) return null;
  const rect = textblock.getBoundingClientRect();
  if (clientY < rect.top || clientY > rect.bottom || clientX < rect.left || clientX > rect.right) return null;
  const coords = view.posAtCoords({ left: clientX, top: clientY });
  if (!coords) return null;
  const pos = Math.max(0, Math.min(coords.pos, view.state.doc.content.size));
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.inlineContent) return null;
  const caret = view.coordsAtPos(pos);
  const lineHeight = Math.max(18, caret.bottom - caret.top);
  return { pos, left: caret.left, top: caret.top, height: lineHeight };
}

function createPlacementUi(image: HTMLImageElement) {
  const ghost = activeWindow.createDiv({ cls: "butter-image-move-ghost" });
  const preview = image.cloneNode(false) as HTMLImageElement;
  preview.removeAttribute("id");
  preview.draggable = false;
  ghost.appendChild(preview);
  const badge = ghost.createSpan({ cls: "butter-image-move-badge" });
  setIcon(badge, "image");

  const block = activeWindow.createDiv({ cls: "butter-spawn-hint butter-image-block-drop-indicator" });
  block.setAttribute("aria-hidden", "true");
  const blockIcon = block.createSpan({ cls: "butter-image-block-drop-icon" });
  setIcon(blockIcon, "image");

  const caret = activeWindow.createDiv({ cls: "butter-image-inline-drop-indicator" });
  caret.setAttribute("aria-hidden", "true");
  const caretIcon = caret.createSpan({ cls: "butter-image-inline-drop-icon" });
  setIcon(caretIcon, "image");

  activeDocument.body.append(ghost, block, caret);
  return {
    ghost,
    block,
    caret,
    remove() { ghost.remove(); block.remove(); caret.remove(); },
  };
}

export function attachImageBodyPlacementDrag(options: {
  image: HTMLImageElement;
  view: EditorView;
  getPos: () => number | undefined;
}): () => void {
  const { image, view, getPos } = options;
  image.draggable = false;
  let armed: {
    x: number; y: number; pointerId: number; pointerType: string;
    doc: PMNode; pos: number; node: PMNode; editorDOM: HTMLElement; generation: symbol | null;
  } | null = null;
  let pendingClick: { selection: NodeSelection; storedMarks: EditorState["storedMarks"]; consumed: boolean } | null = null;
  let ui: ReturnType<typeof createPlacementUi> | null = null;
  let target: { kind: "inline" | "block"; pos: number } | null = null;
  let renderedSize: ImageRenderedSize | undefined;
  let selectionBookmark: SelectionBookmark | undefined;

  const clear = () => {
    armed = null;
    pendingClick = null;
    target = null;
    renderedSize = undefined;
    selectionBookmark = undefined;
    ui?.remove();
    ui = null;
    activeDocument.body.classList.remove("butter-is-image-dragging");
    activeWindow.removeEventListener("pointermove", onMove);
    activeWindow.removeEventListener("pointerup", onUp);
    activeWindow.removeEventListener("pointercancel", onCancel);
    activeWindow.removeEventListener("keydown", onKeyDown, true);
  };

  const currentPos = () => {
    try { return getPos(); } catch { return undefined; }
  };
  const ownsGesture = (source: NonNullable<typeof armed>) => {
    if (
      !ownsImagePlacement(view, source.doc, source.pos, source.node) ||
      currentPos() !== source.pos || sourceGeneration(view.state) !== source.generation ||
      view.dom !== source.editorDOM || !view.dom.isConnected || !image.isConnected || !view.dom.contains(image)
    ) return false;
    const nodeDOM = view.nodeDOM(source.pos);
    return nodeDOM instanceof Element && nodeDOM.contains(image);
  };
  const ownsClickIntent = () => Boolean(
    armed && pendingClick && ownsGesture(armed) &&
    view.state.selection === pendingClick.selection && view.state.storedMarks === pendingClick.storedMarks,
  );
  const isPlainPrimaryPress = (event: MouseEvent) => event.button === 0 &&
    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

  const onMouseDown = (event: MouseEvent) => {
    if (!pendingClick) return;
    if (event.target !== image || !isPlainPrimaryPress(event) || !ownsClickIntent()) {
      pendingClick = null;
      return;
    }
    // The selected image owns this press until it is a click or a drag. Stop
    // compatibility mousedown before click-to-spawn or native caret selection.
    pendingClick.consumed = true;
    event.preventDefault();
    event.stopPropagation();
  };

  const promote = (event: PointerEvent) => {
    pendingClick = null;
    ui = createPlacementUi(image);
    activeDocument.body.classList.add("butter-is-image-dragging");
    image.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const updateUi = (event: PointerEvent) => {
    if (!ui) return;
    ui.ghost.style.left = `${event.clientX + 14}px`;
    ui.ghost.style.top = `${event.clientY + 14}px`;

    const inline = inlineTargetFor(view, event.clientX, event.clientY);
    if (inline) {
      target = { kind: "inline", pos: inline.pos };
      ui.block.classList.remove("is-visible");
      ui.caret.classList.add("is-visible");
      ui.caret.style.left = `${inline.left}px`;
      ui.caret.style.top = `${inline.top}px`;
      ui.caret.style.height = `${inline.height}px`;
      return;
    }

    const boundary = blockBoundaryFor(view, event.clientY);
    if (!boundary) {
      target = null;
      ui.block.classList.remove("is-visible");
      ui.caret.classList.remove("is-visible");
      return;
    }
    target = { kind: "block", pos: boundary.pos };
    ui.caret.classList.remove("is-visible");
    ui.block.classList.add("is-visible");
    ui.block.style.top = `${boundary.top}px`;
    ui.block.style.left = `${boundary.left}px`;
    ui.block.style.width = `${boundary.width}px`;
    ui.block.setCssProps({
      "--butter-spawn-gutter-width": `${boundary.gutterWidth}px`,
    });
  };

  const onMove = (event: PointerEvent) => {
    if (!armed || event.pointerId !== armed.pointerId) return;
    if (!ownsGesture(armed)) { clear(); return; }
    if (pendingClick && !ownsClickIntent()) pendingClick = null;
    if (!ui) {
      const dx = event.clientX - armed.x;
      const dy = event.clientY - armed.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      promote(event);
    }
    event.preventDefault();
    updateUi(event);
  };

  const onUp = (event: PointerEvent) => {
    if (!armed || event.pointerId !== armed.pointerId) return;
    const source = armed;
    const wasDragging = ui !== null;
    const placement = target;
    const sourceSize = renderedSize;
    const priorSelection = selectionBookmark;
    const sourcePos = currentPos();
    const clickSelection = !wasDragging && pendingClick?.consumed && ownsClickIntent() &&
      isPlainPrimaryPress(event) && event.isPrimary !== false && event.pointerType === source.pointerType &&
      Math.hypot(event.clientX - source.x, event.clientY - source.y) < DRAG_THRESHOLD_PX &&
      image.ownerDocument.elementFromPoint(event.clientX, event.clientY) === image
      ? pendingClick.selection : null;
    const owned = ownsGesture(source);
    clear();
    if (!wasDragging) {
      if (clickSelection) deselectSelectedLeaf(view, clickSelection);
      return;
    }
    if (!placement || sourcePos !== source.pos || !owned) return;
    event.preventDefault();
    if (placement.kind === "inline") {
      moveImageInline(view, sourcePos, placement.pos, sourceSize, priorSelection);
    } else {
      moveImageStandalone(view, sourcePos, placement.pos, priorSelection);
    }
  };

  const onCancel = (event: PointerEvent) => { if (armed?.pointerId === event.pointerId) clear(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !armed) return;
    if (ownsGesture(armed)) {
      event.preventDefault();
      // This Escape cancels the gesture. A later editor handler must not also
      // deselect the image; retain the live selection rather than restoring
      // the bookmark captured before the drag.
      event.stopPropagation();
    }
    clear();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!canPlaceImage(view) || event.button !== 0 || event.pointerType === "touch") return;
    const pos = currentPos();
    const node = pos == null ? null : sourceRange(view.state, pos)?.node;
    if (pos == null || !node) return;
    clear();
    const rect = image.getBoundingClientRect();
    renderedSize = { width: rect.width, height: rect.height };
    selectionBookmark = view.state.selection.getBookmark();
    armed = {
      x: event.clientX, y: event.clientY, pointerId: event.pointerId, pointerType: event.pointerType,
      doc: view.state.doc, pos, node, editorDOM: view.dom, generation: sourceGeneration(view.state),
    };
    const selection = view.state.selection;
    if (
      event.target === image && isPlainPrimaryPress(event) && event.isPrimary !== false &&
      (event.pointerType === "mouse" || event.pointerType === "pen") &&
      selection instanceof NodeSelection && selection.from === pos && selection.node === node && ownsGesture(armed)
    ) pendingClick = { selection, storedMarks: view.state.storedMarks, consumed: false };
    activeWindow.addEventListener("pointermove", onMove, { passive: false });
    activeWindow.addEventListener("pointerup", onUp);
    activeWindow.addEventListener("pointercancel", onCancel);
    activeWindow.addEventListener("keydown", onKeyDown, true);
  };
  const onNativeDragStart = (event: DragEvent) => event.preventDefault();

  image.addEventListener("pointerdown", onPointerDown);
  image.addEventListener("mousedown", onMouseDown);
  image.addEventListener("dragstart", onNativeDragStart);
  return () => {
    clear();
    image.removeEventListener("pointerdown", onPointerDown);
    image.removeEventListener("mousedown", onMouseDown);
    image.removeEventListener("dragstart", onNativeDragStart);
  };
}

function blockInfo(state: EditorState, pos: number) {
  const node = state.doc.nodeAt(pos);
  if (!isImageNode(node)) return null;
  if (node.type.name === "obsidian_embed") {
    const $pos = state.doc.resolve(pos);
    return { node, blockPos: pos, blockNode: node, parent: $pos.parent, index: $pos.index() };
  }
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.inlineContent) return null;
  const blockPos = $pos.before();
  const blockNode = $pos.parent;
  if (blockNode.childCount !== 1 || blockNode.firstChild !== node) return null;
  const $block = state.doc.resolve(blockPos);
  return { node, blockPos, blockNode, parent: $block.parent, index: $block.index() };
}

function mergeWithAdjacent(
  view: EditorView,
  pos: number,
  direction: "previous" | "next",
  renderedSize?: ImageRenderedSize,
): boolean {
  if (!canPlaceImage(view)) return false;
  const info = blockInfo(view.state, pos);
  if (!info) return false;
  if (!canMoveCompleteImageOwner(view, pos, info.node)) return false;
  const adjacentIndex = direction === "previous" ? info.index - 1 : info.index + 1;
  if (adjacentIndex < 0 || adjacentIndex >= info.parent.childCount) return false;
  const adjacent = info.parent.child(adjacentIndex);
  if (adjacent.type.name !== "paragraph") return false;
  const inline = imageAsInline(info.node, view.state.schema, renderedSize);
  if (!inline) return false;

  let adjacentPos = info.blockPos;
  if (direction === "previous") adjacentPos -= adjacent.nodeSize;
  else adjacentPos += info.blockNode.nodeSize;
  const space = adjacent.content.size > 0 ? view.state.schema.text(" ") : null;
  const content = direction === "previous"
    ? Fragment.fromArray([...(adjacent.content.content), ...(space ? [space] : []), inline])
    : Fragment.fromArray([inline, ...(space ? [space] : []), ...(adjacent.content.content)]);
  const paragraph = view.state.schema.nodes.paragraph.create(adjacent.attrs, content);
  const from = Math.min(info.blockPos, adjacentPos);
  const to = Math.max(info.blockPos + info.blockNode.nodeSize, adjacentPos + adjacent.nodeSize);
  return dispatchImageMove(view, view.state.tr.replaceWith(from, to, paragraph).scrollIntoView());
}

export function makeImageStandalone(view: EditorView, pos: number): boolean {
  if (!canPlaceImage(view) || !sourceRange(view.state, pos)) return false;
  const state = view.state;
  const node = state.doc.nodeAt(pos);
  if (!isImageNode(node) || node.type.name === "obsidian_embed") return false;
  if (!canMoveCompleteImageOwner(view, pos, node)) return false;
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.inlineContent || ($pos.parent.childCount === 1 && $pos.parent.firstChild === node)) return false;
  const parent = $pos.parent;
  const parentPos = $pos.before();
  const before = parent.content.cut(0, $pos.parentOffset);
  const after = parent.content.cut($pos.parentOffset + node.nodeSize);
  const replacements: PMNode[] = [];
  if (before.size) replacements.push(parent.type.create(parent.attrs, before));
  const standalone = imageAsStandalone(node, state.schema, $pos.node($pos.depth - 1));
  if (!standalone) return false;
  replacements.push(standalone);
  if (after.size) replacements.push(parent.type.create(parent.attrs, after));
  return dispatchImageMove(view, state.tr.replaceWith(parentPos, parentPos + parent.nodeSize, replacements).scrollIntoView());
}

export function imageLayoutActions(
  view: EditorView,
  pos: number,
  renderedSize?: ImageRenderedSize,
): ImageLayoutAction[] {
  if (!canPlaceImage(view) || !sourceRange(view.state, pos)) return [];
  const doc = view.state.doc;
  const node = view.state.doc.nodeAt(pos);
  if (!isImageNode(node)) return [];
  const info = blockInfo(view.state, pos);
  if (!info) {
    return [{ id: "standalone", label: "Move to standalone block", icon: "between-horizontal-start", run: () => ownsImagePlacement(view, doc, pos, node) && makeImageStandalone(view, pos) }];
  }
  const actions: ImageLayoutAction[] = [];
  if (info.index > 0 && info.parent.child(info.index - 1).type.name === "paragraph") {
    actions.push({ id: "inline-previous", label: "Place inline with previous paragraph", icon: "text-cursor-input", run: () => ownsImagePlacement(view, doc, pos, node) && mergeWithAdjacent(view, pos, "previous", renderedSize) });
  }
  if (info.index + 1 < info.parent.childCount && info.parent.child(info.index + 1).type.name === "paragraph") {
    actions.push({ id: "inline-next", label: "Place inline with next paragraph", icon: "text-cursor-input", run: () => ownsImagePlacement(view, doc, pos, node) && mergeWithAdjacent(view, pos, "next", renderedSize) });
  }
  return actions;
}
