import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeWriteEffectTransition,
  AgentRuntimeWriteReviewTransition,
  AgentRuntimeWriteReviewBlockTransition,
  ClaimAgentRuntimeWriteEffect,
  CreateAgentRuntimeWriteReview,
  PersistedAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteReview,
  PersistedAgentRuntimeWriteReviewBlock,
} from '../../../domain/agent-runtime-write-effect';
import type { AgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import { useDataStore } from '../../../store/data-store';
import type { AgentToolContext, AgentWriteApi } from '../tool-handlers';
import type { DriftingWriteStrategy } from './drifting-write-strategies';
import { hashAgentPermissionArguments } from './control-plane';
import { DriftingWriteToolRuntime } from './drifting-write-tool-runtime';
import { WorkspaceNoopWriteSignal } from './drifting-workspace-tool-runtime';
import type { AgentToolExecutionRequest, AgentToolRuntime } from './types';

const initialDataState = useDataStore.getState();

beforeEach(() => {
  useAgentEditStore.getState().clearAll();
  useDataStore.setState({
    ...initialDataState,
    bookNodes: [
      {
        id: 'node-1',
        projectId: 'project-1',
        kind: 'chapter',
        title: 'Chapter One',
        summary: 'Before',
        narrativeOrder: null,
        driftGroupId: null,
        position: { x: 0, y: 0 },
        wordCount: 0,
        bookOrder: 1,
        writingStatus: 'draft',
        createdAt: iso(0),
        updatedAt: iso(0),
      },
    ],
  });
});

afterEach(() => {
  useAgentEditStore.getState().clearAll();
  useDataStore.setState(initialDataState, true);
});

describe('DriftingWriteToolRuntime', () => {
  it('persists one authorized effect and replays duplicates without mutation or post-write review', async () => {
    const repository = memoryRepository();
    const renameNode = vi.fn(async (id: string, title: string) => {
      updateNode(id, { title });
    });
    const runtime = createRuntime(repository, { renameNode });

    expect(
      runtime
        .listDefinitions(request('rename_node', {}).context)
        .map((definition) => definition.name),
    ).toEqual([
      'revise_object',
      'write_object',
      'delete_object',
      'update_element',
      'rename_node',
      'set_node_summary',
      'edit_block',
      'edit_blocks',
      'append_paragraph',
      'remove_blocks',
      'replace_block_range',
      'insert_blocks',
      'update_storyline',
      'update_project_facts',
      'create_element_patch',
      'update_element_patch',
      'delete_element_patch',
      'create_comment',
    ]);

    const input = await authorizedRequest('rename_node', {
      node: 'Chapter One',
      title: 'Opening',
    });
    const first = await runtime.execute(input);
    expect(first).toMatchObject({
      ok: true,
      data: {
        effectId: `agent-write:${input.idempotencyKey}`,
        writeRef: `agent-write:${input.idempotencyKey}`,
        authorization: { kind: 'automatic' },
      },
    });
    expect(node().title).toBe('Opening');
    expect(renameNode).toHaveBeenCalledOnce();

    const effect = repository.effect(`agent-write:${input.idempotencyKey}`);
    expect(effect).toMatchObject({
      phase: 'result_committed',
      preimage: { field: 'title', value: 'Chapter One' },
      reversibility: 'exact',
      authorization: {
        kind: 'automatic',
        requestId: null,
        argumentsHash: input.authorization?.argumentsHash,
      },
    });
    expect(repository.reviews()).toHaveLength(0);

    const replay = await runtime.execute(input);
    expect(replay).toEqual(first);
    expect(renameNode).toHaveBeenCalledOnce();
  });

  it('persists provenance for an author-approved write', async () => {
    const repository = memoryRepository();
    const renameNode = vi.fn(async (id: string, title: string) => {
      updateNode(id, { title });
    });
    const runtime = createRuntime(repository, { renameNode });
    const input = await authorizedRequest(
      'rename_node',
      {
      node: 'Chapter One',
      title: 'Opening',
      },
      'author_approved',
    );

    await expect(runtime.execute(input)).resolves.toMatchObject({
      ok: true,
      data: { authorization: { kind: 'author_approved' } },
    });
    expect(repository.effect(`agent-write:${input.idempotencyKey}`)).toMatchObject({
      authorization: {
        kind: 'author_approved',
        requestId: 'turn-1:call-rename_node:permission',
        argumentsHash: input.authorization?.argumentsHash,
      },
    });
    expect(repository.reviews()).toEqual([]);
    expect(renameNode).toHaveBeenCalledOnce();
  });

  it('rejects missing or argument-mismatched authorization before claiming an effect', async () => {
    const repository = memoryRepository();
    const renameNode = vi.fn(async (id: string, title: string) => {
      updateNode(id, { title });
    });
    const runtime = createRuntime(repository, { renameNode });
    const missing = request('rename_node', {
      node: 'Chapter One',
      title: 'Opening',
    });
    const mismatched = {
      ...(await authorizedRequest('rename_node', missing.arguments)),
      authorization: {
        kind: 'automatic' as const,
        requestId: null,
        argumentsHash: `sha256:${'0'.repeat(64)}`,
      },
    };

    await expect(runtime.execute(missing)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('pre-execution authorization'),
    });
    await expect(runtime.execute(mismatched)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('approved write arguments changed'),
    });
    expect(repository.allEffects()).toEqual([]);
    expect(renameNode).not.toHaveBeenCalled();
  });

  it('marks an entered write uncertain and never dispatches it again', async () => {
    const repository = memoryRepository();
    let dispatches = 0;
    const runtime = createRuntime(repository, {}, async (_name, _arguments, _context) => {
      dispatches += 1;
      updateNode('node-1', { title: 'Maybe committed' });
      throw new Error('process boundary lost');
    });
    const input = await authorizedRequest('rename_node', {
      node: 'Chapter One',
      title: 'Maybe committed',
    });

    await expect(runtime.execute(input)).resolves.toEqual({
      ok: false,
      error: 'process boundary lost',
    });
    expect(repository.effect(`agent-write:${input.idempotencyKey}`).phase).toBe('uncertain');

    await expect(runtime.execute(input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('inspect its durable effect'),
    });
    expect(dispatches).toBe(1);
  });

  it('does not touch the legacy review repository for newly authorized writes', async () => {
    const repository = memoryRepository();
    repository.api.createReview = vi.fn(async () => {
      throw new Error('legacy review repository must not be called');
    });
    const renameNode = vi.fn(async (id: string, title: string) => {
      updateNode(id, { title });
    });
    const runtime = createRuntime(repository, { renameNode });
    const input = await authorizedRequest('rename_node', {
      node: 'Chapter One',
      title: 'Opening',
    });

    await expect(runtime.execute(input)).resolves.toMatchObject({ ok: true });
    expect(repository.effect(`agent-write:${input.idempotencyKey}`).phase).toBe('result_committed');
    expect(repository.reviews()).toHaveLength(0);
    expect(renameNode).toHaveBeenCalledOnce();
    expect(repository.api.createReview).not.toHaveBeenCalled();
  });

  it('recovers a missing approve-mode review before rebuilding editor UI', async () => {
    const repository = memoryRepository();
    const createReview = repository.api.createReview.bind(repository.api);
    let failReviewCreation = true;
    repository.api.createReview = vi.fn(async (input) => {
      if (failReviewCreation) {
        failReviewCreation = false;
        throw new Error('review storage unavailable');
      }
      return createReview(input);
    });
    const projectReview = vi.fn(async () => undefined);
    const strategy: DriftingWriteStrategy = {
      prepare: async (writeRequest) => {
        const effectId = `agent-write:${writeRequest.idempotencyKey}`;
        const payload = {
          kind: 'yjs_prose' as const,
          reviewSnapshot: {
            effectId,
            reviewId: `agent-review:${effectId}`,
            mode: 'approve' as const,
          },
        };
        return {
          observedRevision: null,
          preimage: { stateHash: 'before' },
          forward: payload,
          inverse: payload,
          reversibility: 'exact',
        };
      },
      applyForward: async () => ({ ok: true, revision: 'yjs:1' }),
      captureEffect: async (_request, _context, result) => ({
        kind: 'yjs_prose',
        handlerResult: result,
      }),
      projectReview,
      applyInverse: async () => ({ ok: true }),
    };
    const runtime = createRuntime(repository, {}, undefined, () => strategy);
    const input = await authorizedRequest('edit_block', {
      entity: 'Chapter One',
      block: 1,
      text: 'Changed',
    });
    const effectId = `agent-write:${input.idempotencyKey}`;
    const reviewId = `agent-review:${effectId}`;

    await expect(runtime.execute(input)).resolves.toMatchObject({
      ok: false,
      error: 'review storage unavailable',
    });
    expect(repository.effect(effectId).phase).toBe('result_committed');
    expect(repository.reviews()).toEqual([]);
    expect(projectReview).not.toHaveBeenCalled();

    await expect(runtime.reconcileInterruptedWrites('session-1')).resolves.toEqual({
      inspected: 0,
      reconciled: 0,
      unresolved: 0,
      issues: [],
    });
    expect(repository.reviews()).toEqual([
      expect.objectContaining({
        id: reviewId,
        effectId,
        status: 'pending',
      }),
    ]);
    expect(projectReview).toHaveBeenCalledOnce();
  });

  it('reconciles an entered prose write from its durable receipt without replaying mutation', async () => {
    const repository = memoryRepository();
    let forwardCalls = 0;
    let reconcileCalls = 0;
    const strategy: DriftingWriteStrategy = {
      prepare: async () => ({
        observedRevision: null,
        preimage: { stateHash: 'before' },
        forward: { commandId: 'command-1' },
        inverse: { commandId: 'command-1' },
        reversibility: 'exact',
      }),
      applyForward: async () => {
        forwardCalls += 1;
        // The inner Yjs coordinator receipt committed, but its caller lost the
        // response before effect_committed could be journaled.
        throw new Error('response lost after prose receipt commit');
      },
      captureEffect: async () => {
        throw new Error('capture must not run after response loss');
      },
      reconcileEnteredEffect: async () => {
        reconcileCalls += 1;
        return {
          handlerResult: {
            ok: true,
            nodeId: 'node-1',
            stateHash: 'after',
            revision: 'yjs:1',
          },
          committedEffect: {
            kind: 'yjs_prose',
            commandId: 'command-1',
            stateHash: 'after',
            handlerResult: {
              ok: true,
              nodeId: 'node-1',
              stateHash: 'after',
              revision: 'yjs:1',
            },
          },
        };
      },
      applyInverse: async () => ({ ok: true }),
    };
    const runtime = createRuntime(repository, {}, undefined, () => strategy);
    const input = await authorizedRequest('edit_block', {
      entity: 'Chapter One',
      block: 1,
      text: 'Changed',
    });

    await expect(runtime.execute(input)).resolves.toEqual({
      ok: false,
      error: 'response lost after prose receipt commit',
    });
    expect(repository.effect(`agent-write:${input.idempotencyKey}`).phase).toBe('uncertain');

    const replay = await runtime.execute(input);
    expect(replay).toMatchObject({
      ok: true,
      data: {
        result: {
          stateHash: 'after',
          revision: 'yjs:1',
        },
        writeRef: `agent-write:${input.idempotencyKey}`,
        authorization: { kind: 'automatic' },
      },
    });
    expect(repository.effect(`agent-write:${input.idempotencyKey}`).phase).toBe('result_committed');
    expect(forwardCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
    expect(repository.reviews()).toEqual([]);
  });

  it('settles prose review blocks durably and retries an entered block inverse during project hydration', async () => {
    const repository = memoryRepository();
    const applyReviewBlockInverse = vi.fn(
      async (_effect, blockId: string) => ({ restoredBlock: blockId }),
    );
    const projectReview = vi.fn(async () => undefined);
    const strategy: DriftingWriteStrategy = {
      prepare: async (writeRequest) => {
        const effectId = `agent-write:${writeRequest.idempotencyKey}`;
        const payload = {
          kind: 'yjs_prose' as const,
          reviewSnapshot: {
            effectId,
            reviewId: `agent-review:${effectId}`,
            mode: 'approve' as const,
          },
        };
        return {
          observedRevision: null,
          preimage: { stateHash: 'before' },
          forward: payload,
          inverse: payload,
          reversibility: 'exact',
        };
      },
      applyForward: async () => ({ ok: true, revision: 'yjs:1' }),
      captureEffect: async (_request, _context, result) => ({
        kind: 'yjs_prose',
        handlerResult: result,
      }),
      reviewBlocks: async () => [
        { blockId: 'paragraph-a', ordinal: 0 },
        { blockId: 'paragraph-b', ordinal: 1 },
      ],
      applyReviewBlockInverse,
      projectReview,
      applyInverse: async () => ({ ok: true }),
    };
    const runtime = createRuntime(repository, {}, undefined, () => strategy);
    const input = await authorizedRequest('edit_block', {
      entity: 'Chapter One',
      block: 1,
      text: 'Changed',
    });
    const effectId = `agent-write:${input.idempotencyKey}`;
    const reviewId = `agent-review:${effectId}`;

    await expect(runtime.execute(input)).resolves.toMatchObject({
      ok: true,
      presentation: { review: { id: reviewId, status: 'pending' } },
    });
    expect(repository.reviewBlocks(reviewId)).toMatchObject([
      { blockId: 'paragraph-a', status: 'pending' },
      { blockId: 'paragraph-b', status: 'pending' },
    ]);

    await repository.api.transitionReviewBlock({
      reviewId,
      blockId: 'paragraph-b',
      expectedStatus: 'pending',
      nextStatus: 'revert_started',
      decisionNote: 'reject after restart',
      at: iso(20),
    });
    await expect(runtime.reconcileProjectReviews('project-1')).resolves.toEqual({
      projected: 1,
      unresolved: 0,
    });
    expect(applyReviewBlockInverse).toHaveBeenCalledOnce();
    expect(repository.reviewBlocks(reviewId)).toMatchObject([
      { blockId: 'paragraph-a', status: 'pending' },
      { blockId: 'paragraph-b', status: 'reverted' },
    ]);
    expect(projectReview).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: effectId }),
      expect.objectContaining({ projectId: 'project-1' }),
      { 'paragraph-b': 'reverted' },
    );

    const settled = await runtime.acceptReviewBlock(
      reviewId,
      'paragraph-a',
      'accept remaining block',
    );
    expect(settled).toMatchObject({
      review: { status: 'accepted_effect' },
      block: { status: 'accepted' },
    });
    expect(repository.reviews()[0]).toMatchObject({
      status: 'accepted_effect',
      decisionNote: {
        kind: 'block_review',
        decisions: [
          { blockId: 'paragraph-a', decision: 'accepted' },
          { blockId: 'paragraph-b', decision: 'reverted' },
        ],
      },
    });
  });

  it('backfills ordered blocks for a pending pre-0071 prose review', async () => {
    const repository = memoryRepository();
    let exposeBlocks = false;
    const projectReview = vi.fn(async () => undefined);
    const strategy: DriftingWriteStrategy = {
      prepare: async (writeRequest) => {
        const effectId = `agent-write:${writeRequest.idempotencyKey}`;
        const payload = {
          kind: 'yjs_prose' as const,
          reviewSnapshot: {
            effectId,
            reviewId: `agent-review:${effectId}`,
            mode: 'approve' as const,
          },
        };
        return {
          observedRevision: null,
          preimage: { stateHash: 'before' },
          forward: payload,
          inverse: payload,
          reversibility: 'exact',
        };
      },
      applyForward: async () => ({ ok: true, revision: 'yjs:1' }),
      captureEffect: async (_request, _context, result) => ({
        kind: 'yjs_prose',
        handlerResult: result,
      }),
      reviewBlocks: async () =>
        exposeBlocks ? [{ blockId: 'legacy-paragraph', ordinal: 0 }] : [],
      applyReviewBlockInverse: async () => ({ restored: true }),
      projectReview,
      applyInverse: async () => ({ ok: true }),
    };
    const runtime = createRuntime(repository, {}, undefined, () => strategy);
    const input = await authorizedRequest('edit_block', {
      entity: 'Chapter One',
      block: 1,
      text: 'Changed',
    });
    const reviewId = `agent-review:agent-write:${input.idempotencyKey}`;
    await runtime.execute(input);
    expect(repository.reviewBlocks(reviewId)).toEqual([]);

    exposeBlocks = true;
    await expect(runtime.reconcileProjectReviews('project-1')).resolves.toEqual({
      projected: 1,
      unresolved: 0,
    });
    expect(repository.reviewBlocks(reviewId)).toMatchObject([
      { blockId: 'legacy-paragraph', ordinal: 0, status: 'pending' },
    ]);
  });

  it('fails closed on an unavailable write before claiming an effect', async () => {
    const repository = memoryRepository();
    const runtime = createRuntime(repository, {});
    const unavailable = request('delete_element', { element: 'Someone' });

    await expect(runtime.execute(unavailable)).resolves.toEqual({
      ok: false,
      error: 'Tool "delete_element" is not write-certified',
    });
    expect(repository.allEffects()).toEqual([]);
  });

  it('records and reprojects Added from the canonical committed create result', async () => {
    const repository = memoryRepository();
    const applyForward = vi.fn(async () => {
      useDataStore.setState((state) => ({
        bookNodes: [
          ...state.bookNodes,
          {
            id: 'node-added',
            projectId: 'project-1',
            kind: 'drift' as const,
            title: '潮痕',
            summary: '',
            narrativeOrder: null,
            driftGroupId: null,
            position: { x: 0, y: 0 },
            wordCount: 5,
            bookOrder: null,
            writingStatus: 'drifting' as const,
            createdAt: iso(1),
            updatedAt: iso(1),
          },
        ],
      }));
      return { entityId: 'node-added', nodeId: 'node-added' };
    });
    const strategy: DriftingWriteStrategy = {
      prepare: async () => ({
        observedRevision: null,
        preimage: { kind: 'missing' },
        forward: { kind: 'created' },
        inverse: { kind: 'delete' },
        reversibility: 'exact',
      }),
      applyForward,
      captureEffect: async (_request, _context, result) => result,
      applyInverse: async () => ({ ok: true }),
    };
    const runtime = createRuntime(
      repository,
      {},
      undefined,
      () => strategy,
      async (writeRequest) => ({
        ...writeRequest,
        arguments: {
          path: '/drifts/潮痕/prose.md',
          __workspaceCommand: {
            name: 'create_node',
            arguments: {
              kind: 'drift',
              title: '潮痕',
              content: '潮水退去。',
            },
          },
        },
      }),
    );
    const input = await authorizedRequest('write_object', {
      target: '灵感「潮痕」',
      body: '潮水退去。',
    });

    const result = await runtime.execute(input);

    expect(result).toMatchObject({
      ok: true,
      data: {
        result: {
          path: '/drifts/潮痕/prose.md',
          operation: 'created',
        },
      },
      modelData: expect.any(String),
    });
    if (result.ok) {
      expect(result.modelData).not.toContain('"operation"');
    }
    expect(useAgentEditStore.getState().additions['node:node-added']).toEqual({
      entityType: 'node',
      id: 'node-added',
      revealBlockIds: null,
    });
    expect(applyForward).toHaveBeenCalledOnce();

    useAgentEditStore.getState().clearAll();
    await expect(runtime.execute(input)).resolves.toEqual(result);
    expect(useAgentEditStore.getState().additions['node:node-added']).toEqual({
      entityType: 'node',
      id: 'node-added',
      revealBlockIds: null,
    });
    expect(applyForward).toHaveBeenCalledOnce();
  });

  it('settles a workspace no-op as success without claiming a durable effect', async () => {
    const repository = memoryRepository();
    const runtime = createRuntime(
      repository,
      {},
      undefined,
      undefined,
      async () => {
        throw new WorkspaceNoopWriteSignal('/chapters/Chapter One/prose.md');
      },
    );

    await expect(
      runtime.execute(
        request('edit_file', {
          path: 'Chapter One',
          replacements: [{ oldText: 'Same', newText: 'Same' }],
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { noop: true },
      modelData: expect.stringContaining('已经是所需内容，无需修改'),
    });
    expect(repository.allEffects()).toEqual([]);
  });
});

