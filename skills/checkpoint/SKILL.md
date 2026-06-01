---
name: checkpoint
description: Switchboard /checkpoint contract. Invoke when the agent has reached a milestone worth surfacing to a wander-away operator as RUNNING-zone enrichment. Appends one JSONL record per checkpoint to ~/.switchboard/checkpoints-<sessionId>.jsonl; Switchboard's cell shows the latest message plus an optional milestone fraction, and drill-in renders the full trail.
---

# /checkpoint

Switchboard's `checkpoint` is the third base emission contract. Unlike `/ringing` and `/blocked-on-input`, it does NOT drive a zone transition -- it enriches the existing zone. A line that is `in_progress` or `plugged_in` keeps its RUNNING-zone placement; the cell's footer-text becomes the latest checkpoint message so the operator can glance and see what the agent is doing without plugging in.

The contract is the **wander-away-supporting emission**: an operator who left the room for two hours returns to a board where every long-running line shows "milestone 3 of 5: types migration complete" instead of "Bash command running". The operator's context comes back in one glance.

## When to invoke

- The agent has reached a milestone in a multi-step task (data migration step 2 of 7; chapter 4 of 12 indexed; build phase 3 complete).
- The agent has completed a substantive sub-task and is moving on to the next one.
- Long-running idempotent work where periodic "still alive + here's where I am" is operator-relevant.

Do NOT invoke for routine tool calls (the cell already shows tool name); do NOT invoke for ringing events (use `/ringing`); do NOT invoke for blocked states (use `/blocked-on-input`). Each checkpoint emission should mark a milestone the operator would consider meaningful.

## Substrate

Path: `~/.switchboard/checkpoints-<sessionId>.jsonl`

Append-only. One JSON record per line. The file persists across the session's lifetime; agents do not clear it (the trail is the audit). Switchboard reads the LATEST record for cell enrichment and the FULL trail for drill-in render.

## Payload shape

```json
{
  "ts": "<ISO 8601 timestamp>",
  "message": "<human-readable milestone>",
  "milestoneIndex": <optional number>,
  "milestoneTotal": <optional number>
}
```

- `ts` (required): ISO timestamp of the milestone landing.
- `message` (required): one-line human-readable description. Aim for under 80 characters; longer renders fine but the cell will truncate.
- `milestoneIndex` (optional): 1-based current milestone. Pair with `milestoneTotal` to render "i/N · message" in the cell.
- `milestoneTotal` (optional): total milestone count. Required iff `milestoneIndex` present.

Both `milestoneIndex` and `milestoneTotal` are optional. The simplest valid emission is `{ "ts": "...", "message": "step done" }`.

## Render rule (Switchboard side)

- Cell: stays in RUNNING zone (no zone change). The latest checkpoint message replaces the reducer-derived `lastEventSummary`. If `milestoneIndex` + `milestoneTotal` are both present, the cell renders `i/N · message`.
- Drill-in body: renders the full trail (latest first) with timestamps.
- Precedence: checkpoint is enrichment-only and does not contend for zone with `/blocked-on-input` or `/ringing`. A session that is `blocked` AND has checkpoint emissions renders as blocked (zone-driver wins) but the drill-in body still shows the checkpoint trail.

## Reference implementation

```
skills/checkpoint/checkpoint.cjs
```

Invoke as:

```
echo '{"message":"types migration complete","milestoneIndex":3,"milestoneTotal":5}' \
  | node skills/checkpoint/checkpoint.cjs

# Without milestone fraction:
echo '{"message":"chapter 4 indexed"}' | node skills/checkpoint/checkpoint.cjs
```

Sets `ts` automatically to `new Date().toISOString()` if absent. Session id resolution mirrors `/blocked-on-input` (`--session-id` argv > `CLAUDE_SESSION_ID` env > `SWITCHBOARD_SESSION_ID` env).

## Stability

Contract shape stable as of v1.0.
