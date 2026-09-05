import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { tv } from "../../i18n";
import { buildHandleDotsSvg } from "../drag-handles/constants";
import {
  copyRect,
  mediaGhostContentOffset,
  rectFromDom,
  sceneRect,
  unionVisibleSceneRects,
} from "./geometry";
import {
  DampedScalarMotion,
  DragSceneMotionSystem,
  type SceneMotionConfig,
  type SceneMotionRetargetOptions,
} from "./motion";
import type { CollectedDragScene } from "./scene";
import type {
  DragSceneBlock,
  SceneBlockKey,
  SceneLayout,
  SceneMotionSample,
  SceneRect,
} from "./types";

const FILLER_KEY = "chrome:filler";
const MEDIA_SIZE_KEY = "chrome:media-size";
const COMMITTED_CONTAINER_HEIGHT_EPSILON = 0.01;
const COMMITTED_BLOCK_HEIGHT_EPSILON = 0.01;
const LIVE_PRESENTATION_CLASSES = [
  "butter-drag-scene-live-block",
  "butter-drag-scene-live-moving",
  "butter-drag-scene-live-dragged",
  "butter-drag-scene-live-container",
  "butter-drag-scene-live-height-lock",
  "butter-drag-scene-live-lane",
  "butter-drag-scene-live-source-vacancy",
  "butter-drag-scene-live-compact-reveal",
  "butter-drag-scene-live-compact-reveal-active",
] as const;

export function committedAtomicBlockNeedsHeightLock(
  atomic: boolean,
  expectedHeight: number,
  observedHeight: number,
  tolerancePx = COMMITTED_BLOCK_HEIGHT_EPSILON,
): boolean {
  return atomic && expectedHeight > 0 && observedHeight > 0 &&
    Math.abs(expectedHeight - observedHeight) > tolerancePx;
}

export function committedContainerNeedsHeightLock(
  atomic: boolean,
  expectedHeight: number,
  observedHeight: number,
  tolerancePx = COMMITTED_CONTAINER_HEIGHT_EPSILON,
): boolean {
  return !atomic && expectedHeight > 0 && observedHeight > 0 &&
    Math.abs(expectedHeight - observedHeight) > tolerancePx;
}

interface LiveBinding {
  dom: HTMLElement;
}

interface OriginalAttributes {
  style: string | null;
  className: string | null;
  depth: string | null;
}

interface GlobalDelta {
  left: number;
  top: number;
}

export interface DragScenePresentationFrame {
  samples: ReadonlyMap<string, SceneMotionSample>;
  settled: boolean;
}

export interface DragSceneOverlayRects {
  ghost: SceneRect;
  filler: SceneRect;
}

export type CommittedGhostContentOffsets = ReadonlyMap<SceneBlockKey, SceneRect>;

function clearInteractiveState(root: HTMLElement): void {
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  for (const element of elements) {
    element.removeAttribute("id");
    element.removeAttribute("contenteditable");
    element.removeAttribute("autofocus");
    element.removeAttribute("draggable");
    element.setAttribute("tabindex", "-1");
  }
  root.setAttribute("aria-hidden", "true");
  root.inert = true;
}

function createGhostHandle(ownerDocument: Document): HTMLElement {
  const handle = ownerDocument.win.createDiv();
  handle.className = "butter-drag-handle is-visible butter-drag-scene-ghost-handle";
  handle.setAttribute("aria-hidden", "true");
  handle.inert = true;
  handle.appendChild(buildHandleDotsSvg(ownerDocument));
  return handle;
}

function measuredVisibleText(
  root: HTMLElement,
  cutoffBottom: number,
): { visible: number; total: number } | null {
  const ownerDocument = root.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
  const walker = ownerDocument.createTreeWalker(root, showText);
  let visible = 0;
  let total = 0;
  let measured = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (!text) continue;
    const range = ownerDocument.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects?.() ?? [])
      .filter(rect => rect.width > 0 || rect.height > 0);
    if (rects.length === 0) continue;
    measured = true;
    total += text.length;
    const firstTop = Math.min(...rects.map(rect => rect.top));
    const lastBottom = Math.max(...rects.map(rect => rect.bottom));
    if (lastBottom <= cutoffBottom + 0.5) {
      visible += text.length;
      continue;
    }
    if (firstTop >= cutoffBottom - 0.5) continue;

    let lower = 0;
    let upper = text.length;
    while (lower < upper) {
      const midpoint = Math.ceil((lower + upper) / 2);
      range.setStart(node, 0);
      range.setEnd(node, midpoint);
      const prefixRects = Array.from(range.getClientRects?.() ?? [])
        .filter(rect => rect.width > 0 || rect.height > 0);
      const prefixBottom = prefixRects.length > 0
        ? Math.max(...prefixRects.map(rect => rect.bottom))
        : Number.POSITIVE_INFINITY;
      if (prefixBottom <= cutoffBottom + 0.5) lower = midpoint;
      else upper = midpoint - 1;
    }
    visible += lower;
  }
  return measured ? { visible, total } : null;
}

export function fitSingleCompactPreview(preview: HTMLElement): void {
  const content = preview.querySelector<HTMLElement>(
    ".butter-drag-scene-aggregate-content",
  );
  const renderedBlock = preview.querySelector<HTMLElement>(
    ".butter-drag-scene-aggregate-rendered-block",
  );
  const more = preview.querySelector<HTMLElement>(
    ".butter-drag-scene-aggregate-more",
  );
  const moreLabel = more?.querySelector<HTMLElement>(
    ".butter-drag-scene-aggregate-more-label",
  ) ?? more;
  if (!content || !renderedBlock || !more ||
      !Number.isFinite(content.clientHeight) || content.clientHeight <= 0) return;

  const blockCount = Number.parseInt(preview.dataset.blockCount ?? "1", 10) || 1;
  const multipleBlocks = blockCount > 1;
  const text = renderedBlock.textContent ?? "";
  const naturalHeight = Number.parseFloat(renderedBlock.dataset.naturalHeight ?? "") ||
    renderedBlock.scrollHeight || renderedBlock.getBoundingClientRect().height;
  more.hidden = !multipleBlocks;
  if (moreLabel) moreLabel.textContent = multipleBlocks ? tv("blocks", {}) : "";
  delete more.dataset.remainingCharacters;
  preview.classList.remove("has-overflow");
  if (naturalHeight <= content.clientHeight + 0.5 || text.length === 0) return;

  more.hidden = false;
  preview.classList.add("has-overflow");
  const measuredText = measuredVisibleText(
    renderedBlock,
    content.getBoundingClientRect().bottom,
  );
  const visibleRatio = Math.min(1, Math.max(0, content.clientHeight / naturalHeight));
  const totalCharacters = measuredText?.total ?? text.length;
  const visibleCharacters = measuredText?.visible ?? Math.min(
    totalCharacters,
    Math.max(0, Math.floor(totalCharacters * visibleRatio)),
  );
  const remainingCharacters = Math.max(0, totalCharacters - visibleCharacters);
  more.dataset.remainingCharacters = String(remainingCharacters);
  const remainingLabel = tv("+{count} more characters", {
    count: remainingCharacters.toLocaleString(),
  });
  if (moreLabel) {
    moreLabel.textContent = multipleBlocks
      ? `${tv("blocks", {})} · ${remainingLabel}`
      : remainingLabel;
  }
}

