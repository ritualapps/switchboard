/**
 * Slot allocator for the 9-slot board. The FNV-1a hash that drives the
 * pictograph family also picks a "preferred" slot, but the pigeonhole
 * principle bites once more than one active session hashes to the same
 * digit. This module resolves it: assign each ACTIVE session a unique slot
 * in [1, 9]; sessions beyond the first 9 (or INACTIVE-zone sessions) get
 * `null`.
 *
 * Algorithm (deterministic given same inputs):
 *   1. INACTIVE sessions get `null` outright. Slot is for review-and-
 *      respond zones only.
 *   2. Active sessions are sorted by `startedAt` ascending so older
 *      sessions get hash-slot priority -- they were on the board first
 *      and the operator's mental geography already maps them.
 *   3. Cache pass: any session whose `priorAssignments` slot is still
 *      free and the session is still active keeps that slot.
 *   4. Fresh pass: each remaining session tries its hash slot first; if
 *      taken, walks forward `(hash + i) mod 9 + 1` for `i = 1..8`. The
 *      first free slot is assigned. If all 9 are taken, the session gets
 *      `null` (visible on the board, addressable via cursor / Enter /
 *      `n`/`N`, but not via the 1-9 keystroke or shell jump).
 *
 * The hash + walk + cache combination preserves the common case ("session
 * X always lives at the same slot") while gracefully degrading when
 * collisions force a session off its preferred slot. The cache keeps a
 * session's assignment stable across polls and across `switchboard cmd
 * <N>` invocations.
 */

import { effectiveState, sectionForState } from './ordering.js';
import { identityForSession } from './identity.js';
import type { Line } from '../types.js';

export interface SlotAllocation {
  /** sessionId -> assigned slot (1-9) or `null` if no slot. */
  map: Map<string, number | null>;
}

export function allocateSlots(
  lines: ReadonlyArray<Line>,
  draftLineIds: ReadonlySet<string>,
  priorAssignments: ReadonlyMap<string, number>
): SlotAllocation {
  const map = new Map<string, number | null>();

  // INACTIVE sessions get no slot. Slot reservations follow active work.
  const activeLines: Line[] = [];
  for (const line of lines) {
    const state = effectiveState(line, draftLineIds.has(line.id));
    const zone = sectionForState(state);
    if (zone === 'inactive') {
      map.set(line.id, null);
    } else {
      activeLines.push(line);
    }
  }

  // Older sessions get hash priority -- they were on the board first.
  const sortedActive = activeLines.slice().sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)
  );

  // Slot occupancy: slot index -> sessionId of holder this allocation.
  const slotHolder = new Map<number, string>();

  // Cache pass: honour prior assignments where the slot is still free
  // and the session is still active. This is what keeps the assignment
  // stable across polls.
  for (const line of sortedActive) {
    const cached = priorAssignments.get(line.id);
    if (
      cached !== undefined &&
      Number.isInteger(cached) &&
      cached >= 1 &&
      cached <= 9 &&
      !slotHolder.has(cached)
    ) {
      slotHolder.set(cached, line.id);
      map.set(line.id, cached);
    }
  }

  // Fresh pass: assign new sessions and sessions whose cached slot was
  // taken by a longer-lived holder.
  for (const line of sortedActive) {
    if (map.has(line.id)) continue;
    const hashSlot = identityForSession(line.id).slot;
    let assigned: number | null = null;
    if (!slotHolder.has(hashSlot)) {
      assigned = hashSlot;
    } else {
      for (let i = 1; i < 9; i++) {
        const candidate = ((hashSlot - 1 + i) % 9) + 1;
        if (!slotHolder.has(candidate)) {
          assigned = candidate;
          break;
        }
      }
    }
    if (assigned !== null) {
      slotHolder.set(assigned, line.id);
      map.set(line.id, assigned);
    } else {
      map.set(line.id, null);
    }
  }

  return { map };
}

/**
 * Convert a slot allocation result into a stable cache map (no nulls,
 * suitable for persistence). Stripping nulls means INACTIVE sessions
 * don't pollute the cache.
 */
export function cacheFromAllocation(allocation: SlotAllocation): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, slot] of allocation.map) {
    if (slot !== null) out.set(id, slot);
  }
  return out;
}
