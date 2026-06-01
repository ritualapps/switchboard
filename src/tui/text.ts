/**
 * Shared text helpers for the TUI.
 */

// Width-safe truncation marker. Not `…` (U+2026): that glyph is
// East-Asian-Ambiguous and paints 2 cells in many terminal fonts while
// string-width reports 1, desyncing layout from paint. `›` (U+203A) is an
// unambiguous 1-cell glyph across the EAW table.
export const TRUNCATE_MARKER = '›';

/**
 * Truncate `s` to at most `n` characters, appending the width-safe marker
 * when content is dropped. Empty input returns empty.
 */
export function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + TRUNCATE_MARKER : s;
}
