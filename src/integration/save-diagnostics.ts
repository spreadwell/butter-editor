import type { SavePreflightFailedAttempt } from "../core/save-preflight";

export const SAVE_DIAGNOSTIC_LIMIT = 20;
export const SAVE_DIAGNOSTIC_DAYS = 30;
const MAX_COUNT = 1_000_000_000;
const MAX_HISTORY_BYTES = 65_536;
const DAY = 86_400_000;

const reasonCodes = {
  "editor is not available": "editor-unavailable",
  "property save failed": "property-save",
  "scheduled save failed": "scheduled-save",
  "closing save target changed": "closing-target-changed",
  "closing recovery checkpoint failed": "closing-checkpoint",
  "save preparation failed": "save-preparation",
  "save changed before native clear": "native-clear",
  "save changed before native write": "native-write-target",
  "native file write failed": "native-write",
  "native save acknowledgement failed": "native-acknowledgement",
  "native file source verification failed": "native-source-verification",
} as const;

export const SAVE_FAILURE_CODES = [
  ...Object.values(reasonCodes), "preflight", "other-save", "recovery-write", "recovery-cleanup",
] as const;
export type SaveFailureCode = (typeof SAVE_FAILURE_CODES)[number];

export interface SaveDiagnosticAttempt {
  path: "source-preserving" | "canonical";
  stage: "normalize" | "fingerprint" | "availability" | "serialize" | "finalize" | "reparse" | "compare";
  difference?: {
    kind: "node-type" | "text" | "marks" | "attribute" | "children";
    location: string;
  };
}

export interface SaveDiagnosticFailure {
  firstAt: number;
  lastAt: number;
  pluginVersion: string;
  code: SaveFailureCode;
  occurrences: number;
  attempts?: SaveDiagnosticAttempt[];
}

export interface SaveDiagnosticsReport {
  version: 1;
  capturedAt: number;
  retentionDays: 30;
  maxFailures: 20;
  historyStatus: "available" | "unavailable" | "memory-only";
  session: {
    startedAt: number;
    successfulSaveReports: number;
    blockedSaveReports: number;
    recoveryCopiesWritten: number;
    recoveryWriteFailures: number;
    recoveryCleanupFailures: number;
  };
  recentFailures: SaveDiagnosticFailure[];
}

interface DiagnosticStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

const stages = new Set(["normalize", "fingerprint", "availability", "serialize", "finalize", "reparse", "compare"]);
const differenceKinds = new Set(["node-type", "text", "marks", "attribute", "children"]);
const codes = new Set<string>(SAVE_FAILURE_CODES);
const versionPattern = /^(?:unknown|\d+\.\d+\.\d+(?:-dev\.\d+-[A-Za-z0-9]{1,40}-[a-f0-9]{7,40})?)$/;
const locationPattern = /^doc(?:\.content\[\d{1,6}\]){0,32}\.(?:type|text|marks|attrs|content)$/;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: number) => Math.min(MAX_COUNT, value + 1);

/** Reconstruct only fixed vocabulary and numeric tree locations. Never copy an
 * exception, candidate, fingerprint, attribute value, note identity, or source. */
function diagnosticAttempts(value: unknown): SaveDiagnosticAttempt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attempts: SaveDiagnosticAttempt[] = [];
  for (const item of value.slice(0, 2)) {
    const raw = object(item);
    if (!raw || (raw.path !== "canonical" && raw.path !== "source-preserving") ||
      typeof raw.stage !== "string" || !stages.has(raw.stage)) continue;
    const attempt: SaveDiagnosticAttempt = { path: raw.path, stage: raw.stage as SaveDiagnosticAttempt["stage"] };
    const difference = object(raw.difference);
    const location = difference?.location ?? difference?.path;
    if (difference && typeof difference.kind === "string" && differenceKinds.has(difference.kind) && typeof location === "string" &&
      location.length <= 768 && locationPattern.test(location)) {
      attempt.difference = { kind: difference.kind as NonNullable<SaveDiagnosticAttempt["difference"]>["kind"], location };
    }
    attempts.push(attempt);
  }
  return attempts.length ? attempts : undefined;
}

function readFailure(value: unknown, now: number): SaveDiagnosticFailure | null {
  const raw = object(value);
  if (!raw || typeof raw.firstAt !== "number" || !Number.isSafeInteger(raw.firstAt) ||
    typeof raw.lastAt !== "number" || !Number.isSafeInteger(raw.lastAt) || raw.firstAt < 0 ||
    raw.firstAt > raw.lastAt || raw.firstAt < now - SAVE_DIAGNOSTIC_DAYS * DAY || raw.lastAt > now + 300_000 ||
    typeof raw.pluginVersion !== "string" || !versionPattern.test(raw.pluginVersion) ||
    typeof raw.code !== "string" || !codes.has(raw.code) || typeof raw.occurrences !== "number" ||
    !Number.isSafeInteger(raw.occurrences) || raw.occurrences < 1 || raw.occurrences > MAX_COUNT) return null;
  return {
    firstAt: raw.firstAt, lastAt: raw.lastAt, pluginVersion: raw.pluginVersion,
    code: raw.code as SaveFailureCode, occurrences: raw.occurrences,
    ...(diagnosticAttempts(raw.attempts) ? { attempts: diagnosticAttempts(raw.attempts) } : {}),
  };
}

/** Bounded, content-free local history. Diagnostic I/O never participates in
 * save admission, native writes, acknowledgements, or recovery decisions. */
