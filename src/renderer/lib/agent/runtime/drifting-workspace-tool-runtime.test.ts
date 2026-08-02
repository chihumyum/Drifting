import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookElementCategory } from '../../../domain/book-element';
import type { BookNode } from '../../../domain/book-node';
import type { Comment } from '../../../domain/comment';
import { useDataStore } from '../../../store/data-store';
import type { EntityRelationLink } from '../../../store/data-store';
import type { AgentToolContext } from '../tool-handlers';
import {
  DriftingWorkspaceToolRuntime,
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
      modelData: expect.stringContaining('Directory /'),
    });
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
      expect(listed.modelData).toContain('/chapters/<title>/prose.md');
      expect(listed.modelData).toContain('title.txt and meta.json are generated automatically');
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
        wordCount: 18,
        truncated: false,
      },
    });
    expect(JSON.stringify(read)).not.toContain('receipt');
    expect(JSON.stringify(read)).not.toContain(NODE_ID);
    expect(read).toMatchObject({
      ok: true,
      modelData:
        '/chapters/第一章 雨夜/prose.md\nWord count: 18\n\n# 雨落旧宅\n\n她没有回头。',
    });
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
      modelData: expect.stringContaining('/elements/空分类/'),
    });

    await expect(
      runtime.execute(request('list_files', { path: '/elements/空分类' })),
    ).resolves.toMatchObject({
      ok: true,
      data: { path: '/elements/空分类', files: [], total: 0, truncated: false },
      modelData: expect.stringContaining('/elements/<category>/<name>/body.md'),
    });
  });

  it('publishes exact comment and relation creation forms without schema archaeology', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const comments = await runtime.execute(request('list_files', { path: '/comments' }));
    expect(comments).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('/comments/<descriptive-name>.json'),
    });
    if (comments.ok) {
      expect(comments.modelData).toContain('"kind":"todo"');
      expect(comments.modelData).toContain('"targetKind":"node"');
    }

    const relations = await runtime.execute(request('list_files', { path: '/relations' }));
    expect(relations).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('/relations/<descriptive-name>.json'),
    });
    if (relations.ok) {
      expect(relations.modelData).toContain('"fromKind":"element"');
      expect(relations.modelData).toContain('"kind":"隶属"');
      expect(relations.modelData).toContain('separate A-to-C and B-to-C files');
      expect(relations.modelData).toContain('Wait until every referenced resource creation has succeeded');
    }

    const elements = await runtime.execute(request('list_files', { path: '/elements' }));
    expect(elements).toMatchObject({
      ok: true,
      modelData: expect.stringContaining('reuse the closest existing category'),
    });
    if (elements.ok) {
      expect(elements.modelData).toContain('灵感 or 漂移 belong under /drifts');
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
        entity: '第一章 雨夜',
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
        entity: '第一章 雨夜',
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
        arguments: { node: '12', prose: true },
      }),
    );
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
    const runtime = createRuntime(
      fakeReadRuntime('1\t# 回归\n2\t旧标记与旧标记。\n3\t新标记。'),
    );

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

function fakeReadRuntime(
  prose = '1\t# 雨落旧宅\n2\t她没有回头。',
): AgentToolRuntime & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
    if (input.name !== 'read_node') {
      return { ok: false as const, error: `unexpected read ${input.name}` };
    }
    return {
      ok: true as const,
      data: {
        result:
          `chapter "第一章 雨夜" · draft · 18 words\nsummary: 她在雨夜抵达旧宅。\n\n${prose}`,
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
