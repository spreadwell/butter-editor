/**
 * Verbose debug logging.
 *
 * Toggled at runtime via the "Verbose debug logging" setting under
 * the plugin's Debug tab. When off (default), all debug() calls are
 * cheap no-ops - just a boolean check. When on, they `console.log`
 * with a `[butter:<category>]` prefix so users can filter in the
 * dev-tools console.
 *
 * Design:
 *   - Module-level flag, not a param on every call site. Avoids
 *     plumbing the settings object through every file that wants
 *     to log.
 *   - `setVerbose(bool)` is called once on plugin load and whenever
 *     the user toggles the setting.
 *   - Categories (`parse`, `drag`, `save`, `serialize`, …) are
 *     strings - cheap to filter in dev-tools via the text filter.
 *
 * No `console.log` should appear anywhere in the plugin outside of
 * this module (errors / warnings stay as `console.error` /
 * `console.warn` - those are always on). Grep for `console.log` in
 * src/ to audit; only debug.ts and any migrated-over legacy callers
 * should show up.
 */

let verbose = false;

/** Enable or disable verbose logging. Called from main.ts on settings
 *  load + whenever the Debug-tab toggle flips. */
export function setVerbose(v: boolean) {
  verbose = v;
}

/** Query the current state - rarely needed directly, but exposed for
 *  the odd place that wants to gate something more expensive than a
 *  console call behind the same toggle. */
export function isVerbose(): boolean {
  return verbose;
}

/** Log a message under a category prefix. No-op when verbose is off. */
export function debug(category: string, ...args: unknown[]) {
  if (!verbose) return;
  console.debug(`[butter:${category}]`, ...args);
}

// ── Error ring buffer ──
//
// Mobile Obsidian doesn't expose a visible JS console, so console.error
// alone is invisible to users on a phone. The ring buffer here captures
// the last N error/warn entries so an in-app command can surface them
// after the fact. Independent of the verbose toggle - errors are always
// captured.

interface ErrorEntry {
  timestamp: number;
  category: string;
  message: string;
}

const ERROR_LOG_CAP = 50;
const errorLog: ErrorEntry[] = [];

/** Record an error/warn entry into the ring buffer. ALSO writes to
 *  console.error so desktop devtools still get it. Call from any
 *  catch block or error path that wants to be visible on mobile. */
export function recordError(category: string, message: string): void {
  errorLog.push({ timestamp: Date.now(), category, message });
  if (errorLog.length > ERROR_LOG_CAP) errorLog.shift();
  console.error(`[butter:${category}]`, message);
}

/** Snapshot of the current error log, oldest-first. Used by the
 *  "Butter: Show recent errors" command. */
export function getErrorLog(): ErrorEntry[] {
  return errorLog.slice();
}

/** Clear the error buffer. Used by the show-errors command after
 *  the user has acknowledged them. */
export function clearErrorLog(): void {
  errorLog.length = 0;
}
