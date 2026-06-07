/**
 * Inline-atom edit UI.
 *
 * Right-click an inline atom (wikilink, tag, embed, inline math,
 * footnote ref, inline footnote) to open a native Obsidian Menu
 * with an "Edit source" item. Selecting it opens a small floating
 * edit panel near the atom with:
 *   - A type label ("Wikilink", "Tag", …)
 *   - An input prefilled with the atom's raw markdown source
 *   - Save / Cancel buttons (Lucide icons)
 *
 * Enter commits the edit (replaces the atom via a PM transaction
 * after parsing the new source through a per-type regex). Esc
 * cancels without modification. Clicks outside the panel also
 * cancel. If the input doesn't match the expected source pattern
 * for the atom type, save does nothing (silent reject; keeps panel
 * open with a red-flash so user can fix).
 *
 * Why right-click vs. double-click: single-click on wikilinks and
 * tags has real nav semantics (open link, jump to tag search);
 * introducing a debounce to support double-click-to-edit would make
 * the click feel laggy. Right-click context menu has no collision
 * with nav and maps to the user's mental model ("right-click for
 * options on this thing").
 *
 * Styling: panel reuses the .butter-table-toolbar CSS chrome (same
 * border, shadow, rounded corners, button sizing) for a consistent
 * floating-toolbar language across the editor.
 */

import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { App, Platform } from "obsidian";
import { SPECS, type AtomSpec, type AtomField } from "./inline-atom-specs";
import { openRichContextMenu } from "../ui/link-context-menu";
import {
  openMobileAtomDrawer,
  type MobileSheetAction,
} from "./mobile-atom-sheet";

import { sanitizeHref } from "../util/safe-url";

/** Class selector matching every editable atom's root DOM. Used by
 *  the DOM-event handler to quickly reject clicks outside editable
 *  regions. */
const ATOM_DOM_SELECTOR = [
  ".butter-wikilink",
  ".butter-tag",
  ".butter-obsidian-embed",
  // Inline math NodeView (nodeviews.ts) uses `butter-inline-math-view`,
  // NOT the `butter-inline-math` class the schema's toDOM emits — the
  // NodeView wins. Match the NodeView class so right-click selects
  // the math node.
  ".butter-inline-math-view",
  // Both `footnote_ref` and `inline_footnote` NodeViews render with
  // `butter-footnote-ref`; the contextmenu handler reads the actual
  // node type from doc.nodeAt(pos) and picks the right SPEC.
  ".butter-footnote-ref",
].join(", ");

/** Convert a MouseEvent or TouchEvent into the `{clientX, clientY}`
 *  shape the rich-context-menu's positioner expects. For a touch
 *  event we use the first changed touch (the most-recent touch that
 *  triggered the event, which is the tap point for touchend). When
 *  there is no touch list (synthetic events), fall back to the
 *  original event so the menu can ignore it and anchor off the
 *  element's bounding box. */
function normalizeEventForMenu(
  event: MouseEvent | TouchEvent,
): MouseEvent | undefined {
  if (event instanceof MouseEvent) return event;
  const touch =
    (event).changedTouches?.[0] ??
    (event).touches?.[0];
  if (!touch) return undefined;
  // The menu only reads clientX/clientY, so a plain object works.
  return { clientX: touch.clientX, clientY: touch.clientY } as MouseEvent;
}


// ─── UI construction ─────────────────────────────────────────────

/** Trim a header sub-text to a sensible width. The block-context-menu
 *  CSS already ellipsizes overflow, but we cap at 40 chars first so
 *  long URLs / TeX strings don't push the layout into the ellipsis
 *  before the visually-meaningful portion is shown. */
function truncateForHeader(s: string, max = 40): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

/** Header sub-text for the right-click menu on an inline atom - a
 *  short identifier the user can recognize at a glance (target name
 *  for a wikilink, `#tag` for a tag, etc.). Falls back to the atom's
 *  serialized source when the spec doesn't have a more concise form. */
