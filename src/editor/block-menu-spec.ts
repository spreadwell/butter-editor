/**
 * Block context-menu spec - single source of truth for the per-block
 * menu items that appear in BOTH the single-block context menu
 * (`openBlockContextMenu` in drag-handles.ts) and the multi-block
 * context menu (`openMultiBlockContextMenu` in multi-block-select.ts).
 *
 * Why a spec? The multi-block menu shows the INTERSECTION of items
 * that exist on every selected block - so it inherits, e.g., the
 * "Language" submenu when every selected block is a code block, the
 * "Callout type" submenu when every selected block is a callout,
 * and "Turn into" with the intersected target list across whatever
 * mix of types is selected. Building the menu from data lets us
 * intersect by item id and broadcast a click into one transaction
 * across all selected blocks.
 *
 * Items have one of three modes:
 *   • `applyTr`  - mutates a Transaction. In single-block we wrap one
 *                  call; in multi-block we batch every selected
 *                  block's call into one transaction (reverse pos
 *                  order so earlier positions stay valid). Doc edits
 *                  and selection updates use this.
 *   • `sideEffect` - runs an arbitrary side effect (clipboard write,
 *                  custom DOM event, modal open). Multi-block fires
 *                  it once per block.
 *   • `submenu`  - a list of subgroups. Multi-block intersects
 *                  subgroups by id and uses each sub-item's mode for
 *                  the broadcast.
 *
 * Items can opt out of multi-block via `singleOnly: true` - used by
 * math's "Edit source" which opens a modal targeting one block;
 * broadcasting it would open N modals at once.
 */
import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { Fragment } from "prosemirror-model";
import { App, Menu, setIcon } from "obsidian";
import {
  COMMON_LANGS,
  showLangPopover,
  isEditableLang,
  calloutIcon,
} from "./nodeviews";
import { MathEditModal } from "./math-edit-modal";
import { MobileAtomEditModal } from "./mobile-atom-sheet";
import { SPECS as ATOM_SPECS } from "./inline-atom-specs";

// ── Spec types ─────────────────────────────────────────────────

export interface BlockSubItem {
  /** Stable id used for cross-block intersection. */
  id: string;
  title: string;
  icon?: string;
  /** True when this sub-option is the current/active value FOR THIS
   *  block. Multi-block computes "checked" as `every(sub.isCurrent)`. */
  isCurrent?: boolean;
  applyTr?: (tr: Transaction, pos: number, node: PMNode) => void;
  sideEffect?: (view: EditorView, pos: number, node: PMNode) => void;
}

export interface BlockMenuItem {
  /** Stable id used for cross-block intersection. */
  id: string;
  title: string;
  icon: string;
  warning?: boolean;
  /** Hide from the multi-block menu intersection. Used for actions
   *  whose semantic doesn't broadcast cleanly (e.g. modal edit of
   *  one block's TeX source). */
  singleOnly?: boolean;
  applyTr?: (tr: Transaction, pos: number, node: PMNode) => void;
  sideEffect?: (view: EditorView, pos: number, node: PMNode) => void;
  /** Submenu groups, separated visually by a divider in the rendered
   *  menu. Mutually exclusive with `applyTr` / `sideEffect`. */
  submenu?: BlockSubItem[][];
  /** Optional CSS class to add to the submenu DOM (lets the
   *  single-block-menu CSS keep targeting the same hooks). */
  submenuClass?: string;
}

// ── Turn-into catalog ──────────────────────────────────────────
//
// Universal block-type changer. Each item targets one of Butter's
// block types; conversion logic lives in `buildConvertedNode` below.
// Headings are flattened to per-level entries so the user picks
// "Heading 2" rather than "Heading" + level prompt. Table is
// intentionally absent - the only sensible map from a paragraph to a
// 3×3 table is "drop your text and give you an empty grid", which
// surprises users.

export interface TurnIntoTarget {
  id: string;
  label: string;
  icon: string;
  level?: number;
}

export const TURN_INTO_ITEMS: TurnIntoTarget[] = [
  { id: "paragraph", label: "Paragraph", icon: "pilcrow" },
  { id: "h1", label: "Heading 1", icon: "heading-1", level: 1 },
  { id: "h2", label: "Heading 2", icon: "heading-2", level: 2 },
  { id: "h3", label: "Heading 3", icon: "heading-3", level: 3 },
  { id: "h4", label: "Heading 4", icon: "heading-4", level: 4 },
  { id: "h5", label: "Heading 5", icon: "heading-5", level: 5 },
  { id: "h6", label: "Heading 6", icon: "heading-6", level: 6 },
  { id: "bullet_list", label: "Bulleted list", icon: "list" },
  { id: "ordered_list", label: "Numbered list", icon: "list-ordered" },
  { id: "task_list", label: "Task list", icon: "list-checks" },
  { id: "blockquote", label: "Quote", icon: "quote" },
  { id: "code_block", label: "Code", icon: "file-code" },
  { id: "obsidian_callout", label: "Callout", icon: "pencil" },
  { id: "math_block", label: "Math", icon: "sigma" },
  { id: "horizontal_rule", label: "Divider", icon: "minus" },
];

