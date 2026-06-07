/**
 * Native-feel autocomplete suggester for vault markdown files. Wraps
 * Obsidian's `AbstractInputSuggest` so the dropdown looks identical
 * to the one used by Internal Links / file pickers / "Quick Switcher"
 * elsewhere in Obsidian - fuzzy matching, keyboard nav, themed popup.
 *
 * Replaces the plain `<datalist>` we used previously: datalist works
 * but renders unstyled, can't show secondary metadata (like the file's
 * folder path), and doesn't fuzzy-match.
 *
 * Usage:
 *   const suggest = applyVaultFilesSuggest(app, inputEl, {
 *     onSelect: (file) => { ... },
 *     skipWhen: (raw) => looksLikeUrl(raw),
 *   });
 *   // remember to suggest.close() when the host UI tears down
 *
 * If `skipWhen` is provided and returns true for the current raw
 * input value, the dropdown is hidden - used by the toolbar's Add
 * Link field, which serves dual-purpose (URL or note name) and
 * shouldn't suggest notes when the user is typing a URL.
 */

import { AbstractInputSuggest, App, TFile, prepareFuzzySearch } from "obsidian";

export interface VaultFilesSuggestOptions {
  /** Called when the user picks a suggestion (Enter / click). The
   *  default behavior is to write the file's basename into the input
   *  and close the dropdown; pass an override to do something else
   *  (e.g. fill multiple inputs from one pick). */
  onSelect?: (file: TFile, evt: MouseEvent | KeyboardEvent) => void;
  /** Optional predicate: when it returns true for the current raw
   *  input value, the dropdown is suppressed. Lets a dual-purpose
   *  field (URL or note name) skip note suggestions when the user
   *  is clearly typing a URL. */
  skipWhen?: (raw: string) => boolean;
  /** Maximum number of suggestions to render. Defaults to 50 - high
   *  enough that a vault of a few thousand notes still has plenty of
   *  matches in the visible list, low enough that we don't blow up
   *  the popover on giant vaults. */
  limit?: number;
}

class VaultFilesSuggest extends AbstractInputSuggest<TFile> {
  private readonly opts: VaultFilesSuggestOptions;
  private readonly inputEl: HTMLInputElement;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    opts: VaultFilesSuggestOptions,
  ) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.opts = opts;
    this.limit = opts.limit ?? 50;
  }

  open(): void {
    super.open();
    // Match the popup's width to the input's width. Obsidian's
    // default popup is content-sized (capped at 500px) which produces
    // a noticeably different width from the input it's anchored to;
    // forcing it to the input's offsetWidth keeps the dropdown visually
    // tied to the field. The popup DOM is exposed via the internal
    // `suggestEl` property - not in the public d.ts, but it's the same
    // shape every Obsidian release exposes.
    const popup =
      (this as unknown as { suggestEl?: HTMLElement }).suggestEl ?? null;
    if (popup) {
      const width = this.inputEl.offsetWidth;
      if (width > 0) {
        popup.style.width = `${width}px`;
        // Override the default `max-width: 500px` so a narrow input
        // (~225px in our rich menu) doesn't get a popup that wants to
        // expand past it.
        popup.style.maxWidth = `${width}px`;
      }
    }
  }

  getSuggestions(query: string): TFile[] {
    if (this.opts.skipWhen && this.opts.skipWhen(query)) return [];
    const trimmed = query.trim();
    // Empty input → no dropdown. Returning an empty list signals the
    // suggester to stay closed; the popup only appears once the user
    // has typed something to fuzzy-match against.
    if (!trimmed) return [];
    const files = this.app.vault.getMarkdownFiles();
    const match = prepareFuzzySearch(trimmed);
    type Scored = { file: TFile; score: number };
    const scored: Scored[] = [];
    for (const f of files) {
      // Match against basename + parent path so "fold/note" queries
      // narrow to the right folder. Take the higher of the two
      // scores so a great basename hit wins over a mediocre path
      // hit and vice versa.
      const basenameMatch = match(f.basename);
      const pathMatch = match(f.path);
      const score = Math.max(
        basenameMatch?.score ?? -Infinity,
        pathMatch?.score ?? -Infinity,
      );
      if (score === -Infinity) continue;
      scored.push({ file: f, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, this.limit).map((s) => s.file);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    // Two-line layout matching Obsidian's own internal-link suggester:
    // basename on top, faint folder path below. Files at the vault
    // root show no second line.
    el.addClass("butter-vault-suggest-item");
    // Mark the host `.suggestion-container` so CSS can bump its
    // z-index without a `:has()` query. Obsidian appends the item
    // to the container before this hook runs, so `closest()` works
    // synchronously. The class is cleaned up when the container
    // is destroyed by Obsidian on suggester close.
    el.closest(".suggestion-container")?.classList.add(
      "butter-suggest-host-vault",
    );
    const titleEl = el.createDiv({
      cls: "butter-vault-suggest-title",
      text: file.basename,
    });
    void titleEl;
    const parent = file.parent?.path && file.parent.path !== "/"
      ? file.parent.path
      : "";
    if (parent) {
      el.createDiv({
        cls: "butter-vault-suggest-path",
        text: parent,
      });
    }
  }

  selectSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent): void {
    if (this.opts.onSelect) {
      this.opts.onSelect(file, evt);
    } else {
      this.setValue(file.basename);
    }
    this.close();
  }
}

/**
 * Attach a vault-files suggester to a text input. Returns the
 * suggester instance so the caller can `close()` it on teardown.
 */
export function applyVaultFilesSuggest(
  app: App,
  input: HTMLInputElement,
  opts: VaultFilesSuggestOptions = {},
): VaultFilesSuggest {
  return new VaultFilesSuggest(app, input, opts);
}
