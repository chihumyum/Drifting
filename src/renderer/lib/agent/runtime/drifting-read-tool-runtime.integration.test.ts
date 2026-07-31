import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlainCommentDoc } from '../../../domain/comment';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';

const proseDoc = JSON.stringify({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { blockId: 'block-1' },
      content: [{ type: 'text', text: '雨夜里，柳青点亮了一盏灯。🙂' }],
    },
  ],
});

const memoryFixture = vi.hoisted(() => ({
  rows: [
    {
      id: 'memory-1',
      projectId: 'project-1',
      kind: 'directive',
      status: 'active',
      body: '保持克制。',
      targetKind: null,
      targetId: null,
    },
  ],
}));

const proseTruthFixture = vi.hoisted(() => ({
  byId: new Map<string, string>(),
}));

vi.mock('../../../sqlite-repo/content-repo', () => ({
  createBookContentRepository: () => ({
    findByNodeId: async (nodeId: string) =>
      nodeId === 'node-1'
        ? { nodeId, contentJson: proseDoc }
        : null,
  }),
}));

vi.mock('../../../sqlite-repo/inline-mention-repo', () => ({
  createInlineMentionRepository: () => ({
    listMentionsFromSource: async () => [
      {
        toKind: 'element',
        toId: 'element-1',
      },
    ],
    listBacklinksToTarget: async () => [
      {
        fromKind: 'node',
        fromId: 'node-1',
        fromTitle: '第一章',
        fromBlockId: 'block-1',
        fromSpansJson: '[{"from":4,"to":6}]',
      },
    ],
  }),
}));

vi.mock('../../../sqlite-repo/element-patch-repo', () => ({
  createElementPatchRepository: () => ({
    listByElement: async () => [
      {
        id: 'patch-1',
        title: '获得灯',
        sourceNodeTitle: '第一章',
        contentJson: proseDoc,
        invalidatedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }),
}));

vi.mock('../../../usecase/useAgentMemory', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../usecase/useAgentMemory')>();
  return {
    ...actual,
    listLiveMemories: async () => memoryFixture.rows,
  };
});

vi.mock('../chapter-prose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chapter-prose')>();
  return {
    ...actual,
    getChapterContentJson: async () => proseDoc,
    getEntityContentJson: async (_kind: string, id: string) =>
      proseTruthFixture.byId.get(id) ?? proseDoc,
    getElementContentJson: async () => proseDoc,
  };
});

import {
  setActiveAgentToolContext,
  type AgentWriteApi,
} from '../tool-handlers';
import { AGENT_READ_TOOLS } from '../tool-registry';
import { DriftingReadToolRuntime } from './drifting-read-tool-runtime';
import type { AgentToolExecutionRequest } from './types';

const stableProseBase = {
  revision: 1,
  stateVector: Uint8Array.of(1),
  stateHash: `sha256:${'1'.repeat(64)}`,
};

const route = {
  route: { kind: 'chat' as const, projectId: 'project-1' },
};

const validArguments: Record<string, Record<string, unknown>> = {
  get_overview: {},
  get_project_brief: {},
  list_nodes: {},
  list_elements: {},
  read_element: { element: '柳青' },
  get_element_patches: { element: '柳青' },
  read_node: { node: '第一章' },
  read_block: { node: '第一章', blockId: 'block-1' },
  lookup_block: { node: '第一章', ordinal: 1 },
  get_storyline: { storyline: '主线' },
  get_entity_relations: { kind: 'element', name: '柳青' },
  where_does_entity_appear: { kind: 'element', name: '柳青' },
  search_prose: { query: '雨夜', limit: 10 },
  search_project: { query: '柳' },
  list_comments: {},
  list_memory: {},
  list_materials: {},
  read_material: { material: '气氛样稿' },
};

function request(
  name: string,
  argumentsValue: Record<string, unknown>,
): AgentToolExecutionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: `call-${name}`,
    idempotencyKey: `session-1:turn-1:call-${name}`,
    name,
    arguments: argumentsValue,
    access: 'read',
    context: route,
    signal: new AbortController().signal,
    control: {
      requestUserInput: async () => {
        throw new Error('read integration test did not expect user input');
      },
    },
  };
}

