import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOL_CATALOG,
  getRegisteredTool,
  type AgentProviderToolPolicy,
  type RegisteredTool,
} from '../tool-registry';
import {
  createToolSelector,
  MAX_SELECTED_AGENT_TOOLS,
} from './tool-selector';

const READ_WRITE_POLICY: AgentProviderToolPolicy = {
  scopes: ['general'],
  accesses: ['read', 'write'],
  certifications: ['read-certified', 'write-certified'],
};

function syntheticTool(
  name: string,
  overrides: Partial<RegisteredTool> = {},
): RegisteredTool {
  const base = getRegisteredTool('get_project_brief');
  if (!base) throw new Error('Missing get_project_brief fixture');
  return {
    ...base,
    name,
    description: 'unrelated vocabulary',
    parametersSchema: Type.Object({}, { additionalProperties: false }),
    aliases: [],
    handlerAliases: [],
    ...overrides,
  };
}

describe('local Agent tool selector', () => {
  it('filters policy before indexing and cannot return internal, unavailable, or denied definitions', () => {
    const selector = createToolSelector({
      catalog: AGENT_TOOL_CATALOG,
      policy: {
        scopes: ['general', 'shadow-internal', 'runtime-virtual'],
        accesses: ['read', 'write'],
        certifications: [
          'unavailable',
          'read-certified',
          'write-certified',
          'internal-certified',
        ],
        denyNames: ['read_node'],
      },
    });

    expect(selector.eligibleTools).toHaveLength(19);
    expect(
      selector.eligibleTools.every(
        (tool) =>
          tool.scope === 'general' &&
          tool.certification !== 'unavailable' &&
          tool.name !== 'read_node',
      ),
    ).toBe(true);

    const selected = selector.select(
      'shadow_commit_review delete_element read_node',
      100,
    );
    expect(selected).toHaveLength(
      Math.min(selected.length, MAX_SELECTED_AGENT_TOOLS),
    );
    expect(selected.map((tool) => tool.name)).not.toContain(
      'shadow_commit_review',
    );
    expect(selected.map((tool) => tool.name)).not.toContain(
      'delete_element',
    );
    expect(selected.map((tool) => tool.name)).not.toContain('read_node');
  });

  it('normalizes NFKC, snake_case, English tokens, and Chinese unigram/bigram signals', () => {
    const selector = createToolSelector({
      catalog: AGENT_TOOL_CATALOG,
      policy: READ_WRITE_POLICY,
      searchMetadata: {
        search_prose: {
          searchIntents: ['全文搜索小说正文'],
        },
      },
    });

    expect(selector.select('ｒｅａｄ＿ｅｌｅｍｅｎｔ', 1)[0]?.name).toBe(
      'read_element',
    );
    expect(selector.select('read element details', 1)[0]?.name).toBe(
      'read_element',
    );
    expect(selector.select('全文检索小说段落正文', 1)[0]?.name).toBe(
      'search_prose',
    );
  });

  it('weights name, alias, search intent, schema property, schema description, and description separately', () => {
    const catalog = [
      syntheticTool('target_signal'),
      syntheticTool('alias_tool', { aliases: ['target signal'] }),
      syntheticTool('intent_tool'),
      syntheticTool('schema_property_tool', {
        parametersSchema: Type.Object({
          target_signal: Type.String(),
        }),
      }),
      syntheticTool('schema_description_tool', {
        parametersSchema: Type.Object({
          probe: Type.String({ description: 'target signal' }),
        }),
      }),
      syntheticTool('description_tool', {
        description: 'target signal',
      }),
    ];
    const selector = createToolSelector({
      catalog,
      policy: READ_WRITE_POLICY,
      searchMetadata: {
        intent_tool: { searchIntents: ['target signal'] },
      },
    });

    expect(
      selector.rank('target_signal').map((entry) => entry.tool.name),
    ).toEqual([
      'target_signal',
      'alias_tool',
      'intent_tool',
      'schema_property_tool',
      'schema_description_tool',
      'description_tool',
    ]);
  });

  it('uses a stable canonical-name tiebreak and enforces the hard limit', () => {
    const selector = createToolSelector({
      catalog: [
        syntheticTool('beta_tool'),
        syntheticTool('alpha_tool'),
        ...Array.from({ length: 10 }, (_, index) =>
          syntheticTool(`extra_${String(index).padStart(2, '0')}`),
        ),
      ],
      policy: READ_WRITE_POLICY,
      searchMetadata: Object.fromEntries([
        ['alpha_tool', { searchIntents: ['shared routing phrase'] }],
        ['beta_tool', { searchIntents: ['shared routing phrase'] }],
        ...Array.from({ length: 10 }, (_, index) => [
          `extra_${String(index).padStart(2, '0')}`,
          { searchIntents: ['shared routing phrase'] },
        ]),
      ]),
    });

    const rankedNames = selector
      .rank('shared routing phrase')
      .map((entry) => entry.tool.name);
    expect(rankedNames).toEqual([...rankedNames].sort());
    expect(selector.select('shared routing phrase', 1_000)).toHaveLength(
      MAX_SELECTED_AGENT_TOOLS,
    );
    expect(selector.select('shared routing phrase', 0)).toEqual([]);
    expect(selector.select('   ', 8)).toEqual([]);
  });
});
