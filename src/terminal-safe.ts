/**
 * Sanitisation contracts for transcript-derived display strings.
 *
 * Switchboard renders strings that originate in Claude Code transcripts and in
 * agent-written emission files -- titles, body text, summaries, checkpoint
 * messages. That content is not trusted: anything an agent, a tool result, a
 * fetched page, or another local process can write into a transcript becomes
 * input here. Ink's <Text> passes raw bytes through to stdout, so an embedded
 * escape sequence (OSC clipboard write, title-setting, cursor/screen control,
 * hyperlinks) would be interpreted by the operator's terminal.
 *
 * This file holds two complementary contracts:
 *
 * `stripTerminalControls` removes escape sequences and control bytes before
 * such strings reach the render tree. Newlines and tabs are preserved -- the
 * body viewport splits on "\n" itself, so stripping it would break multi-line
 * rendering -- everything else in the C0/C1 control range, and any ESC-
 * introduced CSI/OSC sequence, is dropped.
 *
 * `sanitiseTitle` is the title-shape contract: every value that becomes
 * Line.title flows through it. Single line, control-clean, ≤80 chars with a
 * width-safe truncation marker, or null. This invariant exists because Ink's
 * row-count math in Board.tsx assumes each row renders on exactly one line --
 * a title with embedded "\n" forces multi-row rendering and breaks the Board's
 * windowing. `stripTerminalControls` alone cannot enforce this (it preserves
 * "\n" for the bundle body), so `singleLine` runs in series for the title
 * path only.
 */

// eslint-disable-next-line no-control-regex
const CSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESC = /\x1b[@-Z\\-_]?/g;
// C0 controls except tab (\x09) and newline (\x0a), plus DEL (\x7f).
// eslint-disable-next-line no-control-regex
const C0_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;
// eslint-disable-next-line no-control-regex
const C1_CONTROLS = /[\x80-\x9f]/g;

export function stripTerminalControls(s: string): string {
  if (!s) return s;
  return s
    .replace(CSI_SEQUENCE, '')
    .replace(OSC_SEQUENCE, '')
    .replace(OTHER_ESC, '')
    .replace(C0_CONTROLS, '')
    .replace(C1_CONTROLS, '');
}

/**
 * Collapse all whitespace runs (including "\n", "\r", "\t", regular spaces,
 * and Unicode whitespace) to a single space, and trim ends.
 *
 * Used by `sanitiseTitle` to enforce the single-line title invariant. Kept
 * separate from `stripTerminalControls` because the bundle body path needs
 * to preserve "\n" for multi-line rendering -- only titles must collapse.
 */
export function singleLine(s: string): string {
  if (!s) return s;
  return s.replace(/\s+/g, ' ').trim();
}

// Width-safe truncation marker for title strings. Duplicated from
// TRUNCATE_MARKER in src/tui/text.ts because tui depends on terminal-safe,
// not the other way -- importing across that boundary would invert the
// dependency direction. Keep these two constants in sync. "›" (U+203A) is an
// unambiguous 1-cell glyph across the East-Asian-Ambiguous table; "…"
// (U+2026) paints 2 cells in many terminal fonts while string-width reports
// 1, desyncing layout from paint.
const TITLE_TRUNCATE_MARKER = '›';

const TITLE_MAX_LENGTH = 80;

/**
 * Title-shape contract. Every value that becomes `Line.title` flows through
 * this helper. The result is either:
 *   - a single-line, control-clean string ≤80 chars (with width-safe marker
 *     if the input exceeded the limit), or
 *   - null when the input was null/undefined/empty/whitespace-only after
 *     sanitisation.
 *
 * Boundary invariant: anything downstream of this function can treat
 * `Line.title` as a one-line displayable label without further checking.
 */
export function sanitiseTitle(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = singleLine(stripTerminalControls(s));
  if (!cleaned) return null;
  if (cleaned.length > TITLE_MAX_LENGTH) {
    return cleaned.slice(0, TITLE_MAX_LENGTH - 1) + TITLE_TRUNCATE_MARKER;
  }
  return cleaned;
}
