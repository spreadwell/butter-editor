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

// Editor chrome that is always positioned out of flow. Showing, hiding,
// pinning or moving it cannot move a block. The code-block edit toolbar
// re-pins itself as its block scrolls, which a drag does at the edges.
const OUT_OF_FLOW_CHROME_SELECTOR = ".butter-code-edit-toolbar";

/** Return true when a class or style mutation lands on out-of-flow chrome. */
export function dragSceneMutationTargetIsOutOfFlowChrome(
  target: Pick<Element, "closest">,
): boolean {
  return target.closest(OUT_OF_FLOW_CHROME_SELECTOR) !== null;
}

/** Return true when a class mutation changes nothing, or only ephemeral host
 * UI state. Content, structure, and geometry-affecting classes remain
 * invalidating.
 *
 * A class written back to the value it already has is still reported as a
 * mutation, but it cannot move anything. A change that is later undone is not
 * missed: its second record carries the changed class list as its old value. */
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
  return Array.from(changed).every((className) =>
    TRANSIENT_DESCENDANT_CLASSES.has(className) ||
    (targetIsEditorRoot && TRANSIENT_EDITOR_ROOT_CLASSES.has(className))
  );
}