function domainSnapshot(): string {
  const data = useDataStore.getState();
  const project = useProjectStore.getState();
  return JSON.stringify({
    storylines: data.storylines,
    storylineNodeMapping: data.storylineNodeMapping,
    nodeStorylineMapping: data.nodeStorylineMapping,
    primaryStorylineByNode: data.primaryStorylineByNode,
    bookNodes: data.bookNodes,
    bookElementCategories: data.bookElementCategories,
    bookElements: data.bookElements,
    libraryItems: data.libraryItems,
    comments: data.comments,
    entityRelations: data.entityRelations,
    currentProject: project.currentProject,
    projects: project.projects,
  });
}

function expectPortableTree(value: unknown, path = '$'): void {
  expect(value, `${path} must not be undefined`).not.toBeUndefined();
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      expectPortableTree(child, `${path}[${index}]`),
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      expectPortableTree(child, `${path}.${key}`);
    }
  }
}

describe('DriftingReadToolRuntime with the real renderer dispatcher', () => {
  let writeCalls: string[];

  beforeEach(() => {
    proseTruthFixture.byId.clear();
    memoryFixture.rows = [
      {
        id: 'memory-1',
        projectId: 'project-1',
        kind: 'directive',
        status: 'active',
        body: '保持克制。',
        targetKind: null,
        targetId: null,
      },
    ];
    writeCalls = [];
    const write = new Proxy(
      {},
      {
        get: (_target, property) => async () => {
          writeCalls.push(String(property));
          throw new Error('read-only acceptance invoked a write usecase');
        },
      },
    ) as AgentWriteApi;
    setActiveAgentToolContext({ projectId: 'project-1', write });

    useProjectStore.setState({
      currentProject: {
        id: 'project-1',
        userId: 'user-1',
        name: '漂流之书',
        summary: '一个关于记忆的故事。',
        kvJson: '[{"key":"语气","value":"克制"}]',
        storylineTemplateKvJson: '[]',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      projects: [],
    });
    useDataStore.setState({
      storylines: [
        {
          id: 'storyline-1',
          projectId: 'project-1',
          name: '主线',
          color: '#123456',
          summary: '寻找遗失的灯。',
          orderKey: 1,
          contentJson: proseDoc,
          kvJson: '[{"key":"目标","value":"找到灯"}]',
          nodeContentTemplateJson: '{}',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      storylineNodeMapping: { 'storyline-1': ['node-1'] },
      nodeStorylineMapping: { 'node-1': ['storyline-1'] },
      primaryStorylineByNode: { 'node-1': 'storyline-1' },
      bookNodes: [
        {
          id: 'node-1',
          projectId: 'project-1',
          kind: 'chapter',
          title: '第一章',
          summary: '柳青在雨夜点灯。',
          bookOrder: 1,
          narrativeOrder: 1,
          driftGroupId: null,
          position: { x: 0, y: 0 },
          wordCount: 14,
          writingStatus: 'draft',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'foreign-node',
          projectId: 'project-foreign',
          kind: 'chapter',
          title: 'FOREIGN_SECRET',
          summary: 'must never leak',
          bookOrder: 1,
          narrativeOrder: 1,
          driftGroupId: null,
          position: { x: 0, y: 0 },
          wordCount: 1,
          writingStatus: 'draft',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      bookElementCategories: [
        {
          id: 'category-1',
          projectId: 'project-1',
          name: '角色',
          contentJson: proseDoc,
          elementTemplateJson: '{}',
          elementTemplateKvJson: '[]',
          color: '#abcdef',
          layoutMode: 'auto',
          gridX: null,
          gridY: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      bookElements: [
        {
          id: 'element-1',
          projectId: 'project-1',
          categoryId: 'category-1',
          name: '柳青',
          summary: '守灯人',
          contentJson: proseDoc,
          kvJson: '[{"key":"身份","value":"守灯人"}]',
          aliases: ['阿青'],
          groupName: null,
          portraitAssetId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      libraryItems: [
        {
          id: 'material-1',
          projectId: 'project-1',
          title: '气氛样稿',
          kind: 'text',
          source: 'local',
          uri: '',
          localPath: null,
          assetId: null,
          mime: 'text/plain',
          sizeBytes: 20,
          bodyJson: '雨落在旧城的瓦片上。',
          notesJson: '参考节奏',
          thumbnailUri: null,
          orderKey: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      comments: [
        {
          id: 'comment-1',
          projectId: 'project-1',
          kind: 'todo',
          targetKind: 'node',
          targetId: 'node-1',
          targetBlockId: 'block-1',
          anchorJson: '{}',
          authorKind: 'user',
          authorId: 'user-1',
          authorName: '作者',
          bodyJson: createPlainCommentDoc('补一处灯的来历。'),
          status: 'open',
          priority: 'med',
          source: 'manual',
          metadataJson: null,
          targetBlockIdsJson: '["block-1"]',
          resolvedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      entityRelations: [
        {
          id: 'relation-1',
          projectId: 'project-1',
          fromKind: 'element',
          fromId: 'element-1',
          toKind: 'node',
          toId: 'node-1',
          kind: 'appears-in',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  afterEach(() => {
    setActiveAgentToolContext(null);
    useDataStore.setState({
      storylines: [],
      storylineNodeMapping: {},
      nodeStorylineMapping: {},
      primaryStorylineByNode: {},
      bookNodes: [],
      bookElementCategories: [],
      bookElements: [],
      libraryItems: [],
      comments: [],
      entityRelations: [],
    });
    useProjectStore.setState({ currentProject: null, projects: [] });
  });

  it('executes every registered read tool without mutating domain state or leaking projects', async () => {
    const runtime = new DriftingReadToolRuntime({
      freshness: null,
      readProseBase: async () => stableProseBase,
    });
    const before = domainSnapshot();
    const results: Record<string, unknown> = {};

    expect(Object.keys(validArguments).sort()).toEqual(
      AGENT_READ_TOOLS.map((tool) => tool.name).sort(),
    );
    for (const tool of AGENT_READ_TOOLS) {
      const result = await runtime.execute(
        request(tool.name, validArguments[tool.name] ?? {}),
      );
      expect(result, tool.name).toMatchObject({ ok: true });
      if (result.ok) {
        expectPortableTree(result.data, tool.name);
        results[tool.name] = result.data;
      }
    }

    expect(writeCalls).toEqual([]);
    expect(domainSnapshot()).toBe(before);
    expect(JSON.stringify(results)).not.toContain('FOREIGN_SECRET');
    expect(results.read_node).toContain('雨夜里');
    expect(results.read_element).toMatchObject({ name: '柳青' });
    expect(results.list_memory).toMatchObject({
      memories: [expect.objectContaining({ body: '保持克制。' })],
    });
  });

  it('resolves the neutral read_node reference in the selected prose-entity namespace', async () => {
    const runtime = new DriftingReadToolRuntime({
      freshness: null,
      readProseBase: async () => stableProseBase,
    });

    const result = await runtime.execute(
      request('read_node', {
        node: '柳青',
        kind: 'element',
        prose: true,
      }),
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toContain('element "柳青"');
    expect(result.data).toContain('雨夜里');
  });

  it('searches authoritative closed-document prose instead of stale contentJson caches', async () => {
    proseTruthFixture.byId.set(
      'node-1',
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { blockId: 'truth-block' },
            content: [
              {
                type: 'text',
                text: '只有持久化 Yjs 真相包含 CLOSED_TRUTH_MARKER。',
              },
            ],
          },
        ],
      }),
    );
    const runtime = new DriftingReadToolRuntime({ freshness: null });

    const result = await runtime.execute(
      request('search_prose', {
        query: 'CLOSED_TRUTH_MARKER',
        limit: 10,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        matches: [
          {
            kind: 'chapter',
            title: '第一章',
            block: 1,
            snippet: expect.stringContaining('CLOSED_TRUTH_MARKER'),
          },
        ],
      },
    });
  });

  it('returns a stable manuscript order even when the hydrated store array is shuffled', async () => {
    const existing = useDataStore
      .getState()
      .bookNodes.find(
        (node) =>
          node.kind === 'chapter' && node.projectId === 'project-1',
      );
    if (!existing) throw new Error('chapter fixture missing');
    if (existing.kind !== 'chapter') {
      throw new Error('chapter fixture has the wrong kind');
    }
    useDataStore.setState({
      bookNodes: [
        {
          ...existing,
          id: 'node-3',
          title: '第三章',
          bookOrder: 30,
        },
        {
          ...existing,
          id: 'node-2',
          title: '第二章',
          bookOrder: 20,
        },
        {
          ...existing,
          id: 'node-1',
          title: '第一章',
          bookOrder: 10,
        },
      ],
    });
    const runtime = new DriftingReadToolRuntime({ freshness: null });

    const result = await runtime.execute(request('list_nodes', {}));

    expect(result).toMatchObject({
      ok: true,
      data: {
        chapters: [
          { name: '第一章' },
          { name: '第二章' },
          { name: '第三章' },
        ],
      },
    });
  });

  it('does not disclose stale current-project metadata through brief or overview reads', async () => {
    useProjectStore.setState({
      currentProject: {
        id: 'project-foreign',
        userId: 'user-foreign',
        name: 'FOREIGN_PROJECT_NAME',
        summary: 'FOREIGN_PROJECT_SUMMARY',
        kvJson: '[{"key":"secret","value":"FOREIGN_PROJECT_FACT"}]',
        storylineTemplateKvJson: '[]',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const runtime = new DriftingReadToolRuntime({
      freshness: null,
      readProseBase: async () => stableProseBase,
    });

    for (const name of ['get_project_brief', 'get_overview'] as const) {
      const result = await runtime.execute(request(name, {}));
      expect(result, name).toMatchObject({
        ok: true,
        data: {
          name: '',
          description: '',
          facts: [],
        },
      });
      expect(JSON.stringify(result), name).not.toContain('FOREIGN_PROJECT');
    }
    expect(writeCalls).toEqual([]);
  });

  it('has local schema coverage for normal and invalid arguments on every tool', () => {
    const runtime = new DriftingReadToolRuntime({
      freshness: null,
      readProseBase: async () => stableProseBase,
    });
    const definitions = runtime
      .listDefinitions(route)
      .filter(
        (definition) =>
          definition.name !== 'read_tool_result' &&
          definition.name !== 'ask_user',
      );

    expect(definitions).toHaveLength(AGENT_READ_TOOLS.length);
    for (const definition of definitions) {
      expect(
        definition.validateInput(validArguments[definition.name] ?? {}),
        `${definition.name} normal`,
      ).toMatchObject({ ok: true });
      expect(
        definition.validateInput({ unexpected: true }),
        `${definition.name} invalid`,
      ).toMatchObject({ ok: false });
    }
    expect(writeCalls).toEqual([]);
  });

  it('returns explicit empty or not-found results for every registered read tool', async () => {
    memoryFixture.rows = [];
    useProjectStore.setState({
      currentProject: {
        id: 'project-1',
        userId: 'user-1',
        name: '',
        summary: '',
        kvJson: '[]',
        storylineTemplateKvJson: '[]',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    useDataStore.setState({
      storylines: [],
      storylineNodeMapping: {},
      nodeStorylineMapping: {},
      primaryStorylineByNode: {},
      bookNodes: [],
      bookElementCategories: [],
      bookElements: [],
      libraryItems: [],
      comments: [],
      entityRelations: [],
    });
    const runtime = new DriftingReadToolRuntime({
      freshness: null,
      readProseBase: async () => stableProseBase,
    });
    const emptySuccesses = new Set([
      'get_overview',
      'get_project_brief',
      'list_nodes',
      'list_elements',
      'search_prose',
      'search_project',
      'list_comments',
      'list_memory',
      'list_materials',
    ]);

    for (const tool of AGENT_READ_TOOLS) {
      const result = await runtime.execute(
        request(tool.name, validArguments[tool.name] ?? {}),
      );
      expect(
        result.ok,
        `${tool.name} should ${
          emptySuccesses.has(tool.name) ? 'return an empty value' : 'report not found'
        }`,
      ).toBe(emptySuccesses.has(tool.name));
    }
    expect(writeCalls).toEqual([]);
  });
});
