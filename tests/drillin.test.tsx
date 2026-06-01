/**
 * DrillIn behaviour: single-path annotation commit plus the full annotation
 * lifecycle (add, edit, delete, cursor navigation).
 *
 * Tests the DrillIn flow against the running Ink tree via ink-testing-library.
 * Step state is owned by App; tests pass a step + setStep controlled-prop
 * pair, mirroring App's role.
 */

import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { DrillIn } from '../src/tui/DrillIn.tsx';
import type { Line, Annotation, LineDraft } from '../src/types.ts';

const OPEN_ANNOTATION = 'a';
const ENTER = '\r';
const DOWN = '\x1b[B';
const UP = '\x1b[A';

function makeLine(): Line {
  return {
    id: 'line-1',
    title: 'Test line',
    projectPath: '/tmp/test',
    projectName: 'test',
    projectHash: 'test',
    transcriptPath: '/tmp/test.jsonl',
    state: 'plugged_in',
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastEventSummary: 'agent posted body',
    currentBundle: {
      id: 'bundle-1',
      lineId: 'line-1',
      createdAt: new Date().toISOString(),
      body: 'first body line\nsecond body line\nthird body line',
      summary: 'sum',
    },
    deferral: null,
    capacitySignals: {
      queueDepth: 0,
      recentEventRate: 0,
      msSinceLastEvent: 100,
    },
    eventCount: 1,
  };
}

/** Test harness mirroring App's ownership of `step` + draft state. */
function DrillInHarness({
  onAdd,
  onUpdate,
  onDelete,
  onDisc,
  initialDraft = null,
}: {
  onAdd: (a: Annotation) => void;
  onUpdate: (i: number, content: string) => void;
  onDelete: (i: number) => void;
  onDisc: () => void;
  initialDraft?: LineDraft | null;
}) {
  const [step, setStep] = useState<'navigate' | 'content'>('navigate');
  const [draft, setDraft] = useState<LineDraft | null>(initialDraft);
  const wrappedAdd = (a: Annotation) => {
    setDraft((d) =>
      d
        ? { ...d, annotations: [...d.annotations, a] }
        : {
            lineId: 'line-1',
            bundleId: 'bundle-1',
            startedAt: new Date().toISOString(),
            annotations: [a],
          }
    );
    onAdd(a);
  };
  const wrappedUpdate = (i: number, content: string) => {
    setDraft((d) => {
      if (!d) return d;
      const next = d.annotations.slice();
      const prior = next[i];
      if (!prior) return d;
      next[i] = { ...prior, content };
      return { ...d, annotations: next };
    });
    onUpdate(i, content);
  };
  const wrappedDelete = (i: number) => {
    setDraft((d) => {
      if (!d) return d;
      const remaining = d.annotations.filter((_, idx) => idx !== i);
      return remaining.length === 0 ? null : { ...d, annotations: remaining };
    });
    onDelete(i);
  };
  return (
    <DrillIn
      line={makeLine()}
      draft={draft}
      step={step}
      setStep={setStep}
      onAddAnnotation={wrappedAdd}
      onUpdateAnnotation={wrappedUpdate}
      onDeleteAnnotation={wrappedDelete}
      onDisconnect={onDisc}
    />
  );
}

const tick = () => new Promise<void>((r) => setTimeout(r, 50));

