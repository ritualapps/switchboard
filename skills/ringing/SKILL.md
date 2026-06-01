---
name: ringing
description: Switchboard /ringing contract. Invoke when the agent has produced a question or artefact the operator must review-and-respond to. Writes a pickup file at ~/.switchboard/pickup-<sessionId>-<bundleId>.md so the operator sees the line in the READY FOR REVIEW (or NEEDS YOU) zone.
---

# /ringing

Switchboard's `ringing` is one of three base emission contracts. Invoke it when the agent has produced a question or artefact the operator must review and respond to before the agent can usefully proceed.

The contract is the **load-bearing emission** for Switchboard's review-and-respond loop. Hand-back from the operator's surface delivers any drafted annotations back to the same substrate path, and Switchboard's installed CC hook (`switchboard-pickup.cjs` registered against `UserPromptSubmit`) injects the file's contents into the agent's next prompt.

## When to invoke

- The agent has reached an inflection point where the operator's judgement is required (a question, a decision, a non-trivial artefact for review).
- The agent has surfaced a substantive answer or proposal the operator should read before next actions.

Do NOT invoke for routine progress logs (use `/checkpoint`); do NOT invoke for tool-approval blocks (use `/blocked-on-input`).

## Substrate

Path: `~/.switchboard/pickup-<sessionId>-<bundleId>.md`

- `<sessionId>` -- the CC session id (UUID).
- `<bundleId>` -- an agent-chosen identifier for this ringing event. Convention: `bundle-<sessionId>-<unix-ms>` so the file sorts chronologically.

The same file path is the **substrate of record** for both directions of the protocol: the agent writes its question/artefact body; on hand-back, Switchboard's dispatcher appends operator annotations below the agent body. The CC pickup hook reads the file on the agent's next `UserPromptSubmit` and injects the contents as prompt context.

## Payload shape

Markdown text. Free-form. The first emission writes the agent's question/artefact body; appended blocks from the operator follow the dispatcher's `--- switchboard annotation (line <id>) ---` separator convention. The agent doesn't need to know about the separator; it writes only its own body.

Minimal example:

```markdown
The migration succeeded on staging but the rollback path doesn't preserve
the `users.created_at` column. Should we ship as-is and patch in 1.1, or
gate ship on the rollback fix?
```

## Render rule (Switchboard side)

- Cell: READY FOR REVIEW zone (or NEEDS YOU if precedence rules elevate it).
- Drill-in: body renders the markdown file's content; cursor lives on the body for annotation.
- Precedence: blocked > ringing > checkpoint. A session with both `pickup-<sessionId>-<bundleId>.md` and `deferred-<sessionId>.json` renders blocked.

## V1 CC adapter built-in

The V1 reducer's pattern-match against CC transcript events (assistant text-block followed by no user response) **derives** ringing for CC-native sessions without an explicit `/ringing` emission. This is the **CC adapter's built-in translation layer** documented in `CONTRACTS.md`. Agents that DO emit `/ringing` directly (via this skill) override the derivation by precedence.

Full agent-side `/ringing` emission (replacing the pattern-match entirely with CC-adapter-emitted pickup files) is a planned extension. The contract ships in place today; explicit emission is the future-extension surface.

## Reference implementation

No standalone executable ships for `/ringing`. The two write paths are:

1. **Implicit:** CC adapter's built-in translation -- the V1 reducer pattern-match in `src/claude-code/reducer.ts:deriveState`. No agent action required.
2. **Explicit:** an agent skill that writes a markdown file at `~/.switchboard/pickup-<sessionId>-<bundleId>.md`. Single-line shell:

```bash
cat > "$HOME/.switchboard/pickup-$CLAUDE_SESSION_ID-bundle-$(date +%s).md" <<'EOF'
<agent's question or artefact>
EOF
```

The hand-back direction (Switchboard -> agent) is handled by `src/dispatch/dispatcher.ts` and the installed `switchboard-pickup.cjs` CC hook; agents do not write the operator-side annotations.

## Stability

Contract shape stable as of v1.0.
