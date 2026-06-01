/**
 * Shared line ordering + section mapping. Used by both the Board (display,
 * grouped by section with headers) and the App (j/k navigation through the
 * same flat order the sections imply).
 *
 * Zone labels shown to the operator:
 *   - REVIEW         -> READY FOR REVIEW
 *   - DEFERRED       -> TO DO
 *   - DONE absorbs   idle  -> INACTIVE (with `~` glyph distinguishing idle from
 *                                       completed / dismissed / closed)
 *
 * State names in code stay technical; only the zone labels rendered to the
 * operator change.
 *
 * Empty sections are suppressed in the Board renderer.
 */

import type { Line, LineState } from '../types.js';

export type SectionKey = 'needs_you' | 'ready_for_review' | 'running' | 'to_do' | 'inactive';

export const SECTION_ORDER: SectionKey[] = ['needs_you', 'ready_for_review', 'running', 'to_do', 'inactive'];

export const SECTION_LABEL: Record<SectionKey, string> = {
  needs_you: 'NEEDS YOU',
  ready_for_review: 'READY FOR REVIEW',
  running: 'RUNNING',
  to_do: 'TO DO',
  inactive: 'INACTIVE',
};

export const SECTION_COLOR: Record<SectionKey, string> = {
  needs_you: 'red',
  ready_for_review: 'yellow',
  running: 'cyan',
  to_do: 'gray',
  inactive: 'gray',
};

export function effectiveState(line: Line, drafted: boolean): LineState {
  if (line.stateManual) return line.stateManual;
  if (line.deferral) return 'deferred';
  if (drafted) return 'drafted';
  return line.state;
}

export function sectionForState(state: LineState): SectionKey {
  switch (state) {
    case 'blocked':
      return 'needs_you';
    case 'ringing':
    case 'drafted':
      return 'ready_for_review';
    case 'plugged_in':
    case 'in_progress':
      return 'running';
    case 'deferred':
      return 'to_do';
    case 'completed':
    case 'dismissed':
    case 'closed':
    case 'idle':
      return 'inactive';
  }
}

/**
 * Returns true if the line should render the "sleeping" `~` glyph in the
 * INACTIVE zone -- distinguishes idle (may re-ring) from finished
 * (completed/dismissed/closed; won't re-ring).
 */
export function isSleeping(state: LineState): boolean {
  return state === 'idle' || state === 'dismissed';
}

export interface SectionedLines {
  /** Sections in display order, including only non-empty groups. */
  sections: Array<{ key: SectionKey; lines: Line[] }>;
  /** Flat order of all lines, matching the visual top-to-bottom traversal. */
  flat: Line[];
}

export function sectionLines(lines: Line[], draftLineIds: Set<string>): SectionedLines {
  const buckets = new Map<SectionKey, Line[]>();
  for (const key of SECTION_ORDER) buckets.set(key, []);
  for (const line of lines) {
    const state = effectiveState(line, draftLineIds.has(line.id));
    buckets.get(sectionForState(state))!.push(line);
  }
  for (const [key, list] of buckets.entries()) {
    if (key === 'inactive') {
      // INACTIVE: stable order by startedAt ascending (oldest at top).
      // Within-zone newest-first applies to the zones the operator attends
      // to -- NEEDS YOU / READY FOR REVIEW / RUNNING / TO DO. INACTIVE is
      // where finished sessions live; if idle sessions keep ticking their
      // lastEventAt during background activity, the list churns and the
      // operator loses spatial memory. startedAt never changes after
      // session creation, so the ordering stays stable across polls.
      list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    } else {
      list.sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt));
    }
  }
  const sections: Array<{ key: SectionKey; lines: Line[] }> = [];
  const flat: Line[] = [];
  for (const key of SECTION_ORDER) {
    const group = buckets.get(key)!;
    if (group.length === 0) continue;
    sections.push({ key, lines: group });
    flat.push(...group);
  }
  return { sections, flat };
}
