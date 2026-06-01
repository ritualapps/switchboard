/**
 * The slot digit renders inline in every Board cell so direct plug-in 1-9
 * and the shell jump are honest about their addressing surface.
 */

import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { render as inkRender } from 'ink';
import { eastAsianWidth } from 'get-east-asian-width';
import stringWidth from 'string-width';
import { Board } from '../src/tui/Board.tsx';
import type { Line } from '../src/types.ts';
import { ROBOT_FAMILY, identityForSession } from '../src/tui/identity.ts';

/**
 * Find a session id whose FNV-1a hash maps to `targetSlot`. Brute-force
 * search over hex stems; the test suite already uses this pattern in
 * `tests/cli-cmd.test.ts`. Kept local to avoid a cross-test import.
 */
function findSessionIdForSlot(targetSlot: number): string {
  let counter = 0;
  while (counter < 100_000) {
    const stem = counter.toString(16).padStart(32, '0');
    const id = `${stem.slice(0, 8)}-${stem.slice(8, 12)}-${stem.slice(12, 16)}-${stem.slice(16, 20)}-${stem.slice(20, 32)}`;
    if (identityForSession(id).slot === targetSlot) return id;
    counter++;
  }
  throw new Error(`could not find session id for slot ${targetSlot}`);
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeLine(id: string): Line {
  return {
    id,
    title: `Line for ${id}`,
    projectPath: '/tmp/test',
    projectName: `proj-${id.slice(0, 4)}`,
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

/**
 * Render a Board at an explicit terminal width. `ink-testing-library`
 * hardcodes columns=100, which never exercises the narrow-width title
 * overflow path -- the condition that triggered the alignment defect this
 * guards against. We drive Ink directly with a fake stdout so the
 * regression test can pin a narrow width.
 */
function renderAtWidth(
  lines: Line[],
  columns: number,
  slotMap?: Map<string, number | null>
): string[] {
  class FakeStdout extends EventEmitter {
    columns = columns;
    rows = 40;
    _last = '';
    write = (f: string) => {
      this._last = f;
    };
    get lastFrame() {
      return this._last;
    }
  }
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read: () => null,
    setEncoding() {},
  });
  const stderr = new EventEmitter() as unknown as NodeJS.WriteStream;
  Object.assign(stderr, { write: () => true });

  const inst = inkRender(
    <Board
      lines={lines}
      focusedId={null}
      draftLineIds={new Set()}
      availableRows={30}
      slotMap={slotMap}
    />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false }
  );
  const frame = stripAnsi(stdout.lastFrame);
  inst.unmount();
  return frame.split('\n');
}

/** A cell's first line ends with the age token (e.g. `6m`, `0s`, `12d`);
 *  the footer line below it ends with `ago`. Match the former. */
function isDataRow(rstripped: string): boolean {
  return /\d+[smhd]$/.test(rstripped) && !/last event/.test(rstripped);
}

