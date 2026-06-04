import { describe, it, expect } from 'vitest';
import {
  _internal,
  extractDisplayableFirstPrompt,
  reduceLineFromEvents,
} from '../src/claude-code/reducer.ts';

const { deriveState, computeCapacitySignals, stripCcCommandWrapper, firstPlausibleLine } =
  _internal;

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

describe('stripCcCommandWrapper', () => {
  it('extracts /cmd args from full wrapper', () => {
    const raw =
      '<command-message>new</command-message>\n' +
      '<command-name>/new</command-name>\n' +
      '<command-args>switchboard capturing and addressing bugs</command-args>';
    expect(stripCcCommandWrapper(raw)).toBe(
      '/new switchboard capturing and addressing bugs'
    );
  });

  it('extracts /cmd when <command-args> is empty', () => {
    const raw =
      '<command-message>new</command-message>\n' +
      '<command-name>/new</command-name>\n' +
      '<command-args></command-args>';
    expect(stripCcCommandWrapper(raw)).toBe('/new');
  });

  it('extracts /cmd when <command-args> tag is absent (Substrate Inventory finding)', () => {
    // Real shape observed at ~/.claude/projects/C--Users-melis--switchboard/
    // 74e542de-4d66-44db-8fef-e09df2262e79.jsonl: bare /new with no args
    // ends after </command-name> with no <command-args> tag at all.
    const raw =
      '<command-message>new</command-message>\n<command-name>/new</command-name>';
    expect(stripCcCommandWrapper(raw)).toBe('/new');
  });

  it('ignores trailing rendered command body after the wrapper', () => {
    const raw =
      '<command-message>build</command-message>\n' +
      '<command-name>/build</command-name>\n' +
      '<command-args>execute the plan</command-args>\n' +
      'You are executing a structured build session...';
    expect(stripCcCommandWrapper(raw)).toBe('/build execute the plan');
  });

  it('returns input unchanged when no wrapper present', () => {
    expect(stripCcCommandWrapper('plain prompt text')).toBe('plain prompt text');
  });

  it('does not match a wrapper that appears mid-prompt', () => {
    const raw = 'hello\n<command-message>x</command-message>';
    expect(stripCcCommandWrapper(raw)).toBe(raw);
  });

  it('trims whitespace from args', () => {
    const raw =
      '<command-message>x</command-message><command-name>/x</command-name>' +
      '<command-args>   padded args   </command-args>';
    expect(stripCcCommandWrapper(raw)).toBe('/x padded args');
  });
});

describe('firstPlausibleLine', () => {
  it('returns the first non-tag line', () => {
    expect(firstPlausibleLine('<tag>x</tag>\nactual question here')).toBe(
      'actual question here'
    );
  });

  it('skips multiple tag lines', () => {
    expect(
      firstPlausibleLine('<a>1</a>\n<b>2</b>\nfinally readable')
    ).toBe('finally readable');
  });

  it('extracts the first non-fence line from a fenced block', () => {
    // Better than null: when a user pastes code as their first message, the
    // inner content is more descriptive than the project+sessionId fallback.
    expect(firstPlausibleLine('```js\nconst x = 1;\n```')).toBe(
      'const x = 1;'
    );
  });

  it('returns null for a pure fence with no inner content', () => {
    expect(firstPlausibleLine('```\n```')).toBeNull();
  });

  it('extracts the first non-{[ line from JSON-ish input', () => {
    expect(firstPlausibleLine('{\n  "key": "value"\n}')).toBe('"key": "value"');
  });

  it('returns null for a single-line JSON object (no inner human line)', () => {
    expect(firstPlausibleLine('{"key":"value","other":42}')).toBeNull();
  });

  it('returns null when every line is structured', () => {
    expect(firstPlausibleLine('<a>1</a>\n<b>2</b>\n<c>3</c>')).toBeNull();
  });

  it('skips lines shorter than 3 chars', () => {
    expect(firstPlausibleLine('<x>y</x>\nok\nactually meaningful')).toBe(
      'actually meaningful'
    );
  });
});

