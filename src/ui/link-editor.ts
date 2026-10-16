import {
  App,
  Menu,
  Notice,
  Platform,
  normalizePath,
  prepareFuzzySearch,
  setIcon,
  type TFile,
} from "obsidian";
import { Fragment, type Mark, type Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { addExternalLinkMark, projectExternalLinkTransaction } from "../editor/link-mark-policy";
import { linkLabelFieldText, prepareLinkLabelContent, preserveLinkControlText } from "../editor/link-label-edit";
import { markBlockConversionRefusal } from "../editor/native-block-id-conservation";
import { bindEditorMenuInteraction } from "../editor/block-menu-ownership";
import { linkOccurrenceRange, resolvedLinkOccurrenceDestination } from "../core/link-occurrence";
import {
  isRepresentableWikilinkAlias,
  isRepresentableWikilinkTarget,
} from "../core/atom-representability";
import { tx, txKnown } from "../i18n";
import { openRichContextMenu } from "./link-context-menu";
import {
  looksLikeWebDestination,
  normalizeWebDestination,
} from "./link-destination";

export type LinkEditorMode = "note" | "web";

export interface LinkMarkRange {
  from: number;
  to: number;
  href: string;
  text: string;
  nonLinkMarks: readonly Mark[];
  owner?: Mark;
  title: string | null;
}

export type LinkEditorContext =
  | { kind: "insert"; from: number; to: number; text: string; marks: readonly Mark[] }
  | { kind: "wikilink"; pos: number }
  | { kind: "external"; from: number };

export interface OpenLinkEditorOptions {
  app: App;
  view: EditorView;
  anchor: HTMLElement;
  sourcePath?: string;
  event?: MouseEvent;
  context?: LinkEditorContext;
  autoFocus?: boolean;
  /** Existing native mobile drawer whose content should become the form. */
  mobileMenu?: Menu;
}

let activeMobileLinkMenu: Menu | null = null;

/** Resolve the complete external-link mark run containing a document position. */
export function findLinkMarkRange(
  view: EditorView,
  pos: number,
): LinkMarkRange | null {
  const linkType = view.state.schema.marks.link;
  if (!linkType || pos < 0 || pos > view.state.doc.content.size) return null;
  const owned = linkOccurrenceRange(view.state.doc, pos);
  if (owned) {
    const content = view.state.doc.slice(owned.from, owned.to).content;
    const text = linkLabelFieldText(content);
    const target = resolvedLinkOccurrenceDestination(view.state.doc, owned.mark);
    if (text === null) return null;
    return { ...owned, owner: owned.mark, href: target?.href ?? "", title: target?.title ?? null, text,
      nonLinkMarks: content.firstChild?.marks.filter(mark => mark.type.name !== "link" && mark.type.name !== "link_occurrence") ?? [] };
  }
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;

  const parent = $pos.parent;
  const parentStart = $pos.start();
  const offset = $pos.parentOffset;
  let found = -1;
  let cursor = 0;
  for (let index = 0; index < parent.childCount; index += 1) {
    const child = parent.child(index);
    const start = cursor;
    const end = start + child.nodeSize;
    if (
      (offset >= start && offset <= end)
      && child.marks.some((mark) => mark.type === linkType)
    ) {
      found = index;
      if (offset > start && offset < end) break;
    }
    cursor = end;
  }
  if (found < 0) return null;

  const link = parent.child(found).marks.find((mark) => mark.type === linkType)!;
  let first = found;
  let last = found;
  while (
    first > 0
    && parent.child(first - 1).marks.some((mark) => mark.type === linkType && mark.eq(link))
  ) first -= 1;
  while (
    last < parent.childCount - 1
    && parent.child(last + 1).marks.some((mark) => mark.type === linkType && mark.eq(link))
  ) last += 1;

  let from = parentStart;
  let to = parentStart;
  cursor = 0;
  for (let index = 0; index < parent.childCount; index += 1) {
    const child = parent.child(index);
    if (index === first) from = parentStart + cursor;
    if (index === last) to = parentStart + cursor + child.nodeSize;
    cursor += child.nodeSize;
  }
  const firstChild = parent.child(first);
  return {
    from,
    to,
    href: (link.attrs as { href?: string }).href ?? "",
    text: linkLabelFieldText(view.state.doc.slice(from, to).content) ?? view.state.doc.textBetween(from, to),
    nonLinkMarks: firstChild.marks.filter((mark) => mark.type !== linkType),
    title: typeof link.attrs.title === "string" ? link.attrs.title : null,
  };
}

function nearbyWikilink(view: EditorView, pos: number): { pos: number; node: PMNode } | null {
  for (const candidate of [pos, pos - 1, pos + 1]) {
    if (candidate < 0 || candidate > view.state.doc.content.size) continue;
    const node = view.state.doc.nodeAt(candidate);
    if (node?.type.name === "wikilink") return { pos: candidate, node };
  }
  return null;
}

function contextFromSelection(view: EditorView): LinkEditorContext {
  const selection = view.state.selection;
  if (selection instanceof NodeSelection && selection.node.type.name === "wikilink") {
    return { kind: "wikilink", pos: selection.from };
  }
  if (selection.empty) {
    const wiki = nearbyWikilink(view, selection.from);
    if (wiki) return { kind: "wikilink", pos: wiki.pos };
    const external = findLinkMarkRange(view, selection.from);
    if (external) return { kind: "external", from: external.from };
  } else {
    const external = findLinkMarkRange(view, selection.from);
    if (external && selection.from >= external.from && selection.to <= external.to) {
      return { kind: "external", from: external.from };
    }
  }
  return {
    kind: "insert",
    from: selection.from,
    to: selection.to,
    text: selection.empty ? "" : linkLabelFieldText(view.state.doc.slice(selection.from, selection.to).content) ?? view.state.doc.textBetween(selection.from, selection.to),
    marks: selection.$from.marks(),
  };
}

function currentWikilink(view: EditorView, pos: number): PMNode | null {
  const node = view.state.doc.nodeAt(pos);
  return node?.type.name === "wikilink" ? node : null;
}

function initialValues(view: EditorView, context: LinkEditorContext): {
  mode: LinkEditorMode;
  target: string;
  text: string;
  editing: boolean;
} {
  if (context.kind === "wikilink") {
    const node = currentWikilink(view, context.pos);
    const target = (node?.attrs.target as string | undefined) ?? "";
    const alias = (node?.attrs.alias as string | undefined) ?? "";
    return { mode: "note", target, text: node?.attrs.emptyAlias ? "" : alias || target, editing: true };
  }
  if (context.kind === "external") {
    const range = findLinkMarkRange(view, context.from);
    return {
      mode: "web",
      target: range?.href ?? "",
      text: range?.text ?? "",
      editing: true,
    };
  }
  const selectedDestination = normalizeWebDestination(context.text);
  if (selectedDestination && looksLikeWebDestination(context.text)) {
    return {
      mode: "web",
      target: selectedDestination,
      text: context.text,
      editing: false,
    };
  }
  return { mode: "note", target: "", text: context.text, editing: false };
}

function replacementRange(
  view: EditorView,
  context: LinkEditorContext,
): { from: number; to: number; marks: readonly Mark[]; text: string } | null {
  if (context.kind === "wikilink") {
    const node = currentWikilink(view, context.pos);
    if (!node) return null;
    return {
      from: context.pos,
      to: context.pos + node.nodeSize,
      marks: node.marks,
      text: node.attrs.emptyAlias ? "" : (node.attrs.alias as string) || (node.attrs.target as string) || "",
    };
  }
  if (context.kind === "external") {
    const range = findLinkMarkRange(view, context.from);
    return range
      ? { from: range.from, to: range.to, marks: range.nonLinkMarks, text: range.text }
      : null;
  }
  if (context.from < 0 || context.to > view.state.doc.content.size) return null;
  return {
    from: context.from,
    to: context.to,
    marks: context.marks,
    text: context.text,
  };
}

function declinedLinkEdit(view: EditorView): false {
  if (!view.isDestroyed) {
    const tr = view.state.tr;
    markBlockConversionRefusal(tr);
    view.dispatch(tr);
  }
  return false;
}

function dispatchLinkEdit(view: EditorView, tr: Transaction): boolean {
  const before = view.state.doc;
  view.dispatch(tr);
  // A prepared admission filter can veto a proposal after the field's own
  // validation. Keep the form open rather than reporting that veto as Save.
  return !tr.docChanged || view.state.doc !== before;
}

/** A form owns the exact reviewed document; stale positions never acquire a
 * different occurrence after a remote edit, undo, or awaited note creation. */
export function captureLinkEditorMutation(view: EditorView, context: LinkEditorContext): () => boolean {
  const doc = view.state.doc;
  const range = replacementRange(view, context);
  return () => Boolean(range && !view.isDestroyed && view.editable !== false && view.state.doc === doc) || declinedLinkEdit(view);
}

export function applyLinkEditorValues(
  view: EditorView,
  context: LinkEditorContext,
  mode: LinkEditorMode,
  values: Record<string, string>,
): boolean {
  const range = replacementRange(view, context);
  if (!range) return declinedLinkEdit(view);
  const rawText = values.text ?? "";

  if (mode === "note") {
    const target = (values.target ?? "").trim();
    if (!isRepresentableWikilinkTarget(target)) return false;
    let alias = rawText;
    if (!isRepresentableWikilinkAlias(alias)) return false;
    const emptyAlias = context.kind === "wikilink" && rawText === "";
    if (!alias || alias === target) alias = "";
    const type = view.state.schema.nodes.wikilink;
    if (!type) return false;
    if (context.kind === "wikilink") {
      const existing = currentWikilink(view, context.pos)!;
      if (existing.attrs.target === target && rawText === range.text) return true;
    } else if (range.from !== range.to) {
      const content = view.state.doc.slice(range.from, range.to).content;
      const retainedMarks = range.marks.filter(mark => !["link", "link_occurrence"].includes(mark.type.name));
      if (content.content.some(node => {
        const marks = node.marks.filter(mark => !["link", "link_occurrence"].includes(mark.type.name));
        return !node.isText || marks.length !== retainedMarks.length || !marks.every(mark => retainedMarks.some(existing => existing.eq(mark)));
      })) return declinedLinkEdit(view);
    }
    const node = type.create({ target, alias, emptyAlias }, null, range.marks.filter(mark => !["link", "link_occurrence"].includes(mark.type.name)));
    return dispatchLinkEdit(view, view.state.tr.replaceWith(range.from, range.to, node).scrollIntoView());
  }

  const existing = context.kind === "external" ? findLinkMarkRange(view, context.from) : null;
  if (context.kind === "wikilink" && currentWikilink(view, context.pos)?.attrs.emptyAlias && !rawText) return declinedLinkEdit(view);
  const unchangedTarget = existing && (values.target ?? "").trim() === existing.href;
  const href = unchangedTarget ? existing.href : normalizeWebDestination(values.target ?? "");
  const linkType = view.state.schema.marks.link;
  const unresolvedReference = unchangedTarget && existing.owner?.attrs.syntax === "reference" && !href;
  if ((!href && !unresolvedReference) || !linkType) return false;
  const text = rawText || href || "";
  if (!text) return false;
  if (existing && unchangedTarget && text === existing.text) return true;
  let replacement: Fragment;
  if (range.from === range.to) replacement = Fragment.from(view.state.schema.text(text, range.marks));
  else if (context.kind === "wikilink") {
    if (text !== range.text) return declinedLinkEdit(view);
    replacement = Fragment.from(view.state.schema.text(text, range.marks));
  } else {
    const prepared = prepareLinkLabelContent(view.state.doc.slice(range.from, range.to).content, text);
    if (!prepared) return declinedLinkEdit(view);
    replacement = prepared;
  }
  const tr = view.state.tr;
  if (text !== range.text || context.kind === "wikilink" || range.from === range.to) tr.replaceWith(range.from, range.to, replacement);
  const to = range.from + replacement.size;
  tr.removeMark(range.from, to, linkType);
  if (existing?.owner) {
    const owner = unchangedTarget ? existing.owner : existing.owner.type.create({ ...existing.owner.attrs,
      syntax: "inline", href, title: existing.title, reference: null, referenceForm: null, labelSource: null, labelSignature: null, labelOuterMarks: null, resolved: true });
    tr.removeMark(range.from, to, owner.type).addMark(range.from, to, owner);
  } else addExternalLinkMark(tr, range.from, to, linkType.create({ href: href!, title: existing?.title ?? null }));
  return dispatchLinkEdit(view, projectExternalLinkTransaction(tr).scrollIntoView());
}

export function removeLinkEditorOccurrence(view: EditorView, context: LinkEditorContext): boolean {
  if (context.kind === "insert") return false;
  if (context.kind === "external") {
    const range = findLinkMarkRange(view, context.from);
    const linkType = view.state.schema.marks.link;
    if (!range || !linkType) return false;
    const tr = view.state.tr.removeMark(range.from, range.to, linkType);
    const ownerType = view.state.schema.marks.link_occurrence;
    if (ownerType) tr.removeMark(range.from, range.to, ownerType);
    return dispatchLinkEdit(view, tr.scrollIntoView());
  }
  const node = currentWikilink(view, context.pos);
  if (!node) return false;
  if (node.attrs.emptyAlias) return dispatchLinkEdit(view, view.state.tr.delete(context.pos, context.pos + node.nodeSize).scrollIntoView());
  const text = (node.attrs.alias as string) || (node.attrs.target as string) || "";
  if (!text) return false;
  return dispatchLinkEdit(view,
    view.state.tr.replaceWith(
      context.pos,
      context.pos + node.nodeSize,
      view.state.schema.text(text, node.marks),
    ).scrollIntoView(),
  );
}

function notePathFromTarget(target: string): string | null {
  const linkPath = target.split("#", 1)[0].split("^", 1)[0].trim();
  if (!linkPath || linkPath.startsWith("/") || linkPath.includes("..")) return null;
  return normalizePath(linkPath.toLowerCase().endsWith(".md") ? linkPath : `${linkPath}.md`);
}

function noteTargetExists(app: App, target: string, sourcePath: string): boolean {
  const linkPath = target.split("#", 1)[0].split("^", 1)[0].trim();
  return Boolean(linkPath && app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath));
}

