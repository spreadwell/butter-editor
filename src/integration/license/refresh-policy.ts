/** Pure policy for cached-session and refresh-failure decisions. */

export type LocalLicenseStatus = "valid" | "trial" | "expired";
export type RefreshFailureStatus = LocalLicenseStatus | "unknown";

export interface RefreshFailurePolicyInput {
  kind: string;
  persistedLastReason: string;
  wasInvalidated: boolean;
  everValidated: boolean;
  localStatus: LocalLicenseStatus;
}

export interface RefreshFailureDecision {
  status: RefreshFailureStatus;
  lastReason: string;
  clearCachedSession: boolean;
  persist: boolean;
}

function authoritativeReason(
  lastReason: string,
  wasInvalidated: boolean,
): "license_invalid" | "client_upgrade_required" | "" {
  if (lastReason === "license_invalid" || wasInvalidated) {
    return "license_invalid";
  }
  if (lastReason === "client_upgrade_required") {
    return "client_upgrade_required";
  }
  return "";
}

/** A known-invalid or protocol-incompatible license must re-check online. */
export function canUseCachedLicenseSession(
  lastReason: string,
  wasInvalidated: boolean,
): boolean {
  return authoritativeReason(lastReason, wasInvalidated) === "";
}

/**
 * Preserve authoritative negative decisions across restarts and outages.
 * Successful session application clears both persisted inputs in main.ts.
 */
export function decideLicenseRefreshFailure(
  input: RefreshFailurePolicyInput,
): RefreshFailureDecision {
  const currentReason = input.kind === "license_invalid"
    || input.kind === "client_upgrade_required"
    ? input.kind
    : authoritativeReason(input.persistedLastReason, input.wasInvalidated);

  if (currentReason === "license_invalid") {
    return {
      status: "expired",
      lastReason: currentReason,
      clearCachedSession: true,
      persist: input.kind === currentReason,
    };
  }
  if (currentReason === "client_upgrade_required") {
    return {
      status: "unknown",
      lastReason: currentReason,
      clearCachedSession: true,
      persist: input.kind === currentReason,
    };
  }

  return {
    status: input.everValidated ? input.localStatus : "unknown",
    lastReason: input.persistedLastReason,
    clearCachedSession: false,
    persist: false,
  };
}
