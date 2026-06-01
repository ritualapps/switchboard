/**
 * Incremental transcript cache tests.
 *
 * These tests write to a tmpdir, not ~/.claude/, so they cannot collide
 * with the operator's real transcripts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getEventsIncremental,
  evictSession,
  retainSessions,
  __resetTranscriptCacheForTests,
  __getCacheEntryForTests,
} from '../src/claude-code/transcript-cache.ts';

function ev(text: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    timestamp: ts,
  });
}

describe('transcript cache (incremental reads)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    __resetTranscriptCacheForTests();
    dir = mkdtempSync(join(tmpdir(), 'switchboard-tc-'));
    path = join(dir, 'session.jsonl');
  });

  afterEach(() => {
    __resetTranscriptCacheForTests();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('first scan reads the file and populates the cache', () => {
    writeFileSync(path, ev('hi', '2026-05-25T00:00:00Z') + '\n', 'utf8');
    const r = getEventsIncremental('s1', path);
    expect(r).not.toBeNull();
    expect(r!.fromCache).toBe(false);
    expect(r!.events.length).toBe(1);
    const cached = __getCacheEntryForTests('s1');
    expect(cached?.events.length).toBe(1);
  });

  it('second scan with unchanged file returns cached events (no reread)', () => {
    writeFileSync(path, ev('hi', '2026-05-25T00:00:00Z') + '\n', 'utf8');
    getEventsIncremental('s1', path);
    const r = getEventsIncremental('s1', path);
    expect(r!.fromCache).toBe(true);
    expect(r!.events.length).toBe(1);
  });

  it('appended line is read incrementally, not via full reread', () => {
    writeFileSync(path, ev('first', '2026-05-25T00:00:00Z') + '\n', 'utf8');
    const r1 = getEventsIncremental('s1', path);
    expect(r1!.events.length).toBe(1);

    appendFileSync(path, ev('second', '2026-05-25T00:00:01Z') + '\n', 'utf8');
    const r2 = getEventsIncremental('s1', path);
    expect(r2!.fromCache).toBe(false);
    expect(r2!.events.length).toBe(2);
    // Same array reference -- events appended in place.
    expect(r2!.events[0]?.type).toBe('assistant');
    expect(r2!.events[1]?.type).toBe('assistant');
  });

  it('partial trailing line is buffered and completed on next scan', () => {
    // First write a complete line + a partial (no trailing newline).
    const partial = ev('half', '2026-05-25T00:00:02Z');
    writeFileSync(path, ev('first', '2026-05-25T00:00:00Z') + '\n' + partial, 'utf8');
    const r1 = getEventsIncremental('s1', path);
    expect(r1!.events.length).toBe(1); // partial not yet parsed
    expect(__getCacheEntryForTests('s1')?.tail).toBe(partial);

    // Complete the partial line.
    appendFileSync(path, '\n', 'utf8');
    const r2 = getEventsIncremental('s1', path);
    expect(r2!.events.length).toBe(2);
    expect(__getCacheEntryForTests('s1')?.tail).toBe('');
  });

  it('truncated file triggers full reread (cache resets)', () => {
    writeFileSync(
      path,
      ev('a', '2026-05-25T00:00:00Z') + '\n' +
        ev('b', '2026-05-25T00:00:01Z') + '\n' +
        ev('c', '2026-05-25T00:00:02Z') + '\n',
      'utf8'
    );
    const r1 = getEventsIncremental('s1', path);
    expect(r1!.events.length).toBe(3);

    // Truncate to just the first line.
    const firstLineLength = ev('a', '2026-05-25T00:00:00Z').length + 1;
    truncateSync(path, firstLineLength);

    const r2 = getEventsIncremental('s1', path);
    expect(r2!.fromCache).toBe(false);
    expect(r2!.events.length).toBe(1);
  });

  it('returns null when the file does not exist', () => {
    expect(getEventsIncremental('s1', join(dir, 'missing.jsonl'))).toBeNull();
  });

  // M2 memory-safety: an untrusted transcript must not be slurped without
  // bound. Past the size cap, only the most recent window is read.
  it('oversized transcript reads only the most recent window (bounded memory)', () => {
    const filler = ev('x'.repeat(70), '2026-05-25T00:00:00Z') + '\n';
    const early = ev('EARLY_MARKER', '2026-05-25T00:00:00Z') + '\n';
    const late = ev('LATE_MARKER', '2026-05-25T23:59:59Z') + '\n';
    // ~17MB: early marker first, fillers to push past the 16MB cap, late last.
    const fillerCount = Math.ceil((17 * 1024 * 1024) / filler.length);
    writeFileSync(path, early + filler.repeat(fillerCount) + late, 'utf8');

    const r = getEventsIncremental('s1', path);
    expect(r).not.toBeNull();
    const texts = r!.events.map((e) => e.raw?.message?.content?.[0]?.text);
    // The most recent event is present...
    expect(texts).toContain('LATE_MARKER');
    // ...but the first event (outside the 16MB tail window) is dropped.
    expect(texts).not.toContain('EARLY_MARKER');
    // And the retained set is bounded well below the total line count.
    expect(r!.events.length).toBeLessThan(fillerCount);
  });

  it('skips a pathologically long single line instead of parsing it', () => {
    // One ~3MB line (over the 2MB parse cap) followed by a normal line: only
    // the normal event survives; the giant line is skipped, not parsed.
    const giant = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'y'.repeat(3 * 1024 * 1024) }] },
      timestamp: '2026-05-25T00:00:00Z',
    });
    writeFileSync(path, giant + '\n' + ev('normal', '2026-05-25T00:00:01Z') + '\n', 'utf8');
    const r = getEventsIncremental('s1', path);
    expect(r!.events.length).toBe(1);
    expect(r!.events[0]?.raw?.message?.content?.[0]?.text).toBe('normal');
  });

  it('evictSession drops a single cached session', () => {
    writeFileSync(path, ev('hi', '2026-05-25T00:00:00Z') + '\n', 'utf8');
    getEventsIncremental('s1', path);
    expect(__getCacheEntryForTests('s1')).toBeDefined();
    evictSession('s1');
    expect(__getCacheEntryForTests('s1')).toBeUndefined();
  });

  it('retainSessions evicts cached sessions not in the active set', () => {
    // Cache two sessions from two transcript files.
    const pathA = join(dir, 'a.jsonl');
    const pathB = join(dir, 'b.jsonl');
    writeFileSync(pathA, ev('a', '2026-05-25T00:00:00Z') + '\n', 'utf8');
    writeFileSync(pathB, ev('b', '2026-05-25T00:00:00Z') + '\n', 'utf8');
    getEventsIncremental('a', pathA);
    getEventsIncremental('b', pathB);
    expect(__getCacheEntryForTests('a')).toBeDefined();
    expect(__getCacheEntryForTests('b')).toBeDefined();

    // Only 'a' is still on disk this scan -- 'b' must be evicted.
    retainSessions(new Set(['a']));
    expect(__getCacheEntryForTests('a')).toBeDefined();
    expect(__getCacheEntryForTests('b')).toBeUndefined();
  });
});
