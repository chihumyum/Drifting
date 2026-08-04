/**
 * Provider-neutral context planning and compaction.
 *
 * Canonical message rows remain the source of truth. This planner only creates
 * a verified projection for one provider call and a V2 checkpoint envelope
 * describing that projection. It never rewrites, retires, or replaces source
 * rows.
 */

import {
  WORKSPACE_COMPLETE_READ_MODEL_MARKER,
  WORKSPACE_NOOP_WRITE_MODEL_MARKER,
} from './drifting-workspace-tool-contract';

export const AGENT_CONTEXT_CHECKPOINT_VERSION = 2 as const;
export const AGENT_CONTEXT_CHECKPOINT_FORMAT = 'drifting.agent-context-checkpoint' as const;

const MIN_OUTPUT_RESERVE_TOKENS = 4_096;
const SAFETY_MARGIN_RATIO = 0.1;
const DEFAULT_COMPACTION_TIMEOUT_MS = 8_000;
const SOURCE_SEGMENT_OVERHEAD_TOKENS = 6;
const SUMMARY_SEGMENT_OVERHEAD_TOKENS = 8;
const MAX_RECENT_EXACT_TOKENS = 64_000;
// Exact recent rows are useful, but they must not consume every token left
// after semantic pins. Long tool turns also carry already-compacted summaries;
// filling the entire remainder with fresh read results can leave no room for
// those summaries and make the next compaction mathematically impossible.
// Large (200k/1m) windows still retain the 64k cap, while smaller windows keep
// at least half of the non-semantic budget available for compacted history.
const MAX_RECENT_EXACT_BUDGET_RATIO = 0.5;
// Authored document reads are the Agent's active working set. If several
// chapters were opened for one edit campaign, compressing half of them before
// the next model iteration makes the model reopen the same prose forever.
// Prefer keeping those exact reads while they fit, then rely on the existing
// soft-release path if accumulated summaries genuinely need the room.
const MAX_AUTHORED_READ_EXACT_BUDGET_RATIO = 0.8;
const AGENT_CONTEXT_SOURCE_KINDS: ReadonlySet<AgentContextSourceKind> = new Set([
  'system_policy',
  'user',
  'assistant_narrative',
  'thinking',
  'tool_call',
  'tool_result',
  'write_receipt',
  'write_review',
  'write_revert',
  'read_progress',
  'freshness',
  'task_plan',
  'task_constraints',
]);

export type AgentContextClass = 'pinned' | 'compressible' | 'discardable';
export type AgentContextToolAccess = 'read' | 'write' | 'denied';

export type AgentContextSourceKind =
  | 'system_policy'
  | 'user'
  | 'assistant_narrative'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'write_receipt'
  | 'write_review'
  | 'write_revert'
  | 'read_progress'
  | 'freshness'
  | 'task_plan'
  | 'task_constraints';

export interface AgentContextSourceRow {
  /** Stable canonical row identity. */
  sourceId: string;
  /** Stable provider-history order. Timestamps must not be used for ordering. */
  ordinal: number;
  /**
   * Canonical turn order. `null` is reserved for session-wide policy/freshness
   * rows. Tool call ids are scoped by this value because providers may reuse
   * call ids in later turns.
   */
  turnOrdinal: number | null;
  kind: AgentContextSourceKind;
  /**
   * Exact provider-neutral payload. The planner treats this string as opaque
   * and must preserve it byte-for-byte whenever the row is projected directly.
   */
  content: string;
  callId?: string;
  toolName?: string;
  toolAccess?: AgentContextToolAccess;
}

export interface AgentContextSummaryCandidate {
  summaryId: string;
  /** Canonical source ids represented by this summary. */
  sourceIds: readonly string[];
  /** SHA-256 of the exact canonical source rows, not of the summary text. */
  sourceHash: string;
  content: string;
}

/**
 * One already topology-safe unit offered to a hierarchical full compactor.
 *
 * `sourceRows` always contains the exact canonical rows used for hashing and
 * final coverage validation. `projectionRows` is the bounded material the
 * compactor may actually send to its model: it can contain exact source rows
 * or an earlier verified summary that represents many canonical rows.
 */
export interface AgentContextFullCompactionUnit {
  sourceRows: readonly AgentContextSourceRow[];
  projectionRows: readonly AgentContextFullCompactionProjectionRow[];
  estimatedTokens: number;
}

export interface AgentContextFullCompactionProjectionRow {
  type: 'source' | 'summary';
  sourceIds: readonly string[];
  content: string;
  kind?: AgentContextSourceKind;
  turnOrdinal?: number | null;
  toolName?: string;
  toolAccess?: AgentContextToolAccess;
  summaryId?: string;
}

export type AgentContextConstraintKind =
  | 'session_goal'
  | 'author_instruction'
  | 'author_veto'
  | 'author_fact'
  | 'legacy_user';

/**
 * A first-class reason an old user row must remain byte-exact. The row hash is
 * mandatory: a stale ledger can never pin a different revision of the text.
 */
export interface AgentContextConstraintLedgerEntry {
  constraintId: string;
  sourceId: string;
  sourceHash: string;
  kind: AgentContextConstraintKind;
}

/**
 * Product-verified durable evidence that a pinned supplemental source replaces
 * one historical write-tool call/result pair for context purposes.
 *
 * Supplying this evidence never removes either canonical row. It only makes a
 * strictly matching pair eligible for verified compaction; the evidence row
 * itself remains semantic-pinned.
 */
export interface AgentContextDurableWriteEvidence {
  evidenceSourceId: string;
  turnOrdinal: number;
  callId: string;
  toolName: string;
}

export interface AgentContextFullCompactionRequest {
  /**
   * Contiguous, unpinned source runs that are safe to summarize. A callback
   * may return one or more summaries, but every summary must stay within one
   * run and preserve complete read-tool call/result pairs.
   */
  eligibleRuns: readonly (readonly AgentContextSourceRow[])[];
  /**
   * Current verified projection grouped into atomic units. Product compactors
   * should prefer this view because it can roll up earlier summaries without
   * replaying their full canonical source bytes to the provider. The legacy
   * `eligibleRuns` view remains for provider-neutral/custom compactors that
   * only understand exact source rows.
   */
  eligibleProjectionRuns?: readonly (readonly AgentContextFullCompactionUnit[])[];
  currentEstimatedTokens: number;
  usableInputBudgetTokens: number;
  /** Optional runtime route used by product compactors to reuse the active provider. */
  sessionId?: string;
  turnId?: string;
  provider?: string;
  model?: string;
  signal: AbortSignal;
}

export type AgentContextFullCompactor = (
  request: AgentContextFullCompactionRequest,
) => Promise<readonly AgentContextSummaryCandidate[]>;

export type AgentContextTokenEstimator = (text: string) => number;

export interface AgentContextPlannerInput {
  contextWindowTokens: number;
  requestedOutputTokens: number;
  /**
   * Provider input that is not represented by `sourceRows`, including the
   * selected tool schemas and provider framing overhead. Callers must compute
   * this before every model invocation; it is deducted after the output
   * reserve and the full-window safety margin.
   */
  fixedInputTokens: number;
  sourceRows: readonly AgentContextSourceRow[];
  /**
   * `undefined` preserves the P4 fail-safe and pins every user row. Supplying a
   * verified ledger (including an empty one) upgrades to P5 policy: only listed
   * constraints and a bounded recent, tool-topology-safe suffix stay exact,
   * while old ordinary user dialogue becomes eligible for compaction.
   */
  constraintLedger?: readonly AgentContextConstraintLedgerEntry[];
  /**
   * Omitted by default. Drifting's product composition may populate this only
   * from durable settled write reviews or canonical long-task snapshots.
   */
  durableWriteEvidence?: readonly AgentContextDurableWriteEvidence[];
  deterministicSummaries?: readonly AgentContextSummaryCandidate[];
  fullCompactor?: AgentContextFullCompactor;
  compactionCircuit?: AgentContextCompactionCircuitBreaker;
  compactionTimeoutMs?: number;
  estimateTokens?: AgentContextTokenEstimator;
  signal?: AbortSignal;
}

export interface AgentContextSourceSegment {
  type: 'source';
  row: AgentContextSourceRow;
  classification: AgentContextClass;
  pinReason: 'semantic' | 'recent_turn' | null;
  sourceHash: string;
  estimatedTokens: number;
}

export interface AgentContextSummarySegment {
  type: 'summary';
  summaryId: string;
  sourceIds: string[];
  sourceHash: string;
  summaryHash: string;
  content: string;
  estimatedTokens: number;
  producer: 'deterministic' | 'full_compactor';
}

export type AgentContextProjectionSegment = AgentContextSourceSegment | AgentContextSummarySegment;

export interface AgentContextCheckpointV2 {
  schemaVersion: typeof AGENT_CONTEXT_CHECKPOINT_VERSION;
  format: typeof AGENT_CONTEXT_CHECKPOINT_FORMAT;
  budget: {
    contextWindowTokens: number;
    requestedOutputTokens: number;
    reservedOutputTokens: number;
    safetyMarginTokens: number;
    fixedInputTokens: number;
    usableInputBudgetTokens: number;
    initialEstimatedTokens: number;
    finalEstimatedTokens: number;
  };
  canonicalSources: {
    sourceCount: number;
    sourceOrderHash: string;
  };
  pinned: {
    sourceIds: string[];
    sourceHash: string;
  };
  constraintLedger: {
    mode: 'legacy_all_user' | 'verified';
    entries: AgentContextConstraintLedgerEntry[];
    ledgerHash: string;
    /**
     * New checkpoints carry an explicit exact-retention witness. Optional only
     * so checkpoints written before Milestone F remain recoverable.
     */
    retentionWitness?: {
      status: 'exact';
      sourceIds: string[];
      sourceHash: string;
    };
  };
  coverage: {
    representedSourceIds: string[];
    discardedSourceIds: string[];
    coverageHash: string;
  };
  projection: {
    segments: AgentContextProjectionSegment[];
    contextHash: string;
  };
  compaction: {
    stages: Array<'drop_discardable' | 'deterministic_summaries' | 'full_compactor'>;
    fullCompactionCount: number;
    circuitState: AgentContextCompactionCircuitSnapshot;
  };
}

export interface AgentContextPlan {
  segments: AgentContextProjectionSegment[];
  estimatedInputTokens: number;
  usableInputBudgetTokens: number;
  checkpoint: AgentContextCheckpointV2;
}

