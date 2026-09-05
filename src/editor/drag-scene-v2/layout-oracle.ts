import {
  listDropFillerRect,
  rectFromDom,
  sceneRect,
  unionVisibleSceneRects,
} from "./geometry";
import type { CollectedDragScene } from "./scene";
import type {
  DragSceneSnapshot,
  DragTarget,
  SceneBlockKey,
  SceneLaneKey,
  SceneLayout,
  SceneRect,
} from "./types";
import { compactMediaSize } from "./compaction";

type DomPath = number[];

type OriginalParentOrder = {
  parent: Node;
  children: Node[];
};

export interface LayoutOracleOptions {
  /** Null preserves the renderer's natural dragged run. A finite value
   * normalizes that run to one compact live footprint in the inert clone. */
  compactHeightPx?: number | null;
  /** Renderer-measured horizontal distance between adjacent flat-list rails. */
  listIndentPx?: number;
}

export interface LayoutOracleMetrics {
  measurements: number;
  totalMeasureMs: number;
  maximumMeasureMs: number;
}

export function domPathFromAncestor(ancestor: Node, descendant: Node): DomPath {
  if (ancestor === descendant) return [];
  const reversed: number[] = [];
  let current: Node | null = descendant;
  while (current && current !== ancestor) {
    const parent: Node | null = current.parentNode;
    if (!parent) throw new Error("DOM binding is outside the editor root");
    const index = Array.from(parent.childNodes).indexOf(current as ChildNode);
    if (index < 0) throw new Error("DOM binding path could not be resolved");
    reversed.push(index);
    current = parent;
  }
  if (current !== ancestor) throw new Error("DOM binding is outside the editor root");
  return reversed.reverse();
}

export function resolveDomPath(root: Node, path: readonly number[]): Node | null {
  let current: Node | null = root;
  for (const index of path) {
    current = current?.childNodes[index] ?? null;
    if (!current) return null;
  }
  return current;
}

function sanitizeClone(root: HTMLElement): void {
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  for (const element of elements) {
    element.removeAttribute("id");
    element.removeAttribute("contenteditable");
    element.removeAttribute("autofocus");
    element.setAttribute("tabindex", "-1");
    element.classList.add("butter-drag-scene-oracle-node");
  }
  root.setAttribute("aria-hidden", "true");
  root.inert = true;
}

function editorAncestorChain(editorDom: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  let current: HTMLElement | null = editorDom.parentElement;
  while (current) {
    chain.push(current);
    if (current.classList.contains("butter-editor-view")) break;
    current = current.parentElement;
  }
  return chain.reverse();
}

function createOracleClone(editorDom: HTMLElement): {
  host: HTMLElement;
  cloneRoot: HTMLElement;
} {
  const ownerDocument = editorDom.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Layout oracle requires an owning window");
  const host = ownerDocument.win.createDiv();
  host.className = "butter-drag-scene-oracle";
  host.dataset.butterDragSceneOracle = "true";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.style.cssText = [
    "position:fixed",
    "left:-100000px",
    "top:0",
    "visibility:hidden",
    "pointer-events:none",
    "overflow:visible",
    "z-index:-2147483648",
    "contain:none",
  ].join(";");

  let cursor: HTMLElement = host;
  for (const original of editorAncestorChain(editorDom)) {
    const shell = original.cloneNode(false) as HTMLElement;
    sanitizeClone(shell);
    shell.classList.add("butter-drag-scene-oracle-shell");
    cursor.appendChild(shell);
    cursor = shell;
  }
  const cloneRoot = editorDom.cloneNode(true) as HTMLElement;
  sanitizeClone(cloneRoot);
  const editorRect = editorDom.getBoundingClientRect();
  cloneRoot.classList.add("butter-drag-scene-oracle-root");
  cloneRoot.setCssProps({
    "--butter-drag-scene-editor-width": `${editorRect.width}px`,
  });
  cursor.appendChild(cloneRoot);
  ownerDocument.body.appendChild(host);
  return { host, cloneRoot };
}

