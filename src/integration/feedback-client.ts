import { Platform, apiVersion, requestUrl } from "obsidian";

const FEEDBACK_ENDPOINT = "https://api.buttereditor.com/feedback";
const FEEDBACK_TIMEOUT_MS = 10_000;

export type FeedbackKind = "bug" | "feature" | "other";
export type FeedbackAccessStatus = "trial" | "paid" | "unknown";

export interface FeedbackDiagnostics {
  pluginVersion: string;
  obsidianVersion: string;
  platform: "windows" | "macos" | "linux" | "ios" | "android" | "unknown";
  architecture?: string;
  logicalProcessors?: number;
  memoryGb?: number;
  display: string;
  touchPoints: number;
}

export interface FeedbackSubmission {
  kind: FeedbackKind;
  subject: string;
  message: string;
  contactEmail?: string;
  accessStatus: FeedbackAccessStatus;
  diagnostics?: FeedbackDiagnostics;
}

function platformName(): FeedbackDiagnostics["platform"] {
  if (Platform.isWin) return "windows";
  if (Platform.isMacOS) return "macos";
  if (Platform.isIosApp) return "ios";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isLinux) return "linux";
  return "unknown";
}

export function inferArchitecture(userAgent: string): string | undefined {
  if (/arm64|aarch64/i.test(userAgent)) return "arm64";
  if (/x86_64|x64|win64|amd64/i.test(userAgent)) return "x64";
  if (/i[3-6]86|win32/i.test(userAgent)) return "x86";
  return undefined;
}

export function collectFeedbackDiagnostics(pluginVersion: string): FeedbackDiagnostics {
  const nav = window.navigator as Navigator & { deviceMemory?: number };
  const logicalProcessors = Number.isFinite(nav.hardwareConcurrency) && nav.hardwareConcurrency > 0
    ? nav.hardwareConcurrency
    : undefined;
  const memoryGb = Number.isFinite(nav.deviceMemory) && (nav.deviceMemory ?? 0) > 0
    ? nav.deviceMemory
    : undefined;
  const width = Math.round(window.screen.width * (window.devicePixelRatio || 1));
  const height = Math.round(window.screen.height * (window.devicePixelRatio || 1));
  const ratio = Math.round((window.devicePixelRatio || 1) * 100) / 100;
  return {
    pluginVersion,
    obsidianVersion: apiVersion,
    platform: platformName(),
    architecture: inferArchitecture(nav.userAgent),
    logicalProcessors,
    memoryGb,
    display: `${width} x ${height} @ ${ratio}x`,
    touchPoints: Number.isFinite(nav.maxTouchPoints) ? nav.maxTouchPoints : 0,
  };
}

export async function submitFeedback(
  submission: FeedbackSubmission,
): Promise<{ reportId: string }> {
  const response = await new Promise<Awaited<ReturnType<typeof requestUrl>>>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Feedback request timed out"));
    }, FEEDBACK_TIMEOUT_MS);
    requestUrl({
      url: FEEDBACK_ENDPOINT,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(submission),
      throw: false,
    }).then((value) => {
      window.clearTimeout(timeout);
      resolve(value);
    }, (error: unknown) => {
      window.clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
  let body: unknown = null;
  try { body = JSON.parse(response.text); } catch { /* handled below */ }
  if (response.status < 200 || response.status >= 300) {
    const message = body && typeof body === "object" && "error" in body
      ? String(body.error)
      : `Feedback request failed (${response.status})`;
    throw new Error(message);
  }
  const reportId = body && typeof body === "object" && "reportId" in body
    ? String(body.reportId)
    : "";
  if (!reportId) throw new Error("Feedback service returned an invalid response");
  return { reportId };
}
