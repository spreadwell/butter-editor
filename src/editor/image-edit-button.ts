import { setIcon } from "obsidian";
import { tx } from "../i18n";

const IMAGE_EDIT_BUTTON_MIN_SIZE = 48;

/** Re-enter the existing right-click event path from another image control.
 * The editor's capture listener remains the sole owner of native-embed menu
 * resolution and editing behavior. */
export function dispatchImageContextMenu(
  anchor: HTMLElement,
  sourceEvent?: MouseEvent | KeyboardEvent,
): void {
  const ownerWindow = anchor.ownerDocument.defaultView;
  if (!ownerWindow) return;
  const rect = anchor.getBoundingClientRect();
  const pointerEvent = sourceEvent && "clientX" in sourceEvent
    ? sourceEvent
    : null;
  anchor.dispatchEvent(new ownerWindow.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: pointerEvent?.clientX ?? Math.max(rect.left, rect.right - 12),
    clientY: pointerEvent?.clientY ?? Math.max(rect.top, rect.top + 12),
    button: 2,
  }));
}

/** Add the compact top-right image action without crowding small inline
 * images. The button opens the same context menu as a right-click; it owns no
 * separate edit UI or document mutation path. */
export function attachImageEditButton(
  host: HTMLElement,
  openMenu: (event: MouseEvent) => void,
): () => void {
  const ownerWindow = host.ownerDocument.defaultView;
  if (!ownerWindow) return () => {};

  const button = host.ownerDocument.win.createEl("button");
  button.type = "button";
  button.className = "butter-image-edit-button";
  button.contentEditable = "false";
  button.setAttribute("aria-label", tx("Edit source"));
  button.setAttribute("title", tx("Edit source"));
  setIcon(button, "pencil");
  host.classList.add("butter-image-edit-host");
  host.appendChild(button);

  const syncFit = () => {
    const rect = host.getBoundingClientRect();
    button.classList.toggle(
      "is-image-large-enough",
      rect.width >= IMAGE_EDIT_BUTTON_MIN_SIZE &&
        rect.height >= IMAGE_EDIT_BUTTON_MIN_SIZE,
    );
  };
  const observer = new ownerWindow.ResizeObserver(syncFit);
  observer.observe(host);
  ownerWindow.requestAnimationFrame(syncFit);

  const onPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(event);
  };
  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("click", onClick);

  return () => {
    observer.disconnect();
    button.removeEventListener("pointerdown", onPointerDown);
    button.removeEventListener("click", onClick);
    button.remove();
    host.classList.remove("butter-image-edit-host");
  };
}