export type AgentContextPlannerFailureCode =
  | 'INVALID_CONTEXT'
  | 'HASH_UNAVAILABLE'
  | 'PINNED_CONTEXT_EXCEEDS_BUDGET'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'INVALID_SUMMARY'
  | 'COMPACTOR_FAILED'
  | 'COMPACTOR_TIMEOUT'
  | 'COMPACTOR_ABORTED'
  | 'COMPACTION_CIRCUIT_OPEN'
  | 'COMPACTOR_NO_GAIN';

export type AgentContextPlannerResult =
  | { ok: true; plan: AgentContextPlan }
  | {
      ok: false;
      error: {
        code: AgentContextPlannerFailureCode;
        message: string;
      };
      diagnostics: {
        usableInputBudgetTokens: number | null;
        estimatedInputTokens: number | null;
        fullCompactionCount: number;
        circuitState: AgentContextCompactionCircuitSnapshot;
      };
    };

export interface AgentContextCompactionCircuitSnapshot {
  state: 'closed' | 'open';
  reason: string | null;
  failureCount: number;
}

/**
 * Caller-owned breaker. Keep one instance per runtime session/provider epoch;
 * an explicit reset should happen only after the caller changes that boundary.
 */
export class AgentContextCompactionCircuitBreaker {
  private reason: string | null = null;
  private failureCount = 0;

  isOpen(): boolean {
    return this.reason !== null;
  }

  trip(reason: string): void {
    this.failureCount += 1;
    if (this.reason === null) this.reason = reason;
  }

  reset(): void {
    this.reason = null;
    this.failureCount = 0;
  }

  snapshot(): AgentContextCompactionCircuitSnapshot {
    return {
      state: this.isOpen() ? 'open' : 'closed',
      reason: this.reason,
      failureCount: this.failureCount,
    };
  }
}

interface ContextBudget {
  contextWindowTokens: number;
  requestedOutputTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  fixedInputTokens: number;
  usableInputBudgetTokens: number;
}

interface ToolPair {
  key: string;
  call: AgentContextSourceRow;
  result: AgentContextSourceRow;
}

interface WorkingProjection {
  segments: AgentContextProjectionSegment[];
  coverage: Map<string, { type: 'source' } | { type: 'summary'; id: string }>;
  summaryIds: Set<string>;
}

interface SummaryBatchResult {
  projection: WorkingProjection;
  gainedTokens: number;
}

