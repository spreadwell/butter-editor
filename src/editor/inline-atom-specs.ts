/**
 * Per-atom source-pattern specs for the inline-edit UI.
 *
 * Split out of `inline-atom-edit.ts` so tests and other consumers
 * can import just the pure specs without dragging in the plugin's
 * DOM-level + Obsidian-API dependencies. The plugin itself
 * re-exports SPECS from this module.
 */

import type { Node as PMNode, Schema } from "prosemirror-model";

/** A single editable field on an atom - for atoms (like wikilink)
 *  whose attrs map naturally onto multiple labelled inputs rather
 *  than a single source pattern. The panel renders one row per
 *  field; the commit logic round-trips through `fromFields`. */
export interface AtomField {
  /** Attribute key on the atom node. */
  name: string;
  /** Label shown above the input. */
  label: string;
  /** Placeholder shown when the input is empty. Can be a function
   *  of the OTHER fields' current values - e.g. the alias field
   *  defaults its placeholder to the target name as the user types. */
  placeholder?: string | ((other: Record<string, string>) => string);
  /** Optional Lucide icon shown left of the input. */
  icon?: string;
  /** Autocomplete source. `vault-files` populates a <datalist> with
   *  every markdown file's basename so typing fuzzy-narrows from a
   *  full vault list - friendlier than memorizing exact filenames. */
  autocomplete?: "vault-files";
}

/** Description of an editable atom type: how to serialize it to
 *  source (for prefilling the input) and how to parse source back
 *  (for committing a new version). When `fields` + the field-mode
 *  helpers are set, the panel uses the multi-input form instead of
 *  the legacy single source-text input. */
export interface AtomSpec {
  /** PM node type name. */
  typeName: string;
  /** Human-readable label shown in the floating panel + context menu. */
  label: string;
  /** Render the atom's CURRENT attrs to the source pattern a user
   *  would author - this is what prefills the legacy single input. */
  toSource: (node: PMNode) => string;
  /** Parse user-edited source back to a fresh node, or null if the
   *  input doesn't match this atom type's source pattern. */
  fromSource: (src: string, schema: Schema) => PMNode | null;
  /** Optional structured-form rendering. When present + `toFields`
   *  / `fromFields` are also set, the panel renders one input row
   *  per field. */
  fields?: AtomField[];
  toFields?: (node: PMNode) => Record<string, string>;
  fromFields?: (
    values: Record<string, string>,
    schema: Schema,
  ) => PMNode | null;
}

/** Parse an embed src ("file.png", "file.png|300", "file.png|300x200")
 *  into file / width / height pieces so the edit UI can surface them
 *  as separate inputs. Unrecognized size syntax falls back to the
 *  whole string in the file field (preserves user data even if the
 *  edit UI doesn't know how to break it apart). */
function splitEmbedSrc(raw: string): Record<string, string> {
  const pipe = raw.lastIndexOf("|");
  if (pipe < 0) return { src: raw, width: "", height: "" };
  const file = raw.slice(0, pipe);
  const sizePart = raw.slice(pipe + 1);
  const dim = /^(\d+)(?:x(\d+))?$/.exec(sizePart);
  if (!dim) return { src: raw, width: "", height: "" };
  return {
    src: file,
    width: dim[1],
    height: dim[2] ?? "",
  };
}

/** Recombine the split fields into the on-disk src string. Empty
 *  width drops the size suffix entirely; width without height emits
 *  `file|W`; both emits `file|WxH`. Returns null when the file is
 *  blank (commit should reject). */
function joinEmbedSrc(values: Record<string, string>): string | null {
  const file = (values.src ?? "").trim();
  if (!file) return null;
  const w = (values.width ?? "").trim();
  const h = (values.height ?? "").trim();
  if (!w) return file;
  if (h) return `${file}|${w}x${h}`;
  return `${file}|${w}`;
}

