/**
 * install-hook consent + packaging regression.
 *
 * The install writes hook, command, and skill files into ~/.claude/. It must
 * never silently destroy a user's own file of the same name (e.g. a
 * hand-written /handback command, or a skill kept under one of our generic
 * names): any pre-existing file is backed up to <file>.bak first. It must also
 * actually install the skill packages from the in-repo source.
 *
 * Spawns the real `switchboard install-hook` subcommand with HOME redirected
 * to a tmpdir so the test is hermetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

function runInstall(homeDir: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, 'install-hook'], {
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('switchboard install-hook (consent + packaging)', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sb-install-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("backs up a user's pre-existing handback.md before overwriting it", () => {
    const commandsDir = join(homeDir, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    const handback = join(commandsDir, 'handback.md');
    const userContent = '# MY OWN HANDBACK COMMAND\nDo not clobber me.\n';
    writeFileSync(handback, userContent);

    runInstall(homeDir);

    // The user's original is preserved at .bak ...
    expect(existsSync(`${handback}.bak`)).toBe(true);
    expect(readFileSync(`${handback}.bak`, 'utf8')).toBe(userContent);
    // ... and the installed command is Switchboard's.
    expect(readFileSync(handback, 'utf8')).toContain('__SWITCHBOARD_HANDBACK__');
  });

  it('installs the base-three skill packages from in-repo source', () => {
    runInstall(homeDir);
    const skillsDir = join(homeDir, '.claude', 'skills');
    for (const name of ['ringing', 'blocked-on-input', 'checkpoint']) {
      expect(existsSync(join(skillsDir, name, 'SKILL.md')), `${name}/SKILL.md`).toBe(true);
    }
    // The two reference-implementation skills ship their .cjs too.
    expect(existsSync(join(skillsDir, 'blocked-on-input', 'blocked-on-input.cjs'))).toBe(true);
    expect(existsSync(join(skillsDir, 'checkpoint', 'checkpoint.cjs'))).toBe(true);
  });

  it('is idempotent: re-running over identical output creates no spurious .bak', () => {
    runInstall(homeDir);
    const handback = join(homeDir, '.claude', 'commands', 'handback.md');
    // First run wrote the command (no prior file -> no .bak).
    expect(existsSync(`${handback}.bak`)).toBe(false);
    runInstall(homeDir);
    // Second run writes identical content -> still no backup churn.
    expect(existsSync(`${handback}.bak`)).toBe(false);
  });
});