function createAggregateRenderedRun(
  ownerDocument: Document,
  scene: CollectedDragScene,
): HTMLElement | null {
  const members: { key: SceneBlockKey; source: HTMLElement; block: DragSceneBlock }[] = [];
  for (const key of scene.snapshot.draggedBlockKeys) {
    const source = scene.blockDoms.get(key);
    const block = scene.snapshot.blocks.get(key);
    if (source && block) members.push({ key, source, block });
  }
  const union = unionVisibleSceneRects(members.map(({ block }) => block.rect));
  if (!union) return null;
  const run = ownerDocument.win.createDiv();
  run.className =
    "butter-drag-scene-aggregate-rendered-block butter-drag-scene-aggregate-rendered-run";
  run.dataset.naturalHeight = String(union.height);
  run.setCssProps({
    "--butter-drag-scene-piece-height": `${union.height}px`,
  });
  for (const { key, source, block } of members) {
    const left = block.rect.left - union.left;
    const right = union.left + union.width - block.rect.left - block.rect.width;
    const member = createGhostPiece(
      ownerDocument,
      source,
      key,
      block.visualSelector ? block.rect : undefined,
    );
    member.classList.remove("butter-drag-scene-ghost-piece");
    member.classList.add("butter-drag-scene-aggregate-rendered-member");
    member.setCssProps({
      "--butter-drag-scene-piece-left": `${left}px`,
      "--butter-drag-scene-piece-top": `${block.rect.top - union.top}px`,
      "--butter-drag-scene-piece-width":
        `calc(100% - ${left}px - ${Math.max(0, right)}px)`,
      "--butter-drag-scene-piece-height": `${block.rect.height}px`,
    });
    run.appendChild(member);
  }
  return run;
}

function createAggregatePreview(
  ownerDocument: Document,
  scene: CollectedDragScene,
): HTMLElement {
  const preview = ownerDocument.win.createDiv();
  preview.className = "butter-drag-scene-aggregate-preview";
  const blockCount = scene.snapshot.draggedBlockKeys.length;
  const singleBlock = blockCount === 1;
  preview.classList.toggle("is-single", singleBlock);
  preview.classList.add("is-content-preview");
  preview.dataset.blockCount = String(blockCount);
  const farCard = ownerDocument.win.createDiv();
  farCard.className =
    "butter-drag-scene-aggregate-card butter-drag-scene-aggregate-card-far";
  const nearCard = ownerDocument.win.createDiv();
  nearCard.className =
    "butter-drag-scene-aggregate-card butter-drag-scene-aggregate-card-near";
  const frontCard = ownerDocument.win.createDiv();
  frontCard.className =
    "butter-drag-scene-aggregate-card butter-drag-scene-aggregate-card-front";
  const content = ownerDocument.win.createDiv();
  content.className = "butter-drag-scene-aggregate-content";
  const renderedRun = createAggregateRenderedRun(ownerDocument, scene);
  if (renderedRun) {
    content.appendChild(renderedRun);
  } else {
    const placeholder = ownerDocument.win.createDiv();
    placeholder.className = "butter-drag-scene-aggregate-placeholder";
    content.appendChild(placeholder);
  }
  const more = ownerDocument.win.createDiv();
  more.className = "butter-drag-scene-aggregate-more";
  more.hidden = singleBlock;
  if (!singleBlock) {
    const count = ownerDocument.win.createDiv();
    count.className = "butter-drag-scene-aggregate-count";
    count.textContent = String(blockCount);
    const label = ownerDocument.win.createDiv();
    label.className = "butter-drag-scene-aggregate-more-label";
    label.textContent = tv("blocks", {});
    more.append(count, label);
  }
  frontCard.append(content, more);
  if (blockCount >= 3) preview.appendChild(farCard);
  if (blockCount >= 2) preview.appendChild(nearCard);
  preview.appendChild(frontCard);
  preview.setAttribute("aria-hidden", "true");
  preview.inert = true;
  return preview;
}

function clearLivePresentationState(root: HTMLElement): void {
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  for (const element of elements) {
    element.classList.remove(...LIVE_PRESENTATION_CLASSES);
    element.style.removeProperty("--butter-drag-scene-live-x");
    element.style.removeProperty("--butter-drag-scene-live-y");
    element.style.removeProperty("--butter-drag-scene-live-height");
    element.style.removeProperty("--butter-drag-scene-live-reveal-right");
    element.style.removeProperty("--butter-drag-scene-live-reveal-bottom");
    element.style.removeProperty("--butter-drag-scene-live-reveal-duration");
    element.style.removeProperty("--butter-drag-scene-live-reveal-easing");
  }
}

function copyCustomProperties(source: HTMLElement, target: HTMLElement): void {
  for (const property of Array.from(source.style)) {
    if (!property.startsWith("--")) continue;
    target.style.setProperty(
      property,
      source.style.getPropertyValue(property),
      source.style.getPropertyPriority(property),
    );
  }
}

function copyContextClasses(source: HTMLElement | null, target: HTMLElement): void {
  if (!source) return;
  for (const className of Array.from(source.classList)) target.classList.add(className);
  copyCustomProperties(source, target);
}

function wrapInSourceContext(
  source: HTMLElement,
  editorRoot: HTMLElement | null,
  clone: HTMLElement,
): HTMLElement {
  if (!editorRoot || source.parentElement === editorRoot) return clone;
  const ancestors: HTMLElement[] = [];
  let current = source.parentElement;
  while (current && current !== editorRoot) {
    ancestors.push(current);
    current = current.parentElement;
  }
  if (current !== editorRoot) return clone;

  let outer: HTMLElement | null = null;
  let parent: HTMLElement | null = null;
  for (const ancestor of ancestors.reverse()) {
    const wrapper = ancestor.cloneNode(false) as HTMLElement;
    clearLivePresentationState(wrapper);
    clearInteractiveState(wrapper);
    wrapper.classList.add("butter-drag-scene-proxy-context");
    if (parent) parent.appendChild(wrapper);
    else outer = wrapper;
    parent = wrapper;
  }
  parent?.appendChild(clone);
  return outer ?? clone;
}

function freezeMediaGeometry(clone: HTMLElement, visualRect?: SceneRect): void {
  if (!visualRect || visualRect.width <= 0 || visualRect.height <= 0) return;
  const media = clone.querySelector<HTMLElement>("img, video");
  media?.setCssProps({
    width: `${visualRect.width}px`,
    height: `${visualRect.height}px`,
  });
  const imageFrame = media?.closest<HTMLElement>(".butter-embed-image-resizable");
  if (imageFrame && clone.contains(imageFrame)) {
    imageFrame.classList.add("butter-drag-scene-frozen-media-frame");
    imageFrame.setCssProps({
      width: `${visualRect.width}px`,
      height: `${visualRect.height}px`,
    });
    imageFrame.querySelector<HTMLElement>(".image-embed")
      ?.classList.add("butter-drag-scene-frozen-media-host");
  }
}

function textContentShadowRect(source: HTMLElement): SceneRect | null {
  const selectionRange = source.ownerDocument.createRange?.();
  if (!selectionRange || !source.textContent?.trim()) return null;
  selectionRange.selectNodeContents(source);
  const rects = Array.from(selectionRange.getClientRects?.() ?? [])
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    .map(rectFromDom);
  return unionVisibleSceneRects(rects);
}