class PlannerFailure extends Error {
  constructor(
    readonly code: AgentContextPlannerFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlannerFailure';
  }
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalJsonValue(
  value: unknown,
  path = 'value',
  ancestors = new WeakSet<object>(),
): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PlannerFailure('INVALID_CONTEXT', `${path} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new PlannerFailure('INVALID_CONTEXT', `${path} contains unsupported ${typeof value}.`);
  }
  if (ancestors.has(value)) {
    throw new PlannerFailure('INVALID_CONTEXT', `${path} contains a cycle.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => canonicalJsonValue(entry, `${path}[${index}]`, ancestors));
    }
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      output[key] = canonicalJsonValue(child, `${path}.${key}`, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new PlannerFailure(
      'HASH_UNAVAILABLE',
      'Web Crypto SHA-256 is unavailable; context cannot be verified.',
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${bytesToHex(digest)}`;
}

function canonicalSourceShape(row: AgentContextSourceRow): CanonicalJson {
  return canonicalJsonValue({
    sourceId: row.sourceId,
    ordinal: row.ordinal,
    turnOrdinal: row.turnOrdinal,
    kind: row.kind,
    content: row.content,
    callId: row.callId,
    toolName: row.toolName,
    toolAccess: row.toolAccess,
  });
}

function orderedRows(rows: readonly AgentContextSourceRow[]): AgentContextSourceRow[] {
  return [...rows].sort(
    (left, right) => left.ordinal - right.ordinal || left.sourceId.localeCompare(right.sourceId),
  );
}

/** Hash exact rows in canonical provider-history order. */
export async function hashAgentContextSourceRows(
  rows: readonly AgentContextSourceRow[],
): Promise<string> {
  return sha256(orderedRows(rows).map(canonicalSourceShape));
}

/**
 * Helper for durable deterministic summaries and full compactor callbacks.
 * The returned source hash binds the summary to the exact source bytes.
 */
export async function createAgentContextSummaryCandidate(input: {
  summaryId: string;
  sourceRows: readonly AgentContextSourceRow[];
  content: string;
}): Promise<AgentContextSummaryCandidate> {
  return {
    summaryId: input.summaryId,
    sourceIds: orderedRows(input.sourceRows).map((row) => row.sourceId),
    sourceHash: await hashAgentContextSourceRows(input.sourceRows),
    content: input.content,
  };
}

/**
 * Conservative provider-neutral fallback used before a provider invocation.
 *
 * A raw UTF-8-bytes/4 estimate materially under-counts Chinese manuscript
 * text: one Han character occupies three UTF-8 bytes but is commonly close to
 * one model token. Long-form writing is Drifting's primary workload, so count
 * CJK code points directly while retaining the conventional chars/4 estimate
 * for ASCII words. Non-ASCII symbols (notably emoji) use a stricter bytes/2
 * fallback, and JSON/control punctuation is charged separately.
 *
 * Provider adapters may still inject an exact tokenizer through
 * `estimateTokens`; this is the safe multi-provider default.
 */
export function estimateAgentContextTextTokens(text: string): number {
  if (text.length === 0) return 0;
  let asciiWordChars = 0;
  let asciiPunctuation = 0;
  let cjkCodePoints = 0;
  let otherUnicode = '';

  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      if (/[\p{Letter}\p{Number}\s]/u.test(character)) {
        asciiWordChars += 1;
      } else {
        asciiPunctuation += 1;
      }
      continue;
    }
    if (
      /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)
    ) {
      cjkCodePoints += 1;
      continue;
    }
    otherUnicode += character;
  }

  const otherUnicodeBytes =
    otherUnicode.length === 0 ? 0 : new TextEncoder().encode(otherUnicode).byteLength;
  return Math.max(
    1,
    Math.ceil(asciiWordChars / 4) +
      Math.ceil(asciiPunctuation / 2) +
      cjkCodePoints +
      Math.ceil(otherUnicodeBytes / 2),
  );
}

/**
 * Canonical wire-equivalent payload used for summary budgeting. The verified
 * envelope retains every source id internally, but provider adapters send only
 * sourceCount + sourceHash. Charging internal provenance as model input makes
 * long-running summaries grow without bound even though those bytes never
 * cross the provider wire.
 */
export function serializeAgentContextSummaryBudgetPayload(input: {
  summaryId: string;
  sourceIds: readonly string[];
  sourceHash: string;
  content: string;
}): string {
  return serializeAgentContextSummaryProviderPayload(input);
}

/**
 * Provider-facing summaries are a projection of verified internal state, not
 * a transport envelope. Hashes and source ids remain in the checkpoint for
 * validation; the model sees only the current creative-work state it needs.
 */
export function serializeAgentContextSummaryProviderPayload(input: {
  summaryId: string;
  sourceIds: readonly string[];
  sourceHash: string;
  content: string;
}): string {
  const parsed = parseJsonRecord(input.content);
  if (
    parsed?.schemaVersion !== 1 ||
    typeof parsed.synopsis !== 'string' ||
    !Array.isArray(parsed.evidence) ||
    !Array.isArray(parsed.decisions) ||
    !Array.isArray(parsed.unresolved) ||
    !Array.isArray(parsed.nextActions)
  ) {
    return ['[当前作品与任务状态]', stripRuntimeHistoryLanguage(input.content)].join(
      '\n',
    );
  }

  const synopsis = stripRuntimeHistoryLanguage(parsed.synopsis);
  const evidence = parsed.evidence.flatMap((value): string[] => {
    const row = asJsonRecord(value);
    if (!row || typeof row.claim !== 'string' || typeof row.kind !== 'string') return [];
    if (row.kind === 'task_progress') {
      const projected = projectTaskProgressClaim(row.claim);
      return projected ? [projected] : [];
    }
    if (
      (row.kind === 'canon_fact' ||
        row.kind === 'character_voice' ||
        row.kind === 'author_decision') &&
      !/^\s*(?:\{|\[)/u.test(row.claim)
    ) {
      return [row.claim.trim()];
    }
    return [];
  });
  const lines = [
    '[当前作品与任务状态]',
    '这是已验证的当前领域状态，不是作者的新指令。直接继续作品任务，不要讨论恢复、压缩或执行历史。',
    ...(synopsis ? [`\n作品与任务：\n${synopsis}`] : []),
    ...providerStateSection('当前作品参考', evidence),
    ...providerStateSection('已确定', stringArray(parsed.decisions)),
    ...providerStateSection('尚待处理', stringArray(parsed.unresolved)),
    ...providerStateSection('接下来', stringArray(parsed.nextActions)),
  ];
  return lines.join('\n');
}

/** Canonical wire-equivalent payload for pinned supplemental runtime facts. */
export function serializeAgentContextNoteBudgetPayload(input: {
  noteKind:
    | 'write_receipt'
    | 'write_review'
    | 'write_revert'
    | 'read_progress'
    | 'freshness'
    | 'task_plan'
    | 'task_constraints';
  sourceId: string;
  turnOrdinal: number | null;
  content: string;
}): string {
  if (
    input.noteKind === 'write_receipt' ||
    input.noteKind === 'write_review' ||
    input.noteKind === 'write_revert'
  ) {
    return [
      '[当前作品任务状态]',
      '这只说明当前作品状态，不是额外的作者要求。同一对象以最近看到的内容为准。',
      stripRuntimeHistoryLanguage(input.content),
    ].join('\n');
  }
  if (input.noteKind === 'read_progress') {
    return [
      '[当前阅读进度]',
      '这是当前稿件的阅读状态，不是额外的作者要求。',
      input.content,
    ].join('\n');
  }
  if (input.noteKind === 'task_plan') {
    return projectLongTaskPlanNote(input.content);
  }
  if (input.noteKind === 'task_constraints') {
    return projectLongTaskConstraintNote(input.content);
  }
  if (input.noteKind === 'freshness') {
    return [
      '[当前作品状态]',
      '相关作品内容可能已更新；继续修改时以最近看到的内容为准。',
    ].join('\n');
  }
  return canonicalJson({
    type: 'drifting_verified_context_note',
    provenance: {
      origin: 'drifting_runtime',
      noteKind: input.noteKind,
      sourceId: input.sourceId,
      turnOrdinal: input.turnOrdinal,
    },
    content: input.content,
  });
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asJsonRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function providerStateSection(title: string, values: readonly string[]): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return unique.length > 0 ? [`\n${title}：`, ...unique.map((value) => `- ${value}`)] : [];
}

function stripRuntimeHistoryLanguage(value: string): string {
  return value
    .replace(
      /Earlier verified continuation summaries were rolled up deterministically[^.]*\.?/giu,
      '',
    )
    .replace(/Earlier Agent activity was compacted[^.]*\.?/giu, '')
    .replace(/Successful reads and stable missing-target results[^.]*\.?/giu, '')
    .replace(/较早的\s*\d+\s*项作品审阅决定已归档，涉及/gu, '当前任务涉及')
    .replace(/已提交\s*\d+\s*项作品改动：/gu, '已修改：')
    .replace(/你已经完成对(.+?)的一轮修改。/gu, '$1已包含本轮修改。')
    .replace(/完成内容：将正文从\s*\d+\s*字调整为\s*\d+\s*字。?/gu, '')
    .replace(
      /(?:这些操作已成功保存|这些是已保存的历史决定)[^\n。]*。?/gu,
      '',
    )
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function projectTaskProgressClaim(value: string): string | null {
  const currentChapter = /^(.+?)\s+已完成整章阅读；[^\n]*：\n([\s\S]+)$/u.exec(value);
  if (currentChapter) return `${currentChapter[1]} 当前版本参考：\n${currentChapter[2]}`;
  const genericRead = /^(?:.+? completed for )(.+?)\. This records scan progress/iu.exec(value);
  if (genericRead) return `${genericRead[1]} 已纳入当前任务背景。`;
  const missing = /^(?:.+? confirmed that )(.+?) did not resolve/iu.exec(value);
  if (missing) return `${missing[1]} 当前不存在。`;
  return stripRuntimeHistoryLanguage(value) || null;
}

function projectLongTaskPlanNote(content: string): string {
  const parsed = parseJsonRecord(content);
  const task = asJsonRecord(parsed?.task);
  const progress = asJsonRecord(parsed?.progress);
  const stepWindow = asJsonRecord(parsed?.stepWindow);
  const steps = Array.isArray(stepWindow?.steps) ? stepWindow.steps : [];
  if (!task || typeof task.objective !== 'string') {
    return ['[当前长任务]', stripRuntimeHistoryLanguage(content)].join('\n');
  }
  const lines = [
    '[当前长任务]',
    `目标：${task.objective}`,
    ...(typeof progress?.completed === 'number' && typeof progress?.total === 'number'
      ? [`进度：${progress.completed}/${progress.total} 步已完成。`]
      : []),
  ];
  const projectedSteps = steps.flatMap((value): string[] => {
    const step = asJsonRecord(value);
    if (!step || typeof step.title !== 'string' || typeof step.status !== 'string') return [];
    const target = asJsonRecord(step.target);
    const targetName =
      typeof target?.name === 'string'
        ? target.name
        : typeof target?.title === 'string'
          ? target.title
          : '';
    const status =
      step.status === 'completed'
        ? '已完成'
        : step.status === 'in_progress'
          ? '进行中'
          : step.status === 'blocked'
            ? '受阻'
            : '待处理';
    return [`- ${step.title}${targetName ? `（${targetName}）` : ''}：${status}`];
  });
  if (projectedSteps.length > 0) lines.push('当前步骤：', ...projectedSteps);
  lines.push('从“进行中”的步骤继续；若没有，则处理第一个“待处理”步骤。不要重复已完成内容。');
  return lines.join('\n');
}

function projectLongTaskConstraintNote(content: string): string {
  const parsed = parseJsonRecord(content);
  const constraints = Array.isArray(parsed?.activeConstraints) ? parsed.activeConstraints : [];
  const bodies = constraints.flatMap((value): string[] => {
    const row = asJsonRecord(value);
    return typeof row?.body === 'string' && row.body.trim() ? [row.body.trim()] : [];
  });
  return bodies.length > 0
    ? ['[作者为当前任务设定的规则]', ...bodies.map((body) => `- ${body}`)].join('\n')
    : '[作者为当前任务设定的规则]\n无额外规则。';
}

export function computeAgentContextBudget(input: {
  contextWindowTokens: number;
  requestedOutputTokens: number;
  fixedInputTokens: number;
}): ContextBudget {
  if (
    !Number.isSafeInteger(input.contextWindowTokens) ||
    input.contextWindowTokens <= 0 ||
    !Number.isSafeInteger(input.requestedOutputTokens) ||
    input.requestedOutputTokens < 0 ||
    !Number.isSafeInteger(input.fixedInputTokens) ||
    input.fixedInputTokens < 0
  ) {
    throw new PlannerFailure(
      'INVALID_CONTEXT',
      'Context window must be positive and requested output/fixed input must be non-negative safe integers.',
    );
  }
  const reservedOutputTokens = Math.max(input.requestedOutputTokens, MIN_OUTPUT_RESERVE_TOKENS);
  const safetyMarginTokens = Math.ceil(input.contextWindowTokens * SAFETY_MARGIN_RATIO);
  const usableInputBudgetTokens =
    input.contextWindowTokens - reservedOutputTokens - safetyMarginTokens - input.fixedInputTokens;
  if (usableInputBudgetTokens <= 0) {
    throw new PlannerFailure(
      'INVALID_CONTEXT',
      'Output reserve, safety margin, and fixed provider input leave no usable context-row budget.',
    );
  }
  return {
    contextWindowTokens: input.contextWindowTokens,
    requestedOutputTokens: input.requestedOutputTokens,
    fixedInputTokens: input.fixedInputTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    usableInputBudgetTokens,
  };
}

export function classifyAgentContextSource(
  row: AgentContextSourceRow,
  constraintSourceIds?: ReadonlySet<string>,
  durablyDiscardableToolSourceIds?: ReadonlySet<string>,
  activeDurableWriteSourceIds?: ReadonlySet<string>,
): AgentContextClass {
  switch (row.kind) {
    case 'system_policy':
    case 'write_receipt':
    case 'write_review':
    case 'write_revert':
    case 'read_progress':
    case 'freshness':
    case 'task_plan':
    case 'task_constraints':
      return 'pinned';
    case 'user':
      return constraintSourceIds === undefined || constraintSourceIds.has(row.sourceId)
        ? 'pinned'
        : 'compressible';
    case 'thinking':
      return 'discardable';
    case 'tool_call':
    case 'tool_result':
      if (durablyDiscardableToolSourceIds?.has(row.sourceId)) return 'discardable';
      // A settled write from the active turn is safe to compact, but its exact
      // domain delta is still useful working memory until the turn ends. Treat
      // it like an ordinary recent row instead of erasing it immediately or
      // pinning an arbitrarily large manuscript replacement forever.
      if (activeDurableWriteSourceIds?.has(row.sourceId)) return 'compressible';
      if (row.toolAccess !== 'write') return 'compressible';
      return 'pinned';
    case 'assistant_narrative':
      return 'compressible';
  }
}

async function normalizeConstraintLedger(input: {
  rows: readonly AgentContextSourceRow[];
  sourceHashes: ReadonlyMap<string, string>;
  ledger: readonly AgentContextConstraintLedgerEntry[] | undefined;
}): Promise<{
  mode: 'legacy_all_user' | 'verified';
  entries: AgentContextConstraintLedgerEntry[];
  sourceIds: Set<string>;
  ledgerHash: string;
}> {
  const sourceById = new Map(input.rows.map((source) => [source.sourceId, source]));
  const rawEntries =
    input.ledger === undefined
      ? input.rows
          .filter((source) => source.kind === 'user')
          .map((source) => ({
            constraintId: `legacy-user:${source.sourceId}`,
            sourceId: source.sourceId,
            sourceHash: input.sourceHashes.get(source.sourceId)!,
            kind: 'legacy_user' as const,
          }))
      : input.ledger.map((entry) => ({ ...entry }));
  const constraintIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const entry of rawEntries) {
    const source = sourceById.get(entry.sourceId);
    if (
      !entry.constraintId ||
      constraintIds.has(entry.constraintId) ||
      !entry.sourceId ||
      sourceIds.has(entry.sourceId) ||
      !source ||
      source.kind !== 'user' ||
      entry.sourceHash !== input.sourceHashes.get(entry.sourceId) ||
      (entry.kind !== 'session_goal' &&
        entry.kind !== 'author_instruction' &&
        entry.kind !== 'author_veto' &&
        entry.kind !== 'author_fact' &&
        entry.kind !== 'legacy_user') ||
      (input.ledger !== undefined && entry.kind === 'legacy_user')
    ) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Constraint ledger entry "${entry.constraintId || '(empty)'}" has duplicate, stale, or invalid user provenance.`,
      );
    }
    constraintIds.add(entry.constraintId);
    sourceIds.add(entry.sourceId);
  }
  const entries = rawEntries.sort((left, right) => {
    const leftOrdinal = sourceById.get(left.sourceId)!.ordinal;
    const rightOrdinal = sourceById.get(right.sourceId)!.ordinal;
    return leftOrdinal - rightOrdinal || left.constraintId.localeCompare(right.constraintId);
  });
  return {
    mode: input.ledger === undefined ? 'legacy_all_user' : 'verified',
    entries,
    sourceIds,
    ledgerHash: await sha256(entries),
  };
}

function cloneSourceRow(row: AgentContextSourceRow): AgentContextSourceRow {
  return {
    sourceId: row.sourceId,
    ordinal: row.ordinal,
    turnOrdinal: row.turnOrdinal,
    kind: row.kind,
    content: row.content,
    ...(row.callId === undefined ? {} : { callId: row.callId }),
    ...(row.toolName === undefined ? {} : { toolName: row.toolName }),
    ...(row.toolAccess === undefined ? {} : { toolAccess: row.toolAccess }),
  };
}

