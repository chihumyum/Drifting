/**
 * Provider-neutral context planning and compaction.
 *
 * Canonical message rows remain the source of truth. This planner only creates
 * a verified projection for one provider call and a V2 checkpoint envelope
 * describing that projection. It never rewrites, retires, or replaces source
 * rows.
 */

export const AGENT_CONTEXT_CHECKPOINT_VERSION = 2 as const;
export const AGENT_CONTEXT_CHECKPOINT_FORMAT =
  'drifting.agent-context-checkpoint' as const;

const MIN_OUTPUT_RESERVE_TOKENS = 4_096;
const SAFETY_MARGIN_RATIO = 0.1;
const DEFAULT_COMPACTION_TIMEOUT_MS = 8_000;
const SOURCE_SEGMENT_OVERHEAD_TOKENS = 6;
const SUMMARY_SEGMENT_OVERHEAD_TOKENS = 8;
const AGENT_CONTEXT_SOURCE_KINDS: ReadonlySet<AgentContextSourceKind> = new Set([
  'system_policy',
  'user',
  'assistant_narrative',
  'thinking',
  'tool_call',
  'tool_result',
  'write_review',
  'write_revert',
  'freshness',
]);

export type AgentContextClass = 'pinned' | 'compressible' | 'discardable';

export type AgentContextSourceKind =
  | 'system_policy'
  | 'user'
  | 'assistant_narrative'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'write_review'
  | 'write_revert'
  | 'freshness';

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
  toolAccess?: 'read' | 'write';
}

export interface AgentContextSummaryCandidate {
  summaryId: string;
  /** Canonical source ids represented by this summary. */
  sourceIds: readonly string[];
  /** SHA-256 of the exact canonical source rows, not of the summary text. */
  sourceHash: string;
  content: string;
}

export interface AgentContextFullCompactionRequest {
  /**
   * Contiguous, unpinned source runs that are safe to summarize. A callback
   * may return one or more summaries, but every summary must stay within one
   * run and preserve complete read-tool call/result pairs.
   */
  eligibleRuns: readonly (readonly AgentContextSourceRow[])[];
  currentEstimatedTokens: number;
  usableInputBudgetTokens: number;
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

export type AgentContextProjectionSegment =
  | AgentContextSourceSegment
  | AgentContextSummarySegment;

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
    stages: Array<
      'drop_discardable' | 'deterministic_summaries' | 'full_compactor'
    >;
    fullCompactionCount: 0 | 1;
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
        fullCompactionCount: 0 | 1;
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
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `${path} contains a non-finite number.`,
      );
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new PlannerFailure(
      'INVALID_CONTEXT',
      `${path} contains unsupported ${typeof value}.`,
    );
  }
  if (ancestors.has(value)) {
    throw new PlannerFailure('INVALID_CONTEXT', `${path} contains a cycle.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        canonicalJsonValue(entry, `${path}[${index}]`, ancestors),
      );
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
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new PlannerFailure(
      'HASH_UNAVAILABLE',
      'Web Crypto SHA-256 is unavailable; context cannot be verified.',
    );
  }
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
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

function orderedRows(
  rows: readonly AgentContextSourceRow[],
): AgentContextSourceRow[] {
  return [...rows].sort(
    (left, right) =>
      left.ordinal - right.ordinal ||
      left.sourceId.localeCompare(right.sourceId),
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

/** Conservative provider-neutral fallback used before a provider invocation. */
export function estimateAgentContextTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4));
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
  const reservedOutputTokens = Math.max(
    input.requestedOutputTokens,
    MIN_OUTPUT_RESERVE_TOKENS,
  );
  const safetyMarginTokens = Math.ceil(
    input.contextWindowTokens * SAFETY_MARGIN_RATIO,
  );
  const usableInputBudgetTokens =
    input.contextWindowTokens -
    reservedOutputTokens -
    safetyMarginTokens -
    input.fixedInputTokens;
  if (usableInputBudgetTokens <= 0) {
    throw new PlannerFailure(
      'INVALID_CONTEXT',
      'Output reserve, safety margin, and fixed provider input leave no usable context-row budget.',
    );
  }
  return {
    ...input,
    reservedOutputTokens,
    safetyMarginTokens,
    usableInputBudgetTokens,
  };
}

export function classifyAgentContextSource(
  row: AgentContextSourceRow,
): AgentContextClass {
  switch (row.kind) {
    case 'system_policy':
    case 'user':
    case 'write_review':
    case 'write_revert':
    case 'freshness':
      return 'pinned';
    case 'thinking':
      return 'discardable';
    case 'tool_call':
    case 'tool_result':
      return row.toolAccess === 'write' ? 'pinned' : 'compressible';
    case 'assistant_narrative':
      return 'compressible';
  }
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
    if (
      !Number.isSafeInteger(row.ordinal) ||
      row.ordinal < 0 ||
      ordinals.has(row.ordinal)
    ) {
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
        (row.toolAccess !== 'read' && row.toolAccess !== 'write') ||
        row.turnOrdinal === null)
    ) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Tool source "${row.sourceId}" lacks call identity, access, or turn ownership.`,
      );
    }
    if (
      !isTool &&
      (row.callId !== undefined ||
        row.toolName !== undefined ||
        row.toolAccess !== undefined)
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

function validateCanonicalToolTopology(
  rows: readonly AgentContextSourceRow[],
): ToolPair[] {
  const calls = new Map<string, AgentContextSourceRow>();
  const results = new Map<string, AgentContextSourceRow>();
  for (const row of orderedRows(rows)) {
    if (row.kind !== 'tool_call' && row.kind !== 'tool_result') continue;
    const key = toolKey(row);
    const target = row.kind === 'tool_call' ? calls : results;
    if (target.has(key)) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Duplicate ${row.kind} for "${key}".`,
      );
    }
    target.set(key, row);
  }
  const allKeys = new Set([...calls.keys(), ...results.keys()]);
  const pairs: ToolPair[] = [];
  for (const key of allKeys) {
    const call = calls.get(key);
    const result = results.get(key);
    if (!call || !result) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Dangling tool call/result for "${key}".`,
      );
    }
    if (
      call.ordinal >= result.ordinal ||
      call.toolName !== result.toolName ||
      call.toolAccess !== result.toolAccess
    ) {
      throw new PlannerFailure(
        'INVALID_CONTEXT',
        `Mismatched tool call/result for "${key}".`,
      );
    }
    pairs.push({ key, call, result });
  }
  return pairs;
}

