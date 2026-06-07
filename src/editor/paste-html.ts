/**
 * HTML → markdown conversion for the paste path.
 *
 * Walks an HTMLElement tree and produces a markdown string that our
 * markdown-it pipeline (with obsidian + html-inline-tags plugins) can
 * parse back into the same PM doc shape. Extracted from paste-drop.ts
 * so it's testable from Node without pulling in the obsidian module.
 *
 * Form-choice rules (per inline mark):
 *   • <strong>, <em>           → emit HTML form. Reasons: overlap
 *     survival (cross-boundary `<strong>...<em>...</strong>...</em>`
 *     can't be represented in `**`/`*` markdown form, but our
 *     htmlInlineTagsPlugin's any-match close handles it on parse) and
 *     whitespace robustness (`<strong> foo </strong>` round-trips
 *     cleanly; `**foo **` runs into right-flanking pairing rules).
 *   • <del>, <s>               → markdown form `~~…~~`. No
 *     html_del_open / html_s_open token handler in our parser; HTML
 *     form would not round-trip.
 *   • <u>, <sup>, <sub>, <kbd>, <mark>, <font>
 *                              → HTML form. No markdown shorthand
 *     exists for these in CommonMark/GFM; HTML is the canonical
 *     authoring form.
 *
 * The end-state on disk is the same regardless of which intermediate
 * form is used (the canonical serializer chooses `**` for non-overlap
 * strong, `<strong>` when overlap forces HTML, etc.). Picking the
 * safer intermediate just maximizes the chance the parser produces
 * the structurally-correct PM doc on the way through.
 */

export function htmlToMarkdown(html: string): string {
  // DOMParser parses into an inert document - scripts don't execute,
  // image error handlers don't fire, etc. - making it the safe primitive
  // for digesting clipboard HTML. (Previously this used `innerHTML` on a
  // detached div, which is safe in practice but flagged by Obsidian's
  // plugin-review guideline against innerHTML for any user input.)
  //
  // Pre-wrap the input in <body>...</body> so the parsed doc always
  // exposes a body element. Some parser implementations (and some
  // malformed clipboard inputs) produce a documentElement-less doc
  // otherwise, which throws on `doc.body` access.
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    "text/html",
  );
  const body = doc.body;
  if (!body) return "";
  return serializeNode(body).trim();
}

export function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const children = Array.from(el.childNodes).map(serializeNode).join("");
  switch (el.tagName.toLowerCase()) {
    // Inline marks with both HTML and markdown forms - emit HTML form.
    case "strong":
    case "b":
      return `<strong>${children}</strong>`;
    case "em":
    case "i":
      return `<em>${children}</em>`;
    case "del":
    case "s":
      // No html_del_open / html_s_open in our parser - markdown form only.
      return `~~${children}~~`;
    // HTML-only inline marks (no markdown shorthand exists).
    case "u":
      return `<u>${children}</u>`;
    case "sup":
      return `<sup>${children}</sup>`;
    case "sub":
      return `<sub>${children}</sub>`;
    case "kbd":
      return `<kbd>${children}</kbd>`;
    case "mark":
      return `<mark>${children}</mark>`;
    case "font": {
      const color = el.getAttribute("color");
      const face = el.getAttribute("face");
      const size = el.getAttribute("size");
      const attrs: string[] = [];
      if (color) attrs.push(`color="${color}"`);
      if (face) attrs.push(`face="${face}"`);
      if (size) attrs.push(`size="${size}"`);
      const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
      return `<font${attrStr}>${children}</font>`;
    }
    case "code": {
      // <code> in <pre> is part of a fenced block - let the <pre> case
      // handle the wrap. Multi-line <code> w/o <pre> is also fenced
      // (some sources emit bare <code class="language-X">…</code>);
      // wrapping multi-line in single backticks would be invalid.
      const parentIsPre =
        el.parentElement?.tagName.toLowerCase() === "pre";
      if (parentIsPre) return el.textContent ?? "";
      const text = el.textContent ?? "";
      if (text.includes("\n")) {
        const langMatch = el.className.match(/language-(\S+)/);
        const lang = langMatch ? langMatch[1] : "";
        const body = text.replace(/\n+$/, "");
        return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
      }
      return `\`${children}\``;
    }
    case "a": {
      const href = el.getAttribute("href") || "";
      return children ? `[${children}](${href})` : href;
    }
    case "img": {
      const src = el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || "";
      return `![${alt}](${src})`;
    }
    case "h1":
      return `\n# ${children}\n`;
    case "h2":
      return `\n## ${children}\n`;
    case "h3":
      return `\n### ${children}\n`;
    case "h4":
      return `\n#### ${children}\n`;
    case "h5":
      return `\n##### ${children}\n`;
    case "h6":
      return `\n###### ${children}\n`;
    case "p":
      return `\n${children}\n`;
    case "br":
      return "\n";
    case "hr":
      return `\n\n---\n\n`;
    case "li":
      return `- ${children}\n`;
    case "ul":
    case "ol":
      return `\n${children}\n`;
    case "blockquote":
      return `\n${children
        .split("\n")
        .map((l) => (l ? `> ${l}` : ""))
        .join("\n")}\n`;
    case "pre": {
      // Fenced code. Pull language from nested <code class="language-X">.
      const codeChild = el.querySelector("code");
      const langMatch = codeChild?.className.match(/language-(\S+)/);
      const lang = langMatch ? langMatch[1] : "";
      const body = (el.textContent ?? "").replace(/\n+$/, "");
      return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
    }
    case "table":
      return htmlTableToMd(el);
    default:
      return children;
  }
}

function htmlTableToMd(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (!rows.length) return "";
  const cells = rows.map((tr) =>
    Array.from(tr.querySelectorAll("th,td")).map(
      (c) => (c.textContent ?? "").trim().replace(/\|/g, "\\|"),
    ),
  );
  const colCount = Math.max(...cells.map((r) => r.length));
  const header = cells[0];
  while (header.length < colCount) header.push("");
  const sep = Array.from({ length: colCount }, () => "---");

  const fmt = (r: string[]) => "| " + r.join(" | ") + " |";
  return [
    fmt(header),
    fmt(sep),
    ...cells.slice(1).map((r) => {
      while (r.length < colCount) r.push("");
      return fmt(r);
    }),
  ].join("\n");
}
