import { describe, it, expect } from 'vitest';
import { _internal, reduceLineFromEvents } from '../src/claude-code/reducer.ts';

const { deriveState, computeCapacitySignals } = _internal;

function asstText(text: string, ts: string) {
  return {
    type: 'assistant' as const,
    raw: { message: { content: [{ type: 'text', text }] } },
    timestamp: ts,
  };
}
function asstToolUse(name: string, ts: string, id: string) {
  return {
    type: 'assistant' as const,
    raw: { message: { content: [{ type: 'tool_use', id, name, input: {} }] } },
    timestamp: ts,
  };
}
function userText(text: string, ts: string) {
  return {
    type: 'user' as const,
    raw: { message: { content: text } },
    timestamp: ts,
  };
}
function userToolResult(toolId: string, ts: string) {
  return {
    type: 'user' as const,
    raw: {
      message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] },
    },
    timestamp: ts,
  };
}

describe('reducer.deriveState', () => {
  it('returns idle for fewer than 2 events', () => {
    expect(deriveState([])).toBe('idle');
    expect(deriveState([userText('hi', '2026-05-17T00:00:00Z')])).toBe('idle');
  });

  it('returns ringing when assistant last spoke text to operator', () => {
    const events = [
      userText('do thing', '2026-05-17T00:00:00Z'),
      asstText('here is the result', '2026-05-17T00:00:01Z'),
    ];
    expect(deriveState(events)).toBe('ringing');
  });

  it('returns in_progress when assistant last issued a tool_use', () => {
    const events = [
      userText('do thing', '2026-05-17T00:00:00Z'),
      asstToolUse('Bash', '2026-05-17T00:00:01Z', 't1'),
    ];
    expect(deriveState(events)).toBe('in_progress');
  });

  it('returns in_progress after a tool_result (assistant about to respond)', () => {
    const events = [
      userText('do thing', '2026-05-17T00:00:00Z'),
      asstToolUse('Bash', '2026-05-17T00:00:01Z', 't1'),
      userToolResult('t1', '2026-05-17T00:00:02Z'),
    ];
    expect(deriveState(events)).toBe('in_progress');
  });

  it('returns in_progress after operator response (running again)', () => {
    const events = [
      asstText('first answer', '2026-05-17T00:00:00Z'),
      userText('do more', '2026-05-17T00:00:01Z'),
    ];
    expect(deriveState(events)).toBe('in_progress');
  });
});

describe('reducer.computeCapacitySignals', () => {
  it('counts pending tool_uses as queueDepth', () => {
    const events = [
      asstToolUse('Bash', '2026-05-17T00:00:00Z', 't1'),
      asstToolUse('Read', '2026-05-17T00:00:01Z', 't2'),
      userToolResult('t1', '2026-05-17T00:00:02Z'),
    ];
    const sig = computeCapacitySignals(events, Date.parse('2026-05-17T00:00:05Z'));
    expect(sig.queueDepth).toBe(1);
  });

  it('measures recentEventRate over the window', () => {
    const now = Date.parse('2026-05-17T00:05:00Z');
    const events = [
      asstText('a', '2026-05-17T00:04:00Z'),
      asstText('b', '2026-05-17T00:04:30Z'),
      asstText('c', '2026-05-17T00:04:45Z'),
    ];
    const sig = computeCapacitySignals(events, now);
    // 3 events in last 5 minutes -> 0.6 per minute
    expect(sig.recentEventRate).toBeCloseTo(0.6, 1);
  });
});

describe('reducer terminal-control sanitisation (H1 regression)', () => {
  it('strips escape sequences from title, body, and summary derived from transcript content', () => {
    // A hostile transcript: the user prompt sets an OSC clipboard-write, the
    // assistant body carries a CSI sequence + BEL. None may survive into the
    // rendered Line.
    const events = [
      userText('do thing\x1b]52;c;ZXZpbA==\x07', '2026-05-17T00:00:00Z'),
      asstText('result \x1b[31mred\x1b[0m text\x07', '2026-05-17T00:00:01Z'),
    ];
    const line = reduceLineFromEvents(events, {
      transcriptPath: '/tmp/s.jsonl',
      projectHash: 'C--Users-test',
      sessionId: '11111111-1111-1111-1111-111111111111',
      now: Date.parse('2026-05-17T00:00:05Z'),
    });
    expect(line).not.toBeNull();
    const blob = `${line!.title}\n${line!.lastEventSummary}\n${line!.currentBundle?.body ?? ''}`;
    expect(blob).not.toContain('\x1b');
    expect(blob).not.toContain('\x07');
    // Ordinary text content survives.
    expect(line!.currentBundle?.body).toContain('result');
    expect(line!.currentBundle?.body).toContain('red');
  });
});
