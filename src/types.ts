/**
 * Switchboard type definitions.
 *
 * Core noun: Line (a switchboard line; one agent's work-in-progress).
 * Annotation primitive is narrow: { anchor, content }. Target and authority
 * are agent-side concerns, not switchboard's. Hand-back is single-target per
 * drafted line: one reply per line to that line's own agent.
 */

// ============================================================================
// Line state machine
// ============================================================================

/**
 * Per-line state. Transitions are operator actions (plug-in, disconnect,
 * defer, hand-back) and agent events (ring, blocked-on-input, progress,
 * completion).
 *
 * `in-progress` covers "agent is auto-proceeding within granted authority"
 * -- visible on the board so the returning operator sees what's still
 * running.
 */
export type LineState =
  | 'idle'
  | 'ringing'
  | 'plugged_in'
  | 'drafted'
  | 'in_progress'
  | 'blocked'
  | 'deferred'
  | 'completed'
  | 'dismissed'
  | 'closed';

export const LINE_STATE_LABEL: Record<LineState, string> = {
  idle: 'IDLE',
  ringing: 'RINGING',
  plugged_in: 'PLUGGED IN',
  drafted: 'DRAFTED',
  in_progress: 'IN PROGRESS',
  blocked: 'BLOCKED',
  deferred: 'DEFERRED',
  completed: 'COMPLETED',
  dismissed: 'DISMISSED',
  closed: 'CLOSED',
};

// ============================================================================
// Bundle = current HITL checkpoint on a line
// ============================================================================

export interface Bundle {
  id: string;
  lineId: string;
  createdAt: string;
  /** The body the operator reads (recent agent output). */
  body: string;
  /** Short one-line summary for the board cell footer / hover. */
  summary: string;
}

// ============================================================================
// Annotation primitive
// ============================================================================

/**
 * Anchor: where on the body the annotation lives.
 * `body_position`: cursor-on-body inline annotation at a specific line.
 * `closing`: closing reply, no body anchor.
 */
export type AnnotationAnchor =
  | { kind: 'body_position'; line: number; lineEnd?: number }
  | { kind: 'closing' };

export interface Annotation {
  id: string;
  anchor: AnnotationAnchor;
  content: string;
}

export interface LineDraft {
  lineId: string;
  bundleId: string;
  startedAt: string;
  annotations: Annotation[];
}

// ============================================================================
// Line (the switchboard line itself)
// ============================================================================

export interface Line {
  id: string;
  title: string;
  projectPath: string;
  projectName: string;
  projectHash: string;
  transcriptPath: string;
  state: LineState;
  /** Set by operator override; absent = state derived from agent events. */
  stateManual?: LineState;
  startedAt: string;
  lastEventAt: string;
  lastEventSummary: string;
  /** Set when waiting on operator HITL. */
  currentBundle: Bundle | null;
  /** Active deferral state, if any. */
  deferral: Deferral | null;
  /** Signal counts for capacity computation. */
  capacitySignals: CapacitySignals;
  /** Total raw event count from the agent transcript. */
  eventCount: number;
}

// ============================================================================
// Capacity (derived primitive)
// ============================================================================

/**
 * Capacity signals derived from observable agent behaviour (not self-report).
 * Composed into a CapacityBand by capacity/indicator.ts.
 */
export interface CapacitySignals {
  /** Pending directives in this line's agent queue. */
  queueDepth: number;
  /** Events per minute over the last N minutes. */
  recentEventRate: number;
  /** ms since last event from the agent. */
  msSinceLastEvent: number;
}

export type CapacityBand = 'quiet' | 'steady' | 'heavy' | 'blocked';

export const CAPACITY_BAND_LABEL: Record<CapacityBand, string> = {
  quiet: 'quiet',
  steady: 'steady',
  heavy: 'heavy',
  blocked: 'blocked',
};

// ============================================================================
// Deferral (operator state: defer-with-intent + conditional surfacing)
// ============================================================================

/**
 * Deferral condition. Re-rings the line when met.
 *
 * `cron` is the escape hatch for anything the named conditions do not
 * cover. Power users use it directly; operator picks named conditions
 * for the common cases.
 */
