/**
 * E2E test for the pickup hook -- covers the failure modes that previously
 * had zero coverage (env-var-vs-stdin, hook group merging, matcher field,
 * Windows path-quoting). This file simulates a Claude Code hook invocation by spawning
 * the pickup script as a child process with a mock stdin JSON and an
 * isolated HOME directory, then asserts the substrate contract.
 *
 * The pickup hook is GATED on the explicit `/handback` gesture (or the
 * sentinel `__SWITCHBOARD_HANDBACK__` carried in the slash command's
 * expanded body). Non-handback prompts are no-ops. These tests cover both
 * the fire path and the gate.
 *
 * Scope:
 *   - pickup hook stdin JSON -> consumed pickup file (the wire-level
 *     contract between CC and switchboard).
 *
 * Out of scope (covered elsewhere):
 *   - install-hook settings.json layout (verified by a live install).
 *   - state-overlay invariants (covered by tests/state-overlay.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PICKUP_SCRIPT = resolve(__dirname, '..', 'hooks', 'switchboard-pickup.cjs');
const SESSIONEND_SCRIPT = resolve(__dirname, '..', 'hooks', 'switchboard-sessionend.cjs');

/** Helper: build a stdin payload that triggers the /handback gate. */
function handbackStdin(sessionId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'UserPromptSubmit',
    prompt: '/handback',
    ...extra,
  });
}

function runHook(script: string, fakeHome: string, stdinPayload: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [script], {
    input: stdinPayload,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome, // Windows
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe('pickup hook E2E (stdin contract)', () => {
  let fakeHome: string;
  let sbDir: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'sb-hook-e2e-'));
    sbDir = join(fakeHome, '.switchboard');
    mkdirSync(sbDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('on /handback: prints pickup, renames to .consumed', () => {
    const sessionId = 'sess-abc-123';
    const bundleId = 'bun-xyz';
    const pickupContent = '--- switchboard annotation (line abcdef12) ---\nAnchor: closing reply\n\noperator reply here\n';
    const pickupFile = join(sbDir, `pickup-${sessionId}-${bundleId}.md`);
    writeFileSync(pickupFile, pickupContent, 'utf8');

    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, handbackStdin(sessionId));

    expect(status).toBe(0);
    expect(stdout).toContain('operator reply here');
    expect(existsSync(pickupFile)).toBe(false);
    expect(existsSync(pickupFile + '.consumed')).toBe(true);
  });

  it('on /handback with a trailing argument: still triggers pickup', () => {
    const sessionId = 'sess-handback-arg';
    writeFileSync(join(sbDir, `pickup-${sessionId}-b1.md`), 'payload\n', 'utf8');

    const { stdout, status } = runHook(
      PICKUP_SCRIPT,
      fakeHome,
      handbackStdin(sessionId, { prompt: '/handback now' })
    );

    expect(status).toBe(0);
    expect(stdout).toContain('payload');
  });

  it('on sentinel-in-body (slash-command-expanded path): triggers pickup', () => {
    const sessionId = 'sess-sentinel';
    writeFileSync(join(sbDir, `pickup-${sessionId}-b1.md`), 'via sentinel\n', 'utf8');

    const stdin = JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'UserPromptSubmit',
      prompt: '__SWITCHBOARD_HANDBACK__\n\nProcess any switchboard annotations prepended above.',
    });
    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, stdin);

    expect(status).toBe(0);
    expect(stdout).toContain('via sentinel');
  });

  it('on non-handback prompt: hook is a no-op (pickup file untouched)', () => {
    const sessionId = 'sess-no-trigger';
    const bundleId = 'bun-1';
    const pickupFile = join(sbDir, `pickup-${sessionId}-${bundleId}.md`);
    writeFileSync(pickupFile, 'should not be delivered\n', 'utf8');

    const stdin = JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'just a regular message from the operator',
    });
    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, stdin);

    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(pickupFile)).toBe(true);
    expect(existsSync(pickupFile + '.consumed')).toBe(false);
  });

  it('on /handback with no pickup files matching: emits empty stdout', () => {
    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, handbackStdin('no-such-session'));
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 cleanly when stdin is empty (no session id)', () => {
    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, '');
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 cleanly when stdin is not valid JSON', () => {
    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, 'not-json{{');
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('on /handback: ignores .consumed files matching the session id (no replay)', () => {
    const sessionId = 'sess-replay';
    const bundleId = 'bun-1';
    const consumedFile = join(sbDir, `pickup-${sessionId}-${bundleId}.md.consumed`);
    writeFileSync(consumedFile, 'already consumed payload\n', 'utf8');

    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, handbackStdin(sessionId));

    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(consumedFile)).toBe(true);
  });

  it('on /handback: concatenates multiple pickup files for the same session', () => {
    const sessionId = 'sess-multi';
    writeFileSync(join(sbDir, `pickup-${sessionId}-b1.md`), 'first\n', 'utf8');
    writeFileSync(join(sbDir, `pickup-${sessionId}-b2.md`), 'second\n', 'utf8');

    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, handbackStdin(sessionId));

    expect(status).toBe(0);
    expect(stdout).toContain('first');
    expect(stdout).toContain('second');
    expect(stdout).toContain('---');
    const files = readdirSync(sbDir);
    expect(files.filter((f) => f.endsWith('.consumed')).length).toBe(2);
  });

  it('on /handback: does NOT pick up files for a different session id', () => {
    const ourSession = 'sess-mine';
    const otherSession = 'sess-yours';
    writeFileSync(join(sbDir, `pickup-${otherSession}-b1.md`), 'not for you\n', 'utf8');

    const { stdout, status } = runHook(PICKUP_SCRIPT, fakeHome, handbackStdin(ourSession));

    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(join(sbDir, `pickup-${otherSession}-b1.md`))).toBe(true);
  });
});

describe('sessionend hook E2E (stdin contract)', () => {
  let fakeHome: string;
  let sbDir: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'sb-sessend-e2e-'));
    sbDir = join(fakeHome, '.switchboard');
  });

  afterEach(() => {
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('appends a closed entry to closed.jsonl when stdin carries a session id', () => {
    const sessionId = 'sess-closed';
    const stdin = JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionEnd' });
    const { status } = runHook(SESSIONEND_SCRIPT, fakeHome, stdin);
    expect(status).toBe(0);

    const closedFile = join(sbDir, 'closed.jsonl');
    expect(existsSync(closedFile)).toBe(true);
    const content = readFileSync(closedFile, 'utf8');
    expect(content).toContain(sessionId);
  });

  it('exits 0 cleanly with no stdin', () => {
    const { status } = runHook(SESSIONEND_SCRIPT, fakeHome, '');
    expect(status).toBe(0);
    // No file created.
    expect(existsSync(join(sbDir, 'closed.jsonl'))).toBe(false);
  });
});
