/**
 * Switchboard CLI entry.
 *
 * Subcommands:
 *   (default)    -- mount the TUI
 *   install-hook -- register the UserPromptSubmit hook in ~/.claude/settings.json
 *                   (modifies user state, so the operator runs it deliberately)
 *
 * Spawns the adapter, mounts the TUI on the alternate screen buffer (so
 * drill-in scrollback can't leak into the operator's primary terminal), and
 * ensures the terminal is restored to a usable state on any exit path (crash,
 * signal, clean quit).
 */

import React from 'react';
import { render } from 'ink';
import { startAdapter } from './adapter.js';
import { App } from './tui/App.js';
import { ErrorBoundary } from './tui/ErrorBoundary.js';
import { runInstallHook } from './install/install-hook.js';
import { flushPendingDraftWrite } from './state-overlay/drafts.js';
import { allocateSlots } from './tui/slot-allocator.js';
import { loadSlotCacheSync } from './state-overlay/slot-cache.js';
import { isValidSessionId } from './contracts/registry.js';

const argv = process.argv.slice(2);
const subcommand = argv[0];

// Track whether we entered the alternate screen so exit paths know to leave.
let altScreenEntered = false;

function enterAltScreen(): void {
  if (altScreenEntered) return;
  if (!process.stdout.isTTY) return; // never alt-screen a redirected stdout
  try {
    process.stdout.write('\x1b[?1049h\x1b[H');
    altScreenEntered = true;
  } catch {
    // best-effort
  }
}

function leaveAltScreen(): void {
  if (!altScreenEntered) return;
  try {
    process.stdout.write('\x1b[?1049l');
  } catch {
    // best-effort
  }
  altScreenEntered = false;
}

/**
 * Exit cleanly. Order matters: leave alt-screen FIRST so any `postMessage`
 * (a stack trace from uncaughtException, say) lands in the primary terminal
 * where the operator can read it after the process dies.
 */
function restoreTerminalAndExit(code: number, postMessage?: string): never {
  leaveAltScreen();
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
  } catch {
    // best-effort
  }
  try {
    process.stdout.write('\x1b[?25h\x1b[0m');
  } catch {
    // best-effort
  }
  if (postMessage) {
    try {
      process.stderr.write(postMessage);
    } catch {
      // best-effort
    }
  }
  // Persist any pending drafts BEFORE we exit -- the in-render debounce
  // may have a snapshot waiting and we cannot lose it.
  flushPendingDraftWrite();
  process.exit(code);
}

// Final synchronous backstops: even if some exit path bypasses
// restoreTerminalAndExit, Node's 'exit' event fires before the process dies.
process.on('exit', () => {
  leaveAltScreen();
  flushPendingDraftWrite();
});

process.on('uncaughtException', (err) => {
  restoreTerminalAndExit(
    1,
    `\nSWITCHBOARD uncaughtException: ${err.message}\n${err.stack ?? ''}\n`
  );
});

process.on('unhandledRejection', (reason) => {
  const msg =
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
  restoreTerminalAndExit(1, `\nSWITCHBOARD unhandledRejection: ${msg}\n`);
});

async function main(): Promise<void> {
  if (subcommand === 'install-hook') {
    const result = await runInstallHook();
    process.stdout.write(result + '\n');
    process.exit(0);
  }

  if (subcommand === 'cmd') {
    await runCmdSubcommand(argv[1]);
    return;
  }

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
    const { VERSION } = await import('./version.js');
    process.stdout.write(`@ritualapps/switchboard ${VERSION}\n`);
    process.exit(0);
  }

  let adapter;
  try {
    adapter = await startAdapter();
  } catch (err) {
    restoreTerminalAndExit(1, `SWITCHBOARD adapter failed: ${(err as Error).message}\n`);
  }

  // Enter the alternate screen buffer AFTER adapter setup but BEFORE render.
  // The operator's previous terminal content is preserved underneath; on any
  // exit path the buffer is left and that content is restored. This stops
  // drill-in scrollback from leaking into the primary terminal.
  enterAltScreen();

  let ink;
  try {
    ink = render(
      React.createElement(
        ErrorBoundary,
        null,
        React.createElement(App, { adapter })
      )
    );
  } catch (err) {
    try {
      await adapter.stop();
    } catch {
      // ignore
    }
    restoreTerminalAndExit(1, `SWITCHBOARD initial render failed: ${(err as Error).message}\n`);
  }

  ink
    .waitUntilExit()
    .then(async () => {
      await adapter.stop();
      restoreTerminalAndExit(0);
    })
    .catch(async (err) => {
      try {
        await adapter.stop();
      } catch {
        // ignore
      }
      restoreTerminalAndExit(1, `SWITCHBOARD render loop crashed: ${(err as Error).message}\n`);
    });

  process.on('SIGINT', async () => {
    try {
      await adapter.stop();
    } catch {
      // ignore
    }
    restoreTerminalAndExit(0);
  });
}

