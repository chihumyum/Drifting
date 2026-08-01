import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookNode } from '../../../domain/book-node';
import { useDataStore } from '../../../store/data-store';
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
  useDataStore.setState({ bookNodes: [node] });
});

afterEach(() => {
  useDataStore.setState({ bookNodes: originalNodes });
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
    if (listed.ok) expect(listed.modelData).not.toContain('她在雨夜抵达旧宅。');

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
        truncated: false,
      },
    });
    expect(JSON.stringify(read)).not.toContain('receipt');
    expect(JSON.stringify(read)).not.toContain(NODE_ID);
    expect(read).toMatchObject({
      ok: true,
      modelData: '/chapters/第一章 雨夜/prose.md\n\n# 雨落旧宅\n\n她没有回头。',
    });
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
});

function createRuntime(readRuntime: AgentToolRuntime) {
  return new DriftingWorkspaceToolRuntime({
    readRuntime,
    getContext: () => ({ projectId: PROJECT_ID, write: {} }) as unknown as AgentToolContext,
  });
}

function fakeReadRuntime(): AgentToolRuntime & {
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
          'chapter "第一章 雨夜" · draft · 18 words\nsummary: 她在雨夜抵达旧宅。\n\n1\t# 雨落旧宅\n2\t她没有回头。',
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
