import type { ButterSavePolicy } from "../core/save-policy";

export type RecoveryPolicy = Omit<ButterSavePolicy, "originalDoc">;

export interface SaveRecoverySnapshot {
  readonly version: 1;
  readonly id: string;
  readonly generation: number;
  readonly createdAt: number;
  readonly pluginVersion: string;
  readonly notePath: string;
  readonly baseline: string;
  readonly doc: Record<string, unknown>;
  readonly policy: RecoveryPolicy;
  /** Content-free preflight stage and semantic location. */
  readonly reason: string;
}

export interface RecoveryAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

interface Envelope {
  readonly format: "butter-save-recovery-1";
  readonly revision: number;
  readonly checksum: string;
  readonly snapshot: SaveRecoverySnapshot;
}

type SlotRead =
  | { readonly kind: "readable"; readonly envelope: Envelope | null }
  | { readonly kind: "invalid" }
  | { readonly kind: "unreadable" };

/** An unknown sibling may contain a later checkpoint. No journal mutation
 * may treat damaged or temporarily unavailable bytes as an absent slot. */
export class SaveRecoverySlotsUnverifiedError extends Error {
  readonly code = "BUTTER_RECOVERY_SLOTS_UNVERIFIED";

  constructor() {
    super("Could not read recovery slot; existing snapshots were preserved");
    this.name = "SaveRecoverySlotsUnverifiedError";
  }
}

/** The stable code also recognizes errors from a previous plugin bundle. */
export function isUnverifiedRecoverySlots(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { code?: unknown }).code === "BUTTER_RECOVERY_SLOTS_UNVERIFIED";
}

function newestReadable(slots: readonly SlotRead[]): Envelope | null {
  const readable: Envelope[] = [];
  slots.forEach(slot => {
    if (slot.kind === "readable" && slot.envelope) readable.push(slot.envelope);
  });
  return readable.sort((left, right) => right.revision - left.revision)[0] ?? null;
}

const VALID_ID = /^[a-z0-9]{16,64}$/;
const RECOVERY_QUEUES = Symbol.for("butter-editor.save-recovery.queues.v1");
type RecoveryQueues = Map<string, Promise<unknown>>;
type AdapterRecoveryQueues = Map<string, RecoveryQueues>;
let nextId = 0;

function sharedRecoveryQueues(adapter: RecoveryAdapter, directory: string): RecoveryQueues {
  // The same vault adapter survives a plugin reload. Symbol.for also survives
  // rebundled module instances, unlike a module-level WeakMap. This registry is
  // Butter-owned transient coordination, never native file-view state.
  const owner = adapter as RecoveryAdapter & { [key: symbol]: unknown };
  let registry = owner[RECOVERY_QUEUES];
  if (registry === undefined) {
    registry = new Map<string, RecoveryQueues>();
    Object.defineProperty(owner, RECOVERY_QUEUES, { value: registry, configurable: true });
  }
  if (!(registry instanceof Map)) throw new Error("Invalid recovery operation registry");
  const directories = registry as AdapterRecoveryQueues;
  let queues = directories.get(directory);
  if (!queues) { queues = new Map(); directories.set(directory, queues); }
  return queues;
}

export function newRecoveryId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }
  // The ID is a filename discriminator, not a secret or authority token.
  nextId++;
  return `${Date.now().toString(36)}${nextId.toString(36)}${Math.random().toString(36).slice(2)}`.padEnd(16, "0");
}

function isSnapshot(value: unknown): value is SaveRecoverySnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SaveRecoverySnapshot>;
  return item.version === 1 && typeof item.id === "string" && VALID_ID.test(item.id) &&
    typeof item.generation === "number" && Number.isSafeInteger(item.generation) && item.generation >= 0 &&
    typeof item.createdAt === "number" && Number.isFinite(item.createdAt) &&
    typeof item.pluginVersion === "string" && typeof item.notePath === "string" &&
    typeof item.baseline === "string" && typeof item.reason === "string" &&
    Boolean(item.doc && typeof item.doc === "object" && item.doc.type === "doc") &&
    Boolean(item.policy && typeof item.policy === "object" && typeof item.policy.originalBody === "string" &&
      typeof item.policy.originalTrailingNewlines === "number" &&
      Number.isSafeInteger(item.policy.originalTrailingNewlines) && item.policy.originalTrailingNewlines >= 0);
}

