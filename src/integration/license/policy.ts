/**
 * Customer-facing policy constants for Butter Editor's licensing copy.
 * Keep these in sync with the licensing service constants so plugin
 * copy matches server-side enforcement.
 *
 * Bumping `TRIAL_LENGTH_DAYS` here also needs:
 *   1. Same value in the Worker's `policy.ts`.
 *   2. Polar's trial-product `expires_in_days` updated to match.
 *   3. A redeploy of the Worker.
 */

/** Length of the free trial in days. Drives plugin-side copy in
 * Settings → License (trial entry state + trial-active state). The
 * actual key expiry comes from Polar via `/trial/poll`'s `expiresAt`;
 * this constant is only for marketing-style copy where we don't have
 * a real expiry yet. */
export const TRIAL_LENGTH_DAYS = 15;

/** Customer-facing lifetime-license price shown in onboarding. Keep
 * this in sync with the Butter Editor site and Polar checkout. */
export const LIFETIME_LICENSE_PRICE = "$16";

/** Maximum active devices per customer. Enforced server-side at
 * `/session` and `/trial/poll-ready` by the Worker - the plugin
 * surfaces this in copy ("up to 5 devices") and handles the
 * `device_cap` error response from the Worker with a friendly
 * "deactivate one from your account portal" message. */
export const MAX_DEVICES_PER_CUSTOMER = 5;
