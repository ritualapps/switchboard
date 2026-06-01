/**
 * Switchboard App.
 *
 * Coordinates the board (persistent peripheral) + drill-in (foregrounded
 * plug-in) + draft state (per-line draft buffers, persist across disconnect)
 * + hand-back (wander-away-safe batched dispatch) + defer (operator state).
 *
 * Key model:
 *   BOARD:
 *     j/k  or arrows : navigate
 *     Enter or right : plug in to focused line
 *     h              : hand-back (dispatch all drafts)
 *     D              : defer focused line (NEEDS YOU -> TO DO; no prompts)
 *     u              : un-defer focused line
 *     X              : dismiss focused line (high-water-mark)
 *     q              : quit
 *   DRILL-IN:
 *     (see DrillIn.tsx for body-cursor + annotation-cursor keys)
 *
 * No audible cues anywhere -- the interface is visual only.
 *
 * Defer: pressing D fires a single-keystroke NEEDS YOU -> TO DO zone
 * transition. No condition, no reason capture, no modal. The operator
 * re-engages by plugging in from TO DO. Conditional re-ring and reason
 * capture are planned for a later release.
 *
 * Annotation lifecycle: the operator's curated set at hand-back is the
 * canonical send. Edit (cursor onto annotation + Enter) and delete
 * (cursor + x) are first-class. The system never flags annotations as
 * stale -- the operator is trusted to curate.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { nanoid } from 'nanoid';
import type {
  Line,
  LineDraft,
  Annotation,
  Deferral,
} from '../types.js';
import type { SwitchboardAdapter } from '../adapter.js';
import { Header } from './Header.js';
import { Board } from './Board.js';
import { DrillIn } from './DrillIn.js';
import { sectionLines, sectionForState, effectiveState } from './ordering.js';
import { identityForSession } from './identity.js';
import { allocateSlots, cacheFromAllocation } from './slot-allocator.js';
import { loadSlotCacheSync, saveSlotCache } from '../state-overlay/slot-cache.js';
import { handBack } from '../dispatch/dispatcher.js';
import { startDeferralChecker } from '../defer/checker.js';
import { appendHistoryEvent } from '../audit/log.js';
import { loadDraftsSync, saveDrafts } from '../state-overlay/drafts.js';
import { computeDrillInLayout, ANNOTATION_VIEWPORT_CAP } from './layout.js';

interface Props {
  adapter: SwitchboardAdapter;
}

type Mode = 'board' | 'drill_in';
type DrillInStep = 'navigate' | 'content';

/**
 * Body-or-annotation cursor.
 *
 *   - `{ kind: 'body', line }` -- cursor on a body line (default).
 *   - `{ kind: 'annotation', index }` -- cursor on a draft annotation row.
 *
 * Transitions are continuous: down-arrow on the last body line jumps to
 * annotation 0 (if drafts exist); up-arrow on annotation 0 returns to the
 * last visible body line. Within either kind, j/k/arrows navigate.
 *
 * `editingIndex` is set when Enter on a focused annotation opens content
 * step for in-place edit; the commit replaces that annotation rather than
 * appending. `null` = appending a fresh annotation.
 */
export type DrillInCursor =
  | { kind: 'body'; line: number }
  | { kind: 'annotation'; index: number };

