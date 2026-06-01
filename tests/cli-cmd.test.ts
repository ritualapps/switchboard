/**
 * `switchboard cmd <N>` shell subcommand.
 *
 * Spawns the cli.ts via tsx so we exercise the real subcommand path. The
 * adapter reads from ~/.claude/projects via CLAUDE_PROJECTS_DIR (resolved
 * from HOME); we redirect HOME / USERPROFILE to a tmpdir so the test is
 * hermetic.
 *
 * Coverage:
 *   - invalid arg -> exit 1 with usage
 *   - out-of-range arg -> exit 1 with message
 *   - no matching slot -> exit 1 with message
 *   - matching slot -> exit 0 + stdout `claude --resume <session-id>`
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityForSession } from '../src/tui/identity.ts';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

function runCli(args: string[], homeDir: string) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI, ...args],
    {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
}

/**
 * Write a minimal CC-shaped session JSONL so the adapter's scan picks up
 * one session in slot N. We pick session IDs whose FNV-1a hash mod 9 lands
 * on the desired slot via brute-force search up front.
 */
function findSessionIdForSlot(targetSlot: number): string {
  // 32-char hex stem, with UUID-style dashes inserted.
  const hex = '0123456789abcdef';
  let counter = 0;
  while (true) {
    const stem = counter.toString(16).padStart(32, '0');
    const id = `${stem.slice(0, 8)}-${stem.slice(8, 12)}-${stem.slice(12, 16)}-${stem.slice(16, 20)}-${stem.slice(20, 32)}`;
    if (identityForSession(id).slot === targetSlot) return id;
    counter++;
    if (counter > 10_000) throw new Error(`could not find session id for slot ${targetSlot}`);
  }
}

function writeMinimalSession(claudeProjectsDir: string, sessionId: string): void {
  const projectDir = join(claudeProjectsDir, 'C--Users-melis-test');
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${sessionId}.jsonl`);
  // Two events: a permission-mode header and an assistant text block to
  // mark the session as ringing (so it surfaces past the baseline).
  const events = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello operator' }],
      },
      uuid: 'u1',
      sessionId,
      timestamp: new Date().toISOString(),
    }),
  ];
  writeFileSync(file, events.join('\n') + '\n');
}

function writeBaselineFile(home: string): void {
  const switchboardDir = join(home, '.switchboard');
  mkdirSync(switchboardDir, { recursive: true });
  // Baseline of 0 means every session passes; we want sessions written AFTER
  // baseline to surface (the file mtime is "now", baseline at = 0).
  writeFileSync(
    join(switchboardDir, 'baseline.json'),
    JSON.stringify({ at: new Date(0).toISOString() }) + '\n'
  );
}

describe('switchboard cmd <N>', () => {
  let homeDir: string;
  let claudeProjectsDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sb-cli-cmd-'));
    claudeProjectsDir = join(homeDir, '.claude', 'projects');
    mkdirSync(claudeProjectsDir, { recursive: true });
    writeBaselineFile(homeDir);
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  // CLI smoke tests check stderr content (not status code) for
  // the error-exit paths because tsx's loader + Node's process.exit
  // interplay on Windows occasionally produces a quirky exit code
  // (0xC000013A) even when the script printed the right message. Stderr
  // content is the reliable signal that the cli reached the intended
  // branch.

  it('with no argument: prints usage to stderr', () => {
    const r = runCli(['cmd'], homeDir);
    expect(r.stderr).toMatch(/Usage:.*switchboard cmd <N>/);
  });

  it('with non-integer slot: prints range error', () => {
    const r = runCli(['cmd', 'five'], homeDir);
    expect(r.stderr).toMatch(/slot must be an integer 1-9/);
  });

  it('with slot 0: prints range error', () => {
    const r = runCli(['cmd', '0'], homeDir);
    expect(r.stderr).toMatch(/slot must be an integer 1-9/);
  });

  it('with slot 10: prints range error', () => {
    const r = runCli(['cmd', '10'], homeDir);
    expect(r.stderr).toMatch(/slot must be an integer 1-9/);
  });

  it('with no live session in slot: prints "no live session" message', () => {
    const r = runCli(['cmd', '5'], homeDir);
    expect(r.stderr).toMatch(/no live session in slot 5/);
  });

  it('with live session matching slot: prints `claude --resume <session-id>`', () => {
    const sessionId = findSessionIdForSlot(3);
    writeMinimalSession(claudeProjectsDir, sessionId);
    const r = runCli(['cmd', '3'], homeDir);
    expect(r.stdout.trim()).toBe(`claude --resume ${sessionId}`);
    expect(r.status).toBe(0);
  });

  // Security regression: a session id originates as a transcript filename
  // stem, which any local process can name. If a non-UUID id reached the
  // printed `claude --resume <id>` string, the documented shell use of that
  // output would execute embedded command substitution. `cmd` must refuse
  // any id that is not a clean UUID.
  it('refuses to emit a resume command for a non-UUID (command-injection) session id', () => {
    const maliciousId = 'evil$(touch pwned)';
    // The slot is keyed on the id hash regardless of id shape, so the hostile
    // session still claims a slot. Query exactly that slot.
    const slot = identityForSession(maliciousId).slot;
    writeMinimalSession(claudeProjectsDir, maliciousId);
    const r = runCli(['cmd', String(slot)], homeDir);
    // The injection payload must never appear in a resume command on stdout.
    expect(r.stdout).not.toContain('claude --resume');
    expect(r.stdout).not.toContain('$(touch pwned)');
    // And the operator gets a clear refusal, not a silent success.
    expect(r.stderr).toMatch(/refusing to emit|unexpected id/);
  });
});
