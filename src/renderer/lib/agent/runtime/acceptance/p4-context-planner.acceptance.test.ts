import { describe, expect, it } from 'vitest';
import {
  AgentContextCompactionCircuitBreaker,
  classifyAgentContextSource,
  createAgentContextSummaryCandidate,
  planAgentContext,
  type AgentContextFullCompactor,
  type AgentContextProjectionSegment,
  type AgentContextSourceRow,
} from '../context-planner';
import {
  createP4LongContextScenario,
  createP4PropertyHistory,
} from './p4-context-planner-fixture';

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function auditProjection(
  rows: readonly AgentContextSourceRow[],
  segments: readonly AgentContextProjectionSegment[],
): string[] {
  const violations: string[] = [];
  const representation = new Map<string, string>();
  const summaryIds = new Set<string>();
  for (const segment of segments) {
    if (segment.type === 'source') {
      if (representation.has(segment.row.sourceId)) {
        violations.push(`duplicate source ${segment.row.sourceId}`);
      }
      representation.set(segment.row.sourceId, 'source');
      continue;
    }
    if (summaryIds.has(segment.summaryId)) {
      violations.push(`duplicate summary ${segment.summaryId}`);
    }
    summaryIds.add(segment.summaryId);
    for (const sourceId of segment.sourceIds) {
      if (representation.has(sourceId)) {
        violations.push(`duplicate coverage ${sourceId}`);
      }
      representation.set(sourceId, `summary:${segment.summaryId}`);
    }
  }

  for (const row of rows) {
    const expected = classifyAgentContextSource(row) === 'discardable' ? 0 : 1;
    const actual = representation.has(row.sourceId) ? 1 : 0;
    if (actual !== expected) {
      violations.push(`coverage ${row.sourceId} expected ${expected} got ${actual}`);
    }
  }

  const calls = new Map<string, AgentContextSourceRow>();
  const results = new Map<string, AgentContextSourceRow>();
  for (const row of rows) {
    if (row.kind !== 'tool_call' && row.kind !== 'tool_result') continue;
    const key = `${row.turnOrdinal}:${row.callId}`;
    const target = row.kind === 'tool_call' ? calls : results;
    if (target.has(key)) violations.push(`duplicate ${row.kind} ${key}`);
    target.set(key, row);
  }
  for (const key of new Set([...calls.keys(), ...results.keys()])) {
    const call = calls.get(key);
    const result = results.get(key);
    if (!call || !result) {
      violations.push(`orphan tool topology ${key}`);
      continue;
    }
    const callRepresentation = representation.get(call.sourceId);
    const resultRepresentation = representation.get(result.sourceId);
    const bothOriginal =
      callRepresentation === 'source' && resultRepresentation === 'source';
    const sameSummary =
      callRepresentation?.startsWith('summary:') &&
      callRepresentation === resultRepresentation;
    if (!bothOriginal && !sameSummary) {
      violations.push(`split tool topology ${key}`);
    }
  }
  return violations;
}

