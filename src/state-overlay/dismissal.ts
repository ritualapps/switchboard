/**
 * Dismissal store -- the high-water-mark primitive.
 *
 * Operator presses 'X' on a focused line to dismiss it. The system records
 * a high-water-mark: the line's `eventCount` and `lastEventAt` at the moment
 * of dismissal. The line is treated as `dismissed` UNTIL new events arrive
 * past the HWM; then `isDismissedAt` returns false and the line re-rings
 * (state derives from substrate again). The dismissal entry remains in the
 * store as audit -- the operator's act of dismissal is append-only history.
 *
 * Storage: ~/.switchboard/dismissals.jsonl, append-only, last-wins per lineId.
 * Tombstones (with `cleared: true`) appear ONLY when the operator explicitly
 * undismisses (via the adapter's `undismiss(lineId)` API). HWM advance does
 * not write a tombstone.
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, SWITCHBOARD_DIR } from '../paths.js';

const DISMISSALS_FILE = join(SWITCHBOARD_DIR, 'dismissals.jsonl');

export interface DismissalEntry {
  lineId: string;
  eventCount: number;
  lastEventAt: string;
  at: string;
  cleared?: boolean;
}

export interface DismissalStore {
  /**
   * Last-write-wins map: lineId -> dismissal entry. Tombstoned entries
   * removed. Entries persist after HWM advance -- the operator's dismissal
   * is audit-trail; use `isDismissedAt` to ask whether a line is currently
   * dismissed.
   */
  active: Map<string, DismissalEntry>;
  add(entry: DismissalEntry): Promise<void>;
  clear(lineId: string): Promise<void>;
  isDismissedAt(lineId: string, currentEventCount: number): boolean;
}

export async function loadDismissalStore(): Promise<DismissalStore> {
  await mkdir(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  let raw = '';
  try {
    raw = await readFile(DISMISSALS_FILE, 'utf8');
  } catch {
    raw = '';
  }
  const active = new Map<string, DismissalEntry>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as DismissalEntry;
      if (entry.cleared) {
        active.delete(entry.lineId);
      } else {
        active.set(entry.lineId, entry);
      }
    } catch {
      // skip malformed lines; never block the dispatcher
    }
  }

  return {
    active,
    async add(entry) {
      active.set(entry.lineId, entry);
      await appendFile(DISMISSALS_FILE, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: SECURE_FILE_MODE });
    },
    async clear(lineId) {
      const tombstone: DismissalEntry = {
        lineId,
        eventCount: 0,
        lastEventAt: '',
        at: new Date().toISOString(),
        cleared: true,
      };
      active.delete(lineId);
      await appendFile(DISMISSALS_FILE, JSON.stringify(tombstone) + '\n', { encoding: 'utf8', mode: SECURE_FILE_MODE });
    },
    isDismissedAt(lineId, currentEventCount) {
      const entry = active.get(lineId);
      if (!entry) return false;
      // Dismissed iff no new events since HWM.
      return currentEventCount <= entry.eventCount;
    },
  };
}