function createRuntime(
  repository: ReturnType<typeof memoryRepository>,
  writeOverrides: Partial<AgentWriteApi>,
  dispatch?: (
    name: string,
    args: Record<string, unknown>,
    context: AgentToolContext,
  ) => Promise<unknown>,
  resolveStrategy?: (name: string) => DriftingWriteStrategy | undefined,
  prepareRequest?: (
    request: AgentToolExecutionRequest,
  ) => Promise<AgentToolExecutionRequest>,
): DriftingWriteToolRuntime {
  const write = {
    renameNode: async (id: string, title: string) => {
      updateNode(id, { title });
    },
    updateNode: async (id: string, updates: { summary?: string }) => {
      updateNode(id, updates);
    },
    ...writeOverrides,
  } as unknown as AgentWriteApi;
  const context: AgentToolContext = { projectId: 'project-1', write };
  const emptyReadRuntime: AgentToolRuntime = {
    listDefinitions: () => [],
    execute: async () => ({ ok: false, error: 'not a read test' }),
  };
  return new DriftingWriteToolRuntime({
    repository: repository.api,
    freshness: null,
    getContext: () => context,
    readRuntime: emptyReadRuntime,
    now: incrementingClock(),
    ...(dispatch ? { dispatch } : {}),
    ...(resolveStrategy ? { resolveStrategy } : {}),
    ...(prepareRequest ? { prepareRequest } : {}),
  });
}