/**
 * Renderer-backed endpoint oracle. It mutates only an inert offscreen clone.
 * The live ProseMirror DOM is read for baseline geometry and never written.
 */
export class ChromiumDragLayoutOracle {
  readonly metrics: LayoutOracleMetrics = {
    measurements: 0,
    totalMeasureMs: 0,
    maximumMeasureMs: 0,
  };

  private readonly host: HTMLElement;
  private readonly cloneRoot: HTMLElement;
  private readonly cloneBlocks = new Map<SceneBlockKey, HTMLElement>();
  private readonly cloneVisuals = new Map<SceneBlockKey, HTMLElement>();
  private readonly cloneLanes = new Map<SceneLaneKey, HTMLElement>();
  private readonly parentOrders: OriginalParentOrder[];
  private readonly originalDepths = new Map<SceneBlockKey, string | null>();
  private readonly originalStyles = new Map<SceneBlockKey, string | null>();
  private readonly cache = new Map<string, SceneLayout>();
  private slotSnapshot: DragSceneSnapshot | null = null;
  private readonly originalRootRect: SceneRect;

  constructor(
    private readonly scene: CollectedDragScene,
    private readonly options: LayoutOracleOptions = {},
  ) {
    const originalRoot = scene.laneDoms.get(scene.snapshot.rootLaneKey);
    if (!originalRoot) throw new Error("Layout oracle requires a root lane DOM");
    this.originalRootRect = rectFromDom(originalRoot.getBoundingClientRect());
    const clone = createOracleClone(originalRoot);
    this.host = clone.host;
    this.cloneRoot = clone.cloneRoot;

    for (const [key, dom] of scene.blockDoms) {
      const path = domPathFromAncestor(originalRoot, dom);
      const cloneDom = resolveDomPath(this.cloneRoot, path);
      if (!(cloneDom instanceof originalRoot.ownerDocument.defaultView!.HTMLElement)) {
        throw new Error(`Layout oracle lost block DOM binding ${key}`);
      }
      this.cloneBlocks.set(key, cloneDom);
      const selector = this.scene.snapshot.blocks.get(key)?.visualSelector;
      const cloneVisual = selector
        ? cloneDom.querySelector<HTMLElement>(selector) ?? cloneDom
        : cloneDom;
      this.cloneVisuals.set(key, cloneVisual);
      if (selector) {
        // cloneNode does not carry decoded image/video metadata. Preserve the
        // renderer-resolved source aspect and maximum width so the inert clone
        // cannot fall back to HTML's 300x150 replaced-element default.
        const sourceVisual = this.scene.blockVisualDoms.get(key) ?? dom;
        const sourceRect = sourceVisual.getBoundingClientRect();
        if (sourceRect.width > 0.5 && sourceRect.height > 0.5) {
          cloneVisual.classList.add("butter-drag-scene-oracle-media");
          cloneVisual.setCssProps({
            "--butter-drag-scene-media-width": `${sourceRect.width}px`,
            "--butter-drag-scene-media-aspect":
              `${sourceRect.width} / ${sourceRect.height}`,
          });
          // Native image embeds use nested fit-content wrappers. Applying a
          // percentage cap to the cloned <img> makes that shrink-to-fit chain
          // circular; Chromium then resolves a 120 px rendered image to its
          // 1 px intrinsic bitmap width. Freeze the Butter-owned outer frame
          // against the destination lane and let every inner host fill it.
          const mediaFrame = cloneVisual.closest<HTMLElement>(
            ".butter-embed-image-resizable",
          );
          if (mediaFrame && cloneDom.contains(mediaFrame)) {
            mediaFrame.classList.add("butter-drag-scene-oracle-media-frame");
            mediaFrame.setCssProps({
              "--butter-drag-scene-media-width": `${sourceRect.width}px`,
              "--butter-drag-scene-media-aspect":
                `${sourceRect.width} / ${sourceRect.height}`,
            });
            cloneVisual.closest<HTMLElement>(".image-embed")
              ?.classList.add("butter-drag-scene-oracle-media-host");
          }
        }
      }
      this.originalDepths.set(key, cloneDom.getAttribute("data-depth"));
      this.originalStyles.set(key, cloneDom.getAttribute("style"));
    }
    for (const [key, dom] of scene.laneDoms) {
      const path = domPathFromAncestor(originalRoot, dom);
      const cloneDom = resolveDomPath(this.cloneRoot, path);
      if (!(cloneDom instanceof originalRoot.ownerDocument.defaultView!.HTMLElement)) {
        throw new Error(`Layout oracle lost lane DOM binding ${key}`);
      }
      this.cloneLanes.set(key, cloneDom);
    }

    const affectedParents = new Set<Node>();
    for (const key of scene.snapshot.draggedBlockKeys) {
      const parent = this.cloneBlocks.get(key)?.parentNode;
      if (parent) affectedParents.add(parent);
    }
    for (const lane of this.cloneLanes.values()) affectedParents.add(lane);
    this.parentOrders = Array.from(affectedParents, (parent) => ({
      parent,
      children: Array.from(parent.childNodes),
    }));
  }

