# Switchboard

A terminal dashboard for operators running many Claude Code sessions at once. Switchboard gathers every active session into one board so you can watch progress, see which sessions are waiting on you, review their output, and reply to each one inline without switching terminals.

Each session is a line on the board. When a session needs input or has output to review, its line moves to a priority zone. Open a line, read its latest output under the cursor, attach annotations at the exact point you're reading, then dispatch your replies across every line with one keystroke. The annotation format stays minimal by design: an anchor and your text. No target picker, no priority field, no metadata.

The board stays live while sessions keep working on their own. When you come back, it shows what changed: which lines progressed, which finished, which actually blocked. "Blocked" means one thing here: a session reports `/blocked-on-input` only when it cannot proceed on its own. Routine confirmations are not blocks. Queued tool calls are not blocks.

## Prerequisites

- **Node.js 20 or newer.**
- **Claude Code**, installed and run at least once. Switchboard reads the session transcripts Claude Code writes under `~/.claude/`.

## Install

```sh
npm install -g @ritualapps/switchboard
```

Then once, to wire Switchboard into Claude Code (this modifies `~/.claude/settings.json`):

```sh
switchboard install-hook
```

`install-hook` writes:

- A `UserPromptSubmit` hook (`~/.claude/hooks/switchboard-pickup.cjs`) that delivers staged annotations into your CC session.
- A `SessionEnd` hook (`~/.claude/hooks/switchboard-sessionend.cjs`) that marks lines closed when their session ends.
- A custom slash command (`~/.claude/commands/handback.md`) that gives the pickup hook an explicit gesture to listen for: `/handback`.
- The skill packages for `/ringing`, `/blocked-on-input`, and `/checkpoint` (under `~/.claude/skills/<name>/`) so any agent in any CC session can invoke them.

