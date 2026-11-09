/**
 * Inline task-checkbox rendering.
 *
 * Task state is stored as a `checked` attribute on `list_item`
 * (see schema.ts + parser.ts post-parse transform). This plugin
 * renders an accessible checkbox control at the start of any list_item
 * with `checked` set, and toggles the attribute when clicked. The native
 * input remains in the accessibility tree but is not the painted surface:
 * Chromium can strand a form-control layer after block-drag reflow. A
 * plain inline span owns the visible checkbox so it travels with the same
 * line box as the task text. Nothing lives in the document text content -
 * no `[ ]` / `[x]` characters to escape, no risk of stray brackets.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

type Toggle = (view: EditorView, position: number) => void;
function buildDecorations(state: EditorState, toggle?: Toggle): DecorationSet {
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
        (view: EditorView, getPos) => {
          // The wrapper occupies the same zero-net-width marker column as
          // bullet and ordered marker widgets. It is deliberately static
          // inline content: relative positioning or native form-control
          // paint can retain an obsolete compositor position after reflow.
          const wrap = activeWindow.createSpan();
          wrap.className = "butter-task-checkbox-wrap";
          wrap.setAttribute("contenteditable", "false");

          const input = activeWindow.createEl("input");
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
          wrap.title = input.title;

          const visual = activeWindow.createSpan();
          visual.className = "butter-task-checkbox-visual";
          visual.setAttribute("aria-hidden", "true");
          visual.textContent = checked ? "\u2713" : "";

          const itemPosition = (): number | undefined => {
            const widget = getPos();
            if (widget === undefined) return;
            const $pos = view.state.doc.resolve(widget), depth = $pos.depth - 1;
            if (depth < 1 || $pos.parent.type.name !== "paragraph" || $pos.parentOffset !== 0 ||
              $pos.node(depth).type.name !== "list_item" || $pos.index(depth) !== 0) return;
            return $pos.before(depth);
          };

          const setChecked = (next: boolean) => {
            const position = itemPosition();
            if (position === undefined || !view.editable || view.composing) return;
            const li = view.state.doc.nodeAt(position);
            if (!li || li.type.name !== "list_item") return;
            if (li.attrs.checked === next) return;
            if (toggle) {
              toggle(view, position);
              input.checked = view.state.doc.nodeAt(position)?.attrs.checked === true;
              return;
            }
            view.dispatch(
              view.state.tr.setNodeMarkup(position, undefined, {
                ...li.attrs,
                checked: next,
                sourceRange: null,
              }),
            );
          };
          wrap.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const position = itemPosition();
            if (position === undefined) return;
            const li = view.state.doc.nodeAt(position);
            if (!li || li.type.name !== "list_item") return;
            setChecked(li.attrs.checked !== true);
          });
          wrap.addEventListener("click", (e) => {
            // The primary pointer gesture already ran on mousedown. Cancel
            // the native input's default toggle, including after a refusal.
            // Keyboard/screen-reader activation has no pointer click count.
            e.preventDefault();
            if (e.detail !== 0) return;
            const position = itemPosition();
            if (position === undefined) return;
            const li = view.state.doc.nodeAt(position);
            if (li?.type.name === "list_item") setChecked(li.attrs.checked !== true);
          });
          input.addEventListener("change", () => {
            setChecked(input.checked);
          });
          wrap.appendChild(input);
          wrap.appendChild(visual);
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

export function checkboxPlugin(toggle?: Toggle) {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init(_, state) {
        return buildDecorations(state, toggle);
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
        return buildDecorations(newState, toggle);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state);
      },
    },
  });
}