  private restoreBaselineDom(): void {
    for (const order of this.parentOrders) {
      let cursor = order.parent.firstChild;
      for (const child of order.children) {
        if (cursor === child) {
          cursor = cursor.nextSibling;
          continue;
        }
        order.parent.insertBefore(child, cursor);
      }
    }
    for (const key of this.scene.snapshot.draggedBlockKeys) {
      const block = this.cloneBlocks.get(key);
      if (!block) continue;
      const depth = this.originalDepths.get(key) ?? null;
      if (depth == null) block.removeAttribute("data-depth");
      else block.setAttribute("data-depth", depth);
      const style = this.originalStyles.get(key) ?? null;
      block.classList.remove(
        "butter-drag-scene-oracle-compact-member",
        "butter-drag-scene-oracle-compact-tail",
      );
      if (style == null) block.removeAttribute("style");
      else block.setAttribute("style", style);
    }
  }

  private toOriginalCoordinates(
    rect: DOMRectReadOnly,
    cloneRootRect = this.cloneRoot.getBoundingClientRect(),
  ): SceneRect {
    if (rect.width <= 0.5 && rect.height <= 0.5) {
      return sceneRect(0, 0, 0, 0);
    }
    return sceneRect(
      this.originalRootRect.left + rect.left - cloneRootRect.left,
      this.originalRootRect.top + rect.top - cloneRootRect.top,
      rect.width,
      rect.height,
    );
  }

  private cacheKey(target: DragTarget, compact: boolean): string {
    return `${compact ? "compact" : "natural"}|${target.slotKey}|${target.listDepth ?? "none"}`;
  }

  private applyCompactFootprint(): void {
    const compactHeight = this.options.compactHeightPx;
    if (compactHeight == null || !Number.isFinite(compactHeight)) return;
    for (let index = 0; index < this.scene.snapshot.draggedBlockKeys.length; index++) {
      const element = this.cloneBlocks.get(this.scene.snapshot.draggedBlockKeys[index]);
      if (!element) continue;
      element.classList.add("butter-drag-scene-oracle-compact-member");
      element.classList.toggle("butter-drag-scene-oracle-compact-tail", index > 0);
      element.setCssProps({
        "--butter-drag-scene-compact-height":
          `${index === 0 ? Math.max(1, compactHeight) : 0}px`,
      });
    }
  }

  private leadingListPaddingTop(target: DragTarget): number {
    if (target.listDepth == null) return 0;
    const first = this.cloneBlocks.get(this.scene.snapshot.draggedBlockKeys[0]);
    if (!first) return 0;
    const value = first.ownerDocument.defaultView?.getComputedStyle(first).paddingTop;
    const padding = Number.parseFloat(value ?? "");
    return Number.isFinite(padding) ? Math.max(0, padding) : 0;
  }

