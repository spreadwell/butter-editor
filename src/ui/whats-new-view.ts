import { ItemView, Notice, setIcon, ToggleComponent, WorkspaceLeaf } from "obsidian";
import type ButterEditorPlugin from "../main";
import {
  LATEST_WHATS_NEW_RELEASE,
  whatsNewAssetUrl,
  whatsNewRelease,
  type WhatsNewRelease,
} from "../integration/whats-new";
import { tx, txKnown, type MessageKey } from "../i18n";

export const VIEW_TYPE_BUTTER_WHATS_NEW = "butter-whats-new";

export class ButterWhatsNewView extends ItemView {
  private releaseVersion = LATEST_WHATS_NEW_RELEASE.version;

  constructor(leaf: WorkspaceLeaf, private plugin: ButterEditorPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BUTTER_WHATS_NEW;
  }

  getDisplayText(): string {
    return txKnown("What's new in Butter Editor");
  }

  getIcon(): string {
    return "party-popper";
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), releaseVersion: this.releaseVersion };
  }

  async setState(state: unknown): Promise<void> {
    const releaseVersion = (state as { releaseVersion?: unknown } | null)?.releaseVersion;
    if (typeof releaseVersion === "string" && whatsNewRelease(releaseVersion)) {
      this.releaseVersion = releaseVersion;
    }
    this.render();
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private render(): void {
    const release = whatsNewRelease(this.releaseVersion) ?? LATEST_WHATS_NEW_RELEASE;
    const root = this.contentEl;
    root.empty();
    root.addClasses(["butter-whats-new-view", "markdown-reading-view"]);

    const scroller = root.createDiv({ cls: "butter-whats-new-scroller markdown-preview-view" });
    const article = scroller.createEl("article", {
      cls: "butter-whats-new-article markdown-preview-sizer markdown-rendered",
    });
    this.renderHeader(article, release);

    this.renderReleaseSection(
      article,
      txKnown("New features"),
      "sparkles",
      release,
      release.demos.filter((demo) => demo.section === "new"),
    );
    this.renderReleaseSection(
      article,
      txKnown("Improvements"),
      "wrench",
      release,
      release.demos.filter((demo) => demo.section === "improvement"),
      release.improvements.map(tx),
    );
    this.renderReleaseSection(
      article,
      txKnown("Bug fixes"),
      "bug",
      release,
      [],
      release.fixed.map(tx),
    );

    const footer = article.createEl("footer", { cls: "butter-whats-new-footer" });
    const icon = footer.createSpan();
    setIcon(icon, "heart");
    footer.createSpan({ text: txKnown("Thanks for using Butter Editor.") });
  }

  private renderHeader(parent: HTMLElement, release: WhatsNewRelease): void {
    const header = parent.createEl("header", { cls: "butter-whats-new-hero" });
    const releaseLabel = header.createDiv({ cls: "butter-whats-new-release" });
    const icon = releaseLabel.createSpan();
    setIcon(icon, "party-popper");
    releaseLabel.createSpan({ text: `Butter Editor ${release.version}` });
    header.createEl("h1", { text: txKnown("What's new") });
    header.createEl("p", { cls: "butter-whats-new-headline", text: tx(release.headline) });
    header.createEl("p", { cls: "butter-whats-new-summary", text: tx(release.summary) });

    const preference = header.createDiv({ cls: "butter-whats-new-preference" });
    preference.toggleClass("is-enabled", this.plugin.settings.whatsNewAutoOpen);
    preference.createSpan({
      cls: "butter-whats-new-preference-title",
      text: txKnown("Open What's New automatically after updates"),
    });
    const control = preference.createDiv({ cls: "butter-whats-new-preference-control" });
    const toggle = new ToggleComponent(control)
      .setValue(this.plugin.settings.whatsNewAutoOpen)
      .onChange((enabled) => {
        preference.toggleClass("is-enabled", enabled);
        void this.plugin.setWhatsNewAutoOpen(enabled);
        new Notice(
          enabled
            ? txKnown("What's New will open automatically after future updates.")
            : txKnown("What's New will no longer open automatically."),
          3000,
        );
      });
    toggle.toggleEl.setAttribute("aria-label", txKnown("Open What's New automatically after updates"));
  }

  private renderReleaseSection(
    parent: HTMLElement,
    title: string,
    iconName: string,
    release: WhatsNewRelease,
    demos: WhatsNewRelease["demos"],
    entries: readonly string[] = [],
  ): void {
    const section = parent.createEl("section", { cls: "butter-whats-new-release-section" });
    const heading = section.createEl("h2", { cls: "butter-whats-new-section-title" });
    const icon = heading.createSpan({ cls: "butter-whats-new-section-icon" });
    setIcon(icon, iconName);
    heading.createSpan({ text: title });
    for (const demo of demos) {
      const demoSection = section.createEl("section", { cls: "butter-whats-new-demo" });
      demoSection.createEl("h3", { text: tx(demo.title) });
      demoSection.createEl("p", { text: tx(demo.description) });
      this.renderDemo(demoSection, release, demo.asset, demo.alt);
    }
    if (entries.length > 0) this.renderList(section, entries);
  }

  private renderDemo(
    parent: HTMLElement,
    release: WhatsNewRelease,
    asset: string,
    alt: MessageKey,
  ): void {
    const frame = parent.createDiv({ cls: "butter-whats-new-demo-frame" });
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const load = () => {
      frame.empty();
      const image = frame.createEl("img", {
        attr: {
          src: whatsNewAssetUrl(release, asset),
          alt: tx(alt),
          loading: "lazy",
          decoding: "async",
        },
      });
      image.addEventListener("error", () => {
        frame.empty();
        frame.createDiv({
          cls: "butter-whats-new-demo-error",
          text: txKnown("The demo could not be loaded. The release details below are still available."),
        });
      }, { once: true });
    };

    if (!reducedMotion) {
      load();
      return;
    }

    const play = frame.createEl("button", {
      cls: "butter-whats-new-play",
      text: txKnown("Play animated demo"),
      attr: { type: "button" },
    });
    const icon = play.createSpan();
    setIcon(icon, "play");
    play.prepend(icon);
    play.addEventListener("click", load, { once: true });
  }

  private renderList(parent: HTMLElement, entries: readonly string[]): void {
    const section = parent.createEl("section", { cls: "butter-whats-new-list" });
    const list = section.createEl("ul");
    for (const entry of entries) list.createEl("li", { text: entry });
  }
}
