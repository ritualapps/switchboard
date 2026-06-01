/**
 * Board -- the persistent peripheral surface.
 *
 * One row per line. Each row shows: state glyph, project name, capacity band,
 * last-event summary, cell footer (raw signals -- queue depth + last event age).
 *
 * Ordering: blocked first (auto-promoted to the top), then ringing, then
 * drafted, then in_progress, then deferred, then completed, then idle.
 * Within each state, most-recent first.
 *
 * The board is always visible -- drill-in does not displace it; App.tsx
 * renders Board above DrillIn so peripheral awareness survives plug-in.
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Line, LineState } from '../types.js';
import { formatCellFooter } from '../capacity/indicator.js';
import {
  sectionLines,
  SECTION_LABEL,
  SECTION_COLOR,
  type SectionKey,
} from './ordering.js';
import { identityForSession } from './identity.js';
import { truncate } from './text.js';

// State prefix glyphs -- shown BEFORE the identity pictograph to flag
// attention. The prefix column is ALWAYS reserved (blank space when no
// glyph applies) so the identity pictograph stays at a fixed horizontal
// position across all rows. `!` is reserved for `blocked` -- ringing is
// normal flow ("ready for review") and gets no glyph; the zone label
// carries the meaning.
const STATE_PREFIX: Partial<Record<LineState, { glyph: string; colour: string }>> = {
  blocked: { glyph: '!', colour: '#ff5566' },
};

// State suffix glyphs -- shown AFTER the identity pictograph for non-
// attention states that still convey context.
const STATE_SUFFIX: Partial<Record<LineState, { glyph: string; colour: string }>> = {
  drafted: { glyph: '✎', colour: '#6BC1FF' },
  deferred: { glyph: '⌛', colour: '#777777' },
};

// Faded states render the identity pictograph dimmed.
const FADED_STATES = new Set<LineState>(['idle', 'dismissed', 'closed', 'completed']);

// Capacity band -> colour mapping is not shown yet. The underlying
// computation (deriveCapacityBand) still ships and is tested in
// capacity.test.ts so the primitive is ready when the surface wants it.
// The visual element stays off for now to keep the cell's colour grammar
// limited to identity + state.

interface Props {
  lines: Line[];
  focusedId: string | null;
  draftLineIds: Set<string>;
  /** Rows the App reserves for the wrapping Footer at the bottom of the
   *  alt-screen. Used only when `availableRows` is not provided. */
  reservedFooterRows?: number;
  /** Hard cap on rows Board may emit. When provided, Board uses this
   *  directly instead of computing from stdout - reserves. App passes a
   *  small value when drill-in is mounted so Board collapses to a
   *  peripheral strip and DrillIn gets the rest of the terminal height. */
  availableRows?: number;
  /** Allocator-assigned slot per session. Sessions absent or with `null`
   *  in this map are unslotted (9-slot cap enforced; or session is
   *  INACTIVE). When absent, Board falls back to the hash-derived slot for
   *  backwards compatibility with existing tests; App always provides this
   *  in production. */
  slotMap?: Map<string, number | null>;
}

