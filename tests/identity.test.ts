import { describe, it, expect } from 'vitest';
import { identityForSession, ROBOT_FAMILY } from '../src/tui/identity.ts';

describe('line visual identity', () => {
  it('returns one of the 9 robot family members', () => {
    for (let i = 0; i < 50; i++) {
      const id = identityForSession(`session-${i}`);
      expect(ROBOT_FAMILY).toContain(id);
    }
  });

  it('is deterministic per session id', () => {
    const a = identityForSession('test-session-abc');
    const b = identityForSession('test-session-abc');
    expect(a).toEqual(b);
  });

  it('distributes across slots over many ids (no single slot dominates)', () => {
    const counts = new Map<number, number>();
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const id = identityForSession(`session-${i}-${Math.random()}`);
      counts.set(id.slot, (counts.get(id.slot) ?? 0) + 1);
    }
    // Every slot should appear at least once over 1000 random ids.
    expect(counts.size).toBe(ROBOT_FAMILY.length);
    // No single slot should take more than ~30% (uniform would be ~11%).
    for (const count of counts.values()) {
      expect(count).toBeLessThan(N * 0.3);
    }
  });

  it('family is exactly 9 robots with unique pictographs + colours', () => {
    expect(ROBOT_FAMILY.length).toBe(9);
    const pictographs = new Set(ROBOT_FAMILY.map((r) => r.pictograph));
    const colours = new Set(ROBOT_FAMILY.map((r) => r.colour));
    const names = new Set(ROBOT_FAMILY.map((r) => r.name));
    expect(pictographs.size).toBe(9);
    expect(colours.size).toBe(9);
    expect(names.size).toBe(9);
  });

  it('includes BUNEEBOT and RAINBOWBOT at slots 6 and 7', () => {
    const diagonalCentre = ROBOT_FAMILY.filter((r) => r.slot === 6 || r.slot === 7);
    expect(diagonalCentre.map((r) => r.name).sort()).toEqual(['BUNEEBOT', 'RAINBOWBOT']);
  });
});
