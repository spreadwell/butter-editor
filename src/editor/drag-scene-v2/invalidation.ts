const TRANSIENT_DESCENDANT_CLASSES = new Set([
  // Obsidian adds this touch-feedback class to the exact pressed descendant,
  // then removes it while the finger is still down. For list rows that
  // descendant is the inner paragraph rather than Drag Scene's managed row.
  "mobile-tap",
]);

const TRANSIENT_EDITOR_ROOT_CLASSES = new Set([
  "ProseMirror-focused",
  "ProseMirror-hideselection",
]);

/** Return true only when a class mutation changes ephemeral host UI state.
 * Content, structure, and geometry-affecting classes remain invalidating. */
export function dragSceneClassMutationIsTransient(
  previousClassName: string,
  currentClassNames: Iterable<string>,
  targetIsEditorRoot: boolean,
): boolean {
  const before = new Set(previousClassName.split(/\s+/).filter(Boolean));
  const after = new Set(currentClassNames);
  const changed = new Set([
    ...Array.from(before).filter((className) => !after.has(className)),
    ...Array.from(after).filter((className) => !before.has(className)),
  ]);
  if (changed.size === 0) return false;
  return Array.from(changed).every((className) =>
    TRANSIENT_DESCENDANT_CLASSES.has(className) ||
    (targetIsEditorRoot && TRANSIENT_EDITOR_ROOT_CLASSES.has(className))
  );
}