function atomHeaderSub(node: PMNode, spec: AtomSpec): string {
  switch (node.type.name) {
    case "wikilink": {
      const target = (node.attrs.target as string) || "";
      const alias = (node.attrs.alias as string) || "";
      return alias ? `${target} · "${alias}"` : target;
    }
    case "obsidian_tag":
      return `#${node.attrs.tag as string}`;
    case "obsidian_embed":
    case "obsidian_embed_inline":
      return (node.attrs.target as string) || "";
    case "footnote_ref":
      return `^${node.attrs.label as string}`;
    case "inline_math":
      return truncateForHeader(spec.toSource(node));
    case "inline_footnote":
      return truncateForHeader(node.textContent || spec.toSource(node));
    default:
      return truncateForHeader(spec.toSource(node));
  }
}

/** Right-click on a wikilink → unified rich popover. Header (link
 *  icon + "Wikilink" + target preview) + inline Note / Name inputs
 *  (mirrors the spec.fields the floating edit panel used to surface)
 *  + the nav action rows that used to sit in the Obsidian Menu. No
 *  separate "Edit wikilink" submenu - editing is the menu now. */
function openWikilinkContextMenu(
  app: App,
  editorView: EditorView,
  pos: number,
  node: PMNode,
  event: MouseEvent | TouchEvent,
  anchor: HTMLElement,
  primaryAction?: { label: string; icon: string; onClick: (values: Record<string, string>) => void },
): void {
  const spec = SPECS.wikilink;
  if (!spec || !spec.fields || !spec.toFields || !spec.fromFields) return;
  const initial = spec.toFields(node);
  const target = (node.attrs.target as string) || "";
  const alias = (node.attrs.alias as string) || "";
  const subText = alias ? `${target} · "${alias}"` : target;
  // Touch events pass a TouchList, not direct clientX/Y. The menu's
  // positioning helper only reads clientX/Y; pass a normalized
  // MouseEvent-shaped object derived from the first touch (or
  // omit and let the menu fall back to the anchor bounding box).
  const positioningEvent = normalizeEventForMenu(event);

  // Each commit re-resolves the node by position so a stale reference
  // (after another tr) doesn't blow up. Returns true if the doc was
  // mutated, so we can avoid spurious dispatches.
  const commit = (values: Record<string, string>): boolean => {
    if (
      values.target === initial.target &&
      values.alias === initial.alias
    ) {
      return false;
    }
    const next = spec.fromFields!(values, editorView.state.schema);
    if (!next) return false;
    const live = editorView.state.doc.nodeAt(pos);
    if (!live || live.type.name !== "wikilink") return false;
    const tr = editorView.state.tr.replaceWith(pos, pos + live.nodeSize, next);
    editorView.dispatch(tr);
    return true;
  };

  // Nav actions reuse the LIVE input target - that way "Open in new
  // tab" with a freshly-edited target name lands at the user's
  // intended target, not the original.
  const openIn = (values: Record<string, string>, where: "tab" | "window" | "split") => {
    commit(values);
    editorView.focus();
    const t = (values.target || target).trim();
    if (!t) return;
    void app.workspace.openLinkText(t, "", where);
  };

  openRichContextMenu({
    app,
    anchor,
    event: positioningEvent,
    autoFocusFirstField: false,
    chrome: {
      icon: "link",
      title: "Wikilink",
      sub: subText,
    },
    fields: spec.fields.map((f: AtomField) => ({
      id: f.name,
      label: f.label,
      icon: f.icon,
      initial: initial[f.name] || "",
      placeholder:
        typeof f.placeholder === "function"
          ? f.placeholder(initial)
          : f.placeholder,
      autocomplete: f.autocomplete,
    })),
    actions: [
      ...(primaryAction ? [primaryAction] : []),
      {
        label: "Open in new tab",
        icon: "file-plus",
        onClick: (v) => openIn(v, "tab"),
      },
      {
        label: "Open in new window",
        icon: "monitor",
        onClick: (v) => openIn(v, "window"),
      },
      {
        label: "Open to the right",
        icon: "separator-vertical",
        onClick: (v) => openIn(v, "split"),
      },
      {
        label: "Clear link",
        icon: "eraser",
        warning: true,
        separatorBefore: true,
        receivesValues: false,
        onClick: () => {
          const live = editorView.state.doc.nodeAt(pos);
          if (!live || live.type.name !== "wikilink") return;
          const text =
            (live.attrs.alias as string) ||
            (live.attrs.target as string) ||
            "";
          if (!text) return;
          const tr = editorView.state.tr.replaceWith(
            pos,
            pos + live.nodeSize,
            editorView.state.schema.text(text),
          );
          editorView.dispatch(tr);
          editorView.focus();
        },
      },
    ],
    onCommit: (values) => {
      commit(values);
      editorView.focus();
    },
  });
}

