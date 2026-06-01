/**
 * Switchboard filesystem paths.
 *
 * State directory: ~/.switchboard/
 * Pickup files: ~/.switchboard/pickup-<sessionId>-<bundleId>.md
 * History log: ~/.switchboard/history.jsonl (per-line + cross-cutting events)
 *
 * Project hash decoding follows Claude Code's encoding convention:
 * `C:\Users\name` -> `C--Users-name`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const CLAUDE_DIR = join(HOME, '.claude');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
export const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');

export const SWITCHBOARD_DIR = join(HOME, '.switchboard');
export const HISTORY_FILE = join(SWITCHBOARD_DIR, 'history.jsonl');
export const DEFERRALS_FILE = join(SWITCHBOARD_DIR, 'deferrals.jsonl');

/**
 * Filesystem modes for switchboard state. Operator-only access -- pickup
 * files + dismissals + closed markers + drafts may contain prompt content
 * dispatched to agents. On POSIX, `0o700` dir + `0o600` files prevent other
 * local users on shared systems from reading. On Windows, modes are ignored
 * (NTFS ACLs apply); the constants are still passed but are no-ops.
 */
export const SECURE_DIR_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

export function pickupFilePath(sessionId: string, bundleId: string): string {
  return join(SWITCHBOARD_DIR, `pickup-${sessionId}-${bundleId}.md`);
}

/**
 * Emission protocol substrate paths.
 *
 * `deferredFilePath` -- canonical home for the `/blocked-on-input`
 * contract's payload (Pydantic AI DeferredToolRequests shape).
 *
 * `checkpointsFilePath` -- canonical home for the `/checkpoint` contract's
 * append-only emission stream, so contract authors can target one fixed
 * path.
 */
export function deferredFilePath(sessionId: string): string {
  return join(SWITCHBOARD_DIR, `deferred-${sessionId}.json`);
}

export function checkpointsFilePath(sessionId: string): string {
  return join(SWITCHBOARD_DIR, `checkpoints-${sessionId}.jsonl`);
}

export function decodeProjectHash(hash: string): string {
  const winMatch = /^([A-Za-z])--(.+)$/.exec(hash);
  if (winMatch) {
    const drive = winMatch[1]!.toUpperCase();
    const rest = winMatch[2]!.replace(/-/g, '\\');
    return `${drive}:\\${rest}`;
  }
  if (hash.startsWith('-')) {
    return hash.replace(/-/g, '/');
  }
  return hash;
}

export function projectLabel(hash: string): string {
  const decoded = decodeProjectHash(hash);
  const parts = decoded.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? decoded;
}
