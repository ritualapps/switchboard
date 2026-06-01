/**
 * Drill-in height-fit regression (2026-06-02).
 *
 * The bug: drilling into a line with a multi-line body and a 7-item draft, the
 * live binary dropped the third row of the body AND of the annotation pane,
 * and collapsed the `↑ N above` indicators onto adjacent rows. Root cause:
 * the body + annotation viewports demanded more rows than App's
 * `height={totalRows}` column, so Yoga resolved the overflow by shrinking
 * flex children to zero height.
 *
 * Why the old suite missed it: every existing DrillIn test renders the
 * component standalone, with no height pin, so it can never reproduce the
 * overflow. This test renders the FULL App through a custom stdout that
 * reports real `rows`, so the pinned column is active -- the only harness
 * that can catch this class of defect.
 *
 * The fix has two halves, both asserted here: fixed rows carry
 * `flexShrink={0}` (no row can collapse) and computeDrillInLayout keeps the
 * budget within the column (no overflow to resolve). The pane therefore
 * renders a contiguous window with the indicators on their own lines.
 */

import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { render as inkRender } from 'ink';
import type { Line, LineState, LineDraft } from '../src/types.ts';
import type { SwitchboardAdapter } from '../src/adapter.ts';

vi.mock('../src/audit/log.js', () => ({
  appendHistoryEvent: vi.fn().mockResolvedValue(undefined),
}));

const draft: LineDraft = {
  lineId: 'line-1',
  bundleId: 'bundle-1',
  startedAt: new Date().toISOString(),
  annotations: Array.from({ length: 7 }, (_, i) => ({
    id: `ann-${i}`,
    anchor: { kind: 'body_position' as const, line: i + 1 },
    content: `annotation #${i + 1} content`,
  })),
};

vi.mock('../src/state-overlay/drafts.js', () => ({
  loadDraftsSync: () => new Map([['line-1', draft]]),
  saveDrafts: vi.fn(),
  flushPendingDraftWrite: vi.fn().mockResolvedValue(undefined),
}));

const { App } = await import('../src/tui/App.tsx');

const bodyText = Array.from({ length: 20 }, (_, i) => `body line ${i + 1}`).join('\n');

function makeLine(title = 'Test line'): Line {
  return {
    id: 'line-1',
    title,
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
      body: bodyText,
      summary: 'sum',
    },
    deferral: null,
    capacitySignals: { queueDepth: 0, recentEventRate: 0, msSinceLastEvent: 100 },
    eventCount: 1,
  };
}

function makeAdapter(initialLines: Line[]): SwitchboardAdapter {
  const lines = [...initialLines];
  return {
    getLines: () => lines,
    on: () => {},
    off: () => {},
    setManualState: () => {},
    dismiss: async () => {},
    undismiss: async () => {},
    stop: async () => {},
  } as unknown as SwitchboardAdapter;
}

/** Fake stdout that reports real rows/columns so App's height pin is active. */
class SizedStdout extends EventEmitter {
  readonly columns: number;
  readonly rows: number;
  _lastFrame = '';
  constructor(rows: number, columns: number) {
    super();
    this.rows = rows;
    this.columns = columns;
  }
  write = (frame: string): void => {
    this._lastFrame = frame;
  };
  lastFrame = (): string => this._lastFrame;
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = (data: string): void => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

function renderApp(rows: number, columns = 100, line: Line = makeLine()) {
  const stdout = new SizedStdout(rows, columns);
  const stderr = new SizedStdout(rows, columns);
  const stdin = new FakeStdin();
  const instance = inkRender(<App adapter={makeAdapter([line])} />, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: stdout as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stderr: stderr as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdin: stdin as any,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdin, lastFrame: stdout.lastFrame, unmount: instance.unmount };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 50));
const ENTER = '\r';
const DOWN = '\x1b[B';

