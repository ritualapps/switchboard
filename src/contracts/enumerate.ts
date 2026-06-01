/**
 * Contract substrate enumeration.
 *
 * Walks `~/.switchboard/` and groups emissions by sessionId. Each
 * recognised file produces a `ContractEmission`; unrecognised files are
 * gracefully absent and surfaced to the caller via `gracefulAbsenceFiles`
 * so the adapter can log `contract_render_skipped` once per file per session
 * lifecycle.
 *
 * The walk is shallow (`~/.switchboard/` only -- no nested dirs); the
 * substrate convention is flat. Reads of structured payloads (currently
 * just `/blocked-on-input`) happen here because the payload determines
 * how the line renders. `/ringing` (markdown) and `/checkpoint` (jsonl)
 * stay lazy -- the adapter reads them on demand for the drill-in.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BlockedPayload, CheckpointEvent, ContractEmission } from '../types.js';
import { parseContractFilename } from './registry.js';

export interface SubstrateScan {
  /** sessionId -> emissions for that session, latest-first by mtimeMs. */
  bySession: Map<string, ContractEmission[]>;
  /** Files matching no registered contract (gracefully absent). */
  gracefulAbsenceFiles: string[];
}

const EMPTY_SCAN: SubstrateScan = {
  bySession: new Map(),
  gracefulAbsenceFiles: [],
};

export function enumerateSwitchboardSubstrate(dir: string): SubstrateScan {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return EMPTY_SCAN;
  }

  const bySession = new Map<string, ContractEmission[]>();
  const gracefulAbsenceFiles: string[] = [];

  for (const filename of entries) {
    const parsed = parseContractFilename(filename);
    if (!parsed) {
      // Only surface files that look like substrate (have a dash + json/md/jsonl
      // extension) to avoid logging history.jsonl / drafts.json / deferrals.jsonl
      // as graceful-absence -- those are the surface's own state, not contracts.
      if (looksLikeContractFilename(filename) && !isSurfaceOwnedFile(filename)) {
        gracefulAbsenceFiles.push(filename);
      }
      continue;
    }
    const fullPath = join(dir, filename);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }

    let payload: BlockedPayload | null = null;
    let checkpointLatest: CheckpointEvent | undefined;
    if (parsed.kind === 'blocked-on-input') {
      payload = readBlockedPayload(fullPath);
      if (payload === null) {
        // Unreadable / malformed -- skip but log via graceful absence.
        gracefulAbsenceFiles.push(filename);
        continue;
      }
    } else if (parsed.kind === 'checkpoint') {
      checkpointLatest = readCheckpointLatest(fullPath);
      // checkpoint files may be empty (legitimate idle state); don't graceful-
      // absence on parse failure of individual lines -- the latest valid
      // record is what we render. If the file is entirely unreadable or all
      // lines are malformed, checkpointLatest stays undefined and the cell
      // simply doesn't enrich.
    }

    const emission: ContractEmission = {
      kind: parsed.kind,
      sessionId: parsed.sessionId,
      filename,
      mtimeMs,
      payload,
    };
    if (parsed.bundleId !== undefined) emission.bundleId = parsed.bundleId;
    if (checkpointLatest) emission.checkpointLatest = checkpointLatest;

    const bucket = bySession.get(parsed.sessionId) ?? [];
    bucket.push(emission);
    bySession.set(parsed.sessionId, bucket);
  }

  // Sort each session's emissions newest-first so callers see latest first.
  for (const list of bySession.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  return { bySession, gracefulAbsenceFiles };
}

/**
 * Read the LATEST checkpoint event from a `/checkpoint` jsonl substrate.
 * Walks lines from the end of the file backwards and returns the first
 * parseable record (defence against partially-written or malformed lines).
 * Returns `undefined` when no parseable line exists.
 *
 * Reading the full file every poll is wasteful for long trails; this scans
 * lines on a single read but only validates from the tail. The drill-in
 * body renders the full trail on demand via a separate read.
 */
export function readCheckpointLatest(fullPath: string): CheckpointEvent | undefined {
  let raw: string;
  try {
    raw = readFileSync(fullPath, 'utf8');
  } catch {
    return undefined;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.ts !== 'string' || typeof obj.message !== 'string') continue;
      const ev: CheckpointEvent = {
        ts: obj.ts,
        message: obj.message,
      };
      if (typeof obj.milestoneIndex === 'number') ev.milestoneIndex = obj.milestoneIndex;
      if (typeof obj.milestoneTotal === 'number') ev.milestoneTotal = obj.milestoneTotal;
      return ev;
    } catch {
      continue;
    }
  }
  return undefined;
}

function readBlockedPayload(fullPath: string): BlockedPayload | null {
  try {
    const raw = readFileSync(fullPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const out: BlockedPayload = {};
    if (Array.isArray(obj.calls)) out.calls = obj.calls as BlockedPayload['calls'];
    if (Array.isArray(obj.approvals)) out.approvals = obj.approvals as BlockedPayload['approvals'];
    if (obj.metadata && typeof obj.metadata === 'object' && !Array.isArray(obj.metadata)) {
      out.metadata = obj.metadata as BlockedPayload['metadata'];
    }
    return out;
  } catch {
    return null;
  }
}

function looksLikeContractFilename(filename: string): boolean {
  // Cheap heuristic: contract files are `<kind>-<sessionId>...`. Surface-
  // owned files don't follow that shape (history.jsonl, drafts.json, etc.).
  return /^[a-z][a-z-]+-/.test(filename) && /\.(json|md|jsonl)$/.test(filename);
}

const SURFACE_OWNED_FILENAMES = new Set([
  'history.jsonl',
  'drafts.json',
  'dismissals.jsonl',
  'baseline.json',
  'deferrals.jsonl',
  'closed.jsonl',
]);

function isSurfaceOwnedFile(filename: string): boolean {
  return SURFACE_OWNED_FILENAMES.has(filename);
}
