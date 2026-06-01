/**
 * Substrate overlay (precedence + blocked render).
 *
 * Pure-function tests against `applySubstrateOverlay`. Adapter integration
 * tests (real ~/.switchboard/ scan + history-log append) are covered
 * implicitly via `tests/contracts.test.ts` substrate enumeration coverage
 * + this file's transition-event coverage.
 */

import { describe, it, expect } from 'vitest';
import { applySubstrateOverlay } from '../src/contracts/overlay.ts';
import type { ContractEmission, Line } from '../src/types.ts';

const SID = '11111111-2222-3333-4444-555555555555';

function makeLine(overrides: Partial<Line> = {}): Line {
  return {
    id: SID,
    title: 'Test line',
    projectPath: '/tmp/test',
    projectName: 'test',
    projectHash: 'test',
    transcriptPath: '/tmp/test.jsonl',
    state: 'ringing',
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastEventSummary: 'agent said something',
    currentBundle: null,
    deferral: null,
    capacitySignals: {
      queueDepth: 0,
      recentEventRate: 0,
      msSinceLastEvent: 100,
    },
    eventCount: 1,
    ...overrides,
  };
}

function makeBlockedEmission(
  mtimeMs: number,
  approvals = 0,
  calls = 0
): ContractEmission {
  return {
    kind: 'blocked-on-input',
    sessionId: SID,
    filename: `deferred-${SID}.json`,
    mtimeMs,
    payload: {
      calls: Array.from({ length: calls }, (_, i) => ({
        tool_name: 'Bash',
        tool_call_id: `c${i + 1}`,
      })),
      approvals: Array.from({ length: approvals }, (_, i) => ({
        tool_name: 'Edit',
        tool_call_id: `a${i + 1}`,
      })),
    },
  };
}

describe('applySubstrateOverlay (precedence + blocked render rule)', () => {
  it('blocked emission forces state=blocked', () => {
    const line = makeLine();
    const result = applySubstrateOverlay(
      line,
      [makeBlockedEmission(1000, 2, 0)],
      undefined
    );
    expect(result.line.state).toBe('blocked');
    expect(result.line.lastEventSummary).toBe('blocked: 2 tool approvals pending');
    expect(result.transitionedToBlocked).toBe(true);
    expect(result.transitionedFromBlocked).toBe(false);
  });

  it('row 1 -- singular pending renders as "1 tool approval pending"', () => {
    const line = makeLine();
    const result = applySubstrateOverlay(
      line,
      [makeBlockedEmission(1000, 1, 0)],
      undefined
    );
    expect(result.line.lastEventSummary).toBe('blocked: 1 tool approval pending');
  });

  it('row 1 -- empty approvals + empty calls renders generic blocked summary', () => {
    const line = makeLine();
    const result = applySubstrateOverlay(
      line,
      [makeBlockedEmission(1000, 0, 0)],
      undefined
    );
    expect(result.line.state).toBe('blocked');
    expect(result.line.lastEventSummary).toBe('blocked: agent emitted /blocked-on-input');
  });

  it('blocked emission takes precedence over ringing emission', () => {
    const line = makeLine({ state: 'ringing' });
    const ringing: ContractEmission = {
      kind: 'ringing',
      sessionId: SID,
      bundleId: 'bundle-1',
      filename: `pickup-${SID}-bundle-1.md`,
      mtimeMs: 2000,
      payload: null,
    };
    const result = applySubstrateOverlay(
      line,
      [ringing, makeBlockedEmission(1500, 1, 1)],
      undefined
    );
    expect(result.line.state).toBe('blocked');
  });

  it('row 3 -- no emissions leaves line state unchanged', () => {
    const line = makeLine({ state: 'in_progress', lastEventSummary: 'unchanged' });
    const result = applySubstrateOverlay(line, [], undefined);
    expect(result.line.state).toBe('in_progress');
    expect(result.line.lastEventSummary).toBe('unchanged');
    expect(result.transitionedToBlocked).toBe(false);
    expect(result.transitionedFromBlocked).toBe(false);
  });

  it('row 4 -- transitionedToBlocked false when mtime matches prior', () => {
    const line = makeLine();
    const result = applySubstrateOverlay(
      line,
      [makeBlockedEmission(5000, 1, 0)],
      5000
    );
    expect(result.line.state).toBe('blocked');
    expect(result.transitionedToBlocked).toBe(false);
  });

  it('row 4 -- transitionedToBlocked true when mtime differs (re-emission)', () => {
    const line = makeLine();
    const result = applySubstrateOverlay(
      line,
      [makeBlockedEmission(6000, 3, 0)],
      5000
    );
    expect(result.transitionedToBlocked).toBe(true);
  });

  it('row 5 -- transitionedFromBlocked fires once when emission disappears', () => {
    const line = makeLine({ state: 'ringing' });
    const result = applySubstrateOverlay(line, [], 5000);
    expect(result.transitionedFromBlocked).toBe(true);
    expect(result.line.state).toBe('ringing'); // unchanged from base
  });

  it('row 5 -- transitionedFromBlocked false when never previously blocked', () => {
    const line = makeLine();
    const result = applySubstrateOverlay(line, [], undefined);
    expect(result.transitionedFromBlocked).toBe(false);
  });
});
