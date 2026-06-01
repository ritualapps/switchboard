/**
 * Drafts persistence.
 *
 * Drafts used to live in App state in memory only -- quitting and restarting
 * the binary lost everything the operator hadn't yet handed back. This module
 * persists the drafts Map to ~/.switchboard/drafts.json across edits and
 * loads it synchronously at startup.
 *
 * Write strategy:
 *   - `saveDrafts(map)` -- debounced 100ms async write from the React
 *     render path. Coalesces rapid keystrokes; never blocks render.
 *   - `flushPendingDraftWrite()` -- synchronous flush of the latest pending
 *     snapshot. Called by every exit path in cli.ts so a process death in
 *     the debounce window cannot lose the operator's last keystrokes.
 *   - `saveDraftsSync(map)` -- the underlying synchronous write, used by
 *     the flush and available for tests / direct callers.
 *
 * Format: a single JSON array of LineDraft objects (one entry per lineId
 * with an open draft). Empty array when no drafts exist.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, SWITCHBOARD_DIR } from '../paths.js';
import type { LineDraft } from '../types.js';

const DRAFTS_FILE = join(SWITCHBOARD_DIR, 'drafts.json');
const DEBOUNCE_MS = 100;

/**
 * Synchronous load at startup. Returns an empty Map if the file is absent
 * or malformed -- never throws.
 */
export function loadDraftsSync(): Map<string, LineDraft> {
  try {
    mkdirSync(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
    const raw = readFileSync(DRAFTS_FILE, 'utf8');
    const arr: LineDraft[] = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Map();
    return new Map(arr.filter((d) => d && typeof d.lineId === 'string').map((d) => [d.lineId, d]));
  } catch {
    return new Map();
  }
}

/**
 * Underlying synchronous write. Best-effort. Direct callers should prefer
 * `saveDrafts` (async/debounced) unless they need the sync guarantee --
 * exit-path flush uses this via `flushPendingDraftWrite`.
 */
export function saveDraftsSync(drafts: Map<string, LineDraft>): void {
  try {
    mkdirSync(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
    const arr = Array.from(drafts.values());
    writeFileSync(DRAFTS_FILE, JSON.stringify(arr, null, 2) + '\n', { encoding: 'utf8', mode: SECURE_FILE_MODE });
  } catch {
    // best-effort
  }
}

// --- Debounced async write machinery -----------------------------------
//
// `pending` holds the latest drafts snapshot that has been requested but
// not yet committed to disk. `timer` is the debounce timer that fires
// `drainPending`. `writing` guards concurrent writes -- if a new snapshot
// arrives while a write is in flight, it stays in `pending` and a fresh
// timer is scheduled when the in-flight write completes.

let pending: LineDraft[] | null = null;
let timer: NodeJS.Timeout | null = null;
let writing = false;

function snapshotOf(drafts: Map<string, LineDraft>): LineDraft[] {
  return Array.from(drafts.values());
}

function scheduleTimer(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void drainPending();
  }, DEBOUNCE_MS);
  // setTimeout in Node holds the event loop open. drafts persistence is
  // best-effort, not a reason to delay process exit -- unref so a quiet
  // event loop can finish.
  if (typeof timer.unref === 'function') timer.unref();
}

async function drainPending(): Promise<void> {
  if (writing || pending === null) return;
  const snapshot = pending;
  pending = null;
  writing = true;
  try {
    await mkdir(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
    await writeFile(
      DRAFTS_FILE,
      JSON.stringify(snapshot, null, 2) + '\n',
      { encoding: 'utf8', mode: SECURE_FILE_MODE }
    );
  } catch {
    // best-effort
  } finally {
    writing = false;
    if (pending !== null) scheduleTimer();
  }
}

/**
 * Debounced async persist. Safe to call from React render path -- captures
 * the snapshot immediately, schedules a 100ms-debounced async write,
 * coalesces rapid successive calls into a single fs write.
 *
 * The persistence guarantee holds IF the process exits via one of the paths
 * that calls `flushPendingDraftWrite`. cli.ts wires every exit path through
 * that flush.
 */
export function saveDrafts(drafts: Map<string, LineDraft>): void {
  pending = snapshotOf(drafts);
  scheduleTimer();
}

/**
 * Synchronous flush of the latest pending snapshot. Cancels any pending
 * debounce timer and writes immediately via `saveDraftsSync`. Called by
 * every exit path so process death in the debounce window cannot lose
 * keystrokes.
 *
 * Safe to call multiple times and safe to call when nothing is pending.
 */
export function flushPendingDraftWrite(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending === null) return;
  const snapshot = pending;
  pending = null;
  try {
    mkdirSync(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
    writeFileSync(
      DRAFTS_FILE,
      JSON.stringify(snapshot, null, 2) + '\n',
      { encoding: 'utf8', mode: SECURE_FILE_MODE }
    );
  } catch {
    // best-effort
  }
}

/**
 * Test-only: reset module-private debounce state. Lets tests run in
 * isolation without leaked timers / pending snapshots from prior cases.
 */
export function __resetDraftsPersistenceForTests(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending = null;
  writing = false;
}
