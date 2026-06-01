/**
 * Tab-title `NEEDS YOU` count.
 *
 * Pure-function tests for `deriveTabTitle` + `formatTabTitleEscape`. The
 * integration (App's useEffect writing to stdout) is exercised implicitly
 * via the existing render tests; this file covers the deterministic title
 * derivation and OSC escape formatting.
 */

import { describe, it, expect } from 'vitest';
import { deriveTabTitle, formatTabTitleEscape } from '../src/tui/App.tsx';

describe('deriveTabTitle', () => {
  it('returns "Switchboard" when no NEEDS YOU lines', () => {
    expect(deriveTabTitle([])).toBe('Switchboard');
    expect(deriveTabTitle([{ state: 'ringing' }])).toBe('Switchboard');
    expect(deriveTabTitle([{ state: 'in_progress' }, { state: 'idle' }])).toBe('Switchboard');
  });

  it('returns "Switchboard (N)" when N >= 1 blocked lines', () => {
    expect(deriveTabTitle([{ state: 'blocked' }])).toBe('Switchboard (1)');
    expect(
      deriveTabTitle([
        { state: 'blocked' },
        { state: 'blocked' },
        { state: 'ringing' },
      ])
    ).toBe('Switchboard (2)');
    expect(
      deriveTabTitle(Array.from({ length: 9 }, () => ({ state: 'blocked' as const })))
    ).toBe('Switchboard (9)');
  });

  it('only counts blocked (NEEDS YOU zone) -- ringing/drafted live in READY FOR REVIEW', () => {
    const lines = [
      { state: 'blocked' as const },
      { state: 'ringing' as const },
      { state: 'drafted' as const },
      { state: 'in_progress' as const },
      { state: 'idle' as const },
    ];
    expect(deriveTabTitle(lines)).toBe('Switchboard (1)');
  });
});

describe('formatTabTitleEscape', () => {
  it('wraps title in OSC 0 escape (\\x1b]0;TITLE\\x07)', () => {
    expect(formatTabTitleEscape('Switchboard')).toBe('\x1b]0;Switchboard\x07');
    expect(formatTabTitleEscape('Switchboard (3)')).toBe('\x1b]0;Switchboard (3)\x07');
  });

  it('passes title through unchanged (no encoding -- terminals handle the title bytes)', () => {
    expect(formatTabTitleEscape('any text')).toBe('\x1b]0;any text\x07');
  });
});
