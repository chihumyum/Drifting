import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookElement, BookElementCategory } from '../../../domain/book-element';
import type { BookNode } from '../../../domain/book-node';
import type { Comment } from '../../../domain/comment';
import { useDataStore } from '../../../store/data-store';
import type { EntityRelationLink } from '../../../store/data-store';
import type { AgentToolContext } from '../tool-handlers';
import type { AgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
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
  it('projects canonical entities as natural virtual files and renders prose without handles', async () => {
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    const root = await runtime.execute(request('list_files', {}));
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
      modelData: expect.stringContaining('作品内容目录'),
    });
    if (root.ok) expect(root.modelData).not.toMatch(/\/chapters|Directory|Creation guide/iu);
    if (root.ok) expect(root.modelData).not.toContain('Element category canon');

    const listed = await runtime.execute(request('list_files', { path: '/chapters' }));
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

    const chapter = await runtime.execute(request('list_files', { path: '第一章 雨夜' }));
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
    const runtime = createRuntime(fakeReadRuntime());

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
            description: expect.stringContaining('/elements/空分类/<element-name>/body.md'),
          }),
        ],
      },
      modelData: expect.stringContaining('要素分类「空分类」'),
    });

    await expect(
      runtime.execute(request('list_files', { path: '/elements/空分类' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/elements/空分类', files: [], total: 0, truncated: false },
      modelData: expect.stringContaining('可在要素分类「空分类」中新建要素'),
    });
  });

  it('describes comment and relation creation in author language without serialization forms', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const comments = await runtime.execute(request('list_files', { path: '/comments' }));
    expect(comments).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('可新建一条批注或待办，并说明内容及其对象'),
    });
    if (comments.ok) {
      expect(comments.modelData).not.toMatch(/\/comments|\.json|targetKind/iu);
    }

    const relations = await runtime.execute(request('list_files', { path: '/relations' }));
    expect(relations).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('可用准确的实体名称和关系类型建立一条实体关系'),
    });
    if (relations.ok) {
      expect(relations.modelData).not.toMatch(/\/relations|\.json|fromKind/iu);
    }

    const elements = await runtime.execute(request('list_files', { path: '/elements' }));
    expect(elements).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('新建要素时先选择或建立分类'),
    });
    if (elements.ok) {
      expect(elements.modelData).not.toMatch(/\/elements|\/drifts|body\.md/iu);
    }
  });

  it('turns multiple same-file replacements into one hidden atomic file-edit command', async () => {
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);
    const prepared = await runtime.prepareEditRequest(
      request(
        'edit_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          replacements: [
            { oldText: '雨落旧宅', newText: '暴雨压住旧宅' },
            { oldText: '她没有回头。', newText: '她停了一瞬，仍没有回头。' },
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
      runtime.execute(
        request('read_file', { path: '/chapters/第一章 雨夜/prose.md' }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { content: 'SLOT_A\n\nSLOT_B' },
    });

    const prepared = await runtime.prepareEditRequest(
      request(
        'edit_file',
        {
          path: '/chapters/第一章 雨夜/prose.md',
          replacements: [{ oldText: 'SLOT_B', newText: 'AGENT_B_DONE' }],
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
          'edit_file',
          {
            path: '第一章 雨夜',
            replacements: [
              {
                oldText: '她没有回头。',
                newText: '她没有回头。',
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
      request('read_file', {
        path: '/chapters/第一章 雨夜/prose.md',
        offset: 0,
        limit: 32_000,
      }),
    );
    expect(firstPage).toMatchObject({
      ok: true,
      data: { truncated: true, nextOffset: 32_000, totalChars: 40_000 },
      modelData: expect.stringContaining('[这份内容尚未读完；从第 32000 个字符继续。]'),
    });

    await expect(
      runtime.prepareWriteRequest(
        request(
          'write_file',
          {
            path: '/chapters/第一章 雨夜/prose.md',
            content: original.slice(0, 20_000),
          },
          'write',
        ),
      ),
    ).rejects.toThrow(/INCOMPLETE_WHOLE_FILE_READ/);

    const finalPage = await runtime.execute(
      request('read_file', {
        path: '/chapters/第一章 雨夜/prose.md',
        offset: 32_000,
        limit: 32_000,
      }),
    );
    expect(finalPage).toMatchObject({
      ok: true,
      data: { truncated: false, nextOffset: 40_000, totalChars: 40_000 },
    });

    await expect(
      runtime.prepareWriteRequest(
        request(
          'write_file',
          {
            path: '/chapters/第一章 雨夜/prose.md',
            content: original.slice(0, -2),
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

  it('defers one redundant whole-body read to the durable current working copy', async () => {
    const readRuntime = fakeReadRuntime();
    const writeEffects = {
      loadSnapshot: vi.fn(async () => ({
        effects: [
          {
            id: 'effect-current-working-copy',
            turnId: 'workspace-turn',
            phase: 'result_committed',
            arguments: {
              __workspaceAuthoredReadState: {
                targetKey: `node:${NODE_ID}`,
                target: '章节「第一章 雨夜」正文',
                summary: '她冒雨抵达旧宅。',
                completeBodyRead: true,
                focusedBodyEdit: true,
                currentPassages: ['她始终没有回头。'],
              },
            },
          },
        ],
        reviews: [],
      })),
    } as unknown as AgentRuntimeWriteEffectRepository;
    const runtime = new DriftingWorkspaceToolRuntime({
      readRuntime,
      writeEffects,
      getContext: () => ({ projectId: PROJECT_ID, write: {} }) as unknown as AgentToolContext,
    });

    const deferred = await runtime.execute(request('read_file', { path: '第一章 雨夜' }));

    expect(deferred).toMatchObject({
      ok: true,
      data: {
        currentWorkingCopy: true,
        summary: '她冒雨抵达旧宅。',
        currentPassages: ['她始终没有回头。'],
      },
      modelData: expect.stringContaining('这次无需再次载入'),
    });
    expect(readRuntime.execute).not.toHaveBeenCalled();

    const explicitSecondRead = await runtime.execute(
      request('read_file', { path: '第一章 雨夜' }),
    );
    expect(explicitSecondRead).toMatchObject({
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
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not turn an invalid grep path into a false negative', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    await expect(
      runtime.execute(request('grep', { query: '雨', path: '/missing-chapter' })),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('No virtual file or directory'),
    });
  });

  it('reports exact literal occurrence counts for one file or entity directory', async () => {
    const runtime = createRuntime(fakeReadRuntime('1\t# 回归\n2\t旧标记与旧标记。\n3\t新标记。'));

    const found = await runtime.execute(
      request('grep', { query: '旧标记', path: '/chapters/第一章 雨夜' }),
    );
    expect(found).toMatchObject({
      ok: true,
      data: {
        path: '/chapters/第一章 雨夜/prose.md',
        total: 2,
        exact: true,
        matches: [{}, {}],
      },
      modelData: expect.stringContaining('Exact literal occurrences: 2'),
    });

    const missing = await runtime.execute(
      request('grep', { query: '不存在', path: '/chapters/第一章 雨夜/prose.md' }),
    );
    expect(missing).toMatchObject({
      ok: true,
      data: { total: 0, exact: true, matches: [] },
      modelData: expect.stringContaining('Exact literal occurrences: 0'),
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

  it('searches current relation JSON literally instead of returning an empty prose search', async () => {
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
      runtime.execute(request('grep', { query: '自省', path: '/relations' })),
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
        'write_file',
        {
          path: `/relations/${relationId}.json`,
          content: JSON.stringify({ kind: 'explains' }),
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
