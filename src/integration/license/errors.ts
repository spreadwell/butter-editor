/** Stable error-code mapping shared by the licensing client and tests. */

export type LicenseClientErrorKind =
  | "network"
  | "rate_limited"
  | "license_invalid"
  | "device_deactivated"
  | "device_cap"
  | "unauthorized"
  | "trial_used"
  | "invalid_input"
  | "invalid_token"
  | "polar_error"
  | "service_unavailable"
  | "client_upgrade_required"
  | "unknown";

export interface WorkerErrorBody {
  error?: string;
  code?: string;
}

export function classifyLicenseError(
  status: number,
  body: WorkerErrorBody | null,
): LicenseClientErrorKind {
  if (status === 0) return "network";
  // Stable Worker codes take precedence over status because rollout and
  // proxy layers may use different 4xx/5xx statuses for the same condition.
  if (body?.code === "client_upgrade_required") return "client_upgrade_required";
  if (body?.code === "service_unavailable") return "service_unavailable";
  if (body?.code === "polar_error") return "polar_error";
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 409 && body?.code === "trial_used") return "trial_used";
  if (status === 403 && body?.code === "device_deactivated") return "device_deactivated";
  if (status === 403 && body?.code === "device_cap") return "device_cap";
  if (status === 403 && body?.code === "license_invalid") return "license_invalid";
  if (status === 400) return "invalid_input";
  if (status === 410) return "invalid_token";
  if (status === 426) return "client_upgrade_required";
  // Preserve the legacy Polar-specific signal while the Polar adapter is
  // still the live merchant-of-record integration.
  if (status === 502) return "polar_error";
  if (status === 503) return "service_unavailable";
  return "unknown";
}