describe('P4 context planner acceptance', () => {
  it(
    'keeps 10,000 generated histories free of dangling, orphaned, or duplicate tool results',
    async () => {
      const propertyCases = 10_000;
      const batchSize = 100;
      const violations: string[] = [];

      for (let offset = 0; offset < propertyCases; offset += batchSize) {
        const results = await Promise.all(
          Array.from(
            { length: Math.min(batchSize, propertyCases - offset) },
            async (_, index) => {
              const seed = offset + index;
              const rows = createP4PropertyHistory(seed);
              const result = await planAgentContext({
                contextWindowTokens: 20_000,
                requestedOutputTokens: 1_024,
                fixedInputTokens: 0,
                sourceRows: rows,
              });
              return { seed, rows, result };
            },
          ),
        );
        for (const item of results) {
          if (!item.result.ok) {
            violations.push(
              `seed ${item.seed} failed: ${item.result.error.code}`,
            );
            continue;
          }
          for (const violation of auditProjection(
            item.rows,
            item.result.plan.segments,
          )) {
            violations.push(`seed ${item.seed}: ${violation}`);
          }
        }
      }

      console.info({
        propertyHistories: propertyCases,
        danglingOrphanDuplicateViolations: violations.length,
      });
      expect(violations).toEqual([]);
    },
  );

  it('passes 20 long scenarios across three deterministic seeds', async () => {
    const seeds = [11, 29, 47];
    const reductions: number[] = [];
    const windowRatios: number[] = [];
    let exactRows = 0;
    let exactRowsRecalled = 0;
    let constraints = 0;
    let constraintsRecalled = 0;
    let baselineCompletions = 0;
    let compactedCompletions = 0;
    const violations: string[] = [];

    for (let scenario = 0; scenario < 20; scenario += 1) {
      for (const seed of seeds) {
        const fixture = await createP4LongContextScenario({ scenario, seed });
        baselineCompletions += 1;
        const result = await planAgentContext(fixture.input);
        if (!result.ok) {
          violations.push(
            `${scenario}/${seed} failed: ${result.error.code} ${result.error.message}`,
          );
          continue;
        }

        const checkpoint = result.plan.checkpoint;
        const initial = checkpoint.budget.initialEstimatedTokens;
        const final = checkpoint.budget.finalEstimatedTokens;
        reductions.push((initial - final) / initial);
        windowRatios.push(final / checkpoint.budget.contextWindowTokens);

        const directSources = new Map(
          result.plan.segments.flatMap((segment) =>
            segment.type === 'source'
              ? [[segment.row.sourceId, segment.row] as const]
              : [],
          ),
        );
        let scenarioExact = true;
        for (const expected of fixture.exactRows) {
          exactRows += 1;
          const actual = directSources.get(expected.sourceId);
          if (actual && JSON.stringify(actual) === JSON.stringify(expected)) {
            exactRowsRecalled += 1;
          } else {
            scenarioExact = false;
            violations.push(
              `${scenario}/${seed} lost exact source ${expected.sourceId}`,
            );
          }
        }
        for (const constraint of fixture.constraintPayloads) {
          constraints += 1;
          if (
            [...directSources.values()].some(
              (sourceRow) => sourceRow.content === constraint,
            )
          ) {
            constraintsRecalled += 1;
          } else {
            scenarioExact = false;
            violations.push(
              `${scenario}/${seed} lost constraint ${constraint.slice(0, 48)}`,
            );
          }
        }

        const topologyViolations = auditProjection(
          fixture.rows,
          result.plan.segments,
        );
        violations.push(
          ...topologyViolations.map(
            (violation) => `${scenario}/${seed}: ${violation}`,
          ),
        );
        const completed =
          scenarioExact &&
          topologyViolations.length === 0 &&
          result.plan.estimatedInputTokens <=
            result.plan.usableInputBudgetTokens;
        if (completed) compactedCompletions += 1;

        if (
          fixture.getFullCompactionCount() !== 1 ||
          checkpoint.compaction.fullCompactionCount !== 1
        ) {
          violations.push(`${scenario}/${seed} full compactor count drifted`);
        }
      }
    }

    const recall = exactRowsRecalled / exactRows;
    const constraintRecall = constraintsRecalled / constraints;
    const completionDrop =
      baselineCompletions === 0
        ? 1
        : (baselineCompletions - compactedCompletions) / baselineCompletions;
    const medianTokenReduction = median(reductions);
    const p95ContextWindowRatio = percentile(windowRatios, 0.95);

    console.info({
      longScenarios: 20,
      deterministicSeeds: seeds.length,
      runs: reductions.length,
      pinnedExactRecall: recall,
      constraintRecall,
      completionDrop,
      medianTokenReduction,
      p95ContextWindowRatio,
    });
    expect(violations).toEqual([]);
    expect(recall).toBe(1);
    expect(constraintRecall).toBe(1);
    expect(completionDrop).toBeLessThanOrEqual(0.05);
    expect(medianTokenReduction).toBeGreaterThanOrEqual(0.5);
    expect(p95ContextWindowRatio).toBeLessThanOrEqual(0.9);
  });

  it('fails closed and opens the circuit for compactor faults without a second attempt', async () => {
    type Fault = {
      name: string;
      expectedCode: string;
      timeoutMs?: number;
      createCompactor: () => AgentContextFullCompactor;
    };
    const faults: Fault[] = [
      {
        name: 'throw',
        expectedCode: 'COMPACTOR_FAILED',
        createCompactor: () => async () => {
          throw new Error('injected compactor failure');
        },
      },
      {
        name: 'hash drift',
        expectedCode: 'INVALID_SUMMARY',
        createCompactor: () => async ({ eligibleRuns }) => [
          {
            summaryId: 'bad-hash',
            sourceIds: eligibleRuns[0].map((row) => row.sourceId),
            sourceHash: `sha256:${'0'.repeat(64)}`,
            content: 'small summary',
          },
        ],
      },
      {
        name: 'split tool pair',
        expectedCode: 'INVALID_SUMMARY',
        createCompactor: () => async ({ eligibleRuns }) => {
          const toolRow = eligibleRuns
            .flat()
            .find((row) => row.kind === 'tool_call');
          if (!toolRow) throw new Error('fixture lacks a read tool');
          return [
            await createAgentContextSummaryCandidate({
              summaryId: 'split-pair',
              sourceRows: [toolRow],
              content: 'partial tool summary',
            }),
          ];
        },
      },
      {
        name: 'no gain',
        expectedCode: 'COMPACTOR_NO_GAIN',
        createCompactor: () => async ({ eligibleRuns }) => [
          await createAgentContextSummaryCandidate({
            summaryId: 'no-gain',
            sourceRows: eligibleRuns[0],
            content: 'larger-summary '.repeat(10_000),
          }),
        ],
      },
      {
        name: 'timeout',
        expectedCode: 'COMPACTOR_TIMEOUT',
        timeoutMs: 5,
        createCompactor: () => async () =>
          await new Promise<never>(() => {}),
      },
    ];

    for (let index = 0; index < faults.length; index += 1) {
      const fault = faults[index];
      const fixture = await createP4LongContextScenario({
        scenario: 100 + index,
        seed: 71,
        deterministicSummaryStride: null,
      });
      const circuit = new AgentContextCompactionCircuitBreaker();
      const delegate = fault.createCompactor();
      let attempts = 0;
      const compactor: AgentContextFullCompactor = async (request) => {
        attempts += 1;
        return await delegate(request);
      };
      const plannerInput = {
        ...fixture.input,
        deterministicSummaries: [],
        fullCompactor: compactor,
        compactionCircuit: circuit,
        compactionTimeoutMs: fault.timeoutMs ?? 1_000,
      };

      const first = await planAgentContext(plannerInput);
      const second = await planAgentContext(plannerInput);

      expect(first, fault.name).toMatchObject({
        ok: false,
        error: { code: fault.expectedCode },
        diagnostics: {
          fullCompactionCount: 1,
          circuitState: { state: 'open' },
        },
      });
      expect(second, fault.name).toMatchObject({
        ok: false,
        error: { code: 'COMPACTION_CIRCUIT_OPEN' },
        diagnostics: {
          fullCompactionCount: 0,
          circuitState: { state: 'open' },
        },
      });
      expect(attempts, fault.name).toBe(1);
    }
  });
});
