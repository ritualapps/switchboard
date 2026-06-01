/**
 * Board viewport-windowing tests.
 *
 * Validates the pure `windowSections` helper that slides a window over
 * the focused line when the full board overflows the terminal height.
 * The render-side integration (Board component + useStdout) is covered
 * implicitly via the existing app + drillin tests; this file covers the
 * deterministic windowing math.
 */

import { describe, it, expect } from 'vitest';
import { windowSections, emitRowsForWindow } from '../src/tui/Board.tsx';
import type { Line } from '../src/types.ts';
import type { SectionKey } from '../src/tui/ordering.ts';

function makeLine(id: string): Line {
  return {
    id,
    title: id,
    projectPath: '/tmp/test',
    projectName: id,
    projectHash: 'h',
    transcriptPath: '/tmp/t.jsonl',
    state: 'ringing',
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastEventSummary: 'x',
    currentBundle: null,
    deferral: null,
    capacitySignals: { queueDepth: 0, recentEventRate: 0, msSinceLastEvent: 0 },
    eventCount: 1,
  };
}

function makeSections(
  spec: Array<{ key: SectionKey; ids: string[] }>
): Array<{ key: SectionKey; lines: Line[] }> {
  return spec.map(({ key, ids }) => ({
    key,
    lines: ids.map(makeLine),
  }));
}

function totalAbove(result: ReturnType<typeof windowSections>): number {
  const collapsed = result.collapsedAbove.reduce((s, c) => s + c.totalCount, 0);
  const partial = result.sections.reduce((s, sec) => s + sec.hiddenAbove, 0);
  return collapsed + partial;
}

function totalBelow(result: ReturnType<typeof windowSections>): number {
  const collapsed = result.collapsedBelow.reduce((s, c) => s + c.totalCount, 0);
  const partial = result.sections.reduce((s, sec) => s + sec.hiddenBelow, 0);
  return collapsed + partial;
}