  private measureMode(target: DragTarget, compact: boolean): SceneLayout {
    const key = this.cacheKey(target, compact);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const startedAt = performance.now();
    this.restoreBaselineDom();

    const slot = this.scene.snapshot.slots.get(target.slotKey);
    if (!slot) throw new Error(`Unknown drag-scene slot ${target.slotKey}`);
    const targetParent = this.cloneLanes.get(slot.laneKey);
    if (!targetParent) throw new Error(`Missing oracle lane ${slot.laneKey}`);
    const before = slot.beforeBlockKey
      ? this.cloneBlocks.get(slot.beforeBlockKey) ?? null
      : null;
    const dragged = this.scene.snapshot.draggedBlockKeys.map((blockKey) => {
      const element = this.cloneBlocks.get(blockKey);
      if (!element) throw new Error(`Missing dragged oracle block ${blockKey}`);
      return element;
    });
    for (const element of dragged) targetParent.insertBefore(element, before);
    if (compact) this.applyCompactFootprint();

    if (target.listDepth != null) {
      const first = this.scene.snapshot.blocks.get(
        this.scene.snapshot.draggedBlockKeys[0],
      );
      const sourceDepth = first?.nodeType === "list_item"
        ? Number(this.originalDepths.get(first.key) ?? 0)
        : null;
      if (sourceDepth != null) {
        const delta = target.listDepth - sourceDepth;
        for (const blockKey of this.scene.snapshot.draggedBlockKeys) {
          const block = this.scene.snapshot.blocks.get(blockKey);
          const element = this.cloneBlocks.get(blockKey);
          if (block?.nodeType !== "list_item" || !element) continue;
          const originalDepth = Number(this.originalDepths.get(blockKey) ?? 0);
          element.setAttribute("data-depth", String(Math.max(0, originalDepth + delta)));
        }
      }
    }

    void this.cloneRoot.offsetHeight;
    const cloneRootRect = this.cloneRoot.getBoundingClientRect();
    const blockRects = new Map<SceneBlockKey, SceneRect>();
    const visualRects = new Map<SceneBlockKey, SceneRect>();
    const containerRects = new Map<SceneBlockKey, SceneRect>();
    for (const [blockKey, element] of this.cloneBlocks) {
      const rect = this.toOriginalCoordinates(
        element.getBoundingClientRect(),
        cloneRootRect,
      );
      blockRects.set(blockKey, rect);
      const visual = this.cloneVisuals.get(blockKey) ?? element;
      const visualRect = visual === element
        ? rect
        : this.toOriginalCoordinates(visual.getBoundingClientRect(), cloneRootRect);
      const draggedCompact = compact &&
        this.scene.snapshot.draggedBlockKeys.includes(blockKey);
      if (draggedCompact && blockKey === this.scene.snapshot.draggedBlockKeys[0] &&
          this.scene.snapshot.draggedBlockKeys.length === 1 &&
          this.scene.snapshot.blocks.get(blockKey)?.visualSelector) {
        const fitted = compactMediaSize(
          visualRect.width,
          visualRect.height,
          Math.min(rect.height, this.options.compactHeightPx ?? rect.height),
        );
        visualRects.set(blockKey, {
          left: visualRect.left,
          top: visualRect.top,
          width: fitted.width,
          height: fitted.height,
        });
      } else {
        visualRects.set(blockKey, draggedCompact
          ? {
              left: visualRect.left,
              top: visualRect.top,
              width: Math.min(visualRect.width, rect.width),
              height: Math.min(visualRect.height, rect.height),
            }
          : visualRect);
      }
      const block = this.scene.snapshot.blocks.get(blockKey);
      if (block && !block.atomic) containerRects.set(blockKey, rect);
    }
    const flowRect = unionVisibleSceneRects(
      this.scene.snapshot.draggedBlockKeys.map((blockKey) => blockRects.get(blockKey)!),
    );
    const landingRect = unionVisibleSceneRects(
      this.scene.snapshot.draggedBlockKeys.map((blockKey) => visualRects.get(blockKey)!),
    );
    if (!flowRect || !landingRect) {
      throw new Error("Oracle drag flow or landing rectangle is not measurable");
    }
    const layout: SceneLayout = {
      target,
      blockRects,
      visualRects,
      containerRects,
      flowRect,
      landingRect,
      draggedRect: { ...landingRect },
      fillerRect: listDropFillerRect(
        landingRect,
        target.listDepth,
        this.options.listIndentPx ?? 0,
        this.leadingListPaddingTop(target),
      ),
    };
    this.cache.set(key, layout);
    const elapsed = performance.now() - startedAt;
    this.metrics.measurements++;
    this.metrics.totalMeasureMs += elapsed;
    this.metrics.maximumMeasureMs = Math.max(this.metrics.maximumMeasureMs, elapsed);
    return layout;
  }

