import type { Node as PMNode } from "prosemirror-model";

export interface Parser {
  parse(markdown: string): PMNode | null;
}
