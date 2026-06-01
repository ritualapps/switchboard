#!/usr/bin/env node
/**
 * Switchboard /blocked-on-input reference implementation.
 *
 * Writes (or clears) ~/.switchboard/deferred-<sessionId>.json so the
 * operator sees a `blocked` line on the Switchboard surface. The payload
 * is a JSON object describing the agent's pending tool requests:
 *
 *   { calls: ToolCallPart[], approvals: ToolCallPart[],
 *     metadata: { <tool_call_id>: { ... } } }
 *
 * Usage:
 *   echo '{ "approvals": [...] }' | node blocked-on-input.cjs
 *   node blocked-on-input.cjs --clear
 *
 * Session id resolution (in order):
 *   1. --session-id <uuid> argv
 *   2. CLAUDE_SESSION_ID env var
 *   3. SWITCHBOARD_SESSION_ID env var (fallback for non-CC agents)
 *
 * Exit codes:
 *   0 -- emission written or cleared
 *   1 -- malformed payload or invalid session id
 *   2 -- io error (eg permission denied on ~/.switchboard/)
 *
 * The contract shape is stable as of v1.0; this script ships as the
 * canonical reference implementation. Conforming agents under any
 * runtime / language may write the same shape directly without going
 * through this binary.
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
  const out = { clear: false, sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clear') out.clear = true;
    else if (a === '--session-id') {
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
  return (
    process.env.CLAUDE_SESSION_ID ||
    process.env.SWITCHBOARD_SESSION_ID ||
    null
  );
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function validatePayload(raw) {
  if (!raw.trim()) return { calls: [], approvals: [], metadata: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out = {};
  out.calls = Array.isArray(parsed.calls) ? parsed.calls : [];
  out.approvals = Array.isArray(parsed.approvals) ? parsed.approvals : [];
  out.metadata =
    parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
      ? parsed.metadata
      : {};
  return out;
}

function printUsage() {
  process.stdout.write(
    [
      '/blocked-on-input -- Switchboard emission contract.',
      '',
      'Usage:',
      '  echo \'{ "approvals": [...] }\' | blocked-on-input.cjs',
      '  blocked-on-input.cjs --clear',
      '  blocked-on-input.cjs --session-id <uuid>',
      '',
      'Writes ~/.switchboard/deferred-<sessionId>.json (or removes it with',
      '--clear). Payload shape: Pydantic AI DeferredToolRequests.',
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
  const filePath = path.join(SWITCHBOARD_DIR, `deferred-${sessionId}.json`);

  try {
    fs.mkdirSync(SWITCHBOARD_DIR, { recursive: true, mode: SECURE_DIR_MODE });
  } catch (e) {
    process.stderr.write(`error: could not create ${SWITCHBOARD_DIR}: ${e.message}\n`);
    process.exit(2);
  }

  if (args.clear) {
    try {
      fs.rmSync(filePath, { force: true });
      process.stdout.write(`cleared: ${filePath}\n`);
      process.exit(0);
    } catch (e) {
      process.stderr.write(`error: could not remove ${filePath}: ${e.message}\n`);
      process.exit(2);
    }
  }

  const payload = validatePayload(readStdinSync());
  if (payload === null) {
    process.stderr.write(
      `error: stdin payload is not valid JSON object. ` +
        `Expected DeferredToolRequests shape.\n`
    );
    process.exit(1);
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', {
      encoding: 'utf8',
      mode: SECURE_FILE_MODE,
    });
    process.stdout.write(`wrote: ${filePath}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`error: could not write ${filePath}: ${e.message}\n`);
    process.exit(2);
  }
}

main();
