/**
 * Dispatcher.
 *
 * Hand-back is single-target per drafted line -- one reply per line goes to
 * that line's own agent, via the pickup-file convention. The Claude Code-side
 * hook (~/.claude/settings.json UserPromptSubmit) reads pickup files matching
 * its session id and injects them as user-prompt context.
 *
 * Pickup file path: ~/.switchboard/pickup-<sessionId>-<bundleId>.md
 * One annotation block is appended per annotation; the hook concatenates
 * all pending blocks for the session on next prompt submit.
 *
 * Authority and target are agent-side concerns and do NOT appear in the
 * switchboard annotation primitive.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { pickupFilePath, SECURE_DIR_MODE, SECURE_FILE_MODE, SWITCHBOARD_DIR } from '../paths.js';
import type {
  Annotation,
  DispatchOutcome,
  DispatchReport,
  Line,
  LineDraft,
} from '../types.js';
import { appendHistoryEvent } from '../audit/log.js';
import { copyToClipboard } from './clipboard.js';

export interface HandBackInput {
  drafts: LineDraft[];
  allLines: Line[];
  now?: number;
}

let ensured = false;
async function ensureDir(): Promise<void> {
  if (ensured) return;
  await mkdir(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  ensured = true;
}

export async function handBack(input: HandBackInput): Promise<DispatchReport> {
  const now = input.now ?? Date.now();
  const tasks: Promise<DispatchOutcome>[] = [];

  for (const draft of input.drafts) {
    const sourceLine = input.allLines.find((l) => l.id === draft.lineId);
    if (!sourceLine) continue;
    for (const annotation of draft.annotations) {
      tasks.push(dispatchToAgent(annotation, sourceLine, now));
    }
  }

  const outcomes = await Promise.all(tasks);

  for (const outcome of outcomes) {
    const sourceLine = findSourceForOutcome(outcome, input.drafts, input.allLines);
    await appendHistoryEvent({
      lineId: sourceLine?.id ?? '(unknown)',
      kind: outcome.ok ? 'dispatch' : 'dispatch_error',
      at: outcome.at,
      payload: {
        annotationId: outcome.annotationId,
        detail: outcome.detail,
      },
    });
  }

  for (const draft of input.drafts) {
    if (draft.annotations.length === 0) continue;
    await appendHistoryEvent({
      lineId: draft.lineId,
      kind: 'hand_back',
      at: new Date(now).toISOString(),
      payload: {
        bundleId: draft.bundleId,
        annotationCount: draft.annotations.length,
      },
    });
  }

  return summariseReport(outcomes, input.drafts);
}

async function dispatchToAgent(
  annotation: Annotation,
  sourceLine: Line,
  now: number
): Promise<DispatchOutcome> {
  const at = new Date(now).toISOString();
  try {
    await ensureDir();
    const bundleId = sourceLine.currentBundle?.id ?? `orphan-${now}`;
    const path = pickupFilePath(sourceLine.id, bundleId);
    const block = formatAnnotationForAgent(annotation, sourceLine.id);
    await appendFile(path, block, { encoding: 'utf8', mode: SECURE_FILE_MODE });
    // Clipboard fallback (defence-in-depth). Best-effort; failure is logged
    // in detail but does NOT fail the dispatch. Pickup file is the primary
    // sink; clipboard is the third.
    const clip = await copyToClipboard(block);
    const clipNote = clip.ok ? ` (clipboard: ${clip.tool})` : ` (clipboard: ${clip.detail})`;
    return {
      annotationId: annotation.id,
      ok: true,
      detail: `pickup ${path}${clipNote}`,
      at,
    };
  } catch (err) {
    return {
      annotationId: annotation.id,
      ok: false,
      detail: `dispatch failed: ${(err as Error).message}`,
      at,
    };
  }
}

function formatAnnotationForAgent(
  annotation: Annotation,
  lineId: string
): string {
  const lines: string[] = [];
  lines.push(`--- switchboard annotation (line ${lineId.slice(0, 8)}) ---`);
  if (annotation.anchor.kind === 'body_position') {
    const a = annotation.anchor;
    lines.push(
      a.lineEnd && a.lineEnd !== a.line
        ? `Anchor: body L${a.line}-${a.lineEnd}`
        : `Anchor: body L${a.line}`
    );
  } else {
    lines.push('Anchor: closing reply');
  }
  lines.push('');
  lines.push(annotation.content);
  lines.push('');
  return lines.join('\n');
}

function findSourceForOutcome(
  outcome: DispatchOutcome,
  drafts: LineDraft[],
  lines: Line[]
): Line | undefined {
  for (const draft of drafts) {
    if (draft.annotations.some((a) => a.id === outcome.annotationId)) {
      return lines.find((l) => l.id === draft.lineId);
    }
  }
  return undefined;
}

function summariseReport(outcomes: DispatchOutcome[], drafts: LineDraft[]): DispatchReport {
  let ok = 0;
  let fail = 0;
  for (const o of outcomes) {
    if (o.ok) ok += 1;
    else fail += 1;
  }
  const parts: string[] = [];
  if (ok > 0) parts.push(`${ok} dispatched`);
  if (fail > 0) parts.push(`${fail} failed`);
  const summary = parts.length > 0 ? parts.join(', ') : 'no dispatches';
  return {
    lineCount: drafts.length,
    annotationCount: outcomes.length,
    outcomes,
    summary,
  };
}
