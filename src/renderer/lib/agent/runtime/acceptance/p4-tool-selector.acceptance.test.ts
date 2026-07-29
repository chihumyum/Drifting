import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOL_CATALOG,
  isToolAllowedByPolicy,
  type AgentProviderToolPolicy,
  type RegisteredTool,
} from '../../tool-registry';
import {
  createToolSelector,
  MAX_SELECTED_AGENT_TOOLS,
} from '../tool-selector';
import {
  P4_TOOL_SEARCH_METADATA,
  P4_TOOL_SELECTOR_CORPUS,
} from './p4-tool-selector-corpus';

const ACCEPTANCE_POLICY: AgentProviderToolPolicy = {
  scopes: ['general'],
  accesses: ['read', 'write'],
  certifications: ['read-certified', 'write-certified'],
};

function percentile(samples: readonly number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function providerDefinitionBytes(tools: readonly RegisteredTool[]): number {
  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersSchema: tool.parametersSchema,
    })),
  ).length;
}

describe('P4 local tool-search acceptance', () => {
  const selector = createToolSelector({
    catalog: AGENT_TOOL_CATALOG,
    policy: ACCEPTANCE_POLICY,
    searchMetadata: P4_TOOL_SEARCH_METADATA,
    defaultLimit: 5,
  });

  it('keeps the corpus fixed at 150 unique, non-empty bilingual intents', () => {
    expect(P4_TOOL_SELECTOR_CORPUS).toHaveLength(150);
    expect(
      new Set(P4_TOOL_SELECTOR_CORPUS.map((intent) => intent.id)).size,
    ).toBe(150);
    expect(
      new Set(P4_TOOL_SELECTOR_CORPUS.map((intent) => intent.query)).size,
    ).toBe(150);
    expect(
      P4_TOOL_SELECTOR_CORPUS.every(
        (intent) =>
          intent.query.trim().length > 0 &&
          selector.eligibleTools.some(
            (tool) => tool.name === intent.expectedTool,
          ),
      ),
    ).toBe(true);
    expect(
      P4_TOOL_SELECTOR_CORPUS.some((intent) =>
        /\p{Script=Han}/u.test(intent.query),
      ),
    ).toBe(true);
    expect(
      P4_TOOL_SELECTOR_CORPUS.some((intent) =>
        /[a-z]/iu.test(intent.query),
      ),
    ).toBe(true);
  });

  it('meets recall, safety, policy, hard-limit, and schema-reduction gates', () => {
    let top3Hits = 0;
    let top5Hits = 0;
    let safetyCases = 0;
    let safetyTop5Hits = 0;
    const top3Misses: string[] = [];
    const top5Misses: string[] = [];
    const reductions: number[] = [];
    const fullSchemaBytes = providerDefinitionBytes(selector.eligibleTools);

    for (const intent of P4_TOOL_SELECTOR_CORPUS) {
      const top8 = selector.select(intent.query, 8);
      const top5 = top8.slice(0, 5);
      const names = top8.map((tool) => tool.name);
      if (names.slice(0, 3).includes(intent.expectedTool)) {
        top3Hits += 1;
      } else {
        top3Misses.push(`${intent.id}: ${names.slice(0, 3).join(',')}`);
      }
      if (names.slice(0, 5).includes(intent.expectedTool)) {
        top5Hits += 1;
      } else {
        top5Misses.push(`${intent.id}: ${names.slice(0, 5).join(',')}`);
      }
      if (intent.safety) {
        safetyCases += 1;
        if (names.slice(0, 5).includes(intent.expectedTool)) {
          safetyTop5Hits += 1;
        }
      }

      expect(top8.length).toBeLessThanOrEqual(MAX_SELECTED_AGENT_TOOLS);
      expect(
        top8.every(
          (tool) =>
            tool.scope === 'general' &&
            tool.certification !== 'unavailable' &&
            isToolAllowedByPolicy(tool, ACCEPTANCE_POLICY),
        ),
      ).toBe(true);

      reductions.push(
        1 - providerDefinitionBytes(top5) / fullSchemaBytes,
      );
    }

    expect(
      top3Hits / P4_TOOL_SELECTOR_CORPUS.length,
      `top3 misses:\n${top3Misses.join('\n')}`,
    ).toBeGreaterThanOrEqual(0.95);
    expect(
      top5Hits / P4_TOOL_SELECTOR_CORPUS.length,
      `top5 misses:\n${top5Misses.join('\n')}`,
    ).toBeGreaterThanOrEqual(0.99);
    expect(safetyCases).toBeGreaterThan(0);
    expect(safetyTop5Hits / safetyCases).toBe(1);
    const medianSchemaReduction = percentile(reductions, 0.5);
    expect(medianSchemaReduction).toBeGreaterThanOrEqual(0.3);
    if (process.env.DRIFTING_AGENT_ACCEPTANCE_VERBOSE === '1') {
      console.info({
        top3Recall: top3Hits / P4_TOOL_SELECTOR_CORPUS.length,
        top5Recall: top5Hits / P4_TOOL_SELECTOR_CORPUS.length,
        safetyTop5Recall: safetyTop5Hits / safetyCases,
        medianSchemaReduction,
      });
    }
  });

  it('keeps 10k warmed local searches below the 20ms p95 gate', () => {
    for (let index = 0; index < 500; index += 1) {
      selector.select(
        P4_TOOL_SELECTOR_CORPUS[index % P4_TOOL_SELECTOR_CORPUS.length]
          .query,
      );
    }

    const durations: number[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const query =
        P4_TOOL_SELECTOR_CORPUS[index % P4_TOOL_SELECTOR_CORPUS.length]
          .query;
      const startedAt = performance.now();
      selector.select(query);
      durations.push(performance.now() - startedAt);
    }

    const p95Ms = percentile(durations, 0.95);
    expect(p95Ms).toBeLessThan(20);
    if (process.env.DRIFTING_AGENT_ACCEPTANCE_VERBOSE === '1') {
      console.info({ warmedSearches: durations.length, p95Ms });
    }
  });
});
