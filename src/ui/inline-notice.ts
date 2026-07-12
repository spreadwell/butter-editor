export type InlineNoticeLevel = "info" | "warning";

export function appendInlineNotice(
  parent: HTMLElement,
  text: string,
  level: InlineNoticeLevel = "info",
): HTMLElement {
  const notice = parent.createDiv({
    cls: `butter-inline-notice is-${level}`,
  });
  notice.createSpan({
    cls: "butter-inline-notice-dot",
    attr: { "aria-hidden": "true" },
  });
  notice.createSpan({
    cls: "butter-inline-notice-text",
    text,
  });
  return notice;
}
