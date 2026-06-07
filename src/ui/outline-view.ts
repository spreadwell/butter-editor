/**
 * Butter Outline - a unified outline sidebar that works across every
 * view type Obsidian ships: Butter, Live Preview, Source, Reading.
 *
 * Design:
 *   • Headings come from the active editor's live state whenever
 *     possible (PM doc for Butter, MarkdownView.editor for Live
 *     Preview / Source), falling back to metadataCache for Reading
 *     mode and stale views.
 *   • Click handlers navigate IN-PLACE - no `openFile`, no
 *     `setViewState`. For Butter we dispatch a PM TextSelection,
 *     for CM6 we call `editor.setCursor` + `editor.scrollIntoView`,
 *     for Reading mode we scroll the heading's rendered DOM element
 *     into view. No view ever reloads.
 *   • Active-heading highlighting is polled off the editor's current
 *     cursor / selection every 250 ms. Cheap, and free of coupling
 *     to any CM6 or PM plugin state.
 */
import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  MarkdownView,
  setIcon,
  Editor,
} from "obsidian";
import { scrollHost, scrollHostTop } from "../util/dom-utils";
import type { Node as PMNode } from "prosemirror-model";
import { Selection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { EditorView as CMEditorView } from "@codemirror/view";

/** Duck-typed Butter view interface — what outline-view actually
 *  reads from a leaf.view to decide if it's a Butter view. Avoids
 *  importing main.ts (heavy module). */
interface ButterViewLike {
  pmViewRef?(): EditorView | null;
  file?: TFile | null;
  getViewType?(): string;
}

export const VIEW_TYPE_BUTTER_OUTLINE = "butter-outline";

type Source = "pm" | "cm6" | "reading" | "none";

interface HeadingEntry {
  level: number;
  text: string;
  /** Source-markdown line (0-based) - used for CM6 navigation and
   *  tracking, and for reading-mode DOM lookup. */
  line: number;
  /** PM position of the heading block. Null for non-Butter sources. */
  pmPos: number | null;
}

export class ButterOutlineView extends ItemView {
  private listEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private pollHandle: number | null = null;
  private lastRenderedKey = "";
  private lastActiveKey: string | null = null;
  /** Scroll position + doc reference from the previous tick. The
   *  active-heading determination is a pure function of (scroll,
   *  heading layout), so if neither changed since last tick we can
   *  skip the ~N `getBoundingClientRect` calls entirely. This turns
   *  the 60ms poll from "always expensive" to "free while typing in
   *  a paragraph" - eliminating the rhythmic stutter that otherwise
   *  shows up every poll tick on multi-thousand-line docs. */
  private lastPollKey: string | null = null;
  /** The most recent non-outline leaf that held an editor. Tracked
   *  explicitly because clicking inside the outline sidebar makes
   *  the outline itself the "active" leaf, which would otherwise
   *  cause `getActiveViewOfType(...)` to return null. */
  private lastEditorLeaf: WorkspaceLeaf | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_BUTTER_OUTLINE;
  }
  getDisplayText() {
    return "Butter outline";
  }
  getIcon() {
    return "list-tree";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("butter-outline-view");

    const header = root.createDiv({ cls: "butter-outline-header" });
    const headerIcon = header.createSpan({ cls: "butter-outline-header-icon" });
    setIcon(headerIcon, "list-tree");
    header.createSpan({ cls: "butter-outline-header-title", text: "Outline" });

    this.listEl = root.createDiv({ cls: "butter-outline-list" });
    this.emptyEl = root.createDiv({
      cls: "butter-outline-empty",
      text: "No headings in this note.",
    });
    this.emptyEl.addClass("butter-hidden");

    // Seed the editor-leaf pointer immediately so the first render
    // has a target even if the user opened the outline via ribbon.
    this.rememberActiveEditor();

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.rememberActiveEditor(leaf);
        this.render();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.rememberActiveEditor();
        this.render();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const active = this.resolveActiveFile();
        if (active && file === active) this.render();
      }),
    );
    // Debounce the editor-change re-render. Each render() walks the
    // full PM doc twice (once for heading positions, once for line
    // counts) and builds a concatenated key string from every
    // heading's metadata - a per-keystroke cost proportional to doc
    // size. On a multi-thousand-line doc that's the biggest source
    // of typing stutter. The scroll-driven updateActive continues to
    // run at 60ms for live highlight; only the full list rebuild
    // debounces.
    let editChangeHandle: number | null = null;
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (editChangeHandle != null) window.clearTimeout(editChangeHandle);
        editChangeHandle = window.setTimeout(() => {
          editChangeHandle = null;
          this.render();
        }, 300);
      }),
    );
    this.register(() => {
      if (editChangeHandle != null) {
        window.clearTimeout(editChangeHandle);
        editChangeHandle = null;
      }
    });

    // Poll at ~17 Hz (60ms) only when the outline is actually
    // visible. Each tick does N cheap DOM reads and at-most one
    // class toggle per row, well under a millisecond for typical
    // docs. When the outline pane is collapsed, offsetParent is
    // null and we skip the work entirely - zero idle cost.
    this.pollHandle = window.setInterval(() => {
      if (!this.contentEl.offsetParent) return;
      this.updateActive();
    }, 60);
    this.register(() => {
      if (this.pollHandle != null) {
        window.clearInterval(this.pollHandle);
        this.pollHandle = null;
      }
    });

    this.render();
  }

  async onClose() {
    this.listEl = null;
    this.emptyEl = null;
  }

  // ── Resolution ──

  /**
   * Update `lastEditorLeaf` when the workspace's active leaf changes
   * to something that's actually an editor (Butter or MarkdownView).
   * Clicks inside the outline sidebar itself are ignored so the
   * outline keeps pointing at the real editor.
   */
  private rememberActiveEditor(leaf?: WorkspaceLeaf | null) {
    const candidate = leaf ?? this.app.workspace.getMostRecentLeaf();
    if (!candidate) return;
    const type = candidate.view.getViewType();
    if (type === VIEW_TYPE_BUTTER_OUTLINE) return;
    const view = candidate.view as ButterViewLike;
    const isEditor =
      type === "markdown" ||
      typeof view.pmViewRef === "function"; // duck-type Butter
    if (isEditor) {
      this.lastEditorLeaf = candidate;
    }
  }

  private resolveActiveFile(): TFile | null {
    return this.resolveContext().file;
  }

  /**
   * Find the active reading-mode preview element. Scopes the lookup
   * to `contentEl` so we don't latch onto an embedded preview or a
   * backlinks/graph panel, and prefers the newer `.markdown-reading-
   * view` class that wraps the whole pane.
   */
  private readingPreviewEl(mdView: MarkdownView): HTMLElement | null {
    const ce = mdView.contentEl;
    return (
      ce.querySelector<HTMLElement>(".markdown-reading-view") ??
      ce.querySelector<HTMLElement>(".markdown-preview-view") ??
      mdView.previewMode?.containerEl ??
      null
    );
  }

  /**
   * Find the DOM element for a heading in reading mode, matched by
   * level and rendered text. Text-matching is more robust than
   * index-matching because the metadataCache's heading list can
   * diverge from the rendered DOM (embedded headings, mod-headers
   * added by Obsidian itself, hidden via CSS, etc.).
   */
  private findReadingHeading(
    previewEl: HTMLElement,
    text: string,
    level: number,
  ): HTMLElement | null {
    const needle = text.trim();
    const byLevel = Array.from(
      previewEl.querySelectorAll<HTMLElement>(`h${level}`),
    );
    for (const el of byLevel) {
      if ((el.textContent ?? "").trim() === needle) return el;
    }
    // Fallback: any level with matching text (handles rare cases
    // where Obsidian rewrites heading levels in rendered output).
    const any = Array.from(
      previewEl.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
    );
    for (const el of any) {
      if ((el.textContent ?? "").trim() === needle) return el;
    }
    return null;
  }

  private resolveContext(): {
    source: Source;
    file: TFile | null;
    pmView: EditorView | null;
    mdView: MarkdownView | null;
  } {
    // Prefer the remembered editor leaf (survives clicks on the
    // outline). Fall back to the workspace's active leaf if we
    // haven't seen one yet, for the very first render.
    const leaf = this.lastEditorLeaf ?? this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view;
    const butterView = view as ButterViewLike | undefined;

    if (butterView && typeof butterView.pmViewRef === "function") {
      const pm = butterView.pmViewRef();
      const file = butterView.file ?? null;
      if (file && pm) return { source: "pm", file, pmView: pm, mdView: null };
    }

    if (view instanceof MarkdownView && view.file) {
      const mode = view.getMode?.() ?? "source";
      return {
        source: mode === "preview" ? "reading" : "cm6",
        file: view.file,
        pmView: null,
        mdView: view,
      };
    }

    return { source: "none", file: null, pmView: null, mdView: null };
  }

  // ── Heading collection ──

  private collectHeadings(): { source: Source; file: TFile | null; headings: HeadingEntry[] } {
    const { source, file, pmView } = this.resolveContext();
    if (source === "pm" && pmView) {
      return { source, file, headings: this.collectFromPM(pmView) };
    }
    if (source === "cm6" || source === "reading") {
      if (file) return { source, file, headings: this.collectFromCache(file) };
    }
    return { source: "none", file: null, headings: [] };
  }

  private collectFromPM(pmView: EditorView): HeadingEntry[] {
    const out: HeadingEntry[] = [];
    const doc = pmView.state.doc;
    doc.forEach((node: PMNode, offset: number) => {
      if (node.type.name === "heading") {
        const levelRaw = (node.attrs as { level?: unknown }).level;
        out.push({
          level: typeof levelRaw === "number" ? levelRaw : 1,
          text: node.textContent || "",
          line: 0,
          pmPos: offset,
        });
      }
    });
    // Compute synthetic line numbers so the same outline entries
    // still carry a usable `line` value (for mode switches).
    let line = 0;
    doc.forEach((child, offset) => {
      const heading = out.find((h) => h.pmPos === offset);
      if (heading) heading.line = line;
      const text = child.textContent;
      const nlines = text ? text.split("\n").length : 1;
      line += nlines + 1;
    });
    return out;
  }

  private collectFromCache(file: TFile): HeadingEntry[] {
    const cache = this.app.metadataCache.getFileCache(file);
    const hs = cache?.headings ?? [];
    return hs.map((h) => ({
      level: h.level,
      text: h.heading,
      line: h.position.start.line,
      pmPos: null,
    }));
  }

  // ── Render ──

  private render() {
    if (!this.listEl || !this.emptyEl) return;
    const { source, file, headings } = this.collectHeadings();

    const key =
      (file?.path ?? "") +
      "::" +
      source +
      "::" +
      headings.map((h) => `${h.level}/${h.text}/${h.pmPos ?? -1}/${h.line}`).join("|");
    if (key === this.lastRenderedKey) {
      this.updateActive();
      return;
    }
    this.lastRenderedKey = key;
    // New set of rows → the scroll-position poll-key needs to re-
    // resolve the active heading on the next tick.
    this.lastPollKey = null;

    this.listEl.empty();
    if (headings.length === 0) {
      this.emptyEl.removeClass("butter-hidden");
      this.emptyEl.textContent = file
        ? "No headings in this note."
        : "Open a note to see its outline.";
      return;
    }
    this.emptyEl.addClass("butter-hidden");

    const minLevel = Math.min(...headings.map((h) => h.level));
    for (const h of headings) {
      const row = this.listEl.createDiv({ cls: "butter-outline-item" });
      row.setAttribute("data-level", String(h.level));
      row.setAttribute("data-key", this.keyFor(h));
      const indent = h.level - minLevel;
      row.style.paddingLeft = `${indent * 14 + 6}px`;

      // One guide span per ancestor-indent column. These render the
      // faint base guide and get a `.lit` class when their column is
      // inside the active heading's ancestor chain. The `.no-anim`
      // class is stripped on the next animation frame so the initial
      // paint doesn't trigger a fade-in on every row.
      for (let col = 0; col < indent; col++) {
        const guide = row.createSpan({
          cls: "butter-outline-guide no-anim",
        });
        guide.setAttribute("data-col", String(col));
        guide.style.left = `${col * 14 + 6}px`;
      }

      const label = row.createSpan({
        cls: "butter-outline-item-text",
        text: h.text || "(untitled)",
      });
      label.setAttribute("data-level", String(h.level));

      row.addEventListener("click", (e) => {
        e.preventDefault();
        this.navigateTo(h);
      });
    }

    this.updateActive();
    // Release transition locks on next frame so subsequent state
    // changes animate but the initial paint is instant.
    window.requestAnimationFrame(() => {
      this.listEl
        ?.querySelectorAll(".butter-outline-guide.no-anim")
        .forEach((g) => g.removeClass("no-anim"));
    });
  }

  private keyFor(h: HeadingEntry): string {
    return `${h.level}::${h.text}::${h.pmPos ?? -1}::${h.line}`;
  }

  // ── Active-heading tracking ──

  private updateActive() {
    if (!this.listEl) return;
    const { source, pmView, mdView } = this.resolveContext();

    const rows = Array.from(
      this.listEl.querySelectorAll<HTMLElement>(".butter-outline-item"),
    );
    if (rows.length === 0) return;

    // Cheap pre-check: if neither the editor scroll position nor the
    // PM doc (for Butter) / CM6 viewport (for Source/LP) has changed
    // since the previous tick, the active heading cannot have moved,
    // and the O(N) rect scan below would be pure waste. On big docs
    // with the outline open, this is what makes typing not stutter.
    let pollKey = "";
    if (source === "pm" && pmView) {
      const host =
        scrollHost(pmView.dom) ?? (pmView.dom.parentElement);
      const scroll = host?.scrollTop ?? 0;
      pollKey = `pm:${scroll}:${rows.length}`;
    } else if (source === "cm6" && mdView) {
      const cm = mdView.editor?.cm;
      pollKey = `cm6:${cm?.scrollDOM?.scrollTop ?? 0}:${rows.length}`;
    } else if (source === "reading" && mdView) {
      const previewEl = this.readingPreviewEl(mdView);
      const host = previewEl ? scrollHost(previewEl) ?? previewEl : null;
      pollKey = `reading:${host?.scrollTop ?? 0}:${rows.length}`;
    } else {
      pollKey = "none";
    }
    if (pollKey === this.lastPollKey) return;
    this.lastPollKey = pollKey;

    let activeKey: string | null = null;

    // All three paths answer the same question: which heading is at
    // the top of the visible viewport? The coordinate system differs
    // (PM DOM / CM6 scroll / preview DOM), but the highlight rule
    // is the same - last heading at or above the fold.

    if (source === "pm" && pmView) {
      const threshold = scrollHostTop(pmView.dom) + 40;
      let bestTop = -Infinity;
      for (const row of rows) {
        const parts = (row.getAttribute("data-key") ?? "").split("::");
        const pmPos = parseInt(parts[2]);
        if (!Number.isFinite(pmPos) || pmPos < 0) continue;
        // PM's `nodeDOM` returns Node | null - could be a Text node
        // or DocumentFragment for inline-content nodes mid-update,
        // and those don't have getBoundingClientRect. Guard with
        // an instanceof check to avoid the TypeError that the poll
        // setInterval would otherwise spam to the console once a
        // doc transitions through a transient state.
        const dom = pmView.nodeDOM(pmPos);
        if (!(dom instanceof HTMLElement)) continue;
        const top = dom.getBoundingClientRect().top;
        if (top <= threshold && top > bestTop) {
          bestTop = top;
          activeKey = row.getAttribute("data-key");
        }
      }
    } else if (source === "cm6" && mdView) {
      const cm = mdView.editor?.cm;
      if (cm) {
        try {
          const scrollDOM = cm.scrollDOM;
          const scrollRect = scrollDOM.getBoundingClientRect();
          const threshold = scrollRect.top + 40;
          let best = -Infinity;
          for (const row of rows) {
            const parts = (row.getAttribute("data-key") ?? "").split("::");
            const ln = parseInt(parts[3]);
            if (!Number.isFinite(ln)) continue;
            try {
              const pos = cm.state.doc.line(ln + 1).from;
              // coordsAtPos reports the actual rendered viewport
              // coords for positions in CM6's render margin; null
              // for positions well off-screen. For those we fall
              // back to the estimate - only negative (above
              // viewport) matters for "last heading above fold".
              const coords = cm.coordsAtPos(pos);
              let top: number;
              if (coords) {
                top = coords.top;
              } else {
                const block = cm.lineBlockAt(pos);
                const estInViewport = block.top - scrollDOM.scrollTop;
                if (estInViewport > 0) continue;
                top = scrollRect.top + estInViewport;
              }
              if (top <= threshold && top > best) {
                best = top;
                activeKey = row.getAttribute("data-key");
              }
            } catch {
              /* skip individual heading */
            }
          }
        } catch {
          /* ignore - empty docs / mid-transition */
        }
      }
    } else if (source === "reading" && mdView) {
      const previewEl = this.readingPreviewEl(mdView);
      if (previewEl) {
        const host = scrollHost(previewEl) ?? previewEl;
        const threshold = host.getBoundingClientRect().top + 40;
        let bestTop = -Infinity;
        for (const row of rows) {
          const parts = (row.getAttribute("data-key") ?? "").split("::");
          const level = parseInt(parts[0]);
          const text = parts[1];
          if (!Number.isFinite(level) || !text) continue;
          const domH = this.findReadingHeading(previewEl, text, level);
          if (!domH) continue;
          const top = domH.getBoundingClientRect().top;
          if (top <= threshold && top > bestTop) {
            bestTop = top;
            activeKey = row.getAttribute("data-key");
          }
        }
      }
    }

    // Single-row activation state (is-active, accent bar) AND the
    // ancestor-section tint state (has-accent, per-row guide layers)
    // are both refreshed from the same activeKey. Updating both here
    // keeps the DOM in sync with the current active heading.
    if (activeKey !== this.lastActiveKey) {
      if (this.lastActiveKey) {
        const prev = this.listEl.querySelector(
          `.butter-outline-item[data-key="${CSS.escape(this.lastActiveKey)}"]`,
        );
        prev?.removeClass("is-active");
      }
      if (activeKey) {
        const next = this.listEl.querySelector(
          `.butter-outline-item[data-key="${CSS.escape(activeKey)}"]`,
        );
        next?.addClass("is-active");
      }
      this.lastActiveKey = activeKey;
    }

    this.applyAncestorHighlights(rows, activeKey);
  }

  /**
   * Light up the guide columns of the active heading's ancestor
   * chain, each column lit for the full vertical span of its
   * section. Per-column animations stagger top-to-bottom so a newly-
   * lit run appears to sweep on from the section's head - but
   * guides that were already lit (user still in the same parent)
   * don't re-animate, because the `.lit` CSS class doesn't change
   * on them so no transition fires.
   */
  private applyAncestorHighlights(rows: HTMLElement[], activeKey: string | null) {
    const levels = rows.map((r) => {
      const parts = (r.getAttribute("data-key") ?? "").split("::");
      return parseInt(parts[0]);
    });
    const minLevel = levels.length ? Math.min(...levels) : 0;
    const activeIdx = activeKey
      ? rows.findIndex((r) => r.getAttribute("data-key") === activeKey)
      : -1;

    // (rowIdx, col) → stagger delay (ms). Delay is distance from
    // the section's head row, so a long section sweeps progressively.
    const litPerRow: Set<number>[] = rows.map(() => new Set<number>());
    const delayPerRow: Map<number, number>[] = rows.map(
      () => new Map<number, number>(),
    );

    if (activeIdx >= 0) {
      const STAGGER_MS = 25;
      const STAGGER_CAP = 300;

      let curIdx = activeIdx;
      let curLevel = levels[curIdx];
      while (curIdx >= 0) {
        let end = rows.length;
        for (let j = curIdx + 1; j < rows.length; j++) {
          if (levels[j] <= curLevel) {
            end = j;
            break;
          }
        }
        const col = curLevel - minLevel;
        for (let j = curIdx; j < end; j++) {
          const rowIndent = levels[j] - minLevel;
          // A guide at `col` is only visible on rows whose indent
          // exceeds `col` - otherwise we'd be painting past the
          // heading text.
          if (col >= rowIndent) continue;
          litPerRow[j].add(col);
          const delay = Math.min((j - curIdx) * STAGGER_MS, STAGGER_CAP);
          delayPerRow[j].set(col, delay);
        }
        let parentIdx = -1;
        for (let k = curIdx - 1; k >= 0; k--) {
          if (levels[k] < curLevel) {
            parentIdx = k;
            curLevel = levels[k];
            break;
          }
        }
        if (parentIdx < 0) break;
        curIdx = parentIdx;
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const guides = rows[i].querySelectorAll<HTMLElement>(
        ".butter-outline-guide",
      );
      guides.forEach((guide) => {
        const col = parseInt(guide.getAttribute("data-col") ?? "-1");
        const shouldLit = litPerRow[i].has(col);
        const delay = delayPerRow[i].get(col) ?? 0;
        guide.style.transitionDelay = `${delay}ms`;
        if (shouldLit) guide.addClass("lit");
        else guide.removeClass("lit");
      });
    }
  }

  // ── Navigation ──

  private navigateTo(h: HeadingEntry) {
    const { source, file, pmView, mdView } = this.resolveContext();

    if (source === "pm" && pmView && h.pmPos != null) {
      // Place the caret inside the heading's textblock but DON'T
      // use PM's scrollIntoView - that merely brings the caret into
      // the viewport, which leaves the heading in the middle on
      // short jumps. We want the clicked heading at the top of the
      // scroll container, which matches what the outline highlighted.
      const target = h.pmPos + 1;
      const size = pmView.state.doc.content.size;
      const clamped = Math.min(target, size);
      const resolved = pmView.state.doc.resolve(clamped);
      pmView.dispatch(pmView.state.tr.setSelection(Selection.near(resolved)));
      pmView.focus();

      const host = scrollHost(pmView.dom);
      const headingDom = pmView.nodeDOM(h.pmPos);
      if (host && headingDom instanceof HTMLElement) {
        const hostRect = host.getBoundingClientRect();
        const headingRect = headingDom.getBoundingClientRect();
        // If a detached/floating toolbar is sitting INSIDE this scroll
        // container with sticky-top positioning, the heading would
        // land underneath it without an offset. Measure the toolbar's
        // bottom edge relative to the host viewport and use that as
        // the floor - heading sits just below it. Default 12px gap
        // for attached / no-toolbar cases.
        let topOffset = 12;
        const stickyToolbar = host.querySelector<HTMLElement>(
          '.butter-toolbar[data-toolbar-style="detached"][data-toolbar-pos="top"]',
        );
        if (stickyToolbar) {
          const tbRect = stickyToolbar.getBoundingClientRect();
          topOffset = Math.max(12, tbRect.bottom - hostRect.top + 12);
        }
        host.scrollTo({
          top: host.scrollTop + (headingRect.top - hostRect.top - topOffset),
          behavior: "smooth",
        });
      }
      return;
    }

    if (source === "cm6" && mdView?.editor) {
      this.navigateEditorToTop(mdView.editor, h.line);
      return;
    }

    if (source === "reading" && mdView) {
      // Reading mode lazily renders sections - a heading far from
      // the current scroll often has no DOM element yet, so DOM-
      // based scroll silently no-ops. Delegate to Obsidian's own
      // setEphemeralState, which unfolds/renders what it needs on
      // the way to the target line. This matches how the core
      // Outline plugin navigates reading-mode notes.
      mdView.setEphemeralState?.({ line: h.line });
      return;
    }

    // Last-resort fallback - only happens if we can't identify the
    // active view. Goes through openLinkText so at minimum the right
    // file + line opens somewhere.
    if (file) {
      void this.app.workspace.openLinkText("", file.path, false, {
        eState: { line: h.line },
      });
    }
  }

  private navigateEditorToTop(editor: Editor, line: number) {
    const safeLine = Math.max(
      0,
      Math.min(line, Math.max(0, editor.lineCount() - 1)),
    );
    const cm = editor.cm;
    if (!cm) {
      editor.setCursor({ line: safeLine, ch: 0 });
      editor.scrollIntoView(
        { from: { line: safeLine, ch: 0 }, to: { line: safeLine, ch: 0 } },
        false,
      );
      editor.focus();
      return;
    }

    try {
      const pos = cm.state.doc.line(safeLine + 1).from;

      // Drive the scroll through CM6's own scrollIntoView effect.
      // Its measure cycle re-runs and corrects the landing spot
      // after virtualized lines are laid out - setting scrollTop
      // manually doesn't (block.top for un-measured lines is
      // estimated, landing the viewport a heading or two off).
      if (typeof CMEditorView.scrollIntoView === "function") {
        cm.dispatch({
          selection: { anchor: pos, head: pos },
          effects: CMEditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }),
          scrollIntoView: false, // we're supplying the effect ourselves
        });
      } else {
        editor.setCursor({ line: safeLine, ch: 0 });
        const block = cm.lineBlockAt(pos);
        cm.scrollDOM.scrollTop = Math.max(0, block.top - 8);
      }
    } catch {
      editor.setCursor({ line: safeLine, ch: 0 });
      editor.scrollIntoView(
        { from: { line: safeLine, ch: 0 }, to: { line: safeLine, ch: 0 } },
        false,
      );
    }
    editor.focus();
  }
}