const ALL_TURN_INTO_IDS = TURN_INTO_ITEMS.map((t) => t.id);

const TURN_INTO_GROUPS: string[][] = [
  ["paragraph"],
  ["h1", "h2", "h3", "h4", "h5", "h6"],
  ["bullet_list", "ordered_list", "task_list"],
  ["blockquote", "obsidian_callout", "code_block", "math_block"],
  ["horizontal_rule"],
];

// Per-source-type allowlist for Turn-into. Not every block has a
// sensible mapping into every other - converting a 3-row table into
// a single heading drops content; turning a code block into a list
// flattens semantics. Each entry below is what makes sense to surface
// in the UI; everything else is filtered out so users don't pick
// destructive nonsense by accident.
//
// `null` = "skip Turn-into entirely for this block type" (e.g. table,
// embed, raw_block - no good targets).
export function validTurnIntoTargets(node: PMNode): string[] | null {
  switch (node.type.name) {
    case "paragraph":
    case "heading":
      return ALL_TURN_INTO_IDS;
    case "list_item":
      return [
        "paragraph",
        "bullet_list",
        "ordered_list",
        "task_list",
        "blockquote",
        "obsidian_callout",
      ];
    case "blockquote":
      return ALL_TURN_INTO_IDS.filter((id) => id !== "horizontal_rule");
    case "obsidian_callout":
      return ALL_TURN_INTO_IDS.filter(
        (id) => id !== "horizontal_rule" && id !== "obsidian_callout",
      );
    case "code_block":
      return ["paragraph", "blockquote", "obsidian_callout", "math_block"];
    case "math_block":
      return ["paragraph", "code_block"];
    case "horizontal_rule":
      return ["paragraph"];
    case "table":
    case "obsidian_embed":
    case "raw_block":
      return null;
    default:
      return null;
  }
}

// Maps a current node to the matching Turn-into id so the active
// option can be marked checked and same-target conversions become
// no-ops. Returns null for shapes Turn-into doesn't surface (table,
// embed, raw_block).
export function currentTurnIntoId(node: PMNode): string | null {
  switch (node.type.name) {
    case "paragraph": return "paragraph";
    case "heading": return `h${(node.attrs.level as number) ?? 1}`;
    case "list_item": {
      const kind = (node.attrs as { kind?: unknown }).kind;
      if (kind === "ordered") return "ordered_list";
      if (kind === "task") return "task_list";
      return "bullet_list";
    }
    case "code_block": return "code_block";
    case "obsidian_callout": return "obsidian_callout";
    case "math_block": return "math_block";
    case "horizontal_rule": return "horizontal_rule";
    case "blockquote": return "blockquote";
    default: return null;
  }
}

// ── Conversion ────────────────────────────────────────────────

// Splits a paragraph's inline content at every softbreak into one
// segment per "visual line" (Shift+Enter run). Empty segments are
// dropped so e.g. a doubled softbreak doesn't produce an empty list
// item between two real ones.
function splitInlineAtSoftbreaks(
  content: Fragment,
  schema: Schema,
): Fragment[] {
  const softbreakType = schema.nodes.softbreak;
  const segments: PMNode[][] = [[]];
  content.forEach((child) => {
    if (child.type === softbreakType) {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(child);
    }
  });
  return segments
    .filter((seg) => seg.length > 0)
    .map((seg) => Fragment.fromArray(seg));
}

// Splits a paragraph into one NEW paragraph per softbreak-delimited line
// (Shift+Enter run) — the inverse of "Combine into paragraph". Inline
// marks ride along with each segment's content. Returns null when
// there's nothing to split (no softbreak, or only one non-empty line),
// which is also the eligibility test for the menu item. Fresh nodes
// carry no sourceRange, so preservation re-synthesizes them cleanly.
function paragraphSplitParts(schema: Schema, node: PMNode): PMNode[] | null {
  if (node.type.name !== "paragraph") return null;
  const segments = splitInlineAtSoftbreaks(node.content, schema);
  if (segments.length < 2) return null;
  return segments.map((seg) => schema.nodes.paragraph.create(null, seg));
}

