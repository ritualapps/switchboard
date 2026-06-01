/**
 * Install-hook command.
 *
 * Registers two Claude Code hooks in ~/.claude/settings.json:
 *   1. UserPromptSubmit -> switchboard-pickup.cjs (delivers pickup payloads
 *      to the agent at next prompt submit)
 *   2. SessionEnd       -> switchboard-sessionend.cjs (writes closed marker
 *      so the line transitions to `closed` state)
 *
 * Also writes the bootstrap baseline (~/.switchboard/baseline.json) at
 * install time so pre-install CC sessions are hidden by default.
 *
 * Idempotent -- safe to re-run; will not add duplicate entries. The operator
 * runs `npx @ritualapps/switchboard install-hook` deliberately, not at npm
 * install time.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_DIR, CLAUDE_SETTINGS_FILE } from '../paths.js';
import { writeBaseline } from '../state-overlay/baseline.js';

const PICKUP_HOOK_FILENAME = 'switchboard-pickup.cjs';
const SESSIONEND_HOOK_FILENAME = 'switchboard-sessionend.cjs';
const HANDBACK_COMMAND_FILENAME = 'handback.md';

/**
 * The three base skill packages copied to `~/.claude/skills/<name>/` on
 * install. Adding a new contract = add an entry here plus the skill
 * directory under `skills/`.
 */
const SKILL_PACKAGES = [
  { name: 'ringing', files: ['SKILL.md'] },
  { name: 'blocked-on-input', files: ['SKILL.md', 'blocked-on-input.cjs'] },
  { name: 'checkpoint', files: ['SKILL.md', 'checkpoint.cjs'] },
] as const;

const HANDBACK_COMMAND_BODY = `---
description: Process handback annotations staged from Switchboard.
---
__SWITCHBOARD_HANDBACK__

Process any switchboard annotations prepended above this line as the operator's instructions to act on now. If nothing was prepended, reply \`(no pending handback)\` and stop.
`;

/**
 * Normalise an OS-specific path to forward slashes for use inside a CC
 * `settings.json` hook `command` string. CC accepts forward slashes on
 * Windows; back-slashes can be mis-parsed by shell wrappers and are also
 * fragile under JSON re-escape. Always emit `/`.
 */
function toHookCommandPath(p: string): string {
  return p.replace(/\\/g, '/');
}

interface HookEntry {
  type: 'command';
  command: string;
}

interface HookGroup {
  hooks?: HookEntry[];
  matcher?: string;
}

interface SettingsShape {
  hooks?: {
    UserPromptSubmit?: HookGroup[];
    SessionEnd?: HookGroup[];
    [key: string]: HookGroup[] | undefined;
  };
  [key: string]: unknown;
}

/**
 * Write `content` to `targetPath`, first backing up any pre-existing file
 * (whose content differs) to `<targetPath>.bak`. Install must never silently
 * destroy a user's own file -- e.g. a hand-written `commands/handback.md` or a
 * skill they already keep under one of our generic names. Re-running the
 * install over Switchboard's own identical output is a no-op (no spurious
 * `.bak`). Mirrors the settings.json backup the install already performs.
 */
async function writeWithBackup(
  targetPath: string,
  content: string,
  messages: string[]
): Promise<void> {
  let existing: string | null = null;
  try {
    existing = await readFile(targetPath, 'utf8');
  } catch {
    // target absent -- nothing to back up
  }
  if (existing !== null && existing !== content) {
    await writeFile(`${targetPath}.bak`, existing, 'utf8');
    messages.push(`  Backed up existing ${targetPath} -> ${targetPath}.bak`);
  }
  await writeFile(targetPath, content, 'utf8');
}

