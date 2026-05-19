# Butter Editor

A WYSIWYG editing mode for [Obsidian](https://obsidian.md). Headings render as headings, bold is bold, embeds and callouts render in place — while the file on disk stays canonical Markdown. Round-trip safe across every other Obsidian view, every other plugin, every other tool you use to touch your vault.

**Website:** [buttereditor.com](https://buttereditor.com) · **Pricing:** [buttereditor.com/pricing](https://buttereditor.com/pricing) · **Manage your licenses:** [licenses.buttereditor.com](https://licenses.buttereditor.com)

---

## What it does

Butter mounts a fourth view mode alongside Obsidian's **Source**, **Live Preview**, and **Reading**. You toggle it per note. The file never changes shape.

- **Full Obsidian syntax, rendered in place.** Headings, bold/italic, lists, task lists, tables, code fences, math, footnotes, highlights, wikilinks, embeds (sized + standard), tags, block IDs, callouts (including nested + code/math/list inside callouts), inline + block comments.
- **Drag-handle block reorder.** A grip appears in the gutter — pick up a paragraph/callout/table/code-fence and drop it elsewhere. Mobile uses long-press.
- **Inline editing for atoms.** Double-click a wikilink, tag, embed, inline math, or footnote — a small floating panel lets you edit the target without disturbing surrounding text.
- **Round-trip safety as the first-class promise.** Ships with an 80+ case round-trip corpus run on every release. Your files don't drift.
- **Mobile-native.** Same editor, touch-tuned toolbar, swipe drawers for block actions.

## Install via BRAT

Butter Editor is in beta and not yet in the Obsidian community plugin store. To install and receive auto-updates:

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the community plugins browser.
2. In BRAT settings, click **Add Beta plugin** and paste: `spreadwell/butter-editor`
3. Enable Butter Editor in Settings → Community plugins.

BRAT checks for updates on Obsidian startup (or on demand via the BRAT command palette: **Check for updates to all beta plugins**).

## Install (community plugins, after store approval)

Once Butter Editor is approved for the Obsidian community plugin store:

1. Settings → **Community plugins** → **Browse**
2. Search **Butter Editor** → Install → Enable
3. Settings → **Butter Editor** → tap **Start free trial**

Free 15-day trial, no card, no email. After the trial, $16 one-time for a Lifetime License covering all v1 updates.

## Use it

Open any note. Toggle into Butter via:

- the **view-cycle button** in the editor's top-right toolbar
- the command palette → **Butter: Toggle Butter mode**
- the file menu → **Open as Butter**

Type `/` at the start of a block for the slash-menu insert palette (headings, callouts, tables, code, math, wikilinks, footnotes).

## Pricing

One payment, $16. Covers Butter Editor v1 forever, all v1 updates included. Up to 5 devices per license. 14-day no-questions refund. v2 (when Obsidian's API forces a major rewrite) will be a paid upgrade priced lower for existing v1 customers.

See [buttereditor.com/pricing](https://buttereditor.com/pricing) for details.

## Network use

Butter Editor talks to one set of servers, and only for license operations. The plugin **never** transmits your note contents.

- **`https://api.buttereditor.com`** — license validation, trial activation, session refresh, device-list management. Called when the License tab is opened, when a session token is near expiry, when you start or end a trial, or when you deactivate a device.
- **`https://licenses.buttereditor.com`** — customer portal in your browser only. The plugin opens this URL externally when you tap *Manage license*; it is not a runtime endpoint.

All requests go through Obsidian's `requestUrl()` (not raw `fetch`) so they're CORS-safe on mobile and respect Obsidian's request semantics. There is no analytics service, no telemetry pipeline, no third-party tracker. Full data-handling details are in the [privacy policy](https://buttereditor.com/privacy).

## Privacy

Butter stores the bare minimum needed to run a license: customer email, device list, license-key registry. No analytics, no telemetry on your notes, no third-party tracking. The plugin runs locally; only license validation talks to a server (see *Network use* above).

Full policy: [buttereditor.com/privacy](https://buttereditor.com/privacy).

## Third-party code

Butter bundles the following open-source libraries. Their licenses are preserved in the compiled bundle and listed here for attribution:

- **[ProseMirror](https://prosemirror.net/)** (MIT) — the toolkit Butter's editor is built on (`prosemirror-model`, `prosemirror-state`, `prosemirror-view`, `prosemirror-transform`, `prosemirror-keymap`, `prosemirror-commands`, `prosemirror-history`, `prosemirror-inputrules`, `prosemirror-schema-list`, `prosemirror-tables`, `prosemirror-dropcursor`, `prosemirror-gapcursor`, `prosemirror-collab`).
- **[markdown-it](https://github.com/markdown-it/markdown-it)** (MIT) — the Markdown parser Butter uses on the way into ProseMirror, with our own custom plugin chain for Obsidian-flavored syntax.

The Obsidian-Markdown bridge, schema, serializer, NodeViews, and every other surface listed in *What it does* are original Butter Editor code, not derived from any other Obsidian plugin.

## Support

- **Bug reports / feature requests:** [GitHub Issues](https://github.com/spreadwell/butter-editor/issues)
- **Email:** support@buttereditor.com
- **Manage your licenses (billing / devices):** [licenses.buttereditor.com](https://licenses.buttereditor.com)

## License

Butter Editor is a commercial closed-source plugin. Source code is not published; only the compiled bundle is distributed. Use of the plugin is governed by the End User License Agreement at [buttereditor.com/terms](https://buttereditor.com/terms) — a valid Butter Editor license (or active trial) is required. See [LICENSE](./LICENSE) for redistribution terms.
