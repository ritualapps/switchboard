/**
 * /blocked-on-input skill executable.
 *
 * Spawns the reference implementation as a child process to verify write
 * + clear behaviour, payload validation, and session-id resolution.
 *
 * The executable writes ~/.switchboard/deferred-<sessionId>.json. To keep
 * the test hermetic, the executable's home is redirected via the HOME /
 * USERPROFILE env vars to a tmpdir for the duration of each test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'skills', 'blocked-on-input', 'blocked-on-input.cjs');
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function run(args: string[], stdinPayload?: string, env: Record<string, string> = {}) {
  const isWin = process.platform === 'win32';
  const home = env.HOME ?? env.USERPROFILE ?? tmpdir();
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input: stdinPayload ?? '',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ...env,
    },
    encoding: 'utf8',
  });
}

describe('/blocked-on-input reference implementation', () => {
  let homeDir: string;
  let switchboardDir: string;
  let deferredFile: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sb-blocked-skill-'));
    switchboardDir = join(homeDir, '.switchboard');
    deferredFile = join(switchboardDir, `deferred-${SID}.json`);
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('writes deferred-<sessionId>.json from valid stdin payload', () => {
    const payload = {
      approvals: [{ tool_name: 'Bash', tool_call_id: 't1', args: { command: 'ls' } }],
    };
    const r = run(['--session-id', SID], JSON.stringify(payload), { HOME: homeDir });
    expect(r.status).toBe(0);
    expect(existsSync(deferredFile)).toBe(true);
    const written = JSON.parse(readFileSync(deferredFile, 'utf8'));
    expect(written.approvals).toHaveLength(1);
    expect(written.calls).toEqual([]);
    expect(written.metadata).toEqual({});
  });

  it('--clear removes the deferred file (idempotent)', () => {
    const fs = require('node:fs');
    fs.mkdirSync(switchboardDir, { recursive: true });
    writeFileSync(deferredFile, JSON.stringify({ approvals: [], calls: [] }));
    expect(existsSync(deferredFile)).toBe(true);
    const r = run(['--session-id', SID, '--clear'], '', { HOME: homeDir });
    expect(r.status).toBe(0);
    expect(existsSync(deferredFile)).toBe(false);
    // Idempotent: second clear on missing file is still status 0.
    const r2 = run(['--session-id', SID, '--clear'], '', { HOME: homeDir });
    expect(r2.status).toBe(0);
  });

  it('rejects missing session id with exit 1', () => {
    const r = run([], JSON.stringify({ approvals: [] }), {
      HOME: homeDir,
      CLAUDE_SESSION_ID: '',
      SWITCHBOARD_SESSION_ID: '',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/session id missing|not a UUID/i);
  });

  it('rejects non-UUID session id with exit 1', () => {
    const r = run(['--session-id', 'not-a-uuid'], JSON.stringify({ approvals: [] }), {
      HOME: homeDir,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a UUID/i);
  });

  it('rejects malformed stdin payload with exit 1', () => {
    const r = run(['--session-id', SID], '{not json', { HOME: homeDir });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/payload is not valid JSON/i);
  });

  it('reads CLAUDE_SESSION_ID env var as session id', () => {
    const r = run(
      [],
      JSON.stringify({ approvals: [{ tool_name: 'X', tool_call_id: 't1' }] }),
      { HOME: homeDir, CLAUDE_SESSION_ID: SID }
    );
    expect(r.status).toBe(0);
    expect(existsSync(deferredFile)).toBe(true);
  });

  it('empty stdin writes empty DeferredToolRequests', () => {
    const r = run(['--session-id', SID], '', { HOME: homeDir });
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(deferredFile, 'utf8'));
    expect(written).toEqual({ calls: [], approvals: [], metadata: {} });
  });
});