function validateSourceRows(rows: readonly AgentContextSourceRow[]): ToolPair[] {
  if (rows.length === 0) {
    throw new PlannerFailure(
      'INVALID_CONTEXT',
      'At least one canonical context source row is required.',
    );
  }
  const sourceIds = new Set<string>();
  const ordinals = new Set<number>();
  let systemPolicies = 0;
  for (const row of rows) {
    if (!row.sourceId || sourceIds.has(row.sourceId)) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Duplicate or empty context source id "${row.sourceId}".`,
      );
    }
    sourceIds.add(row.sourceId);
    if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || ordinals.has(row.ordinal)) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Source "${row.sourceId}" has a duplicate or invalid ordinal.`,
      );
    }
    ordinals.add(row.ordinal);
    if (
      row.turnOrdinal !== null &&
      (!Number.isSafeInteger(row.turnOrdinal) || row.turnOrdinal < 0)
    ) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Source "${row.sourceId}" has an invalid turn ordinal.`,
      );
    }
    if (typeof row.content !== 'string') {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Source "${row.sourceId}" content must be an exact string.`,
      );
    }
    if (!AGENT_CONTEXT_SOURCE_KINDS.has(row.kind)) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Source "${row.sourceId}" has unsupported kind "${String(row.kind)}".`,
      );
    }
    if (row.kind === 'system_policy') systemPolicies += 1;
    const isTool = row.kind === 'tool_call' || row.kind === 'tool_result';
    if (
      isTool &&
      (!row.callId ||
        !row.toolName ||
        (row.toolAccess !== 'read' && row.toolAccess !== 'write' && row.toolAccess !== 'denied') ||
        row.turnOrdinal === null)
    ) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Tool source "${row.sourceId}" lacks call identity, access, or turn ownership.`,
      );
    }
    if (
      !isTool &&
      (row.callId !== undefined || row.toolName !== undefined || row.toolAccess !== undefined)
    ) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Non-tool source "${row.sourceId}" contains tool topology fields.`,
      );
    }
  }
  if (systemPolicies === 0) {
    throw new PlannerFailure(
      'INVALID_CONTEXT',
      'Canonical context must contain at least one system policy row.',
    );
  }
  return validateCanonicalToolTopology(rows);
}

function toolKey(row: AgentContextSourceRow): string {
  return `${row.turnOrdinal}:${row.callId}`;
}

/**
 * Split ordered canonical rows at the smallest boundaries that never separate
 * a tool call from its result. Parallel calls whose call/result intervals
 * overlap intentionally form one atomic unit; sequential calls do not.
 */
export function groupAgentContextRowsByToolTopology(
  rows: readonly AgentContextSourceRow[],
): AgentContextSourceRow[][] {
  const ordered = orderedRows(rows);
  const resultIndexes = new Map<string, number>();
  for (const [index, row] of ordered.entries()) {
    if (row.kind === 'tool_result') resultIndexes.set(toolKey(row), index);
  }

  const units: AgentContextSourceRow[][] = [];
  let start = 0;
  let openThrough = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    const row = ordered[index]!;
    if (row.kind === 'tool_call') {
      openThrough = Math.max(openThrough, resultIndexes.get(toolKey(row)) ?? index);
    }
    if (index >= openThrough) {
      units.push(ordered.slice(start, index + 1));
      start = index + 1;
      openThrough = -1;
    }
  }
  if (start < ordered.length) units.push(ordered.slice(start));
  return units;
}

function validateCanonicalToolTopology(rows: readonly AgentContextSourceRow[]): ToolPair[] {
  const calls = new Map<string, AgentContextSourceRow>();
  const results = new Map<string, AgentContextSourceRow>();
  for (const row of orderedRows(rows)) {
    if (row.kind !== 'tool_call' && row.kind !== 'tool_result') continue;
    const key = toolKey(row);
    const target = row.kind === 'tool_call' ? calls : results;
    if (target.has(key)) {
      throw new PlannerFailure('INVALID_CONTEXT', `Duplicate ${row.kind} for "${key}".`);
    }
    target.set(key, row);
  }
  const allKeys = new Set([...calls.keys(), ...results.keys()]);
  const pairs: ToolPair[] = [];
  for (const key of allKeys) {
    const call = calls.get(key);
    const result = results.get(key);
    if (!call || !result) {
      throw new PlannerFailure('INVALID_CONTEXT', `Dangling tool call/result for "${key}".`);
    }
    if (
      call.ordinal >= result.ordinal ||
      call.toolName !== result.toolName ||
      call.toolAccess !== result.toolAccess
    ) {
      throw new PlannerFailure('INVALID_CONTEXT', `Mismatched tool call/result for "${key}".`);
    }
    pairs.push({ key, call, result });
  }
  return pairs;
}

function estimateSourceTokens(
  row: AgentContextSourceRow,
  estimator: AgentContextTokenEstimator,
): number {
  const budgetText =
    row.kind === 'write_review' ||
    row.kind === 'write_receipt' ||
    row.kind === 'write_revert' ||
    row.kind === 'freshness' ||
    row.kind === 'task_plan' ||
    row.kind === 'task_constraints'
      ? serializeAgentContextNoteBudgetPayload({
          noteKind: row.kind,
          sourceId: row.sourceId,
          turnOrdinal: row.turnOrdinal,
          content: row.content,
        })
      : row.content;
  return validatedEstimate(estimator, budgetText) + SOURCE_SEGMENT_OVERHEAD_TOKENS;
}

function estimateSummaryTokens(
  candidate: AgentContextSummaryCandidate,
  estimator: AgentContextTokenEstimator,
): number {
  return (
    validatedEstimate(estimator, serializeAgentContextSummaryBudgetPayload(candidate)) +
    SUMMARY_SEGMENT_OVERHEAD_TOKENS
  );
}

function validatedEstimate(estimator: AgentContextTokenEstimator, content: string): number {
  const estimate = estimator(content);
  if (!Number.isSafeInteger(estimate) || estimate < 0) {
    throw new PlannerFailure(
      'INVALID_CONTEXT',
      'Context token estimator must return a non-negative safe integer.',
    );
  }
  return estimate;
}

function projectionTokens(segments: readonly AgentContextProjectionSegment[]): number {
  return segments.reduce((total, segment) => total + segment.estimatedTokens, 0);
}

function latestTwoTurnOrdinals(rows: readonly AgentContextSourceRow[]): Set<number> {
  const turns = [
    ...new Set(rows.map((row) => row.turnOrdinal).filter((turn): turn is number => turn !== null)),
  ].sort((left, right) => right - left);
  return new Set(turns.slice(0, 2));
}

function recentExactSourceIds(input: {
  rows: readonly AgentContextSourceRow[];
  classifications: ReadonlyMap<string, AgentContextClass>;
  estimator: AgentContextTokenEstimator;
  availableTokens: number;
}): Set<string> {
  if (input.availableTokens <= 0) return new Set();
  const recentTurns = latestTwoTurnOrdinals(input.rows);
  const candidates = input.rows.filter(
    (row) =>
      row.turnOrdinal !== null &&
      recentTurns.has(row.turnOrdinal) &&
      input.classifications.get(row.sourceId) === 'compressible',
  );
  const units = groupAgentContextRowsByToolTopology(candidates);
  const hasAuthoredRead = units.some(isAuthoredReadUnit);
  const cap = Math.min(
    MAX_RECENT_EXACT_TOKENS,
    Math.floor(
      input.availableTokens *
        (hasAuthoredRead
          ? MAX_AUTHORED_READ_EXACT_BUDGET_RATIO
          : MAX_RECENT_EXACT_BUDGET_RATIO),
    ),
  );
  const candidateTokens = candidates.reduce(
    (total, row) => total + estimateSourceTokens(row, input.estimator),
    0,
  );
  if (candidateTokens <= cap) return new Set(candidates.map((row) => row.sourceId));

  const selected = new Set<string>();
  let selectedTokens = 0;
  const newestFirst = [...units].reverse();
  const prioritized = [
    ...newestFirst.filter(isAuthoredReadUnit),
    ...newestFirst.filter((unit) => !isAuthoredReadUnit(unit)),
  ];
  for (const unit of prioritized) {
    const unitTokens = unit.reduce(
      (total, row) => total + estimateSourceTokens(row, input.estimator),
      0,
    );
    // A single verbose assistant message must not prevent later compact
    // authored reads from being retained. Skip an oversized unit and keep
    // considering other topology-safe units.
    if (selectedTokens + unitTokens > cap) continue;
    for (const row of unit) selected.add(row.sourceId);
    selectedTokens += unitTokens;
  }
  return selected;
}

function isAuthoredReadUnit(rows: readonly AgentContextSourceRow[]): boolean {
  return rows.some(
    (row) => row.toolAccess === 'read' && row.toolName === 'read_file',
  );
}

/**
 * Recent exact context is a quality preference, not a semantic invariant.
 * When every older verified summary is already at its minimum size, release
 * the oldest topology-safe recent unit so long turns can keep compacting
 * instead of permanently tripping the session circuit. Canonical history is
 * untouched and hard semantic pins are never relaxed.
 */
function releaseOldestRecentExactUnits(input: {
  projection: WorkingProjection;
  recentSourceIds: Set<string>;
  minimumReleasedTokens: number;
}): number {
  let releasedTokens = 0;
  while (releasedTokens < input.minimumReleasedTokens) {
    const recentRows = input.projection.segments.flatMap((segment) =>
      segment.type === 'source' && segment.pinReason === 'recent_turn' ? [segment.row] : [],
    );
    const unit = groupAgentContextRowsByToolTopology(recentRows)[0];
    if (!unit?.length) break;

    const releasedIds = new Set(unit.map((row) => row.sourceId));
    let unitTokens = 0;
    for (const segment of input.projection.segments) {
      if (
        segment.type !== 'source' ||
        segment.pinReason !== 'recent_turn' ||
        !releasedIds.has(segment.row.sourceId)
      ) {
        continue;
      }
      segment.pinReason = null;
      input.recentSourceIds.delete(segment.row.sourceId);
      unitTokens += segment.estimatedTokens;
    }
    if (unitTokens <= 0) break;
    releasedTokens += unitTokens;
  }
  return releasedTokens;
}

function sourcePinReason(
  row: AgentContextSourceRow,
  classification: AgentContextClass,
  recentSourceIds: ReadonlySet<string>,
): AgentContextSourceSegment['pinReason'] {
  if (classification === 'pinned') return 'semantic';
  if (classification === 'compressible' && recentSourceIds.has(row.sourceId)) {
    return 'recent_turn';
  }
  return null;
}

function initialProjection(
  rows: readonly AgentContextSourceRow[],
  classifications: ReadonlyMap<string, AgentContextClass>,
  recentSourceIds: ReadonlySet<string>,
  sourceHashes: ReadonlyMap<string, string>,
  estimator: AgentContextTokenEstimator,
): WorkingProjection {
  const coverage = new Map<string, { type: 'source' } | { type: 'summary'; id: string }>();
  const segments: AgentContextProjectionSegment[] = [];
  for (const row of orderedRows(rows)) {
    const classification = classifications.get(row.sourceId)!;
    if (classification === 'discardable') continue;
    coverage.set(row.sourceId, { type: 'source' });
    segments.push({
      type: 'source',
      row: cloneSourceRow(row),
      classification,
      pinReason: sourcePinReason(row, classification, recentSourceIds),
      sourceHash: sourceHashes.get(row.sourceId)!,
      estimatedTokens: estimateSourceTokens(row, estimator),
    });
  }
  return { segments, coverage, summaryIds: new Set() };
}

function candidateSourceRows(
  candidate: AgentContextSummaryCandidate,
  sourceById: ReadonlyMap<string, AgentContextSourceRow>,
): AgentContextSourceRow[] {
  if (!candidate.summaryId || candidate.sourceIds.length === 0 || !candidate.content) {
    throw new PlannerFailure(
      'INVALID_SUMMARY',
      'A summary must have an id, non-empty source coverage, and non-empty content.',
    );
  }
  const seen = new Set<string>();
  return candidate.sourceIds.map((sourceId) => {
    if (!sourceId || seen.has(sourceId)) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" has duplicate or empty source ids.`,
      );
    }
    seen.add(sourceId);
    const row = sourceById.get(sourceId);
    if (!row) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" references unknown source "${sourceId}".`,
      );
    }
    return row;
  });
}