export type DeferralCondition =
  | { kind: 'overnight' }
  | { kind: 'weekend' }
  | { kind: 'until_time'; iso: string }
  | { kind: 'until_day'; dayOfWeek: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' }
  | { kind: 'until_device_context'; context: 'at_desktop' | 'on_mobile' | string }
  | { kind: 'cron'; expression: string };

export interface Deferral {
  /**
   * Optional condition for auto-resurface.
   *
   * `null` in the current flow: defer is a plain NEEDS YOU -> TO DO zone
   * transition, and the operator re-engages by plugging in from TO DO.
   * Conditional re-ring is a later addition. The cron / overnight / weekend /
   * until_time / until_day / until_device_context machinery already lives in
   * `defer/conditions.ts` + `defer/checker.ts`; the checker no-ops on a null
   * condition until that feature turns on.
   */
  condition: DeferralCondition | null;
  /** Operator-stated reason (renders as context on re-plug-in). Empty in the
   *  current flow because there is no prompt for it; a later version
   *  re-introduces the prompt when conditional re-ring returns. */
  reason: string;
  createdAt: string;
}

// ============================================================================
// Dispatch result
// ============================================================================

export interface DispatchOutcome {
  annotationId: string;
  ok: boolean;
  detail: string;
  at: string;
}

export interface DispatchReport {
  lineCount: number;
  annotationCount: number;
  outcomes: DispatchOutcome[];
  summary: string;
}

// ============================================================================
// History event (audit substrate)
// ============================================================================

/**
 * Append-only event log entry. Keyed by line id; cross-cutting time-ordered
 * across all lines via the underlying JSONL file.
 *
 * Each event carries the full context needed to reconstruct line history
 * post-hoc. Lines are never deleted from this log; completed lines remain
 * queryable.
 */
export type HistoryEventKind =
  | 'ring'
  | 'plug_in'
  | 'disconnect'
  | 'draft_add'
  | 'hand_back'
  | 'dispatch'
  | 'dispatch_error'
  | 'defer'
  | 'condition_met'
  | 'blocked_on_input'
  | 'blocked_on_input_cleared'
  | 'agent_progress'
  | 'completed'
  | 'dismiss'
  | 'closed_via_platform'
  | 'baseline_set'
  | 'contract_render_skipped';

export interface HistoryEvent {
  id: string;
  lineId: string;
  kind: HistoryEventKind;
  at: string;
  payload: Record<string, unknown>;
}

// ============================================================================
// Emission protocol
// ============================================================================

/**
 * The three base contract kinds the protocol recognises.
 *
 * `ringing` -- agent has produced a question/artefact the operator must
 *              review-and-respond to. Substrate: pickup-<sessionId>-<bundleId>.md
 * `blocked-on-input` -- agent has paused, needing user input the agent
 *              cannot resolve under its own logic. Substrate:
 *              deferred-<sessionId>.json (Pydantic AI DeferredToolRequests shape)
 * `checkpoint` -- agent has reached a milestone worth surfacing as RUNNING-
 *              zone enrichment. Substrate: checkpoints-<sessionId>.jsonl
 */
export type ContractKind = 'ringing' | 'blocked-on-input' | 'checkpoint';

/**
 * A contract emission discovered by the adapter's substrate scan. One per
 * file under ~/.switchboard/ that matches a registered contract.
 *
 * `kind` -- which contract this file emits against.
 * `sessionId` -- the session this emission belongs to.
 * `bundleId` -- only present for `ringing` (pickup files carry a bundle).
 * `filename` -- the basename in ~/.switchboard/ for audit / log purposes.
 * `mtimeMs` -- last-modified timestamp; used for "latest emission" ordering.
 * `payload` -- parsed contents for contracts that ship a structured payload
 *              (e.g. `/blocked-on-input` ships DeferredToolRequests).
 *              `null` for markdown/jsonl substrates that are read lazily.
 */
export interface ContractEmission {
  kind: ContractKind;
  sessionId: string;
  bundleId?: string;
  filename: string;
  mtimeMs: number;
  /** Parsed payload for `/blocked-on-input` (Pydantic AI DeferredToolRequests).
   *  `null` for contracts whose substrate is read lazily (`/ringing` markdown;
   *  `/checkpoint` jsonl -- the latest event is exposed via `checkpointLatest`
   *  while the full trail is read by drill-in on demand). */
  payload: BlockedPayload | null;
  /** Latest `/checkpoint` event for RUNNING-zone enrichment. Populated only
   *  when `kind === 'checkpoint'`; the full jsonl trail is read lazily by
   *  callers that need it (drill-in body). */
  checkpointLatest?: CheckpointEvent;
}

/**
 * `/checkpoint` payload shape. One JSONL record per checkpoint event.
 * Append-only -- agents add records as milestones land; the surface reads
 * the latest for cell enrichment and the full trail for drill-in.
 */
export interface CheckpointEvent {
  /** ISO timestamp of the event. */
  ts: string;
  /** Human-readable message the agent surfaces to the operator. */
  message: string;
  /** Optional milestone index (1-based); paired with milestoneTotal renders as "i/N". */
  milestoneIndex?: number;
  /** Optional milestone total; paired with milestoneIndex. */
  milestoneTotal?: number;
}

/**
 * `/blocked-on-input` payload shape. Mirror of Pydantic AI's
 * `DeferredToolRequests` dataclass serialised to JSON. Only the fields the
 * surface actually renders are typed strictly; unknown fields pass through
 * without type-checking so the protocol is non-breaking for additions.
 *
 * The intent is: agents under any framework can emit this shape. Pydantic
 * AI agents serialise their `DeferredToolRequests` directly. Non-Pydantic
 * agents construct an equivalent object and write it.
 */
export interface BlockedPayload {
  calls?: Array<BlockedToolCall>;
  approvals?: Array<BlockedToolCall>;
  metadata?: Record<string, Record<string, unknown>>;
}

export interface BlockedToolCall {
  tool_name: string;
  tool_call_id: string;
  args?: Record<string, unknown>;
}
