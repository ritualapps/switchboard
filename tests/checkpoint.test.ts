/**
 * /checkpoint contract (RUNNING-zone enrichment).
 *
 * Covers: enumerator parses checkpoints-*.jsonl correctly; latest record
 * surfaces in `checkpointLatest`; overlay enriches `in_progress` /
 * `plugged_in` lines without changing zone; precedence (blocked > checkpoint
 * enrichment); skill executable appends correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateSwitchboardSubstrate, readCheckpointLatest } from '../src/contracts/enumerate.ts';
import { applySubstrateOverlay } from '../src/contracts/overlay.ts';
import type { ContractEmission, Line } from '../src/types.ts';

const SID = 'cccccccc-1111-2222-3333-444444444444';
const SCRIPT = join(__dirname, '..', 'skills', 'checkpoint', 'checkpoint.cjs');

function makeLine(state: Line['state']): Line {
  return {
    id: SID,
    title: 'Test line',
    projectPath: '/tmp/test',
    projectName: 'test',
    projectHash: 'test',
    transcriptPath: '/tmp/test.jsonl',
    state,
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastEventSummary: 'reducer-derived',
    currentBundle: null,
    deferral: null,
    capacitySignals: { queueDepth: 0, recentEventRate: 0, msSinceLastEvent: 100 },
    eventCount: 1,
  };
}

describe('checkpoint substrate (enrichment)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sb-checkpoint-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('readCheckpointLatest returns the most recent valid record', () => {
    const file = join(tmp, `checkpoints-${SID}.jsonl`);
    const lines = [
      JSON.stringify({ ts: '2026-01-01T10:00:00Z', message: 'first' }),
      JSON.stringify({ ts: '2026-01-01T11:00:00Z', message: 'second', milestoneIndex: 2, milestoneTotal: 5 }),
    ];
    writeFileSync(file, lines.join('\n') + '\n');
    const latest = readCheckpointLatest(file);
    expect(latest?.message).toBe('second');
    expect(latest?.milestoneIndex).toBe(2);
    expect(latest?.milestoneTotal).toBe(5);
  });

  it('readCheckpointLatest skips malformed trailing lines and falls back to last valid', () => {
    const file = join(tmp, `checkpoints-${SID}.jsonl`);
    const content = [
      JSON.stringify({ ts: 't1', message: 'good one' }),
      '{not json',
      '',
    ].join('\n');
    writeFileSync(file, content);
    const latest = readCheckpointLatest(file);
    expect(latest?.message).toBe('good one');
  });

  it('enumerator populates checkpointLatest for /checkpoint substrate', () => {
    const file = join(tmp, `checkpoints-${SID}.jsonl`);
    writeFileSync(file, JSON.stringify({ ts: 't1', message: 'hello' }) + '\n');
    const scan = enumerateSwitchboardSubstrate(tmp);
    const list = scan.bySession.get(SID)!;
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('checkpoint');
    expect(list[0]!.checkpointLatest?.message).toBe('hello');
  });

  it('overlay enriches in_progress line with checkpoint message', () => {
    const line = makeLine('in_progress');
    const emission: ContractEmission = {
      kind: 'checkpoint',
      sessionId: SID,
      filename: `checkpoints-${SID}.jsonl`,
      mtimeMs: 1000,
      payload: null,
      checkpointLatest: { ts: 't', message: 'types migration', milestoneIndex: 3, milestoneTotal: 5 },
    };
    const result = applySubstrateOverlay(line, [emission], undefined);
    expect(result.line.state).toBe('in_progress'); // zone unchanged
    expect(result.line.lastEventSummary).toBe('3/5 · types migration');
    expect(result.checkpointLatest?.message).toBe('types migration');
  });

  it('overlay enriches without milestone fraction when only message present', () => {
    const line = makeLine('plugged_in');
    const emission: ContractEmission = {
      kind: 'checkpoint',
      sessionId: SID,
      filename: `checkpoints-${SID}.jsonl`,
      mtimeMs: 1000,
      payload: null,
      checkpointLatest: { ts: 't', message: 'chapter 4 indexed' },
    };
    const result = applySubstrateOverlay(line, [emission], undefined);
    expect(result.line.lastEventSummary).toBe('chapter 4 indexed');
  });

  it('overlay does NOT enrich ringing or idle lines (RUNNING-only enrichment)', () => {
    const line = makeLine('ringing');
    const emission: ContractEmission = {
      kind: 'checkpoint',
      sessionId: SID,
      filename: `checkpoints-${SID}.jsonl`,
      mtimeMs: 1000,
      payload: null,
      checkpointLatest: { ts: 't', message: 'should not appear' },
    };
    const result = applySubstrateOverlay(line, [emission], undefined);
    expect(result.line.state).toBe('ringing');
    expect(result.line.lastEventSummary).toBe('reducer-derived');
  });

  it('blocked > checkpoint precedence: blocked wins, but checkpointLatest stays exposed', () => {
    const line = makeLine('in_progress');
    const blocked: ContractEmission = {
      kind: 'blocked-on-input',
      sessionId: SID,
      filename: `deferred-${SID}.json`,
      mtimeMs: 2000,
      payload: { approvals: [{ tool_name: 'Bash', tool_call_id: 't1' }] },
    };
    const cp: ContractEmission = {
      kind: 'checkpoint',
      sessionId: SID,
      filename: `checkpoints-${SID}.jsonl`,
      mtimeMs: 1500,
      payload: null,
      checkpointLatest: { ts: 't', message: 'mid-task' },
    };
    const result = applySubstrateOverlay(line, [blocked, cp], undefined);
    expect(result.line.state).toBe('blocked');
    expect(result.line.lastEventSummary).toBe('blocked: 1 tool approval pending');
    // checkpointLatest still carried through so drill-in can render the trail.
    expect(result.checkpointLatest?.message).toBe('mid-task');
  });
});

describe('/checkpoint reference implementation (skill executable)', () => {
  let homeDir: string;
  let checkpointsFile: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sb-checkpoint-skill-'));
    checkpointsFile = join(homeDir, '.switchboard', `checkpoints-${SID}.jsonl`);
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function run(args: string[], stdinPayload: string, extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      input: stdinPayload,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        ...extraEnv,
      },
      encoding: 'utf8',
    });
  }

  it('appends a record with ts auto-filled when absent', () => {
    const r = run(['--session-id', SID], JSON.stringify({ message: 'hello' }));
    expect(r.status).toBe(0);
    expect(existsSync(checkpointsFile)).toBe(true);
    const lines = readFileSync(checkpointsFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.message).toBe('hello');
    expect(typeof rec.ts).toBe('string');
    expect(new Date(rec.ts).toString()).not.toBe('Invalid Date');
  });

  it('preserves milestone fields when present', () => {
    const r = run(
      ['--session-id', SID],
      JSON.stringify({ ts: '2026-05-31T00:00:00Z', message: 'phase 3', milestoneIndex: 3, milestoneTotal: 5 })
    );
    expect(r.status).toBe(0);
    const rec = JSON.parse(readFileSync(checkpointsFile, 'utf8').trim());
    expect(rec.milestoneIndex).toBe(3);
    expect(rec.milestoneTotal).toBe(5);
  });

  it('rejects missing message with exit 1', () => {
    const r = run(['--session-id', SID], JSON.stringify({ ts: 't' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing or malformed|message/i);
  });

  it('rejects non-UUID session id', () => {
    const r = run(['--session-id', 'not-a-uuid'], JSON.stringify({ message: 'x' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a UUID/i);
  });

  it('appends successive records (preserves trail)', () => {
    run(['--session-id', SID], JSON.stringify({ message: 'first' }));
    run(['--session-id', SID], JSON.stringify({ message: 'second' }));
    const lines = readFileSync(checkpointsFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).message).toBe('first');
    expect(JSON.parse(lines[1]!).message).toBe('second');
  });
});
