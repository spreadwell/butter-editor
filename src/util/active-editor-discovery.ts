interface WorkspaceEditor {
  activeEditor?: unknown;
  _butterActiveEditorProxied?: boolean;
}
interface Surface { value: unknown; ready: boolean }

/** A registered native component owns its focused editor, even over a Butter
 * leaf (for example an embedded editor). Global body commands must defer. */
export function canUseBodyEditor(info: unknown, bodyEditor: unknown): boolean {
  if (info == null) return true;
  const editor = (info as { editor?: { hasFocus?: () => boolean } } | null)?.editor;
  if (editor === bodyEditor) return true;
  if (!editor) return false;
  if (typeof editor.hasFocus !== "function") return false;
  try { return editor.hasFocus() === false; } catch { return false; }
}

/** Keep the public file/editor pair current, including lifecycle subscribers.
 * Native view-state methods retain their native editor; a Butter view has no
 * CodeMirror edit mode. Never suppress the entire active-leaf event stack. */
export function installActiveEditorDiscovery(
  workspace: WorkspaceEditor, resolveSurface: () => Surface | null,
  isManagedSurface: (value: unknown) => boolean,
  readStack: () => string = () => new Error().stack ?? "",
): () => void {
  let previous = Object.getOwnPropertyDescriptor(workspace, "activeEditor");
  if (previous?.configurable === false) return () => {};
  let inherited: PropertyDescriptor | undefined, prototype: object | null = Object.getPrototypeOf(workspace) as object | null;
  while (!inherited && prototype) {
    inherited = Object.getOwnPropertyDescriptor(prototype, "activeEditor");
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  if (!previous && !inherited) return () => {};
  // Older Butter builds left this own getter installed after plugin unload.
  // Retire only that identifiable getter, never another plugin's wrapper.
  const legacy = workspace._butterActiveEditorProxied === true && previous?.get &&
    ["resolveButterEditor", "activeLeafEvents", "_onFileOpen"].every(token => previous!.get!.toString().includes(token));
  if (legacy && inherited) {
    Reflect.deleteProperty(workspace, "activeEditor");
    Reflect.deleteProperty(workspace, "_butterActiveEditorProxied");
    previous = undefined;
  }
  const descriptor = (previous ?? inherited)!;
  let value: unknown = descriptor.value, written = false, installed = true;
  let resolve: (() => Surface | null) | null = resolveSurface;
  const readNative = (): unknown => descriptor.get ? descriptor.get.call(workspace) as unknown : value;
  const getter = (): unknown => {
    const native = readNative();
    if (!installed) return native;
    const managedNative = isManagedSurface(native);
    // The native accessor clears explicit components on leaf changes/blur.
    // Preserve that authoritative component before considering the body.
    if (native != null && !managedNative) return native;
    const surface = resolve?.();
    if (!surface && !managedNative) return native;
    const stack = readStack();
    if (stack.includes("updateViewState") || stack.includes("_onFileOpen")) {
      return managedNative ? null : native;
    }
    if (surface) return surface.ready ? surface.value : null;
    return managedNative ? null : native;
  };
  const setter = descriptor.set ? (next: unknown) => { descriptor.set!.call(workspace, next); }
    : "value" in descriptor && descriptor.writable !== false ? (next: unknown) => { value = next; written = true; } : undefined;
  Object.defineProperty(workspace, "activeEditor", { get: getter, set: setter,
    configurable: true, enumerable: descriptor.enumerable ?? false });
  return () => {
    installed = false; resolve = null;
    const current = Object.getOwnPropertyDescriptor(workspace, "activeEditor");
    if (current?.get !== getter || current.set !== setter) return;
    if (previous) Object.defineProperty(workspace, "activeEditor", "value" in previous ? { ...previous, value } : previous);
    else {
      Reflect.deleteProperty(workspace, "activeEditor");
      if (written) Object.defineProperty(workspace, "activeEditor", { value, writable: true, configurable: true, enumerable: true });
    }
  };
}