export class SaveDiagnostics {
  private failures: SaveDiagnosticFailure[] = [];
  private writes: Promise<void> | null = null;
  private writePending = false;
  private loading: Promise<void> | null = null;
  private loaded: boolean;
  private historyStatus: SaveDiagnosticsReport["historyStatus"];
  private session: SaveDiagnosticsReport["session"];
  private readonly pluginVersion: string;

  constructor(pluginVersion: string, private storage?: DiagnosticStorage, private now = () => Date.now()) {
    this.pluginVersion = versionPattern.test(pluginVersion) ? pluginVersion : "unknown";
    this.loaded = !storage;
    this.historyStatus = storage ? "unavailable" : "memory-only";
    this.session = { startedAt: now(), successfulSaveReports: 0, blockedSaveReports: 0,
      recoveryCopiesWritten: 0, recoveryWriteFailures: 0, recoveryCleanupFailures: 0 };
  }

  load(): Promise<void> {
    if (!this.storage) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.readHistory().finally(() => {
        this.loaded = true;
        if (this.writePending) void this.flush();
      });
    }
    return this.loading;
  }

  private async readHistory(): Promise<void> {
    try {
      const text = await this.storage!.read();
      if (text !== null) {
        if (text.length > MAX_HISTORY_BYTES) throw new Error("Diagnostic history exceeds limit");
        const raw = object(JSON.parse(text));
        if (raw?.version !== 1 || !Array.isArray(raw.recentFailures)) throw new Error("Invalid diagnostic history");
        const now = this.now();
        const retained = raw.recentFailures.slice(-SAVE_DIAGNOSTIC_LIMIT)
          .map(item => readFailure(item, now)).filter((item): item is SaveDiagnosticFailure => item !== null)
          .sort((a, b) => a.lastAt - b.lastAt);
        // Loading never holds up the editor. Merge failures that arrived while
        // local history was being read instead of replacing the live buffer.
        this.failures = [...retained, ...this.failures].sort((a, b) => a.lastAt - b.lastAt).slice(-SAVE_DIAGNOSTIC_LIMIT);
      }
      this.historyStatus = "available";
      // Also expire on disk and remove unrecognized fields after loading.
      if (text !== null) this.writePending = true;
    } catch { this.historyStatus = "unavailable"; }
  }

  saved(): void { this.session.successfulSaveReports = count(this.session.successfulSaveReports); }

  blocked(reason: string, attempts?: readonly SavePreflightFailedAttempt[]): void {
    this.session.blockedSaveReports = count(this.session.blockedSaveReports);
    const code = attempts ? "preflight" : Object.prototype.hasOwnProperty.call(reasonCodes, reason)
      ? reasonCodes[reason as keyof typeof reasonCodes] : "other-save";
    this.failure(code, diagnosticAttempts(attempts));
  }

  recoveryWritten(): void { this.session.recoveryCopiesWritten = count(this.session.recoveryCopiesWritten); }
  recoveryWriteFailed(): void {
    this.session.recoveryWriteFailures = count(this.session.recoveryWriteFailures);
    this.failure("recovery-write");
  }
  recoveryCleanupFailed(): void {
    this.session.recoveryCleanupFailures = count(this.session.recoveryCleanupFailures);
    this.failure("recovery-cleanup");
  }

  private failure(code: SaveFailureCode, attempts?: SaveDiagnosticAttempt[]): void {
    const now = this.now();
    this.trim(now);
    const previous = this.failures[this.failures.length - 1];
    if (previous && previous.code === code && previous.pluginVersion === this.pluginVersion &&
      now >= previous.lastAt && now - previous.lastAt < 60_000 && JSON.stringify(previous.attempts) === JSON.stringify(attempts)) {
      previous.lastAt = now;
      previous.occurrences = count(previous.occurrences);
    } else {
      this.failures.push({ firstAt: now, lastAt: now, pluginVersion: this.pluginVersion, code, occurrences: 1,
        ...(attempts ? { attempts } : {}) });
      this.failures = this.failures.slice(-SAVE_DIAGNOSTIC_LIMIT);
    }
    void this.flush();
  }

  private trim(now: number): void {
    this.failures = this.failures.filter(item => item.firstAt >= now - SAVE_DIAGNOSTIC_DAYS * DAY);
  }

  snapshot(): SaveDiagnosticsReport {
    const now = this.now();
    this.trim(now);
    return {
      version: 1, capturedAt: now, retentionDays: SAVE_DIAGNOSTIC_DAYS, maxFailures: SAVE_DIAGNOSTIC_LIMIT,
      historyStatus: this.historyStatus, session: { ...this.session },
      recentFailures: this.failures.map(item => readFailure(item, now)).filter((item): item is SaveDiagnosticFailure => item !== null),
    };
  }

  flush(): Promise<void> {
    if (!this.storage) return Promise.resolve();
    this.writePending = true;
    if (!this.loaded) return this.load().then(() => this.flush());
    if (this.writes) return this.writes;
    // Coalesce bursts; there is only one writer and one pending snapshot.
    this.writes = Promise.resolve().then(async () => {
      while (this.writePending) {
        this.writePending = false;
        try {
          await this.storage!.write(JSON.stringify({ version: 1, recentFailures: this.snapshot().recentFailures }));
          this.historyStatus = "available";
        } catch { this.historyStatus = "unavailable"; }
      }
      this.writes = null;
    });
    return this.writes;
  }
}