function estimateSourceTokens(
  row: AgentContextSourceRow,
  estimator: AgentContextTokenEstimator,
): number {
  return validatedEstimate(estimator, row.content) + SOURCE_SEGMENT_OVERHEAD_TOKENS;
}

function estimateSummaryTokens(
  content: string,
  estimator: AgentContextTokenEstimator,
): number {
  return validatedEstimate(estimator, content) + SUMMARY_SEGMENT_OVERHEAD_TOKENS;
}

function validatedEstimate(
  estimator: AgentContextTokenEstimator,
  content: string,
): number {
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

function recentTurnOrdinals(rows: readonly AgentContextSourceRow[]): Set<number> {
  const turns = [
    ...new Set(
      rows
        .map((row) => row.turnOrdinal)
        .filter((turn): turn is number => turn !== null),
    ),
  ].sort((left, right) => right - left);
  return new Set(turns.slice(0, 2));
}

function sourcePinReason(
  row: AgentContextSourceRow,
  classification: AgentContextClass,
  recentTurns: ReadonlySet<number>,
): AgentContextSourceSegment['pinReason'] {
  if (classification === 'pinned') return 'semantic';
  if (
    classification === 'compressible' &&
    row.turnOrdinal !== null &&
    recentTurns.has(row.turnOrdinal)
  ) {
    return 'recent_turn';
  }
  return null;
}

function initialProjection(
  rows: readonly AgentContextSourceRow[],
  classifications: ReadonlyMap<string, AgentContextClass>,
  recentTurns: ReadonlySet<number>,
  sourceHashes: ReadonlyMap<string, string>,
  estimator: AgentContextTokenEstimator,
): WorkingProjection {
  const coverage = new Map<
    string,
    { type: 'source' } | { type: 'summary'; id: string }
  >();
  const segments: AgentContextProjectionSegment[] = [];
  for (const row of orderedRows(rows)) {
    const classification = classifications.get(row.sourceId)!;
    if (classification === 'discardable') continue;
    coverage.set(row.sourceId, { type: 'source' });
    segments.push({
      type: 'source',
      row: cloneSourceRow(row),
      classification,
      pinReason: sourcePinReason(row, classification, recentTurns),
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
  if (
    !candidate.summaryId ||
    candidate.sourceIds.length === 0 ||
    !candidate.content
  ) {
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
  recentTurns: ReadonlySet<number>,
): boolean {
  return rows.some((row) => {
    const classification = classifications.get(row.sourceId)!;
    return sourcePinReason(row, classification, recentTurns) !== null;
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

async function applySummaryBatch(input: {
  candidates: readonly AgentContextSummaryCandidate[];
  producer: AgentContextSummarySegment['producer'];
  projection: WorkingProjection;
  sourceById: ReadonlyMap<string, AgentContextSourceRow>;
  classifications: ReadonlyMap<string, AgentContextClass>;
  recentTurns: ReadonlySet<number>;
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
    if (summaryIsProtected(sourceRows, input.classifications, input.recentTurns)) {
      if (input.protectedPolicy === 'skip') continue;
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" attempts to replace protected recent context.`,
      );
    }
    if (projection.summaryIds.has(candidate.summaryId)) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Duplicate summary id "${candidate.summaryId}".`,
      );
    }
    for (const row of sourceRows) {
      if (input.classifications.get(row.sourceId) !== 'compressible') {
        throw new PlannerFailure(
          'INVALID_SUMMARY',
          `Summary "${candidate.summaryId}" attempts to replace pinned or discardable source "${row.sourceId}".`,
        );
      }
      const representation = projection.coverage.get(row.sourceId);
      if (!representation || representation.type !== 'source') {
        throw new PlannerFailure(
          'INVALID_SUMMARY',
          `Summary "${candidate.summaryId}" overlaps an already summarized source.`,
        );
      }
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
      if (
        !coveredIds.has(pair.call.sourceId) ||
        !coveredIds.has(pair.result.sourceId)
      ) {
        throw new PlannerFailure(
          'INVALID_SUMMARY',
          `Summary "${candidate.summaryId}" splits read tool pair "${pair.key}".`,
        );
      }
    }

    const sourceSegmentIndexes = sourceRows
      .map((row) =>
        projection.segments.findIndex(
          (segment) =>
            segment.type === 'source' && segment.row.sourceId === row.sourceId,
        ),
      )
      .sort((left, right) => left - right);
    const firstIndex = sourceSegmentIndexes[0];
    const lastIndex = sourceSegmentIndexes[sourceSegmentIndexes.length - 1];
    if (
      firstIndex < 0 ||
      lastIndex - firstIndex + 1 !== sourceSegmentIndexes.length ||
      sourceSegmentIndexes.some((index, offset) => index !== firstIndex + offset)
    ) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" does not cover one contiguous source run.`,
      );
    }
    const replaced = projection.segments.slice(firstIndex, lastIndex + 1);
    if (replaced.some((segment) => segment.type !== 'source')) {
      throw new PlannerFailure(
        'INVALID_SUMMARY',
        `Summary "${candidate.summaryId}" crosses another summary boundary.`,
      );
    }
    const beforeTokens = projectionTokens(replaced);
    const estimatedTokens = estimateSummaryTokens(candidate.content, input.estimator);
    if (estimatedTokens >= beforeTokens) {
      throw new PlannerFailure(
        input.producer === 'full_compactor'
          ? 'COMPACTOR_NO_GAIN'
          : 'INVALID_SUMMARY',
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

function eligibleRuns(
  projection: WorkingProjection,
): readonly (readonly AgentContextSourceRow[])[] {
  const runs: Array<readonly AgentContextSourceRow[]> = [];
  let current: AgentContextSourceRow[] = [];
  for (const segment of projection.segments) {
    if (
      segment.type === 'source' &&
      segment.classification === 'compressible' &&
      segment.pinReason === null
    ) {
      current.push(Object.freeze(cloneSourceRow(segment.row)));
      continue;
    }
    if (current.length > 0) runs.push(Object.freeze(current));
    current = [];
  }
  if (current.length > 0) runs.push(Object.freeze(current));
  return Object.freeze(runs);
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
        reject(
          new PlannerFailure(
            'COMPACTOR_ABORTED',
            'Context compaction was aborted.',
          ),
        );
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
  recentTurns: ReadonlySet<number>;
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
      const source = input.rows.find(
        (row) => row.sourceId === segment.row.sourceId,
      );
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
    const pinReason = sourcePinReason(row, classification, input.recentTurns);
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
    const resultRepresentation = input.projection.coverage.get(
      pair.result.sourceId,
    );
    const bothOriginal =
      callRepresentation?.type === 'source' &&
      resultRepresentation?.type === 'source';
    const sameSummary =
      callRepresentation?.type === 'summary' &&
      resultRepresentation?.type === 'summary' &&
      callRepresentation.id === resultRepresentation.id;
    if (!bothOriginal && !sameSummary) {
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
  fullCompactionCount: 0 | 1;
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
 * Build a provider-call projection and V2 checkpoint. Every compaction branch
 * is single-pass and fail-closed: there is no retry loop inside the planner.
 */
export async function planAgentContext(
  input: AgentContextPlannerInput,
): Promise<AgentContextPlannerResult> {
  const circuit =
    input.compactionCircuit ?? new AgentContextCompactionCircuitBreaker();
  let budget: ContextBudget | null = null;
  let estimatedInputTokens: number | null = null;
  let fullCompactionCount: 0 | 1 = 0;
  try {
    budget = computeAgentContextBudget(input);
    const estimator = input.estimateTokens ?? estimateAgentContextTextTokens;
    const rows = orderedRows(input.sourceRows.map(cloneSourceRow));
    const toolPairs = validateSourceRows(rows);
    const sourceById = new Map(rows.map((row) => [row.sourceId, row]));
    const classifications = new Map(
      rows.map((row) => [row.sourceId, classifyAgentContextSource(row)]),
    );
    const recentTurns = recentTurnOrdinals(rows);
    const sourceHashes = new Map(
      await Promise.all(
        rows.map(async (row) => [
          row.sourceId,
          await hashAgentContextSourceRows([row]),
        ] as const),
      ),
    );
    const initialTokens = rows.reduce(
      (total, row) => total + estimateSourceTokens(row, estimator),
      0,
    );
    const protectedTokens = rows.reduce((total, row) => {
      const classification = classifications.get(row.sourceId)!;
      return sourcePinReason(row, classification, recentTurns) === null
        ? total
        : total + estimateSourceTokens(row, estimator);
    }, 0);
    if (protectedTokens > budget.usableInputBudgetTokens) {
      throw new PlannerFailure(
        'PINNED_CONTEXT_EXCEEDS_BUDGET',
        `Pinned and recent exact context needs ${protectedTokens} tokens, above the ${budget.usableInputBudgetTokens}-token usable budget.`,
      );
    }

    let projection = initialProjection(
      rows,
      classifications,
      recentTurns,
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
        recentTurns,
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

    if (estimatedInputTokens > budget.usableInputBudgetTokens) {
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
      const runs = eligibleRuns(projection);
      if (runs.length === 0) {
        throw new PlannerFailure(
          'CONTEXT_BUDGET_EXCEEDED',
          'No unpinned context remains eligible for full compaction.',
        );
      }
      fullCompactionCount = 1;
      let candidates: readonly AgentContextSummaryCandidate[];
      try {
        candidates = await runFullCompactor({
          compactor: input.fullCompactor,
          request: {
            eligibleRuns: runs,
            currentEstimatedTokens: estimatedInputTokens,
            usableInputBudgetTokens: budget.usableInputBudgetTokens,
          },
          signal: input.signal,
          timeoutMs:
            input.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS,
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
          recentTurns,
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
        const failure = new PlannerFailure(
          'COMPACTOR_NO_GAIN',
          'Full compactor produced no positive token gain.',
        );
        circuit.trip(`${failure.code}:${failure.message}`);
        throw failure;
      }
      projection = compacted.projection;
      stages.push('full_compactor');
      estimatedInputTokens = projectionTokens(projection.segments);
      if (estimatedInputTokens > budget.usableInputBudgetTokens) {
        const failure = new PlannerFailure(
          'CONTEXT_BUDGET_EXCEEDED',
          `Full compaction still needs ${estimatedInputTokens} tokens, above the ${budget.usableInputBudgetTokens}-token usable budget.`,
        );
        circuit.trip(`${failure.code}:${failure.message}`);
        throw failure;
      }
    }

    const validated = await validateFinalProjection({
      rows,
      projection,
      classifications,
      recentTurns,
      sourceHashes,
      toolPairs,
    });
    const sourceOrderHash = await hashAgentContextSourceRows(rows);
    const pinnedSourceIds = orderedRows(validated.pinnedRows).map(
      (row) => row.sourceId,
    );
    const representedSourceIds = orderedRows(validated.representedRows).map(
      (row) => row.sourceId,
    );
    const discardedSourceIds = orderedRows(validated.discardedRows).map(
      (row) => row.sourceId,
    );
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
