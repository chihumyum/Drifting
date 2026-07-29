import {
  AgentContextCompactionCircuitBreaker,
  classifyAgentContextSource,
  createAgentContextSummaryCandidate,
  type AgentContextPlannerInput,
  type AgentContextSourceRow,
  type AgentContextSummaryCandidate,
} from '../context-planner';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function repeatPayload(label: string, length: number): string {
  if (length <= label.length) return label.slice(0, length);
  return `${label}:${'x'.repeat(length - label.length - 1)}`;
}

function source(
  sourceId: string,
  ordinal: number,
  turnOrdinal: number | null,
  kind: AgentContextSourceRow['kind'],
  content: string,
  tool?: {
    callId: string;
    toolName: string;
    toolAccess: 'read' | 'write';
  },
): AgentContextSourceRow {
  return {
    sourceId,
    ordinal,
    turnOrdinal,
    kind,
    content,
    ...tool,
  };
}

export interface P4LongContextScenario {
  scenario: number;
  seed: number;
  input: AgentContextPlannerInput;
  rows: AgentContextSourceRow[];
  exactRows: AgentContextSourceRow[];
  constraintPayloads: string[];
  getFullCompactionCount(): number;
}

export async function createP4LongContextScenario(input: {
  scenario: number;
  seed: number;
  deterministicSummaryStride?: number | null;
}): Promise<P4LongContextScenario> {
  const random = seededRandom(input.seed * 1_009 + input.scenario * 9_973);
  const rows: AgentContextSourceRow[] = [];
  const oldCompressibleRuns: AgentContextSourceRow[][] = [];
  const constraintPayloads: string[] = [];
  let ordinal = 0;
  const add = (
    sourceId: string,
    turnOrdinal: number | null,
    kind: AgentContextSourceRow['kind'],
    content: string,
    tool?: {
      callId: string;
      toolName: string;
      toolAccess: 'read' | 'write';
    },
  ): AgentContextSourceRow => {
    const next = source(sourceId, ordinal, turnOrdinal, kind, content, tool);
    ordinal += 1;
    rows.push(next);
    return next;
  };

  const policy = `POLICY-${input.scenario}-${input.seed}: never bypass renderer use cases`;
  add('system-policy', null, 'system_policy', policy);
  constraintPayloads.push(policy);

  const turnCount = 24;
  const recentTurnStart = turnCount - 2;
  for (let turn = 0; turn < turnCount; turn += 1) {
    const constraint = `CONSTRAINT-${input.scenario}-${input.seed}-${turn}: preserve authored truth`;
    add(`user-${turn}`, turn, 'user', constraint);
    constraintPayloads.push(constraint);

    const run: AgentContextSourceRow[] = [];
    const narrativeLength = 3_000 + Math.floor(random() * 700);
    run.push(
      add(
        `assistant-${turn}`,
        turn,
        'assistant_narrative',
        repeatPayload(
          `assistant-history-${input.scenario}-${input.seed}-${turn}`,
          narrativeLength,
        ),
      ),
    );

    if ((turn + input.scenario) % 2 === 0) {
      const readTool = {
        callId: `read-${turn}`,
        toolName: turn % 4 === 0 ? 'read_node' : 'read_chapter',
        toolAccess: 'read' as const,
      };
      run.push(
        add(
          `read-call-${turn}`,
          turn,
          'tool_call',
          `{"turn":${turn},"query":"facts"}`,
          readTool,
        ),
      );
      run.push(
        add(
          `read-result-${turn}`,
          turn,
          'tool_result',
          repeatPayload(
            `read-result-${input.scenario}-${input.seed}-${turn}`,
            1_800 + Math.floor(random() * 500),
          ),
          readTool,
        ),
      );
    }
    if (turn < recentTurnStart) oldCompressibleRuns.push(run);

    if (turn === 10) {
      const writeTool = {
        callId: 'write-rename',
        toolName: 'rename_node',
        toolAccess: 'write' as const,
      };
      const writeCall = `{"node":"chapter-1","title":"Canonical ${input.scenario}-${input.seed}"}`;
      const writeResult = `{"ok":true,"revision":${input.scenario + input.seed + 1}}`;
      const review = `REVIEW-${input.scenario}-${input.seed}:accepted`;
      const revert = `REVERT-${input.scenario}-${input.seed}:available-exact`;
      add('write-call', turn, 'tool_call', writeCall, writeTool);
      add('write-result', turn, 'tool_result', writeResult, writeTool);
      add('write-review', turn, 'write_review', review);
      add('write-revert', turn, 'write_revert', revert);
      constraintPayloads.push(writeCall, writeResult, review, revert);
    }
    add(
      `thinking-${turn}`,
      turn,
      'thinking',
      repeatPayload(`discardable-thinking-${turn}`, 800),
    );
  }
  const freshness = `FRESHNESS-${input.scenario}-${input.seed}:revision=${
    input.scenario * 100 + input.seed
  }`;
  add('freshness', null, 'freshness', freshness);
  constraintPayloads.push(freshness);

  const stride =
    input.deterministicSummaryStride === undefined
      ? 4
      : input.deterministicSummaryStride;
  const deterministicSummaries: AgentContextSummaryCandidate[] = [];
  if (stride !== null) {
    for (let index = 0; index < oldCompressibleRuns.length; index += 1) {
      if ((index + input.seed) % stride !== 0) continue;
      const run = oldCompressibleRuns[index];
      deterministicSummaries.push(
        await createAgentContextSummaryCandidate({
          summaryId: `det-${input.scenario}-${input.seed}-${index}`,
          sourceRows: run,
          content: `Deterministic history summary for turn ${index}.`,
        }),
      );
    }
  }

  let fullCompactionCount = 0;
  const circuit = new AgentContextCompactionCircuitBreaker();
  const plannerInput: AgentContextPlannerInput = {
    contextWindowTokens: 16_000,
    requestedOutputTokens: 2_048,
    fixedInputTokens: 0,
    sourceRows: rows,
    deterministicSummaries,
    compactionCircuit: circuit,
    fullCompactor: async ({ eligibleRuns }) => {
      fullCompactionCount += 1;
      return await Promise.all(
        eligibleRuns.map((run, index) =>
          createAgentContextSummaryCandidate({
            summaryId: `full-${input.scenario}-${input.seed}-${index}`,
            sourceRows: run,
            content: `Compact verified history ${input.scenario}/${input.seed}/${index}.`,
          }),
        ),
      );
    },
  };

  const recentTurns = new Set([turnCount - 2, turnCount - 1]);
  const exactRows = rows.filter((row) => {
    const classification = classifyAgentContextSource(row);
    return (
      classification === 'pinned' ||
      (classification === 'compressible' &&
        row.turnOrdinal !== null &&
        recentTurns.has(row.turnOrdinal))
    );
  });

  return {
    scenario: input.scenario,
    seed: input.seed,
    input: plannerInput,
    rows,
    exactRows,
    constraintPayloads,
    getFullCompactionCount: () => fullCompactionCount,
  };
}

