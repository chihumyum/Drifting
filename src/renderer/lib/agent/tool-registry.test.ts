import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  AGENT_READ_TOOLS,
  AGENT_TOOL_CATALOG,
  GENERAL_READ_ONLY_PROVIDER_POLICY,
  getRegisteredTool,
  isToolAllowedByPolicy,
  listProviderTools,
  registeredDispatchNames,
  selectProviderTools,
  toAITools,
} from './tool-registry';

const P1_READ_NAMES = [
  'get_overview',
  'get_project_brief',
  'list_elements',
  'read_element',
  'get_element_patches',
  'read_node',
  'get_storyline',
  'get_entity_relations',
  'where_does_entity_appear',
  'search_prose',
  'search_project',
  'list_comments',
  'list_memory',
  'list_materials',
  'read_material',
] as const;

const P3_AUDITED_READ_NAMES = [
  'list_nodes',
  'read_block',
  'lookup_block',
] as const;

const P3_CERTIFIED_WRITE_NAMES = [
  'rename_node',
  'set_node_summary',
] as const;

const P5_PROSE_WRITE_NAMES = [
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'remove_blocks',
  'replace_block_range',
  'insert_blocks',
] as const;

const P5_ELEMENT_PATCH_WRITE_NAMES = [
  'create_element_patch',
  'update_element_patch',
  'delete_element_patch',
] as const;

const P6_ENTITY_WRITE_NAMES = [
  'update_element',
  'update_storyline',
  'update_project_facts',
  'create_comment',
] as const;

const CERTIFIED_WRITE_NAMES = [
  'update_element',
  ...P3_CERTIFIED_WRITE_NAMES,
  ...P5_PROSE_WRITE_NAMES,
  'update_storyline',
  'update_project_facts',
  ...P5_ELEMENT_PATCH_WRITE_NAMES,
  'create_comment',
] as const;

function dispatcherNamesFromSource(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL('./tool-handlers.ts', import.meta.url)),
    'utf8',
  );
  const marker = 'export async function runAgentTool';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);
  return [
    ...source
      .slice(start)
      .matchAll(/case\s+['"]([^'"]+)['"]\s*:/gu),
  ].map((match) => match[1]);
}

