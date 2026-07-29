import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeWriteEffectTransition,
  AgentRuntimeWriteReviewTransition,
  ClaimAgentRuntimeWriteEffect,
  CreateAgentRuntimeWriteReview,
  PersistedAgentRuntimeWriteEffect,
  PersistedAgentRuntimeWriteReview,
} from '../../../domain/agent-runtime-write-effect';
import type { AgentRuntimeWriteEffectRepository } from '../../../sqlite-repo/agent-runtime-write-effect-repo';
import { useDataStore } from '../../../store/data-store';
import type {
  AgentToolContext,
  AgentWriteApi,
} from '../tool-handlers';
import { DriftingWriteToolRuntime } from './drifting-write-tool-runtime';
import type {
  AgentToolExecutionRequest,
  AgentToolRuntime,
} from './types';

const initialDataState = useDataStore.getState();

beforeEach(() => {
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
  useDataStore.setState(initialDataState, true);
});

describe('DriftingWriteToolRuntime', () => {
  it('exposes only certified writes, persists one effect, and replays duplicates without mutation', async () => {
    const repository = memoryRepository();
    const renameNode = vi.fn(async (id: string, title: string) => {
      updateNode(id, { title });
    });
    const runtime = createRuntime(repository, { renameNode });

    expect(
      runtime
        .listDefinitions(request('rename_node', {}).context)
        .map((definition) => definition.name),
    ).toEqual(['rename_node', 'set_node_summary']);

    const input = request('rename_node', {
      node: 'Chapter One',
      title: 'Opening',
    });
    const first = await runtime.execute(input);
    expect(first).toMatchObject({
      ok: true,
      data: {
        effectId: `agent-write:${input.idempotencyKey}`,
        review: { status: 'pending' },
      },
    });
    expect(node().title).toBe('Opening');
    expect(renameNode).toHaveBeenCalledOnce();

    const effect = repository.effect(`agent-write:${input.idempotencyKey}`);
    expect(effect).toMatchObject({
      phase: 'result_committed',
      preimage: { field: 'title', value: 'Chapter One' },
      reversibility: 'exact',
    });
    expect(repository.reviews()).toHaveLength(1);

    const replay = await runtime.execute(input);
    expect(replay).toEqual(first);
    expect(renameNode).toHaveBeenCalledOnce();
  });

  it('rejects a soft review through the same usecase and stores the exact inverse receipt', async () => {
    const repository = memoryRepository();
    const renameNode = vi.fn(async (id: string, title: string) => {
      updateNode(id, { title });
    });
    const runtime = createRuntime(repository, { renameNode });
    const input = request('rename_node', {
      node: 'Chapter One',
      title: 'Opening',
    });
    const result = await runtime.execute(input);
    if (!result.ok) throw new Error(result.error);
    const reviewId = (
      result.data as { review: { id: string } }
    ).review.id;

    const decision = await runtime.rejectReview(reviewId, {
      reason: 'author rejected',
    });

    expect(decision.review.status).toBe('reverted');
    expect(decision.review.revertEffect).toMatchObject({
      field: 'title',
      value: 'Chapter One',
    });
    expect(node().title).toBe('Chapter One');
    expect(renameNode).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a newer manual edit during review rejection', async () => {
    const repository = memoryRepository();
    const updateNodeUsecase = vi.fn(
      async (id: string, updates: { summary?: string }) => {
        updateNode(id, updates);
      },
    );
    const runtime = createRuntime(repository, {
      updateNode: updateNodeUsecase,
    });
    const result = await runtime.execute(
      request('set_node_summary', {
        node: 'Chapter One',
        summary: 'Agent summary',
      }),
    );
    if (!result.ok) throw new Error(result.error);
    updateNode('node-1', { summary: 'Newer author summary' });

    const decision = await runtime.rejectReview(
      (result.data as { review: { id: string } }).review.id,
    );

    expect(decision.review.status).toBe('revert_failed');
    expect(node().summary).toBe('Newer author summary');
    expect(updateNodeUsecase).toHaveBeenCalledOnce();
  });

  it('marks an entered write uncertain and never dispatches it again', async () => {
    const repository = memoryRepository();
    let dispatches = 0;
    const runtime = createRuntime(
      repository,
      {},
      async (_name, _arguments, _context) => {
        dispatches += 1;
        updateNode('node-1', { title: 'Maybe committed' });
        throw new Error('process boundary lost');
      },
    );
    const input = request('rename_node', {
      node: 'Chapter One',
      title: 'Maybe committed',
    });

    await expect(runtime.execute(input)).resolves.toEqual({
      ok: false,
      error: 'process boundary lost',
    });
    expect(
      repository.effect(`agent-write:${input.idempotencyKey}`).phase,
    ).toBe('uncertain');

    await expect(runtime.execute(input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('inspect its durable effect'),
    });
    expect(dispatches).toBe(1);
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
});

function createRuntime(
  repository: ReturnType<typeof memoryRepository>,
  writeOverrides: Partial<AgentWriteApi>,
  dispatch?: (
    name: string,
    args: Record<string, unknown>,
    context: AgentToolContext,
  ) => Promise<unknown>,
): DriftingWriteToolRuntime {
  const write = {
    renameNode: async (id: string, title: string) => {
      updateNode(id, { title });
    },
    updateNode: async (
      id: string,
      updates: { summary?: string },
    ) => {
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
    getContext: () => context,
    readRuntime: emptyReadRuntime,
    now: incrementingClock(),
    ...(dispatch ? { dispatch } : {}),
  });
}

function request(
  name: string,
  arguments_: Record<string, unknown>,
): AgentToolExecutionRequest {
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
    signal: new AbortController().signal,
  };
}

function memoryRepository() {
  const effects = new Map<string, PersistedAgentRuntimeWriteEffect>();
  const reviews = new Map<string, PersistedAgentRuntimeWriteReview>();

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
      return [...effects.values()].filter(
        (effect) => effect.sessionId === sessionId,
      );
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
      if (existing) return { outcome: 'duplicate' as const, review: existing };
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
      return { outcome: 'inserted' as const, review };
    },
    async getReview(id: string) {
      return reviews.get(id) ?? null;
    },
    async listReviews(sessionId: string) {
      return [...reviews.values()].filter(
        (review) => review.sessionId === sessionId,
      );
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
        effects: [...effects.values()].filter(
          (effect) => effect.sessionId === sessionId,
        ),
        reviews: [...reviews.values()].filter(
          (review) => review.sessionId === sessionId,
        ),
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
      return { ...base, revertStartedAt: transition.at };
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

function updateNode(
  id: string,
  updates: { title?: string; summary?: string },
): void {
  useDataStore.setState((state) => ({
    bookNodes: state.bookNodes.map((candidate) =>
      candidate.id === id
        ? { ...candidate, ...updates, updatedAt: iso(1) }
        : candidate,
    ),
  }));
}

function node() {
  const current = useDataStore
    .getState()
    .bookNodes.find((candidate) => candidate.id === 'node-1');
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
