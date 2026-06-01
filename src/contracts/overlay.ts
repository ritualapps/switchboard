/**
 * Contract substrate overlay.
 *
 * Applies the precedence rule (blocked > ringing > checkpoint) to a Line that
 * the adapter has already reduced. The overlay mutates the passed-in `line`
 * to reflect the substrate and returns it alongside transition flags, so the
 * adapter can wire side-effects (history-log append on transition) while the
 * state-derivation logic stays testable in isolation.
 */

import { stripTerminalControls } from '../terminal-safe.js';
import type { CheckpointEvent, ContractEmission, Line } from '../types.js';

export interface OverlayResult {
  /** The line with state + lastEventSummary mutated to reflect substrate. */
  line: Line;
  /** True if this tick observed a fresh blocked-on-input emission (the
   *  caller emits `blocked_on_input` history). */
  transitionedToBlocked: boolean;
  /** True if a prior blocked emission has cleared this tick (the caller
   *  emits `blocked_on_input_cleared` history). */
  transitionedFromBlocked: boolean;
  /** The blocked-on-input emission that drove the state, if any. */
  blockedEmission: ContractEmission | null;
  /** Latest `/checkpoint` event for RUNNING-zone enrichment, if emitted. */
  checkpointLatest: CheckpointEvent | null;
}

/**
 * Apply substrate overlay. `priorBlockedMtimeMs` is the mtimeMs the caller
 * last observed for this session's `/blocked-on-input` file (or undefined
 * if none). The result reports whether this tick's emission is new (so the
 * caller can emit the appropriate history event).
 */
export function applySubstrateOverlay(
  line: Line,
  emissions: ReadonlyArray<ContractEmission>,
  priorBlockedMtimeMs: number | undefined
): OverlayResult {
  const checkpoint = emissions.find((e) => e.kind === 'checkpoint') ?? null;
  const checkpointLatest = checkpoint?.checkpointLatest ?? null;

  const blocked = emissions.find((e) => e.kind === 'blocked-on-input') ?? null;
  if (blocked && blocked.payload) {
    const pending = countPending(blocked.payload);
    line.state = 'blocked';
    line.lastEventSummary =
      pending > 0
        ? `blocked: ${pending} tool ${pending === 1 ? 'approval' : 'approvals'} pending`
        : 'blocked: agent emitted /blocked-on-input';
    return {
      line,
      transitionedToBlocked: priorBlockedMtimeMs !== blocked.mtimeMs,
      transitionedFromBlocked: false,
      blockedEmission: blocked,
      checkpointLatest,
    };
  }
  // Apply checkpoint enrichment to RUNNING-zone states only (in_progress /
  // plugged_in / ringing acting as a transient mid-flight signal). The
  // checkpoint message replaces the reducer-derived lastEventSummary so the
  // operator sees the agent's explicit "what milestone am I on" signal
  // instead of the inferred tool-name summary.
  if (
    checkpointLatest &&
    (line.state === 'in_progress' || line.state === 'plugged_in')
  ) {
    const milestone =
      typeof checkpointLatest.milestoneIndex === 'number' &&
      typeof checkpointLatest.milestoneTotal === 'number'
        ? `${checkpointLatest.milestoneIndex}/${checkpointLatest.milestoneTotal} · `
        : '';
    // checkpointLatest.message is agent-written (untrusted) -- sanitise
    // terminal controls before it reaches the render tree.
    line.lastEventSummary = stripTerminalControls(`${milestone}${checkpointLatest.message}`);
  }
  return {
    line,
    transitionedToBlocked: false,
    transitionedFromBlocked: priorBlockedMtimeMs !== undefined,
    blockedEmission: null,
    checkpointLatest,
  };
}

function countPending(payload: {
  calls?: ReadonlyArray<unknown>;
  approvals?: ReadonlyArray<unknown>;
}): number {
  return (payload.calls?.length ?? 0) + (payload.approvals?.length ?? 0);
}
