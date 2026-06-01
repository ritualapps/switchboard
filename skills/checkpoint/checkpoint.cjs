#!/usr/bin/env node
/**
 * Switchboard /checkpoint reference implementation.
 *
 * Appends one JSON record to ~/.switchboard/checkpoints-<sessionId>.jsonl
 * per invocation. The agent emits a checkpoint each time it reaches a
 * milestone worth surfacing to a wander-away operator.
 *
 * Usage:
 *   echo '{"message":"types migration complete","milestoneIndex":3,"milestoneTotal":5}' \
 *     | node checkpoint.cjs
 *   echo '{"message":"chapter 4 indexed"}' | node checkpoint.cjs
 *
 * Session id resolution (in order):
 *   1. --session-id <uuid> argv
 *   2. CLAUDE_SESSION_ID env var
 *   3. SWITCHBOARD_SESSION_ID env var
 *
 * If the payload omits `ts`, the current ISO timestamp is filled in.
 *
 * Exit codes:
 *   0 -- emission appended
 *   1 -- malformed payload or invalid session id
 *   2 -- io error
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const SWITCHBOARD_DIR = path.join(HOME, '.switchboard');
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseArgs(argv) {
  const out = { sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') {
      out.sessionId = argv[i + 1] || null;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return out;
}

function resolveSessionId(args) {
  if (args.sessionId) return args.sessionId;
  return process.env.CLAUDE_SESSION_ID || process.env.SWITCHBOARD_SESSION_ID || null;
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function validatePayload(raw) {
  if (!raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.message !== 'string' || !parsed.message.trim()) return null;
  const out = {
    ts: typeof parsed.ts === 'string' ? parsed.ts : new Date().toISOString(),
    message: parsed.message,
  };
  if (typeof parsed.milestoneIndex === 'number') out.milestoneIndex = parsed.milestoneIndex;
  if (typeof parsed.milestoneTotal === 'number') out.milestoneTotal = parsed.milestoneTotal;
  return out;
}

function printUsage() {
  process.stdout.write(
    [
      '/checkpoint -- Switchboard emission contract.',
      '',
      'Usage:',
      '  echo \'{"message":"...","milestoneIndex":3,"milestoneTotal":5}\' | checkpoint.cjs',
      '  echo \'{"message":"..."}\' | checkpoint.cjs',
      '  checkpoint.cjs --session-id <uuid>',
      '',
      'Appends to ~/.switchboard/checkpoints-<sessionId>.jsonl. `ts` fills',
      'with new Date().toISOString() if absent. `message` is required.',
      '',
    ].join('\n')
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = resolveSessionId(args);
  if (!sessionId || !UUID_RE.test(sessionId)) {
    process.stderr.write(
      `error: session id missing or not a UUID. Pass --session-id <uuid>, ` +
        `or set CLAUDE_SESSION_ID. Got: ${JSON.stringify(sessionId)}\n`
    );
    process.exit(1);
  }
  const payload = validatePayload(readStdinSync());
  if (payload === null) {
    process.stderr.write(
      `error: stdin payload missing or malformed. Required: ` +
        `{ "message": "<string>" }. Optional: ts, milestoneIndex, milestoneTotal.\n`
    );
    process.exit(1);
  }

  try {
    fs.mkdirSync(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  } catch (e) {
    process.stderr.write(`error: could not create ${SWITCHBOARD_DIR}: ${e.message}\n`);
    process.exit(2);
  }

  const filePath = path.join(SWITCHBOARD_DIR, `checkpoints-${sessionId}.jsonl`);
  try {
    fs.appendFileSync(filePath, JSON.stringify(payload) + '\n', {
      encoding: 'utf8',
      mode: SECURE_FILE_MODE,
    });
    process.stdout.write(`appended: ${filePath}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`error: could not append ${filePath}: ${e.message}\n`);
    process.exit(2);
  }
}

main();
