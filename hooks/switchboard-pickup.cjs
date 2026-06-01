#!/usr/bin/env node
/**
 * Switchboard /handback hook.
 *
 * Configured in ~/.claude/settings.json as a UserPromptSubmit hook by
 * `switchboard install-hook`. The hook is GATED on the explicit handback
 * gesture -- it only injects pickup content when the user prompt is
 * `/handback` (the literal slash command) or contains the sentinel
 * `__SWITCHBOARD_HANDBACK__` (carried in the slash command's expanded body).
 * Any other prompt is a no-op so accidental delivery cannot happen.
 *
 * The slash command file (~/.claude/commands/handback.md) is written by
 * `switchboard install-hook` alongside this script.
 *
 * CC hook input format (stdin JSON):
 *   { session_id, transcript_path, cwd, hook_event_name, prompt, ... }
 *
 * Stdout = injected context. Exit 0 always (failure must never block
 * the user's prompt).
 *
 * Pickup file convention: ~/.switchboard/pickup-<sessionId>-<bundleId>.md
 * Set by handBack() in src/dispatch/dispatcher.ts.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HANDBACK_SENTINEL = '__SWITCHBOARD_HANDBACK__';
const HANDBACK_LITERAL = '/handback';

// CC passes hook input as JSON on stdin.
let sessionId = null;
let prompt = '';
try {
  const stdinRaw = fs.readFileSync(0, 'utf8');
  if (stdinRaw.trim()) {
    const data = JSON.parse(stdinRaw);
    sessionId = data.session_id;
    prompt = typeof data.prompt === 'string' ? data.prompt : '';
  }
} catch (err) {
  // Stdin not available or malformed; bail without injection.
}

if (!sessionId) {
  process.exit(0);
}

// Gate: only the explicit /handback gesture (or the sentinel carried in the
// slash command's expanded body) triggers pickup. CC's exact behaviour for
// `prompt` on slash command invocation isn't documented as of writing, so
// we match both the literal user-typed form and the sentinel-in-body form.
// Either one is sufficient.
const trimmed = prompt.trim();
const isHandback =
  trimmed === HANDBACK_LITERAL ||
  trimmed.startsWith(HANDBACK_LITERAL + ' ') ||
  prompt.includes(HANDBACK_SENTINEL);
if (!isHandback) {
  process.exit(0);
}

const switchboardDir = path.join(os.homedir(), '.switchboard');

let files;
try {
  files = fs.readdirSync(switchboardDir);
} catch (err) {
  process.exit(0);
}

const prefix = `pickup-${sessionId}-`;
const pending = files.filter(
  (f) => f.startsWith(prefix) && f.endsWith('.md') && !f.endsWith('.consumed')
);

if (pending.length === 0) {
  process.exit(0);
}

const parts = [];
for (const f of pending) {
  const fullPath = path.join(switchboardDir, f);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    parts.push(content);
    fs.renameSync(fullPath, fullPath + '.consumed');
  } catch (err) {
    // Skip on failure; never block the prompt.
  }
}

if (parts.length > 0) {
  process.stdout.write(parts.join('\n\n---\n\n'));
}

process.exit(0);
