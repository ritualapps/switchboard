/**
 * Bootstrap baseline.
 *
 * At install time, switchboard records a baseline timestamp. Sessions whose
 * transcript was last modified BEFORE the baseline are pre-hidden -- they
 * appear on the board only if they advance past the baseline.
 *
 * Sessions that started AFTER the baseline (new CC sessions) always appear.
 * Sessions that EXISTED at install time but advance afterwards also appear.
 *
 * Storage: ~/.switchboard/baseline.json -- single object, written once by
 * install-hook. If absent (e.g. dev run without install), the baseline is
 * treated as 0 (everything visible).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, SWITCHBOARD_DIR } from '../paths.js';

const BASELINE_FILE = join(SWITCHBOARD_DIR, 'baseline.json');

export interface Baseline {
  at: string;
  atMs: number;
}

export async function loadBaseline(): Promise<Baseline> {
  try {
    const raw = await readFile(BASELINE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    if (typeof parsed.atMs === 'number') return parsed;
  } catch {
    // fall through -- no baseline => everything visible
  }
  return { at: new Date(0).toISOString(), atMs: 0 };
}

export async function writeBaseline(now: number = Date.now()): Promise<Baseline> {
  await mkdir(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  const baseline: Baseline = { at: new Date(now).toISOString(), atMs: now };
  await writeFile(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n', { encoding: 'utf8', mode: SECURE_FILE_MODE });
  return baseline;
}

/**
 * Returns true if the session's last activity is past the baseline (i.e.
 * the session SHOULD be visible on the board).
 *
 * Sessions older than the baseline are hidden until they advance.
 */
export function passesBaseline(baseline: Baseline, lastEventMs: number): boolean {
  return lastEventMs > baseline.atMs;
}
