/**
 * Switchboard adapter.
 *
 * Polls `~/.claude/projects/<hash>/*.jsonl`, reduces each session into a Line
 * via the reducer, applies state-overlay primitives (dismissed / closed /
 * baseline), exposes a subscription API for the TUI.
 *
 * Visibility is driven by three composable primitives: a bootstrap baseline,
 * dismiss-with-high-water-mark, and closed-via-platform-hook. Sessions older
 * than the baseline are hidden until they advance past it; sessions the
 * operator dismisses are hidden until their event count advances past the
 * high-water mark; sessions the platform (Claude Code SessionEnd hook) closes
 * stay inactive.
 *
 * Polling keeps the design simple. A 2-second poll is plenty for
 * human-in-the-loop-paced work.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR, SWITCHBOARD_DIR } from './paths.js';
import { reduceLineFromEvents } from './claude-code/reducer.js';
import { getEventsIncremental, retainSessions } from './claude-code/transcript-cache.js';
import { loadDismissalStore, type DismissalStore } from './state-overlay/dismissal.js';
import { loadClosedStore, type ClosedStore } from './state-overlay/closed.js';
import { loadBaseline, passesBaseline, type Baseline } from './state-overlay/baseline.js';
import {
  enumerateSwitchboardSubstrate,
  type SubstrateScan,
} from './contracts/enumerate.js';
import { applySubstrateOverlay } from './contracts/overlay.js';
import { appendHistoryEvent } from './audit/log.js';
import type { Line, LineState } from './types.js';

const POLL_MS = 2000;

type LinesListener = (lines: Line[]) => void;

export interface SwitchboardAdapter {
  getLines(): Line[];
  on(event: 'lines', fn: LinesListener): void;
  off(event: 'lines', fn: LinesListener): void;
  setManualState(lineId: string, state: LineState | null): void;
  dismiss(line: Line): Promise<void>;
  undismiss(lineId: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startAdapter(): Promise<SwitchboardAdapter> {
  let lines = new Map<string, Line>();
  const listeners = new Set<LinesListener>();
  const manualStates = new Map<string, LineState>();
  let stopped = false;

  const dismissalStore: DismissalStore = await loadDismissalStore();
  let closedStore: ClosedStore = await loadClosedStore();
  const baseline: Baseline = await loadBaseline();

  /**
   * Per-session memory of contract emissions seen the prior scan tick.
   * Used for two things:
   *   - emit `blocked_on_input` audit log on first detection (the
   *     transition into blocked is a load-bearing operator-relevant event);
   *   - emit `blocked_on_input_cleared` when the deferred file disappears.
   * Keyed by sessionId; value is the file's mtimeMs so re-writes of the
   * same file (agent updated the deferred set) emit a fresh event.
   */
  const blockedSeen = new Map<string, number>();
  /**
   * Per-filename memory of `contract_render_skipped` audit events so the
   * same graceful-absence file doesn't log every poll tick.
   */
  const gracefulAbsenceLogged = new Set<string>();

  function snapshot(): Line[] {
    return Array.from(lines.values());
  }

  // Display-relevant signature: notify() skips when nothing the UI cares about
  // has changed since last emit. Fixes "1980s hacker movie" flicker where
  // every 2s poll re-renders the entire React tree even on idle disks.
  // Excludes msSinceLastEvent / msSinceLastOperatorInput because those tick
  // every poll regardless of substrate state -- including them would defeat
  // the dedup.
  let lastSignature = '';
  function signatureFor(snap: Line[]): string {
    return JSON.stringify(
      snap.map((l) => [
        l.id,
        l.state,
        l.stateManual ?? null,
        l.eventCount,
        l.lastEventAt,
        l.title,
        l.currentBundle?.id ?? null,
        l.capacitySignals.queueDepth,
        l.capacitySignals.recentEventRate,
        l.deferral ? [l.deferral.reason, l.deferral.condition?.kind ?? null] : null,
      ])
    );
  }

  function notify(): void {
    const snap = snapshot();
    const sig = signatureFor(snap);
    if (sig === lastSignature) return;
    lastSignature = sig;
    for (const fn of listeners) fn(snap);
  }

  async function scan(): Promise<void> {
    if (stopped) return;
    // Refresh closed-store from disk each scan -- SessionEnd hook is an
    // external writer.
    closedStore = await loadClosedStore();

    // Read the contract substrate once per tick. It sets the zone-driving
    // state by precedence (blocked > ringing > derived).
    const substrate: SubstrateScan = enumerateSwitchboardSubstrate(SWITCHBOARD_DIR);

    // Log graceful absences once per filename per process lifecycle so the
    // 2s poll doesn't spam the history log. Files with no defined render rule
    // are logged but not rendered; the log is the record contract authors can
    // audit against.
    for (const filename of substrate.gracefulAbsenceFiles) {
      if (gracefulAbsenceLogged.has(filename)) continue;
      gracefulAbsenceLogged.add(filename);
      void appendHistoryEvent({
        lineId: '(graceful-absence)',
        kind: 'contract_render_skipped',
        at: new Date().toISOString(),
        payload: { filename },
      });
    }

    const now = Date.now();
    const next = new Map<string, Line>();
    // Every sessionId whose transcript is still on disk this scan. Used at the
    // end to evict transcript-cache entries for sessions that have gone away,
    // bounding cache memory across a long-lived process.
    const seen = new Set<string>();
    let projectDirs: string[];
    try {
      projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
    } catch {
      return;
    }
    for (const projectHash of projectDirs) {
      const projectDir = join(CLAUDE_PROJECTS_DIR, projectHash);
      let files: string[];
      try {
        files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        const transcriptPath = join(projectDir, file);
        let mtime: number;
        try {
          mtime = statSync(transcriptPath).mtimeMs;
        } catch {
          continue;
        }
        const sessionId = file.replace(/\.jsonl$/, '');
        seen.add(sessionId);
        // Bootstrap baseline gates visibility: sessions with no activity
        // past the baseline are hidden.
        if (!passesBaseline(baseline, mtime)) continue;
        const cached = getEventsIncremental(sessionId, transcriptPath);
        if (!cached) continue;
        const line = reduceLineFromEvents(cached.events, {
          transcriptPath,
          projectHash,
          sessionId,
          now,
        });
        if (!line) continue;

        const manual = manualStates.get(sessionId);
        if (manual) line.stateManual = manual;

        // Apply closed-via-platform overlay (highest precedence among overlays).
        if (closedStore.isClosed(sessionId)) {
          line.state = 'closed';
          next.set(sessionId, line);
          continue;
        }

        // Apply dismissal HWM overlay.
        if (dismissalStore.isDismissedAt(sessionId, line.eventCount)) {
          line.state = 'dismissed';
          next.set(sessionId, line);
          continue;
        }

        // Past the high-water mark: state derives from the contract
        // substrate; the dismissal entry stays in dismissals.jsonl as
        // append-only audit of the operator's explicit dismissal. Only an
        // explicit undismiss() writes a tombstone.

        // Contract substrate overlay (precedence: blocked > ringing >
        // derived). When the agent has emitted `/blocked-on-input`, force
        // state to `blocked` and decorate the line's lastEventSummary with
        // the pending tool count. `/ringing` substrate is read by callers
        // that want the bundle body (drill-in); the cell's ringing state
        // is already correctly derived by the reducer.
        const result = applySubstrateOverlay(
          line,
          substrate.bySession.get(sessionId) ?? [],
          blockedSeen.get(sessionId)
        );
        if (result.transitionedToBlocked && result.blockedEmission) {
          blockedSeen.set(sessionId, result.blockedEmission.mtimeMs);
          const pending =
            (result.blockedEmission.payload?.calls?.length ?? 0) +
            (result.blockedEmission.payload?.approvals?.length ?? 0);
          void appendHistoryEvent({
            lineId: sessionId,
            kind: 'blocked_on_input',
            at: new Date(result.blockedEmission.mtimeMs).toISOString(),
            payload: { pending, filename: result.blockedEmission.filename },
          });
        }
        if (result.transitionedFromBlocked) {
          blockedSeen.delete(sessionId);
          void appendHistoryEvent({
            lineId: sessionId,
            kind: 'blocked_on_input_cleared',
            at: new Date().toISOString(),
            payload: {},
          });
        }

        next.set(sessionId, line);
      }
    }
    // Drop cache entries for transcripts no longer on disk this scan.
    retainSessions(seen);
    lines = next;
    notify();
  }

  await scan();
  const timer = setInterval(() => void scan(), POLL_MS);

  return {
    getLines: snapshot,
    on(event, fn) {
      if (event === 'lines') listeners.add(fn);
    },
    off(event, fn) {
      if (event === 'lines') listeners.delete(fn);
    },
    setManualState(lineId, state) {
      if (state === null) {
        manualStates.delete(lineId);
      } else {
        manualStates.set(lineId, state);
      }
      const ln = lines.get(lineId);
      if (ln) {
        if (state === null) delete ln.stateManual;
        else ln.stateManual = state;
      }
      notify();
    },
    async dismiss(line) {
      await dismissalStore.add({
        lineId: line.id,
        eventCount: line.eventCount,
        lastEventAt: line.lastEventAt,
        at: new Date().toISOString(),
      });
      const ln = lines.get(line.id);
      if (ln) {
        ln.state = 'dismissed';
        notify();
      }
    },
    async undismiss(lineId) {
      await dismissalStore.clear(lineId);
      // State will re-derive from substrate on next scan.
      notify();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      listeners.clear();
    },
  };
}
