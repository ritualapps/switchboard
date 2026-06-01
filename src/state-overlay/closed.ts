/**
 * Closed-via-platform-hook store.
 *
 * The Claude Code SessionEnd hook writes a line to
 * ~/.switchboard/closed.jsonl when a session terminates at the platform
 * level. This module reads that file and exposes a "is session closed?"
 * predicate.
 *
 * The store is reloaded on each adapter scan -- the SessionEnd hook is an
 * external writer, so the in-memory view must refresh from disk regularly.
 */

import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SECURE_DIR_MODE, SWITCHBOARD_DIR } from '../paths.js';

const CLOSED_FILE = join(SWITCHBOARD_DIR, 'closed.jsonl');

export interface ClosedEntry {
  sessionId: string;
  at: string;
}

export interface ClosedStore {
  /** Set of session ids that have been platform-closed. */
  closed: Set<string>;
  isClosed(sessionId: string): boolean;
}

export async function loadClosedStore(): Promise<ClosedStore> {
  await mkdir(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  let raw = '';
  try {
    raw = await readFile(CLOSED_FILE, 'utf8');
  } catch {
    raw = '';
  }
  const closed = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ClosedEntry;
      if (entry.sessionId) closed.add(entry.sessionId);
    } catch {
      // skip malformed lines
    }
  }
  return {
    closed,
    isClosed(sessionId) {
      return closed.has(sessionId);
    },
  };
}
