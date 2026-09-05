import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { rectFromDom } from "./geometry";
import type {
  DragSceneBlock,
  DragSceneLane,
  DragSceneSlot,
  DragSceneSnapshot,
  SceneBlockKey,
  SceneLaneKey,
} from "./types";

const ROOT_LANE_KEY = "lane:root";

export interface CollectedDragScene {
  snapshot: DragSceneSnapshot;
  blockDoms: ReadonlyMap<SceneBlockKey, HTMLElement>;
  blockVisualDoms: ReadonlyMap<SceneBlockKey, HTMLElement>;
  laneDoms: ReadonlyMap<SceneLaneKey, HTMLElement>;
  positionToBlockKey: ReadonlyMap<number, SceneBlockKey>;
}

function isContainerNode(node: PMNode): boolean {
  return node.type.name === "obsidian_callout" || node.type.name === "blockquote";
}

function stableBlockKey(node: PMNode, pos: number): SceneBlockKey {
  const id: unknown = node.attrs?.blockId;
  return typeof id === "string" && id.length > 0
    ? `block:${id}`
    : `pos:${pos}:${node.type.name}`;
}

function laneKeyForContext(contextPos: number | null): SceneLaneKey {
  return contextPos == null ? ROOT_LANE_KEY : `lane:${contextPos}`;
}

function calloutContentDom(outer: HTMLElement): HTMLElement | null {
  for (const child of Array.from(outer.children)) {
    if (child.instanceOf(outer.ownerDocument.defaultView!.HTMLElement) &&
        child.classList.contains("butter-callout-content")) {
      return child;
    }
  }
  return null;
}

function childLaneDom(node: PMNode, outer: HTMLElement): HTMLElement | null {
  if (node.type.name === "blockquote") return outer;
  if (node.type.name === "obsidian_callout") return calloutContentDom(outer);
  return null;
}

function acceptsChildLane(node: PMNode, outer: HTMLElement): boolean {
  return node.type.name !== "obsidian_callout" || !outer.classList.contains("is-collapsed");
}

function mediaVisualSelector(node: PMNode, outer: HTMLElement): "img" | "video" | null {
  if (node.type.name !== "obsidian_embed") return null;
  const source = String(node.attrs.src ?? "").split("|", 1)[0].toLowerCase();
  const selector = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/.test(source)
    ? "img"
    : /\.(?:mp4|webm|mov|m4v|ogv)$/.test(source)
      ? "video"
      : null;
  return selector && outer.querySelector(selector) ? selector : null;
}

function directChildren(parent: PMNode, basePos: number): Array<{
  node: PMNode;
  pos: number;
  index: number;
}> {
  const result = [];
  let pos = basePos;
  for (let index = 0; index < parent.childCount; index++) {
    const node = parent.child(index);
    result.push({ node, pos, index });
    pos += node.nodeSize;
  }
  return result;
}

/**
 * Capture the semantic block/lane tree and read-only DOM bindings for one drag.
 * This function performs no DOM writes.
 */