async function createNoteIfMissing(app: App, target: string, sourcePath: string): Promise<boolean> {
  if (noteTargetExists(app, target, sourcePath)) return true;
  const path = notePathFromTarget(target);
  if (!path) return false;
  const segments = path.split("/");
  if (segments.length > 1) {
    let folder = "";
    for (const segment of segments.slice(0, -1)) {
      folder = folder ? `${folder}/${segment}` : segment;
      if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    }
  }
  if (!app.vault.getAbstractFileByPath(path)) await app.vault.create(path, "");
  return true;
}

function openNoteDestination(
  app: App,
  target: string,
  sourcePath: string,
): boolean {
  const note = target.trim();
  if (!isRepresentableWikilinkTarget(note)) return false;
  void app.workspace.openLinkText(note, sourcePath, false);
  return true;
}

function openExternalDestination(target: string): boolean {
  const href = normalizeWebDestination(target);
  if (!href) return false;
  window.open(href, "_blank");
  return true;
}

type AppWithWebViewer = App & {
  internalPlugins?: {
    plugins?: {
      webviewer?: { enabled?: boolean; views?: { webviewer?: unknown } };
    };
  };
};

function isObsidianWebViewerEnabled(app: App): boolean {
  const webviewer = (app as AppWithWebViewer).internalPlugins?.plugins?.webviewer;
  return webviewer?.enabled === true && Boolean(webviewer.views?.webviewer);
}

