/**
 * Switchboard line reducer.
 *
 * Reduces a Claude Code session JSONL transcript into a Switchboard Line,
 * deriving the state machine (idle / ringing / plugged_in / drafted /
 * in_progress / blocked / deferred / completed) from observed events.
 *
 * One Claude Code session maps to one Line. Multi-session lines
 * (continuation, lineage) are a later addition.
 *
 * State derivation rules (blocked is deliberately narrow):
 *   ringing      -- assistant's last semantic act was text content to operator
 *                   AND no operator response yet (the agent paused with output)
 *   in_progress  -- agent is mid-flight (tool_use awaiting result or assistant
 *                   about to respond) -- this covers the case where the
 *                   operator has stepped away and the agent auto-proceeds
 *                   within granted authority
 *   blocked      -- NOT auto-derived from text-only output. Reserved for
 *                   genuine outside-of-authority blocks; for now the surface
 *                   shows only the agent's explicit blocked-on-input signal
 *                   when emitted
 *   completed    -- transcript ends with no pending agent action AND operator
 *                   has not surfaced a follow-up bundle. NOT a timeout-based
 *                   state -- time on the board is not urgency.
 *
 * `drafted`, `deferred`, `plugged_in` are operator-state, not transcript-
 * derived. They live in the App state (transient) or deferral store.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  parseJsonlLine,
  assistantContentBlocks,
  userTextContent,
  userToolResults,
  type CcEvent,
} from './jsonl-parser.js';
import { decodeProjectHash, projectLabel } from '../paths.js';
import { TRUNCATE_MARKER } from '../tui/text.js';
import {
  sanitiseTitle,
  singleLine,
  stripTerminalControls,
} from '../terminal-safe.js';
import type { Line, LineState, Bundle, CapacitySignals } from '../types.js';

const RECENT_RATE_WINDOW_MS = 5 * 60 * 1000;

export interface ReduceInput {
  transcriptPath: string;
  projectHash: string;
  sessionId: string;
  now: number;
}

/**
 * Reduce a transcript file to a Line by reading the file from disk on every
 * call. Used by callers that do not have an incremental cache (tests +
 * direct invocations). The adapter uses `reduceLineFromEvents` directly,
 * threading cached events from the transcript cache.
 */
export function reduceLine(input: ReduceInput): Line | null {
  let raw: string;
  try {
    raw = readFileSync(input.transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const events: CcEvent[] = [];
  for (const line of raw.split('\n')) {
    const ev = parseJsonlLine(line);
    if (ev) events.push(ev);
  }
  return reduceLineFromEvents(events, input);
}

/**
 * Pure reducer: events array in -> Line out. No filesystem access. The
 * caller is responsible for keeping `events` in sync with the transcript
 * (either by reading the file directly, or via the incremental
 * transcript cache).
 */
export function reduceLineFromEvents(events: CcEvent[], input: ReduceInput): Line | null {
  if (events.length === 0) return null;

  const first = events[0]!;
  const last = events[events.length - 1]!;
  const projectPath = decodeProjectHash(input.projectHash);
  const projectName = projectLabel(input.projectHash);

  // Title priority: custom-title (operator's /rename) > ai-title (auto) >
  // extracted first user prompt > project + session-id fallback.
  //
  // Every candidate flows through `sanitiseTitle` so `Line.title` always
  // carries a single-line, control-clean, non-empty string <=80 chars (with
  // width-safe truncation marker). See `src/terminal-safe.ts` for the
  // boundary contract. This is the invariant that prevents transcript-
  // derived noise -- terminal escapes (H1 regression), embedded newlines
  // (multi-line row break), CC slash-command wrapper leakage, future
  // harness-injected wrapper formats, paste of structured content -- from
  // reaching the render tree as a title.
  const customTitle = findLatestTitleByType(events, 'custom-title', 'customTitle');
  const aiTitle = findLatestTitleByType(events, 'ai-title', 'aiTitle');
  const rawFirst = findFirstUserPrompt(events);
  const displayableFirst = rawFirst
    ? extractDisplayableFirstPrompt(rawFirst)
    : null;
  const fallback = `${projectName} (${input.sessionId.slice(0, 8)})`;
  const title =
    sanitiseTitle(customTitle) ??
    sanitiseTitle(aiTitle) ??
    sanitiseTitle(displayableFirst) ??
    sanitiseTitle(fallback) ??
    '(untitled)';

  const startedAt = first.timestamp ?? new Date().toISOString();
  const lastEventAt = last.timestamp ?? startedAt;

  const state = deriveState(events);
  const lastEventSummary = deriveLastEventSummary(events);

  const hasBundle = state === 'ringing' || state === 'blocked';
  const currentBundle = hasBundle
    ? buildBundle(events, input.sessionId, lastEventAt)
    : null;

  const capacitySignals = computeCapacitySignals(events, input.now);

  // Sanitise every transcript-derived string that reaches the render tree.
  // Title is already covered above by sanitiseTitle. projectName is single-
  // lined + control-cleaned so a hostile path can't break row layout. The
  // bundle body/summary are sanitised in buildBundle.
  return {
    id: input.sessionId,
    title,
    projectPath,
    projectName: singleLine(stripTerminalControls(projectName)),
    projectHash: input.projectHash,
    transcriptPath: input.transcriptPath,
    state,
    startedAt,
    lastEventAt,
    lastEventSummary: stripTerminalControls(lastEventSummary),
    currentBundle,
    deferral: null,
    capacitySignals,
    eventCount: events.length,
  };
}

function deriveState(events: CcEvent[]): LineState {
  if (events.length < 2) return 'idle';

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'user') {
      const text = userTextContent(ev);
      if (text !== null) return 'in_progress';
      const results = userToolResults(ev);
      if (results.length > 0) return 'in_progress';
    }
    if (ev.type === 'assistant') {
      const blocks = assistantContentBlocks(ev);
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock?.type === 'text' && lastBlock.text.trim().length > 0) {
        return 'ringing';
      }
      if (lastBlock?.type === 'tool_use') {
        return 'in_progress';
      }
    }
  }

  return 'in_progress';
}