/** The only content clone in the live presentation: the block attached to the pointer. */
function createGhostPiece(
  ownerDocument: Document,
  source: HTMLElement,
  key: SceneBlockKey,
  visualRect?: SceneRect,
  contentShadow = false,
): HTMLElement {
  const frame = ownerDocument.win.createDiv({
    cls: "butter-drag-scene-proxy butter-drag-scene-ghost-piece",
  });
  frame.dataset.sceneKey = key;
  if (visualRect) frame.classList.add("has-media-preview");
  if (source.matches(".butter-callout-view, blockquote")) {
    frame.appendChild(ownerDocument.win.createDiv({
      cls: "butter-drag-scene-container-backing",
    }));
  }
  const sourceRoot = source.closest<HTMLElement>(".ProseMirror");
  const sourceView = sourceRoot?.closest<HTMLElement>(".butter-editor-view") ?? null;
  const view = ownerDocument.win.createDiv({
    cls: "butter-editor-view butter-drag-scene-proxy-view",
  });
  if (visualRect) {
    // Media pieces are registered to the renderer's visual rectangle rather
    // than the structural embed box. Counter the structural inset once here;
    // otherwise the cloned renderer reapplies (for example) its 16px block
    // padding inside an already image-aligned piece and visibly snaps when the
    // overlay hands off to the real committed image.
    const structuralRect = rectFromDom(source.getBoundingClientRect());
    const offset = mediaGhostContentOffset(structuralRect, visualRect);
    view.setCssProps({
      "--butter-drag-scene-media-content-x":
        `${offset.x}px`,
      "--butter-drag-scene-media-content-y":
        `${offset.y}px`,
    });
    view.classList.add("butter-drag-scene-media-aligned-view");
  }
  copyContextClasses(sourceView, view);
  view.classList.remove("butter-anim-prepped", "butter-just-loaded");
  view.classList.add("butter-drag-scene-proxy-view");
  const proseMirror = ownerDocument.win.createDiv({
    cls: "ProseMirror butter-drag-scene-proxy-root",
  });
  copyContextClasses(sourceRoot, proseMirror);
  proseMirror.classList.remove("ProseMirror-focused", "ProseMirror-hideselection");
  proseMirror.classList.add("butter-drag-scene-proxy-root");
  const clone = source.cloneNode(true) as HTMLElement;
  const sourceStyle = ownerDocument.win.getComputedStyle?.(source);
  if (contentShadow) {
    const textRect = textContentShadowRect(source);
    const sourceRect = rectFromDom(source.getBoundingClientRect());
    if (textRect) {
      const shadow = ownerDocument.win.createDiv({
        cls: "butter-drag-scene-content-shadow",
      });
      shadow.setCssProps({
        "--butter-drag-scene-content-shadow-left":
          `${Math.max(0, textRect.left - sourceRect.left)}px`,
        "--butter-drag-scene-content-shadow-top":
          `${Math.max(0, textRect.top - sourceRect.top)}px`,
        "--butter-drag-scene-content-shadow-width": `${textRect.width}px`,
        "--butter-drag-scene-content-shadow-height": `${textRect.height}px`,
      });
      frame.classList.add("has-content-shadow");
      frame.appendChild(shadow);
    }
  }
  // The real source has already been bound to the live presentation and is
  // hidden in-place. A ghost clone must never inherit that presentation state.
  clearLivePresentationState(clone);
  clearInteractiveState(clone);
  clone.classList.add("butter-drag-scene-proxy-content");
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const padding = sourceStyle?.getPropertyValue(`padding-${edge}`);
    if (padding) clone.style.setProperty(`padding-${edge}`, padding);
  }
  if (sourceStyle?.paddingTop) clone.style.setProperty("--li-pad-top", sourceStyle.paddingTop);
  freezeMediaGeometry(clone, visualRect);
  proseMirror.appendChild(wrapInSourceContext(source, sourceRoot, clone));
  view.appendChild(proseMirror);
  frame.appendChild(view);
  return frame;
}

function listPadding(piece: HTMLElement): { left: number; top: number } | null {
  const row = piece.querySelector<HTMLElement>(
    ".butter-list-item.butter-drag-scene-proxy-content",
  );
  if (!row) return null;
  const style = row.ownerDocument.defaultView?.getComputedStyle(row);
  const left = Number.parseFloat(style?.paddingLeft ?? "");
  const top = Number.parseFloat(style?.paddingTop ?? "");
  return {
    left: Number.isFinite(left) ? left : 0,
    top: Number.isFinite(top) ? top : 0,
  };
}

function createGhost(
  ownerDocument: Document,
  scene: CollectedDragScene,
  baseline: SceneLayout,
  contentShadow = false,
): { frame: HTMLElement; rect: SceneRect } {
  const draggedRects = scene.snapshot.draggedBlockKeys.map((key) => {
    const rect = baseline.visualRects.get(key) ?? baseline.blockRects.get(key);
    if (!rect) throw new Error(`Missing baseline dragged rectangle ${key}`);
    return rect;
  });
  const union = unionVisibleSceneRects(draggedRects);
  if (!union) throw new Error("Drag scene ghost has no measurable rectangle");
  const frame = ownerDocument.win.createDiv({ cls: "butter-drag-scene-ghost" });
  frame.setAttribute("aria-hidden", "true");
  frame.inert = true;
  for (let index = 0; index < scene.snapshot.draggedBlockKeys.length; index++) {
    const key = scene.snapshot.draggedBlockKeys[index];
    const source = scene.blockDoms.get(key);
    if (!source) throw new Error(`Missing ghost source ${key}`);
    if (source.matches(".butter-callout-view, blockquote")) {
      frame.classList.add("has-container-backing");
    }
    const rect = draggedRects[index];
    if (source.classList.contains("butter-heading-folded-content")) continue;
    const block = scene.snapshot.blocks.get(key);
    const piece = createGhostPiece(
      ownerDocument,
      source,
      key,
      block?.visualSelector ? rect : undefined,
      contentShadow,
    );
    piece.setCssProps({
      "--butter-drag-scene-piece-left": `${rect.left - union.left}px`,
      "--butter-drag-scene-piece-top": `${rect.top - union.top}px`,
      "--butter-drag-scene-piece-width": `${rect.width}px`,
      "--butter-drag-scene-piece-height": `${rect.height}px`,
    });
    frame.appendChild(piece);
  }
  frame.classList.toggle(
    "has-content-shadow",
    frame.querySelector(".butter-drag-scene-ghost-piece.has-content-shadow") != null,
  );
  frame.classList.toggle(
    "has-media-preview",
    frame.querySelector(".butter-drag-scene-ghost-piece.has-media-preview") != null,
  );
  return { frame, rect: union };
}

function applyRect(element: HTMLElement, rect: SceneRect, previous?: SceneRect): SceneRect {
  const next = {
    left: rect.left,
    top: rect.top,
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  };
  if (!previous || previous.left !== next.left) {
    element.style.setProperty("--butter-drag-scene-left", `${next.left}px`);
  }
  if (!previous || previous.top !== next.top) {
    element.style.setProperty("--butter-drag-scene-top", `${next.top}px`);
  }
  if (!previous || previous.width !== next.width) {
    element.style.setProperty("--butter-drag-scene-width", `${next.width}px`);
  }
  if (!previous || previous.height !== next.height) {
    element.style.setProperty("--butter-drag-scene-height", `${next.height}px`);
  }
  return next;
}

function stableBlockKey(node: PMNode, pos: number): SceneBlockKey {
  const id: unknown = node.attrs?.blockId;
  return typeof id === "string" && id.length > 0
    ? `block:${id}`
    : `pos:${pos}:${node.type.name}`;
}

/**
 * Live ProseMirror presentation. Non-dragged content is never cloned. The
 * hidden dragged DOM remains collapsed at its source until the one committed
 * transaction; moving a composited subtree between callout/quote transform
 * trees during the gesture causes browser paint glitches even when layout
 * geometry is exact. The oracle owns target layout while real blocks receive
 * presentation-only transforms and container heights.
 */
export class DragScenePresentation {
  readonly overlay: HTMLElement;
  readonly filler: HTMLElement;
  readonly ghost: HTMLElement;
  readonly ghostHandle: HTMLElement | null;
  readonly aggregatePreview: HTMLElement | null;

