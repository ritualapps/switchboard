# Agent-as-watcher

A starter recipe for getting Switchboard handbacks processed without waiting for your next prompt.

## How it works

Switchboard's `h` keystroke writes a pickup file to `~/.switchboard/pickup-*.md`. The CC-side hook delivers that file on your next prompt submit. This recipe asks the agent itself to also check the pickup directory at the end of each turn, so packets you send via `h` get processed even when you don't type anything next.

The agent does the polling. No new Switchboard code, no MCP server, no OS keystroke injection. One extra `Read` tool call per turn.

## Install

Append the contents of [`CLAUDE.md`](./CLAUDE.md) to either:

- Your project's `./CLAUDE.md` (project-scoped), or
- Your global `~/.claude/CLAUDE.md` (every session)

That's it. Next session, the agent will check for pickups at end-of-turn.

## Trade-offs

- **Cost:** roughly one extra `Read` (and possibly a `Bash` for the rename) per turn. Small, but not zero.
- **Reliability:** depends on Claude following the `CLAUDE.md` instruction every turn. Most of the time it does; sometimes it doesn't, especially when the agent is deep in a long tool chain.
- **Multi-session collision:** if you run multiple CC sessions in parallel and they share `~/.switchboard/`, any session may grab any pending packet. The starter recipe is single-session-clean; multi-session variants below.
- **Latency:** packets land at turn END, not the moment `h` is pressed. So if Claude is mid-30-minute task, the packet waits for that to finish.

## Multi-session variants

If you run sessions in parallel, the starter recipe needs session-disambiguation. Two approaches:

1. **Filter by session id.** The agent can find its own session's transcript path by looking at the most-recently-modified `.jsonl` in `~/.claude/projects/<cwd-hash>/`. Then filter pickup files by that session id. Brittle but works.

2. **Per-session pickup directory.** Use Switchboard's `--per-session-dir` flag (not yet implemented; would be a worthy V1.1 PR). Each session reads its own subdirectory only.

If you write one of these, open a PR to add it as a sibling recipe directory (e.g. `examples/agent-as-watcher-multi-session/`).

## Known failure modes

- Agent forgets to check at end of turn (model variance).
- Pickup file is mid-write when agent reads it (race; pickup file writes are append-only and short, so this is rare).
- `.consumed` rename fails (permissions); next turn re-reads the same content -- annoying but not destructive.

## Variants worth exploring

- **Stop-hook integration:** combine this prompt-side recipe with a Stop hook that returns `block` + `reason` when a pickup is pending, forcing Claude to re-enter the turn. Removes the "agent forgot to check" failure mode.
- **MCP long-poll:** replace the agent-side `Read` with a custom MCP tool that blocks until a pickup lands. Removes the "extra tool call per turn" cost and gives instant delivery, but requires shipping an MCP server.

Both of these are real shapes; neither is implemented in Switchboard V1.
