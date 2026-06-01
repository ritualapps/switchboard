/**
 * Incremental transcript cache.
 *
 * The adapter polls `~/.claude/projects/<hash>/*.jsonl` every 2 seconds.
 * Reading every transcript in full on each scan is wasteful -- a multi-megabyte
 * chat means a multi-megabyte read every two seconds for a file that may not
 * have changed.
 *
 * This module caches parsed events per session, keyed by (mtimeMs, size).
 * Per scan:
 *   - stat the transcript.
 *   - cache miss / mtime+size unchanged: serve cached events.
 *   - file grew: read only the bytes from `cached.size` to current `size`
 *     via openSync + readSync (positional, no slurp), parse new complete
 *     lines, append to cached events. Partial trailing line (no `\n` yet)
 *     is preserved in `tail` so the next scan can complete it.
 *   - file shrank / mtime older than cached: treat as truncation -- full
 *     reread, replace cache entry.
 *
 * Invariant: the cache holds EVENTS (the substrate itself), not derived
 * state. The reducer re-runs against cached events on every scan.
 */

import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { parseJsonlLine, type CcEvent } from './jsonl-parser.js';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  events: CcEvent[];
  /** Trailing bytes that did not end in `\n` -- a write in progress. */
  tail: string;
}

const cache = new Map<string, CacheEntry>();

/**
 * Upper bound on how many bytes of a single transcript we hold in memory. A
 * transcript is untrusted and can grow without limit (a runaway or hostile
 * agent). Beyond this size we read only the most recent window each scan, so
 * per-session memory is bounded; the board only needs recent events to derive
 * current state. Normal sessions stay well under this and keep the fast
 * incremental path.
 */
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

export interface IncrementalReadResult {
  events: CcEvent[];
  fromCache: boolean;
}

/**
 * Return the up-to-date events for a session, reading only the delta from
 * disk when possible. Returns null if the transcript cannot be stat'd or
 * read (caller should drop the session for this scan).
 */
export function getEventsIncremental(
  sessionId: string,
  transcriptPath: string
): IncrementalReadResult | null {
  let mtimeMs: number;
  let size: number;
  try {
    const s = statSync(transcriptPath);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    return null;
  }

  const cached = cache.get(sessionId);

  // Cache hit AND nothing changed -- the common hot path.
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return { events: cached.events, fromCache: true };
  }

  // Oversized transcript -- bound memory by reading only the most recent
  // window instead of slurping (full reread) or carrying an ever-growing
  // event array (incremental append).
  if (size > MAX_TRANSCRIPT_BYTES) {
    return boundedTailReread(sessionId, transcriptPath, mtimeMs, size);
  }

  // Truncation / replacement / no cache -- full reread.
  if (!cached || size < cached.size || mtimeMs < cached.mtimeMs) {
    return fullReread(sessionId, transcriptPath, mtimeMs, size);
  }

  // Append-only growth: read delta only.
  return incrementalAppend(sessionId, transcriptPath, cached, mtimeMs, size);
}

/**
 * Read only the final MAX_TRANSCRIPT_BYTES of an oversized transcript. The
 * window almost always starts mid-line, so the first (partial) line is
 * dropped. No `tail` is carried -- the window is re-read each scan -- which
 * keeps memory bounded at the cost of re-reading a large file; this path only
 * triggers for transcripts past the cap, which are rare.
 */
function boundedTailReread(
  sessionId: string,
  transcriptPath: string,
  mtimeMs: number,
  size: number
): IncrementalReadResult | null {
  const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
  const len = size - start;
  let buf: Buffer;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  let text = buf.toString('utf8');
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  const { events } = parseBuffer(text);
  cache.set(sessionId, { mtimeMs, size, events, tail: '' });
  return { events, fromCache: false };
}

function fullReread(
  sessionId: string,
  transcriptPath: string,
  mtimeMs: number,
  size: number
): IncrementalReadResult | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const { events, tail } = parseBuffer(raw);
  cache.set(sessionId, { mtimeMs, size, events, tail });
  return { events, fromCache: false };
}

function incrementalAppend(
  sessionId: string,
  transcriptPath: string,
  cached: CacheEntry,
  mtimeMs: number,
  size: number
): IncrementalReadResult | null {
  const len = size - cached.size;
  if (len === 0) {
    // mtime changed but size identical -- treat as no-op; refresh mtime.
    cached.mtimeMs = mtimeMs;
    return { events: cached.events, fromCache: true };
  }

  let buf: Buffer;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, cached.size);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  // Combine any prior tail (partial line from previous scan) with newly
  // read bytes, then split on complete lines.
  const combined = cached.tail + buf.toString('utf8');
  const { events: newEvents, tail } = parseBuffer(combined);

  cached.events.push(...newEvents);
  cached.mtimeMs = mtimeMs;
  cached.size = size;
  cached.tail = tail;
  return { events: cached.events, fromCache: false };
}

/**
 * Split a buffer into parsed events + trailing partial line (if any).
 * A buffer ending in `\n` has no tail. A buffer with no trailing newline
 * has the final segment held back as `tail` -- on the next read it will
 * be prepended to the new bytes and re-considered.
 */
function parseBuffer(text: string): { events: CcEvent[]; tail: string } {
  if (text.length === 0) return { events: [], tail: '' };
  const endsWithNewline = text.endsWith('\n');
  const parts = text.split('\n');
  // If the buffer ended in `\n`, `parts` has a trailing empty string we
  // discard. Otherwise the last segment is incomplete -- hold as tail.
  let tail = '';
  let upto = parts.length;
  if (endsWithNewline) {
    upto = parts.length - 1; // drop trailing empty
  } else {
    tail = parts[parts.length - 1] ?? '';
    upto = parts.length - 1;
  }
  const events: CcEvent[] = [];
  for (let i = 0; i < upto; i++) {
    const ev = parseJsonlLine(parts[i]!);
    if (ev) events.push(ev);
  }
  return { events, tail };
}

/**
 * Drop a session from the cache -- call when the adapter notices the
 * session has been deleted, closed, or otherwise will not poll again.
 * Without this the cache grows unbounded across long-lived adapter
 * processes.
 */
export function evictSession(sessionId: string): void {
  cache.delete(sessionId);
}

/**
 * Evict every cached session NOT present in `activeSessionIds`. The adapter
 * calls this at the end of each scan with the set of transcripts still on
 * disk, so cache entries for deleted / rotated / no-longer-scanned sessions
 * don't accumulate across a long-lived adapter process.
 */
export function retainSessions(activeSessionIds: Set<string>): void {
  for (const sessionId of cache.keys()) {
    if (!activeSessionIds.has(sessionId)) cache.delete(sessionId);
  }
}

/**
 * Test-only: clear all cache state.
 */
export function __resetTranscriptCacheForTests(): void {
  cache.clear();
}

/**
 * Test-only: inspect cache entry for a session.
 */
export function __getCacheEntryForTests(sessionId: string): CacheEntry | undefined {
  return cache.get(sessionId);
}