/** Generic right-click rich-context menu for any inline atom whose
 *  spec advertises `fields` + `toFields` + `fromFields`. Used by tag,
 *  embed (block + inline), inline math, footnote ref, and inline
 *  footnote — every atom that doesn't need bespoke nav actions
 *  (wikilink has its own opener with Open-in-tab / Clear-link).
 *
 *  Same chrome + cursor-anchored positioning + Enter-to-commit /
 *  Esc-to-cancel / outside-click-dismiss as the wikilink menu, so
 *  all six inline atoms share one UX shape. */
function openGenericAtomContextMenu(
  app: App,
  editorView: EditorView,
  pos: number,
  node: PMNode,
  spec: AtomSpec,
  event: MouseEvent | TouchEvent,
  anchor: HTMLElement,
  primaryAction?: { label: string; icon: string; onClick: (values: Record<string, string>) => void },
): void {
  if (!spec.fields || !spec.toFields || !spec.fromFields) return;
  const initial = spec.toFields(node);
  const positioningEvent = normalizeEventForMenu(event);

  const commit = (values: Record<string, string>): boolean => {
    // Cheap unchanged-skip so we don't dispatch a no-op tr.
    let changed = false;
    for (const k of Object.keys(values)) {
      if ((initial[k] ?? "") !== values[k]) { changed = true; break; }
    }
    if (!changed) return false;
    const next = spec.fromFields!(values, editorView.state.schema);
    if (!next) return false;
    const live = editorView.state.doc.nodeAt(pos);
    if (!live || live.type.name !== spec.typeName) return false;
    const tr = editorView.state.tr.replaceWith(pos, pos + live.nodeSize, next);
    editorView.dispatch(tr);
    return true;
  };

  openRichContextMenu({
    app,
    anchor,
    event: positioningEvent,
    autoFocusFirstField: false,
    chrome: {
      icon: ATOM_ICONS[spec.typeName] || "type",
      title: spec.label,
      sub: atomHeaderSub(node, spec),
    },
    fields: spec.fields.map((f: AtomField) => ({
      id: f.name,
      label: f.label,
      icon: f.icon,
      initial: initial[f.name] ?? "",
      placeholder:
        typeof f.placeholder === "function"
          ? f.placeholder(initial)
          : f.placeholder,
      autocomplete: f.autocomplete,
    })),
    actions: primaryAction ? [primaryAction] : [],
    onCommit: (values) => {
      commit(values);
      editorView.focus();
    },
  });
}

/** Per-atom-type icon for the input row. Nice-to-have visual cue
 *  matching the toolbar link popover's icon-driven chrome. Wikilinks
 *  use Lucide `link` to match the toolbar's primary Link button so
 *  the menu chrome and the toolbar speak the same visual language. */
const ATOM_ICONS: Record<string, string> = {
  wikilink: "link",
  obsidian_tag: "hash",
  obsidian_embed: "image",
  obsidian_embed_inline: "image",
  inline_math: "sigma",
  footnote_ref: "asterisk",
  inline_footnote: "asterisk",
};

// ─── External link (link mark) helpers ───────────────────────────