function request(name: string, arguments_: Record<string, unknown>): AgentToolExecutionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    callId: `call-${name}`,
    idempotencyKey: `session-1:turn-1:call-${name}`,
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
    control: {
      requestUserInput: async () => {
        throw new Error('User input is unavailable in this write-runtime test');
      },
    },
    signal: new AbortController().signal,
  };
}

async function authorizedRequest(
  name: string,
  arguments_: Record<string, unknown>,
  kind: 'automatic' | 'author_approved' = 'automatic',
): Promise<AgentToolExecutionRequest> {
  const base = request(name, arguments_);
  return {
    ...base,
    authorization: {
      kind,
      requestId: kind === 'author_approved' ? `${base.turnId}:${base.callId}:permission` : null,
      argumentsHash: await hashAgentPermissionArguments(arguments_),
    },
  };
}

function memoryRepository() {
  const effects = new Map<string, PersistedAgentRuntimeWriteEffect>();
  const reviews = new Map<string, PersistedAgentRuntimeWriteReview>();
  const reviewBlocks = new Map<string, PersistedAgentRuntimeWriteReviewBlock>();

  const api: AgentRuntimeWriteEffectRepository = {
    async claimEffect(claim: ClaimAgentRuntimeWriteEffect) {
      const existing = effects.get(claim.id);
      if (existing) return { outcome: 'duplicate' as const, effect: existing };
      const effect: PersistedAgentRuntimeWriteEffect = {
        ...claim,
        phase: 'claimed',
        observedRevision: null,
        preimage: null,
        forward: null,
        inverse: null,
        reversibility: null,
        effect: null,
        result: null,
        errorCode: null,
        errorMessage: null,
        confirmedAt: null,
        mutationStartedAt: null,
        effectCommittedAt: null,
        resultCommittedAt: null,
        uncertainAt: null,
        failedAt: null,
        declinedAt: null,
        updatedAt: claim.claimedAt,
      };
      effects.set(effect.id, effect);
      return { outcome: 'inserted' as const, effect };
    },
    async getEffect(id: string) {
      return effects.get(id) ?? null;
    },
    async listEffects(sessionId: string) {
      return [...effects.values()].filter((effect) => effect.sessionId === sessionId);
    },
    async transitionEffect(transition: AgentRuntimeWriteEffectTransition) {
      const current = effects.get(transition.effectId);
      if (!current || current.phase !== transition.expectedPhase) {
        throw new Error('invalid test effect transition');
      }
      const next = transitionEffect(current, transition);
      effects.set(next.id, next);
      return { outcome: 'updated' as const, effect: next };
    },
    async createReview(input: CreateAgentRuntimeWriteReview) {
      const existing = reviews.get(input.id);
      if (existing) {
        const existingBlocks = [...reviewBlocks.values()].filter(
          (block) => block.reviewId === input.id,
        );
        if (
          existing.status === 'pending' &&
          existingBlocks.length === 0 &&
          (input.blocks?.length ?? 0) > 0
        ) {
          for (const block of input.blocks ?? []) {
            reviewBlocks.set(`${input.id}\u0000${block.blockId}`, {
              reviewId: input.id,
              effectId: input.effectId,
              blockId: block.blockId,
              ordinal: block.ordinal,
              status: 'pending',
              decisionNote: null,
              revertEffect: null,
              errorCode: null,
              errorMessage: null,
              createdAt: existing.createdAt,
              revertStartedAt: null,
              settledAt: null,
              updatedAt: existing.createdAt,
            });
          }
          return { outcome: 'updated' as const, review: existing };
        }
        return { outcome: 'duplicate' as const, review: existing };
      }
      const review: PersistedAgentRuntimeWriteReview = {
        ...input,
        status: 'pending',
        decisionNote: null,
        revertEffect: null,
        errorCode: null,
        errorMessage: null,
        acceptedAt: null,
        rejectedAt: null,
        revertStartedAt: null,
        settledAt: null,
        updatedAt: input.createdAt,
      };
      reviews.set(review.id, review);
      for (const block of input.blocks ?? []) {
        reviewBlocks.set(`${input.id}\u0000${block.blockId}`, {
          reviewId: input.id,
          effectId: input.effectId,
          blockId: block.blockId,
          ordinal: block.ordinal,
          status: 'pending',
          decisionNote: null,
          revertEffect: null,
          errorCode: null,
          errorMessage: null,
          createdAt: input.createdAt,
          revertStartedAt: null,
          settledAt: null,
          updatedAt: input.createdAt,
        });
      }
      return { outcome: 'inserted' as const, review };
    },
    async getReview(id: string) {
      return reviews.get(id) ?? null;
    },
    async listReviews(sessionId: string) {
      return [...reviews.values()].filter((review) => review.sessionId === sessionId);
    },
    async listPendingReviewsForProject(projectId: string) {
      return [...reviews.values()].filter((review) => {
        const effect = effects.get(review.effectId);
        return effect?.projectId === projectId && review.status === 'pending';
      });
    },
    async listReviewBlocks(reviewId: string) {
      return [...reviewBlocks.values()]
        .filter((block) => block.reviewId === reviewId)
        .sort((left, right) => left.ordinal - right.ordinal);
    },
    async transitionReviewBlock(
      transition: AgentRuntimeWriteReviewBlockTransition,
    ) {
      const key = `${transition.reviewId}\u0000${transition.blockId}`;
      const current = reviewBlocks.get(key);
      const review = reviews.get(transition.reviewId);
      if (!current || !review || current.status !== transition.expectedStatus) {
        throw new Error('invalid test review block transition');
      }
      const next = transitionReviewBlock(current, transition);
      reviewBlocks.set(key, next);
      const blocks = [...reviewBlocks.values()]
        .filter((block) => block.reviewId === transition.reviewId)
        .sort((left, right) => left.ordinal - right.ordinal);
      let settledReview = review;
      if (
        blocks.length > 0 &&
        blocks.every(
          (block) => block.status === 'accepted' || block.status === 'reverted',
        )
      ) {
        const allReverted = blocks.every(
          (block) => block.status === 'reverted',
        );
        settledReview = {
          ...review,
          status: allReverted ? 'reverted' : 'accepted_effect',
          decisionNote: {
            schemaVersion: 1,
            kind: 'block_review',
            decisions: blocks.map((block) => ({
              blockId: block.blockId,
              decision: block.status,
            })),
          },
          acceptedAt: allReverted ? review.acceptedAt : transition.at,
          rejectedAt: allReverted ? transition.at : review.rejectedAt,
          settledAt: transition.at,
          updatedAt: transition.at,
        };
        reviews.set(settledReview.id, settledReview);
      }
      return {
        outcome: 'updated' as const,
        review: settledReview,
        block: next,
        blocks,
      };
    },
    async transitionReview(transition: AgentRuntimeWriteReviewTransition) {
      const current = reviews.get(transition.reviewId);
      if (!current || current.status !== transition.expectedStatus) {
        throw new Error('invalid test review transition');
      }
      const next = transitionReview(current, transition);
      reviews.set(next.id, next);
      return { outcome: 'updated' as const, review: next };
    },
    async interruptSessionWrites() {
      return { failedBeforeMutation: 0, uncertainAfterMutationStart: 0 };
    },
    async loadSnapshot(sessionId: string) {
      return {
        effects: [...effects.values()].filter((effect) => effect.sessionId === sessionId),
        reviews: [...reviews.values()].filter((review) => review.sessionId === sessionId),
      };
    },
  };

  return {
    api,
    effect(id: string) {
      const effect = effects.get(id);
      if (!effect) throw new Error('missing test effect');
      return effect;
    },
    allEffects: () => [...effects.values()],
    reviews: () => [...reviews.values()],
    reviewBlocks: (reviewId: string) =>
      [...reviewBlocks.values()]
        .filter((block) => block.reviewId === reviewId)
        .sort((left, right) => left.ordinal - right.ordinal),
  };
}