// Inline content with marks is preserved across paragraph ↔ heading
// and into the inner paragraph of list / quote / callout wrappers;
// everything else flattens to plain `textContent`. Code stores plain
// text only; math stores TeX in the `value` attr; divider/table
// discard content. For flat-list targets the source's list-kind is
// just flipped on the same list_item - no structural rewrap needed.
//
// May return multiple replacement nodes - currently only when
// converting a paragraph that contains softbreaks into a list, in
// which case each visual line becomes its own list_item.
export function buildConvertedNode(
  schema: Schema,
  source: PMNode,
  targetId: string,
): PMNode | PMNode[] | null {
  const tgt = TURN_INTO_ITEMS.find((t) => t.id === targetId);
  // Some atom-block source types store their primary text in an attr
  // (math_block.value, block_comment.value) rather than as text
  // children. `source.textContent` returns "" for those, so without
  // this fallback "Turn into code block" on a math block produces an
  // empty code fence — content lost.
  const attrText = (() => {
    if (source.type.name === "math_block" || source.type.name === "block_comment") {
      return (source.attrs.value as string | undefined) ?? "";
    }
    return "";
  })();
  const text = attrText || source.textContent;
  const preservesInline =
    source.type.name === "paragraph" || source.type.name === "heading";
  const inline = preservesInline ? source.content : null;
  // Multi-line text sources (code_block, math_block, block_comment)
  // need their embedded newlines turned into explicit `softbreak`
  // nodes inside the synthesized textblock. A single `text("a\nb")`
  // node serializes to a paragraph that markdown-it RE-parses with
  // an explicit softbreak between "a" and "b" — structurally
  // different doc, save guard fires on the round-trip check.
  //
  // Also strip leading AND trailing whitespace from every line.
  // CommonMark "lazy paragraph continuation" eats up to 3 leading
  // spaces from each line of a paragraph on reparse; markdown-it
  // also strips trailing whitespace. Source text with indentation
  // (e.g. code blocks being converted to paragraphs) would lose
  // those bytes through the round-trip and fingerprint-diverge.
  // The conversion is lossy by nature — paragraphs can't preserve
  // code-style indentation — so normalize at synthesis time so the
  // user sees the final shape immediately and saves are stable.
  const softbreakType = schema.nodes.softbreak;
  const inlineFromText = (() => {
    if (!text) return null;
    if (!softbreakType || !text.includes("\n")) {
      const trimmed = text.replace(/^[ \t]+|[ \t]+$/g, "");
      return trimmed ? schema.text(trimmed) : null;
    }
    const lines = text.split(/\r?\n/);
    const out: PMNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) out.push(softbreakType.create());
      const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
      if (trimmed) out.push(schema.text(trimmed));
    });
    return out;
  })();

  // Heading inline content. When converting any source to a heading,
  // the source's inline (or text) cannot contain `softbreak` nodes —
  // the heading serializer collapses softbreaks to spaces, and the
  // reparsed heading therefore carries `text("a b")` instead of the
  // original `text("a"), softbreak, text("b")`. The fingerprint sees
  // a 1-char textLen drift per softbreak, save guard fires. Flatten
  // softbreaks to spaces at synthesis time so the synthesized
  // heading already matches what reparse will produce.
  const flattenForHeading = (
    content: PMNode[] | PMNode | Fragment | null,
  ): PMNode[] | null => {
    if (content == null) return null;
    const nodes: PMNode[] = [];
    const push = (n: PMNode) => nodes.push(n);
    // PMNode has `.forEach` inherited from its content Fragment —
    // it iterates the node's CHILDREN, not the node itself. For a
    // single text PMNode (which has zero children), `.forEach`
    // pushes nothing, the heading ends up empty, and the user's
    // "Turn into heading" silently drops all content. Distinguish
    // by `.type` (PMNode-only): if present, it's a single node;
    // otherwise it's a Fragment.
    if (Array.isArray(content)) content.forEach(push);
    else if ((content as PMNode).type) push(content as PMNode);
    else (content as Fragment).forEach(push);
    const out: PMNode[] = [];
    let pendingTextBuf = "";
    const flushPending = () => {
      if (pendingTextBuf) {
        out.push(schema.text(pendingTextBuf));
        pendingTextBuf = "";
      }
    };
    for (const n of nodes) {
      if (n.type.name === "softbreak" || n.type.name === "hard_break") {
        pendingTextBuf += " ";
      } else if (n.isText) {
        // Merge runs of text + softbreak-as-space into a single text
        // node so the heading has clean single-text-node inline
        // matching what markdown-it produces on reparse.
        if (n.marks.length === 0) {
          pendingTextBuf += n.text;
        } else {
          flushPending();
          out.push(n);
        }
      } else {
        flushPending();
        out.push(n);
      }
    }
    flushPending();
    // Trim leading whitespace from the FIRST node iff it's unmarked
    // text at the start of the heading content, and trailing
    // whitespace from the LAST node iff it's unmarked text at the
    // end. Source content with leading/trailing empty lines (or
    // softbreaks) would otherwise produce text nodes with leading
    // or trailing spaces, which markdown-it strips on heading
    // reparse. Crucially, we DON'T trim whitespace at mark
    // boundaries — `**bold** text` needs the space to let `**`
    // close cleanly; without it, `**bold**text` may not close the
    // bold and the literal `**` ends up in the reparsed text.
    if (out.length > 0 && out[0].isText && out[0].marks.length === 0) {
      const trimmed = out[0].text!.replace(/^[ \t]+/, "");
      out[0] = trimmed ? schema.text(trimmed) : null as unknown as PMNode;
    }
    const lastIdx = out.length - 1;
    if (
      lastIdx >= 0 &&
      out[lastIdx] &&
      out[lastIdx].isText &&
      out[lastIdx].marks.length === 0
    ) {
      const trimmed = out[lastIdx].text!.replace(/[ \t]+$/, "");
      out[lastIdx] = trimmed ? schema.text(trimmed) : null as unknown as PMNode;
    }
    const cleaned = out.filter((n) => n != null);
    return cleaned.length > 0 ? cleaned : null;
  };
  const headingInline = flattenForHeading(inline ?? inlineFromText);

  switch (targetId) {
    case "paragraph":
      return schema.nodes.paragraph.create(null, inline || inlineFromText);
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = tgt?.level ?? 1;
      return schema.nodes.heading.create({ level }, headingInline);
    }
    case "bullet_list":
    case "ordered_list":
    case "task_list": {
      const kind: "bullet" | "ordered" | "task" =
        targetId === "ordered_list"
          ? "ordered"
          : targetId === "task_list"
            ? "task"
            : "bullet";
      if (source.type.name === "list_item") {
        const checkedRaw = (source.attrs as { checked?: unknown }).checked;
        return schema.nodes.list_item.create(
          {
            ...source.attrs,
            kind,
            checked: kind === "task" ? (typeof checkedRaw === "boolean" ? checkedRaw : false) : null,
            sourceRange: null,
          },
          source.content,
        );
      }
      const liAttrs = {
        kind,
        depth: 0,
        tight: true,
        checked: kind === "task" ? false : null,
        start: null,
      };
      if (source.type.name === "paragraph") {
        const segments = splitInlineAtSoftbreaks(source.content, schema);
        if (segments.length > 1) {
          return segments.map((seg) =>
            schema.nodes.list_item.create(liAttrs, [
              schema.nodes.paragraph.create(null, seg),
            ]),
          );
        }
      }
      const para = schema.nodes.paragraph.create(null, inline || inlineFromText);
      return schema.nodes.list_item.create(liAttrs, [para]);
    }
    case "blockquote": {
      const para = schema.nodes.paragraph.create(null, inline || inlineFromText);
      return schema.nodes.blockquote.create(null, para);
    }
    case "obsidian_callout": {
      const para = schema.nodes.paragraph.create(null, inline || inlineFromText);
      return schema.nodes.obsidian_callout.create(
        { calloutType: "note" },
        para,
      );
    }
    case "code_block":
      return schema.nodes.code_block.create(
        { language: "" },
        text ? schema.text(text) : null,
      );
    case "math_block":
      return schema.nodes.math_block.create({ value: text });
    case "horizontal_rule":
      return schema.nodes.horizontal_rule.create();
    default:
      return null;
  }
}

