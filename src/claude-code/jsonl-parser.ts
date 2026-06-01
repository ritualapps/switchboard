/**
 * Parse a single line from a Claude Code JSONL transcript into a typed event.
 * Returns null for unparseable lines (truncated tails, malformed).
 *
 * Observed event types (from `~/.claude/projects/<hash>/<session-uuid>.jsonl`):
 *   - permission-mode
 *   - file-history-snapshot
 *   - user (with message.content as string OR an array of tool_result blocks)
 *   - assistant (with message.content as array of text or tool_use blocks)
 *   - summary (occasionally)
 */

export type CcEventType =
  | 'permission-mode'
  | 'file-history-snapshot'
  | 'user'
  | 'assistant'
  | 'summary'
  | 'ai-title'
  | 'custom-title'
  | 'queue-operation'
  | 'unknown';

export interface CcEvent {
  type: CcEventType;
  raw: any;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  permissionMode?: string;
}

export interface CcAssistantText {
  type: 'text';
  text: string;
}

export interface CcAssistantToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CcUserToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
}

/**
 * Upper bound on a single JSONL line we will attempt to parse. A transcript is
 * untrusted input; a pathological multi-megabyte line would make `JSON.parse`
 * allocate without bound. Real Claude Code events are far smaller, so skipping
 * an over-length line loses nothing legitimate while capping memory.
 */
const MAX_LINE_BYTES = 2 * 1024 * 1024;

export function parseJsonlLine(line: string): CcEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LINE_BYTES) return null;
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const t = obj.type;
  const known: CcEventType[] = [
    'permission-mode',
    'file-history-snapshot',
    'user',
    'assistant',
    'summary',
    'ai-title',
    'custom-title',
    'queue-operation',
  ];
  const type: CcEventType = known.includes(t) ? t : 'unknown';
  return {
    type,
    raw: obj,
    sessionId: obj.sessionId,
    uuid: obj.uuid,
    parentUuid: obj.parentUuid ?? null,
    timestamp: obj.timestamp,
    cwd: obj.cwd,
    gitBranch: obj.gitBranch,
    version: obj.version,
    permissionMode: obj.permissionMode,
  };
}

export function assistantContentBlocks(
  ev: CcEvent
): Array<CcAssistantText | CcAssistantToolUse> {
  const content = ev?.raw?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b: any) => b && (b.type === 'text' || b.type === 'tool_use')
  ) as Array<CcAssistantText | CcAssistantToolUse>;
}

export function userToolResults(ev: CcEvent): CcUserToolResult[] {
  const content = ev?.raw?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b: any) => b && b.type === 'tool_result'
  ) as CcUserToolResult[];
}

export function userTextContent(ev: CcEvent): string | null {
  const content = ev?.raw?.message?.content;
  if (typeof content === 'string') return content;
  return null;
}

export function assistantUsage(ev: CcEvent): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
} | null {
  const u = ev?.raw?.message?.usage;
  if (!u) return null;
  return {
    input: Number(u.input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
    cacheRead: Number(u.cache_read_input_tokens ?? 0),
    cacheCreation: Number(u.cache_creation_input_tokens ?? 0),
  };
}

export function assistantModel(ev: CcEvent): string | undefined {
  const m = ev?.raw?.message?.model;
  return typeof m === 'string' ? m : undefined;
}