You stage annotations from Switchboard with `h`; you deliver them in CC with `/handback`. The hook is a no-op for any other prompt. See [Handback delivery](#handback-delivery) below for why.

## Run

```sh
switchboard
```

Switchboard reads the transcripts Claude Code writes for every session (`~/.claude/projects/<hash>/<session>.jsonl`) and polls `~/.switchboard/` for emission-protocol contracts. Each session becomes a line on the board. Start a Claude Code session in any terminal; it appears on the board within a couple of seconds.

The terminal window title updates to `Switchboard (N)` where `N` is the count of lines in the NEEDS YOU zone, so you can see unread count even when Switchboard isn't your focused tab.

## Key bindings

**Board:**
- `j` / `k` or arrows: navigate
- `Enter` or `Right-arrow`: plug in to focused line
- `1`-`9`: plug in directly to the line in that slot
- `n` / `N`: walk to next / previous ringing-or-blocked line in the focused zone
- `D`: defer focused line (single keystroke; moves to TO DO zone, no presets, no prompt)
- `u`: un-defer focused line
- `X`: dismiss focused line (high-water-mark; re-rings on new events)
- `h`: hand back (dispatch all drafts across all lines)
- `q`: quit

**Drill-in (navigate step):**
- Arrows or `j` / `k`: move cursor on the body (or on a draft annotation, if any)
- `Right-arrow` or `a`: open annotation input at cursor (body cursor only)
- `Enter` on a focused annotation: re-open for edit (pre-fills existing content)
- `x` on a focused annotation: delete it
- `Esc`, `Left-arrow`, or `q`: disconnect (drafts persist on the line)
- `Ctrl+G`: emergency disconnect

**Drill-in (content step, annotation input active):**
- Type content. `Enter` commits to the per-line draft.
- `Esc`: cancel; content cleared, back to navigate.
- `Left-arrow`: native cursor edit (does NOT cancel; preserves typed content).

## Shell jump

```sh
switchboard cmd 5
# -> claude --resume <session-id>   (copy-paste to resume)
```

`switchboard cmd <N>` prints `claude --resume <session-id>` for the line in slot N; copy-paste the printed command to resume that session. Same identity slot as the board's `1`-`9` keystroke: three surfaces (board, drill-in, shell), one mental model.

The session id is validated as a Claude Code UUID before it is printed, so the output is always a safe, fixed-shape command.

## The emission protocol

Switchboard renders agent sessions through a typed emission protocol. Agents declare what the operator needs to know by writing to predictable substrate paths under `~/.switchboard/`; Switchboard polls and renders deterministically. There is no inference layer on the surface: if an agent doesn't emit, the line doesn't surface.

Three base contracts ship at V1 OSS:

- `/ringing`: agent has a question or artefact for review.
- `/blocked-on-input`: agent is paused waiting on user input (tool approval, external execution).
- `/checkpoint`: agent has reached a milestone worth surfacing as RUNNING-zone enrichment.

See [`CONTRACTS.md`](CONTRACTS.md) for the full protocol: shape, write/clear semantics, precedence rules, and how to add new contracts. New contracts are added via reviewed pull requests.

The base three live in [`skills/`](skills/). Agents conforming to the protocol can invoke them; contributors can add new contracts via PR.

## Handback delivery

Handback is a two-step flow:

1. **In Switchboard, press `h`.** Your annotations stage as a pickup file in `~/.switchboard/`.
2. **In your CC session, type `/handback`.** Claude processes the staged annotations.

`switchboard install-hook` writes `/handback` as a custom slash command in `~/.claude/commands/handback.md`. The pickup hook is gated on this gesture; any other prompt is a no-op at the hook level. Operator-explicit delivery is V1's deliberate design: accidental delivery (you type "ok" and a stale handback fires) hurts more than the small extra keystroke.

### Why not automatic?

The cleanest answer to "how does Switchboard signal Claude Code to start processing without you typing?" isn't obvious inside Claude Code's current hook contract. Hooks are event-OUT (they fire when CC does something), not trigger-IN. There is no documented primitive that lets an external process say "CC, process this now" while CC is sitting idle waiting for input.

A proper design doc for V1.x is in flight. Until it lands, candidate shapes are:

1. **Agent-as-watcher.** Add a snippet to your project's `CLAUDE.md` asking Claude to read `~/.switchboard/pickup-*.md` at end-of-turn and act on contents. Starter recipe in [`examples/agent-as-watcher/`](https://github.com/ritualapps/switchboard/tree/main/examples/agent-as-watcher). Covers active sessions; doesn't bootstrap a cold one.
2. **Long-poll MCP tool + Stop-hook re-enter.** Ship an MCP server whose `await_handback` tool blocks until a pickup lands; the Stop hook returns `block` to keep the turn alive. Bootstraps from one initial prompt, then runs hands-free.
3. **Switchboard manages CC processes.** Switchboard launches Claude Code via a pty (and offers a `/switchboard-take-over` slash command for handoff from sessions you started yourself). Cleanest unconditional answer; the biggest rebuild.
4. **OS-level keystroke injection.** Sends `Enter` to CC's terminal via `SendInput` (Windows) / `cliclick` (macOS) / `ydotool` (Linux). Cross-platform fragile.

If one of these matches how you'd want it solved, drop a thought in [GitHub Discussions](https://github.com/ritualapps/switchboard/discussions) or open a PR into [`examples/`](https://github.com/ritualapps/switchboard/tree/main/examples). Option 1 is the lowest barrier to contribution.

## Defer

Pressing `D` on a focused line moves it from NEEDS YOU / READY FOR REVIEW to the TO DO zone: single keystroke, no presets, no reason capture. You re-engage a deferred line by plugging into it from the TO DO list (`1`-`9` or Enter once focused). Conditional re-ring (defer-with-intent that auto-resurfaces) is V1.x scope.

## Annotations

Cursor lives on the body of the line. Read end-to-end; press `Right-arrow` or `a` at any point to open an annotation input at the cursor's body line.

The annotation primitive is `{anchor, content}` and nothing else. The agent decides what to do with it. There is no target picker because the line itself names the target. There is no authority knob because the agent's existing logic decides what to do under its own authority.

You can walk back through your draft annotations after writing them: arrow keys past the body cursor extend onto the annotation list, `Enter` re-opens an annotation for edit, `x` deletes it. The operator's curated set at hand-back time is the canonical send, with no system-imposed staleness flagging.

## Platform and surface support

Switchboard reads the standard Claude Code transcript files and hooks. Anything that writes them works. Below is what I've confirmed on real machines so far -- help me fill it in by running Switchboard on your setup and opening an issue with the result, good or bad.

**Operating systems**
- **Windows:** verified.
- **macOS (Intel and Apple Silicon), Linux:** should run unchanged. The code is plain Node with no platform paths beyond `~`. I haven't run it on real hardware yet. Reports welcome.
- **Homebrew and other global installs:** untested. If `npm install -g` works on your platform, Switchboard should too. Tell me if it doesn't.

**Claude Code surfaces**
- **CLI (terminal):** verified.
- **VS Code extension, JetBrains plugin, Desktop app:** expected to work, since they write the same `~/.claude/projects/` transcripts and hook paths the CLI uses. Not yet verified. Reports welcome.
- **Web app (`claude.ai/code`):** not supported. It runs in Anthropic's cloud and writes no local transcripts to read.

**Other agent runtimes (Gemini CLI, Codex, and the like)**
Switchboard's reader is Claude Code-specific today: it parses `~/.claude/` transcripts. Other runtimes need a small adapter mapping their transcript and hook format onto the same board model. If you want your runtime supported, open a [Discussion](https://github.com/ritualapps/switchboard/discussions) describing its on-disk format, or a PR adding an adapter. This is the fastest way to widen support.

## State directory

- `~/.switchboard/`: root for all Switchboard state and emission substrate
- `~/.switchboard/history.jsonl`: append-only event log; Switchboard never deletes from this log
- `~/.switchboard/pickup-<sessionId>-<bundleId>.md`: `/ringing` contract substrate + hand-back staging
- `~/.switchboard/deferred-<sessionId>.json`: `/blocked-on-input` contract substrate (a JSON object describing the agent's pending tool requests)
- `~/.switchboard/checkpoints-<sessionId>.jsonl`: `/checkpoint` contract substrate (append-only)
- `~/.switchboard/drafts.json`: per-line draft persistence
- `~/.switchboard/baseline.json`: bootstrap baseline (hides pre-install sessions)

## Troubleshooting

**The board is empty after install.** Switchboard hides sessions that existed before you ran `install-hook` (it writes a baseline at install time). Start a new Claude Code session in any terminal; its line appears within a couple of seconds. Pre-install sessions stay hidden until they advance past the baseline.

**`/handback` does nothing.** Pressing `h` in Switchboard only stages your annotations. Delivery is a separate, deliberate gesture: type `/handback` in the target Claude Code session. Any other prompt is a no-op at the hook level, so a stale batch never fires on an unrelated message.

**Hooks don't fire.** The installed hooks run `node <path-to-hook>`. Make sure `node` is on the PATH that Claude Code uses to launch hooks. `install-hook` is idempotent, so you can safely re-run it after fixing your environment.

**You already had a `~/.claude/settings.json`.** `install-hook` merges its two hook entries into your existing file and never removes hooks it didn't add. It backs the original up to `settings.json.bak` and writes the update atomically. If your existing file was not valid JSON, Switchboard preserves the original bytes at `.bak` and writes a fresh settings file.

## Contributing

The emission protocol is built to extend. New contracts beyond the base three land through a reviewed pull request: add a registry entry, wire a render rule, ship a skill and a reference implementation, and add test coverage. [`CONTRACTS.md`](CONTRACTS.md) documents the full protocol shape and the PR checklist. Working examples of the handback-delivery patterns live in [`examples/`](https://github.com/ritualapps/switchboard/tree/main/examples).

## Using Switchboard

Switchboard is free OSS for solo developers and power Claude Code users: you, your team, whoever.

If you'd like to discuss using Switchboard for your organisation's specific workflow, open an issue: https://github.com/ritualapps/switchboard/issues

## License

MIT.