  private readonly motion: DragSceneMotionSystem<string>;
  private readonly ghostWidthMotion: DampedScalarMotion;
  private readonly ghostHeightMotion: DampedScalarMotion;
  private readonly mediaSizeMotion: DragSceneMotionSystem<string> | null;
  private readonly paintedRects = new Map<string, SceneRect>();
  private readonly allManagedDoms = new Set<HTMLElement>();
  private readonly originalAttributes = new WeakMap<HTMLElement, OriginalAttributes>();
  private readonly naturalViewportRects = new Map<SceneBlockKey, SceneRect>();
  private readonly bindingParentKeys = new Map<SceneBlockKey, SceneBlockKey | null>();
  private readonly bindingChildren = new Map<SceneBlockKey | null, SceneBlockKey[]>();
  private readonly appliedContainerHeights = new Map<SceneBlockKey, number>();
  private readonly appliedLocalDeltas = new Map<SceneBlockKey, GlobalDelta>();
  private readonly promotedKeys = new Set<SceneBlockKey>();
  private readonly baselineContainerHeights = new Map<SceneBlockKey, number>();
  private committedHeightKeys: ReadonlySet<SceneBlockKey> | null = null;
  private committedBlockHeightLocks = new Map<SceneBlockKey, number>();
  private committedGhostListRows = new Map<SceneBlockKey, HTMLElement>();
  private committedGhostListPaddingTargets = new Map<
    SceneBlockKey,
    { left: number; top: number }
  >();
  private bindings = new Map<SceneBlockKey, LiveBinding>();
  private latestSamples = new Map<string, SceneMotionSample>();
  private ghostRect: SceneRect;
  private readonly ghostHandleRegistration: SceneRect | null;
  private scrollOffsetY = 0;
  private naturalScrollOffsetY = 0;
  private compacted: boolean;
  private compactHandoffStarted = false;
  private compactHandoffActivated = false;
  private compactHandoffRect: Pick<SceneRect, "width" | "height"> | null = null;
  private compactLiveRevealStarted = false;
  private compactLiveRevealActivated = false;
  private compactLiveRevealDurationMs = 240;
  private compactLiveRevealEasing = "cubic-bezier(0.2, 1, 0.4, 1)";
  private readonly compactLiveRevealInsets = new Map<
    SceneBlockKey,
    { right: number; bottom: number }
  >();
  private readonly compactLiveRevealAnimations: Animation[] = [];
  private readonly textContentShadow: boolean;
  private readonly mediaCompacted: boolean;
  private mediaGhostNaturalSize: Pick<SceneRect, "width" | "height"> | null = null;
  private finalRevealStarted = false;
  private settlementFillerRect: SceneRect | null = null;
  private committed = false;
  private destroyed = false;

  constructor(
    private readonly scene: CollectedDragScene,
    baseline: SceneLayout,
    _viewportRect: SceneRect,
    startTimeMs: number,
    motionConfig: SceneMotionConfig,
    compacted = false,
    handleRect: SceneRect | null = null,
    mediaCompacted = false,
    naturalBaseline: SceneLayout | null = null,
    mediaSizeMotionConfig: SceneMotionRetargetOptions = {},
  ) {
    const ownerDocument = scene.laneDoms.get(scene.snapshot.rootLaneKey)?.ownerDocument;
    if (!ownerDocument) throw new Error("Drag scene presentation needs an owner document");
    for (const [key, rect] of baseline.containerRects) {
      this.baselineContainerHeights.set(key, rect.height);
    }
    this.compacted = compacted;
    this.mediaCompacted = mediaCompacted;
    const firstDragged = scene.snapshot.blocks.get(scene.snapshot.draggedBlockKeys[0]);
    this.textContentShadow = !compacted &&
      scene.snapshot.draggedBlockKeys.length === 1 &&
      (firstDragged?.nodeType === "paragraph" || firstDragged?.nodeType === "heading");
    this.bindings = this.bindSceneDoms(scene.blockDoms);
    this.bindLaneDoms();

    this.overlay = ownerDocument.win.createDiv({ cls: "butter-drag-scene-overlay" });
    this.overlay.setAttribute("aria-hidden", "true");
    this.overlay.inert = true;
    this.overlay.setCssProps({ "--butter-drag-scene-scroll-y": "0px" });

    this.filler = ownerDocument.win.createDiv({ cls: "butter-drag-scene-filler" });
    this.paintRect(FILLER_KEY, this.filler, baseline.fillerRect);
    this.overlay.appendChild(this.filler);
    // Capture the pointer ghost while the source still has its natural box
    // model. Source-vacancy staging intentionally zeros padding and borders;
    // reading computed styles after that point flattened callouts, quotes, and
    // list rows inside the otherwise faithful clone.
    const ghostBaseline = mediaCompacted && naturalBaseline
      ? naturalBaseline
      : baseline;
    const ghost = createGhost(
      ownerDocument,
      scene,
      ghostBaseline,
      this.textContentShadow,
    );
    this.markSourceVacancy();
    this.ghost = ghost.frame;
    this.ghost.classList.toggle("is-compact", compacted);
    this.ghost.classList.toggle("is-media-compact", mediaCompacted);
    this.ghost.classList.toggle("has-aggregate-preview", compacted && !mediaCompacted);
    this.aggregatePreview = compacted && !mediaCompacted
      ? createAggregatePreview(ownerDocument, scene)
      : null;
    if (this.aggregatePreview) this.ghost.appendChild(this.aggregatePreview);
    this.ghostRect = copyRect(ghost.rect);
    if (mediaCompacted) {
      this.mediaGhostNaturalSize = {
        width: ghost.rect.width,
        height: ghost.rect.height,
      };
      this.paintMediaGhostScale();
    }
    this.paintRect("chrome:ghost", this.ghost, this.ghostRect);
    this.overlay.appendChild(this.ghost);
    this.ghostHandleRegistration = handleRect && firstDragged
      ? sceneRect(
          handleRect.left - firstDragged.rect.left,
          handleRect.top - firstDragged.rect.top,
          handleRect.width,
          handleRect.height,
        )
      : null;
    this.ghostHandle = this.ghostHandleRegistration
      ? createGhostHandle(ownerDocument)
      : null;
    if (this.ghostHandle) {
      this.paintGhostHandle();
      this.overlay.appendChild(this.ghostHandle);
    }
    ownerDocument.body.appendChild(this.overlay);
    if (this.aggregatePreview) {
      fitSingleCompactPreview(this.aggregatePreview);
    }

    const initialRects = new Map<string, SceneRect>();
    for (const [key, rect] of baseline.blockRects) initialRects.set(key, rect);
    initialRects.set(FILLER_KEY, baseline.fillerRect);
    this.motion = new DragSceneMotionSystem(motionConfig);
    this.motion.seed(initialRects, startTimeMs);
    this.ghostWidthMotion = new DampedScalarMotion(
      this.ghostRect.width,
      startTimeMs,
      motionConfig,
    );
    this.ghostHeightMotion = new DampedScalarMotion(
      this.ghostRect.height,
      startTimeMs,
      motionConfig,
    );
    this.mediaSizeMotion = mediaCompacted
      ? new DragSceneMotionSystem({
          ...motionConfig,
          sceneDurationMs: mediaSizeMotionConfig.sceneDurationMs ??
            motionConfig.sceneDurationMs,
          sceneEasing: mediaSizeMotionConfig.sceneEasing ?? motionConfig.sceneEasing,
        })
      : null;
    this.mediaSizeMotion?.seed(new Map([[MEDIA_SIZE_KEY, sceneRect(
      0,
      0,
      this.ghostRect.width,
      this.ghostRect.height,
    )]]), startTimeMs);

    this.hideDraggedBindings();
    this.sample(startTimeMs);
  }

  ownsMutation(mutation: MutationRecord): boolean {
    const HTMLElementCtor = this.overlay.ownerDocument.defaultView?.HTMLElement;
    if (mutation.type === "attributes" && HTMLElementCtor &&
        mutation.target.instanceOf(HTMLElementCtor)) {
      if (!this.allManagedDoms.has(mutation.target)) return false;
      return mutation.attributeName === "style" || mutation.attributeName === "class";
    }
    return false;
  }

