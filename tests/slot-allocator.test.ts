/**
 * Slot allocator -- 9-slot cap, hash + collision walk, INACTIVE = no slot.
 * Slot-collision ruling 2026-06-01 (A4 + B1).
 */

import { describe, it, expect } from 'vitest';
import { allocateSlots, cacheFromAllocation } from '../src/tui/slot-allocator.ts';
import { identityForSession } from '../src/tui/identity.ts';
import type { Line, LineState } from '../src/types.ts';

function makeLine(
  id: string,
  state: LineState = 'ringing',
  startedAt = '2026-06-01T00:00:00Z'
): Line {
  return {
    id,
    title: id,
    projectPath: '/tmp/test',
    projectName: id,
    projectHash: 'h',
    transcriptPath: '/tmp/t.jsonl',
    state,
    startedAt,
    lastEventAt: startedAt,
    lastEventSummary: 'x',
    currentBundle: null,
    deferral: null,
    capacitySignals: { queueDepth: 0, recentEventRate: 0, msSinceLastEvent: 0 },
    eventCount: 1,
  };
}

function findSessionIdForSlot(target: number, taken: Set<string> = new Set()): string {
  let counter = 0;
  while (counter < 200_000) {
    const stem = counter.toString(16).padStart(32, '0');
    const id = `${stem.slice(0, 8)}-${stem.slice(8, 12)}-${stem.slice(12, 16)}-${stem.slice(16, 20)}-${stem.slice(20, 32)}`;
    if (identityForSession(id).slot === target && !taken.has(id)) return id;
    counter++;
  }
  throw new Error(`could not find session id for slot ${target}`);
}

describe('allocateSlots (A4 + B1 ruling)', () => {
  it('returns empty allocation for empty lines', () => {
    const { map } = allocateSlots([], new Set(), new Map());
    expect(map.size).toBe(0);
  });

  it('single line gets its hash slot when uncontested', () => {
    const id = findSessionIdForSlot(5);
    const { map } = allocateSlots([makeLine(id)], new Set(), new Map());
    expect(map.get(id)).toBe(5);
  });

  it('two lines with different hash slots get their respective slots', () => {
    const a = findSessionIdForSlot(2);
    const b = findSessionIdForSlot(7, new Set([a]));
    const { map } = allocateSlots(
      [makeLine(a), makeLine(b)],
      new Set(),
      new Map()
    );
    expect(map.get(a)).toBe(2);
    expect(map.get(b)).toBe(7);
  });

  it('collision: two lines hashing to same slot -- first (older) keeps it, second walks', () => {
    // Find two ids both hashing to slot 3.
    const taken = new Set<string>();
    const a = findSessionIdForSlot(3, taken);
    taken.add(a);
    const b = findSessionIdForSlot(3, taken);
    // `a` is older (startedAt earlier).
    const { map } = allocateSlots(
      [
        makeLine(a, 'ringing', '2026-06-01T00:00:00Z'),
        makeLine(b, 'ringing', '2026-06-01T01:00:00Z'),
      ],
      new Set(),
      new Map()
    );
    expect(map.get(a)).toBe(3);
    expect(map.get(b)).not.toBe(3);
    expect(map.get(b)).toBeGreaterThanOrEqual(1);
    expect(map.get(b)).toBeLessThanOrEqual(9);
  });

  it('every slot allocation is unique across active sessions', () => {
    const lines = Array.from({ length: 9 }, (_, i) =>
      makeLine(`${i.toString().padStart(8, '0')}-1111-2222-3333-444444444444`)
    );
    const { map } = allocateSlots(lines, new Set(), new Map());
    const slots = new Set<number>();
    for (const slot of map.values()) {
      if (slot !== null) {
        expect(slots.has(slot)).toBe(false);
        slots.add(slot);
      }
    }
    expect(slots.size).toBe(Math.min(9, lines.length));
  });

  it('beyond 9 active lines: the 10th gets null (unslotted)', () => {
    const lines = Array.from({ length: 12 }, (_, i) =>
      makeLine(`${i.toString().padStart(8, '0')}-1111-2222-3333-444444444444`)
    );
    const { map } = allocateSlots(lines, new Set(), new Map());
    const slotted = Array.from(map.values()).filter((s) => s !== null);
    const unslotted = Array.from(map.values()).filter((s) => s === null);
    expect(slotted.length).toBe(9);
    expect(unslotted.length).toBe(3);
  });

  it('INACTIVE-zone lines (completed/dismissed/closed/idle) get null', () => {
    const a = findSessionIdForSlot(1);
    const b = findSessionIdForSlot(2, new Set([a]));
    const c = findSessionIdForSlot(3, new Set([a, b]));
    const d = findSessionIdForSlot(4, new Set([a, b, c]));
    const { map } = allocateSlots(
      [
        makeLine(a, 'ringing'),
        makeLine(b, 'completed'),
        makeLine(c, 'dismissed'),
        makeLine(d, 'idle'),
      ],
      new Set(),
      new Map()
    );
    expect(map.get(a)).toBe(1);
    expect(map.get(b)).toBeNull();
    expect(map.get(c)).toBeNull();
    expect(map.get(d)).toBeNull();
  });

  it('cached assignment is honored when slot is still free', () => {
    const id = findSessionIdForSlot(1);
    const cache = new Map([[id, 8]]); // session prefers slot 8 from prior cache
    const { map } = allocateSlots([makeLine(id)], new Set(), cache);
    expect(map.get(id)).toBe(8);
  });

  it('cached assignment is dropped when slot is taken by a longer-lived holder', () => {
    const a = findSessionIdForSlot(5);
    const b = findSessionIdForSlot(7, new Set([a]));
    // `a` is older. Cache says both want slot 7.
    const cache = new Map([[a, 7], [b, 7]]);
    const { map } = allocateSlots(
      [
        makeLine(a, 'ringing', '2026-06-01T00:00:00Z'),
        makeLine(b, 'ringing', '2026-06-01T01:00:00Z'),
      ],
      new Set(),
      cache
    );
    // `a` (older) wins the cached slot 7. `b` walks.
    expect(map.get(a)).toBe(7);
    expect(map.get(b)).not.toBe(7);
    expect(map.get(b)).not.toBeNull();
  });

  it('determinism: same inputs produce same allocations across calls', () => {
    const ids = Array.from({ length: 6 }, (_, i) =>
      findSessionIdForSlot(((i * 3) % 9) + 1, new Set())
    );
    const lines = ids.map((id) => makeLine(id));
    const r1 = allocateSlots(lines, new Set(), new Map());
    const r2 = allocateSlots(lines, new Set(), new Map());
    for (const id of ids) {
      expect(r1.map.get(id)).toBe(r2.map.get(id));
    }
  });

  it('cacheFromAllocation strips nulls', () => {
    const a = findSessionIdForSlot(1);
    const b = findSessionIdForSlot(2, new Set([a]));
    const allocation = allocateSlots(
      [makeLine(a, 'ringing'), makeLine(b, 'completed')],
      new Set(),
      new Map()
    );
    const cache = cacheFromAllocation(allocation);
    expect(cache.has(a)).toBe(true);
    expect(cache.has(b)).toBe(false);
  });

  it('drafted lines (via draftLineIds) are active and keep slots', () => {
    const id = findSessionIdForSlot(4);
    const { map } = allocateSlots(
      [makeLine(id, 'idle')], // raw idle...
      new Set([id]), // ...but has a draft -> drafted -> ready_for_review -> active
      new Map()
    );
    expect(map.get(id)).toBe(4);
  });
});