// Mutates `tr` to convert the block at `pos` to `targetId`. Skips when
// the source already matches the target (clean no-op for "click the
// already-active option"). Used by both the single-block menu (one
// call per click) and the multi-block menu (one call per selected
// block in one batched transaction).
function applyTurnIntoTr(
  tr: Transaction,
  pos: number,
  node: PMNode,
  schema: Schema,
  targetId: string,
): void {
  if (currentTurnIntoId(node) === targetId) return;
  const replacement = buildConvertedNode(schema, node, targetId);
  if (!replacement) return;
  const arr = Array.isArray(replacement) ? replacement : [replacement];
  tr.replaceWith(pos, pos + node.nodeSize, arr);
}

// ── Utilities ──────────────────────────────────────────────────

const CALLOUT_TYPE_GROUPS: string[][] = [
  ["note", "abstract", "info", "tip"],
  ["success", "question", "example", "quote"],
  ["warning", "failure", "danger", "bug"],
];

function labelCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Spec builder ───────────────────────────────────────────────

export interface BuildSpecArgs {
  view: EditorView;
  pos: number;
  node: PMNode;
  app: App;
  /** Optional precomputed block DOM (the single-block menu has it via
   *  the BlockHit it was opened from). When omitted, we resolve via
   *  `view.nodeDOM(pos)` at click time so multi-block call sites
   *  don't have to thread DOM refs through. */
  blockDom?: HTMLElement;
}

/**
 * Builds the block-type-specific menu items for a single block. Returns
 * the list in display order. The Copy / Duplicate / Delete trio is
 * NOT included - those are universal and rendered separately by each
 * caller (with multi-aware variants in the multi-block menu).
 */