  retarget(
    layout: SceneLayout,
    timeMs: number,
    options: SceneMotionRetargetOptions = {},
    snapFiller = false,
  ): void {
    if (this.destroyed) return;
    // Capture the analytic position before changing live layout. Retargeting
    // preserves that position, then gives every edge one coherent monotonic
    // phase against the new renderer boxes.
    const current = this.motion.sample(timeMs);
    this.latestSamples = new Map(current);
    const rects = new Map<string, SceneRect>();
    for (const [key, rect] of layout.blockRects) rects.set(key, rect);
    rects.set(FILLER_KEY, this.settlementFillerRect ?? layout.fillerRect);
    this.updateLivePromotions(current, layout.blockRects);
    this.motion.retarget(rects, timeMs, snapFiller
      ? { ...options, snapKeys: new Set([FILLER_KEY]) }
      : options);
    this.applyLiveSamples(this.latestSamples);
  }

  handoffCommittedLayout(
    layout: SceneLayout,
    timeMs: number,
    options: SceneMotionRetargetOptions = {},
  ): void {
    if (this.destroyed) return;
    const current = this.motion.sample(timeMs);
    const rects = new Map<string, SceneRect>();
    for (const [key, rect] of layout.blockRects) rects.set(key, rect);
    rects.set(FILLER_KEY, this.settlementFillerRect ?? layout.fillerRect);
    this.updateLivePromotions(current, layout.blockRects);
    this.motion.retarget(rects, timeMs, options);
  }

  /** Keep a compact multi-selection's destination cue stable while the real
   * committed blocks expand into their natural renderer geometry. */
  holdSettlementFiller(rect: SceneRect): void {
    this.settlementFillerRect = copyRect(rect);
  }

  /** Stop painting the destination cue as soon as the pointer is released.
   * Its geometry remains available to the shared settlement/convergence clock. */
  beginFillerExit(): void {
    if (this.destroyed) return;
    // Callout and quote ghosts deliberately retain a small amount of surface
    // transparency. A fading accent filler directly beneath that surface can
    // therefore bleed through during the landing handoff. Remove the cue in
    // the same release frame for container ghosts; ordinary blocks keep the
    // softer filler fade because their surfaces are opaque.
    if (this.ghost.classList.contains("has-container-backing")) {
      this.filler.classList.add("is-container-release");
    }
    this.filler.classList.add("is-exiting");
  }

  /** Dissolve elevation during the landing motion so removing the settled
   * ghost cannot produce a one-frame shadow pop. */
  beginGhostShadowExit(): void {
    if (this.destroyed) return;
    this.ghost.classList.add("is-shadow-exiting");
  }

  /** Prepare a compact single-block preview to hand its rendered content to
   * the faithful committed ghost without a final-frame visibility swap. */
  beginCompactHandoff(
    motion: SceneMotionRetargetOptions = {},
  ): boolean {
    if (this.destroyed ||
        !this.aggregatePreview?.classList.contains("is-single")) return false;
    this.compactHandoffStarted = true;
    this.compactHandoffRect = {
      width: this.ghostRect.width,
      height: this.ghostRect.height,
    };
    this.compactLiveRevealDurationMs = motion.sceneDurationMs ?? 240;
    const easing = motion.sceneEasing ?? [0.2, 1, 0.4, 1];
    this.compactLiveRevealEasing = `cubic-bezier(${easing.join(", ")})`;
    this.ghost.setCssProps({
      "--butter-drag-scene-compact-card-width": `${this.ghostRect.width}px`,
      "--butter-drag-scene-compact-card-height": `${this.ghostRect.height}px`,
    });
    this.ghost.classList.add("is-compact-handoff");
    return true;
  }

  /** Crossfade when the compact crop and committed content use different
   * coordinates. If their content boxes already register, swap content on the
   * same frame and fade only the card chrome. */
  activateCompactHandoff(layout?: SceneLayout): void {
    if (this.destroyed || !this.compactHandoffStarted ||
        this.compactHandoffActivated) return;
    const liveReveal = layout ? this.beginCommittedLiveReveal(layout) : false;
    const renderedContent = this.aggregatePreview?.querySelector<HTMLElement>(
      ".butter-drag-scene-aggregate-rendered-block .butter-drag-scene-proxy-content",
    );
    const HTMLElementConstructor = this.ghost.ownerDocument.defaultView?.HTMLElement;
    const committedPiece = Array.from(this.ghost.children).find(
      (child): child is HTMLElement => HTMLElementConstructor != null &&
        child.instanceOf(HTMLElementConstructor) &&
        child.classList.contains("butter-drag-scene-ghost-piece"),
    );
    const committedContent = committedPiece?.querySelector<HTMLElement>(
      ".butter-drag-scene-proxy-content",
    );
    const registered = !liveReveal && renderedContent && committedContent
      ? (() => {
          const source = renderedContent.getBoundingClientRect();
          const target = committedContent.getBoundingClientRect();
          return Math.max(
            Math.abs(source.left - target.left),
            Math.abs(source.top - target.top),
            Math.abs(source.right - target.right),
            Math.abs(source.bottom - target.bottom),
          ) <= 0.5;
        })()
      : false;
    this.ghost.classList.toggle("is-registered-handoff", registered);
    this.ghost.classList.toggle("is-live-reveal", liveReveal);
    this.ghost.classList.add("is-compact-handoff-ready");
    // Establish the hidden committed layer before starting its transition.
    void this.ghost.offsetWidth;
    this.ghost.classList.add("is-compact-handoff-active");
    this.compactHandoffActivated = true;
  }

  private beginCommittedLiveReveal(layout: SceneLayout): boolean {
    if (!this.committed || !this.compactHandoffRect ||
        this.scene.snapshot.draggedBlockKeys.length !== 1) return false;
    const key = this.scene.snapshot.draggedBlockKeys[0];
    const dom = this.bindings.get(key)?.dom;
    const rect = layout.blockRects.get(key);
    if (!dom || !rect) return false;
    const insets = {
      right: Math.max(0, rect.width - this.compactHandoffRect.width),
      bottom: Math.max(0, rect.height - this.compactHandoffRect.height),
    };
    this.compactLiveRevealStarted = true;
    this.compactLiveRevealInsets.set(key, insets);
    this.applyCompactLiveRevealAttributes(key, dom);

    const ownerWindow = dom.ownerDocument.defaultView;
    const reducedMotion = ownerWindow?.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches === true;
    const duration = reducedMotion ? 0 : this.compactLiveRevealDurationMs;
    if (typeof dom.animate === "function") {
      this.compactLiveRevealAnimations.push(dom.animate([
        {
          opacity: 0,
          clipPath: `inset(0 ${insets.right}px ${insets.bottom}px 0)`,
        },
        { opacity: 1, clipPath: "inset(0 0 0 0)" },
      ], {
        duration,
        easing: this.compactLiveRevealEasing,
        fill: "both",
      }));
    }
    // The class transition is the non-WAAPI fallback and leaves the renderer
    // in its natural visible state after the animation object is released.
    void dom.offsetWidth;
    this.compactLiveRevealActivated = true;
    dom.classList.add("butter-drag-scene-live-compact-reveal-active");
    return true;
  }

  private applyCompactLiveRevealAttributes(
    key: SceneBlockKey,
    dom: HTMLElement,
  ): void {
    const insets = this.compactLiveRevealInsets.get(key);
    if (!insets) return;
    dom.classList.remove("butter-drag-scene-live-dragged");
    dom.classList.add("butter-drag-scene-live-compact-reveal");
    dom.style.setProperty(
      "--butter-drag-scene-live-reveal-right",
      `${insets.right}px`,
    );
    dom.style.setProperty(
      "--butter-drag-scene-live-reveal-bottom",
      `${insets.bottom}px`,
    );
    dom.style.setProperty(
      "--butter-drag-scene-live-reveal-duration",
      `${this.compactLiveRevealDurationMs}ms`,
    );
    dom.style.setProperty(
      "--butter-drag-scene-live-reveal-easing",
      this.compactLiveRevealEasing,
    );
    if (this.compactLiveRevealActivated) {
      dom.classList.add("butter-drag-scene-live-compact-reveal-active");
    }
  }

