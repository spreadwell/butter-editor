/**
 * Obsidian exposes its DOM creation helpers on each workspace window so
 * plugins create elements in the correct pop-out window. The 1.13 API types
 * declare the helpers globally and on Node, but currently omit the equivalent
 * Window members used by the official prefer-create-el autofix.
 */
export {};

declare global {
  interface Window {
    CSSStyleSheet: typeof CSSStyleSheet;
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      options?: DomElementInfo | string,
      callback?: (el: HTMLElementTagNameMap[K]) => void,
    ): HTMLElementTagNameMap[K];
    createDiv(
      options?: DomElementInfo | string,
      callback?: (el: HTMLDivElement) => void,
    ): HTMLDivElement;
    createSpan(
      options?: DomElementInfo | string,
      callback?: (el: HTMLSpanElement) => void,
    ): HTMLSpanElement;
    createSvg<K extends keyof SVGElementTagNameMap>(
      tag: K,
      options?: SvgElementInfo | string,
      callback?: (el: SVGElementTagNameMap[K]) => void,
    ): SVGElementTagNameMap[K];
    createFragment(callback?: (el: DocumentFragment) => void): DocumentFragment;
  }
}