export function collectDragScene(
  view: EditorView,
  draggedPositions: readonly number[],
): CollectedDragScene {
  const ownerWindow = view.dom.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Drag scene requires an owning window");
  const draggedPositionSet = new Set(draggedPositions);
  const blocks = new Map<SceneBlockKey, DragSceneBlock>();
  const lanes = new Map<SceneLaneKey, DragSceneLane>();
  const slots = new Map<string, DragSceneSlot>();
  const blockDoms = new Map<SceneBlockKey, HTMLElement>();
  const blockVisualDoms = new Map<SceneBlockKey, HTMLElement>();
  const laneDoms = new Map<SceneLaneKey, HTMLElement>();
  const positionToBlockKey = new Map<number, SceneBlockKey>();
  const draggedBlockKeys: SceneBlockKey[] = [];

  const walkLane = (
    parent: PMNode,
    basePos: number,
    contextPos: number | null,
    parentLaneKey: SceneLaneKey | null,
    ownerBlockKey: SceneBlockKey | null,
    depth: number,
    contentDom: HTMLElement,
  ): void => {
    const laneKey = laneKeyForContext(contextPos);
    const ownerDom = ownerBlockKey ? blockDoms.get(ownerBlockKey) : view.dom;
    const ownerRect = rectFromDom((ownerDom ?? contentDom).getBoundingClientRect());
    const contentRect = contentDom.getBoundingClientRect();
    const lane: DragSceneLane = {
      key: laneKey,
      contextPos,
      ownerBlockKey,
      parentLaneKey,
      depth,
      nestingLeft: contentRect.left,
      ownerRect,
      slotKeys: [],
    };
    lanes.set(laneKey, lane);
    laneDoms.set(laneKey, contentDom);

    const children = directChildren(parent, basePos);
    const laneBlocks: DragSceneBlock[] = [];
    for (const child of children) {
      const dom = view.nodeDOM(child.pos);
      if (!(dom instanceof ownerWindow.HTMLElement)) continue;
      const key = stableBlockKey(child.node, child.pos);
      const container = isContainerNode(child.node);
      const visualSelector = mediaVisualSelector(child.node, dom);
      const visualDom = visualSelector
        ? dom.querySelector<HTMLElement>(visualSelector) ?? dom
        : dom;
      const block: DragSceneBlock = {
        key,
        pos: child.pos,
        nodeType: child.node.type.name,
        laneKey,
        indexInLane: child.index,
        parentBlockKey: ownerBlockKey,
        depth,
        listDepth: child.node.type.name === "list_item"
          ? Number(child.node.attrs.depth ?? 0)
          : null,
        rect: rectFromDom(dom.getBoundingClientRect()),
        visualSelector,
        atomic: !container || draggedPositionSet.has(child.pos) ||
          !acceptsChildLane(child.node, dom),
      };
      blocks.set(key, block);
      blockDoms.set(key, dom);
      blockVisualDoms.set(key, visualDom);
      positionToBlockKey.set(child.pos, key);
      laneBlocks.push(block);
      if (draggedPositionSet.has(child.pos)) draggedBlockKeys.push(key);

      if (container && !draggedPositionSet.has(child.pos) && acceptsChildLane(child.node, dom)) {
        const nestedContentDom = childLaneDom(child.node, dom);
        if (nestedContentDom) {
          walkLane(
            child.node,
            child.pos + 1,
            child.pos,
            laneKey,
            key,
            depth + 1,
            nestedContentDom,
          );
        }
      }
    }

    const remaining = laneBlocks.filter((block) => !draggedPositionSet.has(block.pos));
    const renderedRailLefts = laneBlocks
      .filter((block) => block.rect.width > 0.5 && block.rect.height > 0.5)
      .map((block) => block.rect.left);
    if (renderedRailLefts.length > 0) {
      // The container DOM's border box is not necessarily its visible child
      // rail (the ProseMirror root and callouts both contribute padding).
      // Horizontal lane intent must use the same rendered edge the dragged
      // block is expected to align with after insertion.
      lane.nestingLeft = Math.min(...renderedRailLefts);
    }
    for (let insertion = 0; insertion <= remaining.length; insertion++) {
      const before = remaining[insertion] ?? null;
      const previous = insertion > 0 ? remaining[insertion - 1] : null;
      const top = before
        ? before.rect.top
        : previous
          ? previous.rect.top + previous.rect.height
          : contentRect.top;
      const key = `${laneKey}:slot:${insertion}`;
      const slot: DragSceneSlot = {
        key,
        laneKey,
        indexInLane: before?.indexInLane ?? parent.childCount,
        beforeBlockKey: before?.key ?? null,
        rect: {
          left: contentRect.left,
          top,
          width: contentRect.width,
          height: 0,
        },
      };
      slots.set(key, slot);
      lane.slotKeys.push(key);
    }
  };

  walkLane(view.state.doc, 0, null, null, null, 0, view.dom);

  if (draggedBlockKeys.length !== draggedPositions.length) {
    throw new Error("Every dragged ProseMirror block must have a rendered DOM binding");
  }
  const firstDragged = blocks.get(draggedBlockKeys[0]);
  if (!firstDragged) throw new Error("Drag scene requires at least one dragged block");
  if (draggedBlockKeys.some((key) => blocks.get(key)?.laneKey !== firstDragged.laneKey)) {
    throw new Error("One drag unit cannot span independent sibling lanes");
  }
  const sourceLane = lanes.get(firstDragged.laneKey);
  if (!sourceLane) throw new Error("Dragged block lane is missing");
  const sourceInsertion = Array.from(blocks.values()).filter((block) =>
    block.laneKey === firstDragged.laneKey &&
    !draggedPositionSet.has(block.pos) &&
    block.indexInLane < firstDragged.indexInLane
  ).length;
  const sourceSlotKey = `${sourceLane.key}:slot:${sourceInsertion}`;
  if (!slots.has(sourceSlotKey)) throw new Error("Source slot is missing");

  return {
    snapshot: {
      blocks,
      lanes,
      slots,
      rootLaneKey: ROOT_LANE_KEY,
      draggedBlockKeys,
      sourceSlotKey,
    },
      blockDoms,
      blockVisualDoms,
      laneDoms,
    positionToBlockKey,
  };
}
