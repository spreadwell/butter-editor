/**
 * Save scheduler.
 *
 * Two-timer debounce that coordinates save-to-disk timing across
 * typing bursts, idle periods, long continuous editing, and focus
 * changes.
 *
 * Compared to the old pure-idle debouncer (save 600ms after last
 * edit, period), this scheduler:
 *
 *   1. Uses a longer idle window (1500ms default) to coalesce more
 *      keystrokes into one save - friendlier to sync plugins, file
 *      watchers, git-on-save workflows.
 *
 *   2. Adds a CONTINUOUS CEILING (10000ms default) that forces a
 *      save even during nonstop typing. Without this, the pure
 *      debouncer never fires during 30+ second typing sessions,
 *      leaving all of it unsaved and at crash-risk.
 *
 *   3. Exposes flush() for event-driven saves:
 *        - editor blur (user clicked outside the editor)
 *        - document visibility-hidden (tab switched, window
 *          minimized)
 *        - beforeunload (window about to close)
 *      These give instant saves for the "user alt-tabbed to a sync
 *      app" case without paying the idle-window cost in bandwidth.
 *
 * The scheduler is pure state + timer management - it doesn't know
 * anything about PM or Obsidian. Callers wire onEdit() on every
 * edit, flush() on relevant events, and pass a `doSave` callback
 * that actually writes to disk.
 */

export interface SaveSchedulerConfig {
  /** Save this long after the most recent edit. Resets on every
   *  new edit, so typing bursts coalesce into one save at the end
   *  of the burst. */
  idleMs: number;
  /** Force a save this long after the FIRST edit in a burst,
   *  regardless of whether the user has stopped typing. Safety
   *  net for continuous-editing sessions. */
  ceilingMs: number;
}

/** Balanced defaults - kind to sync plugins and file watchers,
 *  while keeping crash-loss bounded at ~10s of unsaved work. */
export const DEFAULT_SAVE_CONFIG: SaveSchedulerConfig = {
  idleMs: 1500,
  ceilingMs: 10_000,
};

/** Abstract timer facade - lets tests inject a fake timer without
 *  needing a Node-version-specific fake-timer library. In
 *  production, we bind to `window.setTimeout` / `clearTimeout`. */
export interface TimerLike {
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

const REAL_TIMER: TimerLike = {
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (h) => window.clearTimeout(h),
};

export class SaveScheduler {
  private idleHandle: number | null = null;
  private ceilingHandle: number | null = null;

  constructor(
    private doSave: () => void,
    private config: SaveSchedulerConfig = DEFAULT_SAVE_CONFIG,
    private timer: TimerLike = REAL_TIMER,
  ) {}

  /**
   * An edit just landed. Schedule a save.
   *
   * Idle timer resets on every edit (standard debounce). Ceiling
   * timer starts with the FIRST edit in a burst and does NOT
   * reset - so after ceilingMs of continuous edits, we save even
   * if the user hasn't paused.
   */
  onEdit(): void {
    if (this.idleHandle !== null) this.timer.clearTimeout(this.idleHandle);
    this.idleHandle = this.timer.setTimeout(() => {
      this.idleHandle = null;
      this.performSave();
    }, this.config.idleMs);

    if (this.ceilingHandle === null) {
      this.ceilingHandle = this.timer.setTimeout(() => {
        this.ceilingHandle = null;
        this.performSave();
      }, this.config.ceilingMs);
    }
  }

  /**
   * Fire a save right now, cancelling any pending timers.
   *
   * Safe no-op if there's nothing pending. Intended for event-
   * driven immediate saves (blur, visibility-hidden, file switch,
   * beforeunload) - and for tear-down paths that want to ensure
   * all unsaved work lands before state is thrown away.
   */
  flush(): void {
    const hadPending = this.hasPending();
    this.clearTimers();
    if (hadPending) this.performSave();
  }

  /**
   * Drop any pending save without firing. Use when the doc is
   * being replaced entirely (e.g., external file-sync merged in),
   * where firing a save would overwrite the new content with the
   * pre-sync state.
   */
  cancel(): void {
    this.clearTimers();
  }

  hasPending(): boolean {
    return this.idleHandle !== null || this.ceilingHandle !== null;
  }

  private performSave(): void {
    // Clear BOTH timers before calling doSave so that if doSave
    // triggers another onEdit (unlikely but possible - e.g., a
    // post-save hook rewrites the doc), the new edit gets its
    // own clean timer pair.
    this.clearTimers();
    try {
      this.doSave();
    } catch (err) {
      // Save failures are reported by the caller's own logging;
      // the scheduler itself just logs + continues so subsequent
      // edits keep scheduling.
       
      console.error("[butter] save-scheduler doSave threw:", err);
    }
  }

  private clearTimers(): void {
    if (this.idleHandle !== null) {
      this.timer.clearTimeout(this.idleHandle);
      this.idleHandle = null;
    }
    if (this.ceilingHandle !== null) {
      this.timer.clearTimeout(this.ceilingHandle);
      this.ceilingHandle = null;
    }
  }
}