function summaryIsProtected(
  rows: readonly AgentContextSourceRow[],
  classifications: ReadonlyMap<string, AgentContextClass>,
  recentSourceIds: ReadonlySet<string>,
): boolean {
  return rows.some((row) => {
    const classification = classifications.get(row.sourceId)!;
    return sourcePinReason(row, classification, recentSourceIds) !== null;
  });
}

function pairBySourceId(pairs: readonly ToolPair[]): Map<string, ToolPair> {
  const output = new Map<string, ToolPair>();
  for (const pair of pairs) {
    output.set(pair.call.sourceId, pair);
    output.set(pair.result.sourceId, pair);
  }
  return output;
}

function durablyCoveredWriteSourceIds(input: {
  evidence: readonly AgentContextDurableWriteEvidence[] | undefined;
  sourceById: ReadonlyMap<string, AgentContextSourceRow>;
  toolPairs: readonly ToolPair[];
}): Set<string> {
  const covered = new Set<string>();
  if (!input.evidence?.length) return covered;

  const pairByKey = new Map(input.toolPairs.map((pair) => [pair.key, pair] as const));
  for (const evidence of input.evidence) {
    if (
      !evidence ||
      !evidence.evidenceSourceId ||
      !Number.isSafeInteger(evidence.turnOrdinal) ||
      evidence.turnOrdinal < 0 ||
      !evidence.callId ||
      !evidence.toolName
    ) {
      continue;
    }
    const evidenceRow = input.sourceById.get(evidence.evidenceSourceId);
    if (
      !evidenceRow ||
      (evidenceRow.kind !== 'write_receipt' &&
        evidenceRow.kind !== 'write_review' &&
        evidenceRow.kind !== 'task_plan' &&
        evidenceRow.kind !== 'task_constraints')
    ) {
      continue;
    }
    const pair = pairByKey.get(`${evidence.turnOrdinal}:${evidence.callId}`);
    if (
      !pair ||
      pair.call.toolAccess !== 'write' ||
      pair.result.toolAccess !== 'write' ||
      pair.call.toolName !== evidence.toolName ||
      pair.result.toolName !== evidence.toolName
    ) {
      continue;
    }
    const evidenceMatchesProductSnapshot =
      evidenceRow.kind === 'write_receipt'
        ? evidence.toolName !== 'update_task_plan' &&
          evidence.toolName !== 'update_task_step' &&
          evidence.toolName !== 'update_task_constraint'
        : evidenceRow.kind === 'write_review'
          ? evidence.toolName !== 'update_task_plan' &&
            evidence.toolName !== 'update_task_step' &&
            evidence.toolName !== 'update_task_constraint'
          : evidenceRow.kind === 'task_plan'
            ? evidence.toolName === 'update_task_plan' || evidence.toolName === 'update_task_step'
            : evidence.toolName === 'update_task_constraint';
    if (!evidenceMatchesProductSnapshot) continue;

    covered.add(pair.call.sourceId);
    covered.add(pair.result.sourceId);
  }

  // A recovered write must not keep poisoning later reasoning with an older
  // raw failure for the same authored target. The canonical rows remain in
  // the checkpoint for audit/recovery, but a later durable success is the
  // authoritative provider-facing state. This is intentionally conservative:
  // only explicit failed results with a stable target fingerprint and a later
  // durably covered write are superseded.
  const coveredPairs = input.toolPairs.filter(
    (pair) => covered.has(pair.call.sourceId) && covered.has(pair.result.sourceId),
  );
  for (const pair of input.toolPairs) {
    if (
      pair.call.toolAccess !== 'write' ||
      covered.has(pair.call.sourceId) ||
      !toolResultExplicitlyFailed(pair.result)
    ) {
      continue;
    }
    const target = writeToolTargetFingerprint(pair.call);
    if (!target) continue;
    const recovered = coveredPairs.some(
      (candidate) =>
        candidate.call.ordinal > pair.result.ordinal &&
        writeToolTargetFingerprint(candidate.call) === target,
    );
    if (!recovered) continue;
    covered.add(pair.call.sourceId);
    covered.add(pair.result.sourceId);
  }
  return covered;
}

function parsedToolPayload(row: AgentContextSourceRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toolResultExplicitlyFailed(row: AgentContextSourceRow): boolean {
  return parsedToolPayload(row)?.ok === false;
}

function successfulNoopWriteSourceIds(toolPairs: readonly ToolPair[]): Set<string> {
  const discardable = new Set<string>();
  for (const pair of toolPairs) {
    if (pair.call.toolAccess !== 'write' || pair.result.toolAccess !== 'write') continue;
    const result = parsedToolPayload(pair.result);
    if (
      result?.ok !== true ||
      typeof result.content !== 'string' ||
      !result.content.includes(WORKSPACE_NOOP_WRITE_MODEL_MARKER)
    ) {
      continue;
    }
    discardable.add(pair.call.sourceId);
    discardable.add(pair.result.sourceId);
  }
  return discardable;
}

function writeToolTargetFingerprint(row: AgentContextSourceRow): string | null {
  const target = authoredToolTargetFingerprint(row);
  return target ? canonicalJson({ toolName: row.toolName, target }) : null;
}

function authoredToolTargetFingerprint(row: AgentContextSourceRow): string | null {
  const payload = parsedToolPayload(row);
  const arguments_ = payload?.arguments;
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return null;
  const record = arguments_ as Record<string, unknown>;
  const targetKeys = [
    'path',
    'node',
    'entity',
    'element',
    'storyline',
    'category',
    'comment',
    'relation',
    'memory',
    'id',
    'name',
    'title',
    'from',
    'to',
  ] as const;
  const target = Object.fromEntries(
    targetKeys.flatMap((key) => {
      const value = record[key];
      if (typeof value !== 'string' || !value.trim()) return [];
      return [[key, key === 'path' ? normalizeAuthoredWorkspacePath(value) : value.trim()]];
    }),
  );
  return Object.keys(target).length > 0 ? canonicalJson(target) : null;
}

function normalizeAuthoredWorkspacePath(value: string): string {
  const path = `/${value.trim().split('/').filter(Boolean).join('/')}`;
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 2 && (segments[0] === 'chapters' || segments[0] === 'drifts')) {
    return `${path}/prose.md`;
  }
  if (segments.length === 2 && (segments[0] === 'storylines' || segments[0] === 'categories')) {
    return `${path}/body.md`;
  }
  if (segments.length === 3 && segments[0] === 'elements') {
    return `${path}/body.md`;
  }
  return path;
}

function staleReadSourceIds(input: {
  toolPairs: readonly ToolPair[];
  durablyCoveredWriteSourceIds: ReadonlySet<string>;
}): Set<string> {
  const stale = new Set<string>();
  const committedTargets = input.toolPairs.flatMap((pair) => {
    if (
      pair.call.toolAccess !== 'write' ||
      !input.durablyCoveredWriteSourceIds.has(pair.call.sourceId) ||
      !input.durablyCoveredWriteSourceIds.has(pair.result.sourceId)
    ) {
      return [];
    }
    const target = authoredToolTargetFingerprint(pair.call);
    const resultContent = parsedToolPayload(pair.result)?.content;
    return target
      ? [{
          ordinal: pair.call.ordinal,
          turnOrdinal: pair.call.turnOrdinal,
          target,
          focusedEdit: pair.call.toolName === 'edit_file',
          completeReadCarriedForward:
            typeof resultContent === 'string' &&
            resultContent.includes(WORKSPACE_COMPLETE_READ_MODEL_MARKER),
        }]
      : [];
  });
  if (committedTargets.length === 0) return stale;
  for (const pair of input.toolPairs) {
    if (
      pair.call.toolAccess !== 'read' ||
      (pair.call.toolName !== 'read_file' && pair.call.toolName !== 'grep')
    ) {
      continue;
    }
    const target = authoredToolTargetFingerprint(pair.call);
    if (!target) continue;
    const laterWrites = committedTargets.filter(
      (committed) =>
        committed.ordinal > pair.result.ordinal &&
        committed.target === target,
    );
    if (laterWrites.length === 0) {
      continue;
    }
    const keepCurrentWorkingCopy =
      pair.call.toolName === 'read_file' &&
      laterWrites.every(
        (write) => write.turnOrdinal === pair.call.turnOrdinal && write.focusedEdit,
      ) &&
      laterWrites.some((write) => write.completeReadCarriedForward);
    if (keepCurrentWorkingCopy) continue;
    stale.add(pair.call.sourceId);
    stale.add(pair.result.sourceId);
  }
  return stale;
}

function activeTurnDurableWriteSourceIds(input: {
  rows: readonly AgentContextSourceRow[];
  toolPairs: readonly ToolPair[];
  durablyCoveredSourceIds: ReadonlySet<string>;
}): Set<string> {
  const latestTurnOrdinal = input.rows.reduce<number | null>(
    (latest, row) =>
      row.turnOrdinal === null || (latest !== null && row.turnOrdinal <= latest)
        ? latest
        : row.turnOrdinal,
    null,
  );
  const active = new Set<string>();
  if (latestTurnOrdinal === null) return active;
  for (const pair of input.toolPairs) {
    if (
      pair.call.turnOrdinal !== latestTurnOrdinal ||
      !input.durablyCoveredSourceIds.has(pair.call.sourceId) ||
      !input.durablyCoveredSourceIds.has(pair.result.sourceId) ||
      parsedToolPayload(pair.result)?.ok !== true
    ) {
      continue;
    }
    active.add(pair.call.sourceId);
    active.add(pair.result.sourceId);
  }
  return active;
}

/**
 * Keep only the newest complete read of one authored object in provider
 * context. Canonical history remains untouched, but an older full read cannot
 * be more current than a later successful full read of the same target. This
 * prevents harmless verification reads from accumulating into a context loop.
 * Partial pages are deliberately excluded because each page may carry unique
 * prose needed for a complete document read.
 */