export function buildSingleBlockMenuItems(
  args: BuildSpecArgs,
): BlockMenuItem[] {
  const { view, pos, node, app, blockDom } = args;
  const schema = view.state.schema;
  const items: BlockMenuItem[] = [];

  // ── Turn into ────────────────────────────────────────────
  const turnTargets = validTurnIntoTargets(node);
  if (turnTargets && turnTargets.length > 0) {
    const targetSet = new Set(turnTargets);
    const currentTurn = currentTurnIntoId(node);
    const subGroups: BlockSubItem[][] = [];
    for (const groupIds of TURN_INTO_GROUPS) {
      const sub: BlockSubItem[] = TURN_INTO_ITEMS.filter(
        (t) => groupIds.includes(t.id) && targetSet.has(t.id),
      ).map((t) => ({
        id: t.id,
        title: t.label,
        icon: t.icon,
        isCurrent: t.id === currentTurn,
        applyTr: (tr, p, n) => applyTurnIntoTr(tr, p, n, schema, t.id),
      }));
      if (sub.length > 0) subGroups.push(sub);
    }
    items.push({
      id: "turn-into",
      title: "Turn into",
      icon: "shuffle",
      submenu: subGroups,
      submenuClass: "butter-turn-into-submenu",
    });
  }

  // ── Block-type-specific ──────────────────────────────────
  switch (node.type.name) {
    case "code_block": {
      const currentLang = (node.attrs.language as string) || "";
      const delegated = !isEditableLang(currentLang);

      // Edit source - only on delegated langs and only when the
      // widget is currently showing (mode === "view"). Toggles into
      // edit mode via a custom DOM event the NodeView listens for.
      if (delegated) {
        const dom = blockDom ?? (view.nodeDOM(pos) as HTMLElement | null);
        const mode =
          (dom?.dataset?.butterMode as "view" | "edit" | undefined) || "view";
        if (mode === "view") {
          items.push({
            id: "code-edit-source",
            title: "Edit source",
            icon: "pencil",
            sideEffect: (v, p) => {
              const d = v.nodeDOM(p) as HTMLElement | null;
              d?.dispatchEvent(new CustomEvent("butter-toggle-mode"));
            },
          });
        }
      }

      // Language ▶ submenu - common langs as a flat list + a
      // "Custom…" escape hatch that opens the full search popover.
      const langSubItems: BlockSubItem[] = [];
      langSubItems.push({
        id: "lang-custom",
        title: "Custom…",
        icon: "pencil-line",
        sideEffect: (v, p, n) => {
          const dom = v.nodeDOM(p) as HTMLElement | null;
          if (!dom) return;
          const cur = (n.attrs.language as string) || "";
          showLangPopover(dom, cur, (next) => {
            v.dispatch(
              v.state.tr.setNodeMarkup(p, undefined, {
                ...n.attrs,
                language: next,
                sourceRange: null,
              }),
            );
          });
        },
      });
      const plainItem: BlockSubItem = {
        id: "lang-plain",
        title: "plain",
        isCurrent: !currentLang,
        applyTr: (tr, p, n) => {
          tr.setNodeMarkup(p, undefined, {
            ...n.attrs,
            language: "",
            sourceRange: null,
          });
        },
      };
      const otherLangs: BlockSubItem[] = COMMON_LANGS.filter(
        (l) => l !== "plain",
      ).map((lang) => ({
        id: `lang-${lang}`,
        title: lang,
        isCurrent: currentLang.toLowerCase() === lang,
        applyTr: (tr, p, n) => {
          tr.setNodeMarkup(p, undefined, {
            ...n.attrs,
            language: lang,
            sourceRange: null,
          });
        },
      }));
      items.push({
        id: "code-language",
        title: "Language",
        icon: "braces",
        submenu: [langSubItems, [plainItem, ...otherLangs]],
        submenuClass: "butter-lang-submenu",
      });
      break;
    }

    case "math_block": {
      // Math edit opens a modal - broadcasting it across N selected
      // math blocks would open N modals at once, which is awful UX.
      // Mark single-only so the multi-block menu skips it; users can
      // still right-click ONE math block to edit.
      items.push({
        id: "math-edit-source",
        title: "Edit source",
        icon: "pencil",
        singleOnly: true,
        sideEffect: (v, p, n) => {
          const cur = (n.attrs.value as string) || "";
          new MathEditModal(app, cur, (next) => {
            v.dispatch(
              v.state.tr.setNodeMarkup(p, undefined, {
                ...n.attrs,
                value: next,
                sourceRange: null,
              }),
            );
          }).open();
        },
      });
      break;
    }

    case "obsidian_callout": {
      const currentType = (node.attrs.calloutType as string) || "note";
      const subGroups: BlockSubItem[][] = CALLOUT_TYPE_GROUPS.map((group) =>
        group.map((t) => ({
          id: `callout-${t}`,
          title: labelCase(t),
          icon: calloutIcon(t),
          isCurrent: currentType === t,
          applyTr: (tr, p, n) => {
            tr.setNodeMarkup(p, undefined, {
              ...n.attrs,
              calloutType: t,
              sourceRange: null,
            });
          },
        })),
      );
      items.push({
        id: "callout-type",
        title: "Callout type",
        icon: calloutIcon(currentType),
        submenu: subGroups,
        submenuClass: "butter-callout-type-submenu",
      });
      break;
    }

    case "list_item": {
      // Quick-access list-kind switcher - same targets as Turn into,
      // but a one-hop submenu when the user already knows they're
      // staying in a list.
      const listKinds = [
        { id: "bullet_list", label: "Bulleted list", icon: "list" },
        { id: "ordered_list", label: "Numbered list", icon: "list-ordered" },
        { id: "task_list", label: "Task list", icon: "list-checks" },
      ];
      const currentListId = currentTurnIntoId(node);
      const sub: BlockSubItem[] = listKinds.map((k) => ({
        id: k.id,
        title: k.label,
        icon: k.icon,
        isCurrent: k.id === currentListId,
        applyTr: (tr, p, n) => applyTurnIntoTr(tr, p, n, schema, k.id),
      }));
      items.push({
        id: "list-type",
        title: "List type",
        icon: "list",
        submenu: [sub],
        submenuClass: "butter-list-type-submenu",
      });
      break;
    }

    case "obsidian_embed": {
      // Open the same field-based edit modal we use for inline atoms
      // (src + width + height). The drag-handle context menu otherwise
      // had no edit affordance for embeds — only inline right-click
      // / mobile tap did. Lifts the affordance to parity with code
      // blocks' "Edit source" and math blocks' "Edit source".
      const spec = ATOM_SPECS.obsidian_embed;
      if (spec && spec.fields) {
        items.push({
          id: "embed-edit-source",
          title: "Edit source",
          icon: "pencil",
          singleOnly: true,
          sideEffect: (v, p, n) => {
            new MobileAtomEditModal({
              app,
              editorView: v,
              pos: p,
              node: n,
              spec,
              anchor: (v.nodeDOM(p) as HTMLElement) ?? v.dom,
              chrome: {
                icon: "image",
                title: "Embed",
                sub: (n.attrs.src as string) || "",
              },
              actions: [],
            }).open();
          },
        });
      }
      break;
    }

    case "paragraph": {
      // Split into paragraphs — one per soft line break (Shift+Enter).
      // The inverse of multi-block "Combine into paragraph". Only
      // offered when the paragraph actually has >=2 lines to split.
      if (paragraphSplitParts(schema, node)) {
        items.push({
          id: "split-into-paragraphs",
          title: "Split into paragraphs",
          icon: "split",
          applyTr: (tr, p, n) => {
            const parts = paragraphSplitParts(schema, n);
            if (parts) tr.replaceWith(p, p + n.nodeSize, parts);
          },
        });
      }
      break;
    }
  }

  return items;
}

