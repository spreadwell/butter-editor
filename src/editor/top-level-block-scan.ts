import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

/** One top-level block that takes part in a pointer hit-test. */
export interface TopLevelBlock {
  /** Child index in the document. */
  index: number;
  pos: number;
  node: PMNode;
  dom: HTMLElement;
  rect: DOMRect;
}

const startsByDoc = new WeakMap<PMNode, number[]>();

function childStarts(doc: PMNode): number[] {
  let starts = startsByDoc.get(doc);
  if (!starts) {
    const collected: number[] = [];
    doc.forEach((_child, offset) => { collected.push(offset); });
    starts = collected;
    startsByDoc.set(doc, starts);
  }
  return starts;
}

/**
 * Pointer hit-testing over the top-level blocks without measuring all of
 * them.
 *
 * `view.nodeDOM(pos)` walks the document's children from the start, so asking
 * it for every block makes one pointer move quadratic in the length of the
 * note: 60ms at 600 blocks, well over 100ms at 3,000. The blocks are stacked
 * top to bottom in document order, so a binary search reaches the ones around
 * a Y coordinate in a handful of probes instead.
 *
 * A scan serves one hit-test. It remembers what it measured, so the layout
 * must not change while it is in use.
 */
export class TopLevelBlockScan {
  readonly count: number;
  private readonly starts: number[];
  private readonly measured = new Map<number, TopLevelBlock | null>();

  constructor(
    private readonly view: Pick<EditorView, "nodeDOM">,
    private readonly doc: PMNode,
    /** Which measured blocks take part. A block that is not rendered never
     * does, and neither should one hidden with `display: none`: its rect is
     * all zeros, which would put it at the top of the page. */
    private readonly visible: (rect: DOMRect) => boolean,
  ) {
    this.starts = childStarts(doc);
    this.count = this.starts.length;
  }

  private at(index: number): TopLevelBlock | null {
    const known = this.measured.get(index);
    if (known !== undefined) return known;
    let block: TopLevelBlock | null = null;
    const pos = this.starts[index];
    const dom = this.view.nodeDOM(pos);
    if (dom?.instanceOf(HTMLElement)) {
      const rect = dom.getBoundingClientRect();
      if (this.visible(rect)) {
        block = { index, pos, node: this.doc.child(index), dom, rect };
      }
    }
    this.measured.set(index, block);
    return block;
  }

  /** The nearest visible block at or after `index`, short of `limit`. */
  from(index: number, limit = this.count): TopLevelBlock | null {
    for (let i = Math.max(0, index); i < limit; i++) {
      const block = this.at(i);
      if (block) return block;
    }
    return null;
  }

  /** The nearest visible block before `index`. */
  before(index: number): TopLevelBlock | null {
    for (let i = Math.min(index, this.count) - 1; i >= 0; i--) {
      const block = this.at(i);
      if (block) return block;
    }
    return null;
  }

  /**
   * The first visible block `reached` holds for. `reached` must be a
   * threshold going down the page (for example "its bottom edge is at or
   * below the pointer"): once it holds for a block it holds for every visible
   * block after it.
   */
  first(reached: (rect: DOMRect) => boolean): TopLevelBlock | null {
    let low = 0;
    let high = this.count;
    let found: TopLevelBlock | null = null;
    while (low < high) {
      const middle = (low + high) >> 1;
      const block = this.from(middle, high);
      if (!block) {
        high = middle;
      } else if (reached(block.rect)) {
        found = block;
        high = middle;
      } else {
        low = block.index + 1;
      }
    }
    return found;
  }
}