function transitionEffect(
  current: PersistedAgentRuntimeWriteEffect,
  transition: AgentRuntimeWriteEffectTransition,
): PersistedAgentRuntimeWriteEffect {
  const base = { ...current, phase: transition.nextPhase, updatedAt: transition.at };
  switch (transition.nextPhase) {
    case 'confirmed':
      return { ...base, confirmedAt: transition.at };
    case 'mutation_started':
      return {
        ...base,
        mutationStartedAt: transition.at,
        observedRevision: transition.observedRevision,
        preimage: transition.preimage,
        forward: transition.forward,
        inverse: transition.inverse,
        reversibility: transition.reversibility,
      };
    case 'effect_committed':
      return {
        ...base,
        effectCommittedAt: transition.at,
        effect: transition.effect,
      };
    case 'result_committed':
      return {
        ...base,
        resultCommittedAt: transition.at,
        result: transition.result,
      };
    case 'uncertain':
      return {
        ...base,
        uncertainAt: transition.at,
        errorCode: transition.errorCode,
        errorMessage: transition.errorMessage ?? null,
      };
    case 'failed':
      return {
        ...base,
        failedAt: transition.at,
        errorCode: transition.errorCode,
        errorMessage: transition.errorMessage ?? null,
      };
    case 'declined':
      return { ...base, declinedAt: transition.at };
  }
}

