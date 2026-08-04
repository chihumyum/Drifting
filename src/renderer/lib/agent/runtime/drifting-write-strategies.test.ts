import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import type {
  PersistedAgentRuntimeWriteExpectation,
} from '../../../domain/agent-runtime-freshness';
import type { PersistedAgentRuntimeWriteEffect } from '../../../domain/agent-runtime-write-effect';
import { useDataStore } from '../../../store/data-store';
import type {
  AgentToolContext,
  AgentWriteApi,
} from '../tool-handlers';
import { getDriftingWriteStrategy } from './drifting-write-strategies';
import {
  hashYjsProseState,
  prepareYjsProseCommand,
  replaceYjsProseBlocks,
  type PortablePreparedYjsProseCommand,
  type YjsProseBlock,
} from './yjs-prose-command';
import type {
  PreparePersistedYjsProseCommandInput,
  YjsProsePersistenceBase,
  YjsProseCommandReceipt,
  YjsProsePersistenceCoordinator,
} from './yjs-prose-persistence-coordinator';
import type { AgentToolExecutionRequest } from './types';
import { useAgentEditStore } from '../../../store/agent-edit-store';

const initialState = useDataStore.getState();

beforeEach(() => {
  useAgentEditStore.getState().clearAll();
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
  useAgentEditStore.getState().clearAll();
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

    const reviewContext = context();
    await expect(
      strategy!.applyInverse(effect, reviewContext, request.signal),
    ).resolves.toMatchObject({ value: 'Old title' });
    expect(reviewContext.write.renameNode).toHaveBeenCalledWith(
      'node-1',
      'Old title',
      { expectedRevision: '2026-01-02T00:00:00.000Z' },
    );
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

  it('reconciles an inverse that committed before review settlement', async () => {
    const strategy = getDriftingWriteStrategy('rename_node')!;
    const request = executionRequest('rename_node', {
      node: 'Old title',
      title: 'Agent title',
    });
    const prepared = await strategy.prepare(request, context());
    updateNodeField('node-1', 'title', 'Agent title');
    const committed = await strategy.captureEffect(
      request,
      context(),
      { ok: true },
      prepared,
    );
    // Simulate a crash after the inverse usecase committed but before the
    // canonical review advanced from revert_started to reverted.
    updateNodeField('node-1', 'title', 'Old title');
    const reviewContext = context();

    await expect(
      strategy.applyInverse(
        persistedEffect({
          inverse: prepared.inverse,
          effect: committed,
        }),
        reviewContext,
        request.signal,
      ),
    ).resolves.toMatchObject({
      value: 'Old title',
      reconciled: true,
    });
    expect(reviewContext.write.renameNode).not.toHaveBeenCalled();
    expect(node('node-1').title).toBe('Old title');
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

  it('maps all six certified prose tools to deterministic Yjs commands guarded by the read vector/hash', async () => {
    const cases: Array<{
      name: string;
      arguments: Record<string, unknown>;
      operation: string;
    }> = [
      {
        name: 'edit_block',
        arguments: { block: 1, text: 'Edited alpha' },
        operation: 'edit',
      },
      {
        name: 'edit_blocks',
        arguments: {
          edits: [
            { block: 1, text: 'Edited alpha' },
            { blockId: 'block-c', text: 'Edited gamma' },
          ],
        },
        operation: 'edit_many',
      },
      {
        name: 'append_paragraph',
        arguments: { text: 'Delta' },
        operation: 'append',
      },
      {
        name: 'insert_blocks',
        arguments: { afterBlock: 1, blocks: ['Between'] },
        operation: 'insert',
      },
      {
        name: 'remove_blocks',
        arguments: { blockNumbers: [2] },
        operation: 'remove',
      },
      {
        name: 'replace_block_range',
        arguments: {
          fromBlock: 1,
          toBlockId: 'block-b',
          blocks: ['Replacement'],
        },
        operation: 'replace',
      },
    ];

    for (const [index, item] of cases.entries()) {
      const harness = await proseHarness();
      const expectedRevision = {
        receiptId: `receipt-${index}`,
        observationId: `observation-${index}`,
        revision: `yjs:${harness.base.revision}`,
      };
      const request = executionRequest(item.name, {
        entity: 'Old title',
        ...item.arguments,
        expectedRevision,
      });
      const strategy = getDriftingWriteStrategy(item.name, {
        proseCoordinator:
          harness.coordinator as unknown as YjsProsePersistenceCoordinator,
        readNodeContent: async () => harness.contentJson,
      });
      expect(strategy).toBeDefined();
      const prepared = await strategy!.prepare(
        request,
        context(),
        proseExpectation(
          request,
          expectedRevision,
          harness.base,
        ),
      );
      const payload = prepared.forward as {
        kind: string;
        command: PortablePreparedYjsProseCommand;
        reviewSnapshot: {
          effectId: string;
          reviewId: string;
          baseStateHash: string;
        };
      };
      expect(payload.kind).toBe('yjs_prose');
      expect(payload.command.operation.kind).toBe(item.operation);
      expect(payload.reviewSnapshot).toMatchObject({
        effectId: `agent-write:${request.idempotencyKey}`,
        reviewId: `agent-review:agent-write:${request.idempotencyKey}`,
        baseStateHash: harness.base.stateHash,
      });
      expect(prepared.reversibility).toBe('exact');
      expect(prepared.inverse).toEqual(prepared.forward);
      expect(harness.preparedCommands).toBe(1);
      harness.doc.destroy();
    }
  });

  it('fails prose preparation before mutation when the cited Yjs hash is stale', async () => {
    const harness = await proseHarness();
    const expectedRevision = {
      receiptId: 'receipt-stale',
      observationId: 'observation-stale',
      revision: `yjs:${harness.base.revision}`,
    };
    const request = executionRequest('edit_block', {
      entity: 'Old title',
      block: 1,
      text: 'Must not land',
      expectedRevision,
    });
    const strategy = getDriftingWriteStrategy('edit_block', {
      proseCoordinator:
        harness.coordinator as unknown as YjsProsePersistenceCoordinator,
      readNodeContent: async () => harness.contentJson,
    })!;
    const expectation = proseExpectation(
      request,
      expectedRevision,
      harness.base,
    );
    expectation.expectedStateHash = `sha256:${'0'.repeat(64)}`;

    await expect(
      strategy.prepare(request, context(), expectation),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(harness.preparedCommands).toBe(0);
    harness.doc.destroy();
  });

  it('certifies a review baseline when y-prosemirror normalizes mark instance keys', async () => {
    const harness = await proseHarness({
      blocks: [
        {
          id: 'block-a',
          type: 'paragraph',
          attrs: { textAlign: 'left' },
          content: [
            {
              kind: 'text',
              text: 'Alpha',
              marks: {
                'entityLink--wTlwK8yH': {
                  targetKind: 'element',
                  targetId: 'element-1',
                  targetBlockId: null,
                },
              },
            },
          ],
        },
        paragraph('block-b', 'Beta'),
        paragraph('block-c', 'Gamma'),
      ],
    });
    const expectedRevision = {
      receiptId: 'receipt-mark-normalization',
      observationId: 'observation-mark-normalization',
      revision: `yjs:${harness.base.revision}`,
    };
    const request = executionRequest('edit_block', {
      entity: 'Old title',
      blockId: 'block-b',
      text: 'Beta revised',
      expectedRevision,
    });
    const strategy = getDriftingWriteStrategy('edit_block', {
      proseCoordinator:
        harness.coordinator as unknown as YjsProsePersistenceCoordinator,
      readNodeContent: async () => harness.contentJson,
    })!;
    const prepared = await strategy.prepare(
      request,
      context(),
      proseExpectation(request, expectedRevision, harness.base),
    );
    const result = await strategy.applyForward!(request, context(), prepared);

    await expect(
      strategy.captureEffect(request, context(), result, prepared),
    ).resolves.toMatchObject({
      kind: 'yjs_prose',
      nodeId: 'node-1',
    });
    harness.doc.destroy();
  });

  it('strips read_node display markers before replacing heading or quote text', async () => {
    const harness = await proseHarness({
      blocks: [
        {
          id: 'block-a',
          type: 'heading',
          attrs: { level: 1, textAlign: 'left' },
          content: [{ kind: 'text', text: '第一幕' }],
        },
        {
          id: 'block-b',
          type: 'blockquote',
          content: [
            {
              kind: 'element',
              type: 'paragraph',
              content: [{ kind: 'text', text: '引文' }],
            },
          ],
        },
      ],
    });
    const expectedRevision = {
      receiptId: 'receipt-heading-prefix',
      observationId: 'observation-heading-prefix',
      revision: `yjs:${harness.base.revision}`,
    };
    const request = executionRequest('edit_blocks', {
      entity: 'Old title',
      edits: [
        { blockId: 'block-a', text: '# 第一幕修订' },
        { blockId: 'block-b', text: '> 引文修订' },
      ],
      expectedRevision,
    });
    const strategy = getDriftingWriteStrategy('edit_blocks', {
      proseCoordinator:
        harness.coordinator as unknown as YjsProsePersistenceCoordinator,
      readNodeContent: async () => harness.contentJson,
    })!;
    const prepared = await strategy.prepare(
      request,
      context(),
      proseExpectation(request, expectedRevision, harness.base),
    );
    const operation = (prepared.forward as {
      command: PortablePreparedYjsProseCommand;
    }).command.operation;

    expect(operation).toMatchObject({
      kind: 'edit_many',
      edits: [
        {
          blockId: 'block-a',
          block: {
            type: 'heading',
            content: [{ kind: 'text', text: '第一幕修订' }],
          },
        },
        {
          blockId: 'block-b',
          block: {
            type: 'blockquote',
            content: [
              {
                kind: 'element',
                content: [{ kind: 'text', text: '引文修订' }],
              },
            ],
          },
        },
      ],
    });
    harness.doc.destroy();
  });

  it('commits a prose diff without post-write UI state and reconciles the exact durable receipt', async () => {
    const harness = await proseHarness();
    const expectedRevision = {
      receiptId: 'receipt-visible-review',
      observationId: 'observation-visible-review',
      revision: `yjs:${harness.base.revision}`,
    };
    const request = executionRequest('edit_block', {
      entity: 'Old title',
      blockId: 'block-a',
      text: 'Edited alpha',
      expectedRevision,
    });
    const strategy = getDriftingWriteStrategy('edit_block', {
      proseCoordinator:
        harness.coordinator as unknown as YjsProsePersistenceCoordinator,
      readNodeContent: async () => harness.contentJson,
    })!;
    const prepared = await strategy.prepare(
      request,
      context(),
      proseExpectation(request, expectedRevision, harness.base),
    );

    const handlerResult = await strategy.applyForward!(
      request,
      context(),
      prepared,
    );
    expect(useAgentEditStore.getState().pending).toEqual({});

    const committedEffect = await strategy.captureEffect(
      request,
      context(),
      handlerResult,
      prepared,
    );
    const effect: PersistedAgentRuntimeWriteEffect = {
      ...persistedEffect({
        inverse: prepared.inverse,
        effect: committedEffect,
      }),
      id: `agent-write:${request.idempotencyKey}`,
      toolName: 'edit_block',
      idempotencyKey: request.idempotencyKey,
      forward: prepared.forward,
    };
    await expect(
      strategy.reconcileEnteredEffect!(
        effect,
        context(),
        request.signal,
      ),
    ).resolves.toMatchObject({
      handlerResult: {
        nodeId: 'node-1',
        outcome: 'reconciled',
      },
      committedEffect: {
        kind: 'yjs_prose',
        nodeId: 'node-1',
        reconciled: true,
      },
    });
    expect(harness.committedCommands).toBe(1);
    expect(harness.receipts).toBe(1);
    harness.doc.destroy();
  });

  it('guards an open existing-file auto edit before live merge and atomically hands it to the durable review', async () => {
    const harness = await proseHarness({ runBeforeLiveMerge: true });
    const expectedRevision = {
      receiptId: 'receipt-pre-live-guard',
      observationId: 'observation-pre-live-guard',
      revision: `yjs:${harness.base.revision}`,
    };
    const request = executionRequest('edit_block', {
      entity: 'Old title',
      blockId: 'block-a',
      text: 'Guarded alpha',
      expectedRevision,
    });
    const strategy = getDriftingWriteStrategy('edit_block', {
      proseCoordinator:
        harness.coordinator as unknown as YjsProsePersistenceCoordinator,
      readNodeContent: async () => harness.contentJson,
    })!;
    const prepared = await strategy.prepare(
      request,
      context(),
      proseExpectation(request, expectedRevision, harness.base),
    );

    const handlerResult = await strategy.applyForward!(
      request,
      context(),
      prepared,
    );
    const [reviewId] = Object.keys(
      useAgentEditStore.getState().autoRevealGuards,
    );
    expect(reviewId).toBeDefined();
    expect(useAgentEditStore.getState().autoRevealGuards[reviewId!]).toMatchObject({
      entityType: 'node',
      id: 'node-1',
      blockIds: ['block-a'],
    });
    expect(useAgentEditStore.getState().pending['node:node-1']).toBeUndefined();

    const committedEffect = await strategy.captureEffect(
      request,
      context(),
      handlerResult,
      prepared,
    );
    const effect: PersistedAgentRuntimeWriteEffect = {
      ...persistedEffect({
        inverse: prepared.inverse,
        effect: committedEffect,
      }),
      id: `agent-write:${request.idempotencyKey}`,
      toolName: 'edit_block',
      idempotencyKey: request.idempotencyKey,
      forward: prepared.forward,
    };
    await strategy.projectReview!(effect, context());

    expect(useAgentEditStore.getState().autoRevealGuards[reviewId!]).toBeUndefined();
    expect(useAgentEditStore.getState().pending['node:node-1']?.changes).toEqual([
      expect.objectContaining({
        blockId: 'block-a',
        op: 'changed',
        mode: 'auto',
        reviewId,
      }),
    ]);
    harness.doc.destroy();
  });

  it('reconciles a crash after the Yjs commit without rebuilding removed review UI', async () => {
    const harness = await proseHarness({ crashAfterForwardCommit: true });
    const expectedRevision = {
      receiptId: 'receipt-crash-window',
      observationId: 'observation-crash-window',
      revision: `yjs:${harness.base.revision}`,
    };
    const request = executionRequest('edit_block', {
      entity: 'Old title',
      blockId: 'block-a',
      text: 'Crash-safe alpha',
      expectedRevision,
    });
    const strategy = getDriftingWriteStrategy('edit_block', {
      proseCoordinator:
        harness.coordinator as unknown as YjsProsePersistenceCoordinator,
      readNodeContent: async () => harness.contentJson,
    })!;
    const prepared = await strategy.prepare(
      request,
      context(),
      proseExpectation(request, expectedRevision, harness.base),
    );

    await expect(
      strategy.applyForward!(request, context(), prepared),
    ).rejects.toThrow('crash after durable Yjs commit');
    expect(useAgentEditStore.getState().pending['node:node-1']).toBeUndefined();
    expect(harness.committedCommands).toBe(1);
    expect(harness.receipts).toBe(1);

    const effect: PersistedAgentRuntimeWriteEffect = {
      ...persistedEffect({
        inverse: prepared.inverse,
        effect: null,
      }),
      id: `agent-write:${request.idempotencyKey}`,
      phase: 'uncertain',
      toolName: 'edit_block',
      idempotencyKey: request.idempotencyKey,
      forward: prepared.forward,
    };
    const tamperedForward = JSON.parse(
      JSON.stringify(prepared.forward),
    ) as {
      reviewSnapshot: { baseContentJson: string };
    };
    tamperedForward.reviewSnapshot.baseContentJson = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'block-a' },
          content: [{ type: 'text', text: 'Forged base' }],
        },
      ],
    });
    await expect(
      strategy.reconcileEnteredEffect!(
        { ...effect, forward: tamperedForward },
        context(),
        request.signal,
      ),
    ).rejects.toThrow('review snapshot');
    expect(useAgentEditStore.getState().pending['node:node-1']).toBeUndefined();

    const first = await strategy.reconcileEnteredEffect!(
      effect,
      context(),
      request.signal,
    );
    const second = await strategy.reconcileEnteredEffect!(
      effect,
      context(),
      request.signal,
    );

    expect(second).toEqual(first);
    expect(useAgentEditStore.getState().reviewOrder).toEqual([]);
    expect(useAgentEditStore.getState().reviewBatches).toEqual({});
    expect(useAgentEditStore.getState().pending).toEqual({});
    expect(harness.committedCommands).toBe(1);
    expect(harness.receipts).toBe(1);
    harness.doc.destroy();
  });

  it('keeps the removed review store empty when two effects touch one block and replay', async () => {
    const firstHarness = await proseHarness({
      firstText: 'A',
      revision: 7,
    });
    const firstExpected = {
      receiptId: 'receipt-effect-1',
      observationId: 'observation-effect-1',
      revision: `yjs:${firstHarness.base.revision}`,
    };
    const firstRequest: AgentToolExecutionRequest = {
      ...executionRequest('edit_block', {
        entity: 'Old title',
        blockId: 'block-a',
        text: 'B',
        expectedRevision: firstExpected,
      }),
      callId: 'effect-1',
      idempotencyKey: 'session-1:turn-1:effect-1',
    };
    const firstStrategy = getDriftingWriteStrategy('edit_block', {
      proseCoordinator:
        firstHarness.coordinator as unknown as YjsProsePersistenceCoordinator,
      readNodeContent: async () => firstHarness.contentJson,
    })!;
    const firstPrepared = await firstStrategy.prepare(
      firstRequest,
      context(),
      proseExpectation(firstRequest, firstExpected, firstHarness.base),
    );
    await firstStrategy.applyForward!(
      firstRequest,
      context(),
      firstPrepared,
    );

    const secondHarness = await proseHarness({
      firstText: 'B',
      revision: 8,
    });
    const secondExpected = {
      receiptId: 'receipt-effect-2',
      observationId: 'observation-effect-2',
      revision: `yjs:${secondHarness.base.revision}`,
    };
    const secondRequest: AgentToolExecutionRequest = {
      ...executionRequest('edit_block', {
        entity: 'Old title',
        blockId: 'block-a',
        text: 'C',
        expectedRevision: secondExpected,
      }),
      callId: 'effect-2',
      idempotencyKey: 'session-1:turn-1:effect-2',
    };
    const secondStrategy = getDriftingWriteStrategy('edit_block', {
      proseCoordinator:
        secondHarness.coordinator as unknown as YjsProsePersistenceCoordinator,
      readNodeContent: async () => secondHarness.contentJson,
    })!;
    const secondPrepared = await secondStrategy.prepare(
      secondRequest,
      context(),
      proseExpectation(secondRequest, secondExpected, secondHarness.base),
    );
    await secondStrategy.applyForward!(
      secondRequest,
      context(),
      secondPrepared,
    );

    const firstEffectId = `agent-write:${firstRequest.idempotencyKey}`;
    expect(useAgentEditStore.getState().reviewOrder).toEqual([]);
    expect(useAgentEditStore.getState().reviewBatches).toEqual({});
    expect(useAgentEditStore.getState().pending).toEqual({});

    const beforeReplay = useAgentEditStore.getState();
    const firstEffect: PersistedAgentRuntimeWriteEffect = {
      ...persistedEffect({
        inverse: firstPrepared.inverse,
        effect: null,
      }),
      id: firstEffectId,
      phase: 'uncertain',
      toolName: 'edit_block',
      idempotencyKey: firstRequest.idempotencyKey,
      forward: firstPrepared.forward,
    };
    await expect(
      firstStrategy.reconcileEnteredEffect!(
        firstEffect,
        context(),
        firstRequest.signal,
      ),
    ).resolves.toMatchObject({
      committedEffect: { reconciled: true },
    });

    expect(useAgentEditStore.getState().reviewOrder).toEqual([]);
    expect(useAgentEditStore.getState().pending).toEqual(beforeReplay.pending);
    expect(firstHarness.committedCommands).toBe(1);
    expect(secondHarness.committedCommands).toBe(1);
    firstHarness.doc.destroy();
    secondHarness.doc.destroy();
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
    control: unavailableControl(),
    signal: new AbortController().signal,
  };
}

