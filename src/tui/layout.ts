/**
 * Drill-in layout budget -- the single source of truth for dividing the
 * height-pinned terminal column among the board peripheral, the body
 * viewport, the annotation pane, and fixed chrome.
 *
 * Why this module exists. The body and annotation viewports both render
 * inside App's `height={totalRows}` column. If their combined row demand
 * exceeds that height, Yoga resolves the overflow by shrinking flex children
 * -- collapsing rows to zero height, which the terminal paints as vanished
 * middle rows and overlapping indicator text. The cure has two halves, and
 * both must hold:
 *
 *   1. Every fixed-height row carries `flexShrink={0}` (in DrillIn.tsx) so
 *      Yoga can never collapse it.
 *   2. The row budget below never exceeds the available height, so there is
 *      no overflow for Yoga to resolve in the first place.
 *
 * Keeping the arithmetic here -- pure and unit-tested -- stops the budget
 * drifting out of sync across App.tsx and DrillIn.tsx, which is the class of
 * defect that produced the "third annotation row disappears" bug.
 */

/** Maximum annotation rows the pane shows before it scrolls internally. */
export const ANNOTATION_VIEWPORT_CAP = 5;

/**
 * Fixed chrome inside the DrillIn border, independent of body / annotation
 * content: title + state line + body label + DrillIn footer hint + vertical
 * padding (top + bottom) + border (top + bottom).
 */
export const DRILLIN_CHROME_ROWS = 7;

/**
 * The board collapses to a peripheral strip while drilled in: section header
 * + one focused cell + a couple of collapsed siblings.
 */
export const BOARD_PERIPHERAL_ROWS = 8;

export const HEADER_ROWS = 1;

/**
 * The body viewport never shrinks below this many rows. When the terminal is
 * too short to satisfy both panes, the annotation pane yields first (it
 * scrolls within whatever rows remain) -- but the body keeps at least this
 * floor so the operator always has reading context.
 */
export const MIN_BODY_VIEWPORT_ROWS = 4;

export interface DrillInLayout {
  /** Rows the body viewport may emit in total (data + scroll indicators). */
  bodyViewportRows: number;
  /**
   * Rows the annotation viewport may emit in total (data + scroll
   * indicators). Zero when there are no annotations (the pane is hidden).
   * Excludes the pane's own top margin + label, which are counted as part of
   * the annotation section's reservation, not its emit budget.
   */
  annotationViewportRows: number;
}

/** Top margin + label rows that wrap the annotation viewport when shown. */
const ANNOTATION_SECTION_CHROME = 2;

/**
 * Natural row demand of the annotation SECTION -- margin + label + data rows
 * + scroll indicators -- before any clamping for terminal height.
 */
function annotationSectionDemand(annotationCount: number): number {
  if (annotationCount <= 0) return 0;
  const dataRows = Math.min(annotationCount, ANNOTATION_VIEWPORT_CAP);
  const indicators = annotationCount > ANNOTATION_VIEWPORT_CAP ? 2 : 0;
  return ANNOTATION_SECTION_CHROME + dataRows + indicators;
}

/**
 * Divide the available height between the body and annotation viewports such
 * that their combined demand can never exceed `totalRows`. The annotation
 * pane (the hand-back gate) is protected up to its natural demand; the
 * body takes the remainder, never dropping below `MIN_BODY_VIEWPORT_ROWS`
 * unless the terminal is genuinely too short to honour even that.
 */
export function computeDrillInLayout(args: {
  totalRows: number;
  reservedFooterRows: number;
  annotationCount: number;
}): DrillInLayout {
  const { totalRows, reservedFooterRows, annotationCount } = args;

  // Rows left for the body section + annotation section combined.
  const contentRows = Math.max(
    0,
    totalRows -
      HEADER_ROWS -
      BOARD_PERIPHERAL_ROWS -
      reservedFooterRows -
      DRILLIN_CHROME_ROWS
  );

  // Annotation section takes its demand, but never so much that the body
  // drops below its floor. Both always sum to <= contentRows.
  const demand = annotationSectionDemand(annotationCount);
  const annotationSectionRows = Math.max(
    0,
    Math.min(demand, contentRows - MIN_BODY_VIEWPORT_ROWS)
  );
  const bodyViewportRows = Math.min(
    contentRows,
    Math.max(MIN_BODY_VIEWPORT_ROWS, contentRows - annotationSectionRows)
  );

  const annotationViewportRows =
    annotationSectionRows <= ANNOTATION_SECTION_CHROME
      ? 0
      : annotationSectionRows - ANNOTATION_SECTION_CHROME;

  return { bodyViewportRows, annotationViewportRows };
}

export interface ViewportWindow {
  /** First visible index (inclusive). */
  start: number;
  /** Last visible index (exclusive). */
  end: number;
  /** Count of items hidden above the window (0 = none, drives the ↑ indicator). */
  aboveHidden: number;
  /** Count of items hidden below the window (0 = none, drives the ↓ indicator). */
  belowHidden: number;
}

/**
 * Fit a scrolling window of items into a fixed emit budget, centred on
 * `anchor`. The returned window guarantees that
 *
 *   (end - start) + (aboveHidden > 0 ? 1 : 0) + (belowHidden > 0 ? 1 : 0)
 *
 * -- data rows plus the scroll indicators that will actually render -- never
 * exceeds `budget`. Indicator rows are reserved only when they will appear,
 * so a window pinned to the top or bottom reclaims the row a fixed two-row
 * reservation would have wasted.
 *
 * `maxData` optionally caps the visible data rows independently of `budget`.
 * The body viewport leaves it unbounded (it shows as many lines as the budget
 * allows); the annotation pane sets it to ANNOTATION_VIEWPORT_CAP so the pane
 * never shows more than its fixed number of annotation rows even when the
 * budget would permit more. Both panes otherwise scroll by identical rules.
 */
export function fitWindow(
  length: number,
  anchor: number,
  budget: number,
  maxData: number = Infinity
): ViewportWindow {
  const cap = Math.min(Math.max(1, budget), Math.max(1, maxData));
  if (length <= cap) {
    // Everything fits within both budget and the data cap; no indicators.
    return { start: 0, end: length, aboveHidden: 0, belowHidden: 0 };
  }
  // Scrolling. Indicator presence depends on the window, which depends on how
  // many data rows we reserve for indicators -- circular, so iterate to a
  // fixpoint (converges in <= 3 passes).
  let dataRows = cap;
  let start = 0;
  let end = length;
  for (let pass = 0; pass < 3; pass++) {
    const half = Math.floor(dataRows / 2);
    start = Math.max(0, anchor - half);
    end = Math.min(length, start + dataRows);
    if (end - start < dataRows) {
      start = Math.max(0, end - dataRows);
    }
    const indicators = (start > 0 ? 1 : 0) + (end < length ? 1 : 0);
    const allowedData = Math.min(maxData, Math.max(1, budget - indicators));
    if (dataRows <= allowedData) break;
    dataRows = allowedData;
  }
  return { start, end, aboveHidden: start, belowHidden: length - end };
}
