import type { Node as PMNode } from "prosemirror-model";
import type { App } from "obsidian";

export interface DragHandlesConfig {
  app: App;
  serializeNode: (node: PMNode) => string;
  dragHandleVisibility: () => "hover" | "always";
  dragMotion: () => "springy" | "snappy" | "smooth";
  dragTriggerOffset: () => number;
  containerDragTriggerOffset: () => number;
  dragCompactionTriggerPx: () => number;
  dragCompactedHeightPx: () => number;
  mouseReleaseProtection: () => "off" | "automatic" | "strong";
  /** Mobile-only: unlock ProseMirror before placing the cursor after a tap. */
  unlockMobileEditable?: () => void;
  chromeBottom?: () => number;
}

export interface BlockHit {
  pos: number;
  node: PMNode;
  dom: HTMLElement;
  rect: DOMRect;
  /** null = document root; otherwise the container owning this block. */
  context: DragContext | null;
}

export interface DragContext {
  containerPos: number;
  containerNode: PMNode;
  containerDom?: HTMLElement;
}

/** One visible direct child used by handle discovery and hit testing. */
export interface SiblingInfo {
  pos: number;
  node: PMNode;
  dom: HTMLElement;
  rect: DOMRect;
  index: number;
}

/** The handle plugin arms a pointer and then delegates the complete live
 * gesture to DragSceneRuntime. `settling` covers that delegated lifetime. */
export type DragPhase =
  | { kind: "idle" }
  | {
      kind: "armed";
      startX: number;
      startY: number;
      pointerId: number;
      hitPos: number;
      hitNode: PMNode;
      grabOffsetX: number;
      grabOffsetY: number;
      context: DragContext | null;
    }
  | { kind: "settling" };
