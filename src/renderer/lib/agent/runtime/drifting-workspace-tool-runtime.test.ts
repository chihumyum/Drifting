import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookNode } from '../../../domain/book-node';
import { useDataStore } from '../../../store/data-store';
import type { AgentToolContext } from '../tool-handlers';
import {
  DriftingWorkspaceToolRuntime,
  workspaceAuthoredReadStateFromArguments,
  workspaceCommandFromArguments,
} from './drifting-workspace-tool-runtime';
import {
  DRIFTING_DOMAIN_READ_TOOLS,
  DRIFTING_DOMAIN_WRITE_TOOLS,
} from './drifting-workspace-tool-contract';
import type {
  AgentRuntimeContext,
  AgentToolExecutionRequest,
  AgentToolRuntime,
} from './types';

const PROJECT_ID = 'domain-tool-project';
const NODE_ID = 'chapter-rain';
const runtimeContext: AgentRuntimeContext = {
  route: {
    kind: 'chat',
    projectId: PROJECT_ID,
    conversationId: 'domain-tool-conversation',
  },
};

const originalNodes = useDataStore.getState().bookNodes;

beforeEach(() => {
  const chapter: BookNode = {
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
  useDataStore.setState({ bookNodes: [chapter] });
});

afterEach(() => {
  useDataStore.setState({ bookNodes: originalNodes });
});

describe('DriftingWorkspaceToolRuntime domain surface', () => {
  it('publishes all domain reads and no generic object tools', () => {
    const runtime = createRuntime(fakeReadRuntime());
    expect(runtime.listDefinitions(runtimeContext).map((tool) => tool.name)).toEqual(
      DRIFTING_DOMAIN_READ_TOOLS,
    );
    expect(DRIFTING_DOMAIN_WRITE_TOOLS).toHaveLength(43);

    const names = runtime.listDefinitions(runtimeContext).map((tool) => tool.name);
    expect(names).not.toContain('browse_project');
    expect(names).not.toContain('read_object');
    expect(names).not.toContain('search_work');
  });

  it('rejects retired generic calls instead of translating them', async () => {
    const runtime = createRuntime(fakeReadRuntime());
    await expect(
      runtime.execute(request('read_object', { target: '章节「第一章 雨夜」' })),
    ).resolves.toEqual({
      ok: false,
      error: 'Unknown domain read tool "read_object"',
    });
  });

  it('reads a chapter by plain chapter name and hides transport vocabulary from model data', async () => {
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    const result = await runtime.execute(
      request('read_chapter', { chapter: '第一章 雨夜' }),
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        content: '# 雨落旧宅\n\n她没有回头。',
        truncated: false,
      },
      modelData: expect.stringContaining('章节「第一章 雨夜」正文'),
    });
    if (result.ok) {
      expect(result.modelData).not.toMatch(/\/chapters|prose\.md|receipt|revision|Yjs/iu);
    }
    expect(readRuntime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'read_node',
        arguments: { node: NODE_ID, prose: true },
      }),
    );
  });

  it('maps create_chapter to the certified node command with runtime-owned freshness', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const prepared = await runtime.prepareWriteRequest(
      request(
        'create_chapter',
        { title: '第二章 清晨', body: '天亮了。', summary: '旧宅迎来清晨。' },
        'write',
      ),
    );

    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'create_node',
      arguments: {
        kind: 'chapter',
        title: '第二章 清晨',
        body: '天亮了。',
        summary: '旧宅迎来清晨。',
        expectedRevision: projectRevision(),
      },
    });
    expect(prepared.arguments).not.toHaveProperty('target');
    expect(prepared.arguments).not.toHaveProperty('attributes');
  });

  it('prepares chapter title and summary updates without a complete prose read', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const summary = await runtime.prepareWriteRequest(
      request(
        'set_chapter_summary',
        {
          chapter: '第一章 雨夜',
          summary: '雨夜来客发现了旧宅的秘密。',
        },
        'write',
      ),
    );
    expect(workspaceCommandFromArguments(summary.arguments)).toEqual({
      name: 'set_node_summary',
      arguments: {
        node: NODE_ID,
        summary: '雨夜来客发现了旧宅的秘密。',
        expectedRevision: {
          receiptId: 'read-receipt',
          observationId: 'node-observation',
          revision: '2026-08-01T00:00:00.000Z',
        },
      },
    });

    const renamed = await runtime.prepareWriteRequest(
      request(
        'rename_chapter',
        { chapter: '第一章 雨夜', title: '第一章 归宅' },
        'write',
      ),
    );
    expect(workspaceCommandFromArguments(renamed.arguments)).toEqual({
      name: 'rename_node',
      arguments: {
        node: NODE_ID,
        title: '第一章 归宅',
        expectedRevision: {
          receiptId: 'read-receipt',
          observationId: 'node-observation',
          revision: '2026-08-01T00:00:00.000Z',
        },
      },
    });
  });

  it('maps a focused chapter revision from currentText/revisedText without public revisions', async () => {
    const runtime = createRuntime(fakeReadRuntime());
    await runtime.execute(request('read_chapter', { chapter: '第一章 雨夜' }));

    const prepared = await runtime.prepareWriteRequest(
      request(
        'revise_chapter',
        {
          chapter: '第一章 雨夜',
          changes: [{ currentText: '她没有回头。', revisedText: '她终于回了头。' }],
        },
        'write',
      ),
    );

    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'edit_prose_file',
      arguments: {
        entity: NODE_ID,
        kind: 'chapter',
        replacements: [
          { oldText: '她没有回头。', newText: '她终于回了头。', replaceAll: false },
        ],
        expectedRevision: proseRevision(),
      },
    });
    expect(workspaceAuthoredReadStateFromArguments(prepared.arguments)).toMatchObject({
      target: '章节「第一章 雨夜」正文',
      completeBodyRead: true,
      focusedBodyEdit: true,
    });
  });

  it('maps explicit relation endpoints and never asks the model for generic attributes', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const prepared = await runtime.prepareWriteRequest(
      request(
        'create_relation',
        {
          fromType: 'chapter',
          fromName: '第一章 雨夜',
          toType: 'chapter',
          toName: '第一章 雨夜',
          relationType: '自省',
        },
        'write',
      ),
    );

    expect(workspaceCommandFromArguments(prepared.arguments)).toEqual({
      name: 'add_relation',
      arguments: {
        fromKind: 'node',
        from: '第一章 雨夜',
        toKind: 'node',
        to: '第一章 雨夜',
        kind: '自省',
        expectedRevision: projectRevision(),
      },
    });
  });

  it('maps a comment target type to the hidden canonical kind', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const prepared = await runtime.prepareWriteRequest(
      request(
        'create_comment',
        {
          body: '核对这一处伏笔。',
          kind: 'todo',
          targetType: 'chapter',
          targetName: '第一章 雨夜',
        },
        'write',
      ),
    );

    expect(prepared.arguments).toMatchObject({
      body: '核对这一处伏笔。',
      kind: 'todo',
      targetKind: 'node',
      target: '第一章 雨夜',
      expectedRevision: projectRevision(),
    });
    expect(prepared.arguments).not.toHaveProperty('targetType');
    expect(prepared.arguments).not.toHaveProperty('targetName');
  });

  it('resolves unique live prose text to a stable block comment anchor', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    const prepared = await runtime.prepareWriteRequest(
      request(
        'create_comment',
        {
          body: '核对她的决定是否有足够铺垫。',
          kind: 'note',
          targetType: 'chapter',
          targetName: '第一章 雨夜',
          targetText: '她没有回头。',
        },
        'write',
      ),
    );

    expect(prepared.arguments).toMatchObject({
      targetKind: 'node',
      target: '第一章 雨夜',
      targetBlockId: 'block-2',
      expectedRevision: projectRevision(),
    });
    const anchor = JSON.parse(String(prepared.arguments.anchorJson)) as Record<string, unknown>;
    expect(anchor).toMatchObject({
      selectedText: '她没有回头。',
      blockText: '她没有回头。',
      blockSelectionFrom: 0,
      blockSelectionTo: 6,
      blockSnapshots: [{ blockId: 'block-2', blockText: '她没有回头。' }],
      textAnchor: {
        startBlockId: 'block-2',
        startOffset: 0,
        endBlockId: 'block-2',
        endOffset: 6,
        text: '她没有回头。',
      },
    });
  });

  it('fails closed when comment target text is absent from live prose', async () => {
    const runtime = createRuntime(fakeReadRuntime());

    await expect(
      runtime.prepareWriteRequest(
        request(
          'create_comment',
          {
            body: '不能成为悬空批注。',
            targetType: 'chapter',
            targetName: '第一章 雨夜',
            targetText: '正文里不存在的句子。',
          },
          'write',
        ),
      ),
    ).rejects.toThrow('targetText was not found in the current live prose');
  });

  it('maps comment filters from domain names instead of exposing internal kinds', async () => {
    const readRuntime = fakeReadRuntime();
    const runtime = createRuntime(readRuntime);

    await expect(
      runtime.execute(
        request('list_comments', {
          targetType: 'chapter',
          targetName: '第一章 雨夜',
          status: 'open',
          onlyTodos: true,
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(readRuntime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'list_comments',
        arguments: {
          kind: 'node',
          entity: '第一章 雨夜',
          status: 'open',
          onlyTodos: true,
        },
      }),
    );
  });
});