function supersededReadSourceIds(toolPairs: readonly ToolPair[]): Set<string> {
  const superseded = new Set<string>();
  const newestByTarget = new Map<string, ToolPair>();
  for (const pair of toolPairs) {
    const target = completeReadTargetFingerprint(pair);
    if (!target) continue;
    const previous = newestByTarget.get(target);
    if (previous) {
      superseded.add(previous.call.sourceId);
      superseded.add(previous.result.sourceId);
    }
    newestByTarget.set(target, pair);
  }
  return superseded;
}

function completeReadTargetFingerprint(pair: ToolPair): string | null {
  if (
    pair.call.toolAccess !== 'read' ||
    pair.call.toolName !== 'read_file' ||
    parsedToolPayload(pair.result)?.ok !== true
  ) {
    return null;
  }
  const call = parsedToolPayload(pair.call);
  const arguments_ = call?.arguments;
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return null;
  const record = arguments_ as Record<string, unknown>;
  const offset = record.offset;
  if (offset !== undefined && offset !== 0) return null;
  const result = parsedToolPayload(pair.result);
  const content = typeof result?.content === 'string' ? result.content : '';
  if (!content || /这份内容尚未读完|"truncated"\s*:\s*true/iu.test(content)) return null;
  const target = authoredToolTargetFingerprint(pair.call);
  return target ? canonicalJson({ toolName: pair.call.toolName, target }) : null;
}

async function applySummaryBatch(input: {
  candidates: readonly AgentContextSummaryCandidate[];
  producer: AgentContextSummarySegment['producer'];
  projection: WorkingProjection;
  sourceById: ReadonlyMap<string, AgentContextSourceRow>;
  classifications: ReadonlyMap<string, AgentContextClass>;
  recentSourceIds: ReadonlySet<string>;
  toolPairBySourceId: ReadonlyMap<string, ToolPair>;
  estimator: AgentContextTokenEstimator;
  protectedPolicy: 'skip' | 'reject';
}): Promise<SummaryBatchResult> {
  const projection: WorkingProjection = {
    segments: [...input.projection.segments],
    coverage: new Map(input.projection.coverage),
    summaryIds: new Set(input.projection.summaryIds),
  };
  let gainedTokens = 0;
  const orderedCandidates = [...input.candidates].sort((left, right) => {
    const leftFirst = Math.min(
      ...left.sourceIds.map(
        (sourceId) => input.sourceById.get(sourceId)?.ordinal ?? Number.MAX_SAFE_INTEGER,
      ),
    );
    const rightFirst = Math.min(
      ...right.sourceIds.map(
        (sourceId) => input.sourceById.get(sourceId)?.ordinal ?? Number.MAX_SAFE_INTEGER,
      ),
    );
    return leftFirst - rightFirst || left.summaryId.localeCompare(right.summaryId);
  });

  for (const candidate of orderedCandidates) {
    const sourceRows = candidateSourceRows(candidate, input.sourceById);
    if (summaryIsProtected(sourceRows, input.classifications, input.recentSourceIds)) {
      if (input.protectedPolicy === 'skip') continue;
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" attempts to replace protected recent context.`,
      );
    }
    for (const row of sourceRows) {
      if (input.classifications.get(row.sourceId) !== 'compressible') {
        // Cached verified summaries are projections, not canonical truth. A
        // later read or write can make one of their sources obsolete between
        // model iterations. Silently retire that cached candidate; only a
        // freshly returned full-compactor candidate is a protocol violation.
        if (input.protectedPolicy === 'skip') break;
        throw new PlannerFailure(
          'INVALID_SUMMARY',
          `Summary "${candidate.summaryId}" attempts to replace pinned or discardable source "${row.sourceId}".`,
        );
      }
      const representation = projection.coverage.get(row.sourceId);
      if (!representation) {
        if (input.protectedPolicy === 'skip') break;
        throw new PlannerFailure(
          'INVALID_SUMMARY',
          `Summary "${candidate.summaryId}" references an unrepresented source.`,
        );
      }
    }
    if (
      input.protectedPolicy === 'skip' &&
      sourceRows.some(
        (row) =>
          input.classifications.get(row.sourceId) !== 'compressible' ||
          !projection.coverage.has(row.sourceId),
      )
    ) {
      continue;
    }
    const actualSourceHash = await hashAgentContextSourceRows(sourceRows);
    if (candidate.sourceHash !== actualSourceHash) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" source hash does not match canonical rows.`,
      );
    }

    const coveredIds = new Set(sourceRows.map((row) => row.sourceId));
    for (const row of sourceRows) {
      const pair = input.toolPairBySourceId.get(row.sourceId);
      if (!pair) continue;
      if (!coveredIds.has(pair.call.sourceId) || !coveredIds.has(pair.result.sourceId)) {
        throw new PlannerFailure(
          'INVALID_SUMMARY',
          `Summary "${candidate.summaryId}" splits read tool pair "${pair.key}".`,
        );
      }
    }

    const representedSegmentIndexes = [
      ...new Set(
        sourceRows.map((row) => {
          const representation = projection.coverage.get(row.sourceId)!;
          return projection.segments.findIndex((segment) =>
            representation.type === 'source'
              ? segment.type === 'source' && segment.row.sourceId === row.sourceId
              : segment.type === 'summary' && segment.summaryId === representation.id,
          );
        }),
      ),
    ].sort((left, right) => left - right);
    const firstIndex = representedSegmentIndexes[0];
    const lastIndex = representedSegmentIndexes[representedSegmentIndexes.length - 1];
    if (
      firstIndex < 0 ||
      lastIndex - firstIndex + 1 !== representedSegmentIndexes.length ||
      representedSegmentIndexes.some((index, offset) => index !== firstIndex + offset)
    ) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" does not cover one contiguous source run.`,
      );
    }
    const replaced = projection.segments.slice(firstIndex, lastIndex + 1);
    const replacedSourceIds = new Set(
      replaced.flatMap((segment) =>
        segment.type === 'source' ? [segment.row.sourceId] : segment.sourceIds,
      ),
    );
    const candidateSourceIds = new Set(sourceRows.map((row) => row.sourceId));
    if (
      replacedSourceIds.size !== candidateSourceIds.size ||
      [...replacedSourceIds].some((sourceId) => !candidateSourceIds.has(sourceId))
    ) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" partially overlaps an existing summary boundary.`,
      );
    }
    const replacedSummaryIds = new Set(
      replaced.flatMap((segment) => (segment.type === 'summary' ? [segment.summaryId] : [])),
    );
    if (
      projection.summaryIds.has(candidate.summaryId) &&
      !replacedSummaryIds.has(candidate.summaryId)
    ) {
      throw new PlannerFailure('INVALID_SUMMARY', `Duplicate summary id "${candidate.summaryId}".`);
    }
    const beforeTokens = projectionTokens(replaced);
    const estimatedTokens = estimateSummaryTokens(candidate, input.estimator);
    if (estimatedTokens >= beforeTokens) {
      // A production compactor operates on bounded chunks. A short tail chunk
      // can be perfectly valid yet cost more once source/hash provenance is
      // included. Keep that chunk byte-exact and still accept other candidates
      // that produce a real aggregate gain. An all-no-gain batch continues to
      // fail closed below and opens the circuit exactly as before.
      if (input.producer === 'full_compactor') continue;
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" has no positive token gain.`,
      );
    }
    const normalizedSourceIds = orderedRows(sourceRows).map((row) => row.sourceId);
    const segment: AgentContextSummarySegment = {
      type: 'summary',
      summaryId: candidate.summaryId,
      sourceIds: normalizedSourceIds,
      sourceHash: actualSourceHash,
      summaryHash: await sha256({
        summaryId: candidate.summaryId,
        sourceIds: normalizedSourceIds,
        content: candidate.content,
      }),
      content: candidate.content,
      estimatedTokens,
      producer: input.producer,
    };
    projection.segments.splice(firstIndex, replaced.length, segment);
    for (const summaryId of replacedSummaryIds) projection.summaryIds.delete(summaryId);
    for (const sourceId of normalizedSourceIds) {
      projection.coverage.set(sourceId, {
        type: 'summary',
        id: candidate.summaryId,
      });
    }
    projection.summaryIds.add(candidate.summaryId);
    gainedTokens += beforeTokens - estimatedTokens;
  }
  return { projection, gainedTokens };
}