  /** Reveal the real committed renderer beneath a compact preview's exact
   * committed clone, then let CSS dissolve the clone. Natural-size ghosts do
   * not need this extra phase because their content is painted without an
   * opacity/filter compositor layer and matches the renderer directly. */
  beginFinalReveal(): boolean {
    if (this.destroyed || !this.compactHandoffActivated ||
        this.finalRevealStarted) return false;
    this.finalRevealStarted = true;
    this.restoreManagedStyles();
    this.ghost.classList.add("is-final-reveal");
    return true;
  }

  positionGhost(rect: SceneRect, timeMs: number, animateSize = true): void {
    if (this.destroyed) return;
    this.ghostRect.left = rect.left;
    this.ghostRect.top = rect.top;
    if (animateSize) {
      if (this.mediaSizeMotion) {
        this.mediaSizeMotion.retarget(new Map([[MEDIA_SIZE_KEY, sceneRect(
          0,
          0,
          rect.width,
          rect.height,
        )]]), timeMs);
      } else {
        if (this.ghostWidthMotion.target() !== rect.width) {
          this.ghostWidthMotion.retarget(rect.width, timeMs);
        }
        if (this.ghostHeightMotion.target() !== rect.height) {
          this.ghostHeightMotion.retarget(rect.height, timeMs);
        }
      }
    } else {
      if (this.mediaSizeMotion) {
        this.mediaSizeMotion.retarget(new Map([[MEDIA_SIZE_KEY, sceneRect(
          0,
          0,
          rect.width,
          rect.height,
        )]]), timeMs);
        this.mediaSizeMotion.snapToTargets(timeMs);
      }
      this.ghostWidthMotion.snap(rect.width, timeMs);
      this.ghostHeightMotion.snap(rect.height, timeMs);
      this.ghostRect.width = rect.width;
      this.ghostRect.height = rect.height;
      this.paintRect("chrome:ghost", this.ghost, this.ghostRect);
      this.paintMediaGhostScale();
      this.paintGhostHandle();
    }
  }

  setCompacted(compacted: boolean): void {
    if (this.compacted === compacted) return;
    this.compacted = compacted;
    this.ghost.classList.toggle("is-compact", compacted);
  }

  setScrollOffsetY(offsetY: number): void {
    if (this.destroyed) return;
    this.scrollOffsetY = offsetY;
    this.overlay.setCssProps({ "--butter-drag-scene-scroll-y": `${offsetY}px` });
  }

  /** Current analytic viewport box for a live block. Targeting uses this to
   * compare destination slots in the same moving container frame the user can
   * actually see, without reading transformed DOM geometry. */
  sampledBlockRect(key: SceneBlockKey): SceneRect | null {
    const rect = this.latestSamples.get(key)?.rect;
    return rect ? copyRect(rect) : null;
  }

  sample(timeMs: number): DragScenePresentationFrame {
    const samples = this.motion.sample(timeMs);
    this.latestSamples = new Map(samples);
    this.applyLiveSamples(samples);
    this.releaseSettledPromotions(samples);
    let settled = true;
    for (const [key, sample] of samples) {
      if (key === FILLER_KEY) this.paintRect(key, this.filler, sample.rect);
      settled = settled && sample.settled;
    }
    const mediaSize = this.mediaSizeMotion?.sample(timeMs).get(MEDIA_SIZE_KEY);
    const ghostWidth = mediaSize
      ? {
          value: mediaSize.rect.width,
          velocity: mediaSize.velocity.width,
          settled: mediaSize.settled,
        }
      : this.ghostWidthMotion.sample(timeMs);
    const ghostHeight = mediaSize
      ? {
          value: mediaSize.rect.height,
          velocity: mediaSize.velocity.height,
          settled: mediaSize.settled,
        }
      : this.ghostHeightMotion.sample(timeMs);
    this.ghostRect.width = ghostWidth.value;
    this.ghostRect.height = ghostHeight.value;
    this.paintRect("chrome:ghost", this.ghost, this.ghostRect);
    this.paintMediaGhostScale();
    this.paintGhostHandle();
    return {
      samples,
      settled: settled && ghostWidth.settled && ghostHeight.settled,
    };
  }

  /** Restore the source DOM synchronously before the one document transaction. */
  prepareForCommit(timeMs: number): void {
    if (this.destroyed) return;
    this.sample(timeMs);
    this.restoreManagedStyles();
  }

  /** Bind the motion scene to ProseMirror's committed target DOM. */
  bindCommittedDom(
    view: EditorView,
    layout: SceneLayout,
    timeMs: number,
    observedLayout: SceneLayout | null = null,
  ): CommittedGhostContentOffsets {
    const next = new Map<SceneBlockKey, HTMLElement>();
    const expected = new Set(this.scene.snapshot.blocks.keys());
    view.state.doc.descendants((node, pos) => {
      const key = stableBlockKey(node, pos);
      if (!expected.has(key)) return;
      const dom = view.nodeDOM(pos);
      if (dom instanceof view.dom.ownerDocument.defaultView!.HTMLElement) next.set(key, dom);
    });
    if (next.size !== expected.size) {
      throw new Error(`Committed live scene resolved ${next.size}/${expected.size} blocks`);
    }
    this.committed = true;
    this.committedHeightKeys = new Set(
      Array.from(layout.containerRects, ([key, rect]) => [key, rect.height] as const)
        .filter(([key, height]) => {
          const baselineHeight = this.baselineContainerHeights.get(key);
          const block = this.scene.snapshot.blocks.get(key);
          const observedHeight = observedLayout?.blockRects.get(key)?.height;
          return baselineHeight == null ||
            Math.abs(height - baselineHeight) > COMMITTED_CONTAINER_HEIGHT_EPSILON ||
            (block != null && observedHeight != null &&
              committedContainerNeedsHeightLock(block.atomic, height, observedHeight));
        })
        .map(([key]) => key),
    );
    this.committedBlockHeightLocks = new Map(
      Array.from(layout.blockRects, ([key, expectedRect]) => {
        const block = this.scene.snapshot.blocks.get(key);
        const observedRect = observedLayout?.blockRects.get(key);
        return block && observedRect && committedAtomicBlockNeedsHeightLock(
          block.atomic,
          expectedRect.height,
          observedRect.height,
        )
          ? [key, expectedRect.height] as const
          : null;
      }).filter((entry): entry is readonly [SceneBlockKey, number] => entry != null),
    );
    this.bindings = this.bindSceneDoms(next);
    this.hideDraggedBindings();
    const contentOffsets = this.refreshCommittedGhost(layout);
    this.applyLiveSamples(this.latestSamples.size > 0
      ? this.latestSamples
      : this.motion.sample(timeMs));
    return contentOffsets;
  }

