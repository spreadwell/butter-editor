/**
 * Butter Editor licensing - Worker client.
 *
 * Wraps HTTP calls to the Cloudflare Worker at WORKER_BASE. All
 * methods use Obsidian's `requestUrl()` (not native `fetch`) because:
 *   1. requestUrl bypasses CORS and works on mobile.
 *   2. requestUrl returns the body as both `.text` and `.json` without
 *      throwing on non-2xx - we explicitly check `status` instead.
 *
 * Errors surface as `LicenseClientError` with a typed `kind` so the
 * settings UI can show the right message (rate-limited, invalid key,
 * trial-already-used, network problem, etc.) without parsing strings.
 *
 * Architecture reference lives in the private planning notes.
 */

import { requestUrl } from "obsidian";

export const WORKER_BASE = "https://api.buttereditor.com";

/** Hard cap on each Worker call. The Worker itself has 8s timeouts on
 * its upstream Polar/Resend calls, so 10s leaves a small margin. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface TrialResponse {
  checkoutUrl: string;
  pollToken: string;
}

export interface InstantTrialResponse {
  licenseKey: string;
  expiresAt: string;
}

export interface TrialPollResponse {
  status: "pending" | "ready";
  licenseKey?: string;
  expiresAt?: string;
}

export interface SessionResponse {
  sessionToken: string;
  expiresAt: string;
  customerId?: string;
  email?: string;
  tier?: "v1" | "v2";
  upgrade?: { licenseKey: string; customerId: string };
}

/** Per-device payload returned by `GET /devices`. */
export interface DeviceWireRecord {
  deviceId: string;
  /** ms-epoch when the device first activated on this license. */
  activatedAt: number;
  /** ms-epoch of the most recent /session call from this device. */
  lastSeenAt: number;
  /** True for the device whose sessionToken made the request. */
  isCurrent: boolean;
}

export interface DevicesListResponse {
  devices: DeviceWireRecord[];
}

export type LicenseClientErrorKind =
  | "network"             // request timed out, DNS failed, etc.
  | "rate_limited"        // 429 from Worker
  | "license_invalid"     // 403 from /session - key revoked or never existed
  | "device_deactivated"  // 403 from /session or /devices - this device was deactivated
  | "device_cap"          // 403 from /session or /trial/poll - customer at the 5-device cap and this is a new device
  | "unauthorized"        // 401 - missing/expired session token
  | "trial_used"          // 409 from /trial - email or device already used
  | "invalid_input"       // 400 - caller bug or malformed input
  | "invalid_token"       // 410 - magic-link or trial-poll token expired/used
  | "polar_error"         // 502 - Worker reached but Polar upstream failed
  | "unknown";            // 5xx other than 502, or unexpected shape

export class LicenseClientError extends Error {
  constructor(
    public kind: LicenseClientErrorKind,
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "LicenseClientError";
  }
}

interface WorkerErrorBody {
  error?: string;
  code?: string;
}

function classifyError(status: number, body: WorkerErrorBody | null): LicenseClientErrorKind {
  if (status === 0) return "network";
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 409 && body?.code === "trial_used") return "trial_used";
  if (status === 403 && body?.code === "device_deactivated") return "device_deactivated";
  if (status === 403 && body?.code === "device_cap") return "device_cap";
  if (status === 403 && body?.code === "license_invalid") return "license_invalid";
  if (status === 400) return "invalid_input";
  if (status === 410) return "invalid_token";
  if (status === 502) return "polar_error";
  return "unknown";
}

/** Wrap a promise in a timeout. Resolves to a sentinel `null` if the
 * timeout fires, since we want to surface a typed network error rather
 * than throw an uncatchable rejection. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => {
      reject(new LicenseClientError("network", 0, `Worker call timed out after ${ms}ms`));
    }, ms);
    p.then((v) => { window.clearTimeout(t); resolve(v); })
     .catch((e: unknown) => {
       window.clearTimeout(t);
       reject(e instanceof Error ? e : new Error(String(e)));
     });
  });
}

interface RawResponse {
  status: number;
  body: unknown;
}

async function call(
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown; bearer?: string },
): Promise<RawResponse> {
  const url = `${WORKER_BASE}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept": "application/json",
  };
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  let res;

  try {
    res = await withTimeout(requestUrl({
      url,
      method: init.method,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      throw: false,
    }), REQUEST_TIMEOUT_MS);
  } catch (err) {
    console.error(`[LicenseClient] !! Error on ${init.method} ${url}:`, err);
    if (err instanceof LicenseClientError) throw err;
    // requestUrl throws on TLS / DNS / hard network failures even with
    // throw:false. Fold those into a network-kind error.
    throw new LicenseClientError(
      "network",
      0,
      `Worker call to ${path} failed: ${(err as Error).message}`,
    );
  }
  let body: unknown = null;
  try { body = JSON.parse(res.text); } catch { /* non-JSON; leave null */ }
  return { status: res.status, body };
}