function transitionReview(
  current: PersistedAgentRuntimeWriteReview,
  transition: AgentRuntimeWriteReviewTransition,
): PersistedAgentRuntimeWriteReview {
  const base = {
    ...current,
    status: transition.nextStatus,
    updatedAt: transition.at,
  };
  switch (transition.nextStatus) {
    case 'accepted':
      return {
        ...base,
        acceptedAt: transition.at,
        decisionNote: transition.decisionNote ?? null,
      };
    case 'rejected':
      return {
        ...base,
        rejectedAt: transition.at,
        decisionNote: transition.decisionNote ?? null,
      };
    case 'accepted_effect':
      return { ...base, settledAt: transition.at };
    case 'revert_started':
      return {
        ...base,
        revertStartedAt: transition.at,
        settledAt: null,
        errorCode: null,
        errorMessage: null,
      };
    case 'reverted':
      return {
        ...base,
        settledAt: transition.at,
        revertEffect: transition.revertEffect,
      };
    case 'revert_failed':
    case 'revert_unavailable':
      return {
        ...base,
        settledAt: transition.at,
        errorCode: transition.errorCode,
        errorMessage: transition.errorMessage ?? null,
      };
  }
}

function transitionReviewBlock(
  current: PersistedAgentRuntimeWriteReviewBlock,
  transition: AgentRuntimeWriteReviewBlockTransition,
): PersistedAgentRuntimeWriteReviewBlock {
  const base = {
    ...current,
    status: transition.nextStatus,
    updatedAt: transition.at,
  };
  switch (transition.nextStatus) {
    case 'accepted':
      return {
        ...base,
        decisionNote: transition.decisionNote ?? null,
        settledAt: transition.at,
      };
    case 'revert_started':
      return {
        ...base,
        decisionNote: transition.decisionNote ?? current.decisionNote,
        revertStartedAt: transition.at,
        settledAt: null,
      };
    case 'reverted':
      return {
        ...base,
        revertEffect: transition.revertEffect,
        settledAt: transition.at,
      };
    case 'revert_failed':
      return {
        ...base,
        errorCode: transition.errorCode,
        errorMessage: transition.errorMessage ?? null,
        settledAt: transition.at,
      };
  }
}

function updateNode(id: string, updates: { title?: string; summary?: string }): void {
  useDataStore.setState((state) => ({
    bookNodes: state.bookNodes.map((candidate) =>
      candidate.id === id ? { ...candidate, ...updates, updatedAt: iso(1) } : candidate,
    ),
  }));
}

function node() {
  const current = useDataStore.getState().bookNodes.find((candidate) => candidate.id === 'node-1');
  if (!current) throw new Error('missing fixture node');
  return current;
}

function incrementingClock(): () => string {
  let tick = 1;
  return () => iso(tick++);
}

function iso(second: number): string {
  return `2026-07-30T00:00:${String(second).padStart(2, '0')}.000Z`;
}
