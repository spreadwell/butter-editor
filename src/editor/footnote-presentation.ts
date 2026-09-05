import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { setIcon } from "obsidian";
import { planFootnotePresentation } from "./footnote-plan";

function definitionElements(view: EditorView): HTMLElement[] {
  return Array.from(
    view.dom.querySelectorAll<HTMLElement>(".butter-footnote-def-view"),
  );
}

function referenceElements(view: EditorView): HTMLElement[] {
  return Array.from(
    view.dom.querySelectorAll<HTMLElement>(
      ".butter-footnote-ref[data-footnote-kind]",
    ),
  );
}

function revealTarget(target: HTMLElement): void {
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.remove("is-footnote-target");
  // Restart the animation even when navigating to the same target twice.
  void target.offsetWidth;
  target.classList.add("is-footnote-target");
  target.ownerDocument.defaultView?.setTimeout(
    () => target.classList.remove("is-footnote-target"),
    1300,
  );
}

function refreshFootnotePresentation(view: EditorView): void {
  const plan = planFootnotePresentation(view.state.doc);
  const refs = referenceElements(view);
  const defs = definitionElements(view);

  refs.forEach((dom, index) => {
    const presentation = plan.references[index];
    if (!presentation) return;
    const link = dom.querySelector<HTMLElement>(".footnote-link");
    if (!link) return;
    link.textContent = presentation.display;
    dom.classList.toggle("is-unresolved", !presentation.resolved);
    dom.dataset.footnoteReferenceIndex = String(index);
    if (presentation.label !== null) dom.dataset.footnoteLabel = presentation.label;
    else delete dom.dataset.footnoteLabel;
    if (presentation.resolved) {
      link.setAttribute(
        "aria-label",
        presentation.kind === "inline"
          ? `Footnote ${presentation.ordinal}`
          : `Footnote ${presentation.ordinal}: ${presentation.label}`,
      );
      link.setAttribute("role", "link");
      link.removeAttribute("aria-disabled");
    } else {
      link.setAttribute("aria-label", `Unresolved footnote: ${presentation.label}`);
      link.setAttribute("aria-disabled", "true");
      link.removeAttribute("role");
    }
  });

  defs.forEach((dom) => {
    const label = dom.dataset.footnoteLabel ?? "";
    const presentation = plan.definitions.get(label);
    const labelEl = dom.querySelector<HTMLElement>(".butter-footnote-label");
    const backrefs = dom.querySelector<HTMLElement>(".butter-footnote-backrefs");
    if (!labelEl || !backrefs) return;

    labelEl.textContent = presentation?.ordinal
      ? `${presentation.ordinal}.`
      : label;
    dom.classList.toggle("is-orphan", !presentation?.ordinal);
    backrefs.replaceChildren();
    for (let i = 0; i < (presentation?.referenceIndexes.length ?? 0); i++) {
      const referenceIndex = presentation!.referenceIndexes[i];
      const button = dom.ownerDocument.win.createEl("button");
      button.type = "button";
      button.className = "butter-footnote-backref clickable-icon";
      button.dataset.footnoteReferenceIndex = String(referenceIndex);
      setIcon(button, "corner-up-left");
      button.setAttribute(
        "aria-label",
        presentation!.referenceIndexes.length === 1
          ? `Back to footnote ${presentation!.ordinal}`
          : `Back to footnote ${presentation!.ordinal}, reference ${i + 1}`,
      );
      backrefs.appendChild(button);
    }
  });
}

/** View-only native-style numbering and navigation for footnotes. */
export function footnotePresentationPlugin(): Plugin<void> {
  return new Plugin<void>({
    view(view) {
      refreshFootnotePresentation(view);

      const onClick = (event: MouseEvent): void => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const backref = target.closest<HTMLElement>(".butter-footnote-backref");
        if (backref) {
          event.preventDefault();
          event.stopPropagation();
          const index = Number(backref.dataset.footnoteReferenceIndex);
          const ref = referenceElements(view)[index];
          if (ref) revealTarget(ref);
          return;
        }

        const link = target.closest<HTMLElement>(
          ".butter-footnote-ref .footnote-link",
        );
        if (!link) return;
        event.preventDefault();
        event.stopPropagation();
        const ref = link.closest<HTMLElement>(".butter-footnote-ref");
        if (!ref || ref.classList.contains("is-unresolved")) return;
        const label = ref.dataset.footnoteLabel;
        if (!label) {
          // Inline footnotes have no source definition to scroll to. Focus
          // reveals their rich preview; mobile can continue bubbling into
          // the existing atom drawer.
          link.focus({ preventScroll: true });
          return;
        }
        event.stopPropagation();
        const def = definitionElements(view).find(
          (candidate) => candidate.dataset.footnoteLabel === label,
        );
        if (def) revealTarget(def);
      };

      // Capture sees events from atomic NodeViews whose stopEvent prevents
      // ProseMirror's own DOM-event dispatch.
      view.dom.addEventListener("click", onClick, true);
      return {
        update(updatedView) {
          refreshFootnotePresentation(updatedView);
        },
        destroy() {
          view.dom.removeEventListener("click", onClick, true);
        },
      };
    },
  });
}
