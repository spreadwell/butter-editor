/**
 * Targeted real-DOM motion for structural editor commands.
 *
 * Turn Into changes the ProseMirror document immediately. This plugin measures
 * the affected sibling lane before and after that authoritative transaction,
 * then applies a short FLIP transition to the resulting real DOM. There is no
 * cloned editor, no alternate layout model, and no serialized animation state.
 */
import { Plugin as PMPlugin, PluginKey, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

const key = new PluginKey("butter-block-animator");

/** Caller passes block IDs excluded from motion (used by drag commit). */
export const BLOCK_ANIMATOR_SKIP_IDS = "blockAnimator.skipIds";

/** Metadata appended by every canonical Turn Into conversion. */
export const TURN_INTO_MOTION_META = "blockAnimator.turnInto";

export interface TurnIntoMotionRecord {
  blockId: string;
  targetId: string;
  replacementCount: number;
}

interface RectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface BlockSnapshot {
  outer: RectSnapshot;
  content: RectSnapshot;
  parts: RectSnapshot[];
}

interface BlockLocation {
  node: PMNode;
  pos: number;
}

const TURN_INTO_DURATION_MS = 210;
const TURN_INTO_EASING = "cubic-bezier(0.2, 1, 0.4, 1)";
const activeAnimations = new WeakMap<HTMLElement, Animation>();

/** Append rather than replace metadata so a multi-selection animates as one transaction. */
export function markTurnIntoMotion(
  tr: Transaction,
  record: TurnIntoMotionRecord,
): void {
  const existing = tr.getMeta(TURN_INTO_MOTION_META) as
    | TurnIntoMotionRecord[]
    | undefined;
  tr.setMeta(TURN_INTO_MOTION_META, [...(existing ?? []), record]);
}

function usableBlockId(node: PMNode): string | null {
  const value = (node.attrs as { blockId?: unknown }).blockId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function findBlocks(doc: PMNode): Map<string, BlockLocation> {
  const out = new Map<string, BlockLocation>();
  doc.descendants((node, pos) => {
    if (!node.type.isBlock) return;
    const id = usableBlockId(node);
    if (id) out.set(id, { node, pos });
  });
  return out;
}

function siblingIds(doc: PMNode, location: BlockLocation): string[] {
  const parent = doc.resolve(location.pos).parent;
  const ids: string[] = [];
  parent.forEach((node) => {
    const id = usableBlockId(node);
    if (id) ids.push(id);
  });
  return ids;
}

function rectOf(element: HTMLElement): RectSnapshot {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function structuralContentElement(
  node: PMNode,
  element: HTMLElement,
): HTMLElement {
  if (node.type.name !== "blockquote") return element;
  const child = element.firstElementChild;
  return child?.instanceOf(HTMLElement) ? child : element;
}

function structuralPartRects(
  node: PMNode,
  element: HTMLElement,
): RectSnapshot[] {
  if (node.type.name !== "blockquote") return [];
  return Array.from(element.children)
    .filter((child): child is HTMLElement => child.instanceOf(HTMLElement))
    .map(rectOf);
}

function siblingLocations(doc: PMNode, location: BlockLocation): BlockLocation[] {
  const resolved = doc.resolve(location.pos);
  const parent = resolved.parent;
  const start = resolved.start(resolved.depth);
  const siblings: BlockLocation[] = [];
  parent.forEach((node, offset) => siblings.push({ node, pos: start + offset }));
  return siblings;
}

function rectsDiffer(a: RectSnapshot, b: RectSnapshot): boolean {
  return Math.abs(a.left - b.left) >= 0.1 ||
    Math.abs(a.top - b.top) >= 0.1 ||
    Math.abs(a.width - b.width) >= 0.1 ||
    Math.abs(a.height - b.height) >= 0.1;
}

function motionAllowed(view: EditorView): boolean {
  const body = view.dom.ownerDocument.body;
  if (body.classList.contains("butter-no-anim")) return false;
  return !(view.dom.ownerDocument.defaultView
    ?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

function finishAnimation(element: HTMLElement, animation: Animation): void {
  activeAnimations.set(element, animation);
  const release = () => {
    if (activeAnimations.get(element) !== animation) return;
    activeAnimations.delete(element);
    animation.cancel();
  };
  void animation.finished.then(release, release);
}

function animateElement(
  element: HTMLElement,
  oldRect: RectSnapshot,
  newRect: RectSnapshot,
  morph: boolean,
): void {
  const dx = oldRect.left - newRect.left;
  const dy = oldRect.top - newRect.top;
  const sx = morph && newRect.width > 0 ? oldRect.width / newRect.width : 1;
  const sy = morph && newRect.height > 0 ? oldRect.height / newRect.height : 1;
  const moved = Math.abs(dx) >= 0.1 || Math.abs(dy) >= 0.1;
  const resized = Math.abs(sx - 1) >= 0.001 || Math.abs(sy - 1) >= 0.001;
  if (!moved && !resized && !morph) return;

  activeAnimations.get(element)?.cancel();
  const animation = element.animate(
    [
      {
        transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        transformOrigin: "top left",
        opacity: morph ? 0.72 : 1,
      },
      {
        transform: "translate(0px, 0px) scale(1, 1)",
        transformOrigin: "top left",
        opacity: 1,
      },
    ],
    {
      duration: TURN_INTO_DURATION_MS,
      easing: TURN_INTO_EASING,
      fill: "both",
    },
  );
  finishAnimation(element, animation);
}

function animateStructuralContent(
  element: HTMLElement,
  oldRect: RectSnapshot,
  targetId: string,
): void {
  if (targetId !== "blockquote") return;
  const content = element.firstElementChild;
  if (!(content instanceof HTMLElement)) return;
  const newRect = rectOf(content);
  const dx = oldRect.left - newRect.left;
  const dy = oldRect.top - newRect.top;
  if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return;

  activeAnimations.get(content)?.cancel();
  const animation = content.animate(
    [
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: "translate(0px, 0px)" },
    ],
    {
      duration: TURN_INTO_DURATION_MS,
      easing: TURN_INTO_EASING,
      fill: "both",
    },
  );
  finishAnimation(content, animation);
}

function snapshotAffectedLane(
  view: EditorView,
  records: readonly TurnIntoMotionRecord[],
  skipIds: ReadonlySet<string>,
): Map<string, BlockSnapshot> {
  const locations = findBlocks(view.state.doc);
  const affectedIds = new Set<string>();
  for (const record of records) {
    const location = locations.get(record.blockId);
    if (!location) continue;
    for (const id of siblingIds(view.state.doc, location)) affectedIds.add(id);
  }

  const editorRect = view.dom.getBoundingClientRect();
  const targets = new Set(records.map((record) => record.blockId));
  const out = new Map<string, BlockSnapshot>();
  for (const id of affectedIds) {
    if (skipIds.has(id)) continue;
    const location = locations.get(id);
    if (!location) continue;
    const dom = view.nodeDOM(location.pos);
    if (!(dom instanceof HTMLElement)) continue;
    const rect = rectOf(dom);
    if (
      !targets.has(id) &&
      (rect.bottom < editorRect.top - 64 || rect.top > editorRect.bottom + 64)
    ) {
      continue;
    }
    const contentElement = targets.has(id)
      ? structuralContentElement(location.node, dom)
      : dom;
    out.set(id, {
      outer: rect,
      content: rectOf(contentElement),
      parts: targets.has(id) ? structuralPartRects(location.node, dom) : [],
    });
  }
  return out;
}

function runTurnIntoAnimations(
  view: EditorView,
  oldRects: ReadonlyMap<string, BlockSnapshot>,
  records: readonly TurnIntoMotionRecord[],
): void {
  const targets = new Map(
    records.map((record) => [record.blockId, record]),
  );
  const locations = findBlocks(view.state.doc);
  for (const [id, oldRect] of oldRects) {
    const location = locations.get(id);
    if (!location) continue;
    const dom = view.nodeDOM(location.pos);
    if (!(dom instanceof HTMLElement) || !dom.isConnected) continue;
    const record = targets.get(id);
    if (!record) {
      animateElement(dom, oldRect.outer, rectOf(dom), false);
      continue;
    }
    const { targetId } = record;

    // Entering a wrapper animates its real outer box and moves the new inner
    // content from the source text origin. Exiting a wrapper uses that stored
    // inner origin for the resulting ordinary block, avoiding a no-op FLIP
    // against the unchanged quote wrapper bounds.
    if (targetId !== "blockquote" && rectsDiffer(oldRect.outer, oldRect.content)) {
      animateElement(dom, oldRect.content, rectOf(dom), true);
    } else {
      animateElement(dom, oldRect.outer, rectOf(dom), true);
      animateStructuralContent(dom, oldRect.content, targetId);
    }

    if (record.replacementCount <= 1) continue;
    const siblings = siblingLocations(view.state.doc, location);
    const firstIndex = siblings.findIndex(({ node }) => usableBlockId(node) === id);
    if (firstIndex < 0) continue;
    for (let i = 1; i < record.replacementCount; i++) {
      const replacement = siblings[firstIndex + i];
      if (!replacement) break;
      const replacementDom = view.nodeDOM(replacement.pos);
      if (!(replacementDom instanceof HTMLElement) || !replacementDom.isConnected) continue;
      animateElement(
        replacementDom,
        oldRect.parts[i] ?? oldRect.content,
        rectOf(replacementDom),
        true,
      );
    }
  }
}

export function blockAnimatorPlugin(): PMPlugin {
  return new PMPlugin({
    key,
    view(editorView) {
      const originalDispatch = editorView.dispatch.bind(editorView);
      editorView.dispatch = (tr) => {
        const records = tr.getMeta(TURN_INTO_MOTION_META) as
          | TurnIntoMotionRecord[]
          | undefined;
        if (!tr.docChanged || !records?.length || !motionAllowed(editorView)) {
          originalDispatch(tr);
          return;
        }

        const skipIds = new Set(
          (tr.getMeta(BLOCK_ANIMATOR_SKIP_IDS) as string[] | undefined) ?? [],
        );
        const snapshot = snapshotAffectedLane(editorView, records, skipIds);
        originalDispatch(tr);
        runTurnIntoAnimations(editorView, snapshot, records);
      };
      return {
        destroy() {
          editorView.dispatch = originalDispatch;
        },
      };
    },
  });
}