function openInObsidianWebViewer(app: App, target: string): boolean {
  const href = normalizeWebDestination(target);
  if (!href || !isObsidianWebViewerEnabled(app)) return false;
  void app.workspace.getLeaf(true).setViewState({
    type: "webviewer",
    active: true,
    state: { url: href },
  });
  return true;
}

function mobileNoteSuggestions(app: App, query: string, limit = 4): TFile[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const match = prepareFuzzySearch(trimmed);
  return app.vault
    .getMarkdownFiles()
    .map((file) => ({
      file,
      score: Math.max(
        match(file.basename)?.score ?? -Infinity,
        match(file.path)?.score ?? -Infinity,
      ),
    }))
    .filter((candidate) => candidate.score !== -Infinity)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((candidate) => candidate.file);
}

/** Native Obsidian Menu drawer shared by Add Link and Edit Link. */
function openMobileLinkEditor(
  options: OpenLinkEditorOptions,
  context: LinkEditorContext,
): void {
  const { app, view } = options;
  const initial = initialValues(view, context);
  const canMutate = captureLinkEditorMutation(view, context);
  const editing = initial.editing;
  const sourcePath = options.sourcePath ?? "";
  const restoreEditorOnClose = context.kind === "insert" || view.hasFocus();

  if (activeMobileLinkMenu && activeMobileLinkMenu !== options.mobileMenu) {
    activeMobileLinkMenu.hide();
  }

  const drawer = new (class {
    private menu!: Menu;
    private contentEl!: HTMLElement;
    private mode: LinkEditorMode = initial.mode;
    private targetInput!: HTMLInputElement;
    private textInput!: HTMLInputElement | HTMLTextAreaElement;
    private suggestionsEl!: HTMLElement;
    private createNoteButton!: HTMLButtonElement;
    private suggestionButtons: HTMLButtonElement[] = [];
    private restoreEditor = restoreEditorOnClose;
    private modeExplicitlyChosen = false;
    private initialControlText = initial.text;

    open(): void {
      const existingMenu = options.mobileMenu;
      this.menu = existingMenu ?? new Menu();
      bindEditorMenuInteraction(this.menu, view);
      if (!existingMenu) {
        this.menu.addItem((item) => {
          item.setTitle(txKnown(editing ? "Edit link" : "Add link"));
          item.setDisabled(true);
        });
        const rect = options.anchor.getBoundingClientRect();
        this.menu.showAtPosition({
          x: rect.left + rect.width / 2,
          y: rect.bottom + 4,
        });
      }

      const root = (this.menu as unknown as { dom?: HTMLElement }).dom;
      if (!root) {
        this.menu.hide();
        return;
      }
      root.addClass("butter-mobile-link-drawer");
      root.setAttribute("role", "dialog");
      const scroll = root.querySelector<HTMLElement>(".menu-scroll") ?? root;
      scroll.empty();
      this.contentEl = scroll.createDiv({ cls: "butter-mobile-link-drawer-content" });

      const header = this.contentEl.createDiv({
        cls: "butter-mobile-drawer-header butter-mobile-link-drawer-header",
      });
      const headerIcon = header.createDiv({ cls: "butter-mobile-drawer-header-icon" });
      setIcon(headerIcon, "link");
      const headerText = header.createDiv({ cls: "butter-mobile-drawer-header-text" });
      headerText.createDiv({
        cls: "butter-mobile-drawer-header-title",
        text: txKnown(editing ? "Edit link" : "Add link"),
      });
      headerText.createDiv({
        cls: "butter-mobile-drawer-header-sub",
        text: txKnown("Link to a note or the web"),
      });

      const modeSwitch = this.contentEl.createDiv({
        cls: "butter-mobile-link-mode-switch butter-toolbar-platform-switcher",
        attr: { role: "tablist", "aria-label": txKnown("Link type") },
      });
      modeSwitch.createDiv({
        cls: "butter-toolbar-platform-switcher__indicator",
        attr: { "aria-hidden": "true" },
      });
      const modeButtons = new Map<LinkEditorMode, HTMLButtonElement>();
      for (const option of [
        { value: "note" as const, label: "Note", icon: "file-text" },
        { value: "web" as const, label: "Web", icon: "globe" },
      ]) {
        const button = modeSwitch.createEl("button", {
          cls: "butter-mobile-link-mode-button butter-toolbar-platform-switcher__btn",
          attr: {
            type: "button",
            role: "tab",
            "aria-label": txKnown(option.label),
          },
        });
        const icon = button.createSpan({ cls: "butter-toolbar-platform-switcher__icon" });
        setIcon(icon, option.icon);
        button.createSpan({
          cls: "butter-toolbar-platform-switcher__label",
          text: txKnown(option.label),
        });
        button.addEventListener("click", () => {
          this.modeExplicitlyChosen = true;
          this.mode = option.value;
          updateMode();
          this.targetInput.focus();
          this.targetInput.select();
        });
        modeButtons.set(option.value, button);
      }

      const form = this.contentEl.createDiv({ cls: "butter-mobile-link-form" });
      const targetField = form.createDiv({ cls: "butter-mobile-edit-field" });
      targetField.createDiv({
        cls: "butter-mobile-edit-field-label",
        text: txKnown("Destination"),
      });
      this.targetInput = targetField.createEl("input", {
        cls: "butter-mobile-edit-input butter-mobile-link-target",
        attr: { type: "text", autocomplete: "off" },
      });
      this.targetInput.value = initial.target;
      this.targetInput.spellcheck = false;
      this.suggestionsEl = targetField.createDiv({
        cls: "butter-mobile-link-suggestions suggestion-group butter-hidden",
        attr: { role: "listbox", "aria-label": txKnown("Notes") },
      });

      const textField = form.createDiv({ cls: "butter-mobile-edit-field" });
      textField.createDiv({
        cls: "butter-mobile-edit-field-label",
        text: tx("Display text"),
      });
      this.textInput = textField.createEl(/[\r\n]/.test(initial.text) ? "textarea" : "input", {
        cls: "butter-mobile-edit-input",
        attr: {
          type: "text",
          autocomplete: "off",
          placeholder: txKnown("Optional"),
        },
      });
      this.textInput.value = initial.text;
      this.initialControlText = this.textInput.value;
      this.textInput.spellcheck = false;

      this.createNoteButton = this.contentEl.createEl("button", {
        cls: "butter-mobile-link-create butter-hidden",
        attr: { type: "button" },
      });
      const createIcon = this.createNoteButton.createSpan();
      setIcon(createIcon, "file-plus-2");
      this.createNoteButton.createSpan({ text: txKnown("Create note and insert") });
      this.createNoteButton.addEventListener("click", () => {
        void this.createAndCommit();
      });

      const actions = this.contentEl.createDiv({ cls: "butter-mobile-link-drawer-actions" });
      const cancel = actions.createEl("button", { text: txKnown("Cancel") });
      cancel.addEventListener("click", () => this.menu.hide());
      const save = actions.createEl("button", {
        cls: "mod-cta",
        text: txKnown(editing ? "Save" : "Insert"),
      });
      save.addEventListener("click", () => this.commit());

      const updateMode = () => {
        modeSwitch.dataset.mode = this.mode;
        modeSwitch.dataset.segment = this.mode === "note" ? "desktop" : "mobile";
        for (const [candidate, button] of modeButtons) {
          const selected = candidate === this.mode;
          button.toggleClass("is-active", selected);
          button.setAttribute("aria-selected", String(selected));
          button.tabIndex = selected ? 0 : -1;
        }
        this.targetInput.placeholder = this.mode === "note"
          ? txKnown("Search notes…")
          : "https://...";
        this.hideSuggestions();
        this.refreshCreateNote();
      };

      this.targetInput.addEventListener("input", () => {
        if (
          !this.modeExplicitlyChosen
          && this.mode !== "web"
          && looksLikeWebDestination(this.targetInput.value)
        ) {
          this.mode = "web";
          updateMode();
        }
        this.renderSuggestions();
        this.refreshCreateNote();
      });
      for (const input of [this.targetInput, this.textInput]) {
        input.addEventListener("keydown", (rawEvent) => {
          const event = rawEvent as KeyboardEvent;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            this.commit();
          } else if (
            input === this.targetInput
            && event.key === "ArrowDown"
            && this.suggestionButtons.length > 0
          ) {
            event.preventDefault();
            this.suggestionButtons[0].focus();
          }
        });
      }

      updateMode();
      if (options.autoFocus ?? true) {
        window.setTimeout(() => {
          this.targetInput.focus();
          this.targetInput.select();
        }, 0);
      }

      activeMobileLinkMenu = this.menu;
      this.menu.onHide(() => {
        if (activeMobileLinkMenu === this.menu) activeMobileLinkMenu = null;
        this.contentEl.remove();
        if (this.restoreEditor) window.setTimeout(() => view.focus(), 0);
      });
    }

    private values(): Record<string, string> {
      return { target: this.targetInput.value, text: this.textInput.value };
    }

    private commit(): void {
      const values = this.values();
      const text = preserveLinkControlText(values.text, this.initialControlText, initial.text);
      if (text === null) { declinedLinkEdit(view); this.flashInvalid(); return; }
      values.text = text;
      const effectiveMode = !this.modeExplicitlyChosen
        && looksLikeWebDestination(values.target ?? "")
        ? "web"
        : this.mode;
      if (!canMutate() || !applyLinkEditorValues(view, context, effectiveMode, values)) {
        this.flashInvalid();
        return;
      }
      this.menu.hide();
    }

    private async createAndCommit(): Promise<void> {
      const target = this.targetInput.value.trim();
      if (!isRepresentableWikilinkTarget(target)) {
        this.flashInvalid();
        return;
      }
      try {
        if (!canMutate()) { this.flashInvalid(); return; }
        if (!await createNoteIfMissing(app, target, sourcePath)) {
          this.flashInvalid();
          return;
        }
        this.commit();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    }

    private renderSuggestions(): void {
      this.suggestionsEl.empty();
      this.suggestionButtons = [];
      if (this.mode !== "note") {
        this.hideSuggestions();
        return;
      }
      const files = mobileNoteSuggestions(app, this.targetInput.value);
      if (files.length === 0) {
        this.hideSuggestions();
        return;
      }
      for (const file of files) {
        const button = this.suggestionsEl.createEl("button", {
          cls: "butter-mobile-link-suggestion suggestion-item mod-complex",
          attr: { type: "button", role: "option" },
        });
        const icon = button.createSpan({
          cls: "butter-mobile-link-suggestion-icon suggestion-icon",
        });
        setIcon(icon, "file-text");
        const labels = button.createSpan({
          cls: "butter-mobile-link-suggestion-labels suggestion-content",
        });
        labels.createSpan({
          cls: "butter-mobile-link-suggestion-title suggestion-title",
          text: file.basename,
        });
        const folder = file.parent?.path && file.parent.path !== "/"
          ? file.parent.path
          : "";
        if (folder) {
          labels.createSpan({
            cls: "butter-mobile-link-suggestion-path suggestion-note",
            text: folder,
          });
        }
        button.addEventListener("click", () => {
          this.targetInput.value = file.basename;
          this.hideSuggestions();
          this.refreshCreateNote();
          this.targetInput.focus();
        });
        button.addEventListener("keydown", (event) => {
          const index = this.suggestionButtons.indexOf(button);
          if (event.key === "ArrowDown") {
            event.preventDefault();
            this.suggestionButtons[Math.min(index + 1, this.suggestionButtons.length - 1)]
              ?.focus();
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (index <= 0) this.targetInput.focus();
            else this.suggestionButtons[index - 1]?.focus();
          } else if (event.key === "Escape") {
            event.preventDefault();
            this.hideSuggestions();
            this.targetInput.focus();
          }
        });
        this.suggestionButtons.push(button);
      }
      this.suggestionsEl.removeClass("butter-hidden");
    }

    private hideSuggestions(): void {
      this.suggestionsEl?.addClass("butter-hidden");
      this.suggestionButtons = [];
    }

    private refreshCreateNote(): void {
      const target = this.targetInput.value.trim();
      const visible = this.mode === "note"
        && isRepresentableWikilinkTarget(target)
        && !noteTargetExists(app, target, sourcePath);
      this.createNoteButton.toggleClass("butter-hidden", !visible);
    }

    private flashInvalid(): void {
      for (const input of [this.targetInput, this.textInput]) {
        input.addClass("butter-mobile-edit-input-error");
        window.setTimeout(
          () => input.removeClass("butter-mobile-edit-input-error"),
          400,
        );
      }
    }

  })();
  drawer.open();
}