export function createP4PropertyHistory(seed: number): AgentContextSourceRow[] {
  const random = seededRandom(seed + 17);
  const rows: AgentContextSourceRow[] = [];
  let ordinal = 0;
  const add = (
    sourceId: string,
    turnOrdinal: number | null,
    kind: AgentContextSourceRow['kind'],
    content: string,
    tool?: {
      callId: string;
      toolName: string;
      toolAccess: 'read' | 'write';
    },
  ) => {
    rows.push(source(sourceId, ordinal, turnOrdinal, kind, content, tool));
    ordinal += 1;
  };

  add('system', null, 'system_policy', `policy-${seed}`);
  const turns = 1 + (seed % 4);
  for (let turn = 0; turn < turns; turn += 1) {
    add(`user-${turn}`, turn, 'user', `constraint-${seed}-${turn}`);
    add(
      `assistant-${turn}`,
      turn,
      'assistant_narrative',
      repeatPayload(`answer-${seed}-${turn}`, 20 + Math.floor(random() * 80)),
    );
    if ((seed + turn) % 3 === 0) {
      const access = (seed + turn) % 11 === 0 ? 'write' : 'read';
      const tool = {
        callId: `call-${turn}`,
        toolName: access === 'write' ? 'rename_node' : 'read_node',
        toolAccess: access as 'read' | 'write',
      };
      add(`call-${turn}`, turn, 'tool_call', `{"seed":${seed}}`, tool);
      add(`result-${turn}`, turn, 'tool_result', `{"ok":true}`, tool);
    }
    if ((seed + turn) % 2 === 0) {
      add(`thinking-${turn}`, turn, 'thinking', `thinking-${seed}-${turn}`);
    }
  }
  add('freshness', null, 'freshness', `revision-${seed}`);
  return rows;
}
