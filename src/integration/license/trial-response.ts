export interface InstantTrialResponse {
  licenseKey: string;
  expiresAt: string;
}

export function parseInstantTrialResponse(value: unknown): InstantTrialResponse | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const licenseKey = typeof record.licenseKey === "string"
    ? record.licenseKey.trim()
    : "";
  const expiresAt = typeof record.expiresAt === "string"
    ? record.expiresAt.trim()
    : "";

  if (!licenseKey || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
    return null;
  }

  return { licenseKey, expiresAt };
}