describe('Board cell -- slot digit', () => {
  it('renders the slot digit adjacent to the pictograph for every line', () => {
    const ids = [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    ];
    const lines = ids.map(makeLine);
    const { lastFrame } = render(
      <Board lines={lines} focusedId={null} draftLineIds={new Set()} />
    );
    const frame = lastFrame() ?? '';
    for (const id of ids) {
      const identity = identityForSession(id);
      // Pictograph still present.
      expect(frame).toContain(identity.pictograph);
      // Slot digit present.
      expect(frame).toContain(String(identity.slot));
    }
  });

  it('slot digit is visible when the line is focused (cursor brightens identity)', () => {
    const id = '44444444-4444-4444-4444-444444444444';
    const line = makeLine(id);
    const identity = identityForSession(id);
    const { lastFrame } = render(
      <Board lines={[line]} focusedId={id} draftLineIds={new Set()} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(String(identity.slot));
    expect(frame).toContain(identity.pictograph);
  });

  it('slot digit renders for INACTIVE-zone lines too (faded states keep address visible)', () => {
    const id = '55555555-5555-5555-5555-555555555555';
    const line = { ...makeLine(id), state: 'completed' as const };
    const identity = identityForSession(id);
    const { lastFrame } = render(
      <Board lines={[line]} focusedId={null} draftLineIds={new Set()} />
    );
    expect(lastFrame() ?? '').toContain(String(identity.slot));
  });

  /**
   * Slot-spacing invariant: pictographs of varying visual width can cause
   * cascading column drift in everything rendered to their right. To keep
   * the slot digit stable, slot is rendered BEFORE the pictograph so its
   * column is not downstream of the unpredictable glyph. For every family
   * member, the rendered Board frame must contain `<slot-digit><one-or-
   * more-spaces><pictograph>`. If a future change moves the pictograph
   * back upstream of the slot, or removes the spacing, this test fails
   * before the drift reaches the operator.
   */
  it('SLOT_SPACING_INVARIANT -- every cell renders at least 1 space between slot digit and pictograph', () => {
    // Render each family member's line in its own Board so the viewport
    // windowing (which kicks in for >5 lines in the test's default
    // 24-row terminal) does not hide pictographs.
    for (const member of ROBOT_FAMILY) {
      const line = makeLine(findSessionIdForSlot(member.slot));
      const { lastFrame } = render(
        <Board lines={[line]} focusedId={null} draftLineIds={new Set()} />
      );
      const frame = stripAnsi(lastFrame() ?? '');
      const escaped = member.pictograph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`${member.slot}\\s+${escaped}`);
      expect(frame, `${member.name} (slot ${member.slot})`).toMatch(pattern);
    }
  });

  /**
   * NO_WRAP_INVARIANT (Header pinning) -- the rendered Board frame must
   * never emit more visual rows than the row count `emitRowsForWindow`
   * predicts. Without `wrap="truncate-end"` on the title + footer +
   * deferred Text, long titles wrap to multiple visual rows and the
   * actual emit exceeds the budget that keeps the App's Header pinned
   * to the top of the alt-screen.
   */
  it('NO_WRAP_INVARIANT -- rendered frame line count <= predicted emit rows for long titles', async () => {
    const longTitleLines = Array.from({ length: 6 }, (_, i) => {
      const id = `aaaaaaaa-aaaa-aaaa-aaaa-${i.toString().padStart(12, '0')}`;
      return {
        ...makeLine(id),
        title: 'A really quite long project title that would otherwise wrap when rendered in the Board cell column flex layout',
        lastEventSummary: 'an agent message also quite long that the footer renders below the line in the dim color',
      };
    });
    const { sectionLines } = await import('../src/tui/ordering.ts');
    const { windowSections, emitRowsForWindow } = await import('../src/tui/Board.tsx');
    const { sections } = sectionLines(longTitleLines, new Set());
    const focusedId = longTitleLines[2]!.id;
    const windowed = windowSections(sections, focusedId, 24);
    const predicted = emitRowsForWindow(windowed);

    const { lastFrame } = render(
      <Board lines={longTitleLines} focusedId={focusedId} draftLineIds={new Set()} />
    );
    const frame = lastFrame() ?? '';
    const actualLines = frame.split('\n').length;
    // Actual emit must not exceed predicted (modulo trailing newline). +1
    // to allow for the trailing-newline convention used by some render
    // backends.
    expect(actualLines, `frame:\n${frame}`).toBeLessThanOrEqual(predicted + 1);
  });

  /**
   * Companion invariant: the slot digit's column-start position must be
   * the same across all family members (no horizontal jitter). With slot
   * moved BEFORE the pictograph, the slot column sits upstream of any
   * width-ambiguous glyph, so this should hold trivially
   * -- the test still locks it in case a future refactor reintroduces a
   * variable-width element to slot's left.
   */
  it('SLOT_COLUMN_INVARIANT -- slot digit column position is consistent across all family members', () => {
    const positions = new Set<number>();
    for (const member of ROBOT_FAMILY) {
      const line = makeLine(findSessionIdForSlot(member.slot));
      const { lastFrame } = render(
        <Board lines={[line]} focusedId={null} draftLineIds={new Set()} />
      );
      const frame = stripAnsi(lastFrame() ?? '');
      const escaped = member.pictograph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const ln of frame.split('\n')) {
        const re = new RegExp(`(${member.slot})\\s+${escaped}`);
        const m = re.exec(ln);
        if (m) {
          // Column index of the slot digit within the rendered cell row.
          positions.add(m.index!);
          break;
        }
      }
    }
    // Across all 9 family members the slot digit must land at the same
    // column. If a future refactor varies the layout to slot's left
    // (cursor / prefix / a new column), this fails immediately.
    expect(positions.size, `positions seen: ${Array.from(positions).join(', ')}`).toBe(1);
  });

  /**
   * NARROW_WIDTH_ALIGNMENT -- regression test for a narrow-width
   * alignment defect.
   * At a narrow terminal width, rows whose title overflows forced Yoga to
   * shrink the fixed-width columns (which lacked flexShrink={0}), but only
   * on the overflowing rows. Short-title rows kept full width, so the age
   * column right edge went ragged. The fix pins flexShrink={0} on every
   * fixed column. This test mixes long and short titles at a narrow width
   * and asserts every data row renders to the SAME width (so the age
   * column shares one right edge) and that no Ink `…` leaked in.
   */
  it('NARROW_WIDTH_ALIGNMENT -- all rows share one width at narrow terminal with mixed title lengths', () => {
    const mk = (slotTarget: number, title: string, ms: number) => ({
      ...makeLine(findSessionIdForSlot(slotTarget)),
      title,
      capacitySignals: { queueDepth: 0, recentEventRate: 0, msSinceLastEvent: ms },
    });
    const lines: Line[] = [
      mk(7, 'Plan app-factory launch roadmap and next steps for the whole team', 6 * 60_000),
      mk(5, 'Review TUI-bot drawings', 86_400_000),
      mk(6, 'Diagnose recurring C: drive storage issues across every project', 0),
      mk(1, 'unblock Ritual Apps', 0),
    ];
    const slotMap = new Map<string, number | null>(lines.map((l, i) => [l.id, [7, 5, 6, 1][i]!]));

    for (const cols of [70, 56, 100]) {
      const rows = renderAtWidth(lines, cols, slotMap);
      const dataWidths = rows
        .map((r) => r.replace(/\s+$/, ''))
        .filter(isDataRow)
        .map((r) => stringWidth(r));
      expect(new Set(dataWidths).size, `cols=${cols}, widths=${dataWidths.join(',')}\n${rows.join('\n')}`).toBe(1);
      // Width-safe marker only; Ink's ambiguous `…` must never appear.
      expect(rows.join('\n'), `cols=${cols}`).not.toContain('…');
    }
  });

  /**
   * GLYPH_WIDTH_SAFETY -- regression test for an ambiguous-glyph-width
   * defect.
   * Every glyph the Board renders into an aligned column must be
   * unambiguous-width: string-width must report 1 AND the East Asian Width
   * class must not be Ambiguous (which terminals paint as 2 cells in many
   * fonts/locales, desyncing layout from paint). Covers all 9 family
   * pictographs and the truncation marker. Ψ / ∩ / ⊙ and the `…` ellipsis
   * each FAIL this test -- that is what shipped the defect.
   */
  it('GLYPH_WIDTH_SAFETY -- every family pictograph and the truncation marker is unambiguous 1-cell', () => {
    const safe = (g: string) => {
      const cp = g.codePointAt(0)!;
      return (
        stringWidth(g) === 1 &&
        eastAsianWidth(cp) === 1 &&
        eastAsianWidth(cp, { ambiguousAsWide: true }) === 1
      );
    };
    for (const member of ROBOT_FAMILY) {
      expect(
        safe(member.pictograph),
        `${member.name} (slot ${member.slot}) pictograph ${JSON.stringify(member.pictograph)} U+${member.pictograph
          .codePointAt(0)!
          .toString(16)
          .toUpperCase()} is ambiguous/wide -- pick an EAW-Neutral glyph`
      ).toBe(true);
    }
    // The truncation marker used by Board's truncate() (`›`, not `…`).
    expect(safe('›'), 'truncation marker is not width-safe').toBe(true);
    expect(safe('…'), 'sanity: `…` is correctly flagged as unsafe').toBe(false);
  });
});