  measure(target: DragTarget): SceneLayout {
    return this.measureMode(target, this.options.compactHeightPx != null);
  }

  measureNatural(target: DragTarget): SceneLayout {
    return this.measureMode(target, false);
  }

  baseline(): SceneLayout {
    return this.measureNatural({
      slotKey: this.scene.snapshot.sourceSlotKey,
      listDepth: null,
    });
  }

  /**
   * Measure every semantic slot in one renderer pass with the drag unit
   * removed. The vacant scene is immutable targeting authority; only the
   * selected target needs a second, exact insertion measurement. This keeps
   * pickup and depth retarget work independent of document length.
   */
  measureSlotSnapshot(_listDepth: number | null = null): DragSceneSnapshot {
    if (this.slotSnapshot) return this.slotSnapshot;
    const startedAt = performance.now();
    this.restoreBaselineDom();
    for (const blockKey of this.scene.snapshot.draggedBlockKeys) {
      this.cloneBlocks.get(blockKey)?.remove();
    }
    void this.cloneRoot.offsetHeight;
    const cloneRootRect = this.cloneRoot.getBoundingClientRect();

    const measuredSlots = new Map(this.scene.snapshot.slots);
    for (const lane of this.scene.snapshot.lanes.values()) {
      const laneDom = this.cloneLanes.get(lane.key);
      if (!laneDom) throw new Error(`Missing vacant oracle lane ${lane.key}`);
      const laneRect = this.toOriginalCoordinates(
        laneDom.getBoundingClientRect(),
        cloneRootRect,
      );
      const remaining = Array.from(this.scene.snapshot.blocks.values())
        .filter((block) => block.laneKey === lane.key &&
          !this.scene.snapshot.draggedBlockKeys.includes(block.key))
        .sort((left, right) => left.indexInLane - right.indexInLane);
      for (let index = 0; index < lane.slotKeys.length; index++) {
        const slotKey = lane.slotKeys[index];
        const slot = this.scene.snapshot.slots.get(slotKey);
        if (!slot) throw new Error(`Missing vacant oracle slot ${slotKey}`);
        const before = remaining[index]
          ? this.cloneBlocks.get(remaining[index].key) ?? null
          : null;
        const previous = index > 0 && remaining[index - 1]
          ? this.cloneBlocks.get(remaining[index - 1].key) ?? null
          : null;
        const beforeRect = before
          ? this.toOriginalCoordinates(before.getBoundingClientRect(), cloneRootRect)
          : null;
        const previousRect = previous
          ? this.toOriginalCoordinates(previous.getBoundingClientRect(), cloneRootRect)
          : null;
        measuredSlots.set(slotKey, {
          ...slot,
          rect: sceneRect(
            laneRect.left,
            beforeRect?.top ?? (previousRect
              ? previousRect.top + previousRect.height
              : laneRect.top),
            laneRect.width,
            0,
          ),
        });
      }
    }
    this.slotSnapshot = { ...this.scene.snapshot, slots: measuredSlots };
    const elapsed = performance.now() - startedAt;
    this.metrics.measurements++;
    this.metrics.totalMeasureMs += elapsed;
    this.metrics.maximumMeasureMs = Math.max(this.metrics.maximumMeasureMs, elapsed);
    return this.slotSnapshot;
  }

  invalidate(): void {
    this.cache.clear();
    this.slotSnapshot = null;
  }

  destroy(): void {
    this.cache.clear();
    this.slotSnapshot = null;
    this.host.remove();
  }
}
