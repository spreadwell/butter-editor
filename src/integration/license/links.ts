/**
 * Customer-facing URLs surfaced from the License tab.
 *
 * Single source of truth so the renderers in settings-tab.ts don't
 * scatter string literals. All pages are served by the Worker at
 * `buttereditor.com/{pricing,docs,privacy,terms,refunds}`.
 */

export const LINKS = {
  docs: "https://github.com/spreadwell/butter-editor#readme",

  issues: "https://github.com/spreadwell/butter-editor/issues",

  // Forum link points at the Obsidian forum root - sensible fallback
  // for "community discussion" until a dedicated launch thread exists.
  forum: "https://forum.obsidian.md/",

  supportEmail: "support@buttereditor.com",

  privacy: "https://buttereditor.com/privacy",
  terms: "https://buttereditor.com/terms",
  refunds: "https://buttereditor.com/refunds",
  pricing: "https://buttereditor.com/pricing",

  // Buy flow goes through the Worker's /checkout/lifetime endpoint
  // which creates a customer-bound Polar checkout (or anonymous if
  // no session) and redirects to our branded /checkout surface. The
  // plugin never opens a raw Polar SKU URL - that way the underlying
  // SKU can swap at major-version launches without a plugin rebuild.
  buyLifetime: (deviceId?: string) =>
    `https://api.buttereditor.com/checkout/lifetime${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ""}`,

  licensePortal: "https://licenses.buttereditor.com",
} as const;
