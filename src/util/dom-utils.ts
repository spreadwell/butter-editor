import type { EditorView } from "prosemirror-view";
import { recordError } from "../integration/debug";

/**
 * Return the nearest scrolling ancestor of `el`, or null if none.
 * A scroll ancestor is the element that clips and scrolls the
 * descendants - its own position on screen is stable while its
 * contents move.
 */
export function scrollHost(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const s = getComputedStyle(cur);
    if (
      /(auto|scroll|overlay)/.test(s.overflowY) &&
      cur.scrollHeight > cur.clientHeight + 1
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Return the viewport-top y-coordinate of the nearest scrolling
 * ancestor of `el`, or 0 if none. Callers use this as the reference
 * point for "is this heading above the fold?" checks.
 */
export function scrollHostTop(el: HTMLElement): number {
  return scrollHost(el)?.getBoundingClientRect().top ?? 0;
}

/**
 * Run a clipboard command (cut / copy) through the legacy
 * `execCommand` API. `execCommand` is deprecated, but it remains the only
 * programmatic path that respects the currently-focused input's text
 * selection inside a menu action — the async Clipboard API cannot
 * reproduce those focus/selection semantics. Typed locally so the call is
 * explicit and intentional rather than a blanket lint suppression.
 */
export function runClipboardCommand(
  doc: Document,
  command: "cut" | "copy",
): void {
  (doc as unknown as { execCommand(commandId: string): boolean }).execCommand(command);
}

interface DomWindow extends Window {
  readonly Node: typeof Node;
  readonly HTMLElement: typeof HTMLElement;
  readonly HTMLInputElement: typeof HTMLInputElement;
  readonly HTMLTextAreaElement: typeof HTMLTextAreaElement;
  readonly Event: typeof Event;
  readonly DataTransfer: typeof DataTransfer;
  readonly File: typeof File;
  readonly ClipboardEvent: typeof ClipboardEvent;
}

function targetWindow(target: Node): DomWindow | null {
  return target.ownerDocument?.defaultView as DomWindow | null;
}

function eventTargetNode(target: EventTarget | null): Node | null {
  if (!target || typeof target !== "object") return null;
  const candidate = target as Node;
  const win = candidate.ownerDocument?.defaultView as DomWindow | null;
  return win && candidate.instanceOf(win.Node) ? candidate : null;
}

type PropertyClipboardControl =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLElement;

type PropertySelection =
  | { kind: "native-range"; start: number; end: number }
  | { kind: "native-focus" }
  | { kind: "contenteditable"; range: Range };

export interface PropertyClipboardTarget {
  run(command: "cut" | "copy"): boolean;
  paste(): Promise<boolean>;
}

type EditorPasteState = EditorView["state"];

interface EditorPasteTarget {
  readonly doc: EditorPasteState["doc"];
  readonly selection: EditorPasteState["selection"];
  readonly storedMarks: EditorPasteState["storedMarks"];
}

function captureEditorPasteTarget(view: EditorView): EditorPasteTarget {
  return {
    doc: view.state.doc,
    selection: view.state.selection,
    storedMarks: view.state.storedMarks,
  };
}

function storedMarksEqual(
  left: EditorPasteState["storedMarks"],
  right: EditorPasteState["storedMarks"],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((mark, index) => mark.eq(right[index]));
}

function editorPasteTargetIsCurrent(
  view: EditorView,
  target: EditorPasteTarget,
): boolean {
  return (
    view.state.doc === target.doc &&
    view.state.selection.eq(target.selection) &&
    storedMarksEqual(view.state.storedMarks, target.storedMarks)
  );
}

function propertyControlFromPath(
  event: MouseEvent,
  boundary: HTMLElement,
): PropertyClipboardControl | null {
  const path = typeof event.composedPath === "function"
    ? event.composedPath()
    : [event.target];
  for (const candidate of path) {
    const node = eventTargetNode(candidate);
    if (!node || (node !== boundary && !boundary.contains(node))) continue;
    const win = targetWindow(node);
    if (!win) continue;
    if (node.instanceOf(win.HTMLInputElement)) {
      if (
        (node.type.toLowerCase() === "text" ||
          node.type.toLowerCase() === "number") &&
        node.isConnected &&
        !node.disabled &&
        !node.readOnly
      ) {
        return node;
      }
      continue;
    }
    if (node.instanceOf(win.HTMLTextAreaElement)) {
      if (node.isConnected && !node.disabled && !node.readOnly) return node;
      continue;
    }
    if (
      node.instanceOf(win.HTMLElement) &&
      node.isConnected &&
      node.classList.contains("multi-select-input") &&
      node.getAttribute("contenteditable") === "true"
    ) {
      return node;
    }
  }
  return null;
}

/** Date/datetime controls have browser-owned editors but expose no usable text
 * selection and reject insertText. Property-key inputs can be replaced by
 * their blur handler while Butter's menu is open. Do not replace the native
 * context menu for either case; let the host own their clipboard lifecycle. */
export function shouldUseNativePropertyContextMenu(
  event: MouseEvent,
  boundary: HTMLElement,
): boolean {
  const path = typeof event.composedPath === "function"
    ? event.composedPath()
    : [event.target];
  for (const candidate of path) {
    const node = eventTargetNode(candidate);
    if (!node || (node !== boundary && !boundary.contains(node))) continue;
    const win = targetWindow(node);
    if (!win || !node.instanceOf(win.HTMLInputElement)) continue;
    const type = node.type.toLowerCase();
    return (
      node.isConnected &&
      !node.disabled &&
      !node.readOnly &&
      (type === "date" ||
        type === "datetime-local" ||
        node.classList.contains("metadata-property-key-input"))
    );
  }
  return false;
}

/** Capture a property selection before Obsidian's context menu takes focus.
 * The returned descriptor is tied to that exact control, row, document, and
 * owner window; it never falls back to whichever pane is active later. */
export function capturePropertyClipboardTarget(
  event: MouseEvent,
  boundary: HTMLElement,
): PropertyClipboardTarget | null {
  const control = propertyControlFromPath(event, boundary);
  if (!control) return null;
  const doc = control.ownerDocument;
  const win = targetWindow(control);
  if (!win) return null;
  const nativeControl =
    control.instanceOf(win.HTMLInputElement) ||
    control.instanceOf(win.HTMLTextAreaElement)
      ? control
      : null;

  let snapshot: PropertySelection;
  if (nativeControl) {
    if (
      typeof nativeControl.selectionStart !== "number" ||
      typeof nativeControl.selectionEnd !== "number"
    ) {
      if (
        nativeControl.instanceOf(win.HTMLInputElement) &&
        nativeControl.type.toLowerCase() === "number"
      ) {
        snapshot = { kind: "native-focus" };
      } else {
        return null;
      }
    } else {
      snapshot = {
        kind: "native-range",
        start: nativeControl.selectionStart,
        end: nativeControl.selectionEnd,
      };
    }
  } else {
    const selection = doc.getSelection();
    if (
      !selection?.rangeCount ||
      !control.contains(selection.anchorNode) ||
      !control.contains(selection.focusNode)
    ) {
      return null;
    }
    snapshot = {
      kind: "contenteditable",
      range: selection.getRangeAt(0).cloneRange(),
    };
  }

  const valid = (): boolean =>
    control.isConnected &&
    boundary.isConnected &&
    boundary.contains(control) &&
    (nativeControl
      ? !nativeControl.disabled &&
        !nativeControl.readOnly &&
        (!nativeControl.instanceOf(win.HTMLInputElement) ||
          nativeControl.type.toLowerCase() === "text" ||
          nativeControl.type.toLowerCase() === "number")
      : control.classList.contains("multi-select-input") &&
        control.getAttribute("contenteditable") === "true");

  const restore = (): boolean => {
    if (!valid()) return false;
    control.focus();
    if (snapshot.kind === "native-range") {
      if (!nativeControl) return false;
      nativeControl.setSelectionRange(snapshot.start, snapshot.end);
    } else if (snapshot.kind === "contenteditable") {
      const selection = doc.getSelection();
      if (!selection || !control.contains(snapshot.range.commonAncestorContainer)) {
        return false;
      }
      selection.removeAllRanges();
      selection.addRange(snapshot.range);
    }
    return true;
  };

  const exec = (
    command: "cut" | "copy" | "insertText",
    value?: string,
  ): boolean => {
    const commandDocument = doc as unknown as {
      execCommand?: (
        commandId: string,
        showUi?: boolean,
        commandValue?: string,
      ) => boolean;
    };
    return commandDocument.execCommand?.(command, false, value) ?? false;
  };

  return {
    run(command) {
      try {
        return restore() && exec(command);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordError("clipboard", `Property ${command} failed: ${message}`);
        return false;
      }
    },
    async paste() {
      try {
        const clipboard = win.navigator.clipboard;
        if (!clipboard || typeof clipboard.readText !== "function") return false;
        const text = await clipboard.readText();
        return restore() && exec("insertText", text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordError("clipboard", `Property paste failed: ${message}`);
        return false;
      }
    },
  };
}

/** Dispatch a paste event whose clipboardData is the exact DataTransfer read
 * from the system clipboard. Some Electron/Chromium versions expose the
 * ClipboardEvent constructor but reject its clipboardData initializer. A
 * plain Event with an own clipboardData property still enters the same DOM
 * listener and therefore keeps Butter's paste policy as the semantic owner. */
function dispatchCanonicalPasteEvent(
  win: DomWindow,
  view: EditorView,
  transfer: DataTransfer,
  target: EditorPasteTarget,
): boolean {
  let event: Event | null = null;
  if (typeof win.ClipboardEvent === "function") {
    try {
      const clipboardEvent = new win.ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      // Chromium has shipped constructor variants that silently discard the
      // supplied transfer. Treat that the same as a constructor failure.
      if (clipboardEvent.clipboardData === transfer) event = clipboardEvent;
    } catch {
      // Use the owner-realm Event fallback below.
    }
  }
  if (!event && typeof win.Event === "function") {
    try {
      event = new win.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        configurable: true,
        enumerable: true,
        value: transfer,
      });
    } catch {
      event = null;
    }
  }
  if (!event) return false;
  try {
    view.dom.dispatchEvent(event);
  } catch (error) {
    // EditorView commits state before updating DOM/plugin views, and another
    // listener may throw after a handler has already prevented an async paste.
    // Either witness means this activation has an owner; falling through to
    // pasteHTML/pasteText would apply it a second time.
    if (event.defaultPrevented || !editorPasteTargetIsCurrent(view, target)) {
      const message = error instanceof Error ? error.message : String(error);
      recordError(
        "clipboard",
        `Paste was consumed before a later event update failed: ${message}`,
      );
      return true;
    }
    throw error;
  }
  return event.defaultPrevented || !editorPasteTargetIsCurrent(view, target);
}

/**
 * Read the system clipboard after an explicit Paste menu action and feed the
 * resulting MIME payload back through ProseMirror's real DOM paste pipeline.
 *
 * Chromium deliberately does not support `document.execCommand("paste")` in
 * Obsidian. Reading only text/plain is not an acceptable replacement because
 * it discards ProseMirror slice metadata, marks, tables, images, and explicit
 * Markdown MIME data. A ClipboardEvent carrying every readable flavor lets
 * Butter's paste policy and ProseMirror retain their normal ownership order.
 */
export async function pasteClipboardIntoEditor(
  view: EditorView,
): Promise<boolean> {
  try {
    const win = view.dom.ownerDocument.defaultView;
    const clipboard = win?.navigator.clipboard;
    if (!win || !clipboard || view.isDestroyed || !view.dom.isConnected) {
      return false;
    }

    // ProseMirror's logical selection survives the menu taking DOM focus. Do
    // not paste if any transaction changes it/document while permission waits.
    const target = captureEditorPasteTarget(view);
    let transfer: DataTransfer | null = null;
    let plain = "";
    let html = "";

    if (
      typeof clipboard.read === "function" &&
      typeof win.DataTransfer === "function"
    ) {
      try {
        transfer = new win.DataTransfer();
        const items = await clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            const blob = await item.getType(type);
            if (type.startsWith("text/")) {
              const value = await blob.text();
              transfer.setData(type, value);
              if (type === "text/plain") plain = value;
              if (type === "text/html") html = value;
            } else if (
              type.startsWith("image/") &&
              typeof win.File === "function"
            ) {
              transfer.items.add(new win.File([blob], "pasted-image", { type }));
            }
          }
        }
      } catch {
        // Some Chromium hosts expose read() but permission-gate it. Preserve a
        // conventional text fallback rather than partially using its payload.
        transfer = null;
        plain = "";
        html = "";
      }
    }

    if (!transfer || transfer.types.length === 0) {
      transfer = null;
      if (typeof clipboard.readText !== "function") return false;
      plain = await clipboard.readText();
      // A text-only Clipboard API is still able to use the canonical DOM
      // event path when the owner realm provides DataTransfer. This keeps
      // Markdown classification, URL handling, marks, and extension hooks in
      // the same policy chain as a keyboard paste.
      if (plain && typeof win.DataTransfer === "function") {
        try {
          transfer = new win.DataTransfer();
          transfer.setData("text/plain", plain);
        } catch {
          transfer = null;
        }
      }
    }

    if (
      view.isDestroyed ||
      !view.dom.isConnected ||
      !editorPasteTargetIsCurrent(view, target)
    ) {
      return false;
    }

    view.focus();
    if (transfer && transfer.types.length > 0) {
      try {
        if (dispatchCanonicalPasteEvent(win, view, transfer, target)) {
          return true;
        }
      } catch {
        // Only use ProseMirror's direct helpers after both owner-realm DOM
        // event constructors or the event dispatch itself were unavailable.
      }
    }

    if (html) return view.pasteHTML(html);
    if (plain) return view.pasteText(plain);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordError("clipboard", `Editor paste failed: ${message}`);
    return false;
  }
}

/**
 * Paste only the clipboard's plain-text flavor at the selection captured when
 * the context-menu action began. This intentionally bypasses HTML, files, and
 * ProseMirror clipboard slices while retaining the async target-safety guard
 * used by the rich Paste action.
 */
export async function pastePlainTextIntoEditor(
  view: EditorView,
): Promise<boolean> {
  try {
    const clipboard = view.dom.ownerDocument.defaultView?.navigator.clipboard;
    if (
      !clipboard ||
      typeof clipboard.readText !== "function" ||
      view.isDestroyed ||
      !view.dom.isConnected
    ) {
      return false;
    }

    const target = captureEditorPasteTarget(view);
    const plain = await clipboard.readText();
    if (
      view.isDestroyed ||
      !view.dom.isConnected ||
      !editorPasteTargetIsCurrent(view, target)
    ) {
      return false;
    }

    view.focus();
    return view.pasteText(plain);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordError("clipboard", `Plain-text paste failed: ${message}`);
    return false;
  }
}
