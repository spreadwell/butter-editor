# Butter Editor

A WYSIWYG editing mode for [Obsidian](https://obsidian.md). Headings look like headings, bold is bold, embeds and callouts render in place. Your files stay plain markdown that any other tool can read.

**Website:** [buttereditor.com](https://buttereditor.com) · **Pricing:** [buttereditor.com/pricing](https://buttereditor.com/pricing) · **Manage your licenses:** [licenses.buttereditor.com](https://licenses.buttereditor.com)

## What it does

Butter adds a fourth view mode alongside Obsidian's Source, Live Preview, and Reading. You toggle it per note. The file on disk never changes shape.

It renders the full Obsidian-flavored markdown surface in place: headings, bold, italic, strikethrough, lists, task lists, tables, code fences, math, footnotes, highlights, wikilinks, embeds (including sized), tags, block IDs, callouts (including nested ones with code or math or lists inside), inline and block comments.

Other things you can do:

- Reorder blocks with a drag handle that appears in the gutter on hover. Pick up a paragraph, callout, table, or code block and drop it somewhere else. Mobile uses long-press.
- Edit wikilinks, tags, embeds, math, and footnotes inline. Double-click any of them and a small panel opens for editing.
- Color text or apply colored highlights from the toolbar. Or keep your source pure markdown by turning off HTML formatting in settings.
- Strip every styling mark from a selection with the clear-formatting button.

Files round-trip cleanly. An 80+ case test corpus runs on every release so save and reopen cycles don't drift your content.

The mobile experience uses the same editor with a touch-tuned toolbar and swipe drawers for block actions.

## Install via BRAT

Butter Editor is in beta and not yet in the Obsidian community plugin store. To install and receive auto-updates:

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the community plugins browser.
2. In BRAT settings, click "Add Beta plugin" and paste: `spreadwell/butter-editor`
3. Enable Butter Editor in Settings → Community plugins.

BRAT checks for updates on Obsidian startup, or on demand via the BRAT command palette ("Check for updates to all beta plugins").

## Install (community plugins, after store approval)

Once Butter Editor is approved for the Obsidian community plugin store:

1. Settings → Community plugins → Browse
2. Search for "Butter Editor", then Install and Enable.
3. Settings → Butter Editor → "Start free trial".

15-day free trial. No card, no email. After that, $16 one-time for a Lifetime License covering all v1 updates.

## Use it

Open any note and toggle into Butter via:

- the view-cycle button in the editor's top-right toolbar
- the command palette ("Butter: Toggle Butter mode")
- the file menu ("Open as Butter")

Type `/` at the start of a block to open the slash menu (headings, callouts, tables, code, math, wikilinks, footnotes).

## Pricing

One payment, $16. Covers Butter Editor v1 forever, all v1 updates included. Up to 5 devices per license. 14-day no-questions refund. When Obsidian's API eventually forces a major rewrite (v2), existing v1 customers get a discounted upgrade.

See [buttereditor.com/pricing](https://buttereditor.com/pricing) for details.

## Network use

Butter talks to one set of servers, and only for license operations. The plugin never transmits your note contents.

- `https://api.buttereditor.com` handles license validation, trial activation, session refresh, and device-list management. It's called when the License tab is opened, when a session token is near expiry, when you start or end a trial, or when you deactivate a device.
- `https://licenses.buttereditor.com` is your customer portal in a browser. The plugin opens it externally when you tap "Manage license"; nothing else uses it.

All requests go through Obsidian's `requestUrl()` so they're CORS-safe on mobile. No analytics, no telemetry, no third-party trackers. Data-handling details are in the [privacy policy](https://buttereditor.com/privacy).

## Privacy

Butter stores what a license needs and nothing else: customer email, device list, license-key registry. No analytics, no telemetry on your notes, no third-party tracking. The plugin runs locally. Only license validation talks to a server (see Network use above).

Full policy: [buttereditor.com/privacy](https://buttereditor.com/privacy).

## Third-party code

Butter bundles two open-source libraries:

- [ProseMirror](https://prosemirror.net/) (MIT), for the editor toolkit.
- [markdown-it](https://github.com/markdown-it/markdown-it) (MIT), for the markdown parser.

Their licenses are preserved in the compiled bundle. Everything else (Obsidian-Markdown bridge, schema, serializer, NodeViews, and the rest) is original Butter Editor code.

## Support

- Bug reports and feature requests: [GitHub Issues](https://github.com/spreadwell/butter-editor/issues)
- Email: support@buttereditor.com
- Billing and devices: [licenses.buttereditor.com](https://licenses.buttereditor.com)

## License

Butter Editor is a commercial closed-source plugin. Source code is not published; only the compiled bundle is distributed. Use is governed by the End User License Agreement at [buttereditor.com/terms](https://buttereditor.com/terms) and requires a valid Butter Editor license (or an active trial). See [LICENSE](./LICENSE) for redistribution terms.
