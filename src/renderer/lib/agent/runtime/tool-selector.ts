import {
  isToolAllowedByPolicy,
  type AgentProviderToolPolicy,
  type RegisteredTool,
} from '../tool-registry';
import { AGENT_RUNTIME_TOOL_SEARCH_LIMIT } from './types';

const DEFAULT_TOOL_LIMIT = 5;

const LAYER_WEIGHT = {
  name: 48,
  alias: 34,
  searchIntent: 30,
  schemaProperty: 18,
  schemaDescription: 12,
  description: 10,
} as const;

export interface ToolSearchMetadata {
  /** Extra display/search aliases; these never become executable names. */
  aliases?: readonly string[];
  /** Short user intents that should retrieve this canonical tool. */
  searchIntents?: readonly string[];
}

export type ToolSearchMetadataByName = Readonly<
  Record<string, ToolSearchMetadata | undefined>
>;

export interface CreateToolSelectorOptions {
  catalog: readonly RegisteredTool[];
  policy: AgentProviderToolPolicy;
  searchMetadata?: ToolSearchMetadataByName;
  defaultLimit?: number;
}

export interface RankedAgentTool {
  tool: RegisteredTool;
  score: number;
}

export interface AgentToolSelector {
  /** Canonical, policy-filtered definitions used to build the local index. */
  readonly eligibleTools: readonly RegisteredTool[];
  rank(query: string): readonly RankedAgentTool[];
  select(query: string, limit?: number): readonly RegisteredTool[];
}

interface TextSignal {
  normalized: string;
  tokens: ReadonlySet<string>;
  weight: number;
}

interface IndexedTool {
  tool: RegisteredTool;
  signals: readonly TextSignal[];
  documentTokens: ReadonlySet<string>;
}

interface SchemaSignals {
  properties: string[];
  descriptions: string[];
}

function normalizedText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function addEnglishStem(tokens: Set<string>, token: string): void {
  if (!/^[a-z][a-z0-9]*$/u.test(token) || token.length <= 3) return;
  if (token.endsWith('ies') && token.length > 4) {
    tokens.add(`${token.slice(0, -3)}y`);
    return;
  }
  if (
    token.endsWith('es') &&
    token.length > 4 &&
    !token.endsWith('ses')
  ) {
    tokens.add(token.slice(0, -2));
    return;
  }
  if (
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  ) {
    tokens.add(token.slice(0, -1));
  }
}

function tokensFor(value: string): ReadonlySet<string> {
  const normalized = normalizedText(value);
  const tokens = new Set<string>();
  const segments =
    normalized.match(/\p{Script=Han}+|[\p{Letter}\p{Number}]+/gu) ?? [];

  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const chars = [...segment];
      for (const char of chars) tokens.add(char);
      for (let index = 0; index + 1 < chars.length; index += 1) {
        tokens.add(`${chars[index]}${chars[index + 1]}`);
      }
      continue;
    }
    tokens.add(segment);
    addEnglishStem(tokens, segment);
  }
  return tokens;
}

function collectSchemaSignals(schema: unknown): SchemaSignals {
  const properties: string[] = [];
  const descriptions: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    const record = value as Record<string, unknown>;
    if (typeof record.description === 'string') {
      descriptions.push(record.description);
    }
    if (
      record.properties &&
      typeof record.properties === 'object' &&
      !Array.isArray(record.properties)
    ) {
      for (const [property, child] of Object.entries(
        record.properties as Record<string, unknown>,
      )) {
        properties.push(property);
        visit(child);
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key === 'properties' || key === 'description') continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
  };

  visit(schema);
  return { properties, descriptions };
}

function textSignal(value: string, weight: number): TextSignal | undefined {
  const normalized = normalizedText(value);
  if (!normalized) return undefined;
  return {
    normalized,
    tokens: tokensFor(value),
    weight,
  };
}

function appendSignals(
  target: TextSignal[],
  values: readonly string[],
  weight: number,
): void {
  for (const value of values) {
    const signal = textSignal(value, weight);
    if (signal) target.push(signal);
  }
}

