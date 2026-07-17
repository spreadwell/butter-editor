# Butter Editor

A focused WYSIWYG editing view for [Obsidian](https://obsidian.md). Butter renders supported Markdown in place while you write, without converting your notes or introducing a proprietary file format. It sits alongside Source, Live Preview, and Reading, so you can switch views whenever you like. Available on desktop and mobile.

**Butter Editor is paid software.** Try the complete editor free for 15 days - **no account, email, or payment method required**. A $16 one-time v1 license never expires, includes every v1 update plus beta access, and supports up to five active devices by default. No subscription.

[Install from Obsidian Community Plugins](https://obsidian.md/plugins?id=butter-editor) | [Pricing and purchase](https://buttereditor.com/#pricing) | [Manage license](https://licenses.buttereditor.com)

![Formatting a Markdown note without raw syntax](assets/btr-markdown-formatting.gif)

## Why Butter?

Butter adds a visual editing view to the Markdown notes already in your vault. Unlike Live Preview, it keeps supported Markdown syntax out of the editing surface while you write. Your notes remain ordinary `.md` files, with no import step and no lock-in.

## Highlights

- **Visual Markdown editing:** Format headings, lists, tasks, links, tables, code, math, callouts, and more in place.
- **Obsidian-aware:** Work with wikilinks, embeds, tags, footnotes, block IDs, properties, and Bases embeds.
- **Block editing:** Select, drag, reorder, and transform complete blocks.
- **Fast insertion:** Type `/` at the start of a block to add common blocks and Obsidian structures.
- **Desktop and mobile:** Use the same plugin and license, with controls adapted for mouse, keyboard, and touch.
- **Your toolbar, your way:** Choose its position and customize desktop and mobile button layouts.

Standard Markdown formatting is the default. Optional rich-formatting tools - including text color, custom highlights, underline, superscript, and subscript - use inline HTML and may be less portable between Markdown applications.

## See it in action

**Select, reorder, and transform blocks**

![Block selection and editing](assets/btr-blocks.gif)

**Use context actions and optional rich formatting**

![Context menu and text colors](assets/btr-color.gif)

**Customize the toolbar for your workflow**

![Custom desktop toolbar](assets/btr-custom-toolbar.gif)

## Trial and license

The full-featured trial lasts 15 days on the installation where you start it. It does not require an account, email address, or payment card.

After the trial, Butter's editing view becomes read-only until you activate a license. Your notes are not locked: they remain ordinary Markdown files and stay available in Obsidian's other views.

A v1 license never expires and includes all v1 updates. It can be active on up to five devices by default. Use the [license portal](https://licenses.buttereditor.com) to recover a key, review active devices, or deactivate an old installation.

## Installation

Butter Editor requires Obsidian 1.7.2 or newer.

1. Open **Settings -> Community plugins**.
2. If Restricted Mode is active, select **Turn on community plugins**.
3. Select **Browse**, search for **Butter Editor**, and select **Install**.
4. Select **Enable**.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the [latest GitHub release](https://github.com/spreadwell/butter-editor/releases/latest) and place them in `<vault>/.obsidian/plugins/butter-editor/`. Reload Obsidian, then enable Butter Editor under **Community plugins**.

## Getting started

1. Open a Markdown note.
2. In the Command Palette, run `Butter Editor: Open current note in WYSIWYG view`.
3. On first use, complete the short setup and start the free trial or enter a license key.
4. Type `/` at the start of a block to open the insert menu. Use the view-mode button whenever you want to switch views.

## Privacy and network use

Butter does not send the contents of your notes to Butter's servers. Editing and Markdown processing happen locally.

For trial and license operations, the plugin contacts `api.buttereditor.com`. These requests can include a license key or session, a randomly generated installation ID, platform, plugin and protocol versions, and the requested activation action. The plugin sends an email address only when you request license recovery. Purchase, receipt, and account information is handled by Butter's commerce and licensing services.

Butter Editor does not send product-usage analytics, note telemetry, or third-party tracking data. See the [privacy policy](https://buttereditor.com/privacy) for full data-handling details.

Network destinations you may need to allow through a firewall:

- `api.buttereditor.com` - trial and license operations
- `licenses.buttereditor.com` - browser-based license and device management

## Support

- Bug reports and feature requests: [GitHub Issues](https://github.com/spreadwell/butter-editor/issues)
- Email: [support@buttereditor.com](mailto:support@buttereditor.com)
- Billing and devices: [licenses.buttereditor.com](https://licenses.buttereditor.com)

## Source and licensing

Butter Editor is proprietary software. Its source is publicly visible for inspection, security review, and Obsidian plugin review; it is not open source. Third-party dependencies remain subject to their own license terms and are listed in [`package.json`](./package.json) and [`package-lock.json`](./package-lock.json).

See the [source license](./LICENSE) and [End User License Agreement](https://buttereditor.com/terms). Editing with Butter Editor requires a valid license or an active trial; the read-only view remains available after a trial ends.
