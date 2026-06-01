/**
 * State-overlay tests: dismissal HWM + closed marker + baseline.
 *
 * These exercise the pure stores in isolation; adapter integration is
 * covered separately.
 *
 * Stores write to ~/.switchboard/* on the real filesystem. We use unique
 * line-ids per test so they don't collide with other tests or with the
 * operator's real state. Cleanup is best-effort -- the directory is
 * operator-shared and we don't truncate it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nanoid } from 'nanoid';
import { loadDismissalStore } from '../src/state-overlay/dismissal.ts';
import { loadClosedStore } from '../src/state-overlay/closed.ts';
import { passesBaseline } from '../src/state-overlay/baseline.ts';
import {
  loadDraftsSync,
  saveDrafts,
  saveDraftsSync,
  flushPendingDraftWrite,
  __resetDraftsPersistenceForTests,
} from '../src/state-overlay/drafts.ts';
import type { LineDraft } from '../src/types.ts';

describe('dismissal HWM store', () => {
  it('a fresh line is not dismissed', async () => {
    const store = await loadDismissalStore();
    expect(store.isDismissedAt('never-dismissed-' + nanoid(8), 5)).toBe(false);
  });

  it('add() persists; isDismissedAt() returns true at and below HWM', async () => {
    const store = await loadDismissalStore();
    const lineId = 'test-dismiss-' + nanoid(8);
    await store.add({
      lineId,
      eventCount: 10,
      lastEventAt: new Date().toISOString(),
      at: new Date().toISOString(),
    });
    expect(store.isDismissedAt(lineId, 8)).toBe(true);   // below HWM
    expect(store.isDismissedAt(lineId, 10)).toBe(true);  // at HWM
    expect(store.isDismissedAt(lineId, 11)).toBe(false); // past HWM -- re-ring
  });

  it('clear() tombstones the dismissal', async () => {
    const store = await loadDismissalStore();
    const lineId = 'test-clear-' + nanoid(8);
    await store.add({
      lineId,
      eventCount: 5,
      lastEventAt: new Date().toISOString(),
      at: new Date().toISOString(),
    });
    expect(store.isDismissedAt(lineId, 5)).toBe(true);
    await store.clear(lineId);
    expect(store.isDismissedAt(lineId, 5)).toBe(false);
  });

  it('dismissal entry persists in active map after HWM advance (audit)', async () => {
    const store = await loadDismissalStore();
    const lineId = 'test-audit-' + nanoid(8);
    await store.add({
      lineId,
      eventCount: 3,
      lastEventAt: new Date().toISOString(),
      at: new Date().toISOString(),
    });
    expect(store.isDismissedAt(lineId, 3)).toBe(true);
    // Line advances past HWM.
    expect(store.isDismissedAt(lineId, 4)).toBe(false);
    // Entry stays in active as audit -- HWM advance does not tombstone.
    expect(store.active.has(lineId)).toBe(true);
  });

  it('reloading the store reflects persisted state', async () => {
    const lineId = 'test-reload-' + nanoid(8);
    const first = await loadDismissalStore();
    await first.add({
      lineId,
      eventCount: 7,
      lastEventAt: new Date().toISOString(),
      at: new Date().toISOString(),
    });
    const second = await loadDismissalStore();
    expect(second.isDismissedAt(lineId, 7)).toBe(true);
  });
});

describe('closed-marker store', () => {
  it('reads the closed.jsonl substrate', async () => {
    const store = await loadClosedStore();
    // Just verify shape; entries are written by the SessionEnd hook.
    expect(typeof store.isClosed).toBe('function');
    expect(store.closed instanceof Set).toBe(true);
  });
});

describe('bootstrap baseline', () => {
  it('passesBaseline returns true for events after the baseline', () => {
    const baseline = { at: new Date(1000).toISOString(), atMs: 1000 };
    expect(passesBaseline(baseline, 500)).toBe(false);
    expect(passesBaseline(baseline, 1000)).toBe(false); // strict greater-than
    expect(passesBaseline(baseline, 1001)).toBe(true);
  });

  it('a zero baseline lets everything through (dev mode without install)', () => {
    const baseline = { at: new Date(0).toISOString(), atMs: 0 };
    expect(passesBaseline(baseline, 1)).toBe(true);
  });
});

// drafts.json is a shared singleton file. These tests back up the operator's
// real drafts before each case and restore after, so a failing assertion
// cannot lose work.
describe('drafts debounce + flush', () => {
  function makeDraft(lineId: string, content = 'hello'): LineDraft {
    return {
      lineId,
      bundleId: 'b-' + nanoid(6),
      startedAt: new Date().toISOString(),
      annotations: [
        { id: 'a-' + nanoid(6), anchor: { kind: 'closing' }, content },
      ],
    };
  }

  let snapshot: LineDraft[];

  beforeEach(() => {
    snapshot = Array.from(loadDraftsSync().values());
    __resetDraftsPersistenceForTests();
  });

  afterEach(() => {
    __resetDraftsPersistenceForTests();
    const restored = new Map(snapshot.map((d) => [d.lineId, d]));
    saveDraftsSync(restored);
  });

  it('flushPendingDraftWrite persists the latest pending snapshot synchronously', () => {
    const lineId = 'test-flush-' + nanoid(8);
    const drafts = new Map<string, LineDraft>([[lineId, makeDraft(lineId, 'flushed')]]);
    saveDrafts(drafts);
    // No timer advance -- flush bypasses the debounce.
    flushPendingDraftWrite();
    const loaded = loadDraftsSync();
    expect(loaded.get(lineId)?.annotations[0]?.content).toBe('flushed');
  });

  it('rapid saveDrafts calls coalesce into a single write with last-write-wins content', async () => {
    const lineId = 'test-coalesce-' + nanoid(8);
    for (let i = 0; i < 5; i++) {
      const d = new Map<string, LineDraft>([
        [lineId, makeDraft(lineId, `body-${i}`)],
      ]);
      saveDrafts(d);
    }
    // Wait > 100ms debounce + a small async tick for the write.
    await new Promise((r) => setTimeout(r, 200));
    const loaded = loadDraftsSync();
    expect(loaded.get(lineId)?.annotations[0]?.content).toBe('body-4');
  });

  it('flushPendingDraftWrite is a no-op when nothing is pending', () => {
    // Calling flush on a fresh module state should not throw.
    expect(() => flushPendingDraftWrite()).not.toThrow();
  });
});
