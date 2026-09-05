import { tx } from "../../i18n";
import { buildHandleDotsSvg } from "./constants";

let dragHandleLabelId = 0;

/** Build the accessible six-dot block handle without triggering Obsidian's
 * aria-label tooltip behavior. */
export function createHandleEl(ownerDocument: Document): HTMLElement {
  const element = ownerDocument.win.createDiv();
  element.className = "butter-drag-handle";
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "-1");

  const label = ownerDocument.win.createSpan();
  label.id = `butter-drag-handle-label-${++dragHandleLabelId}`;
  label.className = "butter-visually-hidden";
  label.textContent = tx("Drag to reorder");
  element.setAttribute("aria-labelledby", label.id);
  element.appendChild(label);
  element.appendChild(buildHandleDotsSvg(ownerDocument));
  return element;
}
