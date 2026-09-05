import { setIcon } from "obsidian";
import {
  Plugin,
  PluginKey,
  Selection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "prosemirror-view";
import { tx } from "../i18n";
import {
  headingSectionPositions,
  projectHeadingFolds,
} from "./heading-folding-model";
import { animateVerticalFold } from "./fold-animation";

interface HeadingFoldPluginState {
  collapsedIds: ReadonlySet<string>;
  decorations: DecorationSet;
}

type HeadingFoldAction = { kind: "toggle"; blockId: string } | { kind: "reveal"; pos: number };

export const headingFoldKey = new PluginKey<HeadingFoldPluginState>(
  "butter-heading-folding",
);

function toggleHeadingFold(
  view: EditorView,
  getPos: () => number | undefined,
  blockId: string,
  collapsed: boolean,
  keepControlFocus: boolean,
): void {
  const widgetPos = getPos();
  if (widgetPos == null) return;
  const headingPos = widgetPos - 1;
  const heading = view.state.doc.nodeAt(headingPos);
  if (!heading || heading.type.name !== "heading") return;
  const section = headingSectionPositions(view.state.doc, headingPos);
  const sectionElements: HTMLElement[] = [];
  for (const pos of section.slice(1)) {
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) sectionElements.push(dom);
  }

  let tr: Transaction = view.state.tr.setMeta(headingFoldKey, {
    kind: "toggle",
    blockId,
  } satisfies HeadingFoldAction);

  if (!collapsed) {
    const lastPos = section[section.length - 1];
    const last = lastPos == null ? null : view.state.doc.nodeAt(lastPos);
    const sectionEnd = lastPos == null || !last
      ? headingPos + heading.nodeSize
      : lastPos + last.nodeSize;
    const selection = view.state.selection;
    if (
      selection.from >= headingPos + heading.nodeSize &&
      selection.to <= sectionEnd
    ) {
      tr = tr.setSelection(
        Selection.near(
          tr.doc.resolve(headingPos + 1 + heading.content.size),
          -1,
        ),
      );
    }
  }

  if (!collapsed) animateVerticalFold(sectionElements, "collapse");
  view.dispatch(tr);
  if (collapsed) animateVerticalFold(sectionElements, "expand");
  if (keepControlFocus) {
    window.requestAnimationFrame(() => {
      const nextControl = Array.from(
        view.dom.querySelectorAll<HTMLElement>(".butter-heading-fold-indicator"),
      ).find((element) => element.dataset.headingBlockId === blockId);
      nextControl?.focus();
    });
  }
}

function headingFoldWidget(
  blockId: string,
  collapsed: boolean,
): (view: EditorView, getPos: () => number | undefined) => HTMLElement {
  return (view, getPos) => {
    const control = activeWindow.createSpan();
    control.className = "butter-heading-fold-indicator cm-fold-indicator";
    control.contentEditable = "false";
    control.setAttribute("role", "button");
    control.setAttribute("tabindex", "0");
    control.dataset.headingBlockId = blockId;
    control.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const action = tx(collapsed ? "Expand section" : "Collapse section");
    control.setAttribute("aria-label", action);
    control.setAttribute("title", action);

    const icon = activeWindow.createSpan();
    icon.className = "collapse-indicator collapse-icon";
    icon.classList.toggle("is-collapsed", collapsed);
    setIcon(icon, "right-triangle");
    control.appendChild(icon);

    const activate = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleHeadingFold(
        view,
        getPos,
        blockId,
        collapsed,
        event.type === "keydown",
      );
    };
    const preserveEditorSelection = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    // ProseMirror moves its selection during pointerdown. Desktop emits a
    // following mousedown, but iOS may not, so intercept both before the
    // disclosure click and leave the existing editor focus/selection intact.
    control.addEventListener("pointerdown", preserveEditorSelection);
    control.addEventListener("mousedown", preserveEditorSelection);
    control.addEventListener("click", activate);
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
    return control;
  };
}

function buildHeadingFoldState(
  state: EditorState,
  requestedCollapsedIds: ReadonlySet<string>,
): HeadingFoldPluginState {
  const projection = projectHeadingFolds(state.doc, requestedCollapsedIds);
  const collapsedIds = new Set<string>();
  const decorations: Decoration[] = [];

  for (const entry of projection) {
    const classes: string[] = [];
    if (entry.hidden) classes.push("butter-heading-folded-content");
    if (entry.foldable) classes.push("butter-heading-foldable");
    if (entry.collapsed) {
      classes.push("is-collapsed");
      if (entry.blockId) collapsedIds.add(entry.blockId);
    }
    if (classes.length > 0) {
      decorations.push(
        Decoration.node(entry.pos, entry.pos + entry.node.nodeSize, {
          class: classes.join(" "),
        }),
      );
    }
    if (entry.foldable && entry.blockId) {
      decorations.push(
        Decoration.widget(
          entry.pos + 1,
          headingFoldWidget(entry.blockId, entry.collapsed),
          {
            side: -1,
            ignoreSelection: true,
            key: `heading-fold-${entry.blockId}-${entry.collapsed ? "closed" : "open"}`,
            stopEvent: () => true,
          },
        ),
      );
    }
  }

  return {
    collapsedIds,
    decorations: DecorationSet.create(state.doc, decorations),
  };
}

export function headingFoldPlugin(): Plugin<HeadingFoldPluginState> {
  return new Plugin<HeadingFoldPluginState>({
    key: headingFoldKey,
    state: {
      init: (_, state) => buildHeadingFoldState(state, new Set()),
      apply(tr, previous, _oldState, newState) {
        const action = tr.getMeta(headingFoldKey) as HeadingFoldAction | undefined;
        if (!tr.docChanged && !action) return previous;
        const requested = new Set(previous.collapsedIds);
        if (action?.kind === "toggle") {
          if (requested.has(action.blockId)) requested.delete(action.blockId);
          else requested.add(action.blockId);
        }
        if (action?.kind === "reveal") {
          const ancestors: Array<{ level: number; blockId: string | null }> = [];
          for (const entry of projectHeadingFolds(newState.doc, requested)) {
            if (entry.pos > action.pos) break;
            if (entry.level !== null) {
              while (ancestors.length && ancestors[ancestors.length - 1].level >= entry.level) ancestors.pop();
              // A heading's own title is visible without expanding its body.
              if (action.pos < entry.pos + entry.node.nodeSize) break;
              ancestors.push({ level: entry.level, blockId: entry.blockId });
            }
          }
          for (const ancestor of ancestors) if (ancestor.blockId) requested.delete(ancestor.blockId);
        }
        return buildHeadingFoldState(newState, requested);
      },
    },
    props: {
      decorations(state) {
        return headingFoldKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}

export function revealHeadingPosition(view: EditorView, pos: number): void {
  if (!headingFoldKey.getState(view.state)?.collapsedIds.size) return;
  view.dispatch(view.state.tr.setMeta(headingFoldKey, { kind: "reveal", pos } satisfies HeadingFoldAction));
}

export function getCollapsedHeadingSectionPositions(
  state: EditorState,
  headingPos: number,
): number[] {
  const heading = state.doc.nodeAt(headingPos);
  if (!heading || heading.type.name !== "heading") return [];
  const blockId = (heading.attrs as { blockId?: unknown }).blockId;
  if (
    typeof blockId !== "string" ||
    !headingFoldKey.getState(state)?.collapsedIds.has(blockId)
  ) {
    return [];
  }
  return headingSectionPositions(state.doc, headingPos);
}
