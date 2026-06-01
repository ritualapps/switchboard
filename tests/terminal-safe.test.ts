/**
 * Terminal-control sanitisation tests. The security property: no string that
 * passes through stripTerminalControls can carry an escape sequence or control
 * byte into the operator's terminal, while ordinary text (including newlines
 * and tabs used for layout) survives unchanged.
 */

import { describe, it, expect } from 'vitest';
import { stripTerminalControls } from '../src/terminal-safe.ts';

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