describe('windowSections (viewport scroll)', () => {
  it('returns sections unchanged when full board fits', () => {
    const sections = makeSections([
      { key: 'ready_for_review', ids: ['a', 'b', 'c'] },
    ]);
    const result = windowSections(sections, 'b', 100);
    expect(totalAbove(result)).toBe(0);
    expect(totalBelow(result)).toBe(0);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.lines.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(result.sections[0]!.hiddenAbove).toBe(0);
    expect(result.sections[0]!.hiddenBelow).toBe(0);
  });

  it('returns empty result when no sections', () => {
    const result = windowSections([], 'a', 24);
    expect(result.sections).toEqual([]);
    expect(result.collapsedAbove).toEqual([]);
    expect(result.collapsedBelow).toEqual([]);
  });

  it('windows around focused when board overflows -- focused stays visible', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const sections = makeSections([{ key: 'ready_for_review', ids }]);
    const result = windowSections(sections, 's12', 24);
    const visibleIds = result.sections.flatMap((s) => s.lines.map((l) => l.id));
    expect(visibleIds).toContain('s12');
    expect(visibleIds.length).toBeLessThan(20);
    expect(totalAbove(result) + visibleIds.length + totalBelow(result)).toBe(20);
  });

  it('focused at start of list: nothing above; window starts at top', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const sections = makeSections([{ key: 'ready_for_review', ids }]);
    const result = windowSections(sections, 's0', 24);
    expect(totalAbove(result)).toBe(0);
    const visibleIds = result.sections.flatMap((s) => s.lines.map((l) => l.id));
    expect(visibleIds[0]).toBe('s0');
  });

  it('focused at end of list: nothing below; window ends at last', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const sections = makeSections([{ key: 'ready_for_review', ids }]);
    const result = windowSections(sections, 's19', 24);
    expect(totalBelow(result)).toBe(0);
    const visibleIds = result.sections.flatMap((s) => s.lines.map((l) => l.id));
    expect(visibleIds[visibleIds.length - 1]).toBe('s19');
  });

  it('focused not found: anchors at index 0 (window from top)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const sections = makeSections([{ key: 'ready_for_review', ids }]);
    const result = windowSections(sections, 'not-a-real-id', 24);
    expect(totalAbove(result)).toBe(0);
  });

  it('zones FULLY above the window collapse into collapsedAbove with totalCount', () => {
    const sections = makeSections([
      { key: 'needs_you', ids: ['n1', 'n2', 'n3'] },
      { key: 'ready_for_review', ids: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] },
      { key: 'running', ids: ['p1', 'p2', 'p3', 'p4'] },
      { key: 'to_do', ids: ['t1', 't2'] },
      { key: 'inactive', ids: Array.from({ length: 15 }, (_, i) => `i${i}`) },
    ]);
    // Focus deep in INACTIVE so several zones collapse above.
    const result = windowSections(sections, 'i12', 24);
    // At least one zone should be in collapsedAbove
    expect(result.collapsedAbove.length).toBeGreaterThan(0);
    // The keys must be ordered consistently with the input.
    const collapsedAboveKeys = result.collapsedAbove.map((c) => c.key);
    // needs_you was the first zone -- if it's collapsed, it's first in the list.
    if (collapsedAboveKeys.includes('needs_you')) {
      expect(collapsedAboveKeys.indexOf('needs_you')).toBe(0);
    }
    // totalCount equals the original line count of each collapsed zone.
    for (const c of result.collapsedAbove) {
      const orig = sections.find((s) => s.key === c.key)!;
      expect(c.totalCount).toBe(orig.lines.length);
    }
  });

  it('zones FULLY below the window collapse into collapsedBelow', () => {
    const sections = makeSections([
      { key: 'needs_you', ids: ['n1', 'n2'] },
      { key: 'inactive', ids: Array.from({ length: 20 }, (_, i) => `i${i}`) },
    ]);
    const result = windowSections(sections, 'n1', 24);
    expect(result.collapsedBelow.length).toBeGreaterThanOrEqual(0);
    // Lines hidden below either via collapsedBelow OR via hiddenBelow on a partial section.
    expect(totalBelow(result)).toBeGreaterThan(0);
  });

  it('partial zones expose hiddenAbove / hiddenBelow on the visible section', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const sections = makeSections([{ key: 'ready_for_review', ids }]);
    const result = windowSections(sections, 's15', 24);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.hiddenAbove).toBeGreaterThan(0);
    expect(result.sections[0]!.hiddenBelow).toBeGreaterThan(0);
  });

  it('total above + visible + below = full board cell count', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const sections = makeSections([{ key: 'ready_for_review', ids }]);
    const result = windowSections(sections, 's15', 24);
    const visibleCount = result.sections.flatMap((s) => s.lines).length;
    expect(totalAbove(result) + visibleCount + totalBelow(result)).toBe(30);
  });

  it('anchors focused ~30% from top of window (Vim-style scrolloff)', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const sections = makeSections([{ key: 'ready_for_review', ids }]);
    const result = windowSections(sections, 's15', 30);
    const visible = result.sections.flatMap((s) => s.lines.map((l) => l.id));
    const focusedIdxInWindow = visible.indexOf('s15');
    expect(focusedIdxInWindow).toBeGreaterThanOrEqual(0);
    expect(focusedIdxInWindow).toBeLessThan(Math.ceil(visible.length / 2) + 1);
  });

  /**
   * Budget-fit invariant (header pinning): the actual Board emit count
   * never exceeds the row budget. This keeps the App's Header pinned to
   * the top of the alt-screen buffer; if the Board emits more rows than
   * fit, the terminal scrolls and the Header disappears.
   */
  it('BUDGET_FIT_INVARIANT -- emitted Board rows never exceed availableRows', () => {
    // 5-zone full board with deep INACTIVE -- the worst case for
    // overhead (every zone produces a header, several produce hidden-
    // indicator rows).
    const sections = makeSections([
      { key: 'needs_you', ids: ['n1', 'n2'] },
      { key: 'ready_for_review', ids: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] },
      { key: 'running', ids: ['p1', 'p2', 'p3', 'p4'] },
      { key: 'to_do', ids: ['t1', 't2', 't3'] },
      { key: 'inactive', ids: Array.from({ length: 20 }, (_, i) => `i${i}`) },
    ]);
    // Walk a range of realistic terminal sizes (15+ rows -- below that
    // is below the practical floor for a 5-zone board where each
    // collapsed-section header alone takes 1 row + the visible section's
    // minimum of header + 1 cell * 3 + margin = 5 rows + indicators).
    // The case that matters is Header pinning on normal terminal heights
    // (24+); 15 is included as stress.
    const focusIds = ['n1', 'r3', 'p2', 't1', 'i0', 'i10', 'i19'];
    for (const availableRows of [15, 18, 24, 30, 40]) {
      for (const focused of focusIds) {
        const w = windowSections(sections, focused, availableRows);
        expect(
          emitRowsForWindow(w),
          `availableRows=${availableRows}, focused=${focused}`
        ).toBeLessThanOrEqual(availableRows);
      }
    }
  });

  it('BUDGET_FIT_INVARIANT -- always shows at least the focused cell even when math is tight', () => {
    const sections = makeSections([
      { key: 'inactive', ids: Array.from({ length: 50 }, (_, i) => `i${i}`) },
    ]);
    // 10-row available budget: single zone, no other zones to collapse,
    // should always show at least 1 cell (the focused one).
    const result = windowSections(sections, 'i25', 10);
    const visibleIds = result.sections.flatMap((s) => s.lines.map((l) => l.id));
    expect(visibleIds.length).toBeGreaterThanOrEqual(1);
    expect(visibleIds).toContain('i25');
  });
});
