/** Shared catalog shell for Toolbar and context-menu customizers. */
export function createAvailableActionCatalog(
  parent: HTMLElement,
  label: string,
  count: number,
): HTMLElement {
  const catalog = parent.createDiv({
    cls: "butter-layout-list butter-layout-available-catalog",
  });
  catalog.createDiv({
    cls: "butter-layout-list-label",
    text: `${label} (${count})`,
  });
  return catalog;
}

/** One independently collapsible category inside the available catalog. */
export function createAvailableActionCategory(
  parent: HTMLElement,
  label: string,
  count: number,
  open: boolean,
  onToggle: (open: boolean) => void,
): HTMLElement {
  const details = parent.createEl("details", {
    cls: "butter-layout-available-category",
  });
  details.open = open;
  details.addEventListener("toggle", () => onToggle(details.open));
  details.createEl("summary", {
    cls: "butter-layout-category-label butter-layout-category-summary",
    text: `${label} (${count})`,
  });
  return details.createDiv({ cls: "butter-layout-category-content" });
}
