/**
 * Contracts registry + substrate enumeration.
 *
 * Unit-level coverage for the substrate poll, base-three registration,
 * precedence, and graceful absence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACTS,
  parseContractFilename,
  pickZoneDriver,
} from '../src/contracts/registry.ts';
import { enumerateSwitchboardSubstrate } from '../src/contracts/enumerate.ts';

describe('contracts registry (base three locked at V1 OSS)', () => {
  it('exports exactly the three base contracts', () => {
    const kinds = CONTRACTS.map((c) => c.kind).sort();
    expect(kinds).toEqual(['blocked-on-input', 'checkpoint', 'ringing']);
  });

  it('blocked-on-input has higher precedence than ringing', () => {
    const blocked = CONTRACTS.find((c) => c.kind === 'blocked-on-input')!;
    const ringing = CONTRACTS.find((c) => c.kind === 'ringing')!;
    expect(blocked.precedence).toBeGreaterThan(ringing.precedence);
  });

  it('checkpoint is enrichment-only (does not contend for zone)', () => {
    const checkpoint = CONTRACTS.find((c) => c.kind === 'checkpoint')!;
    expect(checkpoint.zone).toBe('enrichment');
  });
});

describe('parseContractFilename', () => {
  const SID = 'a1b2c3d4-e5f6-1234-5678-9abcdef01234';

  it('parses pickup-<uuid>-<bundleId>.md as ringing', () => {
    const out = parseContractFilename(`pickup-${SID}-bundle-1234567890.md`);
    expect(out).toEqual({
      kind: 'ringing',
      sessionId: SID,
      bundleId: 'bundle-1234567890',
    });
  });

  it('parses deferred-<uuid>.json as blocked-on-input', () => {
    const out = parseContractFilename(`deferred-${SID}.json`);
    expect(out).toEqual({
      kind: 'blocked-on-input',
      sessionId: SID,
    });
  });

  it('parses checkpoints-<uuid>.jsonl as checkpoint', () => {
    const out = parseContractFilename(`checkpoints-${SID}.jsonl`);
    expect(out).toEqual({
      kind: 'checkpoint',
      sessionId: SID,
    });
  });

  it('returns null for graceful absence (unknown contract)', () => {
    expect(parseContractFilename(`unknown-${SID}.json`)).toBeNull();
  });

  it('returns null when sessionId is not a uuid', () => {
    expect(parseContractFilename('deferred-not-a-uuid.json')).toBeNull();
    expect(parseContractFilename('pickup-12345-bundle.md')).toBeNull();
  });

  it('returns null for surface-owned files', () => {
    expect(parseContractFilename('history.jsonl')).toBeNull();
    expect(parseContractFilename('drafts.json')).toBeNull();
    expect(parseContractFilename('baseline.json')).toBeNull();
  });
});

describe('pickZoneDriver (precedence)', () => {
  it('picks blocked over ringing on the same session', () => {
    const result = pickZoneDriver([{ kind: 'ringing' }, { kind: 'blocked-on-input' }]);
    expect(result?.kind).toBe('blocked-on-input');
  });

  it('picks ringing when no blocked present', () => {
    const result = pickZoneDriver([{ kind: 'ringing' }, { kind: 'checkpoint' }]);
    expect(result?.kind).toBe('ringing');
  });

  it('returns null when only enrichment contracts present', () => {
    const result = pickZoneDriver([{ kind: 'checkpoint' }]);
    expect(result).toBeNull();
  });

  it('returns null on empty emission list', () => {
    expect(pickZoneDriver([])).toBeNull();
  });
});

describe('enumerateSwitchboardSubstrate (substrate poll)', () => {
  const SID_A = '11111111-2222-3333-4444-555555555555';
  const SID_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'switchboard-contracts-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty scan when dir does not exist', () => {
    const scan = enumerateSwitchboardSubstrate(join(tmpDir, 'nonexistent'));
    expect(scan.bySession.size).toBe(0);
    expect(scan.gracefulAbsenceFiles).toEqual([]);
  });

  it('groups emissions by sessionId', () => {
    writeFileSync(
      join(tmpDir, `deferred-${SID_A}.json`),
      JSON.stringify({ approvals: [], calls: [] })
    );
    writeFileSync(
      join(tmpDir, `pickup-${SID_A}-bundle-1.md`),
      '# question\n'
    );
    writeFileSync(
      join(tmpDir, `deferred-${SID_B}.json`),
      JSON.stringify({ approvals: [{ tool_name: 'Bash', tool_call_id: 't1' }] })
    );
    const scan = enumerateSwitchboardSubstrate(tmpDir);
    expect(scan.bySession.size).toBe(2);
    expect(scan.bySession.get(SID_A)?.map((e) => e.kind).sort()).toEqual([
      'blocked-on-input',
      'ringing',
    ]);
    const sidBList = scan.bySession.get(SID_B)!;
    expect(sidBList).toHaveLength(1);
    expect(sidBList[0]!.payload?.approvals).toHaveLength(1);
  });

  it('flags graceful-absence files but excludes surface-owned ones', () => {
    writeFileSync(join(tmpDir, `unknown-${SID_A}.json`), '{}');
    writeFileSync(join(tmpDir, 'history.jsonl'), '');
    writeFileSync(join(tmpDir, 'drafts.json'), '[]');
    const scan = enumerateSwitchboardSubstrate(tmpDir);
    expect(scan.gracefulAbsenceFiles).toContain(`unknown-${SID_A}.json`);
    expect(scan.gracefulAbsenceFiles).not.toContain('history.jsonl');
    expect(scan.gracefulAbsenceFiles).not.toContain('drafts.json');
  });

  it('treats malformed deferred-*.json as graceful absence', () => {
    writeFileSync(join(tmpDir, `deferred-${SID_A}.json`), '{not json');
    const scan = enumerateSwitchboardSubstrate(tmpDir);
    expect(scan.bySession.get(SID_A)).toBeUndefined();
    expect(scan.gracefulAbsenceFiles).toContain(`deferred-${SID_A}.json`);
  });

  it('sorts each session emissions newest-first by mtime', () => {
    const sub1 = join(tmpDir, `checkpoints-${SID_A}.jsonl`);
    writeFileSync(sub1, '{"ts":"t1"}\n');
    // Sleep is unreliable; use utimes to force ordering.
    const sub2 = join(tmpDir, `pickup-${SID_A}-bundle-1.md`);
    writeFileSync(sub2, '# body');
    const fs = require('node:fs');
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(sub1, past, past);
    fs.utimesSync(sub2, future, future);
    const list = enumerateSwitchboardSubstrate(tmpDir).bySession.get(SID_A)!;
    expect(list[0]!.kind).toBe('ringing');
    expect(list[1]!.kind).toBe('checkpoint');
  });

  it('passes deferred-*.json payload through (calls + approvals + metadata)', () => {
    const payload = {
      calls: [{ tool_name: 'Bash', tool_call_id: 'c1', args: { command: 'ls' } }],
      approvals: [{ tool_name: 'Edit', tool_call_id: 'a1' }],
      metadata: { c1: { note: 'context' } },
    };
    writeFileSync(join(tmpDir, `deferred-${SID_A}.json`), JSON.stringify(payload));
    const list = enumerateSwitchboardSubstrate(tmpDir).bySession.get(SID_A)!;
    const blocked = list.find((e) => e.kind === 'blocked-on-input')!;
    expect(blocked.payload?.calls).toHaveLength(1);
    expect(blocked.payload?.approvals).toHaveLength(1);
    expect(blocked.payload?.metadata?.c1).toEqual({ note: 'context' });
  });

  it('mkdirSync without creating directory still returns empty', () => {
    // No files in the dir at all.
    mkdirSync(join(tmpDir, 'empty'));
    const scan = enumerateSwitchboardSubstrate(join(tmpDir, 'empty'));
    expect(scan.bySession.size).toBe(0);
    expect(scan.gracefulAbsenceFiles).toEqual([]);
  });
});
