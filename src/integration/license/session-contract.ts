/**
 * Runtime contract for the provider-neutral licensing session protocol.
 *
 * The Worker keeps the original response fields for older Butter builds and
 * adds the entitlement metadata below for protocol-v2 clients. Treat every
 * additive field as untrusted input: an older Worker may omit it, while a
 * partially rolled-out Worker must not be able to poison persisted settings
 * with a malformed value.
 */

import {
  MAX_DEVICES_PER_CUSTOMER,
  TRIAL_LENGTH_DAYS,
} from "./policy";

export const LICENSE_PROTOCOL_VERSION = "2";
export const LICENSE_PROTOCOL_HEADER = "x-butter-license-protocol";

export type ActivationIntent = "refresh" | "activate";
export type LicenseType = "trial" | "lifetime";

export interface IssuedSessionResponse {
  sessionToken: string;
  expiresAt: string;
  customerId?: string;
  email?: string;
  tier?: "v1" | "v2";
  upgrade?: never;
  licenseType?: LicenseType;
  licenseStartedAt?: string;
  licenseExpiresAt?: string | null;
  trialLengthDays?: number;
  deviceLimit?: number;
}

/** Legacy-compatible response used when a trial device has already bought a
 * lifetime license. The caller stores the replacement key and immediately
 * validates it, so no session token is expected on this response. */
export interface UpgradeSessionResponse {
  upgrade: { licenseKey: string; customerId: string };
  sessionToken?: never;
  expiresAt?: never;
}

export type SessionResponse = IssuedSessionResponse | UpgradeSessionResponse;

export interface StoredLicenseMetadata {
  licenseType: LicenseType | "";
  licenseStartedAt: number;
  licenseExpiresAt: number;
  trialLengthDays: number;
  deviceLimit: number;
}