function expectOk<T>(path: string, res: RawResponse): T {
  if (res.status >= 200 && res.status < 300) {
    return res.body as T;
  }
  const errBody = (res.body as WorkerErrorBody | null) ?? null;
  throw new LicenseClientError(
    classifyError(res.status, errBody),
    res.status,
    errBody?.error ?? `Worker call to ${path} failed (${res.status})`,
    errBody,
  );
}

export class LicenseClient {
  /**
   * Check if the given device ID is eligible for a free trial.
   */
  async checkTrialEligibility(deviceId: string): Promise<{ eligible: boolean }> {
    const res = await call(`/trial/eligibility?device_id=${encodeURIComponent(deviceId)}`, { method: "GET" });
    return expectOk<{ eligible: boolean }>("/trial/eligibility", res);
  }

  /**
   * Start a trial. Worker dedupes by (emailHash, deviceId) and returns
   * a hosted checkout URL the user opens in their browser. The plugin
   * then polls /trial/poll with the returned token.
   *
   * Throws `LicenseClientError("trial_used")` if the email or device
   * has already started a trial.
   */
  async startTrial(deviceId: string, email?: string): Promise<TrialResponse> {
    const body: Record<string, string> = { deviceId };
    if (email) body.email = email;
    const res = await call("/trial", { method: "POST", body });
    return expectOk<TrialResponse>("/trial", res);
  }

  async startInstantTrial(deviceId: string): Promise<InstantTrialResponse> {
    const res = await call("/trial/instant", { method: "POST", body: { deviceId } });
    return expectOk<InstantTrialResponse>("/trial/instant", res);
  }

  /**
   * Poll for trial-key issuance. Returns `{status: "pending"}` until
   * the customer completes Polar's hosted checkout, then
   * `{status: "ready", licenseKey, expiresAt}`.
   *
   * Token is HMAC-signed by the Worker (2-hour TTL). Polling cadence
   * is the caller's responsibility.
   */
  async pollTrial(pollToken: string): Promise<TrialPollResponse> {
    const res = await call(
      `/trial/poll?token=${encodeURIComponent(pollToken)}`,
      { method: "GET" },
    );
    return expectOk<TrialPollResponse>("/trial/poll", res);
  }

  /**
   * Validate a license key against Polar and mint a 7-day signed
   * session token. Plugin caches the token in `data.json` and
   * re-validates on a daily cadence (with indefinite offline grace).
   *
   * Throws `LicenseClientError("license_invalid")` for revoked /
   * never-existed keys.
   */
  async validateAndIssueSession(
    licenseKey: string,
    deviceId: string,
  ): Promise<SessionResponse> {
    const res = await call("/session", {
      method: "POST",
      body: { licenseKey, deviceId },
    });
    return expectOk<SessionResponse>("/session", res);
  }

  /**
   * Request a magic-link recovery email. The Worker always returns
   * `{ok: true}` regardless of whether the email is on file - that's
   * intentional (no email enumeration). The actual send only happens
   * when a Polar customer matches.
   *
   * Resolves on success or no-customer; throws only on network / rate
   * limit / Worker errors.
   */
  async requestRecovery(email: string): Promise<void> {
    const res = await call("/magic-link/request", {
      method: "POST",
      body: { email },
    });
    expectOk<{ ok: true }>("/magic-link/request", res);
  }

  /**
   * List devices using this license. Authenticated via the caller's
   * own session token. The current device is flagged via `isCurrent`
   * so the UI can label it "This device". Worker 1.7.0+.
   *
   * Throws `LicenseClientError("unauthorized")` if the session token
   * is missing/expired or `("device_deactivated")` if the caller's
   * own device was deactivated from elsewhere.
   */
  async listDevices(sessionToken: string): Promise<DeviceWireRecord[]> {
    const res = await call("/devices", { method: "GET", bearer: sessionToken });
    const body = expectOk<DevicesListResponse>("/devices", res);
    return body.devices;
  }

  /**
   * Deactivate a device by id. Authenticated via the caller's own
   * session token; the deviceId in the path can be either the
   * caller's own (deactivate-this-device) or any sibling device on
   * the same license. Idempotent for already-deactivated entries;
   * 404s for ids not on this license. Worker 1.7.0+.
   */
  async deactivateDevice(sessionToken: string, deviceId: string): Promise<void> {
    const res = await call(`/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      bearer: sessionToken,
    });
    expectOk<{ ok: true }>(`/devices/${deviceId}`, res);
  }
}