export function App({ adapter }: Props) {
  // Raw lines from the adapter; overlays (deferral, submitted-bundle) are
  // applied via the `lines` useMemo below so React state changes to either
  // overlay map drive an immediate re-render.
  const [rawLines, setRawLines] = useState<Line[]>(() => adapter.getLines());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('board');
  const [drillInStep, setDrillInStep] = useState<DrillInStep>('navigate');
  const [drafts, setDrafts] = useState<Map<string, LineDraft>>(() => loadDraftsSync());
  // submittedBundles: in-flight after hand-back. Key = lineId; value =
  // bundleId that was just dispatched. Cleared when the line's currentBundle
  // changes (agent posted a new turn). Wander-away-safe: the cell renders
  // RUNNING instead of stale RINGING until the agent advances.
  const [submittedBundles, setSubmittedBundles] = useState<Map<string, string>>(new Map());
  // Deferrals held in React state so a defer / un-defer triggers an
  // immediate re-render -- the line moves to TO DO on the keystroke, not on
  // the next adapter poll. These were lifted out of a mutable-Map store
  // that was invisible to React's diff, which lagged the zone transition a
  // full poll cycle.
  const [deferrals, setDeferrals] = useState<Map<string, Deferral>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const stdoutCols = stdout?.columns ?? 80;
  const prevModeRef = useRef<Mode>('board');

  // Mode transitions back to board rely on the alt-screen buffer (entered
  // in cli.ts) as the surface-close clear. Avoid a manual `\x1b[2J\x1b[H`
  // here -- it races Ink's diff renderer and causes a visible black flash
  // on every collapse.
  useEffect(() => {
    prevModeRef.current = mode;
  }, [mode]);

  // Subscribe to adapter line updates -- store raw; overlays apply below.
  useEffect(() => {
    const handler = (next: Line[]) => {
      setRawLines([...next]);
    };
    adapter.on('lines', handler);
    return () => adapter.off('lines', handler);
  }, [adapter]);

  // Apply deferral + submitted-bundle overlays on every render. Deferrals
  // live in React state so a `D` keystroke triggers an immediate zone
  // transition (the line moves to TO DO without waiting for the next
  // adapter poll). Same for un-defer.
  const lines = useMemo(() => {
    return rawLines.map((l) => {
      const d = deferrals.get(l.id);
      let line = d ? { ...l, deferral: d } : l;
      const submittedId = submittedBundles.get(l.id);
      if (submittedId && l.currentBundle?.id === submittedId) {
        line = { ...line, state: 'in_progress' };
      }
      return line;
    });
  }, [rawLines, deferrals, submittedBundles]);

  // submittedBundles auto-clear: when the line advances past the submitted
  // bundle (agent posted a new turn), drop the marker.
  useEffect(() => {
    if (submittedBundles.size === 0) return;
    const next = new Map(submittedBundles);
    let changed = false;
    for (const [lineId, submittedId] of submittedBundles) {
      const line = lines.find((l) => l.id === lineId);
      const currentId = line?.currentBundle?.id ?? null;
      if (currentId === null || currentId !== submittedId) {
        next.delete(lineId);
        changed = true;
      }
    }
    if (changed) setSubmittedBundles(next);
  }, [lines, submittedBundles]);

  // Mirror deferrals state into a ref so the long-lived deferral-checker
  // closure reads current values without re-binding every render.
  const deferralsRef = useRef(deferrals);
  useEffect(() => {
    deferralsRef.current = deferrals;
  }, [deferrals]);

  // Start the background deferral checker. Today every deferral has a null
  // condition (a pure zone transition); the checker no-ops on null. It
  // stays wired so conditional re-ring can be switched on later without a
  // re-architecture.
  useEffect(() => {
    const checker = startDeferralChecker({
      store: {
        set: (lineId, deferral) =>
          setDeferrals((prev) => new Map(prev).set(lineId, deferral)),
        clear: (lineId) =>
          setDeferrals((prev) => {
            if (!prev.has(lineId)) return prev;
            const next = new Map(prev);
            next.delete(lineId);
            return next;
          }),
        get: (lineId) => deferralsRef.current.get(lineId),
        list: () => Array.from(deferralsRef.current.entries()),
      },
      onReSurface: (lineId, deferral) => {
        setToast(`re-surfaced: ${lineId.slice(0, 8)} (${deferral.reason})`);
        void appendHistoryEvent({
          lineId,
          kind: 'condition_met',
          at: new Date().toISOString(),
          payload: { reason: deferral.reason, condition: deferral.condition },
        });
      },
    });
    return () => checker.stop();
  }, []);

  // Toast auto-clear.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Persist drafts on every change so they survive a binary restart.
  // Debounced 100ms async to keep the render path non-blocking; the
  // exit-path flush in cli.ts guarantees no loss on process termination.
  useEffect(() => {
    saveDrafts(drafts);
  }, [drafts]);

  // Tab-title NEEDS YOU count. The terminal window title becomes
  // "Switchboard (N)" when at least one line is in the NEEDS YOU zone, else
  // "Switchboard". This lets the operator see the unread count without
  // switching focus back to the terminal.
  //
  // The OSC 0 escape sequence (\x1b]0;TITLE\x07) sets both icon and window
  // title; it is supported across macOS Terminal, iTerm2, Windows Terminal,
  // gnome-terminal, and alacritty. Skipped when the title hasn't changed
  // (avoid emitting OSC bytes every poll when the count is stable); skipped
  // when stdout is not a TTY (the binary is being piped) so test runs don't
  // pollute stdout with escape sequences.
  const lastTitleRef = useRef<string>('');
  useEffect(() => {
    const title = deriveTabTitle(lines);
    if (title === lastTitleRef.current) return;
    lastTitleRef.current = title;
    if (!process.stdout.isTTY) return;
    try {
      process.stdout.write(formatTabTitleEscape(title));
    } catch {
      // best-effort; OSC writes are non-essential
    }
  }, [lines]);

  // Order ids for j/k navigation -- MUST match Board's section-grouped
  // display order so pressing down moves the cursor down visually.
  const draftLineIds = useMemo(() => new Set(Array.from(drafts.keys())), [drafts]);
  const orderedIds = useMemo(
    () => sectionLines(lines, draftLineIds).flat.map((l) => l.id),
    [lines, draftLineIds]
  );

  // Slot allocation -- the 1-9 addressing surface. Cached in a ref so
  // assignments stay stable across polls; persisted to ~/.switchboard/
  // slot-cache.json so `switchboard cmd <N>` from another shell sees the
  // same map.
  const slotCacheRef = useRef<Map<string, number>>(loadSlotCacheSync());
  const slotMap = useMemo(() => {
    const allocation = allocateSlots(lines, draftLineIds, slotCacheRef.current);
    const nextCache = cacheFromAllocation(allocation);
    slotCacheRef.current = nextCache;
    saveSlotCache(nextCache);
    return allocation.map;
  }, [lines, draftLineIds]);

  // Keep focus on a valid line.
  useEffect(() => {
    if (orderedIds.length === 0) {
      if (focusedId !== null) setFocusedId(null);
      return;
    }
    if (!focusedId || !orderedIds.includes(focusedId)) {
      setFocusedId(orderedIds[0]!);
    }
  }, [orderedIds, focusedId]);

  const focused = useMemo(() => lines.find((l) => l.id === focusedId) ?? null, [lines, focusedId]);
  const focusedDraft = focused ? drafts.get(focused.id) ?? null : null;

  useInput((input, key) => {
    if (mode === 'drill_in') {
      // Esc / left-arrow / up-arrow routing:
      //   navigate step  : Esc OR left-arrow -> full disconnect to board
      //                    (up-arrow stays as body cursor up in this step)
      //   content step   : Esc -> back to navigate
      //                    Left-arrow falls through to TextInput (native
      //                    cursor edit). Intercepting it here lost
      //                    operator-typed annotation content.
      // Ctrl+G is always the emergency full-disconnect regardless of step.
      // `q` in navigate step is a third disconnect gesture. It is handled
      // in DrillIn.tsx because it needs to be inert during content step
      // (TextInput owns typed characters).
      //
      // Content-step back-out is Esc only. Up-arrow was once doubled as a
      // back-out gesture on the rationale that TextInput has no native
      // up-arrow meaning, but that "safety" silently destroyed work when an
      // operator hit up-arrow while editing a multi-line annotation. Now
      // up-arrow falls through to TextInput (inert for single-line) so
      // accidental presses preserve the buffer. Left-arrow already passes
      // through. Esc cancels.
      const isEmergency = key.ctrl && input === 'g';
      const isBackOut =
        drillInStep === 'navigate'
          ? key.escape || key.leftArrow
          : key.escape;
      if (isEmergency) {
        if (focused) {
          void appendHistoryEvent({
            lineId: focused.id,
            kind: 'disconnect',
            at: new Date().toISOString(),
            payload: { hadDraft: drafts.has(focused.id), via: 'emergency' },
          });
        }
        setMode('board');
        setDrillInStep('navigate');
        return;
      }
      if (isBackOut) {
        if (drillInStep === 'content') {
          // Clean surface close. Stay in drill-in; the cursor returns to
          // its body position.
          setDrillInStep('navigate');
          return;
        }
        // Step is navigate -- full disconnect.
        if (focused) {
          void appendHistoryEvent({
            lineId: focused.id,
            kind: 'disconnect',
            at: new Date().toISOString(),
            payload: { hadDraft: drafts.has(focused.id) },
          });
        }
        setMode('board');
        setDrillInStep('navigate');
        return;
      }
      // Defer from drill-in. The operator usually decides "defer this"
      // while reading the bundle, not after disconnecting. `D` in navigate
      // step fires the same zone transition (NEEDS YOU / READY FOR REVIEW
      // -> TO DO) as `D` on the board, then disconnects to the board so the
      // operator can walk to the next line. Inert during content step
      // (TextInput owns typed characters).
      if (drillInStep === 'navigate' && input === 'D' && focused) {
        const now = new Date().toISOString();
        const deferral: Deferral = {
          condition: null,
          reason: '',
          createdAt: now,
        };
        setDeferrals((prev) => new Map(prev).set(focused.id, deferral));
        void appendHistoryEvent({
          lineId: focused.id,
          kind: 'defer',
          at: now,
          payload: { mvp: true, fromDrillIn: true },
        });
        void appendHistoryEvent({
          lineId: focused.id,
          kind: 'disconnect',
          at: now,
          payload: { hadDraft: drafts.has(focused.id), viaDefer: true },
        });
        setToast(`deferred: ${focused.projectName}`);
        setMode('board');
        setDrillInStep('navigate');
        return;
      }
      return;
    }

    // mode === 'board'
    if (input === 'q' || (key.ctrl && input === 'c')) {
      void adapter.stop().finally(() => exit());
      return;
    }
    if (input === 'j' || key.downArrow) {
      moveFocus(+1);
      return;
    }
    if (input === 'k' || key.upArrow) {
      moveFocus(-1);
      return;
    }
    // Direct-slot plug-in, a single gesture. Digits 1-9 jump straight to
    // the line that holds the matching slot in the allocator map. With
    // collision resolution, the slot may differ from the session's hash
    // slot when collisions or cache pinning happen. No-op when no session
    // holds the slot (slots 1-9 may not all be occupied if there are fewer
    // active sessions, or all 9 may be taken if 9 or more are active and a
    // further session is unslotted).
    if (/^[1-9]$/.test(input)) {
      const slot = Number(input);
      const target = lines.find((l) => slotMap.get(l.id) === slot);
      if (target) {
        plugInTo(target.id);
      }
      return;
    }
    if ((key.return || key.rightArrow) && focused) {
      plugInTo(focused.id);
      return;
    }
    if (input === 'h') {
      void doHandBack();
      return;
    }
    // Walk across ringing / blocked lines within the current zone. `n`
    // jumps the cursor forward to the next ringing-or-blocked line in the
    // focused line's zone; `N` jumps backward. The walk wraps around so a
    // rapid pass doesn't dead-end. No-op when there is no focused line (the
    // operator hasn't entered the board yet).
    if ((input === 'n' || input === 'N') && focused) {
      const target = nextRingingInZone(focused.id, input === 'n' ? +1 : -1);
      if (target) setFocusedId(target);
      return;
    }
    if (input === 'D' && focused) {
      // Single-keystroke defer: NEEDS YOU / READY FOR REVIEW -> TO DO.
      // No prompts. No condition. No reason. Operator re-engages by
      // plug-in (Enter / right-arrow / 1-9) from the visible TO DO list.
      const now = new Date().toISOString();
      const deferral: Deferral = {
        condition: null,
        reason: '',
        createdAt: now,
      };
      setDeferrals((prev) => new Map(prev).set(focused.id, deferral));
      void appendHistoryEvent({
        lineId: focused.id,
        kind: 'defer',
        at: now,
        payload: { mvp: true },
      });
      setToast(`deferred: ${focused.projectName}`);
      return;
    }
    if (input === 'u' && focused) {
      setDeferrals((prev) => {
        if (!prev.has(focused.id)) return prev;
        const next = new Map(prev);
        next.delete(focused.id);
        return next;
      });
      setToast(`un-deferred: ${focused.projectName}`);
      return;
    }
    if (input === 'X' && focused) {
      void adapter.dismiss(focused).then(() => {
        void appendHistoryEvent({
          lineId: focused.id,
          kind: 'dismiss',
          at: new Date().toISOString(),
          payload: { eventCount: focused.eventCount, lastEventAt: focused.lastEventAt },
        });
        setToast(`dismissed: ${focused.projectName} (X again to bring back)`);
      });
      return;
    }
  });

  /**
   * Plug-in helper -- shared by the Enter / right-arrow (focused) and
   * digit 1-9 (direct-slot) gestures. Focuses the target line, clears any
   * active deferral (re-engaging the line), opens drill_in/navigate, and
   * appends a plug_in history event.
   */
  function plugInTo(lineId: string): void {
    if (focusedId !== lineId) setFocusedId(lineId);
    if (deferrals.has(lineId)) {
      setDeferrals((prev) => {
        const next = new Map(prev);
        next.delete(lineId);
        return next;
      });
    }
    setMode('drill_in');
    setDrillInStep('navigate');
    const target = lines.find((l) => l.id === lineId);
    void appendHistoryEvent({
      lineId,
      kind: 'plug_in',
      at: new Date().toISOString(),
      payload: { bundleId: target?.currentBundle?.id ?? null },
    });
  }

  /**
   * Walk to the next (delta=+1) or previous (delta=-1) ringing-or-blocked
   * line within the focused line's zone. Returns the target line id, or
   * `null` if no other ringing/blocked line exists in the zone. The current
   * focus is included in the walk so a wrap that returns to the starting
   * line is a stable no-op.
   */
  function nextRingingInZone(fromId: string, delta: 1 | -1): string | null {
    const fromLine = lines.find((l) => l.id === fromId);
    if (!fromLine) return null;
    const fromZone = sectionForState(
      effectiveState(fromLine, draftLineIds.has(fromLine.id))
    );
    const fromIdxInBoard = orderedIds.indexOf(fromId);
    if (fromIdxInBoard < 0) return null;
    const N = orderedIds.length;
    for (let i = 1; i <= N; i++) {
      const probeIdx = (fromIdxInBoard + delta * i + N * N) % N;
      const probeId = orderedIds[probeIdx]!;
      const probe = lines.find((l) => l.id === probeId);
      if (!probe) continue;
      const probeZone = sectionForState(
        effectiveState(probe, draftLineIds.has(probe.id))
      );
      if (probeZone !== fromZone) continue;
      const probeState = effectiveState(probe, draftLineIds.has(probe.id));
      if (probeState === 'ringing' || probeState === 'blocked') return probeId;
    }
    return null;
  }

  function moveFocus(delta: number): void {
    if (orderedIds.length === 0) return;
    const idx = focusedId ? orderedIds.indexOf(focusedId) : -1;
    const nextIdx = idx < 0 ? 0 : (idx + delta + orderedIds.length) % orderedIds.length;
    setFocusedId(orderedIds[nextIdx]!);
  }

  function onAddAnnotation(annotation: Annotation): void {
    if (!focused) return;
    setDrafts((m) => {
      const next = new Map(m);
      const existing = next.get(focused.id);
      if (existing) {
        next.set(focused.id, {
          ...existing,
          annotations: [...existing.annotations, annotation],
        });
      } else {
        next.set(focused.id, {
          lineId: focused.id,
          bundleId: focused.currentBundle?.id ?? `orphan-${nanoid(8)}`,
          startedAt: new Date().toISOString(),
          annotations: [annotation],
        });
      }
      return next;
    });
    void appendHistoryEvent({
      lineId: focused.id,
      kind: 'draft_add',
      at: new Date().toISOString(),
      payload: { annotationId: annotation.id },
    });
    // No per-add toast. The draft list inside the DrillIn panel plus the
    // header's "N drafts pending" indicator are the confirmation. The toast
    // is reserved for load-bearing moments (post-hand-back, GC, no-op).
  }

  function onUpdateAnnotation(index: number, content: string): void {
    if (!focused) return;
    setDrafts((m) => {
      const next = new Map(m);
      const existing = next.get(focused.id);
      if (!existing || index < 0 || index >= existing.annotations.length) {
        return m;
      }
      const updated = existing.annotations.slice();
      const prior = updated[index]!;
      updated[index] = { ...prior, content };
      next.set(focused.id, { ...existing, annotations: updated });
      return next;
    });
    void appendHistoryEvent({
      lineId: focused.id,
      kind: 'draft_add',
      at: new Date().toISOString(),
      payload: { edit: true, index },
    });
  }

  function onDeleteAnnotation(index: number): void {
    if (!focused) return;
    setDrafts((m) => {
      const next = new Map(m);
      const existing = next.get(focused.id);
      if (!existing || index < 0 || index >= existing.annotations.length) {
        return m;
      }
      const remaining = existing.annotations.filter((_, i) => i !== index);
      if (remaining.length === 0) {
        next.delete(focused.id);
      } else {
        next.set(focused.id, { ...existing, annotations: remaining });
      }
      return next;
    });
    void appendHistoryEvent({
      lineId: focused.id,
      kind: 'draft_add',
      at: new Date().toISOString(),
      payload: { delete: true, index },
    });
  }

  function onDisconnect(): void {
    if (focused) {
      void appendHistoryEvent({
        lineId: focused.id,
        kind: 'disconnect',
        at: new Date().toISOString(),
        payload: { hadDraft: drafts.has(focused.id) },
      });
    }
    setMode('board');
    setDrillInStep('navigate');
  }

  async function doHandBack(): Promise<void> {
    if (drafts.size === 0) {
      setToast('no drafts to hand back');
      return;
    }
    const draftList = Array.from(drafts.values()).filter((d) => d.annotations.length > 0);
    if (draftList.length === 0) {
      setToast('no drafts to hand back');
      return;
    }
    const report = await handBack({ drafts: draftList, allLines: lines });
    // Mark each dispatched line's current bundle as submitted so the cell
    // renders RUNNING instead of stale RINGING until the agent advances.
    setSubmittedBundles((prev) => {
      const next = new Map(prev);
      for (const draft of draftList) {
        next.set(draft.lineId, draft.bundleId);
      }
      return next;
    });
    setDrafts(new Map());
    setToast(`hand-back: ${report.summary} (${report.annotationCount} across ${report.lineCount})`);
  }

  // Compute row allocations across Header / Board / DrillIn / Footer.
  // When drill-in is mounted the Board collapses to a peripheral strip (a
  // few rows) and DrillIn gets the rest of the terminal height. This keeps
  // DrillIn's title + state line + body cursor visible regardless of which
  // session the operator plugs in to. Without it, plugging into a
  // top-of-list session leaves the DrillIn taller than the remaining
  // terminal area and its top rows scroll off the alt-screen.
  const totalRows = stdout?.rows ?? 24;
  const HEADER_ROWS = 1;
  const BOARD_PERIPHERAL_ROWS = 8; // section header + 1 cell + collapsed others
  const hintForMode = footerHintFor(mode, lines.length, drafts.size);
  const reservedFooterRows = estimateFooterRows(hintForMode, stdoutCols);

  const drillInActive = mode === 'drill_in' && focused !== null;

  const boardAvailableRows = drillInActive
    ? BOARD_PERIPHERAL_ROWS
    : Math.max(10, totalRows - HEADER_ROWS - reservedFooterRows);

  // The drill-in row budget is owned by computeDrillInLayout (src/tui/layout.ts)
  // so the body and annotation viewports can never, between them, demand more
  // rows than the pinned column has -- the overflow that made Yoga collapse
  // middle rows. The body floor is honoured there; when the terminal is too
  // short for both, the annotation pane yields and scrolls.
  const annotationCount = focusedDraft?.annotations.length ?? 0;
  const drillInLayout = computeDrillInLayout({ totalRows, reservedFooterRows, annotationCount });
  const drillInBodyViewport = drillInActive ? drillInLayout.bodyViewportRows : 20;
  const drillInAnnotationViewport = drillInActive
    ? drillInLayout.annotationViewportRows
    : ANNOTATION_VIEWPORT_CAP;

  // `height={totalRows}` + a flexGrow spacer above the Footer is
  // load-bearing. Without them, the outer Box takes content height only;
  // when DrillIn unmounts on disconnect, Ink's diff renderer leaves the old
  // DrillIn rows on the alt-screen until the next keystroke triggers a
  // redraw deeper than the previous frame. The operator then perceives the
  // disconnect as silent (board cursor moved but DrillIn package still on
  // screen). Pinning the column to full terminal height plus a spacer in
  // the freed slot forces Ink to emit blank rows where DrillIn used to be,
  // overwriting the stale frame.
  return (
    <Box flexDirection="column" height={totalRows}>
      <Header draftCount={drafts.size} />
      <Board
        lines={lines}
        focusedId={focusedId}
        draftLineIds={draftLineIds}
        availableRows={boardAvailableRows}
        slotMap={slotMap}
      />

      {drillInActive && focused && (
        <DrillIn
          line={focused}
          draft={focusedDraft}
          step={drillInStep}
          setStep={setDrillInStep}
          onAddAnnotation={onAddAnnotation}
          onUpdateAnnotation={onUpdateAnnotation}
          onDeleteAnnotation={onDeleteAnnotation}
          onDisconnect={onDisconnect}
          maxBodyViewport={drillInBodyViewport}
          maxAnnotationViewport={drillInAnnotationViewport}
        />
      )}

      <Box flexGrow={1} />
      <Footer mode={mode} toast={toast} count={lines.length} draftCount={drafts.size} />
    </Box>
  );
}