/** Strip ANSI colour / style escape sequences so text matching is reliable. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Pull the ordinal numbers (`N.`) from rendered annotation rows, in order. */
function annotationOrdinals(frame: string): number[] {
  return stripAnsi(frame)
    .split('\n')
    .map((line) => /(\d+)\.\s+L\d+\s+annotation #\d/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
}

/** Pull the body line numbers (`L<n>`) from rendered body rows, in order. */
function bodyLineNumbers(frame: string): number[] {
  return stripAnsi(frame)
    .split('\n')
    .map((line) => /L(\d+)\s+body line \d/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
}

describe('drill-in height-fit (full App, height pin active)', () => {
  it('renders a contiguous annotation window with cursor deep in the pane -- no dropped middle row', async () => {
    const { stdin, lastFrame, unmount } = renderApp(40);
    await tick();
    stdin.write(ENTER); // plug in
    await tick();
    for (let i = 0; i < 24; i++) {
      stdin.write(DOWN); // walk past body into the annotations
      await tick();
    }
    const frame = lastFrame();
    const ordinals = annotationOrdinals(frame);

    // At least 5 annotation rows render (the pane is not squashed)...
    expect(ordinals.length).toBeGreaterThanOrEqual(5);
    // ...and they are strictly consecutive -- the defect was a gap (e.g.
    // 3,5,6,7 with ordinal 4 collapsed to zero height).
    for (let i = 1; i < ordinals.length; i++) {
      expect(
        ordinals[i],
        `annotation ordinals not contiguous: ${ordinals.join(',')}`
      ).toBe(ordinals[i - 1]! + 1);
    }
    unmount();
  });

  it('renders a contiguous body window -- no dropped middle line, indicator on its own row', async () => {
    const { stdin, lastFrame, unmount } = renderApp(40);
    await tick();
    stdin.write(ENTER);
    await tick();
    for (let i = 0; i < 18; i++) {
      stdin.write(DOWN); // scroll the body so indicators are present
      await tick();
    }
    const frame = lastFrame();
    const bodyNums = bodyLineNumbers(frame);
    expect(bodyNums.length).toBeGreaterThan(0);
    for (let i = 1; i < bodyNums.length; i++) {
      expect(
        bodyNums[i],
        `body line numbers not contiguous: ${bodyNums.join(',')}`
      ).toBe(bodyNums[i - 1]! + 1);
    }
    // The collapsed-indicator signature was the scroll hint merging onto a
    // body row ("L15 body line 15(j/k to scroll)"). With flexShrink the hint
    // keeps its own line.
    expect(stripAnsi(frame)).not.toMatch(/body line \d+\(j\/k to scroll\)/);
    unmount();
  });

  it('long auto-title does not collapse the header onto the state line', async () => {
    // Regression: Claude Code auto-titles can be far longer than the terminal
    // width. Without flexShrink={0} on the header box AND a one-row clamp on
    // the title, a wrapping title overflowed its 1-row budget, Yoga collapsed
    // the (only shrinkable) header, and the title's tail bled onto the state
    // line ("...plugged inUNIQUETAILMARKER"). A title SHORTER than the state
    // line hid the defect, which is why it read as "inconsistent".
    const TITLE =
      'Review workspace structure and leave cleanup notes ' +
      'then keep going well past the terminal width so this wraps across rows '.repeat(2) +
      'UNIQUETAILMARKER';
    const { stdin, lastFrame, unmount } = renderApp(40, 80, makeLine(TITLE));
    await tick();
    stdin.write(ENTER); // plug in
    await tick();
    // Restrict to the drill-in's bordered rows (│ ... │) so we don't match the
    // unbordered board-peripheral cell, which also carries the title.
    const borderedLines = stripAnsi(lastFrame())
      .split('\n')
      .filter((l) => l.includes('│'));

    // The state row renders on its OWN line with NO title text bled onto it.
    // Pre-fix the collapsed header painted the title's tail past "plugged in".
    const stateRow = borderedLines.find((l) => l.includes('plugged in'));
    expect(stateRow, 'drill-in state row not found').toBeDefined();
    expect(stateRow!, 'title text leaked onto the state line').not.toMatch(
      /Review|cleanup|UNIQUETAILMARKER/
    );

    // The title renders on a SEPARATE bordered row, clamped to one line (its
    // head visible, tail truncated away). Pre-fix the header collapsed and the
    // title head was overpainted, so no such row existed.
    const titleRow = borderedLines.find((l) => l.includes('Review workspace structure'));
    expect(titleRow, 'drill-in title row not found (header collapsed?)').toBeDefined();
    expect(titleRow!).not.toContain('plugged in');
    expect(titleRow!, 'title not clamped to one row').not.toContain('UNIQUETAILMARKER');
    unmount();
  });
});