function createRuntime(readRuntime: AgentToolRuntime) {
  return new DriftingWorkspaceToolRuntime({
    readRuntime,
    getContext: () => ({ projectId: PROJECT_ID, write: {} }) as unknown as AgentToolContext,
  });
}

function fakeReadRuntime(): AgentToolRuntime & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async (input: AgentToolExecutionRequest) => {
    if (input.name === 'read_node') {
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
    }
    if (input.name === 'get_project_brief') {
      return {
        ok: true as const,
        data: {
          result: { name: '雨夜', facts: [] },
          freshness: {
            receiptId: 'project-receipt',
            observations: [
              {
                id: 'project-observation',
                entityKind: 'project',
                entityId: PROJECT_ID,
                revision: 'project:7',
              },
            ],
          },
        },
      };
    }
    if (input.name === 'lookup_block') {
      return {
        ok: true as const,
        data: {
          result: {
            node: NODE_ID,
            matches: [
              { blockId: 'block-2', block: 2, type: 'paragraph', snippet: '她没有回头。' },
            ],
          },
          freshness: { receiptId: 'lookup-receipt', observations: [] },
        },
      };
    }
    if (input.name === 'read_block') {
      return {
        ok: true as const,
        data: {
          result: {
            node: NODE_ID,
            blockId: 'block-2',
            found: true,
            block: 2,
            type: 'paragraph',
            text: '她没有回头。',
          },
          freshness: { receiptId: 'block-receipt', observations: [] },
        },
      };
    }
    if (input.name === 'list_comments') {
      return {
        ok: true as const,
        data: {
          result: { comments: [] },
          freshness: { receiptId: 'comments-receipt', observations: [] },
        },
      };
    }
    return { ok: false as const, error: `unexpected read ${input.name}` };
  });
  return { listDefinitions: () => [], execute };
}

function projectRevision() {
  return {
    receiptId: 'project-receipt',
    observationId: 'project-observation',
    revision: 'project:7',
  };
}

function proseRevision() {
  return {
    receiptId: 'read-receipt',
    observationId: 'prose-observation',
    revision: 'yjs:7',
  };
}

function request(
  name: string,
  arguments_: Record<string, unknown>,
  access: 'read' | 'write' = 'read',
): AgentToolExecutionRequest {
  return {
    sessionId: 'domain-tool-session',
    turnId: 'domain-tool-turn',
    callId: `call-${name}`,
    idempotencyKey: `idempotency-${name}`,
    name,
    arguments: arguments_,
    access,
    context: runtimeContext,
    signal: new AbortController().signal,
  };
}
