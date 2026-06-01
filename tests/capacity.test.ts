import { describe, it, expect } from 'vitest';
import { deriveCapacityBand, formatCellFooter } from '../src/capacity/indicator.ts';
import type { CapacitySignals } from '../src/types.ts';

function sig(partial: Partial<CapacitySignals>): CapacitySignals {
  return {
    queueDepth: 0,
    recentEventRate: 0,
    msSinceLastEvent: 60_000,
    ...partial,
  };
}

describe('deriveCapacityBand', () => {
  it('returns blocked when state is blocked', () => {
    expect(deriveCapacityBand({ signals: sig({}), state: 'blocked' })).toBe('blocked');
  });

  it('returns heavy when queue depth >= 3', () => {
    expect(
      deriveCapacityBand({ signals: sig({ queueDepth: 3 }), state: 'in_progress' })
    ).toBe('heavy');
  });

  it('returns heavy when recent rate >= 5/min', () => {
    expect(
      deriveCapacityBand({ signals: sig({ recentEventRate: 5 }), state: 'in_progress' })
    ).toBe('heavy');
  });

  it('returns steady when recent rate >= 1/min', () => {
    expect(
      deriveCapacityBand({ signals: sig({ recentEventRate: 1.5 }), state: 'in_progress' })
    ).toBe('steady');
  });

  it('returns steady when recent event was within 60s', () => {
    expect(
      deriveCapacityBand({ signals: sig({ msSinceLastEvent: 30_000 }), state: 'idle' })
    ).toBe('steady');
  });

  it('returns quiet when nothing recent', () => {
    expect(
      deriveCapacityBand({
        signals: sig({ recentEventRate: 0, msSinceLastEvent: 300_000 }),
        state: 'idle',
      })
    ).toBe('quiet');
  });
});

describe('formatCellFooter (entry 2 ruling -- capacity-coupled prefix suppressed)', () => {
  it('omits queue depth even when nonzero (capacity deferred to Shipping V2)', () => {
    const s = formatCellFooter(sig({ queueDepth: 2, msSinceLastEvent: 5000 }));
    expect(s).not.toContain('queued');
    expect(s).toContain('5s ago');
  });

  it('renders "last event Xs ago" only', () => {
    const s = formatCellFooter(sig({ queueDepth: 0, msSinceLastEvent: 5000 }));
    expect(s).toBe('last event 5s ago');
  });
});