function deriveLastEventSummary(events: CcEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'assistant') {
      const blocks = assistantContentBlocks(ev);
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock?.type === 'text') {
        return truncateOneLine(lastBlock.text, 100);
      }
      if (lastBlock?.type === 'tool_use') {
        const argHint = summariseToolArgs(lastBlock.name, lastBlock.input);
        return `${lastBlock.name}${argHint ? ` ${argHint}` : ''}`;
      }
    }
    if (ev.type === 'user') {
      const text = userTextContent(ev);
      if (text) return `you: ${truncateOneLine(text, 90)}`;
    }
  }
  return '(no events yet)';
}

function buildBundle(
  events: CcEvent[],
  sessionId: string,
  createdAt: string
): Bundle {
  let body = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'assistant') {
      const blocks = assistantContentBlocks(ev);
      const textBlocks = blocks.filter(
        (b): b is { type: 'text'; text: string } => b.type === 'text'
      );
      if (textBlocks.length > 0) {
        body = textBlocks.map((b) => b.text).join('\n\n');
        break;
      }
    }
  }
  // Body is operator-read content from the transcript -- sanitise terminal
  // controls while preserving newlines (the body viewport splits on them).
  const safeBody = stripTerminalControls(body);
  return {
    id: `bundle-${sessionId}-${Date.parse(createdAt)}`,
    lineId: sessionId,
    createdAt,
    body: safeBody,
    summary: truncateOneLine(safeBody, 100),
  };
}

function computeCapacitySignals(events: CcEvent[], now: number): CapacitySignals {
  const last = events[events.length - 1];
  const lastMs = last?.timestamp ? Date.parse(last.timestamp) : now;
  const msSinceLastEvent = Math.max(0, now - lastMs);

  // queueDepth: count of pending tool_use blocks not yet matched by tool_result.
  const pendingToolUses = new Set<string>();
  for (const ev of events) {
    if (ev.type === 'assistant') {
      const blocks = assistantContentBlocks(ev);
      for (const b of blocks) {
        if (b.type === 'tool_use') pendingToolUses.add(b.id);
      }
    }
    if (ev.type === 'user') {
      const results = userToolResults(ev);
      for (const r of results) pendingToolUses.delete(r.tool_use_id);
    }
  }
  const queueDepth = pendingToolUses.size;

  // recentEventRate: events in the last window / minutes
  const windowStart = now - RECENT_RATE_WINDOW_MS;
  let recentCount = 0;
  for (const ev of events) {
    const t = ev.timestamp ? Date.parse(ev.timestamp) : 0;
    if (t >= windowStart) recentCount += 1;
  }
  const recentEventRate = (recentCount * 60_000) / RECENT_RATE_WINDOW_MS;

  return {
    queueDepth,
    recentEventRate,
    msSinceLastEvent,
  };
}

