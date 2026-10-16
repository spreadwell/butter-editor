import { DOMParser, Fragment, type Attrs, type Node as PMNode, type ParseOptions, type Schema, type TagParseRule } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";

type OpaqueScope = { mark: "code" | "comment"; attrs?: Attrs };
type DOMNode = Node;
type ViewParseRule = Omit<TagParseRule, "tag" | "skip"> & { skip?: boolean | DOMNode };
type DOMPosition = { node: DOMNode; offset: number; pos?: number };
// The installed view supplies this model-parser option internally. Keep that
// exact protocol while using the public EditorView domParser extension point.
interface ViewParseOptions extends ParseOptions {
  ruleFromNode?: (node: DOMNode) => Omit<TagParseRule, "tag"> | null;
}

/** Live view parsing must retain opaque text, including CR and literal LF.
 * ProseMirror's normal text reader normalizes these even in `full` mode.
 * Exact leaves therefore enter through getContent in a detached parse tree;
 * all surrounding node/mark rules and DOM selection offsets remain intact.
 * Clipboard parseSlice retains its ordinary schema behavior. */
export class OpaqueDOMParser extends DOMParser {
  override parse(parent: DOMNode, options: ViewParseOptions = {}): PMNode {
    const viewRule = (node: DOMNode): ViewParseRule | null =>
      options.ruleFromNode?.(node) as ViewParseRule | null ?? null;
    // DOMObserver commonly supplies only a few children of a rich paragraph.
    // Unrelated opaque leaves must not make that edit scan or clone its peers.
    const rootChildren = parent.childNodes;
    const from = options.from ?? 0, to = Math.min(options.to ?? rootChildren.length, rootChildren.length);
    const selectedChildren: DOMNode[] = [];
    for (let index = from; index < to; index++) {
      if (rootChildren[index]) selectedChildren.push(rootChildren[index]);
    }
    const scopes = new Map<DOMNode, OpaqueScope>();
    const rootScope: OpaqueScope | null = options.topNode?.type.spec.code
      ? { mark: "code" } : null;
    const collect = (node: DOMNode, inherited: OpaqueScope | null): void => {
      let scope = inherited;
      if (node.nodeType === 1) {
        const element = node as HTMLElement, rule = viewRule(node);
        if (rule?.node === "code_block") scope = { mark: "code" };
        if (rule?.mark === "code" || rule?.mark === "comment") scope = { mark: rule.mark, attrs: rule.attrs };
        if (!scope && element.nodeName === "CODE") scope = { mark: "code" };
        if (!scope && element.matches("span[data-obsidian-comment]")) {
          scope = { mark: "comment", attrs: { value: element.getAttribute("data-value") || "" } };
        }
      }
      if (node.nodeType === 3 && scope && /[\r\n]/.test(node.nodeValue || "")) scopes.set(node, scope);
      for (const child of node === parent ? selectedChildren : Array.from(node.childNodes)) collect(child, scope);
    };
    collect(parent, rootScope);
    if (!scopes.size) return super.parse(parent, options);

    const copiedByOriginal = new Map<DOMNode, DOMNode>();
    const originalByCopied = new Map<DOMNode, DOMNode>();
    const payloads = new Map<DOMNode, OpaqueScope & { text: string }>();
    const copy = (original: DOMNode): DOMNode => {
      const scope = scopes.get(original);
      const copied = original.cloneNode(false);
      copiedByOriginal.set(original, copied); originalByCopied.set(copied, original);
      if (scope) {
        const wrapper = original.ownerDocument!.win.createSpan();
        wrapper.appendChild(copied);
        payloads.set(wrapper, { ...scope, text: original.nodeValue || "" });
        return wrapper;
      }
      for (const child of original === parent ? selectedChildren : Array.from(original.childNodes)) copied.appendChild(copy(child));
      return copied;
    };
    const copiedParent = copy(parent);
    const positions: DOMPosition[] = (options.findPositions || []).map(position => ({
      ...position, node: copiedByOriginal.get(position.node) || position.node,
      offset: position.node === parent ? position.offset - from : position.offset,
    }));
    // The detached root contains just the requested children. Translate its
    // boundary positions as well as descendant skip/contentElement pointers.
    const parseOptions: ViewParseOptions = { ...options, from: 0, to: selectedChildren.length, findPositions: positions, ruleFromNode: copied => {
      const payload = payloads.get(copied);
      if (payload) return { mark: payload.mark, attrs: payload.attrs, getContent: () => {
        // findInside runs immediately before getContent and gives the leaf's
        // starting position. Preserve the caret's actual UTF-16 offset.
        for (const position of positions) {
          if (copied.contains(position.node) && position.pos != null) position.pos += position.offset;
        }
        return Fragment.from(this.schema.text(payload.text));
      } };
      const original = originalByCopied.get(copied) || copied, rule = viewRule(original);
      if (!rule) return null;
      const element = rule.contentElement;
      const contentElement = typeof element === "function"
        ? (node: HTMLElement) => {
          const target = element((originalByCopied.get(node) || node) as HTMLElement);
          return (copiedByOriginal.get(target) || target) as HTMLElement;
        }
        : typeof element === "object" && element
          ? (copiedByOriginal.get(element) || element) as HTMLElement : element;
      const skip = typeof rule.skip === "object" && rule.skip
        ? copiedByOriginal.get(rule.skip) || rule.skip : rule.skip;
      // Installed PM view rules also use a DOM-node `skip` for decorated
      // text, although the public model declaration describes only boolean.
      return { ...rule, contentElement, skip } as Omit<TagParseRule, "tag">;
    } };
    const parsed = super.parse(copiedParent, parseOptions);
    for (let index = 0; index < positions.length; index++) options.findPositions![index].pos = positions[index].pos;
    return parsed;
  }
}

export function opaqueDOMParserPlugin(schema: Schema): Plugin {
  return new Plugin({
    key: new PluginKey("butter-opaque-dom-parser"),
    props: { domParser: new OpaqueDOMParser(schema, DOMParser.fromSchema(schema).rules) },
  });
}
