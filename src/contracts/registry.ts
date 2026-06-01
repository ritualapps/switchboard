/**
 * Contract registry.
 *
 * Canonical home for the three base contracts:
 *
 *   /ringing          -> pickup-<sessionId>-<bundleId>.md   -> zone NEEDS YOU
 *   /blocked-on-input -> deferred-<sessionId>.json          -> zone NEEDS YOU
 *   /checkpoint       -> checkpoints-<sessionId>.jsonl      -> RUNNING enrichment
 *
 * The registry is data, not behaviour: it names the contracts the surface
 * knows about. The substrate enumerator (`./enumerate.ts`) walks
 * `~/.switchboard/` against this registry; files matching a registered
 * pattern produce a `ContractEmission`; files matching no registered
 * pattern are gracefully absent (contracts with no defined render rule are
 * logged but not rendered).
 *
 * `precedence` resolves concurrent emissions: when a session has emissions
 * across multiple zone-driving contracts, the higher-precedence contract
 * wins. `blocked-on-input` > `ringing` > `checkpoint` (the checkpoint
 * contract is enrichment-only and does not contend with the zone-drivers).
 *
 * Expanding the protocol: new contracts beyond the base three land via PR.
 * The PR adds an entry to this registry, plus a render rule in `adapter.ts`,
 * plus a skill markdown under `skills/`.
 */

import type { ContractKind } from '../types.js';

export type Zone = 'ringing' | 'blocked' | 'enrichment';

export interface ContractDefinition {
  kind: ContractKind;
  /**
   * Filename pattern, with `<sessionId>` and optionally `<bundleId>` as
   * placeholders. Used by `parseContractFilename` to extract sessionId
   * and bundleId from a real filename.
   */
  pattern: string;
  zone: Zone;
  /** Higher precedence wins under the concurrent-emission rule. */
  precedence: number;
}

export const CONTRACTS: readonly ContractDefinition[] = Object.freeze([
  // blocked-on-input first so the array order matches precedence order
  // (incidental; the precedence number is the source of truth).
  {
    kind: 'blocked-on-input' as const,
    pattern: 'deferred-<sessionId>.json',
    zone: 'blocked' as const,
    precedence: 2,
  },
  {
    kind: 'ringing' as const,
    pattern: 'pickup-<sessionId>-<bundleId>.md',
    zone: 'ringing' as const,
    precedence: 1,
  },
  {
    kind: 'checkpoint' as const,
    pattern: 'checkpoints-<sessionId>.jsonl',
    zone: 'enrichment' as const,
    precedence: 0,
  },
]);

export interface ParsedContractFilename {
  kind: ContractKind;
  sessionId: string;
  bundleId?: string;
}

/**
 * Parse a basename from `~/.switchboard/` against the registered contracts.
 * Returns `null` for filenames matching no contract (gracefully absent;
 * callers may log `contract_render_skipped` but must not throw).
 *
 * The sessionId fragment is required to look like a uuid -- 8-4-4-4-12 hex
 * with dashes -- because Switchboard's session ids are CC's session uuids
 * and the lookup against `lines` keys on that shape. Any non-uuid match
 * routes to graceful absence to keep the surface deterministic.
 */
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const SESSION_ID_RE = new RegExp(`^${UUID_RE}$`);

/**
 * A Switchboard session id is a Claude Code session UUID (8-4-4-4-12 hex).
 * Validating against this shape before a session id reaches a command line is
 * load-bearing: `switchboard cmd N` prints a `claude --resume <id>` string and
 * the id originates as a transcript filename stem, which any local process can
 * control. Refusing a non-UUID id keeps a hostile filename
 * (e.g. `$(...).jsonl`) out of the operator's shell.
 */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function parseContractFilename(filename: string): ParsedContractFilename | null {
  // `/ringing` pickup-<sessionId>-<bundleId>.md
  const pickupRe = new RegExp(`^pickup-(${UUID_RE})-(.+)\\.md$`);
  const pickup = pickupRe.exec(filename);
  if (pickup) {
    return {
      kind: 'ringing',
      sessionId: pickup[1]!,
      bundleId: pickup[2]!,
    };
  }
  // `/blocked-on-input` deferred-<sessionId>.json
  const deferredRe = new RegExp(`^deferred-(${UUID_RE})\\.json$`);
  const deferred = deferredRe.exec(filename);
  if (deferred) {
    return {
      kind: 'blocked-on-input',
      sessionId: deferred[1]!,
    };
  }
  // `/checkpoint` checkpoints-<sessionId>.jsonl
  const checkpointRe = new RegExp(`^checkpoints-(${UUID_RE})\\.jsonl$`);
  const checkpoint = checkpointRe.exec(filename);
  if (checkpoint) {
    return {
      kind: 'checkpoint',
      sessionId: checkpoint[1]!,
    };
  }
  return null;
}

/**
 * Given a per-session emission list, pick the zone-driving emission.
 * Enrichment contracts (checkpoint) do not contend; the caller composes them
 * into the chosen zone separately.
 *
 * Returns `null` when no zone-driving emission is present.
 */
export function pickZoneDriver(
  emissions: ReadonlyArray<{ kind: ContractKind }>
): { kind: ContractKind } | null {
  let best: { kind: ContractKind; precedence: number } | null = null;
  for (const em of emissions) {
    const def = CONTRACTS.find((c) => c.kind === em.kind);
    if (!def) continue;
    if (def.zone === 'enrichment') continue;
    if (!best || def.precedence > best.precedence) {
      best = { kind: em.kind, precedence: def.precedence };
    }
  }
  return best ? { kind: best.kind } : null;
}