function unavailableControl(): AgentToolExecutionRequest['control'] {
  return {
    requestUserInput: async () => {
      throw new Error('User input is unavailable in this write-strategy test');
    },
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
    authorization: {
      kind: 'automatic',
      requestId: null,
      argumentsHash: 'sha256:test-arguments',
      authorizedAt: '2026-01-01T00:00:00.000Z',
    },
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

function paragraph(id: string, text: string): YjsProseBlock {
  return {
    id,
    type: 'paragraph',
    content: [{ kind: 'text', text }],
  };
}

async function proseHarness(
  options: {
    crashAfterForwardCommit?: boolean;
    runBeforeLiveMerge?: boolean;
    firstText?: string;
    revision?: number;
    blocks?: readonly YjsProseBlock[];
  } = {},
): Promise<{
  doc: Y.Doc;
  base: YjsProsePersistenceBase;
  contentJson: string;
  coordinator: Pick<YjsProsePersistenceCoordinator, 'readBase' | 'prepare'>;
  readonly preparedCommands: number;
  readonly committedCommands: number;
  readonly receipts: number;
}> {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 0x5015;
  const firstText = options.firstText ?? 'Alpha';
  replaceYjsProseBlocks(
    doc,
    options.blocks ?? [
      paragraph('block-a', firstText),
      paragraph('block-b', 'Beta'),
      paragraph('block-c', 'Gamma'),
    ],
  );
  const stateUpdate = Y.encodeStateAsUpdate(doc);
  const base: YjsProsePersistenceBase = {
    docId: 'node-content:node-1',
    sourceKind: 'closed',
    revision: options.revision ?? 7,
    stateVector: Y.encodeStateVector(doc),
    stateHash: await hashYjsProseState(doc),
    stateUpdate,
  };
  const contentJson = JSON.stringify(
    yDocToProsemirrorJSON(doc, 'default'),
  );
  let preparedCommands = 0;
  let committedCommands = 0;
  const receipts = new Map<string, YjsProseCommandReceipt>();
  const coordinator = {
    async readBase() {
      return {
        ...base,
        stateVector: new Uint8Array(base.stateVector),
        stateUpdate: new Uint8Array(base.stateUpdate),
      };
    },
    async prepare(input: PreparePersistedYjsProseCommandInput) {
      preparedCommands += 1;
      const prepared = await prepareYjsProseCommand({
        commandId: input.commandId,
        source: {
          kind: 'closed',
          stateUpdate: base.stateUpdate,
          revision: base.revision,
        },
        expectedBase: {
          revision: input.expectedBase.revision,
          stateVector: input.expectedBase.stateVector,
        },
        operation: input.operation,
      });
      return { base, prepared };
    },
    async commit(
      input: Parameters<YjsProsePersistenceCoordinator['commit']>[0],
    ) {
      committedCommands += 1;
      const prepared = input.command.prepared;
      const watermark = prepared.durableWatermark;
      const isForward = input.direction === 'forward';
      const receipt: YjsProseCommandReceipt = {
        id: `receipt:${prepared.commandId}:${input.direction}`,
        commandId: prepared.commandId,
        direction: input.direction,
        docId: input.command.base.docId,
        sourceKind: watermark.sourceKind,
        baseRevision: watermark.baseRevision,
        committedRevision: input.expectedRevision + 1,
        baseStateVector: new Uint8Array(
          isForward
            ? watermark.baseStateVector
            : watermark.forwardStateVector,
        ),
        baseStateHash: isForward
          ? watermark.baseStateHash
          : watermark.forwardStateHash,
        resultStateVector: new Uint8Array(
          isForward
            ? watermark.forwardStateVector
            : watermark.inverseStateVector,
        ),
        resultStateHash: isForward
          ? watermark.forwardStateHash
          : watermark.baseStateHash,
        updateHash: isForward
          ? watermark.forwardUpdateHash
          : watermark.inverseUpdateHash,
        updateId: committedCommands,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      receipts.set(`${prepared.commandId}:${input.direction}`, receipt);
      if (options.crashAfterForwardCommit && isForward) {
        throw new Error('crash after durable Yjs commit');
      }
      if (options.runBeforeLiveMerge && isForward) {
        input.beforeLiveMerge?.();
      }
      return {
        outcome: 'committed' as const,
        receipt,
        projection: prepared.projection,
        liveMerged: false,
      };
    },
    async getReceipt(commandId: string, direction: 'forward' | 'inverse') {
      return receipts.get(`${commandId}:${direction}`) ?? null;
    },
  };
  return {
    doc,
    base,
    contentJson,
    coordinator,
    get preparedCommands() {
      return preparedCommands;
    },
    get committedCommands() {
      return committedCommands;
    },
    get receipts() {
      return receipts.size;
    },
  };
}

function proseExpectation(
  request: AgentToolExecutionRequest,
  expectedRevision: {
    receiptId: string;
    observationId: string;
    revision: string;
  },
  base: YjsProsePersistenceBase,
): PersistedAgentRuntimeWriteExpectation {
  return {
    id: `expectation-${request.callId}`,
    effectId: `effect-${request.callId}`,
    projectId: 'project-1',
    sessionId: request.sessionId,
    writeTurnId: request.turnId,
    writeToolCallId: `agent-tool:${request.callId}`,
    observationId: expectedRevision.observationId,
    readReceiptId: expectedRevision.receiptId,
    readTurnId: 'read-turn',
    readToolCallId: 'read-tool-call',
    entityKind: 'node_prose',
    entityId: 'node-1',
    expectedRevision: expectedRevision.revision,
    expectedStateVector: new Uint8Array(base.stateVector),
    expectedStateHash: base.stateHash,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}