// ── Chrome (header + class) ────────────────────────────────────
//
// Every Butter context menu (block, multi-block, link right-click,
// inline-atom right-click) shares the same visual chrome: 240px wide,
// custom enter/leave animation, and a non-interactive header row at
// the top with a Lucide icon + bold title + faint sub. The CSS lives
// under `.menu.butter-block-context-menu` in styles.css; this helper
// is the one place that adds the class + injects the header DOM so
// the look stays consistent as the catalog of menus grows.

export interface BlockMenuChrome {
  /** Lucide icon name for the header tile. */
  icon: string;
  /** Bold title line. */
  title: string;
  /** Optional faint subtext below the title. */
  sub?: string;
}

/** Build the header DOM (icon tile + title + optional sub) without
 *  attaching it anywhere. Used by `applyBlockContextMenuChrome` for
 *  Obsidian Menus and by hand-rolled rich popovers (see
 *  `link-context-menu.ts`) that build their own root but want the
 *  same chrome. */
export function buildBlockContextMenuHeaderEl(
  chrome: BlockMenuChrome,
): HTMLElement {
  const header = activeDocument.createElement("div");
  header.className = "butter-block-menu-header";
  const iconEl = activeDocument.createElement("div");
  iconEl.className = "butter-block-menu-header-icon";
  setIcon(iconEl, chrome.icon);
  header.appendChild(iconEl);
  const textEl = activeDocument.createElement("div");
  textEl.className = "butter-block-menu-header-text";
  const titleEl = activeDocument.createElement("div");
  titleEl.className = "butter-block-menu-header-title";
  titleEl.textContent = chrome.title;
  textEl.appendChild(titleEl);
  if (chrome.sub) {
    const subEl = activeDocument.createElement("div");
    subEl.className = "butter-block-menu-header-sub";
    subEl.textContent = chrome.sub;
    textEl.appendChild(subEl);
  }
  header.appendChild(textEl);
  return header;
}

export function applyBlockContextMenuChrome(
  menu: Menu,
  chrome: BlockMenuChrome,
): void {
  const dom = (menu as { dom?: HTMLElement }).dom;
  if (!dom) return;
  dom.classList.add("butter-block-context-menu");
  dom.insertBefore(buildBlockContextMenuHeaderEl(chrome), dom.firstChild);
}