  /** Replace source-context ghost pieces with the renderer's committed target
   * DOM while retaining the one continuous pointer frame. */
  refreshCommittedGhost(layout: SceneLayout): CommittedGhostContentOffsets {
    if (this.destroyed || !this.committed) return new Map();
    const previousPaddings = new Map<SceneBlockKey, { left: number; top: number }>();
    for (const piece of Array.from(
      this.ghost.querySelectorAll<HTMLElement>(".butter-drag-scene-ghost-piece"),
    )) {
      const key = piece.dataset.sceneKey;
      const padding = listPadding(piece);
      if (key && padding) previousPaddings.set(key, padding);
    }
    const rects = this.scene.snapshot.draggedBlockKeys.map((key) => {
      const rect = layout.visualRects.get(key) ?? layout.blockRects.get(key);
      if (!rect) throw new Error(`Missing committed ghost rectangle ${key}`);
      return rect;
    });
    const union = unionVisibleSceneRects(rects);
    if (!union) throw new Error("Committed drag ghost has no measurable rectangle");
    const pieces: HTMLElement[] = [];
    this.committedGhostListRows.clear();
    this.committedGhostListPaddingTargets.clear();
    for (let index = 0; index < this.scene.snapshot.draggedBlockKeys.length; index++) {
      const key = this.scene.snapshot.draggedBlockKeys[index];
      const source = this.bindings.get(key)?.dom;
      if (!source || source.classList.contains("butter-heading-folded-content")) continue;
      const block = this.scene.snapshot.blocks.get(key);
      const rect = rects[index];
      const piece = createGhostPiece(
        this.ghost.ownerDocument,
        source,
        key,
        block?.visualSelector ? rect : undefined,
        this.textContentShadow,
      );
      piece.setCssProps({
        "--butter-drag-scene-piece-left": `${rect.left - union.left}px`,
        "--butter-drag-scene-piece-top": `${rect.top - union.top}px`,
        "--butter-drag-scene-piece-width": `${rect.width}px`,
        "--butter-drag-scene-piece-height": `${rect.height}px`,
      });
      const listRow = piece.querySelector<HTMLElement>(
        ".butter-list-item.butter-drag-scene-proxy-content",
      );
      if (listRow) this.committedGhostListRows.set(key, listRow);
      pieces.push(piece);
    }
    this.ghost.replaceChildren(
      ...pieces,
      ...(this.aggregatePreview ? [this.aggregatePreview] : []),
    );
    this.ghost.classList.toggle(
      "has-content-shadow",
      pieces.some((piece) => piece.classList.contains("has-content-shadow")),
    );
    this.ghost.classList.toggle(
      "has-media-preview",
      pieces.some((piece) => piece.classList.contains("has-media-preview")),
    );
    if (this.mediaCompacted) {
      this.mediaGhostNaturalSize = { width: union.width, height: union.height };
      this.paintMediaGhostScale();
    }
    this.activateCompactHandoff(layout);
    const offsets = new Map<SceneBlockKey, SceneRect>();
    for (const piece of pieces) {
      const key = piece.dataset.sceneKey;
      if (!key) continue;
      const previous = previousPaddings.get(key);
      const next = listPadding(piece);
      if (!previous || !next) continue;
      this.committedGhostListPaddingTargets.set(key, next);
      const offset = {
        left: previous.left - next.left,
        top: previous.top - next.top,
        width: 0,
        height: 0,
      };
      offsets.set(key, offset);
      this.positionCommittedGhostContent(key, offset.left, offset.top);
    }
    return offsets;
  }

  private paintMediaGhostScale(): void {
    if (!this.mediaCompacted || !this.mediaGhostNaturalSize) return;
    const width = Math.max(0.01, this.mediaGhostNaturalSize.width);
    const height = Math.max(0.01, this.mediaGhostNaturalSize.height);
    this.ghost.setCssProps({
      "--butter-drag-scene-media-scale-x": `${this.ghostRect.width / width}`,
      "--butter-drag-scene-media-scale-y": `${this.ghostRect.height / height}`,
    });
  }

  positionCommittedGhostContent(key: SceneBlockKey, x: number, y: number): void {
    const row = this.committedGhostListRows.get(key);
    const target = this.committedGhostListPaddingTargets.get(key);
    if (!row || !target) return;
    row.style.setProperty("padding-left", `${target.left + x}px`);
    row.style.setProperty("padding-top", `${target.top + y}px`);
  }

  /** Read the committed renderer with every presentation-only class/style
   * synchronously removed, then restore the current scene before the browser
   * can paint. This prevents transformed coordinates from feeding back into
   * the next motion target. */
  measureNaturalCommittedDom<T>(measure: () => T): T {
    if (this.destroyed || !this.committed) return measure();
    const committedBindings = new Map(
      Array.from(this.bindings, ([key, binding]) => [key, binding.dom]),
    );
    this.restoreManagedStyles();
    try {
      return measure();
    } finally {
      this.bindings = this.bindSceneDoms(committedBindings);
      this.bindLaneDoms();
      this.applyLiveSamples(this.latestSamples);
    }
  }

