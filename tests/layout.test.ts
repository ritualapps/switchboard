/**
 * Drill-in layout budget tests. The load-bearing guarantee is the
 * height-fit invariant: the body + annotation viewports, plus all fixed
 * chrome, must never demand more rows than the terminal has. When that
 * invariant held only by hand-counted constants split across App.tsx and
 * DrillIn.tsx it drifted, the column overflowed, and Yoga collapsed middle
 * rows ("third annotation row disappears", 2026-06-02). These tests pin the
 * invariant to one tested function.
 */

import { describe, it, expect } from 'vitest';
import {
  computeDrillInLayout,
  fitWindow,
  HEADER_ROWS,
  BOARD_PERIPHERAL_ROWS,
  DRILLIN_CHROME_ROWS,
  MIN_BODY_VIEWPORT_ROWS,
  ANNOTATION_VIEWPORT_CAP,
} from '../src/tui/layout.ts';

const ANNOTATION_SECTION_CHROME = 2; // top margin + label, mirrors layout.ts

/** Total rows the drill-in actually demands for a given layout result. */
function demandedRows(
  layout: { bodyViewportRows: number; annotationViewportRows: number },
  reservedFooterRows: number
): number {
  const annotationSection =
    layout.annotationViewportRows > 0
      ? layout.annotationViewportRows + ANNOTATION_SECTION_CHROME
      : 0;
  return (
    HEADER_ROWS +
    BOARD_PERIPHERAL_ROWS +
    reservedFooterRows +
    DRILLIN_CHROME_ROWS +
    layout.bodyViewportRows +
    annotationSection
  );
}

describe('computeDrillInLayout -- height-fit invariant', () => {
  it('never demands more rows than the terminal has, across a wide sweep', () => {
    // Fixed chrome (header + board peripheral + footer + DrillIn chrome) is
    // ~18 rows; below that the chrome itself cannot fit and no budget can
    // help. 20 is the smallest terminal Switchboard supports for drill-in.
    for (let totalRows = 20; totalRows <= 80; totalRows++) {
      for (let annotationCount = 0; annotationCount <= 12; annotationCount++) {
        for (const reservedFooterRows of [2, 3, 4]) {
          const layout = computeDrillInLayout({ totalRows, reservedFooterRows, annotationCount });
          const demand = demandedRows(layout, reservedFooterRows);
          expect(
            demand,
            `totalRows=${totalRows} ann=${annotationCount} footer=${reservedFooterRows} -> demand=${demand}`
          ).toBeLessThanOrEqual(totalRows);
        }
      }
    }
  });

  it('protects the body floor at realistic terminal heights', () => {
    const layout = computeDrillInLayout({ totalRows: 40, reservedFooterRows: 2, annotationCount: 7 });
    expect(layout.bodyViewportRows).toBeGreaterThanOrEqual(MIN_BODY_VIEWPORT_ROWS);
  });

  it('hides the annotation pane (budget 0) when there are no annotations', () => {
    const layout = computeDrillInLayout({ totalRows: 40, reservedFooterRows: 2, annotationCount: 0 });
    expect(layout.annotationViewportRows).toBe(0);
  });

  it('gives the annotation pane its full cap when the terminal is tall enough', () => {
    const layout = computeDrillInLayout({ totalRows: 50, reservedFooterRows: 2, annotationCount: 7 });
    // 5 data rows + 2 scroll indicators = 7 emit rows for an over-cap draft.
    expect(layout.annotationViewportRows).toBe(ANNOTATION_VIEWPORT_CAP + 2);
  });
});

describe('fitWindow -- contiguous, indicator-aware scrolling', () => {
  it('returns the whole list with no indicators when it fits', () => {
    const w = fitWindow(5, 2, 10);
    expect(w).toEqual({ start: 0, end: 5, aboveHidden: 0, belowHidden: 0 });
  });

  it('window is always contiguous (start < end, no gaps)', () => {
    for (let length = 1; length <= 60; length++) {
      for (let anchor = 0; anchor < length; anchor++) {
        for (const budget of [3, 5, 8, 10]) {
          const w = fitWindow(length, anchor, budget);
          expect(w.start).toBeGreaterThanOrEqual(0);
          expect(w.end).toBeLessThanOrEqual(length);
          expect(w.start).toBeLessThan(w.end);
          expect(w.aboveHidden).toBe(w.start);
          expect(w.belowHidden).toBe(length - w.end);
        }
      }
    }
  });

  it('data rows + rendered indicators never exceed budget', () => {
    for (let length = 1; length <= 60; length++) {
      for (let anchor = 0; anchor < length; anchor++) {
        for (const budget of [3, 5, 8, 10]) {
          const w = fitWindow(length, anchor, budget);
          const indicators = (w.aboveHidden > 0 ? 1 : 0) + (w.belowHidden > 0 ? 1 : 0);
          const emit = w.end - w.start + indicators;
          expect(
            emit,
            `length=${length} anchor=${anchor} budget=${budget} -> emit=${emit}`
          ).toBeLessThanOrEqual(budget);
        }
      }
    }
  });

  it('reclaims the edge row: a top-anchored window reserves only one indicator', () => {
    // 50 items, cursor at top, budget 10: only the ↓ indicator renders, so 9
    // data rows fit (the old fixed -2 reserve would have shown only 8).
    const w = fitWindow(50, 0, 10);
    expect(w.start).toBe(0);
    expect(w.aboveHidden).toBe(0);
    expect(w.end - w.start).toBe(9);
  });

  it('keeps the anchor inside the window while scrolling', () => {
    for (let anchor = 0; anchor < 50; anchor++) {
      const w = fitWindow(50, anchor, 8);
      expect(anchor).toBeGreaterThanOrEqual(w.start);
      expect(anchor).toBeLessThan(w.end);
    }
  });

  it('maxData caps visible rows below the budget (annotation pane behaviour)', () => {
    // Budget 7 leaves room for 5 data + 2 indicators, but maxData=5 must hold
    // the data band to 5 even when more rows would fit -- the annotation-pane cap.
    for (let anchor = 0; anchor < 8; anchor++) {
      const w = fitWindow(8, anchor, ANNOTATION_VIEWPORT_CAP + 2, ANNOTATION_VIEWPORT_CAP);
      expect(w.end - w.start).toBeLessThanOrEqual(ANNOTATION_VIEWPORT_CAP);
    }
    // Top-anchored: exactly 5 data + a single below indicator.
    const top = fitWindow(8, 0, ANNOTATION_VIEWPORT_CAP + 2, ANNOTATION_VIEWPORT_CAP);
    expect(top.start).toBe(0);
    expect(top.end - top.start).toBe(ANNOTATION_VIEWPORT_CAP);
    expect(top.aboveHidden).toBe(0);
    expect(top.belowHidden).toBe(3);
  });
});
