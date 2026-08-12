import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOL_CATALOG,
  getRegisteredTool,
  registeredDispatchNames,
} from './tool-registry';
import {
  DRIFTING_DOMAIN_PROVIDER_TOOLS,
  DRIFTING_DOMAIN_READ_TOOLS,
  DRIFTING_DOMAIN_WRITE_TOOLS,
} from './runtime/drifting-workspace-tool-contract';

const RETIRED_GENERIC_TOOLS = [
  'browse_project',
  'read_object',
  'search_work',
  'revise_object',
  'write_object',
  'delete_object',
  'list_files',
  'read_file',
  'grep',
  'edit_file',
  'write_file',
  'delete_file',
] as const;

function dispatcherNamesFromSource(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL('./tool-handlers.ts', import.meta.url)),
    'utf8',
  );
  const marker = 'export async function runAgentTool';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);
  return [...source.slice(start).matchAll(/case\s+['"]([^'"]+)['"]\s*:/gu)].map(
    (match) => match[1],
  );
}

function schemaPropertyNames(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const record = schema as Record<string, unknown>;
  const properties =
    record.properties && typeof record.properties === 'object'
      ? Object.keys(record.properties as Record<string, unknown>)
      : [];
  return [
    ...properties,
    ...Object.values(record).flatMap((value) =>
      Array.isArray(value)
        ? value.flatMap(schemaPropertyNames)
        : schemaPropertyNames(value),
    ),
  ];
}

function objectSchemaDepth(schema: unknown, parentDepth = 0): number {
  if (!schema || typeof schema !== 'object') return parentDepth;
  const record = schema as Record<string, unknown>;
  const depth = record.type === 'object' ? parentDepth + 1 : parentDepth;
  let maximum = depth;
  for (const value of Object.values(record)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      maximum = Math.max(maximum, objectSchemaDepth(entry, depth));
    }
  }
  return maximum;
}

function objectUnionBranches(schema: unknown): number {
  if (!schema || typeof schema !== 'object') return 0;
  const record = schema as Record<string, unknown>;
  let count = 0;
  for (const key of ['anyOf', 'oneOf']) {
    const variants = Array.isArray(record[key]) ? record[key] : [];
    count += variants.filter(
      (variant) =>
        variant &&
        typeof variant === 'object' &&
        !Array.isArray(variant) &&
        (variant as Record<string, unknown>).type === 'object',
    ).length;
  }
  for (const value of Object.values(record)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) count += objectUnionBranches(entry);
  }
  return count;
}