  /** Capture the last painted chrome before teardown reveals the committed
   * renderer. The runtime compares these immutable viewport rectangles with
   * the clean DOM after every presentation style has been removed. */
  overlayRects(): DragSceneOverlayRects | null {
    if (this.destroyed || !this.committed) return null;
    return {
      ghost: rectFromDom(this.ghost.getBoundingClientRect()),
      filler: rectFromDom(this.filler.getBoundingClientRect()),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.restoreManagedStyles();
    for (const animation of this.compactLiveRevealAnimations) animation.cancel();
    this.compactLiveRevealAnimations.length = 0;
    this.overlay.remove();
    this.bindings.clear();
    this.paintedRects.clear();
  }

  private bindSceneDoms(doms: ReadonlyMap<SceneBlockKey, HTMLElement>): Map<SceneBlockKey, LiveBinding> {
    this.naturalViewportRects.clear();
    this.bindingParentKeys.clear();
    this.bindingChildren.clear();
    this.appliedContainerHeights.clear();
    this.appliedLocalDeltas.clear();
    this.promotedKeys.clear();
    const result = new Map<SceneBlockKey, LiveBinding>();
    for (const [key, dom] of doms) {
      this.rememberManagedDom(dom);
      result.set(key, { dom });
      dom.classList.add("butter-drag-scene-live-block");
      dom.classList.toggle(
        "butter-drag-scene-live-dragged",
        this.scene.snapshot.draggedBlockKeys.includes(key) &&
          !this.compactLiveRevealStarted,
      );
      if (this.compactLiveRevealStarted) {
        this.applyCompactLiveRevealAttributes(key, dom);
      }
      dom.classList.toggle(
        "butter-drag-scene-live-container",
        this.scene.snapshot.blocks.get(key)?.atomic === false &&
          (!this.committed || this.committedHeightKeys?.has(key) === true),
      );
      const lockedHeight = this.committedBlockHeightLocks.get(key);
      dom.classList.toggle(
        "butter-drag-scene-live-height-lock",
        lockedHeight != null,
      );
      if (lockedHeight != null) {
        dom.style.setProperty("--butter-drag-scene-live-height", `${lockedHeight}px`);
      }
    }
    return result;
  }

  private bindLaneDoms(): void {
    for (const [key, dom] of this.scene.laneDoms) {
      if (key === this.scene.snapshot.rootLaneKey) continue;
      this.rememberManagedDom(dom);
      dom.classList.add("butter-drag-scene-live-lane");
    }
  }

  private rememberManagedDom(dom: HTMLElement): void {
    this.allManagedDoms.add(dom);
    if (this.originalAttributes.has(dom)) return;
    this.originalAttributes.set(dom, {
      style: dom.getAttribute("style"),
      className: dom.getAttribute("class"),
      depth: dom.getAttribute("data-depth"),
    });
  }

  private hideDraggedBindings(): void {
    for (const key of this.scene.snapshot.draggedBlockKeys) {
      this.bindings.get(key)?.dom.classList.add("butter-drag-scene-live-dragged");
    }
  }

  private markSourceVacancy(): void {
    for (const key of this.scene.snapshot.draggedBlockKeys) {
      this.bindings.get(key)?.dom.classList.add("butter-drag-scene-live-source-vacancy");
    }
  }

  private applyLiveSamples(samples: ReadonlyMap<string, SceneMotionSample>): void {
    if (this.destroyed || this.bindings.size === 0) return;

    const heightDeltas = new Map<SceneBlockKey, number>();
    // Container boxes are real live boxes. Their sampled height drives native
    // callout/quote paint. Record exact height deltas so the cached natural
    // flow can advance mathematically without a forced layout read per frame.
    for (const [key, binding] of this.bindings) {
      const block = this.scene.snapshot.blocks.get(key);
      const sample = samples.get(key);
      if (block?.atomic !== false || !sample) continue;
      if (this.committed && this.committedHeightKeys?.has(key) !== true) continue;
      const height = Math.max(0, sample.rect.height);
      const previous = this.appliedContainerHeights.get(key);
      if (previous === height) continue;
      binding.dom.setCssProps({
        "--butter-drag-scene-live-height": `${height}px`,
      });
      this.appliedContainerHeights.set(key, height);
      if (previous != null) heightDeltas.set(key, height - previous);
    }

    if (this.naturalViewportRects.size === 0) {
      // One binding generation gets one clean natural-layout read. Subsequent
      // frames never consume their own transformed geometry.
      for (const binding of this.bindings.values()) {
        binding.dom.setCssProps({
          "--butter-drag-scene-live-x": "0px",
          "--butter-drag-scene-live-y": "0px",
        });
      }
      for (const [key, binding] of this.bindings) {
        this.naturalViewportRects.set(key, rectFromDom(binding.dom.getBoundingClientRect()));
      }
      this.naturalScrollOffsetY = this.scrollOffsetY;
      this.rebuildBindingTopology();
    } else {
      const scrollDelta = this.scrollOffsetY - this.naturalScrollOffsetY;
      if (scrollDelta !== 0) {
        for (const rect of this.naturalViewportRects.values()) rect.top += scrollDelta;
        this.naturalScrollOffsetY = this.scrollOffsetY;
      }
      for (const [key, delta] of heightDeltas) {
        if (delta !== 0) this.applyContainerHeightDelta(key, delta);
      }
    }

    const nextGlobal = new Map<SceneBlockKey, GlobalDelta>();
    const orderedKeys = this.bindingKeysByDepth();
    for (const key of orderedKeys) {
      const binding = this.bindings.get(key);
      const sample = samples.get(key);
      const natural = this.naturalViewportRects.get(key);
      if (!binding || !sample || !natural) continue;
      const global = {
        left: sample.rect.left - natural.left,
        top: sample.rect.top + this.scrollOffsetY - natural.top,
      };
      nextGlobal.set(key, global);
      const parentKey = this.bindingParentKeys.get(key) ?? null;
      const parent = parentKey ? nextGlobal.get(parentKey) : null;
      const localLeft = global.left - (parent?.left ?? 0);
      const localTop = global.top - (parent?.top ?? 0);
      const previous = this.appliedLocalDeltas.get(key);
      if (previous?.left === localLeft && previous.top === localTop) continue;
      binding.dom.setCssProps({
        "--butter-drag-scene-live-x": `${localLeft}px`,
        "--butter-drag-scene-live-y": `${localTop}px`,
      });
      this.appliedLocalDeltas.set(key, { left: localLeft, top: localTop });
    }
  }

  /** Only blocks with an active geometric transition need an advance
   * compositor hint. Promoting every document block made long mobile notes pay
   * layer memory and bookkeeping costs even when most blocks were stationary. */
  private updateLivePromotions(
    current: ReadonlyMap<string, SceneMotionSample>,
    targets: ReadonlyMap<SceneBlockKey, SceneRect>,
  ): void {
    const next = new Set<SceneBlockKey>();
    for (const key of this.bindings.keys()) {
      const sample = current.get(key);
      const target = targets.get(key);
      const moving = sample != null && target != null && (
        !sample.settled ||
        sample.rect.left !== target.left ||
        sample.rect.top !== target.top ||
        sample.rect.width !== target.width ||
        sample.rect.height !== target.height
      );
      if (moving) next.add(key);
    }
    for (const key of this.promotedKeys) {
      if (!next.has(key)) {
        this.bindings.get(key)?.dom.classList.remove("butter-drag-scene-live-moving");
      }
    }
    for (const key of next) {
      if (!this.promotedKeys.has(key)) {
        this.bindings.get(key)?.dom.classList.add("butter-drag-scene-live-moving");
      }
    }
    this.promotedKeys.clear();
    for (const key of next) this.promotedKeys.add(key);
  }

  private releaseSettledPromotions(
    samples: ReadonlyMap<string, SceneMotionSample>,
  ): void {
    for (const key of Array.from(this.promotedKeys)) {
      if (samples.get(key)?.settled !== true) continue;
      this.bindings.get(key)?.dom.classList.remove("butter-drag-scene-live-moving");
      this.promotedKeys.delete(key);
    }
  }

  private bindingKeysByDepth(): SceneBlockKey[] {
    const result: SceneBlockKey[] = [];
    const visit = (parent: SceneBlockKey | null): void => {
      for (const key of this.bindingChildren.get(parent) ?? []) {
        result.push(key);
        visit(key);
      }
    };
    visit(null);
    return result;
  }

  private rebuildBindingTopology(): void {
    this.bindingParentKeys.clear();
    this.bindingChildren.clear();
    const domKeys = new Map<HTMLElement, SceneBlockKey>();
    for (const [key, binding] of this.bindings) domKeys.set(binding.dom, key);
    for (const [key, binding] of this.bindings) {
      let parent: SceneBlockKey | null = null;
      for (let dom = binding.dom.parentElement; dom; dom = dom.parentElement) {
        const candidate = domKeys.get(dom);
        if (candidate) {
          parent = candidate;
          break;
        }
      }
      this.bindingParentKeys.set(key, parent);
      const children = this.bindingChildren.get(parent) ?? [];
      children.push(key);
      this.bindingChildren.set(parent, children);
    }
    const NodeCtor = this.overlay.ownerDocument.defaultView?.Node;
    if (!NodeCtor) return;
    for (const children of this.bindingChildren.values()) {
      children.sort((left, right) => {
        const leftDom = this.bindings.get(left)?.dom;
        const rightDom = this.bindings.get(right)?.dom;
        if (!leftDom || !rightDom || leftDom === rightDom) return 0;
        return leftDom.compareDocumentPosition(rightDom) & NodeCtor.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1;
      });
    }
  }

  private applyContainerHeightDelta(key: SceneBlockKey, delta: number): void {
    const container = this.naturalViewportRects.get(key);
    if (container) container.height = Math.max(0, container.height + delta);
    const parent = this.bindingParentKeys.get(key) ?? null;
    const siblings = this.bindingChildren.get(parent) ?? [];
    const index = siblings.indexOf(key);
    if (index < 0) return;
    for (let siblingIndex = index + 1; siblingIndex < siblings.length; siblingIndex++) {
      this.shiftNaturalSubtree(siblings[siblingIndex], delta);
    }
  }

  private shiftNaturalSubtree(key: SceneBlockKey, delta: number): void {
    const rect = this.naturalViewportRects.get(key);
    if (rect) rect.top += delta;
    for (const child of this.bindingChildren.get(key) ?? []) {
      this.shiftNaturalSubtree(child, delta);
    }
  }

  private restoreManagedStyles(): void {
    for (const dom of this.allManagedDoms) {
      const original = this.originalAttributes.get(dom);
      if (!original) continue;
      if (original.style == null) dom.removeAttribute("style");
      else dom.setAttribute("style", original.style);
      if (original.className == null) dom.removeAttribute("class");
      else dom.setAttribute("class", original.className);
      if (original.depth == null) dom.removeAttribute("data-depth");
      else dom.setAttribute("data-depth", original.depth);
    }
  }

  private paintRect(key: string, element: HTMLElement, rect: SceneRect): void {
    this.paintedRects.set(key, applyRect(element, rect, this.paintedRects.get(key)));
  }

  private paintGhostHandle(): void {
    if (!this.ghostHandle || !this.ghostHandleRegistration) return;
    this.paintRect("chrome:handle", this.ghostHandle, sceneRect(
      this.ghostRect.left + this.ghostHandleRegistration.left,
      this.ghostRect.top + this.ghostHandleRegistration.top,
      this.ghostHandleRegistration.width,
      this.ghostHandleRegistration.height,
    ));
  }
}