function eligibleCompactionViews(
  projection: WorkingProjection,
  toolPairs: readonly ToolPair[],
  sourceById: ReadonlyMap<string, AgentContextSourceRow>,
): {
  legacyRuns: readonly (readonly AgentContextSourceRow[])[];
  projectionRuns: readonly (readonly AgentContextFullCompactionUnit[])[];
} {
  // A parallel tool batch is ordered as call A, call B, result A, result B.
  // Pinned writes or an existing summary can therefore sit between a read
  // call and its result even though both read rows are individually
  // compressible. Never expose either half as a compactor run: removing one
  // split pair can expose an overlapping pair, so close the interval set to a
  // fixed point before collecting contiguous runs.
  const segmentIndexBySourceId = new Map<string, number>();
  const eligible = projection.segments.map((segment, index) => {
    if (segment.type === 'source') {
      segmentIndexBySourceId.set(segment.row.sourceId, index);
      return segment.classification === 'compressible' && segment.pinReason === null;
    }
    for (const sourceId of segment.sourceIds) {
      segmentIndexBySourceId.set(sourceId, index);
    }
    return true;
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const pair of toolPairs) {
      const callIndex = segmentIndexBySourceId.get(pair.call.sourceId);
      const resultIndex = segmentIndexBySourceId.get(pair.result.sourceId);
      if (callIndex === undefined || resultIndex === undefined) continue;
      const first = Math.min(callIndex, resultIndex);
      const last = Math.max(callIndex, resultIndex);
      // A verified summary is already atomic: applySummaryBatch proved that it
      // contains both halves of every tool pair it represents. It is therefore
      // safe to roll that whole segment up again. Requiring every segment to be
      // an exact source made all tool-bearing summaries permanently ineligible
      // and eventually stranded long turns with no compactable history.
      const wholeIntervalEligible = projection.segments
        .slice(first, last + 1)
        .every((_segment, offset) => eligible[first + offset] === true);
      if (wholeIntervalEligible) continue;
      for (let index = first; index <= last; index += 1) {
        if (!eligible[index]) continue;
        eligible[index] = false;
        changed = true;
      }
    }
  }

  const eligibleSegmentRuns: AgentContextProjectionSegment[][] = [];
  let currentSegments: AgentContextProjectionSegment[] = [];
  for (const [index, segment] of projection.segments.entries()) {
    if (eligible[index]) {
      currentSegments.push(segment);
      continue;
    }
    if (currentSegments.length > 0) eligibleSegmentRuns.push(currentSegments);
    currentSegments = [];
  }
  if (currentSegments.length > 0) eligibleSegmentRuns.push(currentSegments);

  const legacyRuns: Array<readonly AgentContextSourceRow[]> = [];
  for (const segmentRun of eligibleSegmentRuns) {
    let currentRows: AgentContextSourceRow[] = [];
    for (const segment of segmentRun) {
      if (segment.type === 'source') {
        currentRows.push(Object.freeze(cloneSourceRow(segment.row)));
      } else {
        if (currentRows.length > 0) legacyRuns.push(Object.freeze(currentRows));
        currentRows = [];
      }
    }
    if (currentRows.length > 0) legacyRuns.push(Object.freeze(currentRows));
  }

  const projectionRuns = eligibleSegmentRuns.map((segmentRun) => {
    const localIndexBySourceId = new Map<string, number>();
    for (const [index, segment] of segmentRun.entries()) {
      const sourceIds = segment.type === 'source' ? [segment.row.sourceId] : segment.sourceIds;
      for (const sourceId of sourceIds) localIndexBySourceId.set(sourceId, index);
    }
    const intervalEndByStart = new Map<number, number>();
    for (const pair of toolPairs) {
      const callIndex = localIndexBySourceId.get(pair.call.sourceId);
      const resultIndex = localIndexBySourceId.get(pair.result.sourceId);
      if (callIndex === undefined || resultIndex === undefined) continue;
      const first = Math.min(callIndex, resultIndex);
      const last = Math.max(callIndex, resultIndex);
      intervalEndByStart.set(first, Math.max(intervalEndByStart.get(first) ?? first, last));
    }

    const units: AgentContextFullCompactionUnit[] = [];
    let start = 0;
    let openThrough = -1;
    for (let index = 0; index < segmentRun.length; index += 1) {
      openThrough = Math.max(openThrough, intervalEndByStart.get(index) ?? index);
      if (index < openThrough) continue;
      const unitSegments = segmentRun.slice(start, index + 1);
      const unitSourceIds = unitSegments.flatMap((segment) =>
        segment.type === 'source' ? [segment.row.sourceId] : segment.sourceIds,
      );
      const sourceRows = orderedRows(
        unitSourceIds.map((sourceId) => {
          const source = sourceById.get(sourceId);
          if (!source) {
            throw new PlannerFailure(
              'INVALID_CONTEXT',
              `Projected compaction source "${sourceId}" is missing.`,
            );
          }
          return cloneSourceRow(source);
        }),
      );
      units.push(
        Object.freeze({
          sourceRows: Object.freeze(sourceRows),
          projectionRows: Object.freeze(
            unitSegments.map(
              (segment): AgentContextFullCompactionProjectionRow =>
                segment.type === 'source'
                  ? Object.freeze({
                      type: 'source',
                      sourceIds: Object.freeze([segment.row.sourceId]),
                      content: segment.row.content,
                      kind: segment.row.kind,
                      turnOrdinal: segment.row.turnOrdinal,
                      ...(segment.row.toolName ? { toolName: segment.row.toolName } : {}),
                      ...(segment.row.toolAccess ? { toolAccess: segment.row.toolAccess } : {}),
                    })
                  : Object.freeze({
                      type: 'summary',
                      sourceIds: Object.freeze([...segment.sourceIds]),
                      content: segment.content,
                      summaryId: segment.summaryId,
                    }),
            ),
          ),
          estimatedTokens: projectionTokens(unitSegments),
        }),
      );
      start = index + 1;
      openThrough = -1;
    }
    return Object.freeze(units);
  });
  return {
    legacyRuns: Object.freeze(legacyRuns),
    projectionRuns: Object.freeze(projectionRuns),
  };
}

async function runFullCompactor(input: {
  compactor: AgentContextFullCompactor;
  request: Omit<AgentContextFullCompactionRequest, 'signal'>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<readonly AgentContextSummaryCandidate[]> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new PlannerFailure(
      'INVALID_CONTEXT',
      'Compaction timeout must be a positive safe integer.',
    );
  }
  if (input.signal?.aborted) {
    throw new PlannerFailure(
      'COMPACTOR_ABORTED',
      'Context compaction was aborted before it started.',
    );
  }
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abort, { once: true });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let rejectOnAbort: (() => void) | undefined;
  try {
    const task = Promise.resolve().then(() =>
      input.compactor({
        ...input.request,
        signal: controller.signal,
      }),
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort('context compaction timeout');
        reject(
          new PlannerFailure(
            'COMPACTOR_TIMEOUT',
            `Full context compaction exceeded ${input.timeoutMs} ms.`,
          ),
        );
      }, input.timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!input.signal) return;
      rejectOnAbort = () => {
        reject(new PlannerFailure('COMPACTOR_ABORTED', 'Context compaction was aborted.'));
      };
      input.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    return await Promise.race([task, timeout, aborted]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    input.signal?.removeEventListener('abort', abort);
    if (rejectOnAbort) {
      input.signal?.removeEventListener('abort', rejectOnAbort);
    }
  }
}

function cloneProjectionSegments(
  segments: readonly AgentContextProjectionSegment[],
): AgentContextProjectionSegment[] {
  return segments.map((segment) =>
    segment.type === 'source'
      ? { ...segment, row: cloneSourceRow(segment.row) }
      : { ...segment, sourceIds: [...segment.sourceIds] },
  );
}

