import { describe, it, expect } from 'vitest';
import { copyToClipboard } from '../src/dispatch/clipboard.ts';

describe('clipboard fallback', () => {
  it('returns a result object with ok + detail (best-effort, never throws)', async () => {
    const result = await copyToClipboard('test payload');
    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.detail).toBe('string');
    // Pass on either outcome:
    //   ok=true: a clipboard tool was available + accepted the input
    //   ok=false: tool absent/refused; detail explains
    // The dispatcher must NOT fail when clipboard fails -- the test here
    // just verifies the contract shape.
  });

  it('does not throw on empty string', async () => {
    await expect(copyToClipboard('')).resolves.toBeDefined();
  });

  it('does not throw on multi-line payload', async () => {
    const block = 'line one\nline two\nline three';
    const result = await copyToClipboard(block);
    expect(result).toBeDefined();
  });
});