function footerHintFor(mode: Mode, count: number, draftCount: number): string {
  if (mode === 'board') {
    return `↓↑/j/k nav · enter/→ plug in · 1-9 plug in by slot · D defer · u un-defer · X dismiss · h hand-back · q quit  ·  ${count} line${count === 1 ? '' : 's'}${
      draftCount > 0 ? ` · ${draftCount} draft${draftCount === 1 ? '' : 's'}` : ''
    }`;
  }
  return '';
}

/**
 * Estimate how many terminal rows the footer hint occupies when it wraps.
 * Approximation: char count divided by terminal columns, rounded up,
 * plus 1 for the marginTop on the Footer Box.
 */
export function estimateFooterRows(hint: string, cols: number): number {
  if (!hint) return 2; // Footer always has marginTop=1 + 1 content row even when blank
  const wrapCount = Math.max(1, Math.ceil(hint.length / Math.max(20, cols)));
  return wrapCount + 1; // +1 for marginTop
}

/**
 * Pure helpers for the tab-title primitive. Exported so they can be
 * unit-tested independently of the React render path.
 *
 * `deriveTabTitle` -- "Switchboard (N)" when at least one NEEDS YOU line;
 *                     "Switchboard" otherwise.
 * `formatTabTitleEscape` -- OSC 0 wrapper (`\x1b]0;TITLE\x07`).
 */
