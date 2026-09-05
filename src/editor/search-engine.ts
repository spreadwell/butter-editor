import type { Node as PMNode } from "prosemirror-model";

export interface SearchSegment {
  text: string;
  from: number;
  /** Visible atomic labels are searchable, but cannot be replaced as prose. */
  atomTo?: number;
}
export interface SearchMatch {
  from: number;
  to: number;
  atom: boolean;
  replacement: string;
}
export interface SearchRequest {
  segments: SearchSegment[];
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  replace: string;
}
export interface SearchResult {
  matches: SearchMatch[];
  error?: "invalid" | "limit" | "timeout" | "unavailable";
}

/** UTF-16 text offsets map exactly to PM positions within each text run.
 * Marks do not split runs; opaque atoms do. Break nodes occupy one position. */
export function searchSegments(doc: PMNode): SearchSegment[] {
  const segments: SearchSegment[] = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    let run: SearchSegment | null = null;
    block.forEach((node, offset) => {
      const from = pos + 1 + offset;
      const text = node.isText ? node.text! :
        ["hard_break", "softbreak"].includes(node.type.name) ? "\n" : null;
      if (text !== null) {
        if (!run) segments.push(run = { text: "", from });
        run.text += text;
        return;
      }
      run = null;
      let label = "";
      switch (node.type.name) {
        case "wikilink": label = String(node.attrs.alias || node.attrs.target || ""); break;
        case "obsidian_tag": label = `#${String(node.attrs.tag)}`; break;
        case "inline_math": label = String(node.attrs.value || ""); break;
        case "inline_footnote": label = String(node.attrs.content || ""); break;
      }
      if (label) segments.push({ text: label, from, atomTo: from + node.nodeSize });
    });
    return false;
  });
  return segments;
}

/** Self-contained so the exact same implementation runs in an isolated Worker.
 * Never call this with regex=true on the UI thread. */
export function executeSearch(request: SearchRequest): SearchResult {
  const matches: SearchMatch[] = [];
  let replacementSize = 0;
  if (!request.query) return { matches };
  if (request.query.length > 1024) return { matches, error: "limit" };
  let pattern: RegExp;
  try {
    pattern = new RegExp(request.regex ? request.query :
      request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), request.caseSensitive ? "gu" : "giu");
  } catch { return { matches, error: "invalid" }; }
  for (const segment of request.segments) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment.text))) {
      if (matches.length >= 10000) return { matches: [], error: "limit" };
      const found = match;
      const replacement = request.regex ? request.replace.replace(
        /\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g,
        (token: string, key: string) => {
          if (key === "$") return "$";
          if (key === "&") return found[0];
          if (key === "`") return segment.text.slice(0, found.index);
          if (key === "'") return segment.text.slice(found.index + found[0].length);
          if (key.startsWith("<")) return found.groups ? found.groups[key.slice(1, -1)] ?? "" : token;
          const index = Number(key);
          if (index > 0 && index < found.length) return found[index] ?? "";
          const first = Number(key[0]);
          return key.length === 2 && first > 0 && first < found.length
            ? (found[first] ?? "") + key[1] : token;
        },
      ) : request.replace;
      replacementSize += replacement.length;
      if (replacementSize > 4_000_000) return { matches: [], error: "limit" };
      matches.push({
        from: segment.atomTo == null ? segment.from + found.index : segment.from,
        to: segment.atomTo ?? segment.from + found.index + found[0].length,
        atom: segment.atomTo != null,
        replacement,
      });
      // An atomic label is one navigation target, regardless of repeated hits.
      if (segment.atomTo != null) break;
      if (found[0].length === 0) {
        const next = segment.text.codePointAt(pattern.lastIndex);
        pattern.lastIndex += next != null && next > 0xffff ? 2 : 1;
      }
    }
  }
  return { matches };
}

export interface SearchWorker {
  onmessage: ((event: MessageEvent<SearchResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: SearchRequest): void;
  terminate(): void;
}

/** One operation per editor. Cancellation also terminates an expensive exec. */
export class RegexSearch {
  private cancelPending: (() => void) | null = null;
  constructor(private readonly createWorker: () => SearchWorker = () => {
    const source = `self.onmessage = e => self.postMessage((${executeSearch.toString()})(e.data));`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try { return new Worker(url); }
    finally { URL.revokeObjectURL(url); }
  }) {}

  cancel(): void { this.cancelPending?.(); }

  run(request: SearchRequest, accept: (result: SearchResult) => void): void {
    this.cancel();
    let worker: SearchWorker;
    try { worker = this.createWorker(); }
    catch { accept({ matches: [], error: "unavailable" }); return; }
    let active = true;
    const cleanup = () => {
      active = false;
      window.clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      this.cancelPending = null;
    };
    const timer = window.setTimeout(() => {
      cleanup();
      accept({ matches: [], error: "timeout" });
    }, 500);
    this.cancelPending = cleanup;
    worker.onmessage = (event) => { if (active) { cleanup(); accept(event.data); } };
    worker.onerror = () => { if (active) { cleanup(); accept({ matches: [], error: "unavailable" }); } };
    try { worker.postMessage(request); }
    catch { cleanup(); accept({ matches: [], error: "unavailable" }); }
  }
}