export function Board({
  lines,
  focusedId,
  draftLineIds,
  reservedFooterRows = 3,
  availableRows: availableRowsProp,
  slotMap,
}: Props) {
  const { sections } = sectionLines(lines, draftLineIds);
  const { stdout } = useStdout();
  // Available rows for the board: App-provided when known, else computed
  // from stdout - header - footer reserve. Defaults to 24 rows when
  // stdout doesn't expose rows (test-harness, piped output).
  const totalRows = stdout?.rows ?? 24;
  // Terminal width, used by each cell to truncate its title BEFORE Ink's
  // own `truncate-end` would -- Ink hardcodes an `…` truncation marker
  // (U+2026, East-Asian-Ambiguous: 1 cell to string-width, 2 in many
  // fonts), so letting it truncate reintroduces width drift. We pre-fit
  // the title to a safe marker instead. Defaults to 80 when stdout has no
  // columns (piped output / test harness without a width).
  const columns = stdout?.columns ?? 80;
  const HEADER_ROWS = 1;
  const availableRows =
    availableRowsProp ?? Math.max(10, totalRows - HEADER_ROWS - reservedFooterRows);
  const windowed = windowSections(sections, focusedId, availableRows);

  return (
    <Box flexDirection="column" paddingX={1}>
      {sections.length === 0 && (
        <Text dimColor>
          (no recent Claude Code sessions in ~/.claude/projects/ -- start one and it appears here)
        </Text>
      )}
      {/* Pinned section headers ABOVE the window. Each fully-above zone
          renders as `<ZONE LABEL>  ↑ N more` so the operator always sees
          what's collapsed above the cursor. */}
      {windowed.collapsedAbove.map(({ key, totalCount }) => (
        <Box key={`above-${key}`}>
          <Text bold color={SECTION_COLOR[key]}>
            {SECTION_LABEL[key]}
          </Text>
          <Text dimColor>{`  ↑ ${totalCount} more`}</Text>
        </Box>
      ))}
      {windowed.sections.map(({ key, lines: group, hiddenAbove, hiddenBelow }) => (
        <Box key={key} flexDirection="column" marginBottom={1}>
          <Text bold color={SECTION_COLOR[key]}>
            {SECTION_LABEL[key]} <Text dimColor>({group.length}{hiddenAbove + hiddenBelow > 0 ? ` of ${group.length + hiddenAbove + hiddenBelow}` : ''})</Text>
          </Text>
          {hiddenAbove > 0 && (
            <Text dimColor>{`  ↑ ${hiddenAbove} more in zone`}</Text>
          )}
          {group.map((line) => (
            <LineCell
              key={line.id}
              line={line}
              focused={line.id === focusedId}
              slot={slotMap ? slotMap.get(line.id) ?? null : undefined}
              columns={columns}
            />
          ))}
          {hiddenBelow > 0 && (
            <Text dimColor>{`  ↓ ${hiddenBelow} more in zone`}</Text>
          )}
        </Box>
      ))}
      {/* Pinned section headers BELOW the window. Same shape as above. */}
      {windowed.collapsedBelow.map(({ key, totalCount }) => (
        <Box key={`below-${key}`}>
          <Text bold color={SECTION_COLOR[key]}>
            {SECTION_LABEL[key]}
          </Text>
          <Text dimColor>{`  ↓ ${totalCount} more`}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Rough row cost per visible cell (line row + footer row + margin). */
const ROWS_PER_CELL = 3;
/** Rough row cost per section header (label + bottom margin on section box). */
const ROWS_PER_SECTION = 2;
/** Row cost per collapsed (pinned) section header above or below the window. */
const ROWS_PER_PINNED_SECTION = 1;

export interface WindowedSection {
  key: SectionKey;
  /** Cells visible in the window from this section. */
  lines: Line[];
  /** Count of additional cells in this same zone above the visible slice
   *  (only nonzero when the window cut falls mid-zone). */
  hiddenAbove: number;
  /** Same for below. */
  hiddenBelow: number;
}

export interface CollapsedSection {
  key: SectionKey;
  /** Total line count in this zone. The whole zone is collapsed because
   *  none of its lines fit in the window. */
  totalCount: number;
}

export interface WindowedSections {
  /** Sections with at least one cell visible. */
  sections: WindowedSection[];
  /** Zones fully above the window -- rendered as pinned header + count. */
  collapsedAbove: CollapsedSection[];
  /** Zones fully below the window. */
  collapsedBelow: CollapsedSection[];
}

/**
 * Slide a viewport over the focused line so the operator's cursor stays
 * visible when the full board would overflow the terminal. Zones fully
 * outside the window collapse to a one-line pinned header so the
 * operator always sees which zones exist + how much is collapsed.
 *
 *   - If the full board fits in `availableRows`, no windowing is applied
 *     (every section returned with empty hiddenAbove/hiddenBelow).
 *   - Otherwise a slice is taken around the focused cell, with the cursor
 *     anchored ~30% from the top of the window so the operator has room
 *     to look ahead.
 *   - Zones fully above the window are returned in `collapsedAbove` with
 *     their total line counts. Same for below.
 *   - Zones partially in the window expose `hiddenAbove` / `hiddenBelow`
 *     so the Board can render an in-zone indicator.
 *
 * An earlier implementation collapsed the above/below counts into a single
 * number that hid which zones the operator was scrolling past. The intended
 * behaviour: as the operator scrolls down through the inactive items, the
 * zones above (such as READY FOR REVIEW and RUNNING) collapse to their
 * headings pinned at the top of the screen, each with an "N more" indicator.
 * This shape delivers that.
 */
export function windowSections(
  sections: ReadonlyArray<{ key: SectionKey; lines: Line[] }>,
  focusedId: string | null,
  availableRows: number
): WindowedSections {
  // Flat list of every renderable cell along with its section key.
  const flat: Array<{ sectionKey: SectionKey; line: Line }> = [];
  for (const sec of sections) {
    for (const ln of sec.lines) flat.push({ sectionKey: sec.key, line: ln });
  }
  if (flat.length === 0) {
    return { sections: [], collapsedAbove: [], collapsedBelow: [] };
  }

  const fullCost = emitRowsForFullBoard(sections);
  if (fullCost <= availableRows) {
    return {
      sections: sections.map((s) => ({
        key: s.key,
        lines: s.lines.slice(),
        hiddenAbove: 0,
        hiddenBelow: 0,
      })),
      collapsedAbove: [],
      collapsedBelow: [],
    };
  }

  let focusedIdx = focusedId ? flat.findIndex((e) => e.line.id === focusedId) : -1;
  if (focusedIdx < 0) focusedIdx = 0;

  // Start with a generous cellBudget, then SHRINK until the actual emit
  // count fits in availableRows. This guarantees the rendered Board
  // never exceeds the terminal height, which would otherwise scroll the
  // App's Header off the top of the alt-screen buffer.
  //
  // An earlier version used a single closed-form budget estimate that left
  // a 1-2 row gap between the calculated and actual emit count. That gap
  // was enough to push the SWITCHBOARD header out of view on real
  // terminals.
  const upperBound = Math.max(
    1,
    Math.floor(availableRows / ROWS_PER_CELL)
  );
  for (let budget = upperBound; budget >= 1; budget--) {
    const candidate = buildWindow(sections, flat, focusedIdx, budget);
    if (emitRowsForWindow(candidate) <= availableRows) return candidate;
  }
  // Fallback: 1-cell window. Floor of 1 guarantees the focused line is
  // always visible even on terminals so small that overflow is
  // unavoidable.
  return buildWindow(sections, flat, focusedIdx, 1);
}

function buildWindow(
  sections: ReadonlyArray<{ key: SectionKey; lines: Line[] }>,
  flat: ReadonlyArray<{ sectionKey: SectionKey; line: Line }>,
  focusedIdx: number,
  cellBudget: number
): WindowedSections {
  // Anchor focused at 30% from top of the window so the operator has
  // lookahead. Vim-style scrolloff.
  const leadIn = Math.floor(cellBudget * 0.3);
  let start = Math.max(0, focusedIdx - leadIn);
  let end = Math.min(flat.length, start + cellBudget);
  if (end - start < cellBudget) {
    start = Math.max(0, end - cellBudget);
  }

  const visibleSections: WindowedSection[] = [];
  const collapsedAbove: CollapsedSection[] = [];
  const collapsedBelow: CollapsedSection[] = [];

  let cellIdx = 0;
  for (const sec of sections) {
    const sectionStart = cellIdx;
    const sectionEnd = cellIdx + sec.lines.length;
    cellIdx = sectionEnd;

    if (sectionEnd <= start) {
      collapsedAbove.push({ key: sec.key, totalCount: sec.lines.length });
      continue;
    }
    if (sectionStart >= end) {
      collapsedBelow.push({ key: sec.key, totalCount: sec.lines.length });
      continue;
    }
    const visibleStart = Math.max(start, sectionStart);
    const visibleEnd = Math.min(end, sectionEnd);
    const hiddenAbove = visibleStart - sectionStart;
    const hiddenBelow = sectionEnd - visibleEnd;
    visibleSections.push({
      key: sec.key,
      lines: sec.lines.slice(visibleStart - sectionStart, visibleEnd - sectionStart),
      hiddenAbove,
      hiddenBelow,
    });
  }

  return {
    sections: visibleSections,
    collapsedAbove,
    collapsedBelow,
  };
}

/**
 * Count the rows the Board component would actually emit for a given
 * windowed result. Tracks every visual element the Board renders:
 *   - Each collapsed-above section header: 1 row.
 *   - Each visible section: section header (1) + optional hiddenAbove
 *     indicator (1) + per-cell rows (line + footer + marginBottom = 3
 *     rows) + optional hiddenBelow indicator (1) + section's
 *     marginBottom (1).
 *   - Each collapsed-below section header: 1 row.
 *
 * Used by `windowSections` to iteratively shrink the cellBudget until
 * the total fits in the terminal's row budget. Exported so the test
 * suite can lock the invariant programmatically.
 */
export function emitRowsForWindow(w: WindowedSections): number {
  let rows = 0;
  rows += w.collapsedAbove.length * ROWS_PER_PINNED_SECTION;
  for (const sec of w.sections) {
    rows += 1; // section header
    if (sec.hiddenAbove > 0) rows += 1; // in-zone above indicator
    rows += sec.lines.length * ROWS_PER_CELL;
    if (sec.hiddenBelow > 0) rows += 1; // in-zone below indicator
    rows += 1; // section marginBottom
  }
  rows += w.collapsedBelow.length * ROWS_PER_PINNED_SECTION;
  return rows;
}

function emitRowsForFullBoard(
  sections: ReadonlyArray<{ key: SectionKey; lines: Line[] }>
): number {
  let rows = 0;
  for (const sec of sections) {
    rows += 1; // header
    rows += sec.lines.length * ROWS_PER_CELL;
    rows += 1; // marginBottom
  }
  return rows;
}

/** Fixed (non-flex) horizontal cells consumed by a row, left to right:
 *  Board paddingX (1+1) + cursor (2) + prefix (2) + slot (3) + pictograph
 *  (3) + suffix (2) + age (8) = 22. The title box gets whatever remains.
 *  Used to pre-fit the title so Ink's `…` truncation never fires. */
const FIXED_ROW_CELLS = 22;

function LineCell({
  line,
  focused,
  slot,
  columns,
}: {
  line: Line;
  focused: boolean;
  /** Slot from App's allocator. `null` means unslotted (no 1-9 address);
   *  `undefined` falls back to the hash slot for backwards compatibility
   *  with tests that don't pass slotMap. */
  slot?: number | null;
  /** Terminal width in columns, threaded from Board so the title can be
   *  pre-truncated to the flex width with a width-safe marker. */
  columns: number;
}) {
  const state = line.stateManual ?? line.state;
  const cursor = focused ? '▸' : ' ';
  const footer = formatCellFooter(line.capacitySignals);
  const age = formatAge(line.capacitySignals.msSinceLastEvent);
  const label = (line.title && line.title.trim()) || line.projectName;

  // Stable per-session visual identity (pictograph + colour).
  const identity = identityForSession(line.id);
  // Slot column always emits a fixed 3-char string: `<digit><space><space>`
  // when slotted, `<space><space><space>` when unslotted (INACTIVE rows).
  // Rendering as a single explicit Text bypasses two Ink behaviours that
  // collapse the column:
  //   1. Box width=N with whitespace-only Text content collapses to 1
  //      visual cell, so INACTIVE rows' pictographs drift one column left
  //      of READY rows'.
  //   2. With slot Box width=2 (digit + 1 padding space), pictographs whose
  //      font glyph has high left bearing merge visually into the
  //      single-cell padding, reading as `7∩` not `7 ∩`. Two padding cells
  //      survive even hostile bearing.
  const renderedSlot =
    slot === undefined
      ? `${identity.slot}  `
      : slot === null
        ? '   '
        : `${slot}  `;
  const prefix = STATE_PREFIX[state];
  const suffix = STATE_SUFFIX[state];
  // Focus brightens faded states -- a faded line under the cursor renders
  // at full colour like an active line does. Without this, the cursor on
  // INACTIVE-zone lines stays dim and the operator loses the "where am I"
  // feedback. `dimColor` only applies when the line is BOTH faded AND not
  // focused.
  const dim = FADED_STATES.has(state) && !focused;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box width={2} flexShrink={0}>
          <Text color="yellow">{cursor}</Text>
        </Box>
        <Box width={2} flexShrink={0}>
          {prefix ? (
            <Text color={prefix.colour} bold>{prefix.glyph}</Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
        {/* Slot digit -- the address used by direct plug-in (`1`-`9`
            keystroke) and the shell jump (`switchboard cmd <N>`). The slot
            renders BEFORE the pictograph: the address is the load-bearing
            identity component for the operator, and placing it leftmost
            keeps its column stable regardless of how wide the terminal
            renders the pictograph that follows. Some family glyphs render 2
            visual cells in certain fonts while ink string-width sees 1,
            cascading drift through every column to their right. Anchoring
            the slot at the leftmost stable column keeps that drift away
            from the operator's "where am I" feedback.
            Rendered as a single 3-char Text (digit + 2 spaces) inside a
            width-LESS Box so Ink sizes it to content (no collapse) -- the
            wrapping Box carries flexShrink={0} so a narrow terminal can't
            steal a cell from this column and jitter the pictograph that
            follows. */}
        <Box flexShrink={0}>
          <Text color={identity.colour} bold dimColor={dim}>
            {renderedSlot}
          </Text>
        </Box>
        {/* PICTOGRAPH_BOX_WIDTH=3 reserves enough cells for any of the 9
            family members; the suffix box that follows accepts whatever
            visual drift the terminal introduces. */}
        <Box width={3} flexShrink={0}>
          <Text color={identity.colour} bold dimColor={dim}>
            {identity.pictograph}
          </Text>
        </Box>
        <Box width={2} flexShrink={0}>
          {suffix ? (
            <Text color={suffix.colour}>{suffix.glyph}</Text>
          ) : (
            // The capacity-band block (`█` coloured per band) is
            // deliberately suppressed for now. Rendering the coloured block
            // collides with the robot identity + state colour legends and
            // needs careful design before it ships. The capacity band is
            // still computed (deriveCapacityBand) and tested; only the
            // visual element is held back.
            <Text> </Text>
          )}
        </Box>
        <Box flexGrow={1}>
          {/* wrap="truncate-end" is load-bearing: without it, long titles
              wrap to a second visual row, breaking the row-count math
              `windowSections` uses to keep the Board within
              `availableRows`. The Board would then emit more rows than the
              windowing budgeted and scroll the App's Header off the
              alt-screen. We pre-truncate to the flex width with a width-safe
              marker so this `truncate-end` stays a no-op backstop and never
              paints Ink's ambiguous-width `…`. */}
          <Text
            color={focused ? 'green' : undefined}
            bold={focused}
            dimColor={dim}
            wrap="truncate-end"
          >
            {truncate(label, Math.max(8, columns - FIXED_ROW_CELLS))}
          </Text>
        </Box>
        <Box width={8} justifyContent="flex-end" flexShrink={0}>
          <Text dimColor={!focused}>{age}</Text>
        </Box>
      </Box>
      <Box marginLeft={6}>
        <Text dimColor={!focused} wrap="truncate-end">{footer}</Text>
        {line.deferral && (
          <Text dimColor={!focused} wrap="truncate-end">
            {line.deferral.reason
              ? `  ·  deferred: ${line.deferral.reason}`
              : '  ·  deferred'}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function formatAge(ms: number): string {
  if (Number.isNaN(ms) || ms < 0) return '-';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