/** Find the contiguous range in the click's parent textblock that
 *  carries the same link-mark instance. Used by the external-link
 *  context menu so Edit / Clear operate on the entire link, not the
 *  one character under the cursor.
 *
 *  Walks the parent's children directly - character-by-character
 *  position walks are unreliable at text-node boundaries because
 *  PM's `ResolvedPos.marks()` returns different sets depending on
 *  whether you ask "marks active at this boundary" vs "marks of the
 *  next character", which differ at the start/end of a marked run
 *  and would leave one character behind on Clear. */
function findLinkMarkRange(
  view: EditorView,
  pos: number,
): { from: number; to: number; href: string; text: string } | null {
  const linkType = view.state.schema.marks.link;
  if (!linkType) return null;
  const doc = view.state.doc;
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;

  const parent = $pos.parent;
  const parentStart = $pos.start();
  const offset = $pos.parentOffset;

  // Find the child whose range contains `offset`. Children are text
  // / inline nodes; PM merges adjacent text nodes that share the
  // same mark set, so a normal link is one text node. Boundary clicks
  // (offset exactly on a child edge) prefer the child whose mark set
  // has the link.
  let foundIdx = -1;
  let acc = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const start = acc;
    const end = start + child.nodeSize;
    const inside = offset > start && offset < end;
    const onBoundary = offset === start || offset === end;
    if (
      (inside || onBoundary) &&
      child.marks.some((m) => m.type === linkType)
    ) {
      foundIdx = i;
      // Prefer non-boundary match if we already have one - but
      // since we break on first hit, the iteration order resolves
      // ambiguity by preferring the earlier child on a shared edge.
      if (inside) break;
    }
    acc = end;
  }
  if (foundIdx < 0) return null;

  const mark = parent
    .child(foundIdx)
    .marks.find((m) => m.type === linkType)!;

  // Extend left + right through neighbor children that carry the
  // same mark instance. Defensive - PM normally merges these.
  let startIdx = foundIdx;
  let endIdx = foundIdx;
  while (
    startIdx > 0 &&
    parent
      .child(startIdx - 1)
      .marks.some((m) => m.type === linkType && m.eq(mark))
  ) {
    startIdx -= 1;
  }
  while (
    endIdx < parent.childCount - 1 &&
    parent
      .child(endIdx + 1)
      .marks.some((m) => m.type === linkType && m.eq(mark))
  ) {
    endIdx += 1;
  }

  // Compute the doc-absolute from/to from accumulated child sizes.
  let from = parentStart;
  let to = parentStart;
  let cur = 0;
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (i === startIdx) from = parentStart + cur;
    if (i === endIdx) to = parentStart + cur + c.nodeSize;
    cur += c.nodeSize;
  }

  return {
    from,
    to,
    href: (mark.attrs as { href?: string }).href ?? "",
    text: doc.textBetween(from, to),
  };
}