export const DEFAULT_STORED_LICENSE_METADATA: StoredLicenseMetadata = {
  licenseType: "",
  licenseStartedAt: 0,
  licenseExpiresAt: 0,
  trialLengthDays: TRIAL_LENGTH_DAYS,
  deviceLimit: MAX_DEVICES_PER_CUSTOMER,
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isoDateString(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= min
    && value <= max
    ? value
    : undefined;
}

function storedTimestamp(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 8_640_000_000_000_000
    ? value
    : 0;
}

/** Parse a successful `/session` body and discard malformed optional fields. */
export function parseSessionResponse(value: unknown): SessionResponse | null {
  const body = asRecord(value);
  if (!body) return null;

  const upgrade = asRecord(body.upgrade);
  if (upgrade) {
    const licenseKey = nonEmptyString(upgrade.licenseKey);
    const upgradeCustomerId = nonEmptyString(upgrade.customerId);
    if (licenseKey && upgradeCustomerId) {
      return { upgrade: { licenseKey, customerId: upgradeCustomerId } };
    }
  }

  const sessionToken = nonEmptyString(body.sessionToken);
  const expiresAt = isoDateString(body.expiresAt);
  if (!sessionToken || !expiresAt) return null;

  const parsed: IssuedSessionResponse = { sessionToken, expiresAt };
  const customerId = nonEmptyString(body.customerId);
  const email = nonEmptyString(body.email);
  if (customerId) parsed.customerId = customerId;
  if (email) parsed.email = email;
  if (body.tier === "v1" || body.tier === "v2") parsed.tier = body.tier;

  if (body.licenseType === "trial" || body.licenseType === "lifetime") {
    parsed.licenseType = body.licenseType;
  }
  const licenseStartedAt = isoDateString(body.licenseStartedAt);
  if (licenseStartedAt) parsed.licenseStartedAt = licenseStartedAt;
  if (body.licenseExpiresAt === null) {
    parsed.licenseExpiresAt = null;
  } else {
    const licenseExpiresAt = isoDateString(body.licenseExpiresAt);
    if (licenseExpiresAt) parsed.licenseExpiresAt = licenseExpiresAt;
  }
  const trialLengthDays = boundedInteger(body.trialLengthDays, 1, 365);
  const deviceLimit = boundedInteger(body.deviceLimit, 1, 100);
  if (trialLengthDays !== undefined) parsed.trialLengthDays = trialLengthDays;
  if (deviceLimit !== undefined) parsed.deviceLimit = deviceLimit;

  return parsed;
}

/** Sanitize the persisted subset read from an existing `data.json`. */
export function sanitizeStoredLicenseMetadata(
  value: Partial<Record<keyof StoredLicenseMetadata, unknown>>,
): StoredLicenseMetadata {
  return {
    licenseType: value.licenseType === "trial" || value.licenseType === "lifetime"
      ? value.licenseType
      : "",
    licenseStartedAt: storedTimestamp(value.licenseStartedAt),
    licenseExpiresAt: storedTimestamp(value.licenseExpiresAt),
    trialLengthDays: boundedInteger(value.trialLengthDays, 1, 365)
      ?? TRIAL_LENGTH_DAYS,
    deviceLimit: boundedInteger(value.deviceLimit, 1, 100)
      ?? MAX_DEVICES_PER_CUSTOMER,
  };
}

/**
 * Resolve optional protocol-v2 metadata over the last known-good state.
 * Missing fields preserve compatibility with the original Worker. Explicit
 * `null` clears lifetime expiry, but is ignored for a trial because a trial
 * without an expiry must never be interpreted as unlimited. Returns `null`
 * when an explicitly typed trial has no wire or last-known expiry.
 */
export function resolveSessionLicenseMetadata(
  current: StoredLicenseMetadata,
  session: IssuedSessionResponse,
  inferredType: LicenseType,
  now: number,
): StoredLicenseMetadata | null {
  const licenseType = session.licenseType ?? inferredType;
  const wireStartedAt = session.licenseStartedAt
    ? Date.parse(session.licenseStartedAt)
    : Number.NaN;
  const wireExpiresAt = typeof session.licenseExpiresAt === "string"
    ? Date.parse(session.licenseExpiresAt)
    : Number.NaN;

  let licenseExpiresAt = current.licenseExpiresAt;
  if (Number.isFinite(wireExpiresAt)) {
    licenseExpiresAt = wireExpiresAt;
  } else if (licenseType === "lifetime") {
    // A lifetime entitlement has no license expiry. This also clears stale
    // trial expiry when an old Worker response omits the new fields.
    licenseExpiresAt = 0;
  }

  let trialLengthDays = session.trialLengthDays ?? current.trialLengthDays;
  let licenseStartedAt = Number.isFinite(wireStartedAt)
    ? wireStartedAt
    : current.licenseStartedAt;

  if (licenseType === "trial") {
    // An explicitly typed protocol-v2 trial must have a recoverable expiry.
    // A missing wire value may reuse a last-known positive expiry, but a new
    // explicit trial must never resolve to the legacy "unknown" sentinel 0.
    if (session.licenseType === "trial" && licenseExpiresAt <= 0) return null;

    // If protocol v2 supplied both boundaries but omitted the length, derive
    // it so custom trials still render accurately during a mixed rollout.
    if (
      session.trialLengthDays === undefined
      && licenseStartedAt > 0
      && licenseExpiresAt > licenseStartedAt
    ) {
      const derivedDays = Math.ceil(
        (licenseExpiresAt - licenseStartedAt) / (24 * 60 * 60 * 1000),
      );
      trialLengthDays = Math.max(1, Math.min(365, derivedDays));
    }
    if (!licenseStartedAt && licenseExpiresAt > 0) {
      licenseStartedAt = Math.max(
        0,
        licenseExpiresAt - trialLengthDays * 24 * 60 * 60 * 1000,
      );
    }
  }

  // Legacy lifetime sessions do not carry an authoritative purchase/start
  // date. Keep that value unknown so the UI can fall back to the install's
  // historical `activatedAt` instead of replacing it with today's date.
  if (!licenseStartedAt && licenseType === "trial") licenseStartedAt = now;

  return {
    licenseType,
    licenseStartedAt,
    licenseExpiresAt,
    trialLengthDays,
    deviceLimit: session.deviceLimit ?? current.deviceLimit,
  };
}