function indexTool(
  tool: RegisteredTool,
  metadata: ToolSearchMetadata | undefined,
): IndexedTool {
  const signals: TextSignal[] = [];
  const schema = collectSchemaSignals(tool.parametersSchema);

  appendSignals(signals, [tool.name], LAYER_WEIGHT.name);
  appendSignals(
    signals,
    [...tool.aliases, ...(metadata?.aliases ?? [])],
    LAYER_WEIGHT.alias,
  );
  appendSignals(
    signals,
    metadata?.searchIntents ?? [],
    LAYER_WEIGHT.searchIntent,
  );
  appendSignals(
    signals,
    schema.properties,
    LAYER_WEIGHT.schemaProperty,
  );
  appendSignals(
    signals,
    schema.descriptions,
    LAYER_WEIGHT.schemaDescription,
  );
  appendSignals(signals, [tool.description], LAYER_WEIGHT.description);

  const documentTokens = new Set<string>();
  for (const signal of signals) {
    for (const token of signal.tokens) documentTokens.add(token);
  }
  return { tool, signals, documentTokens };
}

function tokenSpecificity(token: string): number {
  if (/^\p{Script=Han}$/u.test(token)) return 0.35;
  if (/^\p{Script=Han}{2}$/u.test(token)) return 1.4;
  return 1;
}

function scoreSignal(
  queryNormalized: string,
  queryTokens: ReadonlySet<string>,
  signal: TextSignal,
  inverseDocumentFrequency: ReadonlyMap<string, number>,
): number {
  let overlap = 0;
  let matchedImportance = 0;
  let totalImportance = 0;

  for (const token of queryTokens) {
    const importance =
      tokenSpecificity(token) * (inverseDocumentFrequency.get(token) ?? 1);
    totalImportance += importance;
    if (!signal.tokens.has(token)) continue;
    matchedImportance += importance;
    overlap += signal.weight * importance;
  }
  if (matchedImportance === 0) return 0;

  const coverage =
    totalImportance === 0 ? 0 : matchedImportance / totalImportance;
  let score = overlap + signal.weight * coverage * 1.5;
  if (signal.normalized === queryNormalized) {
    score += signal.weight * 8;
  } else if (
    signal.normalized.includes(queryNormalized) ||
    queryNormalized.includes(signal.normalized)
  ) {
    score += signal.weight * 2.5;
  }
  return score;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  const requested = Number.isFinite(limit) ? Math.floor(limit ?? fallback) : fallback;
  return Math.max(
    0,
    Math.min(AGENT_RUNTIME_TOOL_SEARCH_LIMIT, requested),
  );
}

/**
 * Build a tiny in-memory retrieval index after applying the provider policy.
 *
 * The supplied policy is the complete eligibility authority: scope, access,
 * certification, and name allow/deny lists all fail closed inside
 * `isToolAllowedByPolicy`. The selector therefore cannot index unavailable or
 * denied tools even when a query exactly matches a forbidden tool name, and a
 * provider-facing runtime-virtual surface (the author-domain workspace tools)
 * becomes retrievable only when its policy explicitly says so.
 */
export function createToolSelector(
  options: CreateToolSelectorOptions,
): AgentToolSelector {
  const eligibleTools = Object.freeze(
    options.catalog.filter((tool) => isToolAllowedByPolicy(tool, options.policy)),
  );
  const indexed = eligibleTools.map((tool) =>
    indexTool(tool, options.searchMetadata?.[tool.name]),
  );

  const documentFrequency = new Map<string, number>();
  for (const entry of indexed) {
    for (const token of entry.documentTokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const inverseDocumentFrequency = new Map<string, number>();
  for (const [token, frequency] of documentFrequency) {
    inverseDocumentFrequency.set(
      token,
      Math.log((indexed.length + 1) / (frequency + 1)) + 1,
    );
  }

  const defaultLimit = clampLimit(options.defaultLimit, DEFAULT_TOOL_LIMIT);

  const rank = (query: string): readonly RankedAgentTool[] => {
    const queryNormalized = normalizedText(query);
    if (!queryNormalized) return [];
    const queryTokens = tokensFor(query);
    if (queryTokens.size === 0) return [];

    return indexed
      .map((entry) => ({
        tool: entry.tool,
        score: entry.signals.reduce(
          (total, signal) =>
            total +
            scoreSignal(
              queryNormalized,
              queryTokens,
              signal,
              inverseDocumentFrequency,
            ),
          0,
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.tool.name.localeCompare(right.tool.name, 'en'),
      );
  };

  return Object.freeze({
    eligibleTools,
    rank,
    select(query: string, limit?: number): readonly RegisteredTool[] {
      const boundedLimit = clampLimit(limit, defaultLimit);
      if (boundedLimit === 0) return [];
      return rank(query)
        .slice(0, boundedLimit)
        .map((entry) => entry.tool);
    },
  });
}

export const MAX_SELECTED_AGENT_TOOLS = AGENT_RUNTIME_TOOL_SEARCH_LIMIT;