describe('extractDisplayableFirstPrompt', () => {
  it('extracts /cmd args from CC wrapper (stage 1)', () => {
    const raw =
      '<command-message>new</command-message>\n' +
      '<command-name>/new</command-name>\n' +
      '<command-args>switchboard bugs</command-args>';
    expect(extractDisplayableFirstPrompt(raw)).toBe('/new switchboard bugs');
  });

  it('extracts /cmd from CC wrapper without args', () => {
    const raw =
      '<command-message>new</command-message>\n<command-name>/new</command-name>';
    expect(extractDisplayableFirstPrompt(raw)).toBe('/new');
  });

  it('extracts meaningful content from a code fence (stage 2)', () => {
    // The inner content is a better title than the project+sessionId fallback,
    // and it still gets singleLine'd + 80-sliced by sanitiseTitle downstream.
    expect(extractDisplayableFirstPrompt('```js\nconst x = 1;\n```')).toBe(
      'const x = 1;'
    );
  });

  it('returns null for single-line JSON with no inner human content (stage 2)', () => {
    expect(
      extractDisplayableFirstPrompt('{"key":"value","other":42}')
    ).toBeNull();
  });

  it('returns null for pure code fence with no inner content (stage 2)', () => {
    expect(extractDisplayableFirstPrompt('```\n```')).toBeNull();
  });

  it('extracts first plausible line from unknown XML wrapper (stage 2)', () => {
    expect(
      extractDisplayableFirstPrompt(
        '<future-tag>x</future-tag>\nactual question here'
      )
    ).toBe('actual question here');
  });

  it('returns plain text unchanged (stage 3)', () => {
    expect(
      extractDisplayableFirstPrompt('working on Cockpit build plan 6.?')
    ).toBe('working on Cockpit build plan 6.?');
  });

  it('returns multi-line plain text unchanged (sanitiseTitle handles collapse downstream)', () => {
    const raw = 'first line\nsecond line\nthird line';
    expect(extractDisplayableFirstPrompt(raw)).toBe(raw);
  });

  it('returns null for empty input', () => {
    expect(extractDisplayableFirstPrompt('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(extractDisplayableFirstPrompt('   \n\t  ')).toBeNull();
  });
});

describe('Line.title contract (boundary invariant)', () => {
  // Every reduceLineFromEvents output must produce a title that is:
  //   * non-empty
  //   * single line (no "\n" or "\r")
  //   * control-clean (no "\x1b" or "\x07")
  //   * <=80 chars
  //   * free of CC slash-command wrapper substrings
  // This regression net catches future input shapes that would otherwise
  // re-introduce the v1.0.0 title-leakage bug.
  function assertTitleContract(title: string) {
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).not.toContain('\n');
    expect(title).not.toContain('\r');
    expect(title).not.toContain('\x1b');
    expect(title).not.toContain('\x07');
    expect(title).not.toContain('<command-');
  }

  function baseInput() {
    return {
      transcriptPath: '/tmp/s.jsonl',
      projectHash: 'C--Users-test',
      sessionId: '11111111-1111-1111-1111-111111111111',
      now: Date.parse('2026-06-04T00:00:05Z'),
    };
  }

  it('case 1: first prompt is CC slash-command wrapper -> /cmd args', () => {
    const wrapped =
      '<command-message>new</command-message>\n' +
      '<command-name>/new</command-name>\n' +
      '<command-args>switchboard bugs</command-args>\n' +
      'Start a new session with project briefs and session contract.';
    const events = [userText(wrapped, '2026-06-04T00:00:00Z')];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    expect(line!.title).toBe('/new switchboard bugs');
  });

  it('case 2: bare CC wrapper without args tag -> /cmd', () => {
    const wrapped =
      '<command-message>new</command-message>\n<command-name>/new</command-name>';
    const events = [userText(wrapped, '2026-06-04T00:00:00Z')];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    expect(line!.title).toBe('/new');
  });

  it('case 3: multi-line plain first prompt -> single line title', () => {
    const events = [
      userText('first line\nsecond line\nthird line', '2026-06-04T00:00:00Z'),
    ];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    expect(line!.title).toBe('first line second line third line');
  });

  it('case 4: single-line JSON paste falls through to project + sessionId', () => {
    const events = [
      userText('{"key":"value","other":42}', '2026-06-04T00:00:00Z'),
    ];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    // No human line found inside a single-line JSON -> falls back.
    expect(line!.title).toContain('(');
    expect(line!.title).toContain(')');
  });

  it('case 5: customTitle with embedded newlines is collapsed', () => {
    const events = [
      userText('hi', '2026-06-04T00:00:00Z'),
      {
        type: 'custom-title' as const,
        raw: { type: 'custom-title', customTitle: 'a\nb\nc' },
        timestamp: '2026-06-04T00:00:01Z',
      },
    ];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    expect(line!.title).toBe('a b c');
  });

  it('case 6: aiTitle with terminal escape is stripped', () => {
    const events = [
      userText('hi', '2026-06-04T00:00:00Z'),
      {
        type: 'ai-title' as const,
        raw: {
          type: 'ai-title',
          aiTitle: 'evil\x1b]0;pwned\x07title',
        },
        timestamp: '2026-06-04T00:00:01Z',
      },
    ];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    expect(line!.title).toBe('eviltitle');
  });

  it('case 7: title priority preserved -- customTitle wins over aiTitle wins over first-prompt', () => {
    const events = [
      userText('the first prompt', '2026-06-04T00:00:00Z'),
      {
        type: 'ai-title' as const,
        raw: { type: 'ai-title', aiTitle: 'ai chose this' },
        timestamp: '2026-06-04T00:00:01Z',
      },
      {
        type: 'custom-title' as const,
        raw: { type: 'custom-title', customTitle: 'operator chose this' },
        timestamp: '2026-06-04T00:00:02Z',
      },
    ];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    expect(line!.title).toBe('operator chose this');
  });

  it('case 8: events with only tool_result content fall through to fallback', () => {
    const events = [userToolResult('t1', '2026-06-04T00:00:00Z')];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    expect(line!.title).toContain('(');
    expect(line!.title).toContain(')');
  });

  it('case 9: very long plain prompt is sliced with width-safe marker', () => {
    const events = [userText('a'.repeat(120), '2026-06-04T00:00:00Z')];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    expect(line!.title.length).toBe(80);
    expect(line!.title.endsWith('›')).toBe(true);
  });

  it('case 10: aiTitle overrides CC wrapper first-prompt (no leakage during ai-title window)', () => {
    const wrapped =
      '<command-message>new</command-message>\n<command-name>/new</command-name>';
    const events = [
      userText(wrapped, '2026-06-04T00:00:00Z'),
      {
        type: 'ai-title' as const,
        raw: { type: 'ai-title', aiTitle: 'Session about Switchboard bugs' },
        timestamp: '2026-06-04T00:00:01Z',
      },
    ];
    const line = reduceLineFromEvents(events, baseInput());
    expect(line).not.toBeNull();
    assertTitleContract(line!.title);
    expect(line!.title).toBe('Session about Switchboard bugs');
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
