---
name: blocked-on-input
description: Switchboard /blocked-on-input contract. Invoke when the agent has paused waiting on user input the agent cannot resolve under its own logic (tool approvals, external execution results). Writes ~/.switchboard/deferred-<sessionId>.json, a JSON object describing the agent's pending tool requests, so the operator sees the line as `blocked` in the NEEDS YOU zone.
---

# /blocked-on-input

Switchboard's `blocked-on-input` is one of three base emission contracts. Invoke it when the agent has paused waiting on input the agent cannot resolve under its own logic. The most common case is a tool call that requires operator approval (Claude Code's permission system); other cases include externally-executed tools that the agent has dispatched and is waiting for results on.

## When to invoke

- A tool call requires user approval and the agent is blocked waiting for it.
- An externally-executed tool was dispatched and the agent cannot proceed without its result.
- The agent has reached a hand-off point and needs explicit operator confirmation to continue.

Do NOT invoke for routine think-then-act sequences the agent can resolve under its own logic. The `/blocked-on-input` contract triggers a NEEDS YOU zone transition with a `!` glyph; misuse trains the operator to ignore the cue.

## Substrate

Path: `~/.switchboard/deferred-<sessionId>.json`

Where `<sessionId>` is the CC session id (UUID). The agent reads `$CLAUDE_SESSION_ID` from the environment, or accepts a `--session-id <id>` flag.

## Payload shape

A JSON object describing the agent's pending tool requests:

```json
{
  "calls": [
    { "tool_name": "<name>", "tool_call_id": "<id>", "args": { ... } }
  ],
  "approvals": [
    { "tool_name": "<name>", "tool_call_id": "<id>", "args": { ... } }
  ],
  "metadata": {
    "<tool_call_id>": { "<key>": "<value>" }
  }
}
```

- `calls`: tool calls that require external execution.
- `approvals`: tool calls that require operator approval.
- `metadata`: optional per-call context (tool-author-defined).

Both `calls` and `approvals` are arrays of `ToolCallPart`-shaped objects. Empty arrays are valid (an empty `deferred-<sessionId>.json` represents "I'm blocked but the specifics will follow"). The operator sees the line in NEEDS YOU with `blocked: 0 tool approvals pending` until the array populates.

## Clear semantics

When the block resolves (approval granted, external execution returned a result), the agent invokes the skill with `--clear` to remove the file. The operator's surface immediately drops the `blocked` state on the next 2s poll.

Idempotent: clearing an absent file is a no-op.

## Render rule (Switchboard side)

- Cell: NEEDS YOU zone; `!` prefix glyph; `⌛` suffix glyph; footer `blocked: N tool approvals pending`.
- Drill-in: body lists each pending tool call with its name + summary of args.
- Precedence: blocked beats ringing. A session with both `pickup-<sessionId>-<bundleId>.md` and `deferred-<sessionId>.json` renders blocked.

## Reference implementation

The Switchboard repo ships a reference implementation at:

```
skills/blocked-on-input/blocked-on-input.cjs
```

Invoke as:

```
echo '{"approvals":[{"tool_name":"Bash","tool_call_id":"t1","args":{"command":"ls"}}]}' \
  | node skills/blocked-on-input/blocked-on-input.cjs

# Clear:
node skills/blocked-on-input/blocked-on-input.cjs --clear
```

Sets `CLAUDE_SESSION_ID` from env; override with `--session-id <uuid>`.

## Stability

Contract shape stable as of v1.0.