const USAGE = `Switchboard -- the operator's surface for N parallel HITL agent lines.

Usage:
  switchboard                 Run the TUI (default).
  switchboard install-hook    Register the Claude Code UserPromptSubmit hook.
                              Modifies ~/.claude/settings.json and writes hook,
                              command, and skill files into ~/.claude/. Any
                              existing file is backed up to <file>.bak first.
  switchboard cmd <N>         Print \`claude --resume <session-id>\` for slot N.
                              Copy-paste the printed command to resume it.
  switchboard help            Show this help.
  switchboard version         Show the installed version.

Key bindings (board):
  j/k or arrows               Navigate lines.
  Enter or right-arrow        Plug in to focused line.
  1-9                         Plug in directly to the line in that slot.
  n / N                       Walk to next / previous ringing line in zone.
  D                           Defer focused line (NEEDS YOU -> TO DO).
  u                           Un-defer focused line.
  X                           Dismiss focused line (high-water-mark; re-rings on new events).
  h                           Hand back -- dispatch all drafts across all lines.
  q                           Quit.

Key bindings (drill-in):
  arrows / j / k              Move cursor on the body.
  right-arrow or a            Open annotation input at cursor.
  Esc / left-arrow / q        Disconnect (drafts persist).

Annotation flow:
  type content -> Enter (commits to per-line draft).

State directory: ~/.switchboard/
History log:     ~/.switchboard/history.jsonl
Pickup files:    ~/.switchboard/pickup-<sessionId>-<bundleId>.md
`;

/**
 * `switchboard cmd <N>` -- print `claude --resume <session-id>` for the
 * line whose identity slot matches `<N>`. Prints the resume command
 * for the operator to copy-paste. If multiple sessions hash to the
 * same slot (>9 active sessions), the most-recently-active one is chosen
 * so the operator's mental model -- "slot 5 is where I just was" -- holds.
 * Exits 0 on success (command printed to stdout). Exits 1 on invalid
 * argument or no match (message to stderr).
 */
async function runCmdSubcommand(rawSlot: string | undefined): Promise<void> {
  if (!rawSlot) {
    process.stderr.write(
      'Usage: switchboard cmd <N>\n  where N is a slot 1-9.\n'
    );
    process.exit(1);
  }
  const slot = Number(rawSlot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
    process.stderr.write(`error: slot must be an integer 1-9; got "${rawSlot}"\n`);
    process.exit(1);
  }
  let adapter;
  try {
    adapter = await startAdapter();
  } catch (err) {
    process.stderr.write(
      `error: could not start adapter: ${(err as Error).message}\n`
    );
    process.exit(1);
  }
  const lines = adapter.getLines();
  await adapter.stop();

  // Allocate slots using the shared cache so the CLI agrees with the
  // running App about which session holds which slot. The CLI is a
  // read-only consumer of the cache to avoid concurrent-write races
  // with the App.
  const cache = loadSlotCacheSync();
  const allocation = allocateSlots(lines, new Set(), cache);
  let targetId: string | null = null;
  for (const [id, assigned] of allocation.map) {
    if (assigned === slot) {
      targetId = id;
      break;
    }
  }
  if (targetId === null) {
    process.stderr.write(
      `error: no live session in slot ${slot}. Run \`switchboard\` to see ` +
        `which slots are occupied.\n`
    );
    process.exit(1);
  }
  // A session id is a Claude Code session UUID. It originates as a transcript
  // filename stem, which any local process can name arbitrarily, and this
  // string is printed for the operator to run as a command. Refuse anything
  // that is not a clean UUID so a hostile filename cannot reach the shell.
  if (!isValidSessionId(targetId)) {
    process.stderr.write(
      `error: session in slot ${slot} has an unexpected id; refusing to emit a ` +
        `resume command. Resume it manually from \`switchboard\`.\n`
    );
    process.exit(1);
  }
  process.stdout.write(`claude --resume ${targetId}\n`);
  process.exit(0);
}

main().catch((err) => {
  restoreTerminalAndExit(1, `SWITCHBOARD main failed: ${(err as Error).message}\n`);
});
