import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import type { BookNode } from '../../../domain/book-node';
import type { Comment } from '../../../domain/comment';
import { useDataStore } from '../../../store/data-store';
import type { EntityRelationLink } from '../../../store/data-store';
import type { AgentToolContext } from '../tool-handlers';
import {
  DriftingWorkspaceToolRuntime,
  WorkspaceNoopWriteSignal,
  WORKSPACE_NOOP_WRITE_MODEL_MARKER,
  workspaceAuthoredReadStateFromArguments,
  workspaceCommandFromArguments,
} from './drifting-workspace-tool-runtime';
import type { AgentRuntimeContext, AgentToolExecutionRequest, AgentToolRuntime } from './types';

const PROJECT_ID = 'workspace-project';
const NODE_ID = 'workspace-node';
const runtimeContext: AgentRuntimeContext = {
  route: {
    kind: 'chat',
    projectId: PROJECT_ID,
    conversationId: 'workspace-conversation',
  },
};

const originalNodes = useDataStore.getState().bookNodes;
const originalElements = useDataStore.getState().bookElements;
const originalCategories = useDataStore.getState().bookElementCategories;
const originalComments = useDataStore.getState().comments;
const originalRelations = useDataStore.getState().entityRelations;

beforeEach(() => {
  const node: BookNode = {
    id: NODE_ID,
    projectId: PROJECT_ID,
    kind: 'chapter',
    title: '第一章 雨夜',
    summary: '她在雨夜抵达旧宅。',
    bookOrder: 1,
    narrativeOrder: 2,
    driftGroupId: null,
    writingStatus: 'draft',
    position: { x: 0, y: 0 },
    wordCount: 18,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  useDataStore.setState({ bookNodes: [node], comments: [], entityRelations: [] });
});

afterEach(() => {
  useDataStore.setState({
    bookNodes: originalNodes,
    bookElements: originalElements,
    bookElementCategories: originalCategories,
    comments: originalComments,
    entityRelations: originalRelations,
  });
});

describe('DriftingWorkspaceToolRuntime', () => {
  it('projects canonical entities as authored objects and renders prose without handles', async () => {
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    const root = await runtime.execute(request('browse_project', {}));
    expect(root).toMatchObject({
      ok: true,
      data: {
        files: expect.arrayContaining([
          expect.objectContaining({ path: '/chapters', name: '章节', type: 'directory' }),
          expect.objectContaining({ path: '/README.md', name: '项目说明', type: 'file' }),
        ]),
      },
    });
    expect(JSON.stringify(root)).not.toContain('/chapters/第一章 雨夜/prose.md');
    expect(root).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('作品包含'),
    });
    if (root.ok) expect(root.modelData).not.toMatch(/\/chapters|Directory|Creation guide/iu);
    if (root.ok) expect(root.modelData).not.toContain('Element category canon');

    const listed = await runtime.execute(request('browse_project', { collection: '章节' }));
    expect(listed).toMatchObject({
      ok: true,
      data: {
        files: expect.arrayContaining([
          expect.objectContaining({
            path: '/chapters/第一章 雨夜',
            name: '第一章 雨夜',
            type: 'directory',
            writable: true,
            description: expect.stringContaining('她在雨夜抵达旧宅。'),
          }),
        ]),
      },
    });
    if (listed.ok) {
      expect(listed.modelData).not.toContain('她在雨夜抵达旧宅。');
      expect(listed.modelData).toContain('章节「第一章 雨夜」');
      expect(listed.modelData).toContain('可直接用名称和完整初稿新建章节');
      expect(listed.modelData).not.toMatch(/\/chapters|prose\.md|title\.txt|meta\.json/iu);
    }

    const chapter = await runtime.execute(
      request('browse_project', { collection: '章节「第一章 雨夜」' }),
    );
    expect(chapter).toMatchObject({
      ok: true,
      data: {
        files: expect.arrayContaining([
          expect.objectContaining({
            path: '/chapters/第一章 雨夜/prose.md',
            name: '第一章 雨夜正文',
            type: 'file',
            writable: true,
          }),
        ]),
      },
    });

    const read = await runtime.execute(request('read_file', { path: '第一章 雨夜' }));
    expect(read).toMatchObject({
      ok: true,
      data: {
        path: '/chapters/第一章 雨夜/prose.md',
        name: '第一章 雨夜正文',
        content: '# 雨落旧宅\n\n她没有回头。',
        wordCount: 9,
        truncated: false,
      },
    });
    expect(JSON.stringify(read)).not.toContain('receipt');
    expect(JSON.stringify(read)).not.toContain(NODE_ID);
    expect(read).toMatchObject({
      ok: true,
      modelData:
        '章节「第一章 雨夜」正文\n字数：9\n摘要（章节「第一章 雨夜」摘要）：她在雨夜抵达旧宅。\n\n# 雨落旧宅\n\n她没有回头。',
    });
  });

  it('opens named domain collections without making the model choose a browse verb', async () => {
    const readRuntime = fakeReadRuntime();
    const readNode = readRuntime.execute;
    readRuntime.execute = vi.fn(async (input: AgentToolExecutionRequest) =>
      input.name === 'list_memory'
        ? {
            ok: true as const,
            data: {
              result: { memories: [] },
              freshness: { receiptId: 'memory-receipt', observations: [] },
            },
          }
        : readNode(input),
    );
    const runtime = createRuntime(readRuntime);

    await expect(runtime.execute(request('read_file', { path: '/' }))).resolves.toMatchObject({
      ok: true,
      data: { path: '/', files: expect.any(Array) },
    });
    await expect(
      runtime.execute(request('read_file', { path: 'chapters' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/chapters', files: expect.any(Array) },
      modelData: expect.stringContaining('章节'),
    });
    await expect(runtime.execute(request('read_file', { path: '灵感' }))).resolves.toMatchObject({
      ok: true,
      data: { path: '/drifts', files: expect.any(Array) },
      modelData: expect.stringContaining('灵感'),
    });
    await expect(
      runtime.execute(request('browse_project', { collection: '素材' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/materials', files: expect.any(Array) },
    });
    await expect(
      runtime.execute(request('browse_project', { collection: '项目信息' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/project', files: expect.any(Array) },
    });
    await expect(
      runtime.execute(request('browse_project', { collection: '项目规则' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/memory', files: expect.any(Array) },
    });
  });

  it('returns a long authored body without injecting a model workflow', async () => {
    const runtime = createRuntime(fakeReadRuntime(`1\t${'雨'.repeat(1_600)}`));

    const result = await runtime.execute(
      request('read_object', { target: '章节「第一章 雨夜」' }),
    );

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.modelData).not.toContain('当前长篇工作对象');
      expect(result.modelData).not.toContain('先完成这篇的实际取舍或修改');
      expect(result.modelData).not.toContain('修改清单');
      expect(result.modelData).not.toMatch(/file|path|directory/iu);
    }
  });

  it('states explicitly when an authored body is genuinely unfilled', async () => {
    const runtime = createRuntime(fakeReadRuntime(''));

    const result = await runtime.execute(
      request('read_object', { target: '章节「第一章 雨夜」' }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: { content: '', truncated: false },
      modelData: expect.stringContaining('正文：尚未填写。'),
    });
    if (result.ok) {
      expect(result.modelData).not.toContain('尚未读完');
    }
  });

  it('opens a quoted 灵感 name without exposing its virtual directory', async () => {
    const chapter = useDataStore.getState().bookNodes[0]!;
    useDataStore.setState({
      bookNodes: [
        chapter,
        {
          ...chapter,
          id: 'drift-outline',
          kind: 'drift',
          title: '故事大纲_b01',
          bookOrder: null,
          narrativeOrder: 3,
          writingStatus: 'drifting',
        },
      ],
    });
    const runtime = createRuntime(fakeReadRuntime('1\t大纲正文'));

    const result = await runtime.execute(
      request('read_file', { path: '灵感「故事大纲_b01」' }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: { path: '/drifts/故事大纲_b01/prose.md' },
      modelData: expect.stringContaining('灵感「故事大纲_b01」正文'),
    });
  });

  it('bundles an element summary and resolves its authored field labels', async () => {
    const category: BookElementCategory = {
      id: 'people-category',
      projectId: PROJECT_ID,
      name: '人物',
      contentJson: '{}',
      elementTemplateJson: '{}',
      elementTemplateKvJson: '[]',
      color: '#7386a8',
      layoutMode: 'auto',
      gridX: null,
      gridY: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const element: BookElement = {
      id: 'grey-banker',
      projectId: PROJECT_ID,
      categoryId: category.id,
      name: 'Grey Banker',
      summary: 'A retired banker carrying one last debt.',
      contentJson: '{}',
      kvJson: '[]',
      aliases: ['奥伦', 'Grey'],
      groupName: null,
      portraitAssetId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const relation: EntityRelationLink = {
      id: 'grey-opening-relation',
      projectId: PROJECT_ID,
      fromKind: 'element',
      fromId: element.id,
      toKind: 'node',
      toId: NODE_ID,
      kind: '出场于',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({
      bookElementCategories: [category],
      bookElements: [element],
      entityRelations: [relation],
    });
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => ({
      ok: true as const,
      data: {
        result:
          input.name === 'read_node'
            ? 'element "Grey Banker"\n\n1\tHe counts every favor twice.'
            : input.name === 'search_prose'
              ? {
                  matches: [
                    {
                      kind: 'chapter',
                      title: '第一章 雨夜',
                      snippet: '奥伦在雨夜替凯尔挡住追兵。',
                      block: 2,
                      score: 90,
                      matchedTerms: ['奥伦'],
                    },
                  ],
                }
              : input.name === 'search_project'
                ? { matches: [] }
            : {
                name: element.name,
                summary: element.summary,
                aliases: [],
                facts: [],
                groupName: null,
                category: category.name,
              },
        freshness: {
          receiptId: 'element-receipt',
          observations:
            input.name === 'read_node' || input.name === 'read_element'
              ? [
                  {
                    id: 'element-observation',
                    entityKind: input.name === 'read_node' ? 'element_prose' : 'element',
                    entityId: element.id,
                    revision: 'element:1',
                  },
                ]
              : [],
        },
      },
    }));
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    await expect(
      runtime.execute(request('read_object', { target: '人物「Grey Banker」' })),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        path: '/elements/人物/Grey Banker/body.md',
        content: 'He counts every favor twice.',
        summary: element.summary,
      },
      modelData: expect.stringContaining('要素「Grey Banker」（别名：奥伦、Grey）设定'),
    });
    const dossier = await runtime.execute(
      request('read_object', { target: '要素「Grey Banker」（别名：奥伦、Grey）' }),
    );
    expect(dossier).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('作品中的相关片段（当前正文证据，无需另行打开来源）'),
    });
    if (dossier.ok) {
      expect(dossier.modelData).toContain('奥伦在雨夜替凯尔挡住追兵。');
      expect(dossier.modelData).toContain('当前直接关系');
      expect(dossier.modelData).toContain(
        '实体关系「grey-opening-relation」：Grey Banker（别名：奥伦、Grey） —出场于→ 第一章 雨夜',
      );
      expect(dossier.modelData).not.toMatch(/\/chapters|prose\.md|search_prose/u);
    }
    const catalog = await runtime.execute(
      request('browse_project', { collection: '要素分类「人物」' }),
    );
    expect(catalog).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('要素「Grey Banker」（别名：奥伦、Grey）'),
    });
    const categories = await runtime.execute(
      request('browse_project', { collection: '实体' }),
    );
    expect(categories).toMatchObject({
      ok: true,
      data: { path: '/elements' },
      modelData: expect.stringContaining('要素分类「人物」'),
    });
    if (categories.ok) {
      expect(categories.modelData).not.toContain('要素分类「人物」（别名：奥伦、Grey）');
    }
    await expect(
      runtime.execute(request('read_object', { target: '人物「奥伦」' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/elements/人物/Grey Banker/body.md' },
      modelData: expect.stringContaining('要素「Grey Banker」（别名：奥伦、Grey）设定'),
    });
    const naturalSummaryWrite = await runtime.prepareWriteRequest(
      request(
        'write_object',
        {
          target: '奥伦',
          summary: 'A concise current profile.',
        },
        'write',
      ),
    );
    expect(naturalSummaryWrite).toMatchObject({
      arguments: {
        path: '/elements/人物/Grey Banker/summary.md',
        content: 'A concise current profile.',
        __workspaceCommand: {
          name: 'update_element',
          arguments: {
            element: element.id,
            summary: 'A concise current profile.',
          },
        },
      },
    });
    expect(naturalSummaryWrite.arguments).not.toHaveProperty('summary');
    await expect(
      runtime.execute(request('read_object', { target: '人物「Grey Banker」摘要' })),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        path: '/elements/人物/Grey Banker/summary.md',
        content: element.summary,
      },
    });
    const quotedBareSummaryWrite = await runtime.prepareWriteRequest(
      request(
        'write_object',
        {
          target: '「Grey Banker」摘要',
          summary: 'A summary through a tolerant authored label.',
        },
        'write',
      ),
    );
    expect(quotedBareSummaryWrite).toMatchObject({
      arguments: {
        path: '/elements/人物/Grey Banker/summary.md',
        content: 'A summary through a tolerant authored label.',
        __workspaceCommand: {
          name: 'update_element',
          arguments: {
            element: element.id,
            summary: 'A summary through a tolerant authored label.',
          },
        },
      },
    });
    await runtime.execute(
      request('read_object', { target: '人物「Grey Banker」摘要' }),
    );
    const summaryWrite = await runtime.prepareWriteRequest(
      request(
        'revise_object',
        {
          target: '人物「Grey Banker」摘要',
          changes: [
            {
              currentText: element.summary,
              revisedText: `${element.summary} He is done waiting.`,
            },
          ],
        },
        'write',
      ),
    );
    expect(summaryWrite).toMatchObject({
      arguments: {
        path: '/elements/人物/Grey Banker/summary.md',
        __workspaceCommand: {
          name: 'update_element',
          arguments: {
            element: element.id,
            summary: `${element.summary} He is done waiting.`,
          },
        },
      },
    });
    expect(workspaceAuthoredReadStateFromArguments(summaryWrite.arguments)).toEqual({
      targetKey: `element:${element.id}`,
      target: '要素「Grey Banker」设定',
      summary: `${element.summary} He is done waiting.`,
      completeBodyRead: false,
      focusedBodyEdit: false,
      currentPassages: [],
    });

    await runtime.execute(
      request('read_object', { target: '要素「Grey Banker」摘要' }),
    );
    const summaryOnlyWrite = await runtime.prepareWriteRequest(
      request(
        'write_object',
        {
          target: '要素「Grey Banker」摘要',
          summary: 'The current authored summary.',
        },
        'write',
      ),
    );
    expect(summaryOnlyWrite).toMatchObject({
      arguments: {
        path: '/elements/人物/Grey Banker/summary.md',
        content: 'The current authored summary.',
        __workspaceCommand: {
          name: 'update_element',
          arguments: {
            element: element.id,
            summary: 'The current authored summary.',
          },
        },
      },
    });
    expect(summaryOnlyWrite.arguments).not.toHaveProperty('summary');
    expect(summaryOnlyWrite.arguments).not.toHaveProperty('remainingWork');
    expect(workspaceAuthoredReadStateFromArguments(summaryOnlyWrite.arguments)).toEqual({
      targetKey: `element:${element.id}`,
      target: '要素「Grey Banker」设定',
      summary: 'The current authored summary.',
      completeBodyRead: false,
      focusedBodyEdit: false,
      currentPassages: [],
    });

    await runtime.execute(
      request('read_object', { target: '要素「Grey Banker」摘要' }),
    );
    const placeholderBodyWrite = await runtime.prepareWriteRequest(
      request(
        'write_object',
        {
          target: '要素「Grey Banker」摘要',
          body: '要素「Grey Banker」摘要',
          summary: 'The domain-specific summary wins.',
        },
        'write',
      ),
    );
    expect(workspaceCommandFromArguments(placeholderBodyWrite.arguments)).toMatchObject({
      name: 'update_element',
      arguments: { summary: 'The domain-specific summary wins.' },
    });
    expect(placeholderBodyWrite.arguments.content).toBe(
      'The domain-specific summary wins.',
    );

    const profileWrite = await runtime.prepareWriteRequest(
      request(
        'write_object',
        {
          target: '要素「Grey Banker」（别名：奥伦、Grey）',
          body: 'He counts every favor three times.',
          summary: 'A sharper current summary.',
        },
        'write',
      ),
    );
    expect(profileWrite).toMatchObject({
      arguments: {
        path: '/elements/人物/Grey Banker/body.md',
        content: 'He counts every favor three times.',
        remainingWork: expect.stringContaining(
          '要素「Grey Banker」摘要仍需单独更新为：A sharper current summary.',
        ),
        __workspaceCommand: {
          name: 'edit_prose_file',
          arguments: {
            entity: element.id,
            kind: 'element',
            content: 'He counts every favor three times.',
          },
        },
      },
    });
    expect(profileWrite.arguments).not.toHaveProperty('summary');
    expect(workspaceAuthoredReadStateFromArguments(profileWrite.arguments)).toEqual({
      targetKey: `element:${element.id}`,
      target: '要素「Grey Banker」设定',
      summary: element.summary,
      completeBodyRead: true,
      focusedBodyEdit: false,
      currentPassages: [],
    });

    // Existing authored objects accept the same bare canonical name on write
    // that read_object already accepts. A name-only target must never fall
    // through to the new-object parser and make the model restate a type.
    await runtime.execute(request('read_object', { target: 'Grey Banker' }));
    const bareNameWrite = await runtime.prepareWriteRequest(
      request(
        'write_object',
        {
          target: 'Grey Banker',
          body: 'He counts every favor four times.',
        },
        'write',
      ),
    );
    expect(bareNameWrite).toMatchObject({
      arguments: {
        path: '/elements/人物/Grey Banker/body.md',
        content: 'He counts every favor four times.',
        __workspaceCommand: {
          name: 'edit_prose_file',
          arguments: {
            entity: element.id,
            kind: 'element',
            content: 'He counts every favor four times.',
          },
        },
      },
    });
  });

  it('reports a missing ordinal as authored state instead of a virtual path failure', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    await expect(runtime.execute(request('read_file', { path: '第十三章' }))).resolves.toMatchObject({
      ok: true,
      data: {
        path: '/chapters/13/prose.md',
        missing: true,
        content: '',
      },
      modelData: expect.stringMatching(
        /第十三章尚未创建。如果当前任务包含它，可以直接按作者已有素材写出正文并同时建立摘要。/u,
      ),
    });
  });

  it('treats a missing named entity as absent instead of inviting spelling retries', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const result = await runtime.execute(
      request('read_object', { target: '人物「凯尔·维尔」设定' }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: { missing: true, content: '' },
      modelData: expect.stringContaining(
        '人物「凯尔·维尔」尚未建立。当前任务需要它时可以直接创建；无需继续尝试这个名称的其他写法。',
      ),
    });
    if (result.ok) expect(result.modelData).not.toMatch(/path|file|directory|json/iu);
  });

  it('resolves punctuation variants and aliases to one canonical entity', async () => {
    const category: BookElementCategory = {
      id: 'people-category',
      projectId: PROJECT_ID,
      name: '人物',
      contentJson: '{}',
      elementTemplateJson: '{}',
      elementTemplateKvJson: '[]',
      color: '#7386a8',
      layoutMode: 'auto',
      gridX: null,
      gridY: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const element: BookElement = {
      id: 'grey-banker',
      projectId: PROJECT_ID,
      categoryId: category.id,
      name: '奥伦维尔',
      summary: '背着旧债上路。',
      contentJson: '{}',
      kvJson: '[]',
      aliases: ['奥伦'],
      groupName: null,
      portraitAssetId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ bookElementCategories: [category], bookElements: [element] });
    const runtime = createRuntime(fakeReadRuntime('1\t他背着旧债上路。'));

    await expect(
      runtime.execute(request('read_object', { target: '人物「奥伦·维尔」' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/elements/人物/奥伦维尔/body.md' },
      modelData: expect.stringContaining('要素「奥伦维尔」（别名：奥伦）设定'),
    });
    const aliasRuntime = createRuntime(fakeReadRuntime('1\t他背着旧债上路。'));
    await expect(
      aliasRuntime.execute(request('read_object', { target: '人物「奥伦」' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/elements/人物/奥伦维尔/body.md' },
    });
    const bareAliasRuntime = createRuntime(fakeReadRuntime('1\t他背着旧债上路。'));
    await expect(
      bareAliasRuntime.execute(request('read_object', { target: '奥伦' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/elements/人物/奥伦维尔/body.md' },
      modelData: expect.stringContaining('要素「奥伦维尔」（别名：奥伦）设定'),
    });
  });

  it('returns relevant author outline evidence with a missing named chapter', async () => {
    const chapter = useDataStore.getState().bookNodes[0]!;
    if (chapter.kind !== 'chapter') throw new Error('Expected the chapter fixture');
    useDataStore.setState({
      bookNodes: [
        chapter,
        {
          ...chapter,
          id: 'drift-outline',
          kind: 'drift',
          title: '故事大纲_b01',
          bookOrder: null,
          narrativeOrder: 3,
          writingStatus: 'drifting',
        },
      ],
    });
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => ({
      ok: true as const,
      data: {
        result:
          input.name === 'read_node'
            ? '1\t第一章：婚礼。\n2\t第二章：奥伦凯尔驾车前往福地途中，在茶镇停留并带走一个女孩。\n3\t第三章：港口等待。'
            : input.name === 'search_prose'
            ? {
                matches: [
                  {
                    kind: 'drift',
                    title: '故事大纲_b01',
                    snippet: '第二章：奥伦凯尔驾车前往福地途中…',
                    block: 12,
                    score: 100,
                    matchedTerms: ['第二章'],
                  },
                ],
              }
            : { matches: [] },
        freshness: { receiptId: `${input.name}-receipt`, observations: [] },
      },
    }));
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    await expect(runtime.execute(request('read_file', { path: '第二章' }))).resolves.toMatchObject({
      ok: true,
      data: { path: '/chapters/2/prose.md', missing: true },
      modelData: expect.stringMatching(
        /第二章尚未创建。[\s\S]*已给出完整相关段落[\s\S]*灵感「故事大纲_b01」正文：第二章：奥伦凯尔驾车前往福地途中，在茶镇停留并带走一个女孩。/u,
      ),
    });
  });

  it('shows entity connections semantically without exposing editor link or hard-break syntax', async () => {
    const runtime = createRuntime(
      fakeReadRuntime('1\t他看见[泰勒](主要角色.md#泰勒)<br>停下。'),
    );

    const read = await runtime.execute(request('read_file', { path: '第一章 雨夜' }));

    if (!read.ok) throw new Error(read.error);
    expect(read).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('正文中的实体连接：泰勒'),
    });
    expect(read.modelData).toContain('他看见泰勒\n停下。');
    expect(read.modelData).not.toMatch(/<br>|主要角色\.md/iu);
    expect(read.data).toMatchObject({
      content: '他看见[泰勒](主要角色.md#泰勒)<br>停下。',
    });
  });

  it('returns parallel chapter reads as ordinary authored documents without scheduling markers', async () => {
    const first = useDataStore.getState().bookNodes[0]!;
    if (first.kind !== 'chapter') throw new Error('Expected chapter fixture');
    useDataStore.setState({
      bookNodes: [
        first,
        {
          ...first,
          id: 'workspace-node-2',
          title: '第二章 晨雾',
          summary: '她在晨雾中离开旧宅。',
          bookOrder: 2,
        },
      ],
    });
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);
    const firstRequest = {
      ...request('read_file', { path: '第一章 雨夜' }),
      iteration: 1,
      callId: 'read-first',
    };
    const secondRequest = {
      ...request('read_file', { path: '第二章 晨雾' }),
      iteration: 1,
      callId: 'read-second',
    };

    const [firstRead, secondRead] = await Promise.all([
      runtime.execute(firstRequest),
      runtime.execute(secondRequest),
    ]);

    expect(firstRead).toMatchObject({ ok: true, data: { content: expect.any(String) } });
    expect(secondRead).toMatchObject({
      ok: true,
      data: {
        path: '/chapters/第二章 晨雾/prose.md',
        content: expect.any(String),
      },
      modelData: expect.stringContaining('章节「第二章 晨雾」正文'),
    });
    if (secondRead.ok) {
      expect(secondRead.modelData).not.toMatch(
        /摘要与开头|摘要与结尾|当前活动正文|之后再单独读取|可直接修改/u,
      );
    }
    expect(readRuntime.execute).toHaveBeenCalledTimes(2);
  });

  it('keeps an empty element category visible as a writable directory', async () => {
    const category: BookElementCategory = {
      id: 'empty-category',
      projectId: PROJECT_ID,
      name: '空分类',
      contentJson: '{}',
      elementTemplateJson: '{}',
      elementTemplateKvJson: '[]',
      color: '#7386a8',
      layoutMode: 'auto',
      gridX: null,
      gridY: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ bookElementCategories: [category] });
    const runtime = createRuntime(fakeReadRuntime());

    const elements = await runtime.execute(request('list_files', { path: '/elements' }));
    expect(elements).toMatchObject({
      ok: true,
      data: {
        files: [
          expect.objectContaining({
            path: '/elements/空分类',
            name: '空分类',
            type: 'directory',
            writable: true,
            description: expect.stringContaining('空要素分类'),
          }),
        ],
      },
      modelData: expect.stringContaining('要素分类「空分类」'),
    });

    await expect(
      runtime.execute(request('browse_project', { collection: '要素分类「空分类」' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/elements/空分类', files: [], total: 0, truncated: false },
      modelData: expect.stringContaining('可在要素分类「空分类」中新建要素'),
    });
  });

  it('describes comment and relation creation in author language without serialization forms', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const comments = await runtime.execute(request('browse_project', { collection: '批注' }));
    expect(comments).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('可新建一条批注或待办，并说明内容及其对象'),
    });
    if (comments.ok) {
      expect(comments.modelData).not.toMatch(/\/comments|\.json|targetKind/iu);
    }

    const relations = await runtime.execute(request('browse_project', { collection: '实体关系' }));
    expect(relations).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('可用准确的实体名称和关系类型建立一条实体关系'),
    });
    if (relations.ok) {
      expect(relations.modelData).not.toMatch(/\/relations|\.json|fromKind/iu);
    }

    const elements = await runtime.execute(request('browse_project', { collection: '要素' }));
    expect(elements).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('新建要素时先选择或建立分类'),
    });
    if (elements.ok) {
      expect(elements.modelData).not.toMatch(/\/elements|\/drifts|body\.md/iu);
    }
  });

  it('summarizes and searches comments semantically instead of forcing numbered reads', async () => {
    const commentId = 'todo-grey-shure';
    const comment: Comment = {
      id: commentId,
      projectId: PROJECT_ID,
      kind: 'todo',
      targetKind: 'node',
      targetId: NODE_ID,
      targetBlockId: null,
      anchorJson: JSON.stringify({ selectedText: '奥伦没有回答凯尔。' }),
      authorKind: 'user',
      authorId: null,
      authorName: null,
      bodyJson: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '核对奥伦与凯尔是否已经和解' }],
          },
        ],
      }),
      status: 'open',
      priority: null,
      source: 'manual',
      metadataJson: null,
      targetBlockIdsJson: '[]',
      resolvedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ comments: [comment] });
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    const catalog = await runtime.execute(
      request('browse_project', { collection: '批注或待办' }),
    );
    expect(catalog).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('待办 · 未完成 · 第一章 雨夜 · 核对奥伦与凯尔是否已经和解'),
    });
    if (catalog.ok) {
      expect(catalog.modelData).toContain(`批注或待办「${commentId}」`);
      expect(catalog.modelData).toContain('引用片段：奥伦没有回答凯尔。');
      expect(catalog.modelData).not.toMatch(/\/comments|\.json|bodyJson|targetId/iu);
    }

    const found = await runtime.execute(
      request('search_work', { query: '奥伦', within: '批注或待办' }),
    );
    expect(found).toMatchObject({
      ok: true,
      data: { total: 1, matches: [{ path: `/comments/${commentId}.json` }] },
      modelData: expect.stringContaining('核对奥伦与凯尔是否已经和解'),
    });
    expect(readRuntime.execute).not.toHaveBeenCalled();
  });

  it('keeps large note catalogs bounded and directs semantic search across the full set', async () => {
    const comments: Comment[] = Array.from({ length: 30 }, (_, index) => ({
      id: `catalog-note-${String(index).padStart(2, '0')}`,
      projectId: PROJECT_ID,
      kind: 'todo',
      targetKind: 'node',
      targetId: NODE_ID,
      targetBlockId: null,
      anchorJson: '{}',
      authorKind: 'user',
      authorId: null,
      authorName: null,
      bodyJson: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: `核对人物关系 ${index}` }],
          },
        ],
      }),
      status: 'open',
      priority: null,
      source: 'manual',
      metadataJson: null,
      targetBlockIdsJson: '[]',
      resolvedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }));
    useDataStore.setState({ comments });
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    const result = await runtime.execute(
      request('browse_project', { collection: '批注或待办' }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: { files: expect.any(Array), total: 30, truncated: true },
      modelData: expect.stringContaining('可按人物、主题或明显的测试词搜索全部内容'),
    });
    if (result.ok) {
      const files =
        result.data && typeof result.data === 'object' && !Array.isArray(result.data)
          ? (result.data as Record<string, unknown>).files
          : [];
      expect(Array.isArray(files) ? files : []).toHaveLength(24);
      expect(result.modelData).not.toContain('catalog-note-24');
      expect(result.modelData).not.toContain('目录');
    }
    expect(readRuntime.execute).not.toHaveBeenCalled();
  });

  it('renders notes and relations as domain fields instead of serialized objects', async () => {
    const commentId = 'todo-domain-view';
    const relationId = 'relation-domain-view';
    const comment: Comment = {
      id: commentId,
      projectId: PROJECT_ID,
      kind: 'todo',
      targetKind: 'node',
      targetId: NODE_ID,
      targetBlockId: null,
      anchorJson: '{}',
      authorKind: 'ai',
      authorId: null,
      authorName: 'Agent',
      bodyJson: '{}',
      status: 'open',
      priority: null,
      source: 'api',
      metadataJson: null,
      targetBlockIdsJson: '[]',
      resolvedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const relation: EntityRelationLink = {
      id: relationId,
      projectId: PROJECT_ID,
      fromKind: 'node',
      fromId: NODE_ID,
      toKind: 'node',
      toId: NODE_ID,
      kind: '映照',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ comments: [comment], entityRelations: [relation] });
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
      if (input.name === 'list_comments') {
        return {
          ok: true as const,
          data: {
            result: {
              comments: [
                {
                  id: commentId,
                  kind: 'todo',
                  body: '核对第一章时间线',
                  status: 'open',
                  targetKind: 'node',
                  target: '第一章 雨夜',
                  createdAt: comment.createdAt,
                },
              ],
            },
            freshness: { receiptId: 'comments-receipt', observations: [] },
          },
        };
      }
      if (input.name === 'get_entity_relations') {
        return {
          ok: true as const,
          data: {
            result: { relations: [] },
            freshness: { receiptId: 'relations-receipt', observations: [] },
          },
        };
      }
      return { ok: false as const, error: `unexpected read ${input.name}` };
    });
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    const note = await runtime.execute(
      request('read_object', { target: `批注或待办「${commentId}」` }),
    );
    expect(note).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('类型：待办'),
    });
    if (note.ok) {
      expect(note.modelData).toContain('内容：核对第一章时间线');
      expect(note.modelData).toContain('对象：第一章 雨夜');
      expect(note.modelData).not.toMatch(/[{}]|\.json|projectId|createdAt/iu);
    }

    const linked = await runtime.execute(
      request('read_object', { target: `实体关系「${relationId}」` }),
    );
    expect(linked).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('起点：第一章 雨夜'),
    });
    if (linked.ok) {
      expect(linked.modelData).toContain('终点：第一章 雨夜');
      expect(linked.modelData).toContain('类型：映照');
      expect(linked.modelData).not.toMatch(/[{}]|fromKind|toKind|\.json/iu);
    }
  });

  it('revises the visible default relation label when the stored kind is empty', async () => {
    const relationId = 'relation-default-kind';
    const relation: EntityRelationLink = {
      id: relationId,
      projectId: PROJECT_ID,
      fromKind: 'node',
      fromId: NODE_ID,
      toKind: 'node',
      toId: NODE_ID,
      kind: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ entityRelations: [relation] });
    const execute = vi.fn(async (_input: AgentToolExecutionRequest) => ({
      ok: true as const,
      data: {
        result: {},
        freshness: {
          receiptId: 'relation-receipt',
          observations: [
            {
              id: 'relation-observation',
              entityKind: 'relation',
              entityId: relationId,
              revision: relation.updatedAt,
            },
          ],
        },
      },
    }));
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    const prepared = await runtime.prepareWriteRequest(
      request(
        'revise_object',
        {
          target: `实体关系「${relationId}」`,
          changes: [{ currentText: '关联', revisedText: '身份：能力者' }],
        },
        'write',
      ),
    );

    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'update_relation_kind',
      arguments: {
        relationId,
        kind: '身份：能力者',
        expectedRevision: {
          receiptId: 'relation-receipt',
          observationId: 'relation-observation',
          revision: relation.updatedAt,
        },
      },
    });
  });

  it('turns multiple passage revisions into one hidden atomic prose command', async () => {
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);
    const prepared = await runtime.prepareEditRequest(
      request(
        'revise_object',
        {
          target: '章节「第一章 雨夜」',
          changes: [
            { currentText: '雨落旧宅', revisedText: '暴雨压住旧宅' },
            { currentText: '她没有回头。', revisedText: '她停了一瞬，仍没有回头。' },
          ],
        },
        'write',
      ),
    );

    expect(prepared.arguments.expectedRevision).toEqual({
      receiptId: 'read-receipt',
      observationId: 'prose-observation',
      revision: 'yjs:7',
    });
    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'edit_prose_file',
      arguments: {
        entity: NODE_ID,
        kind: 'chapter',
        replacements: [
          { oldText: '雨落旧宅', newText: '暴雨压住旧宅', replaceAll: false },
          {
            oldText: '她没有回头。',
            newText: '她停了一瞬，仍没有回头。',
            replaceAll: false,
          },
        ],
        expectedRevision: {
          receiptId: 'read-receipt',
          observationId: 'prose-observation',
          revision: 'yjs:7',
        },
      },
    });
    expect(readRuntime.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the model-visible prose revision when another collaborator edits before prepare', async () => {
    let readIndex = 0;
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
      expect(input.name).toBe('read_node');
      const firstRead = readIndex === 0;
      readIndex += 1;
      return {
        ok: true as const,
        data: {
          result: firstRead
            ? 'chapter "第一章 雨夜" · draft\n\n1\tSLOT_A\n2\tSLOT_B'
            : 'chapter "第一章 雨夜" · draft\n\n1\tAGENT_A_DONE\n2\tSLOT_B',
          freshness: {
            receiptId: firstRead ? 'public-read-receipt' : 'prepare-read-receipt',
            observations: [
              {
                id: firstRead ? 'public-read-observation' : 'prepare-read-observation',
                entityKind: 'node_prose',
                entityId: NODE_ID,
                revision: firstRead ? 'yjs:7' : 'yjs:8',
              },
            ],
          },
        },
      };
    });
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    await expect(
      runtime.execute(request('read_object', { target: '章节「第一章 雨夜」' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { content: 'SLOT_A\n\nSLOT_B' },
    });

    const prepared = await runtime.prepareWriteRequest(
      request(
        'revise_object',
        {
          target: '章节「第一章 雨夜」',
          changes: [{ currentText: 'SLOT_B', revisedText: 'AGENT_B_DONE' }],
        },
        'write',
      ),
    );

    expect(prepared.arguments.expectedRevision).toEqual({
      receiptId: 'public-read-receipt',
      observationId: 'public-read-observation',
      revision: 'yjs:7',
    });
    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'edit_prose_file',
      arguments: {
        entity: NODE_ID,
        kind: 'chapter',
        replacements: [{ oldText: 'SLOT_B', newText: 'AGENT_B_DONE', replaceAll: false }],
        expectedRevision: {
          receiptId: 'public-read-receipt',
          observationId: 'public-read-observation',
          revision: 'yjs:7',
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('maps domain-native creation requests to every hidden authored-object command', async () => {
    const category: BookElementCategory = {
      id: 'category-people',
      projectId: PROJECT_ID,
      name: '人物',
      contentJson: '{}',
      elementTemplateJson: '{}',
      elementTemplateKvJson: '[]',
      color: '#888888',
      layoutMode: 'auto',
      gridX: null,
      gridY: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ bookElementCategories: [category] });
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
      const entityKind = input.name === 'list_memory' ? 'memory_set' : 'project';
      return {
        ok: true as const,
        data: {
          result: input.name === 'list_memory' ? { memories: [] } : {},
          freshness: {
            receiptId: `${entityKind}-receipt`,
            observations: [
              {
                id: `${entityKind}-observation`,
                entityKind,
                entityId: PROJECT_ID,
                revision: '2026-08-01T00:00:00.000Z',
              },
            ],
          },
        },
      };
    });
    const runtime = createRuntime({ listDefinitions: () => [], execute });
    const create = async (arguments_: Record<string, unknown>) =>
      workspaceCommandFromArguments(
        (
          await runtime.prepareWriteRequest(request('write_object', arguments_, 'write'))
        ).arguments,
      );

    await expect(
      create({ target: '灵感「雨夜片段」', body: '雨声切开旧城。', summary: '一段雨夜灵感。' }),
    ).resolves.toMatchObject({
      name: 'create_node',
      arguments: { kind: 'drift', title: '雨夜片段', body: '雨声切开旧城。' },
    });
    await expect(
      create({ target: '人物「林弦」', body: '林弦习惯在说谎前摸一下袖口。' }),
    ).resolves.toMatchObject({
      name: 'create_element',
      arguments: { category: '人物', name: '林弦' },
    });
    await expect(
      create({ target: '故事线「返乡」', body: '林弦沿旧铁路返乡。' }),
    ).resolves.toMatchObject({
      name: 'create_storyline',
      arguments: { name: '返乡' },
    });
    await expect(
      create({ target: '要素分类「遗物」', body: '承载人物过去的物件。' }),
    ).resolves.toMatchObject({
      name: 'create_category',
      arguments: { name: '遗物' },
    });
    await expect(
      create({
        target: '待办',
        body: '核对第一章时间线',
        attributes: [
          { name: '类型', value: '奥伦凯尔线的后续设定落实' },
          { name: '对象类型', value: '章节' },
          { name: '对象', value: '第一章 雨夜' },
        ],
      }),
    ).resolves.toMatchObject({
      name: 'create_comment',
      arguments: {
        kind: 'todo',
        body: '核对第一章时间线',
        targetKind: 'node',
        target: '第一章 雨夜',
      },
    });
    await expect(
      create({
        target: '实体关系',
        attributes: [
          { name: '起点类型', value: '人物' },
          { name: '起点', value: '林弦' },
          { name: '终点类型', value: '章节' },
          { name: '终点', value: '第一章 雨夜' },
          { name: '关系', value: '登场于' },
        ],
      }),
    ).resolves.toMatchObject({
      name: 'add_relation',
      arguments: {
        fromKind: 'element',
        from: '林弦',
        toKind: 'node',
        to: '第一章 雨夜',
        kind: '登场于',
      },
    });
    await expect(
      create({ target: '作者规则', body: '对话尽量克制，避免解释人物情绪。' }),
    ).resolves.toMatchObject({
      name: 'remember',
      arguments: { kind: 'directive', body: '对话尽量克制，避免解释人物情绪。' },
    });
    await expect(
      create({
        target: '项目事实',
        attributes: [{ name: '南园气候', value: '终年潮湿多雨' }],
      }),
    ).resolves.toMatchObject({
      name: 'update_project_facts',
      arguments: { facts: [{ key: '南园气候', value: '终年潮湿多雨' }] },
    });
  });

  it('maps a domain-native destructive request to the guarded hidden delete command', async () => {
    const runtime = createRuntime(fakeReadRuntime());
    const prepared = await runtime.prepareWriteRequest(
      request('delete_object', { target: '章节「第一章 雨夜」' }, 'write'),
    );
    expect(workspaceCommandFromArguments(prepared.arguments)).toMatchObject({
      name: 'delete_node',
      arguments: { node: NODE_ID },
    });
  });

  it('keeps exact current-revision edits when sibling rows are stale or already satisfied', async () => {
    const runtime = createRuntime(fakeReadRuntime());
    const prepared = await runtime.prepareEditRequest(
      request(
        'edit_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          replacements: [
            { oldText: '雨落旧宅', newText: '暴雨压住旧宅' },
            { oldText: '已被上一轮删除', newText: '不应重放' },
            { oldText: '她没有回头。', newText: '她没有回头。' },
          ],
        },
        'write',
      ),
    );

    expect(prepared.arguments).toMatchObject({
      path: '/chapters/第一章 雨夜/prose.md',
      replacements: [{ oldText: '雨落旧宅', newText: '暴雨压住旧宅' }],
      skippedStaleReplacements: 1,
    });
    const hidden = workspaceCommandFromArguments(prepared.arguments);
    expect(hidden).toMatchObject({
      name: 'edit_prose_file',
      arguments: {
        replacements: [
          { oldText: '雨落旧宅', newText: '暴雨压住旧宅', replaceAll: false },
        ],
      },
    });
    expect(hidden?.arguments).not.toHaveProperty('skippedStaleReplacements');
  });

  it('carries an authored change summary while keeping it out of the hidden command', async () => {
    const runtime = createRuntime(
      fakeReadRuntime('1\t# 【测试·章节】test residue\n2\t正文拖沓重复重复。'),
    );
    const prepared = await runtime.prepareEditRequest(
      request(
        'edit_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          replacements: [
            { oldText: '# 【测试·章节】test residue\n\n', newText: '' },
            { oldText: '正文拖沓重复重复。', newText: '正文收紧。' },
          ],
          changeSummary: '清理测试痕迹并收紧正文',
        },
        'write',
      ),
    );

    expect(prepared.arguments.changeSummary).toMatch(/将正文从 .*调整为/);
    expect(prepared.arguments.changeSummary).not.toBe('清理测试痕迹并收紧正文');
    expect(workspaceCommandFromArguments(prepared.arguments)?.arguments).not.toHaveProperty(
      'changeSummary',
    );
  });

  it('does not trust a completion summary when one requested prose target is stale', async () => {
    const runtime = createRuntime(
      fakeReadRuntime('1\t# 【测试·章节】test residue\n2\t正文拖沓重复重复。'),
    );
    const prepared = await runtime.prepareEditRequest(
      request(
        'edit_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          replacements: [
            { oldText: '# 已经过期的测试标题\n\n', newText: '' },
            { oldText: '正文拖沓重复重复。', newText: '正文收紧。' },
          ],
          changeSummary: '测试痕迹已经全部清理',
        },
        'write',
      ),
    );

    expect(prepared.arguments.changeSummary).not.toBe('测试痕迹已经全部清理');
    expect(prepared.arguments.remainingWork).toContain('只有它仍影响作者目标时');
    expect(prepared.arguments.remainingWork).not.toContain('已经过期的测试标题');
    expect(prepared.arguments.skippedStaleReplacements).toBe(1);
    expect(workspaceCommandFromArguments(prepared.arguments)?.arguments).not.toHaveProperty(
      'remainingWork',
    );
  });

  it('accepts a cross-paragraph replacement without exposing block handles', async () => {
    const runtime = createRuntime(fakeReadRuntime());
    const prepared = await runtime.prepareEditRequest(
      request(
        'edit_file',
        {
          path: '/chapters/第一章 雨夜',
          replacements: [
            {
              oldText: '# 雨落旧宅\n\n她没有回头。',
              newText: '# 暴雨旧宅\n\n她停在门前。\n\n门从里面开了。',
            },
          ],
        },
        'write',
      ),
    );

    expect(prepared.arguments.path).toBe('/chapters/第一章 雨夜/prose.md');
    expect(JSON.stringify(workspaceCommandFromArguments(prepared.arguments))).not.toContain(
      'block',
    );
  });

  it('prepares whole-file prose replacement directly, including blank files', async () => {
    const runtime = createRuntime(fakeReadRuntime('1\t'));
    const prepared = await runtime.prepareWriteRequest(
      request(
        'write_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          content: '# 新章\n\n第一段。',
        },
        'write',
      ),
    );

    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'edit_prose_file',
      arguments: {
        entity: NODE_ID,
        kind: 'chapter',
        content: '# 新章\n\n第一段。',
        expectedRevision: {
          receiptId: 'read-receipt',
          observationId: 'prose-observation',
          revision: 'yjs:7',
        },
      },
    });
  });

  it('keeps an existing chapter rewrite and its summary in one domain command', async () => {
    const runtime = createRuntime(fakeReadRuntime('1\t'));
    const prepared = await runtime.prepareWriteRequest(
      request(
        'write_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          content: '# 新章\n\n第一段。',
          summary: '雨夜重逢后，两人决定继续北上。',
        },
        'write',
      ),
    );

    expect(workspaceCommandFromArguments(prepared.arguments)).toMatchObject({
      name: 'edit_prose_file',
      arguments: {
        entity: NODE_ID,
        kind: 'chapter',
        content: '# 新章\n\n第一段。',
        summary: '雨夜重逢后，两人决定继续北上。',
      },
    });
  });

  it('returns a semantic no-op signal when an edit already matches the manuscript', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    let thrown: unknown;
    try {
      await runtime.prepareWriteRequest(
        request(
          'revise_object',
          {
            target: '章节「第一章 雨夜」',
            changes: [
              {
                currentText: '她没有回头。',
                revisedText: '她没有回头。',
              },
            ],
          },
          'write',
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkspaceNoopWriteSignal);
    expect((thrown as WorkspaceNoopWriteSignal).result).toMatchObject({
      ok: true,
      data: { noop: true },
      modelData: expect.stringContaining(WORKSPACE_NOOP_WRITE_MODEL_MARKER),
    });
    expect((thrown as WorkspaceNoopWriteSignal).result).not.toMatchObject({
      modelData: expect.stringMatching(/\/chapters|edit_file|replacement/iu),
    });
  });

  it('allows a summary-only chapter rewrite when the body is already current', async () => {
    const runtime = createRuntime(fakeReadRuntime());
    await runtime.execute(
      request('read_file', { path: '/chapters/第一章 雨夜/prose.md' }),
    );

    const prepared = await runtime.prepareWriteRequest(
      request(
        'write_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          content: '# 雨落旧宅\n\n她没有回头。',
          summary: '她在雨夜抵达旧宅，却拒绝回头。',
        },
        'write',
      ),
    );

    expect(workspaceCommandFromArguments(prepared.arguments)).toMatchObject({
      name: 'edit_prose_file',
      arguments: {
        entity: NODE_ID,
        content: '# 雨落旧宅\n\n她没有回头。',
        summary: '她在雨夜抵达旧宅，却拒绝回头。',
      },
    });
  });

  it('owns JSON transport escaping at the prose-write boundary', async () => {
    const runtime = createRuntime(fakeReadRuntime('1\t'));
    const prepared = await runtime.prepareWriteRequest(
      request(
        'write_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          content: String.raw`# 新章

\"第一百零一种。\"\他说，\“别回头。”`,
        },
        'write',
      ),
    );

    expect(prepared.arguments.content).toBe('# 新章\n\n"第一百零一种。"他说，“别回头。”');
    expect(workspaceCommandFromArguments(prepared.arguments)).toMatchObject({
      name: 'edit_prose_file',
      arguments: {
        content: '# 新章\n\n"第一百零一种。"他说，“别回头。”',
      },
    });
  });


  it('treats a semantic chapter directory as its prose target when creating', async () => {
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
      expect(input.name).toBe('get_project_brief');
      return {
        ok: true as const,
        data: {
          result: { projectId: PROJECT_ID },
          freshness: {
            receiptId: 'project-receipt',
            observations: [
              {
                id: 'project-observation',
                entityKind: 'project',
                entityId: PROJECT_ID,
                revision: '2026-08-01T00:00:00.000Z',
              },
            ],
          },
        },
      };
    });
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    const prepared = await runtime.prepareWriteRequest(
      request(
        'write_file',
        {
          path: '/chapters/13',
          content: '# 第十三章·雨夜\n\n雨忽然落了下来。',
        },
        'write',
      ),
    );

    expect(prepared.arguments.path).toBe('/chapters/13/prose.md');
    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'create_node',
      arguments: {
        kind: 'chapter',
        title: '13',
        body: '# 第十三章·雨夜\n\n雨忽然落了下来。',
        expectedRevision: {
          receiptId: 'project-receipt',
          observationId: 'project-observation',
          revision: '2026-08-01T00:00:00.000Z',
        },
      },
    });
  });

  it('creates a missing naturally named chapter with its summary in one domain write', async () => {
    const current = useDataStore.getState().bookNodes[0]!;
    if (current.kind !== 'chapter') throw new Error('Expected the chapter fixture');
    useDataStore.setState({
      bookNodes: [
        { ...current, title: '01', bookOrder: 1 },
        { ...current, id: 'chapter-03', title: '03', bookOrder: 3 },
      ],
    });
    const runtime = createRuntime({
      listDefinitions: () => [],
      execute: vi.fn(async () => ({
        ok: true as const,
        data: {
          result: { projectId: PROJECT_ID },
          freshness: {
            receiptId: 'project-receipt',
            observations: [
              {
                id: 'project-observation',
                entityKind: 'project',
                entityId: PROJECT_ID,
                revision: '2026-08-01T00:00:00.000Z',
              },
            ],
          },
        },
      })),
    });

    const prepared = await runtime.prepareWriteRequest(
      request(
        'write_file',
        {
          path: '第二章',
          content: '# 第二章·茶镇\n\n雾压在山路上。',
          summary: '奥伦与凯尔在茶镇遭遇异变。',
        },
        'write',
      ),
    );

    expect(prepared.arguments.path).toBe('/chapters/02/prose.md');
    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'create_node',
      arguments: {
        kind: 'chapter',
        title: '02',
        body: '# 第二章·茶镇\n\n雾压在山路上。',
        summary: '奥伦与凯尔在茶镇遭遇异变。',
        expectedRevision: {
          receiptId: 'project-receipt',
          observationId: 'project-observation',
          revision: '2026-08-01T00:00:00.000Z',
        },
      },
    });
  });

  it('rejects a whole-file replacement after only a partial read and allows it after all pages', async () => {
    const original = '原稿'.repeat(20_000);
    const runtime = createRuntime(fakeReadRuntime(`1\t${original}`));

    const firstPage = await runtime.execute(
      request('read_object', {
        target: '章节「第一章 雨夜」',
        cursor: 0,
        maxCharacters: 32_000,
      }),
    );
    expect(firstPage).toMatchObject({
      ok: true,
      data: { truncated: true, nextOffset: 32_000, totalChars: 40_000 },
      modelData: expect.stringContaining('[这份内容尚未读完；继续读取时使用 cursor 32000。]'),
    });

    await expect(
      runtime.prepareWriteRequest(
        request(
          'write_object',
          {
            target: '章节「第一章 雨夜」',
            body: original.slice(0, 20_000),
          },
          'write',
        ),
      ),
    ).rejects.toThrow(/INCOMPLETE_AUTHORED_OBJECT_READ/);

    const finalPage = await runtime.execute(
      request('read_object', {
        target: '章节「第一章 雨夜」',
        cursor: 32_000,
        maxCharacters: 32_000,
      }),
    );
    expect(finalPage).toMatchObject({
      ok: true,
      data: { truncated: false, nextOffset: 40_000, totalChars: 40_000 },
    });

    await expect(
      runtime.prepareWriteRequest(
        request(
          'write_object',
          {
            target: '章节「第一章 雨夜」',
            body: original.slice(0, -2),
          },
          'write',
        ),
      ),
    ).resolves.toMatchObject({
      arguments: {
        path: '/chapters/第一章 雨夜/prose.md',
        content: original.slice(0, -2),
      },
    });
  });

  it('resolves a natural chapter ordinal to a numeric chapter directory', async () => {
    const current = useDataStore.getState().bookNodes[0]!;
    if (current.kind !== 'chapter') throw new Error('Expected chapter fixture');
    useDataStore.setState({
      bookNodes: [{ ...current, title: '12', bookOrder: 12 }],
    });
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    const read = await runtime.execute(request('read_file', { path: '第十二章' }));

    expect(read).toMatchObject({
      ok: true,
      data: { path: '/chapters/12/prose.md' },
    });
    expect(readRuntime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'read_node',
        arguments: { node: NODE_ID, prose: true },
      }),
    );
  });

  it('never substitutes book order for a missing number in numeric-titled manuscripts', async () => {
    const current = useDataStore.getState().bookNodes[0]!;
    if (current.kind !== 'chapter') throw new Error('Expected chapter fixture');
    useDataStore.setState({
      bookNodes: [
        { ...current, title: '04', bookOrder: 16 },
        { ...current, id: 'chapter-13', title: '13', bookOrder: 90 },
      ],
    });
    const runtime = createRuntime(fakeReadRuntime());

    await expect(
      runtime.execute(request('read_file', { path: '第十三章' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/chapters/13/prose.md' },
    });
    await expect(
      runtime.execute(request('read_file', { path: '第十六章' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { missing: true },
      modelData: expect.stringContaining('第十六章尚未创建'),
    });
  });

  it('resolves an authored chapter field without requiring a virtual path', async () => {
    const current = useDataStore.getState().bookNodes[0]!;
    if (current.kind !== 'chapter') throw new Error('Expected chapter fixture');
    useDataStore.setState({
      bookNodes: [{ ...current, title: '8', summary: '旧摘要', bookOrder: 8 }],
    });
    const runtime = createRuntime(fakeReadRuntime());

    const read = await runtime.execute(request('read_file', { path: '第八章摘要' }));

    expect(read).toMatchObject({
      ok: true,
      data: {
        path: '/chapters/8/summary.md',
        content: '旧摘要',
      },
      modelData: '章节「8」摘要\n\n旧摘要',
    });

    await expect(
      runtime.execute(request('read_file', { path: '章节「8」摘要' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/chapters/8/summary.md', content: '旧摘要' },
    });
  });

  it('lets the summary bundled with a chapter read authorize a summary rewrite', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    await runtime.execute(request('read_file', { path: '第一章 雨夜' }));

    const prepared = await runtime.prepareWriteRequest(
      request(
        'write_file',
        {
          path: '章节「第一章 雨夜」摘要',
          content: '她冒雨抵达旧宅，决定不再回头。',
        },
        'write',
      ),
    );

    expect(prepared.arguments.path).toBe('/chapters/第一章 雨夜/summary.md');
    expect(workspaceCommandFromArguments(prepared.arguments)).toMatchObject({
      name: 'set_node_summary',
      arguments: { summary: '她冒雨抵达旧宅，决定不再回头。' },
    });
    expect(workspaceAuthoredReadStateFromArguments(prepared.arguments)).toEqual({
      targetKey: `node:${NODE_ID}`,
      target: '章节「第一章 雨夜」正文',
      summary: '她冒雨抵达旧宅，决定不再回头。',
      completeBodyRead: false,
      focusedBodyEdit: false,
      currentPassages: [],
    });
  });

  it('carries complete authored reading forward as domain state after a focused edit', async () => {
    const runtime = createRuntime(fakeReadRuntime());
    await runtime.execute(request('read_file', { path: '第一章 雨夜' }));

    const prepared = await runtime.prepareWriteRequest(
      request(
        'edit_file',
        {
          path: '第一章 雨夜',
          replacements: [
            { oldText: '她没有回头。', newText: '她始终没有回头。' },
          ],
        },
        'write',
      ),
    );

    expect(workspaceAuthoredReadStateFromArguments(prepared.arguments)).toEqual({
      targetKey: `node:${NODE_ID}`,
      target: '章节「第一章 雨夜」正文',
      summary: '她在雨夜抵达旧宅。',
      completeBodyRead: true,
      focusedBodyEdit: true,
      currentPassages: ['她始终没有回头。'],
    });
  });

  it('returns a fresh complete body when the model explicitly reads after a durable edit', async () => {
    const readRuntime = fakeReadRuntime();
    const runtime = new DriftingWorkspaceToolRuntime({
      readRuntime,
      getContext: () => ({ projectId: PROJECT_ID, write: {} }) as unknown as AgentToolContext,
    });

    const freshRead = await runtime.execute(
      request('read_file', { path: '第一章 雨夜' }),
    );
    expect(freshRead).toMatchObject({
      ok: true,
      data: { content: '# 雨落旧宅\n\n她没有回头。' },
    });
    expect(readRuntime.execute).toHaveBeenCalledTimes(1);
  });

  it('uses the dominant quoted passages to correct an accidentally misnamed read chapter', async () => {
    const first = useDataStore.getState().bookNodes[0]!;
    if (first.kind !== 'chapter') throw new Error('Expected chapter fixture');
    const second: BookNode = {
      ...first,
      id: 'workspace-node-two',
      title: '第二章 晨雾',
      summary: '她在晨雾中离开旧宅。',
      bookOrder: 2,
    };
    useDataStore.setState({ bookNodes: [first, second] });
    const proseByNode = new Map([
      [first.id, '1\t# 雨落旧宅\n2\t她没有回头。'],
      [second.id, '1\t# 晨雾\n2\t她把旧钥匙留在窗台。'],
    ]);
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
      if (input.name !== 'read_node') {
        return { ok: false as const, error: `unexpected read ${input.name}` };
      }
      const nodeId = String(input.arguments.node ?? '');
      const node = useDataStore.getState().bookNodes.find((candidate) => candidate.id === nodeId);
      if (!node) return { ok: false as const, error: `unknown node ${nodeId}` };
      return {
        ok: true as const,
        data: {
          result: `chapter "${node.title}" · draft\nsummary: ${node.summary}\n\n${proseByNode.get(nodeId)}`,
          freshness: {
            receiptId: `receipt-${nodeId}`,
            observations: [
              {
                id: `prose-${nodeId}`,
                entityKind: 'node_prose',
                entityId: nodeId,
                revision: `yjs:${nodeId}:1`,
              },
            ],
          },
        },
      };
    });
    const runtime = createRuntime({ listDefinitions: () => [], execute });
    await runtime.execute(request('read_file', { path: '第一章 雨夜' }));
    await runtime.execute(request('read_file', { path: '第二章 晨雾' }));

    const prepared = await runtime.prepareWriteRequest(
      request(
        'edit_file',
        {
          path: '第一章 雨夜',
          replacements: [
            {
              oldText: '她把旧钥匙留在窗台。',
              newText: '她把旧钥匙轻轻留在窗台。',
            },
            { oldText: '# 晨雾', newText: '# 薄雾' },
            { oldText: '另一章里尚未定位的一句。', newText: '待后续单独处理。' },
          ],
        },
        'write',
      ),
    );

    expect(prepared.arguments.path).toBe('/chapters/第二章 晨雾/prose.md');
    expect(prepared.arguments.skippedStaleReplacements).toBe(1);
    expect(workspaceCommandFromArguments(prepared.arguments)).toMatchObject({
      name: 'edit_prose_file',
      arguments: {
        entity: second.id,
        replacements: [
          {
            oldText: '她把旧钥匙留在窗台。',
            newText: '她把旧钥匙轻轻留在窗台。',
          },
          { oldText: '# 晨雾', newText: '# 薄雾' },
        ],
      },
    });
    expect(
      execute.mock.calls.map(([input]) => String(input.arguments.node ?? '')),
    ).toEqual([first.id, second.id, second.id]);
  });

  it('keeps an intentionally cleared summary on the unfinished continuity ledger', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const prepared = await runtime.prepareWriteRequest(
      request(
        'edit_file',
        {
          path: '/chapters/第一章 雨夜/summary.md',
          replacements: [{ oldText: '她在雨夜抵达旧宅。', newText: '' }],
        },
        'write',
      ),
    );

    expect(prepared.arguments).toMatchObject({
      changeSummary: '已清空摘要',
      remainingWork: '当前摘要为空，需要补写',
    });
    expect(workspaceCommandFromArguments(prepared.arguments)).toMatchObject({
      name: 'set_node_summary',
      arguments: { summary: '' },
    });
  });

  it('uses the category-qualified path to read one of several same-name elements', async () => {
    const categories: BookElementCategory[] = ['人物', '势力与组织'].map((name, index) => ({
      id: `category-${index}`,
      projectId: PROJECT_ID,
      name,
      contentJson: '{}',
      elementTemplateJson: '{}',
      elementTemplateKvJson: '[]',
      color: '#7386a8',
      layoutMode: 'auto',
      gridX: null,
      gridY: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }));
    const elements: BookElement[] = categories.map((category, index) => ({
      id: `same-name-${index}`,
      projectId: PROJECT_ID,
      categoryId: category.id,
      name: 'New Element',
      summary: '',
      contentJson: '{}',
      kvJson: '[]',
      aliases: [],
      groupName: null,
      portraitAssetId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }));
    useDataStore.setState({ bookElementCategories: categories, bookElements: elements });
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
      expect(input).toMatchObject({
        name: 'read_node',
        arguments: { node: elements[1]!.id, kind: 'element', prose: true },
      });
      return {
        ok: true as const,
        data: {
          result: 'element "New Element"\n\n1\t组织档案。',
          freshness: {
            receiptId: 'element-receipt',
            observations: [
              {
                id: 'element-observation',
                entityKind: 'element_prose',
                entityId: elements[1]!.id,
                revision: 'yjs:element:1',
              },
            ],
          },
        },
      };
    });
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    const path = '/elements/势力与组织/New Element/body.md';
    await expect(runtime.execute(request('read_file', { path }))).resolves.toMatchObject({
      ok: true,
      data: { content: '组织档案。' },
    });
    await expect(
      runtime.prepareWriteRequest(
        request('write_file', { path, content: '# 组织档案\n\n更新后的资料。' }, 'write'),
      ),
    ).resolves.toMatchObject({
      arguments: {
        path,
        content: '# 组织档案\n\n更新后的资料。',
        expectedRevision: {
          receiptId: 'element-receipt',
          observationId: 'element-observation',
          revision: 'yjs:element:1',
        },
      },
    });
    expect(
      execute.mock.calls.filter(([input]) => input.name === 'read_node'),
    ).toHaveLength(2);
  });

  it('does not turn an unavailable search scope into a false negative', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    await expect(
      runtime.execute(request('search_work', { query: '雨', within: '不存在的章节' })),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('requested authored object or collection is unavailable'),
    });
  });

  it('reports exact literal occurrence counts for one authored object', async () => {
    const runtime = createRuntime(fakeReadRuntime('1\t# 回归\n2\t旧标记与旧标记。\n3\t新标记。'));

    const found = await runtime.execute(
      request('search_work', { query: '旧标记', within: '章节「第一章 雨夜」' }),
    );
    expect(found).toMatchObject({
      ok: true,
      data: {
        path: '/chapters/第一章 雨夜/prose.md',
        total: 2,
        exact: true,
        matches: [{}, {}],
      },
      modelData: expect.stringContaining('精确出现次数：2'),
    });

    const missing = await runtime.execute(
      request('search_work', { query: '不存在', within: '章节「第一章 雨夜」' }),
    );
    expect(missing).toMatchObject({
      ok: true,
      data: { total: 0, exact: true, matches: [] },
      modelData: expect.stringContaining('精确出现次数：0'),
    });
  });

  it('maps broad metadata matches to their real file and drops fuzzy-only grep hits', async () => {
    const category: BookElementCategory = {
      id: 'people-category',
      projectId: PROJECT_ID,
      name: '人物',
      contentJson: '{}',
      elementTemplateJson: '{}',
      elementTemplateKvJson: '[]',
      color: '#7386a8',
      layoutMode: 'auto',
      gridX: null,
      gridY: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const element: BookElement = {
      id: 'person-liaomu',
      projectId: PROJECT_ID,
      categoryId: category.id,
      name: '辽姆',
      summary: '旧摘要【测试改写 2026-06-03】',
      contentJson: '{}',
      kvJson: '[]',
      aliases: [],
      groupName: null,
      portraitAssetId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ bookElementCategories: [category], bookElements: [element] });
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => ({
      ok: true as const,
      data: {
        result:
          input.name === 'search_project'
            ? {
                matches: [
                  {
                    kind: 'element',
                    label: '辽姆',
                    snippet: '旧摘要【测试改写 2026-06-03】',
                    matchedIn: 'summary',
                    score: 100,
                    matchedTerms: ['测试改写'],
                  },
                ],
              }
            : {
                matches: [
                  {
                    kind: 'element',
                    title: '辽姆',
                    snippet: '普通剧情里测试能力。',
                    block: 1,
                    score: 80,
                    matchedTerms: ['测试'],
                  },
                ],
              },
        freshness: { receiptId: `${input.name}-receipt`, observations: [] },
      },
    }));
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    await expect(
      runtime.execute(request('grep', { query: '【测试改写', path: '/elements' })),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        total: 1,
        matches: [{ path: '/elements/人物/辽姆/summary.md' }],
      },
      modelData: expect.not.stringContaining('/elements/人物/辽姆/body.md'),
    });
  });

  it('searches current entity relations instead of returning an empty prose search', async () => {
    const relation: EntityRelationLink = {
      id: 'relation-current',
      projectId: PROJECT_ID,
      fromKind: 'node',
      fromId: NODE_ID,
      toKind: 'node',
      toId: NODE_ID,
      kind: '自省',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ entityRelations: [relation] });
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    await expect(
      runtime.execute(request('search_work', { query: '自省', within: '实体关系' })),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        exact: true,
        total: 1,
        matches: [{ path: '/relations/relation-current.json' }],
      },
    });
    expect(readRuntime.execute).not.toHaveBeenCalled();
  });

  it('projects element aliases into relation browsing and exact relation search', async () => {
    const category: BookElementCategory = {
      id: 'people-category',
      projectId: PROJECT_ID,
      name: '人物',
      contentJson: '{}',
      elementTemplateJson: '{}',
      elementTemplateKvJson: '[]',
      color: '#7386a8',
      layoutMode: 'auto',
      gridX: null,
      gridY: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const elements: BookElement[] = [
      {
        id: 'grey-banker',
        projectId: PROJECT_ID,
        categoryId: category.id,
        name: 'Grey Banker',
        summary: '',
        contentJson: '{}',
        kvJson: '[]',
        aliases: ['奥伦', 'Grey'],
        groupName: null,
        portraitAssetId: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'shul-banker',
        projectId: PROJECT_ID,
        categoryId: category.id,
        name: 'Shul Banker',
        summary: '',
        contentJson: '{}',
        kvJson: '[]',
        aliases: ['凯尔', 'Shul'],
        groupName: null,
        portraitAssetId: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ];
    const relation: EntityRelationLink = {
      id: 'banker-allies',
      projectId: PROJECT_ID,
      fromKind: 'element',
      fromId: elements[0]!.id,
      toKind: 'element',
      toId: elements[1]!.id,
      kind: '旧日同盟',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({
      bookElementCategories: [category],
      bookElements: elements,
      entityRelations: [relation],
    });
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    const catalog = await runtime.execute(
      request('browse_project', { collection: '实体关系' }),
    );
    expect(catalog).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('Grey Banker（别名：奥伦、Grey）'),
    });
    if (catalog.ok) {
      expect(catalog.modelData).toContain('Shul Banker（别名：凯尔、Shul）');
      expect(catalog.modelData).not.toMatch(/\/relations|\.json|fromId|toId/iu);
    }

    await expect(
      runtime.execute(request('search_work', { query: '奥伦', within: '实体关系' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { total: 1, matches: [{ path: '/relations/banker-allies.json' }] },
      modelData: expect.stringContaining('Grey Banker（别名：奥伦、Grey）'),
    });
    expect(readRuntime.execute).not.toHaveBeenCalled();
  });

  it('uses an opaque annotative id when refreshing a comment-origin relation', async () => {
    const commentId = 'comment-origin';
    const relationId = 'relation-from-comment';
    const comment: Comment = {
      id: commentId,
      projectId: PROJECT_ID,
      kind: 'todo',
      targetKind: 'node',
      targetId: NODE_ID,
      targetBlockId: null,
      anchorJson: '{}',
      authorKind: 'ai',
      authorId: null,
      authorName: 'Agent',
      bodyJson: '{}',
      status: 'open',
      priority: null,
      source: 'api',
      metadataJson: null,
      targetBlockIdsJson: '[]',
      resolvedAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const relation: EntityRelationLink = {
      id: relationId,
      projectId: PROJECT_ID,
      fromKind: 'comment',
      fromId: commentId,
      toKind: 'node',
      toId: NODE_ID,
      kind: 'supports',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    useDataStore.setState({ comments: [comment], entityRelations: [relation] });
    const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
      expect(input).toMatchObject({
        name: 'get_entity_relations',
        arguments: { kind: 'comment', name: commentId },
      });
      return {
        ok: true as const,
        data: {
          result: {},
          freshness: {
            receiptId: 'relation-receipt',
            observations: [
              {
                id: 'relation-observation',
                entityKind: 'relation',
                entityId: relationId,
                revision: relation.updatedAt,
              },
            ],
          },
        },
      };
    });
    const runtime = createRuntime({ listDefinitions: () => [], execute });

    const prepared = await runtime.prepareWriteRequest(
      request(
        'write_object',
        {
          target: `实体关系「${relationId}」`,
          attributes: [{ name: 'kind', value: 'explains' }],
        },
        'write',
      ),
    );

    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'update_relation_kind',
      arguments: {
        relationId,
        kind: 'explains',
        expectedRevision: {
          receiptId: 'relation-receipt',
          observationId: 'relation-observation',
          revision: relation.updatedAt,
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function createRuntime(readRuntime: AgentToolRuntime) {
  return new DriftingWorkspaceToolRuntime({
    readRuntime,
    getContext: () => ({ projectId: PROJECT_ID, write: {} }) as unknown as AgentToolContext,
  });
}

function fakeReadRuntime(prose = '1\t# 雨落旧宅\n2\t她没有回头。'): AgentToolRuntime & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
    if (input.name !== 'read_node') {
      return { ok: false as const, error: `unexpected read ${input.name}` };
    }
    return {
      ok: true as const,
      data: {
        result: `chapter "第一章 雨夜" · draft · 18 words\nsummary: 她在雨夜抵达旧宅。\n\n${prose}`,
        freshness: {
          receiptId: 'read-receipt',
          observations: [
            {
              id: 'node-observation',
              entityKind: 'node',
              entityId: NODE_ID,
              revision: '2026-08-01T00:00:00.000Z',
            },
            {
              id: 'prose-observation',
              entityKind: 'node_prose',
              entityId: NODE_ID,
              revision: 'yjs:7',
            },
          ],
        },
      },
    };
  });
  return {
    listDefinitions: () => [],
    execute,
  };
}

function request(
  name: string,
  arguments_: Record<string, unknown>,
  access: 'read' | 'write' = 'read',
): AgentToolExecutionRequest {
  return {
    sessionId: 'workspace-session',
    turnId: 'workspace-turn',
    callId: `call-${name}`,
    idempotencyKey: `idempotency-${name}`,
    name,
    arguments: arguments_,
    access,
    context: runtimeContext,
    signal: new AbortController().signal,
  };
}
