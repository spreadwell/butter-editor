import type { Modal } from "obsidian";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

type NativeModal = Modal & { win?: Window | null };

interface NativeModalCallbacks {
  readonly onOpen: (this: Modal, ...args: Parameters<Modal["onOpen"]>) => ReturnType<Modal["onOpen"]>;
  readonly onClose: (this: Modal, ...args: Parameters<Modal["onClose"]>) => ReturnType<Modal["onClose"]>;
  readonly close: (this: Modal, ...args: Parameters<Modal["close"]>) => ReturnType<Modal["close"]>;
}

interface ModalBinding {
  readonly modal: NativeModal;
  readonly view: EditorView;
  readonly root: HTMLElement | undefined;
  readonly container: HTMLElement | undefined;
  readonly onOpen: Modal["onOpen"];
  readonly onClose: Modal["onClose"];
  readonly close: Modal["close"];
  current?: ModalOccurrence;
}

interface ModalOccurrence {
  readonly binding: ModalBinding;
  readonly document: PMNode;
  readonly editorDOM: HTMLElement;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof window;
  readonly root: HTMLElement;
  readonly container: HTMLElement;
  readonly popups: Set<SuggestOccurrence>;
  active: boolean;
}

interface NativeSuggest {
  open: (this: NativeSuggest) => void;
  close: (this: NativeSuggest) => void;
  suggestEl?: HTMLElement;
  textInputEl?: HTMLElement;
  isOpen?: boolean;
}

interface SuggestBinding {
  readonly suggest: NativeSuggest;
  readonly root: HTMLElement | undefined;
  readonly open: NativeSuggest["open"];
  readonly close: NativeSuggest["close"];
  current?: SuggestOccurrence;
}

interface SuggestOccurrence {
  readonly binding: SuggestBinding;
  readonly parent: ModalOccurrence;
  readonly anchor: HTMLInputElement;
  readonly root: HTMLElement;
  active: boolean;
}

const bindings = new WeakMap<Modal, ModalBinding>();
const editorModals = new WeakMap<EditorView, Set<ModalOccurrence>>();
const suggestBindings = new WeakMap<NativeSuggest, SuggestBinding>();

function retireSuggest(record: SuggestOccurrence | undefined): void {
  if (!record) return;
  record.active = false;
  record.parent.popups.delete(record);
  if (record.binding.current === record) record.binding.current = undefined;
}

function retire(record: ModalOccurrence | undefined): void {
  if (!record) return;
  record.active = false;
  for (const popup of record.popups) retireSuggest(popup);
  editorModals.get(record.binding.view)?.delete(record);
  if (record.binding.current === record) record.binding.current = undefined;
}

function ownerIsCurrent(record: ModalOccurrence): boolean {
  const { binding, editorDOM, ownerDocument, ownerWindow, root, container } = record;
  const { modal, view } = binding;
  return binding.current === record && bindings.get(modal) === binding &&
    modal.onOpen === binding.onOpen && modal.onClose === binding.onClose && modal.close === binding.close &&
    !view.isDestroyed && view.state.doc === record.document && view.dom === editorDOM &&
    editorDOM.isConnected && editorDOM.ownerDocument === ownerDocument &&
    ownerDocument.defaultView === ownerWindow && modal.win === ownerWindow &&
    root === binding.root && container === binding.container &&
    modal.modalEl === root && modal.containerEl === container &&
    root.ownerDocument === ownerDocument && container.ownerDocument === ownerDocument &&
    root.isConnected && container.isConnected && container.contains(root);
}