describe('canonical Agent tool catalog', () => {
  it('covers every runAgentTool handler exactly once, including the deprecated alias', () => {
    const dispatcherNames = dispatcherNamesFromSource();
    const catalogDispatchNames = AGENT_TOOL_CATALOG.filter(
      (tool) => tool.scope !== 'runtime-virtual',
    ).flatMap(registeredDispatchNames);

    expect(new Set(dispatcherNames).size).toBe(dispatcherNames.length);
    expect(new Set(catalogDispatchNames).size).toBe(
      catalogDispatchNames.length,
    );
    expect(catalogDispatchNames.sort()).toEqual(dispatcherNames.sort());
    expect(getRegisteredTool('set_element_body')).toBe(
      getRegisteredTool('set_entity_body'),
    );
    expect(getRegisteredTool('set_entity_body')?.aliases).toContain(
      'set_element_body',
    );
  });

  it('classifies the full surface with no unclassified entry', () => {
    const canonicalNames = AGENT_TOOL_CATALOG.map((tool) => tool.name);
    expect(new Set(canonicalNames).size).toBe(canonicalNames.length);

    expect(
      AGENT_TOOL_CATALOG.filter(
        (tool) => tool.scope === 'general' && tool.access === 'read',
      ),
    ).toHaveLength(18);
    expect(
      AGENT_TOOL_CATALOG.filter(
        (tool) => tool.scope === 'general' && tool.access === 'write',
      ),
    ).toHaveLength(34);
    expect(
      AGENT_TOOL_CATALOG.filter(
        (tool) => tool.scope === 'shadow-internal',
      ),
    ).toHaveLength(4);
    expect(
      AGENT_TOOL_CATALOG.filter(
        (tool) => tool.scope === 'runtime-virtual',
      ),
    ).toHaveLength(8);

    for (const tool of AGENT_TOOL_CATALOG) {
      expect(tool.name).not.toBe('');
      expect(tool.version).toBeGreaterThan(0);
      expect(tool.description).not.toBe('');
      expect(tool.parametersSchema).toMatchObject({ type: 'object' });
      expect(tool.scope).not.toBeUndefined();
      expect(tool.access).not.toBeUndefined();
      expect(tool.risk).not.toBeUndefined();
      expect(tool.effect).not.toBeUndefined();
      expect(tool.approval).not.toBeUndefined();
      expect(tool.retry).not.toBeUndefined();
      expect(tool.revertStrategy).not.toBeUndefined();
      expect(tool.certification).not.toBeUndefined();
      expect(tool.certificationNote).not.toBe('');
      expect(Array.isArray(tool.aliases)).toBe(true);
      expect(Array.isArray(tool.handlerAliases)).toBe(true);
    }
  });

  it('preserves the P1 reads and certifies the three audited pure reads', () => {
    for (const name of P1_READ_NAMES) {
      expect(getRegisteredTool(name)).toMatchObject({
        name,
        scope: 'general',
        access: 'read',
        risk: 'none',
        effect: 'none',
        certification: 'read-certified',
      });
    }
    for (const name of P3_AUDITED_READ_NAMES) {
      expect(getRegisteredTool(name)).toMatchObject({
        name,
        scope: 'general',
        access: 'read',
        risk: 'none',
        effect: 'none',
        certification: 'read-certified',
      });
      expect(getRegisteredTool(name)?.certificationNote).toContain(
        'P3 read audit',
      );
    }
    expect(AGENT_READ_TOOLS).toHaveLength(18);
  });

  it('certifies only writes with durable receipts and exact guarded inverses', () => {
    const writes = AGENT_TOOL_CATALOG.filter(
      (tool) => tool.scope === 'general' && tool.access === 'write',
    );
    expect(writes).toHaveLength(34);
    expect(
      writes.filter((tool) => tool.certification === 'unavailable'),
    ).toHaveLength(19);
    expect(
      writes
        .filter((tool) => tool.certification === 'write-certified')
        .map((tool) => tool.name),
    ).toEqual(CERTIFIED_WRITE_NAMES);
    for (const name of P3_CERTIFIED_WRITE_NAMES) {
      const tool = getRegisteredTool(name);
      expect(tool).toMatchObject({
        approval: 'automatic',
        retry: 'inspect_before_retry',
        revertStrategy: 'exact_inverse',
        certification: 'write-certified',
      });
      expect(
        Value.Check(tool!.parametersSchema, {
          node: '第一章',
          ...(name === 'rename_node'
            ? { title: '序章' }
            : { summary: '新的梗概' }),
        }),
      ).toBe(false);
      expect(
        Value.Check(tool!.parametersSchema, {
          node: '第一章',
          ...(name === 'rename_node'
            ? { title: '序章' }
            : { summary: '新的梗概' }),
          expectedRevision: {
            receiptId: 'agent-read:session:turn:call',
            observationId: 'agent-observation:session:turn:call:0',
            revision: '2026-07-30T00:00:00.000Z',
          },
        }),
      ).toBe(true);
    }
    for (const name of P5_PROSE_WRITE_NAMES) {
      const tool = getRegisteredTool(name)!;
      expect(tool).toMatchObject({
        effect: 'prose',
        approval: 'review_after',
        revertStrategy: 'exact_inverse',
        certification: 'write-certified',
      });
      expect(tool.certificationNote).toContain('P5 Yjs prose');
      const properties = (
        tool.parametersSchema as unknown as {
          properties: Record<string, unknown>;
        }
      ).properties;
      expect(properties.expectedRevision).toBeDefined();
      expect(
        Value.Check(tool.parametersSchema, proseArguments(name, false)),
      ).toBe(false);
      expect(
        Value.Check(tool.parametersSchema, proseArguments(name, true)),
      ).toBe(true);
    }
    for (const name of P5_ELEMENT_PATCH_WRITE_NAMES) {
      const tool = getRegisteredTool(name)!;
      expect(tool).toMatchObject({
        approval: name === 'delete_element_patch' ? 'confirm_before' : 'automatic',
        revertStrategy: 'exact_inverse',
        certification: 'write-certified',
      });
      const mutationArguments =
        name === 'create_element_patch'
          ? { element: '柳青', body: '立场发生变化' }
          : name === 'update_element_patch'
            ? { patchId: 'patch-1', title: '新的演化标题' }
            : { patchId: 'patch-1' };
      expect(
        Value.Check(tool.parametersSchema, mutationArguments),
      ).toBe(false);
      expect(
        Value.Check(tool.parametersSchema, {
          ...mutationArguments,
          expectedRevision: {
            receiptId: 'agent-read:session:turn:call',
            observationId: 'agent-observation:session:turn:call:0',
            revision: `element-patch:sha256:${'0'.repeat(64)}`,
          },
        }),
      ).toBe(true);
    }
    for (const name of P6_ENTITY_WRITE_NAMES) {
      const tool = getRegisteredTool(name)!;
      expect(tool).toMatchObject({
        approval: 'automatic',
        retry: 'inspect_before_retry',
        revertStrategy: 'exact_inverse',
        certification: 'write-certified',
      });
      expect(tool.certificationNote).toContain(
        'P6 entity-write certification',
      );
      const properties = (
        tool.parametersSchema as unknown as {
          properties: Record<string, unknown>;
        }
      ).properties;
      expect(properties.expectedRevision).toBeDefined();
    }
  });

  it('keeps exact, compensating, irreversible, and unavailable write policy distinct', () => {
    const writes = AGENT_TOOL_CATALOG.filter(
      (tool) => tool.scope === 'general' && tool.access === 'write',
    );
    const exact = writes.filter(
      (tool) => tool.revertStrategy === 'exact_inverse',
    );
    const compensating = writes.filter(
      (tool) => tool.revertStrategy === 'compensating',
    );
    const irreversible = writes.filter(
      (tool) => tool.revertStrategy === 'irreversible',
    );

    expect(exact.length).toBeGreaterThan(0);
    expect(compensating.length).toBeGreaterThan(0);
    expect(irreversible.map((tool) => tool.name).sort()).toEqual([
      'delete_comment',
      'delete_element',
    ]);

    for (const tool of exact) {
      expect(tool.reversible).toBe(true);
    }
    for (const tool of compensating) {
      expect(tool.reversible).toBe(true);
      expect(tool.certification).toBe('unavailable');
    }
    for (const tool of irreversible) {
      expect(tool).toMatchObject({
        approval: 'confirm_before',
        retry: 'never',
        reversible: false,
        certification: 'unavailable',
      });
    }

    for (const tool of writes) {
      if (tool.certification === 'write-certified') {
        expect(tool.revertStrategy).toBe('exact_inverse');
        expect(['automatic', 'review_after', 'confirm_before']).toContain(tool.approval);
        if (tool.approval === 'review_after') {
          expect(P5_PROSE_WRITE_NAMES).toContain(tool.name);
        }
        if (tool.approval === 'confirm_before') {
          expect(tool.name).toBe('delete_element_patch');
        }
      } else {
        expect(tool.certification).toBe('unavailable');
        expect(tool.certificationNote).toContain('unavailable');
      }
    }
  });

  it('exposes only canonical tools allowed and certified by provider policy', () => {
    const reads = listProviderTools();
    expect(reads).toEqual(AGENT_READ_TOOLS);
    expect(
      reads.every((tool) =>
        isToolAllowedByPolicy(tool, GENERAL_READ_ONLY_PROVIDER_POLICY),
      ),
    ).toBe(true);
    expect(reads.every((tool) => tool.access === 'read')).toBe(true);
    expect(reads.every((tool) => tool.scope === 'general')).toBe(true);

    // Asking for writes admits only the independently certified subset.
    expect(
      listProviderTools({ allowWrite: true })
        .filter((tool) => tool.access === 'write')
        .map((tool) => tool.name),
    ).toEqual(CERTIFIED_WRITE_NAMES);

    const providerNames = toAITools(AGENT_TOOL_CATALOG).map(
      (tool) => tool.name,
    );
    expect(providerNames).toEqual(reads.map((tool) => tool.name));
    expect(new Set(providerNames).size).toBe(providerNames.length);
    expect(providerNames).not.toContain('set_element_body');
    expect(providerNames).not.toContain('shadow_commit_review');
    expect(providerNames).not.toContain('read_tool_result');
    expect(providerNames).not.toContain('ask_user');
  });

  it('cannot leak an unavailable write through a permissive-looking policy', () => {
    const result = selectProviderTools({
      scopes: ['general'],
      accesses: ['read', 'write'],
      certifications: [
        'unavailable',
        'protocol-conformant',
        'read-certified',
        'write-certified',
      ],
    });

    expect(result).toHaveLength(33);
    expect(
      result
        .filter((tool) => tool.access === 'write')
        .map((tool) => tool.name),
    ).toEqual(CERTIFIED_WRITE_NAMES);
    expect(
      result.some((tool) => tool.certification === 'unavailable'),
    ).toBe(false);
  });
});

function proseArguments(
  name: (typeof P5_PROSE_WRITE_NAMES)[number],
  withFreshness: boolean,
): Record<string, unknown> {
  const target = {
    entity: '第一章',
    ...(withFreshness
      ? {
          expectedRevision: {
            receiptId: 'agent-read:session:turn:call',
            observationId: 'agent-observation:session:turn:call:1',
            revision: 'yjs:7',
          },
        }
      : {}),
  };
  switch (name) {
    case 'edit_block':
      return { ...target, block: 1, text: '新段落' };
    case 'edit_blocks':
      return {
        ...target,
        edits: [{ block: 1, text: '新段落' }],
      };
    case 'append_paragraph':
      return { ...target, text: '新增段落' };
    case 'remove_blocks':
      return { ...target, blockNumbers: [1] };
    case 'replace_block_range':
      return {
        ...target,
        fromBlock: 1,
        toBlock: 2,
        blocks: ['替换段落'],
      };
    case 'insert_blocks':
      return { ...target, afterBlock: 1, blocks: ['插入段落'] };
  }
}
