import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { handBack } from '../src/dispatch/dispatcher.ts';
import { pickupFilePath } from '../src/paths.ts';
import type { Line, LineDraft, Annotation } from '../src/types.ts';

// Note: handBack writes pickup files to ~/.switchboard/ (real). Per the
// pickup-file convention, files use random session ids so there's no risk
// of CC picking them up. Tests here verify the outcome contract; the
// on-disk effect is integration territory.

function makeLine(id: string, name: string): Line {
  return {
    id,
    title: `${name} line`,
    projectPath: '/tmp/' + name,
    projectName: name,
    projectHash: name,
    transcriptPath: '/tmp/' + name + '.jsonl',
    state: 'ringing',
    startedAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    lastEventSummary: 'test',
    currentBundle: {
      id: 'bundle-' + id,
      lineId: id,
      createdAt: new Date().toISOString(),
      body: 'body',
      summary: 'sum',
    },
    deferral: null,
    capacitySignals: {
      queueDepth: 0,
      recentEventRate: 0,
      msSinceLastEvent: 1000,
    },
    eventCount: 2,
  };
}

function annot(id: string, content = 'x'): Annotation {
  return {
    id,
    anchor: { kind: 'closing' },
    content,
  };
}

describe('handBack dispatcher (single-target per-line)', () => {
  it('returns empty report for no drafts', async () => {
    const report = await handBack({ drafts: [], allLines: [] });
    expect(report.annotationCount).toBe(0);
    expect(report.lineCount).toBe(0);
    expect(report.summary).toBe('no dispatches');
  });

  it('writes one pickup file block per annotation, returning ok outcomes', async () => {
    const line = makeLine('line1', 'projA');
    const draft: LineDraft = {
      lineId: 'line1',
      bundleId: 'bundle-line1',
      startedAt: new Date().toISOString(),
      annotations: [
        annot('a1', 'first directive'),
        annot('a2', 'second directive'),
      ],
    };
    const report = await handBack({ drafts: [draft], allLines: [line] });
    expect(report.annotationCount).toBe(2);
    expect(report.lineCount).toBe(1);
    expect(report.outcomes.every((o) => o.ok)).toBe(true);
    expect(report.outcomes[0]?.detail).toContain('pickup');
    expect(report.outcomes[1]?.detail).toContain('pickup');
    expect(report.summary).toBe('2 dispatched');
  });

  it('dispatches multiple drafts across multiple lines independently', async () => {
    const a = makeLine('line-a', 'projA');
    const b = makeLine('line-b', 'projB');
    const drafts: LineDraft[] = [
      {
        lineId: 'line-a',
        bundleId: 'bundle-line-a',
        startedAt: new Date().toISOString(),
        annotations: [annot('a1', 'for A')],
      },
      {
        lineId: 'line-b',
        bundleId: 'bundle-line-b',
        startedAt: new Date().toISOString(),
        annotations: [annot('b1', 'for B')],
      },
    ];
    const report = await handBack({ drafts, allLines: [a, b] });
    expect(report.annotationCount).toBe(2);
    expect(report.lineCount).toBe(2);
    expect(report.outcomes.every((o) => o.ok)).toBe(true);
    // Each outcome's pickup path embeds the source line id, proving the
    // single-target per-line discipline (no cross-fan-out).
    const aOutcome = report.outcomes.find((o) => o.annotationId === 'a1');
    const bOutcome = report.outcomes.find((o) => o.annotationId === 'b1');
    expect(aOutcome?.detail).toContain('line-a');
    expect(bOutcome?.detail).toContain('line-b');
  });

  it('skips drafts whose source line is no longer on the board', async () => {
    const draft: LineDraft = {
      lineId: 'ghost-line',
      bundleId: 'bundle-ghost',
      startedAt: new Date().toISOString(),
      annotations: [annot('a1')],
    };
    const report = await handBack({ drafts: [draft], allLines: [] });
    expect(report.annotationCount).toBe(0);
    expect(report.lineCount).toBe(1);
  });

  it('handback never emits the legacy "authored against an earlier bundle" NOTE (factual-correctness guard; staleness primitive removed)', async () => {
    // The staleness mechanism was removed; LineDraft no longer carries
    // staleAt/staleBundleId. The dispatcher must never emit the old
    // per-annotation stale NOTE under any path. This guard prevents that
    // factually incorrect NOTE from sneaking back in.
    const line = makeLine('line-curated', 'projCurated');
    const draft: LineDraft = {
      lineId: 'line-curated',
      bundleId: 'bundle-original',
      startedAt: new Date().toISOString(),
      annotations: [annot('s1', 'directive on a curated draft')],
    };
    const report = await handBack({ drafts: [draft], allLines: [line] });
    expect(report.outcomes.every((o) => o.ok)).toBe(true);

    const pickupPath = pickupFilePath(line.id, line.currentBundle!.id);
    const contents = await readFile(pickupPath, 'utf8');
    expect(contents).not.toContain('authored against an earlier bundle');
    expect(contents).not.toContain('treat the anchor as approximate');
    expect(contents).not.toMatch(/stale/i);
    expect(contents).toContain('directive on a curated draft');
  });
});
