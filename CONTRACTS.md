# Switchboard contracts

Switchboard renders parallel agent sessions through a **typed emission protocol**. Agents declare what the operator needs to know by writing to predictable substrate paths under `~/.switchboard/`; Switchboard polls the directory on a 2s cadence and renders deterministically. There is no inference layer anywhere on the surface: if an agent doesn't emit, the line doesn't surface.

This doc is the public protocol contract for contributors. Three reference contracts ship at V1 OSS; the protocol is extensible thereafter via reviewed pull requests.

## The base three (locked at V1 OSS)

| Contract | Substrate path | Render zone | Skill markdown |
|----------|----------------|-------------|----------------|
| `/ringing` | `~/.switchboard/pickup-<sessionId>-<bundleId>.md` | NEEDS YOU / READY FOR REVIEW | [`skills/ringing/SKILL.md`](skills/ringing/SKILL.md) |
| `/blocked-on-input` | `~/.switchboard/deferred-<sessionId>.json` | NEEDS YOU (precedence over ringing) | [`skills/blocked-on-input/SKILL.md`](skills/blocked-on-input/SKILL.md) |
| `/checkpoint` | `~/.switchboard/checkpoints-<sessionId>.jsonl` | RUNNING enrichment | [`skills/checkpoint/SKILL.md`](skills/checkpoint/SKILL.md) |

### Precedence

When a session has concurrent emissions across multiple zone-driving contracts, the surface picks deterministically:

```
blocked-on-input  >  ringing  >  checkpoint (enrichment-only; does not contend)
```

`blocked-on-input` and `ringing` both drive zone changes. `checkpoint` enriches the cell within whatever zone the session's other emissions resolve to. Operator-state overlays (drafted / deferred / dismissed / closed) compose with substrate-derived state via the existing state machine rules; they do not participate in this precedence ordering.

### Graceful absence

Files under `~/.switchboard/` whose names match no registered contract pattern are **gracefully absent**: they are logged once (history event `contract_render_skipped`) and not rendered. Switchboard does not crash, warn, or render error states for unknown contracts. This makes the directory safe for contributors to drop experimental contracts without breaking the surface.

Surface-owned files (`history.jsonl`, `drafts.json`, `dismissals.jsonl`, `baseline.json`, `deferrals.jsonl`, `closed.jsonl`) are recognised as state, not contracts; they don't trigger graceful-absence logging.

## The protocol shape

Every contract is defined by four primitives:

1. **Skill prompt**: the markdown the agent reads to know when and how to invoke the contract. Lives in `skills/<contract-name>/SKILL.md`.
2. **Payload shape**: the substrate file's content schema. Markdown / JSON / JSONL depending on the contract.
3. **Substrate path**: the canonical `~/.switchboard/<pattern>` location, with `<sessionId>` (and optionally `<bundleId>`) placeholders.
4. **Render rule**: how Switchboard's surface presents the emission. The registered base three live in `src/contracts/registry.ts`; the render rule itself is `applySubstrateOverlay` in `src/contracts/overlay.ts`, which `src/adapter.ts` calls during its scan.

A contract is the **promise** an agent makes to the operator. The substrate path is the canonical home; the skill prompt is how the agent learns to keep the promise; the render rule is how the operator sees it. All three move together (`feedback_canonical_by_position`).

## V1 CC adapter built-in

The V1 reducer (`src/claude-code/reducer.ts:deriveState`) pattern-matches CC transcript events to derive `ringing` and `in_progress` states. This is a CC-substrate-to-contract translation: it does what an explicit CC adapter component would do if `/ringing` were emitted per-event by the agent.

Under V2 MVP this **ships as the CC adapter's built-in behaviour** for backwards compatibility with CC sessions that don't (yet) call `/ringing` explicitly. The translation:

- Assistant message ending with a text block AND no following user message -> `ringing` (operator's review needed).
- Assistant message ending with a tool_use block, OR user message with tool_result -> `in_progress` (agent has work in hand).
- No events -> `idle`.

Agents that DO emit `/ringing` explicitly (by writing a pickup file from their skill) override the derivation by precedence. Full agent-side emission (replacing the CC adapter's built-in with explicit emission from a CC skill) is a planned extension.

The `blocked-on-input` derivation has **no built-in translation**. The V1 reducer comment explicitly says `blocked` is reserved for "the agent's explicit blocked-on-input signal when emitted". Under V2 this signal IS the `/blocked-on-input` contract; no inference, no fallback.

## Adding a new contract

New contracts beyond the base three are added through a reviewed pull request. The PR shape:

1. Add a row to `src/contracts/registry.ts`'s `CONTRACTS` array. Each row is a `ContractDefinition`:

   ```ts
   interface ContractDefinition {
     kind: ContractKind;      // the contract's name, e.g. 'ringing'
     pattern: string;         // filename template, e.g. 'pickup-<sessionId>-<bundleId>.md'
                              //   (a string with <sessionId> / <bundleId> placeholders, not a RegExp)
     zone: Zone;              // 'ringing' | 'blocked' | 'enrichment'
     precedence: number;      // higher wins when a session has concurrent zone-driving emissions
   }
   ```

2. Add the parse case to `parseContractFilename` in the same file (it turns a real filename back into `{ kind, sessionId, bundleId? }`).
3. Update the render rule in `src/contracts/overlay.ts:applySubstrateOverlay` (for zone-drivers), which `src/adapter.ts` calls during its scan, or wire enrichment into the relevant TUI component (for enrichment contracts).
4. Ship `skills/<contract-name>/SKILL.md` documenting when / how the agent invokes.
5. Ship a reference implementation (`skills/<contract-name>/<contract-name>.cjs` or equivalent) so contributors and the standard install path have something to point at.
6. Add unit coverage in `tests/contracts.test.ts` and integration coverage in `tests/adapter-substrate.test.ts`.
7. Update this doc with the new row.

A maintainer reviews the PR. Merged contracts ship in the next release. Until a contract is registered, agents can still emit it, but the file hits graceful-absence (the file lands; no render fires).

## Concurrency & race notes

- All writes are atomic per OS file semantics (single `writeFileSync` for JSON; append-only for markdown / jsonl). Switchboard reads on a 2s poll; the worst-case render lag is one tick.
- The substrate is shared between agent and surface. Both sides must tolerate the other side rewriting files. The current contracts ship with this assumption baked in: `deferred-<sessionId>.json` is overwritten in place; `pickup-<sessionId>-<bundleId>.md` is append-friendly (operator annotations land below the agent body); `checkpoints-<sessionId>.jsonl` is append-only.
- Clearing emissions: agents remove their own emission files when the block resolves (`/blocked-on-input --clear`) or when the bundle is consumed (Switchboard's dispatcher removes pickup files on hand-back's behalf via the CC pickup hook). Switchboard never deletes an emission file the agent owns.

## Stability

This contract shape is stable as of v1.0. The base three are locked at V1 OSS; new contracts are added through the reviewed pull-request process above.