export const SPECS: Record<string, AtomSpec> = {
  wikilink: {
    typeName: "wikilink",
    label: "Wikilink",
    toSource(node) {
      const { target, alias } = node.attrs;
      return alias ? `[[${target}|${alias}]]` : `[[${target}]]`;
    },
    fromSource(src, schema) {
      const trimmed = src.trim();
      if (!trimmed) return null;
      // Bracketed form `[[Note]]` or `[[Note|alias]]`.
      const bracketed = /^\[\[([^\]|]+)(\|([^\]]+))?\]\]$/.exec(trimmed);
      if (bracketed) {
        return schema.nodes.wikilink.create({
          target: bracketed[1].trim(),
          alias: (bracketed[3] ?? "").trim(),
        });
      }
      // Plain form - allow `Note` or `Note|alias` without requiring
      // brackets (matches the toolbar's link popover behavior so the
      // edit input doesn't feel pickier than the insert one).
      // Reject anything containing `[` or `]` so a partial bracket
      // typo doesn't silently parse as a literal target name.
      if (trimmed.includes("[") || trimmed.includes("]")) return null;
      const pipe = trimmed.indexOf("|");
      if (pipe >= 0) {
        const target = trimmed.slice(0, pipe).trim();
        const alias = trimmed.slice(pipe + 1).trim();
        if (!target) return null;
        return schema.nodes.wikilink.create({ target, alias });
      }
      return schema.nodes.wikilink.create({ target: trimmed, alias: "" });
    },
    // Structured-form rendering - the panel shows two inputs ("Note"
    // + "Display text") instead of a single source pattern. Note
    // autocompletes from the vault file list; Display text is optional
    // and placeholders to the current Note value so the user doesn't
    // have to retype it. Label matches the external-link right-click
    // menu's "Display text" field for consistency between the two.
    fields: [
      {
        name: "target",
        label: "Note",
        icon: "file-text",
        autocomplete: "vault-files",
        placeholder: "Type to search the vault…",
      },
      {
        name: "alias",
        label: "Display text",
        icon: "pencil",
        placeholder: (other) => other.target || "Display text (optional)",
      },
    ],
    toFields(node) {
      const a = node.attrs as { target?: string; alias?: string };
      return {
        target: a.target ?? "",
        alias: a.alias ?? "",
      };
    },
    fromFields(values, schema) {
      const target = values.target.trim();
      if (!target) return null;
      let alias = values.alias.trim();
      // If the user left alias empty OR explicitly typed the same
      // string as target, don't store an alias - the wikilink will
      // render its target as the visible text by default.
      if (!alias || alias === target) alias = "";
      return schema.nodes.wikilink.create({ target, alias });
    },
  },
  obsidian_tag: {
    typeName: "obsidian_tag",
    label: "Tag",
    toSource(node) {
      return `#${node.attrs.tag}`;
    },
    fromSource(src, schema) {
      const m = /^#([A-Za-z0-9_\-/]+)$/.exec(src.trim());
      if (!m) return null;
      return schema.nodes.obsidian_tag.create({ tag: m[1] });
    },
    fields: [
      {
        name: "tag",
        label: "Tag",
        icon: "hash",
        placeholder: "project/butter",
      },
    ],
    toFields(node) {
      return { tag: (node.attrs.tag as string) ?? "" };
    },
    fromFields(values, schema) {
      // Accept user-typed `#tag` OR plain `tag`; strip the leading
      // hash so the attr value stays clean and round-trips through
      // the existing toSource regex.
      const raw = values.tag.trim().replace(/^#/, "");
      if (!/^[A-Za-z0-9_\-/]+$/.test(raw)) return null;
      return schema.nodes.obsidian_tag.create({ tag: raw });
    },
  },
  obsidian_embed: {
    typeName: "obsidian_embed",
    label: "Embed",
    toSource(node) {
      return `![[${node.attrs.src}]]`;
    },
    fromSource(src, schema) {
      const m = /^!\[\[([^\]]+)\]\]$/.exec(src.trim());
      if (!m) return null;
      return schema.nodes.obsidian_embed.create({ src: m[1] });
    },
    // Embed size lives in the src string (`file.png|300` or
    // `file.png|300x200`). Split it into three fields for editing,
    // recombine on commit — keeps the schema untouched while giving
    // the user a real GUI instead of having to type pipe-separated
    // markdown in the file input.
    fields: [
      {
        name: "src",
        label: "File",
        icon: "file-text",
        autocomplete: "vault-files",
        placeholder: "Type to search the vault…",
      },
      { name: "width", label: "Width (px)", icon: "scaling", placeholder: "auto" },
      { name: "height", label: "Height (px)", icon: "scaling", placeholder: "auto" },
    ],
    toFields(node) {
      return splitEmbedSrc((node.attrs.src as string) ?? "");
    },
    fromFields(values, schema) {
      const combined = joinEmbedSrc(values);
      if (!combined) return null;
      return schema.nodes.obsidian_embed.create({ src: combined });
    },
  },
  obsidian_embed_inline: {
    typeName: "obsidian_embed_inline",
    label: "Embed",
    toSource(node) {
      return `![[${node.attrs.src}]]`;
    },
    fromSource(src, schema) {
      const m = /^!\[\[([^\]]+)\]\]$/.exec(src.trim());
      if (!m) return null;
      return schema.nodes.obsidian_embed_inline.create({ src: m[1] });
    },
    fields: [
      {
        name: "src",
        label: "File",
        icon: "file-text",
        autocomplete: "vault-files",
        placeholder: "Type to search the vault…",
      },
      { name: "width", label: "Width (px)", icon: "scaling", placeholder: "auto" },
      { name: "height", label: "Height (px)", icon: "scaling", placeholder: "auto" },
    ],
    toFields(node) {
      return splitEmbedSrc((node.attrs.src as string) ?? "");
    },
    fromFields(values, schema) {
      const combined = joinEmbedSrc(values);
      if (!combined) return null;
      return schema.nodes.obsidian_embed_inline.create({ src: combined });
    },
  },
  inline_math: {
    typeName: "inline_math",
    label: "Inline math",
    toSource(node) {
      return `$${node.attrs.value}$`;
    },
    fromSource(src, schema) {
      const t = src.trim();
      if (!t.startsWith("$") || !t.endsWith("$") || t.length < 3) return null;
      const value = t.slice(1, -1);
      return schema.nodes.inline_math.create({ value });
    },
    fields: [
      {
        name: "value",
        label: "TeX",
        icon: "sigma",
        placeholder: "x^2 + y^2 = r^2",
      },
    ],
    toFields(node) {
      return { value: (node.attrs.value as string) ?? "" };
    },
    fromFields(values, schema) {
      const value = values.value.trim();
      if (!value) return null;
      return schema.nodes.inline_math.create({ value });
    },
  },
  footnote_ref: {
    typeName: "footnote_ref",
    label: "Footnote reference",
    toSource(node) {
      return `[^${node.attrs.label}]`;
    },
    fromSource(src, schema) {
      const m = /^\[\^([^\]]+)\]$/.exec(src.trim());
      if (!m) return null;
      return schema.nodes.footnote_ref.create({ label: m[1] });
    },
    fields: [
      {
        name: "label",
        label: "Footnote ID",
        icon: "asterisk",
        placeholder: "1, note-1, …",
      },
    ],
    toFields(node) {
      return { label: (node.attrs.label as string) ?? "" };
    },
    fromFields(values, schema) {
      const label = values.label.trim();
      if (!label) return null;
      return schema.nodes.footnote_ref.create({ label });
    },
  },
  inline_footnote: {
    typeName: "inline_footnote",
    label: "Inline footnote",
    toSource(node) {
      return `^[${node.attrs.content}]`;
    },
    fromSource(src, schema) {
      const m = /^\^\[(.*)\]$/.exec(src);
      if (!m) return null;
      return schema.nodes.inline_footnote.create({ content: m[1] });
    },
    fields: [
      {
        name: "content",
        label: "Footnote text",
        icon: "asterisk",
        placeholder: "Footnote body shown inline",
      },
    ],
    toFields(node) {
      return { content: (node.attrs.content as string) ?? "" };
    },
    fromFields(values, schema) {
      // Allow empty footnote bodies — `^[]` is technically legal
      // markdown though weird in practice. Trim trailing whitespace
      // but preserve internal spacing.
      const content = values.content.trimEnd();
      return schema.nodes.inline_footnote.create({ content });
    },
  },
};
