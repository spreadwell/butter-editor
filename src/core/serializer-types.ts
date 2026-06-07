import type { Node as PMNode } from "prosemirror-model";

export type Serializer = (doc: PMNode) => string;
