/**
 * Customer-facing policy constants for Butter Editor's licensing copy.
 * Keep these in sync with the licensing service constants so plugin
 * copy matches server-side enforcement.
 *
 * Bumping `TRIAL_LENGTH_DAYS` here also needs the Worker's default
 * policy and pre-activation product copy updated to match.
 */

/** Default free-trial length. Protocol-v2 sessions may override it per
 * entitlement; this remains the fallback for older Workers and
 * pre-activation marketing copy. */
export const TRIAL_LENGTH_DAYS = 15;

/** Customer-facing lifetime-license price shown in onboarding. Keep
 * this in sync with the Butter Editor site and active checkout provider. */
export const LIFETIME_LICENSE_PRICE = "$16";

/** Default active-device limit. Protocol-v2 sessions may override it per
 * entitlement in the 1-100 range; the Worker remains authoritative. */
export const MAX_DEVICES_PER_CUSTOMER = 5;