function visible(element: HTMLElement, window: Window): boolean {
  if (element.hidden || element.getClientRects().length === 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" &&
    style.visibility !== "collapse" && style.pointerEvents !== "none";
}

/** Own this exact dialog's selection interaction, independently of its opening
 * Menu. Native methods, callbacks, return values and cleanup remain intact.
 * This grants no mutation authority and never restores a rejected selection. */
export function bindEditorModalInteraction(modal: Modal, view: EditorView): void {
  if (bindings.has(modal)) return;
  const native = modal as NativeModal;
  // Keep the original methods unbound: wrappers explicitly apply the native
  // receiver, including calls borrowed by another instance.
  const methods: NativeModalCallbacks = modal;
  const originalOpen = methods.onOpen;
  const originalClose = methods.onClose;
  const originalHide = methods.close;
  const binding: ModalBinding = {
    modal: native, view, root: native.modalEl, container: native.containerEl,
    onOpen: function (this: Modal, ...args: Parameters<Modal["onOpen"]>) {
      if (this !== modal) return originalOpen?.apply(this, args);
      retire(binding.current);
      const editorDOM = view.dom;
      const ownerDocument = editorDOM?.ownerDocument;
      const ownerWindow = ownerDocument?.defaultView;
      // A modeled/non-DOM view receives no exemption. Its native callback
      // still runs, as it does when a real editor has already been destroyed.
      const record: ModalOccurrence | undefined = editorDOM && ownerDocument && ownerWindow &&
        binding.root && binding.container && native.modalEl === binding.root &&
        native.containerEl === binding.container && !view.isDestroyed ? {
          binding, document: view.state.doc, editorDOM, ownerDocument, ownerWindow,
          root: native.modalEl, container: native.containerEl, popups: new Set(), active: false,
        } : undefined;
      binding.current = record;
      if (record) {
        let records = editorModals.get(view);
        if (!records) editorModals.set(view, records = new Set());
        records.add(record);
      }
      try {
        // The selected consumers initialize synchronously. Obsidian itself
        // does not await onOpen; return its original result unchanged.
        const result = originalOpen?.apply(this, args);
        if (record && ownerIsCurrent(record)) record.active = true;
        else retire(record);
        return result;
      } catch (error) {
        retire(record);
        throw error;
      }
    },
    onClose: function (this: Modal, ...args: Parameters<Modal["onClose"]>) {
      if (this !== modal) return originalClose?.apply(this, args);
      // Native close detaches its captured container before delivery. Close
      // already retired its own record; delayed callback delivery alone must
      // not revoke another opening whose exact native owner remains current.
      const current = binding.current;
      if (current && !ownerIsCurrent(current)) retire(current);
      return originalClose?.apply(this, args);
    },
    close: function (this: Modal, ...args: Parameters<Modal["close"]>) {
      if (this !== modal) return originalHide.apply(this, args);
      // Phone close animates before onClose. Retire at the native close
      // request, before any callback can reopen this or another dialog.
      retire(binding.current);
      return originalHide.apply(this, args);
    },
  };
  bindings.set(modal, binding);
  modal.onOpen = binding.onOpen;
  modal.onClose = binding.onClose;
  modal.close = binding.close;
}

function suggestIsOpen(suggest: NativeSuggest): boolean {
  return suggest.isOpen === true;
}

function suggestIsCurrent(record: SuggestOccurrence): boolean {
  const { parent, binding, anchor, root } = record;
  const { suggest } = binding;
  return record.active && parent.active && ownerIsCurrent(parent) &&
    binding.current === record && suggestBindings.get(suggest) === binding &&
    suggest.open === binding.open && suggest.close === binding.close && suggestIsOpen(suggest) &&
    root === binding.root && suggest.suggestEl === root && suggest.textInputEl === anchor &&
    parent.root.contains(anchor) && anchor.isConnected && root.isConnected &&
    anchor.ownerDocument === parent.ownerDocument && root.ownerDocument === parent.ownerDocument;
}

/** AbstractInputSuggest mounts its popup beside the dialog on document.body.
 * Only this native suggester and input inherit the exact parent occurrence. */
export function bindEditorModalSuggestInteraction(
  modal: Modal,
  suggest: { open(): void; close(): void },
  input: HTMLInputElement,
): void {
  const parentBinding = bindings.get(modal);
  if (!parentBinding || suggestBindings.has(suggest)) return;
  const native = suggest as NativeSuggest;
  // Preserve each native call's receiver; every wrapper uses apply below.
  const originalOpen = native.open;
  const originalClose = native.close;
  const binding: SuggestBinding = {
    suggest: native, root: native.suggestEl,
    open: function (this: NativeSuggest, ...args: Parameters<NativeSuggest["open"]>) {
      if (this !== native) return originalOpen.apply(this, args);
      const parent = parentBinding.current;
      const previous = binding.current;
      // Native open is a no-op while already open. It cannot transfer an
      // old popup to a newer dialog occurrence merely by being called again.
      if (suggestIsOpen(native)) {
        try {
          const result = originalOpen.apply(this, args);
          if (previous && (previous.parent !== parent || !ownerIsCurrent(previous.parent))) retireSuggest(previous);
          return result;
        } catch (error) {
          retireSuggest(previous);
          throw error;
        }
      }
      retireSuggest(previous);
      const root = binding.root;
      const record: SuggestOccurrence | undefined = parent && root ? {
        binding, parent, anchor: input, root, active: false,
      } : undefined;
      binding.current = record;
      if (record) record.parent.popups.add(record);
      try {
        const result = originalOpen.apply(this, args);
        // A popup opened while onOpen builds the form may become usable
        // after that same parent reservation completes, never a successor.
        if (record && binding.current === record && parentBinding.current === record.parent &&
          ownerIsCurrent(record.parent) && suggestIsOpen(native) && native.suggestEl === root &&
          native.textInputEl === input && record.parent.root.contains(input)) record.active = true;
        else retireSuggest(record);
        return result;
      } catch (error) {
        retireSuggest(record);
        throw error;
      }
    },
    close: function (this: NativeSuggest, ...args: Parameters<NativeSuggest["close"]>) {
      if (this !== native) return originalClose.apply(this, args);
      retireSuggest(binding.current);
      return originalClose.apply(this, args);
    },
  };
  suggestBindings.set(native, binding);
  native.open = binding.open;
  native.close = binding.close;
}

export function isEditorModalInteraction(view: EditorView, target: EventTarget | null): boolean {
  const records = editorModals.get(view);
  if (!records) return false;
  for (const record of records) {
    if (!record.active) continue;
    if (!ownerIsCurrent(record)) {
      retire(record);
      continue;
    }
    const Node = record.ownerWindow.Node;
    if (!(target instanceof Node) || !visible(record.root, record.ownerWindow) ||
      !visible(record.container, record.ownerWindow)) continue;
    if (record.root.contains(target)) return true;
    for (const popup of record.popups) {
      if (!suggestIsCurrent(popup)) { retireSuggest(popup); continue; }
      if (popup.root.contains(target) && visible(popup.anchor, record.ownerWindow) &&
        visible(popup.root, record.ownerWindow)) return true;
    }
  }
  return false;
}
