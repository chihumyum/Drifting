import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedAgentRuntimeWriteEffect } from '../../../domain/agent-runtime-write-effect';
import { useDataStore } from '../../../store/data-store';
import type {
  AgentToolContext,
  AgentWriteApi,
} from '../tool-handlers';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
import type { AgentToolExecutionRequest } from './types';

const initialState = useDataStore.getState();

beforeEach(() => {
  useDataStore.setState({
    ...initialState,
    bookNodes: [
      {
        id: 'node-1',
        projectId: 'project-1',
        kind: 'chapter',
        title: 'Old title',
        summary: 'Old summary',
        narrativeOrder: null,
        driftGroupId: null,
        position: { x: 0, y: 0 },
        wordCount: 0,
        bookOrder: 1,
        writingStatus: 'draft',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'foreign-node',
        projectId: 'project-2',
        kind: 'drift',
        title: 'Foreign',
        summary: '',
        narrativeOrder: null,
        driftGroupId: null,
        position: { x: 0, y: 0 },
        wordCount: 0,
        bookOrder: null,
        writingStatus: 'drifting',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
});

afterEach(() => {
  useDataStore.setState(initialState, true);
});

describe('Drifting write strategies', () => {
  it('captures and exactly reverts a node title through the renderer usecase', async () => {
    const strategy = getDriftingWriteStrategy('rename_node');
    expect(strategy).toBeDefined();
    const request = executionRequest('rename_node', {
      node: 'Old title',
      title: 'New title',
    });
    const prepared = await strategy!.prepare(request, context());
    expect(prepared).toMatchObject({
      reversibility: 'exact',
      preimage: { nodeId: 'node-1', field: 'title', value: 'Old title' },
      forward: { nodeId: 'node-1', field: 'title', value: 'New title' },
    });

    updateNodeField('node-1', 'title', 'New title');
    const committed = await strategy!.captureEffect(
      request,
      context(),
      { ok: true },
      prepared,
    );
    const effect = persistedEffect({
      inverse: prepared.inverse,
      effect: committed,
    });

    await expect(
      strategy!.applyInverse(effect, context(), request.signal),
    ).resolves.toMatchObject({ value: 'Old title' });
    expect(node('node-1').title).toBe('Old title');
  });

  it('refuses an exact inverse after a newer manual field edit', async () => {
    const strategy = getDriftingWriteStrategy('set_node_summary')!;
    const request = executionRequest('set_node_summary', {
      node: 'Old title',
      summary: 'Agent summary',
    });
    const prepared = await strategy.prepare(request, context());
    updateNodeField('node-1', 'summary', 'Agent summary');
    const committed = await strategy.captureEffect(
      request,
      context(),
      { ok: true },
      prepared,
    );
    updateNodeField('node-1', 'summary', 'Newer author summary');

    await expect(
      strategy.applyInverse(
        persistedEffect({
          inverse: prepared.inverse,
          effect: committed,
        }),
        context(),
        request.signal,
      ),
    ).rejects.toThrow('exact revert is unavailable');
    expect(node('node-1').summary).toBe('Newer author summary');
  });

  it('rejects foreign-project node references before mutation preparation', async () => {
    const strategy = getDriftingWriteStrategy('rename_node')!;
    await expect(
      strategy.prepare(
        executionRequest('rename_node', {
          node: 'foreign-node',
          title: 'Leaked',
        }),
        context(),
      ),
    ).rejects.toThrow('No node');
  });
});

function executionRequest(
  name: string,
  arguments_: Record<string, unknown>,
): AgentToolExecutionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: 'call-1',
    idempotencyKey: 'session-1:turn-1:call-1',
    name,
    arguments: arguments_,
    access: 'write',
    context: {
      route: {
        kind: 'chat',
        projectId: 'project-1',
        conversationId: 'conversation-1',
      },
    },
    signal: new AbortController().signal,
  };
}

function context(): AgentToolContext {
  const write = {
    renameNode: vi.fn(async (id: string, title: string) => {
      updateNodeField(id, 'title', title);
    }),
    updateNode: vi.fn(
      async (id: string, updates: { summary?: string }) => {
        if (updates.summary !== undefined) {
          updateNodeField(id, 'summary', updates.summary);
        }
      },
    ),
  } as unknown as AgentWriteApi;
  return { projectId: 'project-1', write };
}

function updateNodeField(
  id: string,
  field: 'title' | 'summary',
  value: string,
): void {
  useDataStore.setState((state) => ({
    bookNodes: state.bookNodes.map((candidate) =>
      candidate.id === id
        ? {
            ...candidate,
            [field]: value,
            updatedAt: '2026-01-02T00:00:00.000Z',
          }
        : candidate,
    ),
  }));
}

function node(id: string) {
  const found = useDataStore.getState().bookNodes.find((item) => item.id === id);
  if (!found) throw new Error('missing fixture node');
  return found;
}

function persistedEffect(
  values: Pick<PersistedAgentRuntimeWriteEffect, 'inverse' | 'effect'>,
): PersistedAgentRuntimeWriteEffect {
  return {
    id: 'effect-1',
    projectId: 'project-1',
    routeKind: 'chat',
    conversationId: 'conversation-1',
    goalRunId: null,
    chapterId: null,
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'agent-tool:session-1:turn-1:call-1',
    callId: 'call-1',
    toolName: 'rename_node',
    idempotencyKey: 'session-1:turn-1:call-1',
    phase: 'result_committed',
    arguments: {},
    expectedRevision: null,
    observedRevision: {},
    preimage: {},
    forward: {},
    inverse: values.inverse,
    reversibility: 'exact',
    effect: values.effect,
    result: {},
    errorCode: null,
    errorMessage: null,
    claimedAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
    mutationStartedAt: '2026-01-01T00:00:00.000Z',
    effectCommittedAt: '2026-01-01T00:00:00.000Z',
    resultCommittedAt: '2026-01-01T00:00:00.000Z',
    uncertainAt: null,
    failedAt: null,
    declinedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