function showExternalLinkMenu(
  app: App,
  view: EditorView,
  event: MouseEvent,
  anchor: HTMLAnchorElement,
): void {
  const linkType = view.state.schema.marks.link;
  if (!linkType) return;
  const posInfo = view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });
  if (!posInfo) return;
  const range = findLinkMarkRange(view, posInfo.pos);
  if (!range) return;

  // Commit the URL + Display-text edits as a single tr - replaces the
  // marked range with new text + new mark when changed, no-ops when
  // unchanged. Re-resolves the range against the live doc each call
  // so a stale capture doesn't blow up.
  const commit = (values: Record<string, string>): boolean => {
    const newUrl = (values.url || "").trim();
    if (!newUrl) return false;
    const newText = values.text || newUrl;
    if (newUrl === range.href && newText === range.text) return false;
    const fresh = findLinkMarkRange(view, range.from);
    if (!fresh) return false;
    const replacement = view.state.schema.text(newText, [
      linkType.create({ href: newUrl }),
    ]);
    view.dispatch(view.state.tr.replaceWith(fresh.from, fresh.to, replacement));
    return true;
  };

  openRichContextMenu({
    app,
    anchor,
    event,
    autoFocusFirstField: false,
    chrome: {
      icon: "link",
      title: "External link",
      sub: truncateForHeader(range.href),
    },
    fields: [
      {
        id: "url",
        label: "URL",
        icon: "globe",
        initial: range.href,
        placeholder: "https://…",
      },
      {
        id: "text",
        label: "Display text",
        icon: "type",
        initial: range.text,
        placeholder: range.href || "Display text",
      },
    ],
    actions: [
      {
        label: "Open in default browser",
        icon: "external-link",
        onClick: (v) => {
          commit(v);
          const raw = (v.url || range.href).trim();
          if (!raw) return;
          const safe = sanitizeHref(raw);
          if (safe === "#") return;
          const win = window as unknown as { open: typeof window.open };
          win.open(safe, "_blank");
        },
      },
      {
        label: "Copy URL",
        icon: "copy",
        onClick: (v) => {
          const url = (v.url || range.href).trim();
          if (!url) return;
          void navigator.clipboard.writeText(url).catch(() => {
            /* clipboard may be unavailable; silently no-op */
          });
        },
      },
      {
        label: "Clear link",
        icon: "eraser",
        warning: true,
        separatorBefore: true,
        receivesValues: false,
        onClick: () => {
          const fresh = findLinkMarkRange(view, range.from);
          if (!fresh) return;
          const tr = view.state.tr.removeMark(fresh.from, fresh.to, linkType);
          view.dispatch(tr);
          view.focus();
        },
      },
    ],
    onCommit: (values) => {
      commit(values);
      view.focus();
    },
  });
}

// ─── Plugin ──────────────────────────────────────────────────────



