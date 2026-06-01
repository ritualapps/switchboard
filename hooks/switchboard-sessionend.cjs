#!/usr/bin/env node
/**
 * Switchboard SessionEnd hook.
 *
 * Configured in ~/.claude/settings.json as a SessionEnd hook by
 * `switchboard install-hook`. Claude Code fires SessionEnd when a session
 * terminates at the platform level. This script appends the session id to
 * ~/.switchboard/closed.jsonl so the adapter can transition the line to
 * the `closed` state on its next scan.
 *
 * CC hook input format (stdin JSON):
 *   { session_id, transcript_path, cwd, hook_event_name, ... }
 *
 * Stdout is unused. Exit 0 always (failure must never block CC shutdown).
 *
 * Format: each line is a JSON object: {sessionId, at}.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let sessionId = null;
try {
  const stdinRaw = fs.readFileSync(0, 'utf8');
  if (stdinRaw.trim()) {
    const data = JSON.parse(stdinRaw);
    sessionId = data.session_id;
  }
} catch (err) {
  // Stdin not available or malformed; bail without closed-marker.
}

if (!sessionId) {
  process.exit(0);
}

const switchboardDir = path.join(os.homedir(), '.switchboard');

// Operator-only perms; no-op on Windows (ACL-based). Mirrors SECURE_DIR_MODE /
// SECURE_FILE_MODE in src/paths.ts -- duplicated here because hook scripts
// are plain CommonJS without a build step.
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;

try {
  fs.mkdirSync(switchboardDir, { recursive: true, mode: SECURE_DIR_MODE });
  const entry = JSON.stringify({ sessionId, at: new Date().toISOString() });
  fs.appendFileSync(path.join(switchboardDir, 'closed.jsonl'), entry + '\n', { encoding: 'utf8', mode: SECURE_FILE_MODE });
} catch (err) {
  // best-effort; never block CC shutdown
}

process.exit(0);
