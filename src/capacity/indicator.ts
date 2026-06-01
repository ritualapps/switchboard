/**
 * Capacity indicator.
 *
 * Derives a coarse capacity band (quiet / steady / heavy / blocked) from
 * observable signals (queue depth + recent event rate + time since last
 * event). Honest about being coarse -- NOT a self-reported time estimate
 * from the agent. The operator translates the band + cell-footer raw
 * signals into their own wander-confidence judgment.
 *
 * Thresholds are an initial calibration; expect to tune them against real
 * usage.
 */

import type { CapacitySignals, CapacityBand, LineState } from '../types.js';

const MIN_HEAVY_QUEUE_DEPTH = 3;
const STEADY_RATE_PER_MIN = 1;
const QUIET_EVENT_AGE_MS = 60_000;
const HEAVY_RATE_PER_MIN = 5;

export interface DeriveInput {
  signals: CapacitySignals;
  state: LineState;
}

export function deriveCapacityBand(input: DeriveInput): CapacityBand {
  if (input.state === 'blocked') return 'blocked';
  if (input.signals.queueDepth >= MIN_HEAVY_QUEUE_DEPTH) return 'heavy';
  if (input.signals.recentEventRate >= HEAVY_RATE_PER_MIN) return 'heavy';
  if (input.signals.recentEventRate >= STEADY_RATE_PER_MIN) return 'steady';
  if (input.signals.msSinceLastEvent < QUIET_EVENT_AGE_MS) return 'steady';
  return 'quiet';
}

export function formatCellFooter(signals: CapacitySignals): string {
  // The capacity-coupled "N queued" prefix is suppressed for now; capacity
  // visibility returns in a later version. "last event Xs ago" is a general
  // line-state signal independent of capacity and ships now.
  const age = formatAge(signals.msSinceLastEvent);
  return `last event ${age}`;
}

function formatAge(ms: number): string {
  if (Number.isNaN(ms) || ms < 0) return '-';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