async function validateFinalProjection(input: {
  rows: readonly AgentContextSourceRow[];
  projection: WorkingProjection;
  classifications: ReadonlyMap<string, AgentContextClass>;
  recentSourceIds: ReadonlySet<string>;
  sourceHashes: ReadonlyMap<string, string>;
  toolPairs: readonly ToolPair[];
}): Promise<{
  pinnedRows: AgentContextSourceRow[];
  representedRows: AgentContextSourceRow[];
  discardedRows: AgentContextSourceRow[];
}> {
  const segmentSourceIds = new Set<string>();
  const segmentSummaryIds = new Set<string>();
  for (const segment of input.projection.segments) {
    if (segment.type === 'source') {
      const source = input.rows.find((row) => row.sourceId === segment.row.sourceId);
      if (
        !source ||
        segmentSourceIds.has(source.sourceId) ||
        canonicalJson(canonicalSourceShape(source)) !==
          canonicalJson(canonicalSourceShape(segment.row)) ||
        segment.sourceHash !== input.sourceHashes.get(source.sourceId)
      ) {
        throw new PlannerFailure(
          'INVALID_CONTEXT',
          `Projected source "${segment.row.sourceId}" is duplicate or not byte-exact.`,
        );
      }
      segmentSourceIds.add(source.sourceId);
    } else {
      if (segmentSummaryIds.has(segment.summaryId)) {
        throw new PlannerFailure(
          'INVALID_SUMMARY',
          `Projected summary "${segment.summaryId}" is duplicated.`,
        );
      }
      segmentSummaryIds.add(segment.summaryId);
    }
  }

  const pinnedRows: AgentContextSourceRow[] = [];
  const representedRows: AgentContextSourceRow[] = [];
  const discardedRows: AgentContextSourceRow[] = [];
  for (const row of input.rows) {
    const classification = input.classifications.get(row.sourceId)!;
    const pinReason = sourcePinReason(row, classification, input.recentSourceIds);
    if (pinReason !== null) pinnedRows.push(row);
    const representation = input.projection.coverage.get(row.sourceId);
    if (classification === 'discardable') {
      if (representation) {
        throw new PlannerFailure(
          'INVALID_CONTEXT',
          `Discardable source "${row.sourceId}" survived compaction.`,
        );
      }
      discardedRows.push(row);
      continue;
    }
    if (!representation) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Canonical source "${row.sourceId}" is missing from context coverage.`,
      );
    }
    representedRows.push(row);
    if (
      pinReason !== null &&
      (representation.type !== 'source' || !segmentSourceIds.has(row.sourceId))
    ) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Pinned source "${row.sourceId}" was not preserved byte-exact.`,
      );
    }
  }

  for (const pair of input.toolPairs) {
    const callRepresentation = input.projection.coverage.get(pair.call.sourceId);
    const resultRepresentation = input.projection.coverage.get(pair.result.sourceId);
    const bothOriginal =
      callRepresentation?.type === 'source' && resultRepresentation?.type === 'source';
    const sameSummary =
      callRepresentation?.type === 'summary' &&
      resultRepresentation?.type === 'summary' &&
      callRepresentation.id === resultRepresentation.id;
    const bothDurablyDiscarded =
      callRepresentation === undefined &&
      resultRepresentation === undefined &&
      input.classifications.get(pair.call.sourceId) === 'discardable' &&
      input.classifications.get(pair.result.sourceId) === 'discardable';
    if (!bothOriginal && !sameSummary && !bothDurablyDiscarded) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Projected context splits tool pair "${pair.key}".`,
      );
    }
  }
  return { pinnedRows, representedRows, discardedRows };
}

function failureResult(input: {
  error: PlannerFailure;
  budget: ContextBudget | null;
  estimatedInputTokens: number | null;
  fullCompactionCount: number;
  circuit: AgentContextCompactionCircuitBreaker;
}): AgentContextPlannerResult {
  return {
    ok: false,
    error: {
      code: input.error.code,
      message: input.error.message,
    },
    diagnostics: {
      usableInputBudgetTokens: input.budget?.usableInputBudgetTokens ?? null,
      estimatedInputTokens: input.estimatedInputTokens,
      fullCompactionCount: input.fullCompactionCount,
      circuitState: input.circuit.snapshot(),
    },
  };
}

/**
 * Build a provider-call projection and V2 checkpoint. Full compaction may run
 * repeatedly while every pass makes verified progress; invalid output and a
 * genuine no-gain state still fail closed.
 */
export async function planAgentContext(
  input: AgentContextPlannerInput,
): Promise<AgentContextPlannerResult> {
  const circuit = input.compactionCircuit ?? new AgentContextCompactionCircuitBreaker();
  let budget: ContextBudget | null = null;
  let estimatedInputTokens: number | null = null;
  let fullCompactionCount = 0;
  try {
    budget = computeAgentContextBudget(input);
    const estimator = input.estimateTokens ?? estimateAgentContextTextTokens;
    const rows = orderedRows(input.sourceRows.map(cloneSourceRow));
    const toolPairs = validateSourceRows(rows);
    const sourceById = new Map(rows.map((row) => [row.sourceId, row]));
    const sourceHashes = new Map(
      await Promise.all(
        rows.map(async (row) => [row.sourceId, await hashAgentContextSourceRows([row])] as const),
      ),
    );
    const constraintLedger = await normalizeConstraintLedger({
      rows,
      sourceHashes,
      ledger: input.constraintLedger,
    });
    const coveredWriteSourceIds = durablyCoveredWriteSourceIds({
      evidence: input.durableWriteEvidence,
      sourceById,
      toolPairs,
    });
    const activeDurableWriteSourceIds = activeTurnDurableWriteSourceIds({
      rows,
      toolPairs,
      durablyCoveredSourceIds: coveredWriteSourceIds,
    });
    const discardableToolSourceIds = new Set([
      ...[...coveredWriteSourceIds].filter(
        (sourceId) => !activeDurableWriteSourceIds.has(sourceId),
      ),
      ...successfulNoopWriteSourceIds(toolPairs),
      ...staleReadSourceIds({ toolPairs, durablyCoveredWriteSourceIds: coveredWriteSourceIds }),
      ...supersededReadSourceIds(toolPairs),
    ]);
    const classifications = new Map(
      rows.map((row) => [
        row.sourceId,
        classifyAgentContextSource(
          row,
          constraintLedger.sourceIds,
          discardableToolSourceIds,
          activeDurableWriteSourceIds,
        ),
      ]),
    );
    const initialTokens = rows.reduce(
      (total, row) => total + estimateSourceTokens(row, estimator),
      0,
    );
    const noRecentSourceIds = new Set<string>();
    const semanticTokens = rows.reduce((total, row) => {
      const classification = classifications.get(row.sourceId)!;
      return sourcePinReason(row, classification, noRecentSourceIds) === null
        ? total
        : total + estimateSourceTokens(row, estimator);
    }, 0);
    if (semanticTokens > budget.usableInputBudgetTokens) {
      throw new PlannerFailure(
        'PINNED_CONTEXT_EXCEEDS_BUDGET',
        `Pinned semantic context needs ${semanticTokens} tokens, above the ${budget.usableInputBudgetTokens}-token usable budget.`,
      );
    }
    const recentSourceIds = recentExactSourceIds({
      rows,
      classifications,
      estimator,
      availableTokens: budget.usableInputBudgetTokens - semanticTokens,
    });
    const protectedTokens = rows.reduce((total, row) => {
      const classification = classifications.get(row.sourceId)!;
      return sourcePinReason(row, classification, recentSourceIds) === null
        ? total
        : total + estimateSourceTokens(row, estimator);
    }, 0);
    if (protectedTokens > budget.usableInputBudgetTokens) {
      throw new PlannerFailure(
        'PINNED_CONTEXT_EXCEEDS_BUDGET',
        `Pinned and bounded recent exact context needs ${protectedTokens} tokens, above the ${budget.usableInputBudgetTokens}-token usable budget.`,
      );
    }

    let projection = initialProjection(
      rows,
      classifications,
      recentSourceIds,
      sourceHashes,
      estimator,
    );
    const stages: AgentContextCheckpointV2['compaction']['stages'] = [];
    if (rows.some((row) => classifications.get(row.sourceId) === 'discardable')) {
      stages.push('drop_discardable');
    }
    estimatedInputTokens = projectionTokens(projection.segments);

    if (
      estimatedInputTokens > budget.usableInputBudgetTokens &&
      (input.deterministicSummaries?.length ?? 0) > 0
    ) {
      const deterministic = await applySummaryBatch({
        candidates: input.deterministicSummaries!,
        producer: 'deterministic',
        projection,
        sourceById,
        classifications,
        recentSourceIds,
        toolPairBySourceId: pairBySourceId(toolPairs),
        estimator,
        protectedPolicy: 'skip',
      });
      if (deterministic.gainedTokens > 0) {
        projection = deterministic.projection;
        stages.push('deterministic_summaries');
        estimatedInputTokens = projectionTokens(projection.segments);
      }
    }

    let softRecentReleaseAttempted = false;
    while (estimatedInputTokens > budget.usableInputBudgetTokens) {
      if (!input.fullCompactor) {
        throw new PlannerFailure(
          'CONTEXT_BUDGET_EXCEEDED',
          `Context needs ${estimatedInputTokens} tokens after deterministic compaction, above the ${budget.usableInputBudgetTokens}-token usable budget.`,
        );
      }
      if (circuit.isOpen()) {
        throw new PlannerFailure(
          'COMPACTION_CIRCUIT_OPEN',
          'Full context compaction is disabled by an open circuit breaker.',
        );
      }
      const compactionViews = eligibleCompactionViews(projection, toolPairs, sourceById);
      if (compactionViews.legacyRuns.length === 0 && compactionViews.projectionRuns.length === 0) {
        throw new PlannerFailure(
          'CONTEXT_BUDGET_EXCEEDED',
          'No unpinned context remains eligible for full compaction.',
        );
      }
      fullCompactionCount += 1;
      let candidates: readonly AgentContextSummaryCandidate[];
      try {
        candidates = await runFullCompactor({
          compactor: input.fullCompactor,
          request: {
            eligibleRuns: compactionViews.legacyRuns,
            eligibleProjectionRuns: compactionViews.projectionRuns,
            currentEstimatedTokens: estimatedInputTokens,
            usableInputBudgetTokens: budget.usableInputBudgetTokens,
          },
          signal: input.signal,
          timeoutMs: input.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS,
        });
      } catch (error) {
        const failure =
          error instanceof PlannerFailure
            ? error
            : new PlannerFailure(
                'COMPACTOR_FAILED',
                `Full context compaction failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
        circuit.trip(`${failure.code}:${failure.message}`);
        throw failure;
      }
      let compacted: SummaryBatchResult;
      try {
        compacted = await applySummaryBatch({
          candidates,
          producer: 'full_compactor',
          projection,
          sourceById,
          classifications,
          recentSourceIds,
          toolPairBySourceId: pairBySourceId(toolPairs),
          estimator,
          protectedPolicy: 'reject',
        });
      } catch (error) {
        const failure =
          error instanceof PlannerFailure
            ? error
            : new PlannerFailure(
                'INVALID_SUMMARY',
                'Full compactor returned an invalid context projection.',
              );
        circuit.trip(`${failure.code}:${failure.message}`);
        throw failure;
      }
      if (compacted.gainedTokens <= 0) {
        if (
          !softRecentReleaseAttempted &&
          releaseOldestRecentExactUnits({
            projection,
            recentSourceIds,
            minimumReleasedTokens: Math.max(
              2_048,
              estimatedInputTokens - budget.usableInputBudgetTokens + 4_096,
            ),
          }) > 0
        ) {
          softRecentReleaseAttempted = true;
          // Recompute eligible runs with one less soft recent pin. The next
          // pass may now merge that exact unit with already-minimal summaries.
          // This is the only no-gain recovery attempt: a second no-gain result
          // opens the circuit instead of spending repeatedly on the same turn.
          continue;
        }
        const failure = new PlannerFailure(
          'COMPACTOR_NO_GAIN',
          'Full compactor produced no positive token gain.',
        );
        circuit.trip(`${failure.code}:${failure.message}`);
        throw failure;
      }
      projection = compacted.projection;
      if (!stages.includes('full_compactor')) stages.push('full_compactor');
      estimatedInputTokens = projectionTokens(projection.segments);
      // One provider pass is allowed to make partial positive progress. Large
      // same-turn read/write campaigns can expose several disjoint topology-
      // safe runs, and a bounded compactor request may reclaim most—but not
      // all—of the overage before its own timeout. Recompute eligibility and
      // continue until the verified projection fits. Positive integer gain
      // makes this loop finite; no-gain and invalid output still fail closed.
    }

    const validated = await validateFinalProjection({
      rows,
      projection,
      classifications,
      recentSourceIds,
      sourceHashes,
      toolPairs,
    });
    const sourceOrderHash = await hashAgentContextSourceRows(rows);
    const pinnedSourceIds = orderedRows(validated.pinnedRows).map((row) => row.sourceId);
    const retainedConstraintRows = constraintLedger.entries.map(
      (entry) => sourceById.get(entry.sourceId)!,
    );
    const representedSourceIds = orderedRows(validated.representedRows).map((row) => row.sourceId);
    const discardedSourceIds = orderedRows(validated.discardedRows).map((row) => row.sourceId);
    const segments = cloneProjectionSegments(projection.segments);
    const checkpoint: AgentContextCheckpointV2 = {
      schemaVersion: AGENT_CONTEXT_CHECKPOINT_VERSION,
      format: AGENT_CONTEXT_CHECKPOINT_FORMAT,
      budget: {
        ...budget,
        initialEstimatedTokens: initialTokens,
        finalEstimatedTokens: estimatedInputTokens,
      },
      canonicalSources: {
        sourceCount: rows.length,
        sourceOrderHash,
      },
      pinned: {
        sourceIds: pinnedSourceIds,
        sourceHash: await hashAgentContextSourceRows(validated.pinnedRows),
      },
      constraintLedger: {
        mode: constraintLedger.mode,
        entries: constraintLedger.entries.map((entry) => ({ ...entry })),
        ledgerHash: constraintLedger.ledgerHash,
        retentionWitness: {
          status: 'exact',
          sourceIds: retainedConstraintRows.map((row) => row.sourceId),
          sourceHash: await hashAgentContextSourceRows(retainedConstraintRows),
        },
      },
      coverage: {
        representedSourceIds,
        discardedSourceIds,
        coverageHash: await sha256(
          representedSourceIds.map((sourceId) => ({
            sourceId,
            sourceHash: sourceHashes.get(sourceId),
            representation: projection.coverage.get(sourceId),
          })),
        ),
      },
      projection: {
        segments: cloneProjectionSegments(segments),
        contextHash: await sha256(segments),
      },
      compaction: {
        stages,
        fullCompactionCount,
        circuitState: circuit.snapshot(),
      },
    };
    return {
      ok: true,
      plan: {
        segments,
        estimatedInputTokens,
        usableInputBudgetTokens: budget.usableInputBudgetTokens,
        checkpoint,
      },
    };
  } catch (error) {
    const failure =
      error instanceof PlannerFailure
        ? error
        : new PlannerFailure(
            'INVALID_CONTEXT',
            error instanceof Error ? error.message : String(error),
          );
    return failureResult({
      error: failure,
      budget,
      estimatedInputTokens,
      fullCompactionCount,
      circuit,
    });
  }
}