/** Open Butter's shared non-modal editor for new and existing links. */
export function openUnifiedLinkEditor(options: OpenLinkEditorOptions): void {
  const { app, view, anchor } = options;
  const context = options.context ?? contextFromSelection(view);
  const initial = initialValues(view, context);
  const canMutate = captureLinkEditorMutation(view, context);
  let mode = initial.mode;
  const sourcePath = options.sourcePath ?? "";
  const editing = initial.editing;
  let modeExplicitlyChosen = false;
  let initialControlText = initial.text;

  if (Platform.isMobile || activeDocument.body.classList.contains("is-mobile")) {
    openMobileLinkEditor(options, context);
    return;
  }

  const commit = (values: Record<string, string>): boolean => {
    const text = preserveLinkControlText(values.text ?? "", initialControlText, initial.text);
    if (text === null) return declinedLinkEdit(view);
    const effectiveMode = !modeExplicitlyChosen
      && looksLikeWebDestination(values.target ?? "")
      ? "web"
      : mode;
    const applied = canMutate() && applyLinkEditorValues(view, context, effectiveMode, { ...values, text });
    if (applied) view.focus();
    return applied;
  };

  openRichContextMenu({
    app,
    anchor,
    event: options.event,
    className: "butter-link-editor",
    autoFocusFirstField: options.autoFocus ?? !editing,
    chrome: {
      icon: "link",
      title: txKnown(editing ? "Edit link" : "Add link"),
      sub: txKnown("Link to a note or the web"),
    },
    modeSwitch: {
      value: mode,
      options: [
        { value: "note", label: "Note", icon: "file-text" },
        { value: "web", label: "Web", icon: "globe" },
      ],
      onChange: (value, inputs, source) => {
        if (source === "user") modeExplicitlyChosen = true;
        mode = value === "web" ? "web" : "note";
        const target = inputs.target;
        if (target) {
          target.placeholder = mode === "note" ? txKnown("Search notes…") : "https://...";
          if (source === "user") {
            target.focus();
            target.select();
          }
          if (mode === "note") target.dispatchEvent(new Event("input", { bubbles: true }));
        }
      },
      inferValue: (values) =>
        !modeExplicitlyChosen && looksLikeWebDestination(values.target ?? "")
          ? "web"
          : null,
    },
    fields: [
      {
        id: "target",
        label: txKnown("Destination"),
        icon: "link-2",
        initial: initial.target,
        placeholder: initial.mode === "note" ? txKnown("Search notes…") : "https://...",
        autocomplete: "vault-files",
        suggestOnEmpty: true,
        suggestSkipWhen: () => mode === "web",
      },
      {
        id: "text",
        label: tx("Display text"),
        icon: "type",
        initial: initial.text,
        multiline: /[\r\n]/.test(initial.text),
        placeholder: tx("Optional"),
      },
    ],
    actions: [
      {
        label: txKnown(editing ? "Save" : "Insert"),
        icon: "check",
        onClick: commit,
      },
      {
        label: txKnown("Open"),
        icon: "arrow-up-right",
        modes: ["note"],
        onClick: (values) => {
          if (!commit(values)) return false;
          return openNoteDestination(app, values.target ?? "", sourcePath);
        },
      },
      {
        label: txKnown("Open in Obsidian"),
        icon: "app-window",
        modes: ["web"],
        visibleWhen: () => isObsidianWebViewerEnabled(app),
        onClick: (values) => {
          if (!commit(values)) return false;
          return openInObsidianWebViewer(app, values.target ?? "");
        },
      },
      {
        label: txKnown("Open in default browser"),
        icon: "external-link",
        modes: ["web"],
        onClick: (values) => {
          if (!commit(values)) return false;
          return openExternalDestination(values.target ?? "");
        },
      },
      {
        label: txKnown("Copy destination"),
        icon: "copy",
        onClick: (values) => {
          const target = mode === "web"
            ? normalizeWebDestination(values.target ?? "")
            : (values.target ?? "").trim();
          if (!target) return false;
          void navigator.clipboard.writeText(target);
          return true;
        },
      },
      {
        label: txKnown("Create note and insert"),
        icon: "file-plus-2",
        modes: ["note"],
        visibleWhen: (values) => {
          const target = (values.target ?? "").trim();
          return isRepresentableWikilinkTarget(target)
            && !noteTargetExists(app, target, sourcePath);
        },
        onClick: async (values) => {
          const target = (values.target ?? "").trim();
          if (!isRepresentableWikilinkTarget(target)) return false;
          try {
            if (!canMutate()) return false;
            if (!await createNoteIfMissing(app, target, sourcePath)) return false;
            return commit(values);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
            return false;
          }
        },
      },
      ...(editing
        ? [{
          label: txKnown("Remove link"),
          icon: "unlink",
          warning: true,
          separatorBefore: true,
          receivesValues: false,
          onClick: () => {
            const removed = canMutate() && removeLinkEditorOccurrence(view, context);
            if (removed) view.focus();
            return removed;
          },
        }]
        : []),
    ],
    onCommit: commit,
    onFieldsReady: values => { initialControlText = values.text ?? ""; },
    onCancel: () => view.focus(),
  });
}

/** Ctrl/Cmd+K opens the same editor and edits the current link when applicable. */
export function linkEditorKeyboardPlugin(
  app: App,
  getSourcePath: () => string,
): Plugin<void> {
  return new Plugin<void>({
    props: {
      handleKeyDown(view, event) {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
        if (event.key.toLowerCase() !== "k") return false;
        event.preventDefault();
        const coords = view.coordsAtPos(view.state.selection.head);
        openUnifiedLinkEditor({
          app,
          view,
          anchor: view.dom,
          sourcePath: getSourcePath(),
          event: { clientX: coords.left, clientY: coords.bottom } as MouseEvent,
          autoFocus: true,
        });
        return true;
      },
    },
  });
}

export function externalContextAtPoint(
  view: EditorView,
  clientX: number,
  clientY: number,
): LinkEditorContext | null {
  const pos = view.posAtCoords({ left: clientX, top: clientY })?.pos;
  if (pos == null) return null;
  const range = findLinkMarkRange(view, pos);
  return range ? { kind: "external", from: range.from } : null;
}

export function wikilinkContext(pos: number): LinkEditorContext {
  return { kind: "wikilink", pos };
}