function findFirstUserPrompt(events: CcEvent[]): string | null {
  for (const ev of events) {
    if (ev.type === 'user') {
      const text = userTextContent(ev);
      if (text && text.trim()) return text.trim();
    }
  }
  return null;
}

// Claude Code wraps slash-command invocations in a fixed XML envelope before
// the rendered command body. We see this verbatim in the JSONL transcript:
//   <command-message>new</command-message>
//   <command-name>/new</command-name>
//   <command-args>session args here</command-args>
//   ...rendered command body...
// The <command-args> tag is optional -- a bare `/new` (no args) ends after
// </command-name>. Anchored at start of string so a wrapper appearing
// mid-prompt cannot match.
const CC_COMMAND_WRAPPER =
  /^<command-message>[^<]*<\/command-message>\s*<command-name>(\/[^<\s]+)<\/command-name>(?:\s*<command-args>([^<]*)<\/command-args>)?/;

/**
 * If `raw` opens with a Claude Code slash-command wrapper, return the
 * human-readable form "/cmd args" (or "/cmd" when args are absent or empty).
 * Otherwise return `raw` unchanged.
 */
function stripCcCommandWrapper(raw: string): string {
  const m = raw.match(CC_COMMAND_WRAPPER);
  if (!m) return raw;
  const cmd = m[1]!;
  const args = (m[2] ?? '').trim();
  return args ? `${cmd} ${args}` : cmd;
}

// First-char openers we treat as "this is structured content, not a sentence".
const STRUCTURED_FIRST_CHARS = new Set(['<', '{', '[']);

/**
 * Walk the input line by line and return the first line that looks like a
 * human-readable sentence -- not an XML tag, not a JSON-ish opener, not a
 * code fence, at least 3 chars. Returns null when no such line exists.
 */
function firstPlausibleLine(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (STRUCTURED_FIRST_CHARS.has(t[0]!)) continue;
    if (t.startsWith('```')) continue;
    if (t.length < 3) continue;
    return t;
  }
  return null;
}

/**
 * Extract a displayable title from the raw first-user-prompt content. Three
 * stages, applied in order:
 *
 *   1. Known CC slash-command wrapper -> "/cmd args" (or "/cmd").
 *   2. Structured-content skip: if the input opens with "<", "{", "[", or a
 *      code fence, walk the lines for the first plausible sentence. Catches
 *      future wrapper formats, JSON/code-fence pastes, and any input shape
 *      where the literal first 80 chars would be noise. Returns null if no
 *      plausible line exists, falling the title pipeline through to the
 *      project + sessionId fallback.
 *   3. Plain text path: return `raw` unchanged. Downstream `sanitiseTitle`
 *      handles multi-line collapse, length, and control bytes.
 *
 * This helper is the only place that knows Claude Code's wire format for
 * first-prompt content. Adding awareness of future wrappers is a single-file
 * change here.
 */
export function extractDisplayableFirstPrompt(raw: string): string | null {
  if (!raw) return null;

  const stripped = stripCcCommandWrapper(raw);
  if (stripped !== raw) return stripped;

  const trimmed = raw.trim();
  const first = trimmed[0];
  if (!first) return null;
  if (STRUCTURED_FIRST_CHARS.has(first) || trimmed.startsWith('```')) {
    return firstPlausibleLine(raw);
  }

  return raw;
}

function findLatestTitleByType(
  events: CcEvent[],
  type: string,
  field: 'customTitle' | 'aiTitle'
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const raw = events[i]?.raw;
    if (raw?.type === type) {
      const t = raw[field];
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
  }
  return null;
}

function summariseToolArgs(name: string, input: Record<string, unknown>): string {
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    const fp = input.file_path;
    if (typeof fp === 'string') return `(${basename(fp)})`;
  }
  if (name === 'Bash') {
    const cmd = input.command;
    if (typeof cmd === 'string') return `(${truncateOneLine(cmd, 50)})`;
  }
  return '';
}

function truncateOneLine(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + TRUNCATE_MARKER : oneLine;
}

export const _internal = {
  deriveState,
  deriveLastEventSummary,
  buildBundle,
  computeCapacitySignals,
  stripCcCommandWrapper,
  firstPlausibleLine,
};
