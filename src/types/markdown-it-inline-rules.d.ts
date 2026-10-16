// markdown-it publishes these rule modules; its external type package omits
// their declarations. Keep the public RuleInline signature at this boundary.
declare module "markdown-it/lib/rules_inline/link.mjs" {
  import type { RuleInline } from "markdown-it/lib/parser_inline.mjs";
  const link: RuleInline;
  export default link;
}
declare module "markdown-it/lib/rules_inline/image.mjs" {
  import type { RuleInline } from "markdown-it/lib/parser_inline.mjs";
  const image: RuleInline;
  export default image;
}
