import {
  AbstractInputSuggest,
  App,
  prepareFuzzySearch,
  renderMatches,
  setIcon,
  type SearchResult,
} from "obsidian";

interface PropertyKeySuggestion {
  key: string;
  icon: string;
  occurrences: number;
  match: SearchResult | null;
}

export interface PropertyKeySuggestOptions {
  currentKey: string;
  existingKeys: readonly string[];
  onSelect: (key: string) => void;
  limit?: number;
}

/**
 * Obsidian's native Properties editor attaches a type-ahead to each property
 * name input. Butter owns a separate frontmatter writer, so it cannot safely
 * mount the native MetadataEditor wholesale; this adapter uses Obsidian's
 * public suggestion surface with the same metadata registry and visual shape.
 */
class PropertyKeySuggest extends AbstractInputSuggest<PropertyKeySuggestion> {
  private readonly inputEl: HTMLInputElement;
  private readonly options: PropertyKeySuggestOptions;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    options: PropertyKeySuggestOptions,
  ) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.options = options;
    this.limit = options.limit ?? 100;
  }

  open(): void {
    super.open();
    const popup = (this as unknown as { suggestEl?: HTMLElement }).suggestEl;
    popup?.addClass("mod-property-key");
  }

  getSuggestions(query: string): PropertyKeySuggestion[] {
    const manager = this.app.metadataTypeManager;
    const registry = manager?.properties ?? {};
    const currentLower = this.options.currentKey.toLowerCase();
    const unavailable = new Set(
      this.options.existingKeys
        .map((key) => key.toLowerCase())
        .filter((key) => key !== currentLower),
    );
    const trimmed = query.trim();
    const match = trimmed ? prepareFuzzySearch(trimmed) : null;
    const suggestions: PropertyKeySuggestion[] = [];

    for (const [registryKey, info] of Object.entries(registry)) {
      const key = info?.name?.trim() || registryKey;
      if (!key || unavailable.has(key.toLowerCase())) continue;
      const result = match?.(key) ?? null;
      if (match && !result) continue;
      const widget = info?.widget
        ? manager?.registeredTypeWidgets?.[info.widget]
        : undefined;
      suggestions.push({
        key,
        icon: widget?.icon ?? "lucide-text",
        occurrences: info?.occurrences ?? 0,
        match: result,
      });
    }

    suggestions.sort((a, b) => {
      if (trimmed) {
        const score = (b.match?.score ?? 0) - (a.match?.score ?? 0);
        if (score !== 0) return score;
      }
      const frequency = b.occurrences - a.occurrences;
      return frequency !== 0 ? frequency : a.key.localeCompare(b.key);
    });
    return suggestions.slice(0, this.limit);
  }

  renderSuggestion(suggestion: PropertyKeySuggestion, el: HTMLElement): void {
    el.addClass("mod-complex");
    el.closest(".suggestion-container")?.addClass("mod-property-key");
    const icon = el.createDiv({ cls: "suggestion-icon" });
    const flair = icon.createSpan({ cls: "suggestion-flair" });
    setIcon(flair, suggestion.icon);
    const content = el.createDiv({ cls: "suggestion-content" });
    const title = content.createDiv({ cls: "suggestion-title" });
    renderMatches(title, suggestion.key, suggestion.match?.matches ?? null);
  }

  selectSuggestion(
    suggestion: PropertyKeySuggestion,
    _event: MouseEvent | KeyboardEvent,
  ): void {
    this.setValue(suggestion.key);
    this.options.onSelect(suggestion.key);
    this.close();
  }
}

export function applyPropertyKeySuggest(
  app: App,
  inputEl: HTMLInputElement,
  options: PropertyKeySuggestOptions,
): { close(): void } {
  return new PropertyKeySuggest(app, inputEl, options);
}