describe('canonical Agent tool catalog', () => {
  it('installs only explicit domain tools and removes every generic object/filesystem verb', () => {
    expect(DRIFTING_DOMAIN_READ_TOOLS).toHaveLength(23);
    expect(DRIFTING_DOMAIN_WRITE_TOOLS).toHaveLength(46);
    expect(DRIFTING_DOMAIN_PROVIDER_TOOLS).toHaveLength(69);
    expect(new Set(DRIFTING_DOMAIN_PROVIDER_TOOLS).size).toBe(69);

    for (const name of DRIFTING_DOMAIN_PROVIDER_TOOLS) {
      expect(getRegisteredTool(name), name).toMatchObject({ name });
    }
    for (const name of RETIRED_GENERIC_TOOLS) {
      expect(getRegisteredTool(name), name).toBeUndefined();
      expect(DRIFTING_DOMAIN_PROVIDER_TOOLS).not.toContain(name);
    }
  });

  it('keeps every public domain schema free of storage and freshness plumbing', () => {
    const forbidden = new Set([
      'path',
      'attributes',
      'expectedRevision',
      'receiptId',
      'observationId',
      'revision',
      'oldText',
      'newText',
      'replacements',
    ]);

    for (const name of DRIFTING_DOMAIN_PROVIDER_TOOLS) {
      const tool = getRegisteredTool(name)!;
      expect(tool.parametersSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(
        schemaPropertyNames(tool.parametersSchema).filter((property) =>
          forbidden.has(property),
        ),
        name,
      ).toEqual([]);
      expect(Object.keys(tool.parametersSchema.properties ?? {}).length, name).toBeLessThanOrEqual(8);
      expect(objectSchemaDepth(tool.parametersSchema), name).toBeLessThanOrEqual(2);
      expect(objectUnionBranches(tool.parametersSchema), name).toBe(0);
      expect(tool.description, name).not.toMatch(
        /\b(?:Yjs|SQLite|path|file|revision|receipt|node|drift)\b/iu,
      );
    }
  });

  it('accepts narrow domain arguments and rejects the retired generic shapes', () => {
    const valid: Readonly<Record<string, Record<string, unknown>>> = {
      read_chapter: { chapter: '第一章 雨夜' },
      create_chapter: { title: '第二章 清晨', body: '天亮了。' },
      create_element: { category: '人物', name: '奥伦', summary: '退休银行家。' },
      update_element: { element: '奥伦', summary: '背负最后一笔债。' },
      revise_element: {
        element: '奥伦',
        changes: [{ currentText: '他没有回头。', revisedText: '他终究回了头。' }],
      },
      create_relation: {
        fromType: 'element',
        fromName: '奥伦',
        toType: 'chapter',
        toName: '第一章 雨夜',
        relationType: '出场于',
      },
      update_relation: { relationId: 'relation-1', relationType: '保护' },
      delete_relation: { relationId: 'relation-1' },
      create_comment: {
        body: '核对这一处伏笔。',
        kind: 'todo',
        targetType: 'chapter',
        targetName: '第一章 雨夜',
        targetText: '她把钥匙放回了桌上。',
      },
      list_comments: {
        targetType: 'chapter',
        targetName: '第一章 雨夜',
        status: 'open',
        onlyTodos: true,
      },
      create_author_rule: { kind: 'veto', body: '不要使用全知视角。' },
    };

    for (const [name, args] of Object.entries(valid)) {
      const schema = getRegisteredTool(name)!.parametersSchema;
      expect(Value.Check(schema, args), name).toBe(true);
      expect(Value.Check(schema, { target: '某对象', attributes: [] }), name).toBe(false);
    }
    expect(
      Value.Check(getRegisteredTool('create_comment')!.parametersSchema, {
        body: '不要让模型操作内部句柄。',
        targetType: 'chapter',
        targetName: '第一章 雨夜',
        targetBlockId: 'block-internal-only',
      }),
    ).toBe(false);
  });

  it('requires confirmation only for destructive domain operations', () => {
    for (const name of [
      'create_relation',
      'update_relation',
      'add_chapter_to_storyline',
      'set_chapter_primary_storyline',
      'update_comment',
    ]) {
      expect(getRegisteredTool(name)?.approval, name).toBe('automatic');
    }
    for (const name of [
      'delete_chapter',
      'delete_inspiration',
      'delete_element',
      'delete_element_category',
      'delete_storyline',
      'remove_chapter_from_storyline',
      'replace_storyline_chapters',
      'delete_relation',
      'delete_comment',
      'delete_author_rule',
      'delete_element_patch',
    ]) {
      expect(getRegisteredTool(name)?.approval, name).toBe('confirm_before');
    }
  });

  it('covers every hidden runAgentTool handler exactly once', () => {
    const dispatcherNames = dispatcherNamesFromSource();
    const catalogDispatchNames = AGENT_TOOL_CATALOG.filter(
      (tool) => tool.scope !== 'runtime-virtual',
    ).flatMap(registeredDispatchNames);

    expect(new Set(dispatcherNames).size).toBe(dispatcherNames.length);
    expect(new Set(catalogDispatchNames).size).toBe(catalogDispatchNames.length);
    expect(catalogDispatchNames.sort()).toEqual(dispatcherNames.sort());
  });

  it('classifies every catalog entry and keeps canonical names unique', () => {
    const canonicalNames = AGENT_TOOL_CATALOG.map((tool) => tool.name);
    expect(new Set(canonicalNames).size).toBe(canonicalNames.length);

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
    }
  });
});
