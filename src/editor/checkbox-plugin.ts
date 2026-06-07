/**
 * Inline task-checkbox rendering.
 *
 * Task state is stored as a `checked` attribute on `list_item`
 * (see schema.ts + parser.ts post-parse transform). This plugin
 * renders a real `<input type="checkbox">` at the start of any
 * list_item with `checked` set, and toggles the attribute when
 * clicked. Nothing lives in the text content - no `[ ]` / `[x]`
 * characters to escape, no risk of stray brackets.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

function buildDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name !== "list_item") return true;
    if (node.attrs.checked === null || node.attrs.checked === undefined)
      return true;

    const first = node.firstChild;
    if (!first || first.type.name !== "paragraph") return true;

    // `pos` is before the list_item, pos+1 enters it, pos+2 enters
    // the inner paragraph. Placing a widget at that point puts the
    // checkbox right before the first inline content.
    const widgetPos = pos + 2;
    const checked = node.attrs.checked === true;

    decos.push(
      Decoration.widget(
        widgetPos,
        (view: EditorView) => {
          // Wrap the checkbox in a span with padding-right. CSS margin
          // on the input alone doesn't push the caret - the browser
          // places the caret at the widget's content-box edge, inside
          // the margin. Padding is part of the widget's box, so the
          // caret lands AFTER the padding. That gives a clear visual
          // gap between the checkbox and the cursor when the task
          // content is empty.
          const wrap = activeDocument.createElement("span");
          wrap.className = "butter-task-checkbox-wrap";
          wrap.setAttribute("contenteditable", "false");

          const input = activeDocument.createElement("input");
          input.type = "checkbox";
          input.className = "butter-task-checkbox task-list-item-checkbox";
          input.checked = checked;
          // tabIndex stays -1 so Tab through the editor doesn't snag
          // on every task checkbox (which would be brutally noisy in
          // any long list). Keyboard users toggle the checkbox at the
          // caret via Ctrl/Cmd+L; screen-reader users still reach the
          // input through SR element navigation, where the
          // aria-label + aria-checked below name it correctly.
          input.tabIndex = -1;
          input.setAttribute(
            "aria-label",
            checked
              ? "Task: done (Ctrl+L to toggle)"
              : "Task: open (Ctrl+L to toggle)",
          );
          input.setAttribute("aria-checked", String(checked));
          input.title = checked
            ? "Done. Ctrl+L to mark open"
            : "Open. Ctrl+L to mark done";
          input.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const li = view.state.doc.nodeAt(pos);
            if (!li || li.type.name !== "list_item") return;
            const next = li.attrs.checked === true ? false : true;
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                ...li.attrs,
                checked: next,
                sourceRange: null,
              }),
            );
          });
          wrap.appendChild(input);
          return wrap;
        },
        { side: -1, ignoreSelection: true, key: `cb-${checked}-${pos}` },
      ),
    );

    return true;
  });

  return DecorationSet.create(state.doc, decos);
}

const key = new PluginKey<DecorationSet>("butter-checkboxes");

/** Does the given range contain any list_item node? */
function rangeTouchesListItem(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  let found = false;
  state.doc.nodesBetween(
    Math.max(0, from),
    Math.min(state.doc.content.size, to),
    (node) => {
      if (found) return false;
      if (node.type.name === "list_item") {
        found = true;
        return false;
      }
      return true;
    },
  );
  return found;
}

export function checkboxPlugin() {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init(_, state) {
        return buildDecorations(state);
      },
      apply(tr, old, oldState, newState) {
        if (!tr.docChanged) return old;

        // Skip the full doc walk + decoration rebuild when no list
        // item was touched - for typing in a paragraph, this turns
        // an O(doc) cost per keystroke into a cheap position-map.
        let touched = false;
        const mapping = tr.mapping;
        for (let i = 0; i < mapping.maps.length && !touched; i++) {
          mapping.maps[i].forEach((oldStart, oldEnd, newStart, newEnd) => {
            if (touched) return;
            if (rangeTouchesListItem(oldState, oldStart, oldEnd)) touched = true;
            else if (rangeTouchesListItem(newState, newStart, newEnd))
              touched = true;
          });
        }
        if (!touched) return old.map(tr.mapping, tr.doc);
        return buildDecorations(newState);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