export function inlineAtomEditPlugin(app: App): Plugin<void> {
  return new Plugin<void>({
    view(editorView) {
      // Attach the contextmenu listener at the editor-DOM level in
      // CAPTURE phase rather than through PM's `handleDOMEvents.
      // contextmenu`. Why: each atom NodeView (wikilink, tag, embed,
      // …) uses `stopEvent: () => true` to keep PM from trying to
      // cursor-position inside the atom. That same stopEvent return
      // value also suppresses PM's plugin-level handleDOMEvents
      // dispatch for events originating inside the NodeView, which
      // means a plugin-level `handleDOMEvents.contextmenu` would
      // NEVER fire for right-clicks on atoms.
      //
      // A capture-phase DOM listener runs before any bubble-phase
      // handlers (including PM's internal dispatch) and sees every
      // contextmenu event in the editor, regardless of stopEvent.
      const onContextMenu = (event: MouseEvent) => {
        // Read-only license gate: inline-atom edit panels mutate the
        // doc, so they're disabled when PM is non-editable.
        if (!editorView.editable) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        // Mobile long-press fires `contextmenu` mid-selection. We
        // still want it to work for INLINE ATOMS and EXTERNAL LINKS
        // (those are atomic nodes / spans where the native "select a
        // word" gesture has no useful meaning anyway — the user can
        // not select character-by-character inside them). For plain
        // text targets, bail so the native long-press → text-select
        // gesture continues working unchanged. The atom/link checks
        // below already return early when `target.closest(...)`
        // misses, which IS the gate: on mobile, a contextmenu over
        // plain text falls through both checks and returns without
        // doing anything; over an atom/link, we proceed and
        // preventDefault to suppress the native selection grippers.

        // External link mark - separate detection path from the
        // atom selector since the link mark renders as a plain
        // `<a>` (not a special node type). Handles its own menu +
        // edit panel below.
        const linkAnchor = target.closest<HTMLAnchorElement>(
          ".butter-external-link",
        );
        if (linkAnchor) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          showExternalLinkMenu(app, editorView, event, linkAnchor);
          return;
        }

        const atomDOM = target.closest(ATOM_DOM_SELECTOR);
        if (!atomDOM) return;

        const posInfo = editorView.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (!posInfo) return;
        // Atoms have nodeSize 1, so doc.nodeAt(pos) returns the atom
        // when pos is at the atom's start. posAtCoords sometimes
        // returns JUST BEFORE or JUST AFTER the atom - check both
        // neighbors.
        let pos = posInfo.pos;
        let node = editorView.state.doc.nodeAt(pos);
        if (!node || !(node.type.name in SPECS)) {
          const before = pos > 0 ? editorView.state.doc.nodeAt(pos - 1) : null;
          const after = editorView.state.doc.nodeAt(pos + 1);
          if (before && before.type.name in SPECS) {
            pos = pos - 1;
            node = before;
          } else if (after && after.type.name in SPECS) {
            pos = pos + 1;
            node = after;
          }
        }
        if (!node || !(node.type.name in SPECS)) return;

        const spec = SPECS[node.type.name];
        // Block the default browser menu + any other PM plugin's
        // contextmenu handler (the core formatting menu) - we're
        // handling this click.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const capturedNode = node;
        const capturedPos = pos;
        const capturedAtomDOM = atomDOM;

        // Wikilinks keep their custom function — they carry extra
        // nav actions (Open in tab / window / split, Clear link)
        // that the generic atom menu doesn't have a place for.
        if (capturedNode.type.name === "wikilink") {
          openWikilinkContextMenu(
            app,
            editorView,
            capturedPos,
            capturedNode,
            event,
            capturedAtomDOM as HTMLElement,
          );
          return;
        }

        // Every other inline atom uses the unified rich-context-menu
        // (same chrome + header + inline inputs as wikilink). Each
        // spec advertises its own `fields` / `toFields` / `fromFields`,
        // so the menu shape is purely data-driven — no per-atom
        // branching here.
        openGenericAtomContextMenu(
          app,
          editorView,
          capturedPos,
          capturedNode,
          spec,
          event,
          capturedAtomDOM as HTMLElement,
        );
      };

      editorView.dom.addEventListener("contextmenu", onContextMenu, true);

      // ── Mobile tap → native drawer + edit modal ───────────────
      //
      // Mobile uses Obsidian's native `Menu` (auto-renders as a
      // bottom slide-up drawer) for nav + edit-affordance actions,
      // then opens a native `Modal` (full-width sheet on mobile)
      // when the user picks "Edit…". This matches every other
      // mobile pattern in Obsidian (file long-press → drawer →
      // "Rename" → modal) so editor surfaces speak the same
      // muscle-memory language as the rest of the app.
      //
      // Why click instead of touchstart/touchend: browsers fire a
      // synthetic `click` after a touch sequence that meets tap
      // thresholds (no significant movement, no long-press). Using
      // click means we get the platform's tap detection for free
      // — no double-firing on mouse-like devices, no accidental
      // fire during scroll, no conflict with drag.
      const buildMobileActions = (node: PMNode): MobileSheetAction[] => {
        const actions: MobileSheetAction[] = [];
        if (node.type.name === "wikilink") {
          const target = (node.attrs.target as string) || "";
          if (target) {
            actions.push({
              label: "Open",
              icon: "arrow-up-right",
              onClick: () => void app.workspace.openLinkText(target, "", false),
            });
            actions.push({
              label: "Open in new tab",
              icon: "file-plus",
              onClick: () => void app.workspace.openLinkText(target, "", "tab"),
            });
            actions.push({
              label: "Open to the right",
              icon: "separator-vertical",
              onClick: () => void app.workspace.openLinkText(target, "", "split"),
            });
          }
          actions.push({
            label: "Clear link",
            icon: "eraser",
            warning: true,
            separatorBefore: true,
            onClick: () => {
              const posAttr = node.attrs.__pos as number | undefined;
              const live = editorView.state.doc.nodeAt(posAttr ?? -1)
                ?? editorView.state.doc.nodeAt(0);
              void live;
              // Re-resolve by scanning for the node by reference —
              // matches what openWikilinkContextMenu's Clear does.
              editorView.state.doc.descendants((n, p) => {
                if (n === node) {
                  const text =
                    (n.attrs.alias as string) ||
                    (n.attrs.target as string) ||
                    "";
                  if (!text) return false;
                  const tr = editorView.state.tr.replaceWith(
                    p,
                    p + n.nodeSize,
                    editorView.state.schema.text(text),
                  );
                  editorView.dispatch(tr);
                  editorView.focus();
                  return false;
                }
                return true;
              });
            },
          });
        } else if (node.type.name === "obsidian_tag") {
          const tag = (node.attrs.tag as string) || "";
          if (tag) {
            actions.push({
              label: "Search this tag",
              icon: "search",
              onClick: () => {
                const search = app.internalPlugins?.getPluginById?.("global-search");
                const inst = search?.instance as
                  | { openGlobalSearch?: (q: string) => void }
                  | undefined;
                inst?.openGlobalSearch?.(`tag:${tag}`);
              },
            });
          }
        } else if (
          node.type.name === "obsidian_embed" ||
          node.type.name === "obsidian_embed_inline"
        ) {
          const raw = (node.attrs.src as string) || "";
          const pipe = raw.indexOf("|");
          const linkPath = pipe >= 0 ? raw.slice(0, pipe) : raw;
          if (linkPath) {
            actions.push({
              label: "Open file",
              icon: "arrow-up-right",
              onClick: () => void app.workspace.openLinkText(linkPath, "", false),
            });
            actions.push({
              label: "Open in new tab",
              icon: "file-plus",
              onClick: () => void app.workspace.openLinkText(linkPath, "", "tab"),
            });
          }
        }
        // inline_math, footnote_ref, inline_footnote have no
        // standalone nav target; the drawer just shows "Edit…".
        return actions;
      };

      const onMobileTap = (event: MouseEvent) => {
        if (!Platform.isMobile) return;
        if (!editorView.editable) return;
        const target = event.target;
        if (!(target instanceof Element)) return;

        // External link uses its own native-mobile-friendly menu
        // (existing showExternalLinkMenu also uses Obsidian Menu).
        const linkAnchor = target.closest<HTMLAnchorElement>(
          ".butter-external-link",
        );
        if (linkAnchor) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          showExternalLinkMenu(app, editorView, event, linkAnchor);
          return;
        }

        const atomDOM = target.closest(ATOM_DOM_SELECTOR);
        if (!atomDOM) return;

        const posInfo = editorView.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (!posInfo) return;
        let pos = posInfo.pos;
        let node = editorView.state.doc.nodeAt(pos);
        if (!node || !(node.type.name in SPECS)) {
          const before = pos > 0 ? editorView.state.doc.nodeAt(pos - 1) : null;
          const after = editorView.state.doc.nodeAt(pos + 1);
          if (before && before.type.name in SPECS) {
            pos = pos - 1;
            node = before;
          } else if (after && after.type.name in SPECS) {
            pos = pos + 1;
            node = after;
          }
        }
        if (!node || !(node.type.name in SPECS)) return;

        const spec = SPECS[node.type.name];
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        openMobileAtomDrawer({
          app,
          editorView,
          pos,
          node,
          spec,
          anchor: atomDOM as HTMLElement,
          chrome: {
            icon: ATOM_ICONS[spec.typeName] || "type",
            title: spec.label,
            sub: atomHeaderSub(node, spec),
          },
          actions: buildMobileActions(node),
        });
      };

      editorView.dom.addEventListener("click", onMobileTap, true);

      return {
        destroy() {
          editorView.dom.removeEventListener(
            "contextmenu",
            onContextMenu,
            true,
          );
          editorView.dom.removeEventListener("click", onMobileTap, true);
          // Belt-and-braces: yank any orphan DOM as well.
          activeDocument.querySelectorAll(".butter-inline-atom-edit").forEach((el) => {
            if (el.instanceOf(HTMLElement)) el.remove();
          });
        },
      };
    },
  });
}