describe('DrillIn: annotation input, commit flow, and lifecycle', () => {
  it("'a' on a body line opens the annotation input at the cursor", async () => {
    const { stdin, lastFrame } = render(
      <DrillInHarness onAdd={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onDisc={vi.fn()} />
    );
    await tick();
    expect(lastFrame()).not.toContain('annotate at L');
    stdin.write(OPEN_ANNOTATION);
    await tick();
    expect(lastFrame()).toContain('annotate at L1');
    expect(lastFrame()).toContain('first body line');
  });

  it('Enter commits the annotation directly, with no target or authority step', async () => {
    const onAdd = vi.fn();
    const { stdin, lastFrame } = render(
      <DrillInHarness onAdd={onAdd} onUpdate={vi.fn()} onDelete={vi.fn()} onDisc={vi.fn()} />
    );
    await tick();
    stdin.write(OPEN_ANNOTATION);
    await tick();
    stdin.write('reshape this');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onAdd).toHaveBeenCalledTimes(1);
    const ann = onAdd.mock.calls[0]![0] as Annotation;
    expect(ann.content).toBe('reshape this');
    expect(ann.anchor.kind).toBe('body_position');
    expect(Object.keys(ann).sort()).toEqual(['anchor', 'content', 'id']);
    expect(lastFrame()).not.toContain('target for');
    expect(lastFrame()).not.toContain('authority for');
  });

  it('shows no branching surfaces at any point in the commit flow', async () => {
    const { stdin, lastFrame } = render(
      <DrillInHarness onAdd={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onDisc={vi.fn()} />
    );
    await tick();
    stdin.write(OPEN_ANNOTATION);
    await tick();
    stdin.write('a directive');
    await tick();
    expect(lastFrame()).not.toContain('target for');
    expect(lastFrame()).not.toContain('authority for');
    expect(lastFrame()).not.toContain('autonomous');
    expect(lastFrame()).not.toContain('confirm_each_step');
  });

  // Surface-close (Esc / left-arrow) is verified at the App level in
  // tests/app.test.tsx -- App owns that routing.

  it('draft renders no STALE/stale markers regardless of bundle state', async () => {
    // staleAt is not part of the type. This guards against any future
    // surfacing of system-imposed staleness.
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-original',
      startedAt: new Date().toISOString(),
      annotations: [
        {
          id: 'a1',
          anchor: { kind: 'body_position', line: 1 },
          content: 'an annotation on a curated draft',
        },
      ],
    };
    const { lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('an annotation on a curated draft');
    expect(frame).not.toMatch(/stale/i);
  });

  it('cursor walks from the last body line into the draft annotations', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: [
        { id: 'a1', anchor: { kind: 'body_position', line: 1 }, content: 'first annotation' },
        { id: 'a2', anchor: { kind: 'body_position', line: 2 }, content: 'second annotation' },
      ],
    };
    const { stdin, lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    // Initial cursor on body L1. Down 3 times: body L1 -> L2 -> L3 -> annotation 0.
    // Each keystroke awaits a tick so React state lands in the closure for
    // the next useInput call.
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    // The footer hint should now reflect annotation-focus.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter edit');
    expect(frame).toContain('x delete');
  });

  it('Enter on a focused annotation pre-fills the content step for editing', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: [
        { id: 'a1', anchor: { kind: 'body_position', line: 1 }, content: 'original content' },
      ],
    };
    const onUpdate = vi.fn();
    const { stdin, lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    // Body has 3 lines; cursor starts on L1. Down 3 -> annotation 0.
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('edit annotation 1');
    expect(lastFrame()).toContain('original content');
    // Replace the content and commit.
    stdin.write(' (edited)');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0]).toBe(0);
    expect(onUpdate.mock.calls[0]![1]).toBe('original content (edited)');
  });

  it('x on a focused annotation deletes it with no confirmation', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: [
        { id: 'a1', anchor: { kind: 'body_position', line: 1 }, content: 'keep me' },
        { id: 'a2', anchor: { kind: 'body_position', line: 2 }, content: 'delete me' },
      ],
    };
    const onDelete = vi.fn();
    const { stdin } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={onDelete}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    // Cursor to annotation 1 (the second one).
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick(); // annotation 0
    stdin.write(DOWN); await tick(); // annotation 1
    stdin.write('x');
    await tick();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]![0]).toBe(1);
  });

  it('up-arrow on annotation 0 returns to the last body line', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: [
        { id: 'a1', anchor: { kind: 'body_position', line: 1 }, content: 'only annotation' },
      ],
    };
    const { stdin, lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick(); // annotation 0
    expect(lastFrame()).toContain('Enter edit');
    stdin.write(UP); // back to last body line
    await tick();
    // Body-cursor hint set should now show /a annotate (not Enter edit).
    const frame = lastFrame() ?? '';
    expect(frame).toContain('annotate');
    expect(frame).not.toContain('Enter edit');
  });

  it('strips leading blank lines in the body so L1 shows the first content line', async () => {
    // Body has 2 leading blank lines + content. Without trim, viewport
    // would show L1 = blank, L2 = blank, L3 = first content -- which the
    // operator reads as "starts at L3". After trim, L1 shows the content.
    const lineWithLeadingBlanks: Line = {
      ...makeLine(),
      currentBundle: {
        id: 'bundle-1',
        lineId: 'line-1',
        createdAt: new Date().toISOString(),
        body: '\n\nfirst real content line\nsecond real content line\nthird real content line',
        summary: 'sum',
      },
    };
    const { lastFrame } = render(
      <DrillIn
        line={lineWithLeadingBlanks}
        draft={null}
        step="navigate"
        setStep={() => {}}
        onAddAnnotation={vi.fn()}
        onUpdateAnnotation={vi.fn()}
        onDeleteAnnotation={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );
    await tick();
    const frame = lastFrame() ?? '';
    // L1 should be the FIRST CONTENT line, not blank.
    expect(frame).toMatch(/L1\s+first real content line/);
    // Should NOT show an "above" indicator -- nothing trimmed by viewport
    // (only by leading-blank trim).
    expect(frame).not.toMatch(/lines? above/);
  });

  it('q in the navigate step disconnects', async () => {
    const onDisc = vi.fn();
    const { stdin } = render(
      <DrillInHarness onAdd={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onDisc={onDisc} />
    );
    await tick();
    stdin.write('q');
    await tick();
    expect(onDisc).toHaveBeenCalledTimes(1);
  });

  /**
   * When two annotations share an anchor (e.g. both at body L21, one long
   * and one short), editing the focused row must load that row's own
   * content into the buffer, not the other row's. This test walks the
   * cursor to annotation index 0 and asserts the loaded buffer matches
   * annotations[0].content, pinning positional correctness between display
   * and edit-load.
   */
  it('ANNOTATION_IDENTITY: edit-load on index 0 matches annotations[0] when two share an anchor', async () => {
    const LONG = 'this is a long annotation typed first at L1';
    const SHORT = 'short';
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: [
        { id: 'long-id', anchor: { kind: 'body_position', line: 1 }, content: LONG },
        { id: 'short-id', anchor: { kind: 'body_position', line: 1 }, content: SHORT },
      ],
    };
    const { stdin, lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    // Body in makeLine() is 3 lines (L1, L2, L3). Initial cursor on L1.
    // Sequence to reach annotation index 0:
    //   DOWN 1: L1 -> L2
    //   DOWN 2: L2 -> L3 (last body line)
    //   DOWN 3: L3 -> annotation index 0
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    // Press Enter to open the focused annotation for edit.
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    // The edit-mode anchor label should show "edit annotation 1" (1-indexed
    // for the operator).
    expect(frame, `frame:\n${frame}`).toContain('edit annotation 1');
    // CRITICAL: the buffer should be pre-filled with the LONG content
    // (annotations[0]). If this fails, the code-level swap is real.
    expect(frame, `frame:\n${frame}`).toContain(LONG);
  });

  /**
   * Companion: cursor onto annotation index 1 should load the SHORT content.
   * Together with the above, this pins positional correctness from both
   * sides -- index 0 -> LONG, index 1 -> SHORT.
   */
  it('ANNOTATION_IDENTITY: edit-load on index 1 matches annotations[1] when two share an anchor', async () => {
    const LONG = 'this is a long annotation typed first at L1';
    const SHORT = 'short';
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: [
        { id: 'long-id', anchor: { kind: 'body_position', line: 1 }, content: LONG },
        { id: 'short-id', anchor: { kind: 'body_position', line: 1 }, content: SHORT },
      ],
    };
    const { stdin, lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    // Sequence to reach annotation index 1:
    //   DOWN 1: L1 -> L2
    //   DOWN 2: L2 -> L3
    //   DOWN 3: L3 -> annotation index 0
    //   DOWN 4: annotation index 0 -> annotation index 1
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(ENTER);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame, `frame:\n${frame}`).toContain('edit annotation 2');
    expect(frame, `frame:\n${frame}`).toContain(SHORT);
    // And the LONG should NOT appear in the buffer area; it may still appear
    // in the draft list (the focused row leaves it as-is). We only check
    // that the input row contains SHORT, not that LONG is absent overall.
  });

  /**
   * Annotation viewport: the annotation pane caps at 5 rendered rows.
   * When N > 5, the pane scrolls within its fixed height and surfaces
   * above/below indicators, mirroring the body viewport pattern. The
   * cursor index walks 0..N-1 unchanged; only the display is windowed.
   */
  function makeAnnotations(n: number): Annotation[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `ann-${i}`,
      anchor: { kind: 'body_position' as const, line: i + 1 },
      content: `annotation #${i + 1} content`,
    }));
  }

  it('annotation viewport: N=5 -- all annotations visible, no above/below indicators', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: makeAnnotations(5),
    };
    const { lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    const frame = lastFrame() ?? '';
    for (let i = 1; i <= 5; i++) {
      expect(frame, `expected ordinal ${i}. in frame`).toMatch(new RegExp(`${i}\\.\\s+L${i}`));
    }
    expect(frame).not.toMatch(/\d+\s+above/);
    expect(frame).not.toMatch(/\d+\s+below/);
  });

  it('annotation viewport: N=6 cursor on idx 0 -- top 5 visible + below indicator', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: makeAnnotations(6),
    };
    const { stdin, lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    // 3 DOWNs: L1 -> L2 -> L3 -> annotation idx 0
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    stdin.write(DOWN); await tick();
    const frame = lastFrame() ?? '';
    // Top 5 ordinals visible.
    for (let i = 1; i <= 5; i++) {
      expect(frame).toMatch(new RegExp(`${i}\\.\\s+L${i}`));
    }
    // Annotation 6 hidden; below indicator surfaces.
    expect(frame).not.toMatch(/6\.\s+L6/);
    expect(frame).toMatch(/↓\s+1\s+below/);
    expect(frame).not.toMatch(/\d+\s+above/);
  });

  it('annotation viewport: N=8 cursor on idx 4 (middle) -- both indicators surface', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: makeAnnotations(8),
    };
    const { stdin, lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    // 3 DOWNs -> annotation idx 0, then 4 more -> annotation idx 4.
    for (let i = 0; i < 7; i++) {
      stdin.write(DOWN);
      await tick();
    }
    const frame = lastFrame() ?? '';
    // Anchor on idx 4 (1-indexed: 5.) -- half=2 -> visible window starts at idx 2 (3.) and ends at idx 6 (7.).
    // Above hidden: 2; below hidden: 1.
    expect(frame, `frame:\n${frame}`).toMatch(/↑\s+2\s+above/);
    expect(frame, `frame:\n${frame}`).toMatch(/↓\s+1\s+below/);
    // Visible band 3./4./5./6./7.
    expect(frame).toMatch(/3\.\s+L3/);
    expect(frame).toMatch(/7\.\s+L7/);
    // 1./2./8. should be hidden.
    expect(frame).not.toMatch(/1\.\s+L1/);
    expect(frame).not.toMatch(/8\.\s+L8/);
  });

  it('annotation viewport: N=8 cursor on idx 7 (last) -- above-only indicator', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: makeAnnotations(8),
    };
    const { stdin, lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    // 3 + 7 = 10 DOWNs -> annotation idx 7 (last).
    for (let i = 0; i < 10; i++) {
      stdin.write(DOWN);
      await tick();
    }
    const frame = lastFrame() ?? '';
    // Bottom 5 visible: ordinals 4./5./6./7./8.
    for (let i = 4; i <= 8; i++) {
      expect(frame).toMatch(new RegExp(`${i}\\.\\s+L${i}`));
    }
    // 1./2./3. hidden; above indicator surfaces; below is absent.
    expect(frame).not.toMatch(/3\.\s+L3/);
    expect(frame).toMatch(/↑\s+3\s+above/);
    expect(frame).not.toMatch(/\d+\s+below/);
  });

  /**
   * Body viewport emit invariant: when the body has more lines than
   * viewportRows, the body section's TOTAL emitted rows (data plus
   * indicators) must not exceed viewportRows. Otherwise the body overflows
   * its budget, Yoga clips the adjacent annotation pane, and fewer than 5
   * annotations show. This locks the cap so future refactors can't
   * reintroduce overflow.
   */
  it('BODY_VIEWPORT_TOTAL_EMIT_INVARIANT: long body emit count <= viewportRows when scrolling', async () => {
    // 50-line body, viewport via prop = 10. Expect: <= 10 emitted lines
    // for the body section (data + above/below indicators combined).
    const longBodyLine = (linesCount: number): Line => ({
      ...makeLine(),
      currentBundle: {
        ...makeLine().currentBundle!,
        body: Array.from({ length: linesCount }, (_, i) => `body line ${i + 1}`).join('\n'),
      },
    });
    function HarnessFixedViewport({ line }: { line: Line }) {
      const [step, setStep] = useState<'navigate' | 'content'>('navigate');
      return (
        <DrillIn
          line={line}
          draft={null}
          step={step}
          setStep={setStep}
          onAddAnnotation={vi.fn()}
          onUpdateAnnotation={vi.fn()}
          onDeleteAnnotation={vi.fn()}
          onDisconnect={vi.fn()}
          maxBodyViewport={10}
        />
      );
    }
    const { stdin, lastFrame } = render(<HarnessFixedViewport line={longBodyLine(50)} />);
    await tick();
    // Walk cursor to middle so both indicators appear.
    for (let i = 0; i < 20; i++) {
      stdin.write(DOWN);
      await tick();
    }
    const frame = lastFrame() ?? '';
    // Count the emitted body section: from "── body" label to next blank
    // line or section boundary.
    const bodyStartIdx = frame.indexOf('── body');
    expect(bodyStartIdx, 'body label not found').toBeGreaterThanOrEqual(0);
    const afterLabel = frame.slice(bodyStartIdx).split('\n').slice(1); // skip label line
    // Body section ends at the next blank-content row or the footer / draft.
    const bodyRows: string[] = [];
    for (const ln of afterLabel) {
      const stripped = ln.replace(/\x1b\[[0-9;]*m/g, '').trim();
      // Stop at footer hint line or empty boundary; body rows match L\d+ or indicator arrows.
      if (/L\d+/.test(stripped) || /^[↑↓]\s*\d+\s+line/.test(stripped)) {
        bodyRows.push(stripped);
      } else if (bodyRows.length > 0) {
        break; // section ended
      }
    }
    expect(
      bodyRows.length,
      `body emit count = ${bodyRows.length}, expected <= 10. emitted:\n${bodyRows.join('\n')}`
    ).toBeLessThanOrEqual(10);
  });

  /**
   * Ordinal label invariant: each DraftRow must render a visible ordinal
   * `N.` so the operator can unambiguously distinguish annotations that
   * share an anchor. Without the ordinal, two annotations both labelled
   * `L21` are visually identical apart from content and the `▸` cursor
   * indicator, and it is easy to misread which row the cursor is on.
   */
  it('ORDINAL_LABEL_INVARIANT: every draft row shows its 1-indexed ordinal', async () => {
    const draft: LineDraft = {
      lineId: 'line-1',
      bundleId: 'bundle-1',
      startedAt: new Date().toISOString(),
      annotations: [
        { id: 'a1', anchor: { kind: 'body_position', line: 1 }, content: 'first' },
        { id: 'a2', anchor: { kind: 'body_position', line: 1 }, content: 'second' },
        { id: 'a3', anchor: { kind: 'body_position', line: 2 }, content: 'third' },
      ],
    };
    const { lastFrame } = render(
      <DrillInHarness
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onDisc={vi.fn()}
        initialDraft={draft}
      />
    );
    await tick();
    const frame = lastFrame() ?? '';
    // Each ordinal appears alongside its annotation's content row.
    expect(frame, `frame:\n${frame}`).toMatch(/1\.\s+L1\s+first/);
    expect(frame, `frame:\n${frame}`).toMatch(/2\.\s+L1\s+second/);
    expect(frame, `frame:\n${frame}`).toMatch(/3\.\s+L2\s+third/);
  });
});
