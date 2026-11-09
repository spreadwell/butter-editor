/** Match the actual host constructor, whose exported name may be minified. */
export function installEditorViewDiscovery(
  workspace: { getActiveViewOfType: (type: unknown) => unknown },
  markdownView: unknown,
  resolveEditor: () => unknown,
): () => void {
  const original = workspace.getActiveViewOfType;
  let installed = true;
  const lookup = function (this: unknown, type: unknown): unknown {
    const native = original.call(this, type);
    return installed && native == null && type === markdownView
      ? resolveEditor() ?? native : native;
  };
  workspace.getActiveViewOfType = lookup;
  return () => {
    installed = false;
    // Preserve another plugin's later wrapper; retained calls become pass-through.
    if (workspace.getActiveViewOfType === lookup) workspace.getActiveViewOfType = original;
  };
}
