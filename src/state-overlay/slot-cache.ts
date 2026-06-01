/**
 * Persistence for the slot-allocator cache.
 *
 * The slot allocator's stability guarantee -- "session X holds the same
 * slot across polls" -- only holds when App + CLI agree on the cache.
 * If only App cached in memory, `switchboard cmd 5` from another shell
 * would compute a fresh allocation that may diverge (e.g., after a
 * session leaves the board, App keeps existing assignments but the CLI's
 * fresh pass would re-distribute).
 *
 * Both surfaces read this file before allocating. App writes after every
 * allocation (debounced 200ms). CLI never writes -- read-only consumer
 * to avoid concurrent-write races.
 *
 * Format: flat JSON object `{ "<sessionId>": <slot>, ... }`. Stale
 * entries (for sessions no longer on the board) are dropped on the next
 * App write naturally because the allocation only includes currently
 * active sessions.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, SWITCHBOARD_DIR } from '../paths.js';

const SLOT_CACHE_FILE = join(SWITCHBOARD_DIR, 'slot-cache.json');
const DEBOUNCE_MS = 200;

export function loadSlotCacheSync(): Map<string, number> {
  try {
    mkdirSync(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
    const raw = readFileSync(SLOT_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map();
    }
    const map = new Map<string, number>();
    for (const [id, slot] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof slot === 'number' && Number.isInteger(slot) && slot >= 1 && slot <= 9) {
        map.set(id, slot);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

let pending: Map<string, number> | null = null;
let timer: NodeJS.Timeout | null = null;
let writing = false;

export function saveSlotCache(cache: Map<string, number>): void {
  pending = new Map(cache);
  scheduleWrite();
}

function scheduleWrite(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void drainPending();
  }, DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

async function drainPending(): Promise<void> {
  if (writing || pending === null) return;
  const snapshot = pending;
  pending = null;
  writing = true;
  try {
    await mkdir(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
    const obj: Record<string, number> = {};
    for (const [id, slot] of snapshot) obj[id] = slot;
    await writeFile(
      SLOT_CACHE_FILE,
      JSON.stringify(obj, null, 2) + '\n',
      { encoding: 'utf8', mode: SECURE_FILE_MODE }
    );
  } catch {
    // best-effort -- slot cache loss is recoverable on next allocation
  } finally {
    writing = false;
    if (pending !== null) scheduleWrite();
  }
}

/** Synchronous flush of any pending cache write. Called by exit paths. */
export function flushPendingSlotCacheWrite(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending === null) return;
  const snapshot = pending;
  pending = null;
  try {
    mkdirSync(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
    const obj: Record<string, number> = {};
    for (const [id, slot] of snapshot) obj[id] = slot;
    writeFileSync(
      SLOT_CACHE_FILE,
      JSON.stringify(obj, null, 2) + '\n',
      { encoding: 'utf8', mode: SECURE_FILE_MODE }
    );
  } catch {
    // best-effort
  }
}

/** Test-only: reset module-private state between tests. */
export function __resetSlotCacheForTests(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending = null;
  writing = false;
}