async function checksum(snapshot: SaveRecoverySnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (typeof crypto === "undefined" || !crypto.subtle) throw new Error("Recovery checksum is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Two-slot local journal. A failed/partial new write leaves the other verified
 * slot readable. Work is serialized per editor session; an older save cannot
 * delete a newer generation's snapshot. Unresolved records never expire.
 */
export class SaveRecoveryStore {
  private queues: RecoveryQueues;
  /** Existing slots that could not be verified in the latest enumeration:
   * malformed/checksum-invalid bytes or unavailable IO/checksum service. */
  private readFailures = 0;

  get unreadableSlotCount(): number { return this.readFailures; }

  constructor(private adapter: RecoveryAdapter, readonly directory: string) {
    this.queues = sharedRecoveryQueues(adapter, directory);
  }

  private async ensureDirectory(): Promise<void> {
    let path = "";
    for (const part of this.directory.split("/")) {
      if (!part || part === "." || part === "..") throw new Error("Invalid recovery directory");
      path = path ? `${path}/${part}` : part;
      if (!await this.adapter.exists(path)) {
        try { await this.adapter.mkdir(path); }
        catch (error) { if (!await this.adapter.exists(path)) throw error; }
      }
    }
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!VALID_ID.test(id)) return Promise.reject(new Error("Invalid recovery ID"));
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(id, current);
    void current.finally(() => {
      if (this.queues.get(id) === current) this.queues.delete(id);
    }).catch(() => undefined);
    return current;
  }

  private slotPath(id: string, slot: number): string {
    return `${this.directory}/${id}.${slot}.json`;
  }

  private async readSlot(id: string, slot: number): Promise<SlotRead> {
    const path = this.slotPath(id, slot);
    let contents: string;
    try {
      if (!await this.adapter.exists(path)) return { kind: "readable", envelope: null };
      contents = await this.adapter.read(path);
    } catch {
      // An unavailable slot may contain a newer checkpoint. Recovery may use
      // another verified slot, but mutations must not treat this as absence.
      return { kind: "unreadable" };
    }
    let envelope: Partial<Envelope>;
    try {
      envelope = JSON.parse(contents) as Partial<Envelope>;
      if (!envelope || envelope.format !== "butter-save-recovery-1" || !Number.isSafeInteger(envelope.revision) ||
        (envelope.revision ?? 0) < 1 || !isSnapshot(envelope.snapshot) || envelope.snapshot.id !== id ||
        typeof envelope.checksum !== "string") {
        return { kind: "invalid" };
      }
    } catch { return { kind: "invalid" }; }
    try {
      if (await checksum(envelope.snapshot) !== envelope.checksum) return { kind: "invalid" };
    } catch { return { kind: "unreadable" }; }
    return { kind: "readable", envelope: envelope as Envelope };
  }

  private async latest(id: string): Promise<Envelope | null> {
    const slots = await Promise.all([this.readSlot(id, 0), this.readSlot(id, 1)]);
    if (slots.some(slot => slot.kind !== "readable")) {
      throw new SaveRecoverySlotsUnverifiedError();
    }
    return newestReadable(slots);
  }

  retain(snapshot: SaveRecoverySnapshot): Promise<void> {
    // Snapshot the payload now, before asynchronous I/O can observe mutation.
    let captured: unknown;
    try { captured = JSON.parse(JSON.stringify(snapshot)); }
    catch { return Promise.reject(new Error("Invalid recovery snapshot")); }
    if (!isSnapshot(captured)) return Promise.reject(new Error("Invalid recovery snapshot"));
    return this.enqueue(captured.id, async () => {
      await this.ensureDirectory();
      const prior = await this.latest(captured.id);
      if (prior && prior.snapshot.generation > captured.generation) return;
      const revision = (prior?.revision ?? 0) + 1;
      const envelope: Envelope = {
        format: "butter-save-recovery-1", revision,
        checksum: await checksum(captured), snapshot: captured,
      };
      const path = this.slotPath(captured.id, revision % 2);
      await this.adapter.write(path, JSON.stringify(envelope));
      // A resolved adapter write is not enough: verify the retained payload.
      const verified = await this.readSlot(captured.id, revision % 2);
      if (verified.kind !== "readable" || verified.envelope?.checksum !== envelope.checksum ||
        verified.envelope.revision !== revision) {
        throw new Error("Recovery snapshot verification failed");
      }
    });
  }

  clearSaved(id: string, generation: number): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      return Promise.reject(new Error("Invalid saved recovery generation"));
    }
    return this.enqueue(id, async () => {
      const latest = await this.latest(id);
      if (!latest || latest.snapshot.generation > generation) return;
      await this.removeSlots(id);
    });
  }

  /** A UI discard may remove only the exact checkpoint the user inspected. */
  discardDisplayed(snapshot: SaveRecoverySnapshot): Promise<boolean> {
    let captured: unknown;
    try { captured = JSON.parse(JSON.stringify(snapshot)); }
    catch { return Promise.reject(new Error("Invalid recovery snapshot")); }
    if (!isSnapshot(captured)) return Promise.reject(new Error("Invalid recovery snapshot"));
    return this.enqueue(captured.id, async () => {
      const latest = await this.latest(captured.id);
      if (!latest || latest.snapshot.generation !== captured.generation ||
        latest.checksum !== await checksum(captured)) return false;
      await this.removeSlots(captured.id);
      return true;
    });
  }

  private async removeSlots(id: string): Promise<void> {
    for (const slot of [0, 1]) {
      const path = this.slotPath(id, slot);
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }
  }

  async list(): Promise<SaveRecoverySnapshot[]> {
    const queued = Array.from(this.queues.values());
    // Wait for every captured operation, including failures, in one reaction layer.
    await new Promise<void>(resolve => {
      let remaining = 1;
      for (const operation of queued) {
        remaining++;
        let completed = false;
        const settled = () => {
          if (completed) return;
          completed = true;
          if (--remaining === 0) resolve();
        };
        void Promise.resolve(operation).then(settled, settled);
      }
      if (--remaining === 0) resolve();
    });
    if (!await this.adapter.exists(this.directory)) {
      this.readFailures = 0;
      return [];
    }
    const listing = await this.adapter.list(this.directory);
    const ids = new Set<string>();
    for (const path of listing.files) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      const match = /^([a-z0-9]{16,64})\.[01]\.json$/.exec(name);
      if (match) ids.add(match[1]);
    }
    const slotSets = await Promise.all(Array.from(ids, id => Promise.all([this.readSlot(id, 0), this.readSlot(id, 1)])));
    this.readFailures = slotSets.reduce((count, slots) => count + slots.filter(slot => slot.kind !== "readable").length, 0);
    const records = slotSets.map(newestReadable);
    return records.filter((record): record is Envelope => record !== null)
      .map(record => record.snapshot).sort((left, right) => right.createdAt - left.createdAt);
  }
}
