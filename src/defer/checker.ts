/**
 * Background deferral checker.
 *
 * Polls every 30 seconds. For each line with an active deferral, evaluates
 * its condition. On match, fires the onReSurface callback (which the App
 * uses to re-ring the line and log condition_met to history).
 *
 * Stores deferrals in memory only for now; a later version persists them to
 * ~/.switchboard/deferrals.jsonl so deferrals survive restart.
 */

import type { Deferral } from '../types.js';
import { evaluateCondition } from './conditions.js';

const CHECK_INTERVAL_MS = 30_000;

export interface DeferralStore {
  set(lineId: string, deferral: Deferral): void;
  clear(lineId: string): void;
  get(lineId: string): Deferral | undefined;
  list(): Array<[string, Deferral]>;
}

export function createDeferralStore(): DeferralStore {
  const map = new Map<string, Deferral>();
  return {
    set(lineId, deferral) {
      map.set(lineId, deferral);
    },
    clear(lineId) {
      map.delete(lineId);
    },
    get(lineId) {
      return map.get(lineId);
    },
    list() {
      return Array.from(map.entries());
    },
  };
}

export interface CheckerOptions {
  store: DeferralStore;
  onReSurface: (lineId: string, deferral: Deferral) => void;
}

export function startDeferralChecker(opts: CheckerOptions): { stop: () => void } {
  let stopped = false;

  function tick(): void {
    if (stopped) return;
    const now = new Date();
    for (const [lineId, deferral] of opts.store.list()) {
      // In the current flow the condition is null (a plain zone transition,
      // no auto-resurface). A later version re-introduces conditional re-ring.
      if (deferral.condition === null) continue;
      const deferredAt = new Date(deferral.createdAt);
      if (evaluateCondition({ condition: deferral.condition, now, deferredAt })) {
        opts.store.clear(lineId);
        opts.onReSurface(lineId, deferral);
      }
    }
  }

  const timer = setInterval(tick, CHECK_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
