/**
 * Append-only history log -- the traceability substrate.
 *
 * One file: ~/.switchboard/history.jsonl. Keyed by line id in each record;
 * the log itself is cross-cutting and time-ordered (append order). Lines
 * are never deleted from the log -- completed/deferred lines remain
 * queryable months later.
 *
 * Reading is on-demand and not part of the hot path. For the operator's
 * cell-footer signals and capacity computation we use the in-memory
 * transcript reduction (cheap); the history log is the durable record
 * for post-hoc walks ("show me what happened on this line yesterday").
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { HISTORY_FILE, SECURE_DIR_MODE, SECURE_FILE_MODE, SWITCHBOARD_DIR } from '../paths.js';
import type { HistoryEvent, HistoryEventKind } from '../types.js';

let ensured = false;
async function ensureDir(): Promise<void> {
  if (ensured) return;
  await mkdir(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  ensured = true;
}

export interface AppendHistoryInput {
  lineId: string;
  kind: HistoryEventKind;
  at: string;
  payload: Record<string, unknown>;
}

export async function appendHistoryEvent(input: AppendHistoryInput): Promise<void> {
  await ensureDir();
  const event: HistoryEvent = {
    id: nanoid(12),
    lineId: input.lineId,
    kind: input.kind,
    at: input.at,
    payload: input.payload,
  };
  await appendFile(HISTORY_FILE, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: SECURE_FILE_MODE });
}

export async function readHistoryForLine(lineId: string): Promise<HistoryEvent[]> {
  try {
    const raw = await readFile(HISTORY_FILE, 'utf8');
    const events: HistoryEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as HistoryEvent;
        if (ev.lineId === lineId) events.push(ev);
      } catch {
        // skip malformed line
      }
    }
    return events;
  } catch {
    return [];
  }
}

export async function readAllHistory(): Promise<HistoryEvent[]> {
  try {
    const raw = await readFile(HISTORY_FILE, 'utf8');
    const events: HistoryEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as HistoryEvent);
      } catch {
        // skip
      }
    }
    return events;
  } catch {
    return [];
  }
}