// ── Per-node header label + icon (for the block context menus) ──
//
// Longer than the tooltip-style describeNodeType - e.g. "Heading 2"
// vs "H2". Tasks vs bullets distinguished by inspecting the list_item
// `kind` attr (flat-list schema: list "type" lives there, no
// bullet_list / ordered_list container nodes).

export function blockMenuLabel(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph": return "Paragraph";
    case "heading": return `Heading ${node.attrs.level ?? 1}`;
    case "list_item": {
      const kind = (node.attrs as { kind?: unknown }).kind;
      if (kind === "task") return "Task";
      if (kind === "ordered") return "Numbered list item";
      return "Bullet";
    }
    case "code_block": return "Code";
    case "obsidian_callout": return "Callout";
    case "math_block": return "Math";
    case "table": return "Table";
    case "horizontal_rule": return "Divider";
    case "blockquote": return "Quote";
    case "obsidian_embed": return "Embed";
    case "raw_block": return "Raw";
    default: return "Block";
  }
}

export function blockMenuHeaderIcon(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph": return "pilcrow";
    case "heading": {
      const lvl = (node.attrs.level as number) ?? 1;
      return `heading-${Math.min(Math.max(lvl, 1), 6)}`;
    }
    case "list_item": {
      const kind = (node.attrs as { kind?: unknown }).kind;
      if (kind === "task") return "list-checks";
      if (kind === "ordered") return "list-ordered";
      return "list";
    }
    case "code_block": return "file-code";
    case "obsidian_callout": return "pencil";
    case "math_block": return "sigma";
    case "table": return "table";
    case "horizontal_rule": return "minus";
    case "blockquote": return "quote";
    case "obsidian_embed": return "image";
    default: return "type";
  }
}

// ── Rendering ──────────────────────────────────────────────────

/**
 * Renders a list of `BlockMenuItem`s into an Obsidian `Menu`. Drives
 * both the single-block menu and the multi-block menu - the only
 * difference between call sites is what `runItem` does on click:
 *
 *   • Single-block: invoke once with the clicked block.
 *   • Multi-block:  invoke for every selected block, batched into one
 *                   transaction so the operation is a single undo step.
 *
 * Submenus are rendered with one separator between groups (matches the
 * old hand-built menus). A separator is also emitted after the
 * Turn-into item when more items follow, preserving the existing
 * "Turn into ▶ | per-type ▶" visual split.
 */
export function renderBlockMenuItems(
  menu: Menu,
  items: BlockMenuItem[],
  runItem: (item: BlockMenuItem | BlockSubItem) => void,
): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    menu.addItem((mi) => {
      mi.setTitle(item.title);
      mi.setIcon(item.icon);
      if (item.warning) {
        mi.setWarning?.(true);
        mi.dom?.classList.add("is-warning");
      }
      if (item.submenu) {
        const sub = mi.setSubmenu();
        sub.setUseNativeMenu(false);
        if (item.submenuClass) sub.dom?.classList.add(item.submenuClass);
        item.submenu.forEach((group, gi) => {
          if (gi > 0) sub.addSeparator();
          for (const subItem of group) {
            sub.addItem((si) => {
              si.setTitle(subItem.title);
              if (subItem.icon) si.setIcon(subItem.icon);
              if (subItem.isCurrent) si.setChecked(true);
              si.onClick(() => runItem(subItem));
            });
          }
        });
      } else {
        mi.onClick(() => runItem(item));
      }
    });
    // Visual split between Turn-into and per-type-specific items
    // mirrors the old typeSep() behavior in the hand-built menu.
    if (item.id === "turn-into" && i < items.length - 1) {
      menu.addSeparator();
    }
  }
}

// ── Merge items (multi-block only) ─────────────────────────────
//
// Merges collapse N selected blocks into ONE new block - fundamentally
// different shape from broadcast items, so they live in their own
// catalog rather than being squeezed into `BlockMenuItem`. Each item
// has an eligibility predicate (`appliesTo`) over the resolved node
// list and a `run` that mutates the doc directly. The multi-block
// menu iterates `MERGE_MENU_ITEMS`, includes any whose predicate
// passes, and renders them inline. After `run` completes the multi-
// block selection is always cleared (positions are stale post-merge),
// so the runner doesn't have to know about that state machine.

export interface MergeMenuItem {
  id: string;
  title: string;
  icon: string;
  /** Selection always has ≥2 nodes by the time this is asked. */
  appliesTo: (nodes: PMNode[]) => boolean;
  /** Mutate the doc + focus. Does NOT touch multi-block selection
   *  state - the menu shell handles that. */
  run: (view: EditorView, nodes: { pos: number; node: PMNode }[]) => void;
}

