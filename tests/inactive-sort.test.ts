/**
 * INACTIVE zone stable ordering.
 *
 * The within-zone "newest activity first" rule applies to NEEDS YOU /
 * READY FOR REVIEW / RUNNING / TO DO -- zones the
 * operator attends to. INACTIVE sessions tick `lastEventAt` from
 * background activity even when nothing operator-relevant happened; that
 * caused the visual position of inactive lines to churn between polls.
 *
 * Fix: INACTIVE sorts by `startedAt` ascending. `startedAt` is frozen at
 * session creation and never changes, so ordering is stable across
 * polls.
 */

import { describe, it, expect } from 'vitest';
import { sectionLines } from '../src/tui/ordering.ts';
import type { Line, LineState } from '../src/types.ts';

function makeLine(
  id: string,
  state: LineState,
  startedAt: string,
  lastEventAt: string
): Line {
  return {
    id,
    title: id,
    projectPath: '/tmp/test',
    projectName: id,
    projectHash: 'h',
    transcriptPath: '/tmp/t.jsonl',
    state,
    startedAt,
    lastEventAt,
    lastEventSummary: 'x',
    currentBundle: null,
    deferral: null,
    capacitySignals: { queueDepth: 0, recentEventRate: 0, msSinceLastEvent: 0 },
    eventCount: 1,
  };
}

describe('INACTIVE zone stable order', () => {
  it('inactive lines sort by startedAt ascending (oldest at top)', () => {
    const lines = [
      makeLine('newer', 'idle', '2026-05-01T00:00:00Z', '2026-06-01T10:00:00Z'),
      makeLine('older', 'idle', '2026-04-01T00:00:00Z', '2026-06-01T11:00:00Z'),
      makeLine('mid', 'idle', '2026-04-15T00:00:00Z', '2026-06-01T09:00:00Z'),
    ];
    const { sections } = sectionLines(lines, new Set());
    const inactive = sections.find((s) => s.key === 'inactive')!;
    expect(inactive.lines.map((l) => l.id)).toEqual(['older', 'mid', 'newer']);
  });

  it('inactive order does NOT shift when lastEventAt updates (the churn fix)', () => {
    const lines = [
      makeLine('a', 'idle', '2026-04-01T00:00:00Z', '2026-06-01T10:00:00Z'),
      makeLine('b', 'idle', '2026-05-01T00:00:00Z', '2026-06-01T11:00:00Z'),
    ];
    const before = sectionLines(lines, new Set()).sections.find(
      (s) => s.key === 'inactive'
    )!;
    // Simulate background activity ticking `b`'s lastEventAt forward.
    const updatedLines = lines.map((l) =>
      l.id === 'b'
        ? { ...l, lastEventAt: '2026-06-01T20:00:00Z' }
        : l
    );
    const after = sectionLines(updatedLines, new Set()).sections.find(
      (s) => s.key === 'inactive'
    )!;
    expect(before.lines.map((l) => l.id)).toEqual(after.lines.map((l) => l.id));
  });

  it('active zones (ready_for_review) still sort newest-first', () => {
    const lines = [
      makeLine('old', 'ringing', '2026-04-01T00:00:00Z', '2026-06-01T10:00:00Z'),
      makeLine('new', 'ringing', '2026-04-01T00:00:00Z', '2026-06-01T20:00:00Z'),
    ];
    const { sections } = sectionLines(lines, new Set());
    const ready = sections.find((s) => s.key === 'ready_for_review')!;
    expect(ready.lines[0]!.id).toBe('new');
    expect(ready.lines[1]!.id).toBe('old');
  });
});