export function deriveTabTitle(lines: ReadonlyArray<{ state: Line['state'] }>): string {
  const needsYouCount = lines.filter((l) => l.state === 'blocked').length;
  return needsYouCount > 0 ? `Switchboard (${needsYouCount})` : 'Switchboard';
}

export function formatTabTitleEscape(title: string): string {
  // Strip ESC / BEL / ST from the title so it cannot terminate the OSC
  // sequence early and inject further control bytes. deriveTabTitle only
  // produces fixed strings today, but this keeps the sink safe if a future
  // caller ever passes transcript-derived text.
  // eslint-disable-next-line no-control-regex
  const safe = title.replace(/[\x00-\x1f\x7f]/g, '');
  return `\x1b]0;${safe}\x07`;
}

function Footer({
  mode,
  toast,
  count,
  draftCount,
}: {
  mode: Mode;
  toast: string | null;
  count: number;
  draftCount: number;
}) {
  // The App-level Footer renders ONLY in board mode. In drill_in mode the
  // DrillIn component owns its own step-aware footer; rendering both
  // creates a dual-footer visual collision. The toast still surfaces in
  // both modes so post-hand-back / post-defer confirmations remain visible
  // regardless of where the operator is in the surface.
  if (mode !== 'board') {
    return toast ? (
      <Box paddingX={1} marginTop={1} justifyContent="flex-end">
        <Text color="green">{toast}</Text>
      </Box>
    ) : null;
  }
  const hint = footerHintFor(mode, count, draftCount);
  // The footer hint wraps naturally; App's `reservedFooterRows` reserves
  // the matching row count in Board's windowing so wrapping doesn't push
  // the Header off the alt-screen. An earlier truncate-end approach hid
  // operator-critical key bindings, so the footer must reserve enough space
  // at the bottom to display in full rather than truncate.
  return (
    <Box paddingX={1} marginTop={1} justifyContent="space-between">
      <Box flexGrow={1}>
        <Text dimColor>{hint}</Text>
      </Box>
      {toast && <Text color="green">{toast}</Text>}
    </Box>
  );
}