// "Combine into paragraph" eligibility: source has a primary
// inline-content carrier we can extract. Paragraphs and headings carry
// inline content directly; flat-schema list_items carry it on their
// first paragraph child. Other block types (callouts, code, math,
// tables, embeds, dividers, raw) would lose structure on inline
// flatten, so the item is hidden when any selected block isn't
// inline-like.
function isInlineCarrier(node: PMNode): boolean {
  if (node.type.name === "paragraph" || node.type.name === "heading") {
    return true;
  }
  if (node.type.name === "list_item") {
    return node.firstChild?.type.name === "paragraph";
  }
  return false;
}

// Pulls the inline Fragment that represents the block's primary
// content. Mirrors `isInlineCarrier` - caller must have already
// confirmed eligibility.
function inlineContentOf(node: PMNode): Fragment {
  if (node.type.name === "list_item") {
    return node.firstChild!.content;
  }
  return node.content;
}

// Merges N inline-bearing blocks into a single paragraph whose content
// is each source's inline Fragment, joined by softbreak nodes between
// blocks. Replaces the entire selected range in one transaction so
// undo treats the combine as atomic. Non-contiguous (Cmd+click-built)
// selections fall back to reverse-delete-then-insert at the FIRST
// source's position so the merged paragraph lands where the user's
// eye expects it.
function combineIntoParagraph(
  view: EditorView,
  nodes: { pos: number; node: PMNode }[],
): void {
  const schema = view.state.schema;
  const softbreakType = schema.nodes.softbreak;
  if (!softbreakType) return;
  const parts: PMNode[] = [];
  nodes.forEach(({ node }, i) => {
    if (i > 0) parts.push(softbreakType.create());
    inlineContentOf(node).forEach((c) => parts.push(c));
  });
  const merged = schema.nodes.paragraph.create(null, Fragment.fromArray(parts));

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const start = first.pos;
  const end = last.pos + last.node.nodeSize;
  const totalSize = nodes.reduce((s, { node }) => s + node.nodeSize, 0);
  const isContiguous = totalSize === end - start;

  const tr = view.state.tr;
  if (isContiguous) {
    tr.replaceWith(start, end, merged);
  } else {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { pos, node } = nodes[i];
      tr.delete(pos, pos + node.nodeSize);
    }
    tr.insert(first.pos, merged);
  }
  view.dispatch(tr);
  view.focus();
}

export const MERGE_MENU_ITEMS: MergeMenuItem[] = [
  {
    id: "combine-into-paragraph",
    title: "Combine into paragraph",
    icon: "merge",
    appliesTo: (nodes) => nodes.every(isInlineCarrier),
    run: combineIntoParagraph,
  },
];

// ── Multi-block intersection ───────────────────────────────────

/**
 * Intersect per-block specs into the set of items that exist across
 * EVERY selected block. Top-level items match by id; submenu groups
 * are reduced to the sub-items present in every block's submenu (also
 * by id), preserving the first block's group ordering. `isCurrent`
 * on a sub-item is true only when every block has it true (so e.g.
 * the Language menu shows a checkmark for the language only if all
 * selected code blocks share that language). `singleOnly` items are
 * dropped.
 */
export function intersectBlockMenuSpecs(
  specs: BlockMenuItem[][],
): BlockMenuItem[] {
  if (specs.length === 0) return [];
  const result: BlockMenuItem[] = [];
  const first = specs[0];

  for (const baseItem of first) {
    if (baseItem.singleOnly) continue;
    // Look up the same-id item on every other block.
    const peers: BlockMenuItem[] = [baseItem];
    let allPresent = true;
    for (let i = 1; i < specs.length; i++) {
      const match = specs[i].find((it) => it.id === baseItem.id);
      if (!match || match.singleOnly) {
        allPresent = false;
        break;
      }
      peers.push(match);
    }
    if (!allPresent) continue;

    if (baseItem.submenu) {
      // Intersect submenu groups by sub-id, group-by-group. Preserve
      // first block's group ordering. A sub-item is included only if
      // every peer has it; `isCurrent` is the AND of every peer's.
      const intersected: BlockSubItem[][] = [];
      for (const group of baseItem.submenu) {
        const subResult: BlockSubItem[] = [];
        for (const baseSub of group) {
          let allHaveSub = true;
          let everyCurrent = !!baseSub.isCurrent;
          for (let i = 1; i < peers.length; i++) {
            let peerSub: BlockSubItem | undefined;
            for (const g of peers[i].submenu || []) {
              peerSub = g.find((s) => s.id === baseSub.id);
              if (peerSub) break;
            }
            if (!peerSub) {
              allHaveSub = false;
              break;
            }
            if (!peerSub.isCurrent) everyCurrent = false;
          }
          if (allHaveSub) {
            subResult.push({ ...baseSub, isCurrent: everyCurrent });
          }
        }
        if (subResult.length > 0) intersected.push(subResult);
      }
      if (intersected.length > 0) {
        result.push({ ...baseItem, submenu: intersected });
      }
    } else {
      // Flat action item - included as long as every peer has it.
      result.push({ ...baseItem });
    }
  }

  return result;
}
