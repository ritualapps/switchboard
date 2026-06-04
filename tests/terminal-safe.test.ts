/**
 * Sanitisation contract tests. The security property: no string that passes
 * through stripTerminalControls can carry an escape sequence or control byte
 * into the operator's terminal, while ordinary text (including newlines and
 * tabs used for layout) survives unchanged.
 *
 * The title-shape contract: sanitiseTitle always returns either a single-line,
 * control-clean string ≤80 chars (with width-safe truncation marker), or null.
 * Downstream code can treat Line.title as a one-line displayable label.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitiseTitle,
  singleLine,
  stripTerminalControls,
} from '../src/terminal-safe.ts';

describe('stripTerminalControls', () => {
  it('removes the ESC byte entirely', () => {
    expect(stripTerminalControls('a\x1bb')).not.toContain('\x1b');
  });

  it('strips an OSC 52 clipboard-write sequence', () => {
    const payload = 'before\x1b]52;c;ZXZpbA==\x07after';
    const out = stripTerminalControls(payload);
    expect(out).toBe('beforeafter');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
  });

  it('strips a CSI colour/cursor sequence', () => {
    expect(stripTerminalControls('x\x1b[31mred\x1b[0m')).toBe('xred');
  });

  it('strips an OSC title-set sequence (ST-terminated)', () => {
    expect(stripTerminalControls('t\x1b]0;pwned\x1b\\u')).toBe('tu');
  });

  it('strips BEL and other C0 controls but keeps tab and newline', () => {
    const out = stripTerminalControls('a\x07b\tc\nd\x00e');
    expect(out).toBe('ab\tc\nde');
  });

  it('strips C1 controls', () => {
    expect(stripTerminalControls('a\x9bb')).toBe('ab');
  });

  it('leaves ordinary multi-line text untouched', () => {
    const text = 'line one\nline two\twith tab\nunicode: 🤖 café';
    expect(stripTerminalControls(text)).toBe(text);
  });

  it('is a no-op on empty input', () => {
    expect(stripTerminalControls('')).toBe('');
  });

  it('leaves no orphaned escape parameters as visible junk', () => {
    // A naive lone-ESC strip would leave "[31m" behind; the sequence matcher
    // removes the whole CSI.
    expect(stripTerminalControls('\x1b[1;33mhi')).toBe('hi');
  });
});

describe('singleLine', () => {
  it('collapses \\n to space', () => {
    expect(singleLine('a\nb')).toBe('a b');
  });

  it('collapses \\r\\n to space', () => {
    expect(singleLine('a\r\nb')).toBe('a b');
  });

  it('collapses \\r alone to space', () => {
    expect(singleLine('a\rb')).toBe('a b');
  });

  it('collapses runs of mixed whitespace to single space', () => {
    expect(singleLine('a   b\t\tc\n\nd')).toBe('a b c d');
  });

  it('trims leading and trailing whitespace', () => {
    expect(singleLine('  hello  ')).toBe('hello');
  });

  it('returns empty for empty input', () => {
    expect(singleLine('')).toBe('');
  });

  it('returns single-line single-space input unchanged', () => {
    expect(singleLine('plain text here')).toBe('plain text here');
  });
});

describe('sanitiseTitle', () => {
  it('returns null for null input', () => {
    expect(sanitiseTitle(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(sanitiseTitle(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(sanitiseTitle('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(sanitiseTitle('   \n\t  ')).toBeNull();
  });

  it('collapses multi-line input to single line', () => {
    const out = sanitiseTitle('line one\nline two\nline three');
    expect(out).toBe('line one line two line three');
    expect(out).not.toContain('\n');
  });

  it('removes terminal escape sequences (H1 protection generalised)', () => {
    expect(sanitiseTitle('hi\x1b[31mred\x1b[0m there')).toBe('hired there');
  });

  it('truncates input >80 chars with width-safe marker', () => {
    const longInput = 'a'.repeat(100);
    const out = sanitiseTitle(longInput)!;
    expect(out.length).toBe(80);
    expect(out.endsWith('›')).toBe(true);
    expect(out.startsWith('a')).toBe(true);
  });

  it('leaves ≤80 char input unchanged in length', () => {
    const input = 'short title';
    expect(sanitiseTitle(input)).toBe(input);
  });

  it('handles combined hostile input (controls + newlines + length)', () => {
    const hostile =
      '\x1b[1mevil\x07' + 'x'.repeat(100) + '\nmore content here';
    const out = sanitiseTitle(hostile)!;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
    expect(out).not.toContain('\n');
  });

  it('returns null when input collapses to empty after sanitisation', () => {
    // Pure terminal escapes with no visible content.
    expect(sanitiseTitle('\x1b[31m\x1b[0m')).toBeNull();
  });
});