export async function runInstallHook(): Promise<string> {
  const messages: string[] = [];

  const pickupSource = resolveHookSourcePath(PICKUP_HOOK_FILENAME);
  const sessionendSource = resolveHookSourcePath(SESSIONEND_HOOK_FILENAME);
  const pickupInstalled = join(CLAUDE_DIR, 'hooks', PICKUP_HOOK_FILENAME);
  const sessionendInstalled = join(CLAUDE_DIR, 'hooks', SESSIONEND_HOOK_FILENAME);

  await mkdir(dirname(pickupInstalled), { recursive: true });
  const pickupContent = await readFile(pickupSource, 'utf8');
  await writeWithBackup(pickupInstalled, pickupContent, messages);
  const sessionendContent = await readFile(sessionendSource, 'utf8');
  await writeWithBackup(sessionendInstalled, sessionendContent, messages);

  // Custom slash command -- the operator's explicit handback gesture in CC.
  // Without this, the pickup hook never fires (it gates on /handback or the
  // sentinel carried by this command's body).
  const handbackInstalled = join(CLAUDE_DIR, 'commands', HANDBACK_COMMAND_FILENAME);
  await mkdir(dirname(handbackInstalled), { recursive: true });
  await writeWithBackup(handbackInstalled, HANDBACK_COMMAND_BODY, messages);

  // Read original settings (if any) BEFORE composing the update. We preserve
  // the verbatim original so we can write it back to `.bak` regardless of
  // whether it parses -- a malformed existing file still has content the
  // operator may want to recover.
  let originalRaw: string | null = null;
  try {
    originalRaw = await readFile(CLAUDE_SETTINGS_FILE, 'utf8');
  } catch {
    // not present yet
  }
  let settings: SettingsShape = {};
  if (originalRaw !== null) {
    try {
      settings = JSON.parse(originalRaw);
    } catch {
      // unparseable -- start fresh; .bak below preserves the original bytes
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // 1. UserPromptSubmit hook
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
  const pickupCommand = `node ${toHookCommandPath(pickupInstalled)}`;
  const pickupGroup = settings.hooks.UserPromptSubmit.find((g) =>
    (g.hooks ?? []).some((h) => toHookCommandPath(h.command) === pickupCommand)
  );
  if (pickupGroup) {
    messages.push('  UserPromptSubmit (pickup): already registered');
  } else {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: pickupCommand }],
    });
    messages.push('  UserPromptSubmit (pickup): registered');
  }

  // 2. SessionEnd hook
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];
  const sessionendCommand = `node ${toHookCommandPath(sessionendInstalled)}`;
  const sessionendGroup = settings.hooks.SessionEnd.find((g) =>
    (g.hooks ?? []).some((h) => toHookCommandPath(h.command) === sessionendCommand)
  );
  if (sessionendGroup) {
    messages.push('  SessionEnd (closed-marker): already registered');
  } else {
    settings.hooks.SessionEnd.push({
      hooks: [{ type: 'command', command: sessionendCommand }],
    });
    messages.push('  SessionEnd (closed-marker): registered');
  }

  // Backup-then-atomic-write. Mid-process crashes cannot corrupt the operator's
  // settings.json: the original is preserved at `.bak`, the new content is
  // staged at `.tmp`, and the final move is a single atomic `rename` on both
  // POSIX and Windows.
  if (originalRaw !== null) {
    await writeFile(`${CLAUDE_SETTINGS_FILE}.bak`, originalRaw, 'utf8');
  }
  const tmpPath = `${CLAUDE_SETTINGS_FILE}.tmp`;
  await writeFile(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await rename(tmpPath, CLAUDE_SETTINGS_FILE);

  // 3. The three base skill packages.
  const skillsInstalled: string[] = [];
  for (const skill of SKILL_PACKAGES) {
    const skillDir = join(CLAUDE_DIR, 'skills', skill.name);
    await mkdir(skillDir, { recursive: true });
    for (const file of skill.files) {
      const sourcePath = resolveSkillSourcePath(skill.name, file);
      try {
        const content = await readFile(sourcePath, 'utf8');
        await writeWithBackup(join(skillDir, file), content, messages);
      } catch {
        // Skill source files ship in-repo; absence is a package shape bug.
        // Don't fail the install -- the hooks still work, just without the
        // skill markdown. Log + continue.
        messages.push(`  Skill ${skill.name}/${file}: source not found at ${sourcePath} (skipped)`);
      }
    }
    skillsInstalled.push(skillDir);
    messages.push(`  Skill ${skill.name}: installed at ${skillDir}`);
  }

  // 4. Bootstrap baseline -- hides pre-install sessions from the board.
  const baseline = await writeBaseline();
  messages.push(`  Bootstrap baseline: ${baseline.at}`);

  return [
    'Switchboard hooks + base skills installed.',
    ...messages,
    `  /handback slash command: ${handbackInstalled}`,
    '',
    `Hook scripts:  ${pickupInstalled}`,
    `               ${sessionendInstalled}`,
    `Skill packages: ${skillsInstalled.join('\n                 ')}`,
    `CC settings:   ${CLAUDE_SETTINGS_FILE}`,
    `Baseline file: ~/.switchboard/baseline.json`,
    '',
    'New CC sessions after install will appear on the switchboard board.',
    'Pre-install sessions remain hidden until they advance past the baseline.',
    '',
    'To deliver staged annotations: press `h` in Switchboard, then type',
    '`/handback` in your CC session. Only `/handback` triggers pickup --',
    'other prompts are no-ops at the hook level.',
  ].join('\n');
}

function resolveHookSourcePath(filename: string): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '..', 'hooks', filename);
}

function resolveSkillSourcePath(skillName: string, filename: string): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '..', 'skills', skillName, filename);
}
