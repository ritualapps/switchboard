/**
 * App-level surface-close and left-arrow routing: left-arrow is
 * context-sensitive and Esc is the universal back-out.
 *
 * Esc / left-arrow routing lives in App rather than DrillIn, so these checks
 * mount App + DrillIn + TextInput together via ink-testing-library and cover
 * the full set of bindings:
 *
 *   - content step + Esc       -> back to navigate, content cleared
 *   - content step + ←          -> NOT a back-out; TextInput consumes it
 *                                  natively and the typed content is preserved
 *                                  (the data-loss case this guards against)
 *   - navigate step + ←         -> full disconnect to board
 *
 * Hermetic: state-overlay + audit log writers are mocked so the test does not
 * touch ~/.switchboard.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import type { Line, LineState } from '../src/types.ts';
import type { SwitchboardAdapter } from '../src/adapter.ts';

vi.mock('../src/audit/log.js', () => ({
  appendHistoryEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/state-overlay/drafts.js', () => ({
  loadDraftsSync: () => new Map(),
  saveDrafts: vi.fn(),
  flushPendingDraftWrite: vi.fn().mockResolvedValue(undefined),
}));

// App must be imported AFTER the mocks above so its `import` of the audit
// log + drafts modules resolves to the stubs.
const { App } = await import('../src/tui/App.tsx');

function makeLine(overrides: Partial<Line> = {}): Line {
  return {
    id: 'line-1',
    title: 'Test line',
    projectPath: '/tmp/test',
    projectName: 'test',
    projectHash: 'test',
    transcriptPath: '/tmp/test.jsonl',
    state: 'ringing' as LineState,
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastEventSummary: 'agent posted body',
    currentBundle: {
      id: 'bundle-1',
      lineId: 'line-1',
      createdAt: new Date().toISOString(),
      body: 'first body line\nsecond body line\nthird body line',
      summary: 'sum',
    },
    deferral: null,
    capacitySignals: {
      queueDepth: 0,
      recentEventRate: 0,
      msSinceLastEvent: 100,
    },
    eventCount: 1,
    ...overrides,
  };
}

function makeAdapter(initialLines: Line[]): SwitchboardAdapter {
  const lines = [...initialLines];
  const listeners = new Set<(next: Line[]) => void>();
  return {
    getLines: () => lines,
    on: (_event, fn) => {
      listeners.add(fn);
    },
    off: (_event, fn) => {
      listeners.delete(fn);
    },
    setManualState: () => {},
    dismiss: async () => {},
    undismiss: async () => {},
    stop: async () => {},
  } as SwitchboardAdapter;
}

const ENTER = '\r';
const ESC = '\x1b';
const LEFT_ARROW = '\x1b[D';
const RIGHT_ARROW = '\x1b[C';
const UP_ARROW = '\x1b[A';
const OPEN_ANNOTATION = 'a';

const tick = () => new Promise<void>((r) => setTimeout(r, 50));

describe('App-level surface-close + left-arrow routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('content step + Esc: cancels, returns to navigate, content cleared, still in drill-in', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    // Plug in
    stdin.write(ENTER);
    await tick();
    // Open annotation input
    stdin.write(OPEN_ANNOTATION);
    await tick();
    expect(lastFrame()).toContain('annotate at L1');
    // Type content
    stdin.write('partial annotation text');
    await tick();
    expect(lastFrame()).toContain('partial annotation text');
    // Esc cancels
    stdin.write(ESC);
    await tick();
    // Back to navigate: no annotation input, content gone, drill-in still mounted
    expect(lastFrame()).not.toContain('annotate at L1');
    expect(lastFrame()).not.toContain('partial annotation text');
    expect(lastFrame()).toContain('Test line'); // drill-in title still visible
  });

  it('content step + ←: TextInput consumes left-arrow as cursor edit; typed content preserved (data-loss fix)', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(OPEN_ANNOTATION);
    await tick();
    stdin.write('keep this content');
    await tick();
    expect(lastFrame()).toContain('keep this content');
    expect(lastFrame()).toContain('annotate at L1');
    // Left-arrow: must NOT cancel the surface. Content preserved.
    stdin.write(LEFT_ARROW);
    await tick();
    expect(lastFrame()).toContain('keep this content');
    expect(lastFrame()).toContain('annotate at L1'); // still in content step
    // Multiple left-arrows still safe
    stdin.write(LEFT_ARROW);
    stdin.write(LEFT_ARROW);
    await tick();
    expect(lastFrame()).toContain('keep this content');
    expect(lastFrame()).toContain('annotate at L1');
  });

  it('navigate step + ←: full disconnect to board (operator-approved behaviour preserved)', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    // Plug in -> drill-in/navigate
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('Test line'); // drill-in title
    expect(lastFrame()).toContain('plugged in');
    // Left-arrow from navigate (no TextInput mounted) -> back to board
    stdin.write(LEFT_ARROW);
    await tick();
    expect(lastFrame()).not.toContain('plugged in'); // drill-in unmounted
    expect(lastFrame()).not.toContain('annotate at L');
  });

  it('content step + ↑: inert and preserves the typed buffer (data-loss fix)', async () => {
    // Up-arrow was originally a second back-out gesture alongside Esc on the
    // rationale that TextInput has no native up-arrow meaning. Operator hit
    // it while editing a multi-line annotation and lost work. Behaviour
    // changed: up-arrow now falls through (inert for single-line TextInput);
    // the operator's typed buffer is preserved. Esc remains the cancel.
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(OPEN_ANNOTATION);
    await tick();
    stdin.write('typed text');
    await tick();
    expect(lastFrame()).toContain('typed text');
    expect(lastFrame()).toContain('annotate at L1');
    stdin.write(UP_ARROW);
    await tick();
    // Content step still open; typed buffer preserved.
    expect(lastFrame()).toContain('annotate at L1');
    expect(lastFrame()).toContain('typed text');
  });

  it('content step + ← then Enter commits the edited content (end-to-end safety check)', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(OPEN_ANNOTATION);
    await tick();
    stdin.write('hello world');
    await tick();
    // Left-arrow x6 leaves cursor in the middle of "hello world" without losing it
    for (let i = 0; i < 6; i++) {
      stdin.write(LEFT_ARROW);
    }
    await tick();
    expect(lastFrame()).toContain('hello world');
    // Enter commits whatever was typed
    stdin.write(ENTER);
    await tick();
    // After commit: back to navigate, annotation input gone
    expect(lastFrame()).not.toContain('annotate at L1');
    // Drill-in still mounted (commit returns to navigate, not full disconnect)
    expect(lastFrame()).toContain('Test line');
  });
});

describe('estimateFooterRows (footer-rows reservation)', () => {
  it('returns at least 2 rows for any hint (1 content + 1 marginTop)', async () => {
    const { estimateFooterRows } = await import('../src/tui/App.tsx');
    expect(estimateFooterRows('', 80)).toBe(2);
    expect(estimateFooterRows('short hint', 80)).toBe(2);
  });

  it('grows the reservation as hint length / cols increases', async () => {
    const { estimateFooterRows } = await import('../src/tui/App.tsx');
    const hint = '↓↑/j/k nav · enter/→ plug in · 1-9 plug in by slot · D defer · u un-defer · X dismiss · h hand-back · q quit  ·  3 lines';
    // 130 char hint at 80 cols: 2 wrap rows + 1 margin = 3
    expect(estimateFooterRows(hint, 80)).toBeGreaterThanOrEqual(3);
    // 60 cols: 3 wrap rows + 1 margin = 4
    expect(estimateFooterRows(hint, 60)).toBeGreaterThanOrEqual(3);
    // 200 cols: 1 row + 1 margin = 2
    expect(estimateFooterRows(hint, 200)).toBeLessThanOrEqual(3);
  });
});

describe('App behaviour: defer, slot plug-in, zone navigation, and staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pressing D moves a line from NEEDS YOU to TO DO with no modal', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    // No defer-pick / defer-reason surfaces should ever appear -- the
    // single-keystroke MVP defer model has no modal.
    stdin.write('D');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('defer test until');
    expect(frame).not.toContain('overnight');
    expect(frame).not.toContain('reason');
    // Line moved to TO DO zone (deferred state -> TO DO section label).
    expect(frame).toContain('TO DO');
    // MVP deferral carries no reason; the cell footer renders a bare
    // "deferred" (without "deferred: <reason>").
    expect(frame).toContain('deferred');
    // Toast `deferred: <projectName>` reaches the screen (substring check
    // separated because ink wraps long footer lines in the test viewport).
    expect(frame).toContain('deferred:');
    expect(frame).toContain('test');
  });

  it('plug-in from TO DO re-engages a deferred line and clears the deferral', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write('D');
    await tick();
    expect(lastFrame()).toContain('TO DO');
    // Plug in: the line should re-engage (defer cleared); drill-in mounts.
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('plugged in');
    // Disconnect; line should no longer be in TO DO.
    stdin.write(LEFT_ARROW);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('TO DO');
  });

  it('q in drill-in navigate disconnects', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('plugged in');
    stdin.write('q');
    await tick();
    expect(lastFrame()).not.toContain('plugged in');
  });

  it('header reads "h hand-back" when a draft exists', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write(ENTER); // plug in
    await tick();
    stdin.write(OPEN_ANNOTATION);
    await tick();
    stdin.write('something');
    await tick();
    stdin.write(ENTER); // commit
    await tick();
    stdin.write(LEFT_ARROW); // back to board
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('h hand-back');
    expect(frame).not.toContain('p hand-back');
  });

  it('digit 1-9 plugs into the line whose slot matches', async () => {
    const { identityForSession } = await import('../src/tui/identity.ts');
    // Build a line whose identity slot we know.
    const baseLine = makeLine();
    const slot = identityForSession(baseLine.id).slot;
    const adapter = makeAdapter([baseLine]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    expect(lastFrame()).not.toContain('plugged in');
    stdin.write(String(slot));
    await tick();
    // Drill-in mounts on the slot-matched line.
    expect(lastFrame()).toContain('plugged in');
    expect(lastFrame()).toContain('Test line');
  });

  it('digit with no matching slot is a no-op', async () => {
    const { identityForSession } = await import('../src/tui/identity.ts');
    const baseLine = makeLine();
    const occupiedSlot = identityForSession(baseLine.id).slot;
    const wrongSlot = occupiedSlot === 9 ? 1 : 9;
    const adapter = makeAdapter([baseLine]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write(String(wrongSlot));
    await tick();
    // Still on the board; drill-in did not mount.
    expect(lastFrame()).not.toContain('plugged in');
  });

  it('direct-slot plug-in clears the deferral (operator re-engagement)', async () => {
    const { identityForSession } = await import('../src/tui/identity.ts');
    const baseLine = makeLine();
    const slot = identityForSession(baseLine.id).slot;
    const adapter = makeAdapter([baseLine]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write('D');
    await tick();
    expect(lastFrame()).toContain('TO DO');
    // Direct-slot plug-in re-engages.
    stdin.write(String(slot));
    await tick();
    expect(lastFrame()).toContain('plugged in');
    // Disconnect; line should not return to TO DO (defer was cleared).
    stdin.write(LEFT_ARROW);
    await tick();
    expect(lastFrame()).not.toContain('TO DO');
  });

  it('n walks to the next ringing line in the same zone', async () => {
    // Three ringing lines in READY FOR REVIEW zone, distinct lastEventAt.
    const now = Date.now();
    const lineA = makeLine({
      id: 'a0000000-0000-0000-0000-000000000001',
      projectName: 'projA',
      title: 'A line',
      lastEventAt: new Date(now - 30_000).toISOString(),
    });
    const lineB = makeLine({
      id: 'b0000000-0000-0000-0000-000000000002',
      projectName: 'projB',
      title: 'B line',
      lastEventAt: new Date(now - 20_000).toISOString(),
    });
    const lineC = makeLine({
      id: 'c0000000-0000-0000-0000-000000000003',
      projectName: 'projC',
      title: 'C line',
      lastEventAt: new Date(now - 10_000).toISOString(),
    });
    const adapter = makeAdapter([lineA, lineB, lineC]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    // Ordering: within-zone by lastEventAt desc -> C, B, A.
    // Initial focus = first orderedId = C.
    expect(lastFrame()).toMatch(/▸.*C line/);
    stdin.write('n');
    await tick();
    expect(lastFrame()).toMatch(/▸.*B line/);
    stdin.write('n');
    await tick();
    expect(lastFrame()).toMatch(/▸.*A line/);
    // Wrap.
    stdin.write('n');
    await tick();
    expect(lastFrame()).toMatch(/▸.*C line/);
  });

  it('N walks backward and wraps', async () => {
    const now = Date.now();
    const a = makeLine({
      id: 'a0000000-0000-0000-0000-000000000001',
      projectName: 'projA',
      title: 'A line',
      lastEventAt: new Date(now - 30_000).toISOString(),
    });
    const b = makeLine({
      id: 'b0000000-0000-0000-0000-000000000002',
      projectName: 'projB',
      title: 'B line',
      lastEventAt: new Date(now - 20_000).toISOString(),
    });
    const adapter = makeAdapter([a, b]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    // Order: B (newer), A (older). Initial focus = B.
    expect(lastFrame()).toMatch(/▸.*B line/);
    stdin.write('N');
    await tick();
    expect(lastFrame()).toMatch(/▸.*A line/);
    // Wrap.
    stdin.write('N');
    await tick();
    expect(lastFrame()).toMatch(/▸.*B line/);
  });

  it('n stays within the zone and does not jump from NEEDS YOU to RUNNING', async () => {
    const ringing = makeLine({
      id: 'a0000000-0000-0000-0000-000000000001',
      projectName: 'ringing',
      title: 'ringing line',
      state: 'ringing',
    });
    const inProgress = makeLine({
      id: 'b0000000-0000-0000-0000-000000000002',
      projectName: 'running',
      title: 'running line',
      state: 'in_progress',
    });
    const adapter = makeAdapter([ringing, inProgress]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    expect(lastFrame()).toMatch(/▸.*ringing line/);
    stdin.write('n');
    await tick();
    // No other ringing line in the same zone, so focus stays put.
    expect(lastFrame()).toMatch(/▸.*ringing line/);
    // Running line is not focused.
    expect(lastFrame()).not.toMatch(/▸.*running line/);
  });

  it('drill-in -- D from the navigate step defers and disconnects to the board', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    // Plug in.
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('plugged in');
    // D in drill-in/navigate fires defer + disconnect.
    stdin.write('D');
    await tick();
    const frame = lastFrame() ?? '';
    // Drill-in unmounted (back to board).
    expect(frame).not.toContain('plugged in');
    // Line moved to TO DO zone.
    expect(frame).toContain('TO DO');
    // Toast confirms.
    expect(frame).toContain('deferred:');
  });

  it('only the DrillIn footer renders in drill_in mode (no dual footer)', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // DrillIn's step-aware footer is present.
    expect(frame).toMatch(/cursor.*annotate.*disconnect/);
    // The App-level board hint is NOT present in drill_in mode.
    expect(frame).not.toContain('plug in by slot');
    expect(frame).not.toContain('un-defer');
    expect(frame).not.toMatch(/q quit/);
  });

  it('two-surface layout: board and drill-in render together', async () => {
    const { identityForSession } = await import('../src/tui/identity.ts');
    const baseLine = makeLine();
    const slot = identityForSession(baseLine.id).slot;
    const adapter = makeAdapter([baseLine]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    stdin.write(String(slot));
    await tick();
    const frame = lastFrame() ?? '';
    // Drill-in title visible.
    expect(frame).toContain('Test line');
    expect(frame).toContain('plugged in');
    // Board zone label still visible (board not displaced).
    expect(frame).toMatch(/READY FOR REVIEW|NEEDS YOU|RUNNING|TO DO|INACTIVE/);
  });

  it('no staleness toast or marker ever surfaces (system surfaces; operator judges)', async () => {
    const adapter = makeAdapter([makeLine()]);
    const { stdin, lastFrame } = render(<App adapter={adapter} />);
    await tick();
    // Draft an annotation, then advance the line's currentBundle to simulate
    // the prior "staleness" trigger.
    stdin.write(ENTER);
    await tick();
    stdin.write(OPEN_ANNOTATION);
    await tick();
    stdin.write('committed annotation');
    await tick();
    stdin.write(ENTER);
    await tick();
    // Disconnect to board so we can see the cell.
    stdin.write(LEFT_ARROW);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/stale/i);
    expect(frame).not.toContain('marked stale');
    expect(frame).not.toContain('review before hand back');
  });
});
