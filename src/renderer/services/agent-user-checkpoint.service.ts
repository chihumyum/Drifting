import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AgentChatMessage, AgentConvMode } from '../domain/agent-conversation';
import type {
  AgentUserCheckpoint,
  AgentUserCheckpointActionKind,
  AgentUserCheckpointEntity,
  AgentUserCheckpointPreview,
  AgentUserCheckpointRestoreResult,
  AgentUserCheckpointSummary,
} from '../domain/agent-user-checkpoint';
import { getDb } from '../lib/db';
import {
  canonicalAgentRuntimeJson,
  createAgentRuntimePersistenceRepository,
} from '../sqlite-repo/agent-runtime-persistence-repo';
import {
  createAgentUserCheckpointRepository,
  type AgentUserCheckpointActionEntityRow,
  type AgentUserCheckpointActionRow,
  type AgentUserCheckpointRepository,
} from '../sqlite-repo/agent-user-checkpoint-repo';
import { createAgentRuntimeLongTaskRepository } from '../sqlite-repo/agent-runtime-long-task-repo';
import {
  AgentRuntimeWriteEffectTable,
  AgentRuntimeWriteReviewTable,
} from '../schema/drizzle';
import {
  hashAgentRuntimeCheckpointContext,
  recoverAgentRuntimeSnapshot,
} from '../lib/agent/runtime/recovery';
import type { AgentModelMessage } from '../lib/agent/runtime/types';
import {
  createProductAgentUserCheckpointWorkspace,
  type AgentCheckpointWorkspaceEntityState,
  type AgentUserCheckpointWorkspace,
} from './agent-user-checkpoint-workspace';

const PREVIEW_TTL_MS = 15 * 60_000;
const FORK_CONTEXT_BUDGET_CHARS = 96_000;

export type AgentUserCheckpointErrorCode =
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_NOT_READY'
  | 'CHECKPOINT_ROUTE_MISMATCH'
  | 'CHECKPOINT_ACTION_NOT_FOUND'
  | 'CHECKPOINT_ACTION_CONFLICT'
  | 'CHECKPOINT_PREVIEW_EXPIRED'
  | 'CHECKPOINT_PREVIEW_TOKEN_INVALID'
  | 'CHECKPOINT_PREVIEW_STALE'
  | 'CHECKPOINT_OVERWRITE_CONFIRMATION_REQUIRED'
  | 'CHECKPOINT_ENTITY_MISSING'
  | 'CHECKPOINT_RESTORE_FAILED'
  | 'CHECKPOINT_RECOVERY_DIVERGED';

export class AgentUserCheckpointError extends Error {
  constructor(
    readonly code: AgentUserCheckpointErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentUserCheckpointError';
  }
}

export interface CaptureAgentUserCheckpointInput {
  projectId: string;
  conversationId: string;
  runtimeSessionId: string | null;
  sourceTurnId: string | null;
  label: string;
  kind: 'automatic' | 'manual';
  pinned?: boolean;
  conversationMessages: AgentChatMessage[];
  parentCheckpointId?: string | null;
}

interface RuntimeCheckpointCapture {
  providerHistory: AgentModelMessage[];
  canonicalThroughTurnOrdinal: number;
  canonicalContextHash: string | null;
  longTaskState: unknown | null;
  acceptedWriteEffectIds: string[];
}

export interface AgentUserCheckpointServiceOptions {
  repository?: AgentUserCheckpointRepository;
  workspace?: AgentUserCheckpointWorkspace;
  now?: () => Date;
  createId?: () => string;
  captureRuntime?: (input: {
    projectId: string;
    conversationId: string;
    runtimeSessionId: string | null;
  }) => Promise<RuntimeCheckpointCapture>;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

async function captureProductRuntime(input: {
  projectId: string;
  conversationId: string;
  runtimeSessionId: string | null;
}): Promise<RuntimeCheckpointCapture> {
  if (!input.runtimeSessionId) {
    return {
      providerHistory: [],
      canonicalThroughTurnOrdinal: -1,
      canonicalContextHash: null,
      longTaskState: null,
      acceptedWriteEffectIds: [],
    };
  }
  const persistence = createAgentRuntimePersistenceRepository();
  const snapshot = await persistence.loadRecoverySnapshot(input.runtimeSessionId);
  if (
    !snapshot ||
    snapshot.session.projectId !== input.projectId ||
    snapshot.session.routeKind !== 'chat' ||
    snapshot.session.conversationId !== input.conversationId
  ) {
    throw new AgentUserCheckpointError(
      'CHECKPOINT_ROUTE_MISMATCH',
      'The canonical Agent session does not belong to this project and conversation.',
    );
  }
  const recovered = await recoverAgentRuntimeSnapshot(snapshot);
  const completedOrdinals = recovered.turns
    .filter((turn) => turn.recoveredStatus === 'completed')
    .map((turn) => turn.ordinal);
  const canonicalThroughTurnOrdinal = completedOrdinals.length
    ? Math.max(...completedOrdinals)
    : -1;
  const longTasks = createAgentRuntimeLongTaskRepository();
  const plan = await longTasks.getLatestPlan({
    projectId: input.projectId,
    sessionId: input.runtimeSessionId,
  });
  const manifest = plan
    ? await longTasks.getChapterManifestState(
        { projectId: input.projectId, sessionId: input.runtimeSessionId },
        plan.task.id,
      )
    : null;
  const writes = await getDb()
    .select({
      id: AgentRuntimeWriteEffectTable.id,
      reviewStatus: AgentRuntimeWriteReviewTable.status,
    })
    .from(AgentRuntimeWriteEffectTable)
    .leftJoin(
      AgentRuntimeWriteReviewTable,
      eq(AgentRuntimeWriteReviewTable.effectId, AgentRuntimeWriteEffectTable.id),
    )
    .where(
      and(
        eq(AgentRuntimeWriteEffectTable.sessionId, input.runtimeSessionId),
        inArray(AgentRuntimeWriteEffectTable.phase, [
          'effect_committed',
          'result_committed',
        ]),
      ),
    );
  const acceptedWriteEffectIds = writes
    .filter((row) => row.reviewStatus === null || row.reviewStatus === 'accepted')
    .map((row) => row.id);
  return {
    providerHistory: recovered.providerHistory,
    canonicalThroughTurnOrdinal,
    canonicalContextHash: await hashAgentRuntimeCheckpointContext(
      recovered.providerHistory,
    ),
    longTaskState: plan ? { plan, manifest } : null,
    acceptedWriteEffectIds,
  };
}

function checkpointEntityFromWorkspace(
  checkpointId: string,
  ordinal: number,
  capturedAt: string,
  state: AgentCheckpointWorkspaceEntityState,
): AgentUserCheckpointEntity {
  return {
    checkpointId,
    ordinal,
    projectId: state.projectId,
    entityKind: state.entityKind,
    entityId: state.entityId,
    displayName: state.displayName,
    documentId: state.documentId,
    yjsRevision: state.yjsRevision,
    stateVector: state.stateVector,
    stateHash: state.stateHash,
    contentHash: state.contentHash,
    stateBlob: state.stateBlob,
    metadataJson: state.metadataJson,
    metadataHash: state.metadataHash,
    capturedAt,
  };
}

function deterministicPreviewToken(actionId: string, previewHash: string): string {
  return `drifting-checkpoint-preview:${actionId}:${previewHash}`;
}

function actionResult(
  action: AgentUserCheckpointActionRow,
  restoredEntityCount: number,
  replayed: boolean,
): AgentUserCheckpointRestoreResult {
  return {
    actionId: action.id,
    checkpointId: action.checkpointId,
    restoredEntityCount,
    conversationId: action.targetConversationId,
    replayed,
  };
}

export function buildAgentCheckpointForkContext(
  checkpoint: AgentUserCheckpoint,
  maxChars = FORK_CONTEXT_BUDGET_CHARS,
): string {
  const header = [
    '【系统检查点上下文】这是用户从一个持久化检查点分叉出的新对话。',
    `检查点：${checkpoint.label || checkpoint.id}`,
    `创建时间：${checkpoint.createdAt}`,
    '以下是分叉点之前的 provider-neutral canonical history。它只用于恢复任务语境；不要声称已重新执行其中的工具。',
  ].join('\n');
  const fixed = [
    checkpoint.longTaskState === null
      ? ''
      : `持久化任务状态：${canonicalAgentRuntimeJson(checkpoint.longTaskState)}`,
    checkpoint.acceptedWriteEffectIds.length === 0
      ? ''
      : `分叉点前已接受写入：${checkpoint.acceptedWriteEffectIds.join(', ')}`,
  ].filter(Boolean);
  const historyRows = checkpoint.providerHistory.map(
    (message) => `${message.role}: ${canonicalAgentRuntimeJson(message.content)}`,
  );
  const selected: string[] = [];
  let used = header.length + fixed.reduce((sum, value) => sum + value.length + 1, 0);
  for (let index = historyRows.length - 1; index >= 0; index -= 1) {
    const row = historyRows[index]!;
    if (used + row.length + 1 > maxChars) break;
    selected.unshift(row);
    used += row.length + 1;
  }
  const omitted = historyRows.length - selected.length;
  return [
    header,
    ...fixed,
    omitted > 0 ? `较早的 ${omitted} 条 canonical message 因分叉注入上限未展开。` : '',
    ...selected,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface AgentUserCheckpointService {
  capture(input: CaptureAgentUserCheckpointInput): Promise<AgentUserCheckpoint>;
  list(projectId: string, conversationId?: string): Promise<AgentUserCheckpointSummary[]>;
  get(id: string): Promise<AgentUserCheckpoint | null>;
  getForkContext(checkpointId: string, projectId: string): Promise<string>;
  preview(input: {
    checkpointId: string;
    projectId: string;
    kind: AgentUserCheckpointActionKind;
    idempotencyKey: string;
  }): Promise<AgentUserCheckpointPreview>;
  forkConversation(input: {
    actionId: string;
    previewToken: string;
    title?: string;
    mode: AgentConvMode;
  }): Promise<AgentUserCheckpointRestoreResult>;
  restore(input: {
    actionId: string;
    previewToken: string;
    overwriteConfirmed: boolean;
    forkTitle?: string;
    mode?: AgentConvMode;
  }): Promise<AgentUserCheckpointRestoreResult>;
  recoverIncomplete(projectId?: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createAgentUserCheckpointService(
  options: AgentUserCheckpointServiceOptions = {},
): AgentUserCheckpointService {
  const repository = options.repository ?? createAgentUserCheckpointRepository();
  const workspace = options.workspace ?? createProductAgentUserCheckpointWorkspace();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? uuidv7;
  const captureRuntime = options.captureRuntime ?? captureProductRuntime;

  const requireCheckpoint = async (
    checkpointId: string,
    projectId?: string,
  ): Promise<AgentUserCheckpoint> => {
    const checkpoint = await repository.getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.deletedAt) {
      throw new AgentUserCheckpointError(
        'CHECKPOINT_NOT_FOUND',
        'The Agent checkpoint does not exist.',
      );
    }
    if (projectId && checkpoint.projectId !== projectId) {
      throw new AgentUserCheckpointError(
        'CHECKPOINT_ROUTE_MISMATCH',
        'The Agent checkpoint belongs to another project.',
      );
    }
    if (checkpoint.status !== 'ready') {
      throw new AgentUserCheckpointError(
        'CHECKPOINT_NOT_READY',
        'The Agent checkpoint did not finish capturing and cannot be used.',
      );
    }
    return checkpoint;
  };

  const requireAction = async (actionId: string): Promise<AgentUserCheckpointActionRow> => {
    const action = await repository.getAction(actionId);
    if (!action) {
      throw new AgentUserCheckpointError(
        'CHECKPOINT_ACTION_NOT_FOUND',
        'The checkpoint action does not exist.',
      );
    }
    return action;
  };

  const validateToken = async (
    action: AgentUserCheckpointActionRow,
    token: string,
    allowCompleted = true,
  ): Promise<void> => {
    if (allowCompleted && action.status === 'completed') return;
    if (now().getTime() > Date.parse(action.expiresAt)) {
      throw new AgentUserCheckpointError(
        'CHECKPOINT_PREVIEW_EXPIRED',
        'The checkpoint preview expired. Create a new preview before restoring.',
      );
    }
    if ((await sha256Text(token)) !== action.previewTokenHash) {
      throw new AgentUserCheckpointError(
        'CHECKPOINT_PREVIEW_TOKEN_INVALID',
        'The checkpoint preview token is invalid.',
      );
    }
  };

  const compensate = async (
    action: AgentUserCheckpointActionRow,
    failure: unknown,
  ): Promise<void> => {
    const transition = await repository.transitionAction({
      id: action.id,
      from: ['applying', 'compensating'],
      to: 'compensating',
      now: now().toISOString(),
      errorCode: 'CHECKPOINT_RESTORE_FAILED',
      errorMessage: failure instanceof Error ? failure.message : String(failure),
    });
    if (!transition && action.status !== 'compensating') return;
    const steps = (await repository.listActionEntities(action.id)).reverse();
    let divergent = false;
    for (const step of steps) {
      if (!step.beforeStateBlob || !step.beforeStateVector || !step.beforeMetadataJson || !step.beforeContentHash) {
        continue;
      }
      const current = await workspace.readEntityState(
        action.projectId,
        step.entityKind,
        step.entityId,
      );
      if (!current) {
        divergent = true;
        await repository.settleActionEntity({
          actionId: action.id,
          entityKind: step.entityKind,
          entityId: step.entityId,
          status: 'failed',
          errorCode: 'CHECKPOINT_RECOVERY_DIVERGED',
          errorMessage: 'Entity disappeared while compensating a checkpoint restore.',
          now: now().toISOString(),
        });
        continue;
      }
      if (
        current.contentHash === step.beforeContentHash &&
        current.metadataHash === step.expectedCurrentMetadataHash
      ) {
        await repository.settleActionEntity({
          actionId: action.id,
          entityKind: step.entityKind,
          entityId: step.entityId,
          status: 'compensated',
          resultStateHash: current.stateHash,
          now: now().toISOString(),
        });
        continue;
      }
      if (
        current.contentHash !== step.checkpointContentHash ||
        current.metadataHash !== step.checkpointMetadataHash
      ) {
        // A later author edit wins. Never overwrite it while compensating.
        divergent = true;
        await repository.settleActionEntity({
          actionId: action.id,
          entityKind: step.entityKind,
          entityId: step.entityId,
          status: 'failed',
          errorCode: 'CHECKPOINT_RECOVERY_DIVERGED',
          errorMessage: 'The entity changed after restore; compensation refused to overwrite it.',
          now: now().toISOString(),
        });
        continue;
      }
      await workspace.restoreEntityState({
        ...current,
        yjsRevision: step.beforeRevision ?? current.yjsRevision,
        stateVector: step.beforeStateVector,
        stateBlob: step.beforeStateBlob,
        contentHash: step.beforeContentHash,
        metadataJson: step.beforeMetadataJson,
        metadataHash: step.expectedCurrentMetadataHash,
      });
      const restored = await workspace.readEntityState(
        action.projectId,
        step.entityKind,
        step.entityId,
      );
      if (
        !restored ||
        restored.contentHash !== step.beforeContentHash ||
        restored.metadataHash !== step.expectedCurrentMetadataHash
      ) {
        divergent = true;
        await repository.settleActionEntity({
          actionId: action.id,
          entityKind: step.entityKind,
          entityId: step.entityId,
          status: 'failed',
          errorCode: 'CHECKPOINT_RESTORE_FAILED',
          errorMessage: 'Checkpoint compensation did not restore the pre-action state.',
          now: now().toISOString(),
        });
      } else {
        await repository.settleActionEntity({
          actionId: action.id,
          entityKind: step.entityKind,
          entityId: step.entityId,
          status: 'compensated',
          resultStateHash: restored.stateHash,
          now: now().toISOString(),
        });
      }
    }
    await repository.transitionAction({
      id: action.id,
      from: 'compensating',
      to: divergent ? 'failed' : 'compensated',
      now: now().toISOString(),
      errorCode: divergent
        ? 'CHECKPOINT_RECOVERY_DIVERGED'
        : 'CHECKPOINT_RESTORE_FAILED',
      errorMessage: failure instanceof Error ? failure.message : String(failure),
      completedAt: now().toISOString(),
    });
  };

  const service: AgentUserCheckpointService = {
    async capture(input) {
      if (input.sourceTurnId) {
        const existing = await repository.getCheckpointBySourceTurn({
          conversationId: input.conversationId,
          sourceTurnId: input.sourceTurnId,
          kind: input.kind,
        });
        if (existing?.status === 'ready') return existing;
      }
      const capturedAt = now().toISOString();
      const id = createId();
      const [runtime, states] = await Promise.all([
        captureRuntime({
          projectId: input.projectId,
          conversationId: input.conversationId,
          runtimeSessionId: input.runtimeSessionId,
        }),
        workspace.listProjectEntityStates(input.projectId),
      ]);
      const entities = states.map((state, ordinal) =>
        checkpointEntityFromWorkspace(id, ordinal, capturedAt, state),
      );
      return repository.createCheckpoint({
        checkpoint: {
          id,
          projectId: input.projectId,
          conversationId: input.conversationId,
          runtimeSessionId: input.runtimeSessionId,
          sourceTurnId: input.sourceTurnId,
          parentCheckpointId: input.parentCheckpointId ?? null,
          kind: input.kind,
          label: input.label,
          pinned: input.pinned ?? input.kind === 'manual',
          canonicalThroughTurnOrdinal: runtime.canonicalThroughTurnOrdinal,
          canonicalContextHash: runtime.canonicalContextHash,
          conversationMessages: input.conversationMessages,
          providerHistory: runtime.providerHistory,
          longTaskState: runtime.longTaskState,
          acceptedWriteEffectIds: runtime.acceptedWriteEffectIds,
          createdAt: capturedAt,
        },
        entities,
      });
    },

    list(projectId, conversationId) {
      return repository.listCheckpoints(projectId, conversationId);
    },

    get(id) {
      return repository.getCheckpoint(id);
    },

    async getForkContext(checkpointId, projectId) {
      return buildAgentCheckpointForkContext(
        await requireCheckpoint(checkpointId, projectId),
      );
    },

    async preview(input) {
      const existing = await repository.getActionByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        if (
          existing.projectId !== input.projectId ||
          existing.checkpointId !== input.checkpointId ||
          existing.kind !== input.kind
        ) {
          throw new AgentUserCheckpointError(
            'CHECKPOINT_ACTION_CONFLICT',
            'The checkpoint idempotency key was already used for another action.',
          );
        }
        const rows = await repository.listActionEntities(existing.id);
        const checkpointEntities = await repository.listCheckpointEntities(input.checkpointId);
        const byKey = new Map(
          checkpointEntities.map((entity) => [
            `${entity.entityKind}:${entity.entityId}`,
            entity,
          ]),
        );
        const token = deterministicPreviewToken(existing.id, existing.previewHash);
        const entities = rows.map((row) => {
          const checkpoint = byKey.get(`${row.entityKind}:${row.entityId}`)!;
          const missing = row.expectedCurrentStateHash === 'missing';
          return {
            entityKind: row.entityKind,
            entityId: row.entityId,
            displayName: checkpoint?.displayName ?? row.entityId,
            checkpointStateHash: row.checkpointStateHash,
            currentStateHash: missing ? null : row.expectedCurrentStateHash,
            changed:
              missing ||
              row.expectedCurrentContentHash !== row.checkpointContentHash ||
              row.expectedCurrentMetadataHash !== row.checkpointMetadataHash,
            currentRevision: missing ? null : row.expectedCurrentRevision,
            checkpointRevision: checkpoint?.yjsRevision ?? 0,
            missing,
          };
        });
        return {
          actionId: existing.id,
          checkpointId: existing.checkpointId,
          projectId: existing.projectId,
          previewToken: token,
          expiresAt: existing.expiresAt,
          entities,
          changedEntityCount: entities.filter((entity) => entity.changed).length,
          unchangedEntityCount: entities.filter((entity) => !entity.changed).length,
          requiresExplicitOverwrite: entities.some((entity) => entity.changed),
        };
      }

      const checkpoint = await requireCheckpoint(input.checkpointId, input.projectId);
      const checkpointEntities = await repository.listCheckpointEntities(checkpoint.id);
      const actionId = createId();
      const observed =
        input.kind === 'conversation_fork'
          ? []
          : await Promise.all(
              checkpointEntities.map(async (entity) => ({
                checkpoint: entity,
                current: await workspace.readEntityState(
                  input.projectId,
                  entity.entityKind,
                  entity.entityId,
                ),
              })),
            );
      const previewPayload = observed.map(({ checkpoint: entity, current }) => ({
        entityKind: entity.entityKind,
        entityId: entity.entityId,
        checkpointStateHash: entity.stateHash,
        checkpointContentHash: entity.contentHash,
        checkpointMetadataHash: entity.metadataHash,
        currentStateHash: current?.stateHash ?? 'missing',
        currentContentHash: current?.contentHash ?? 'missing',
        currentMetadataHash: current?.metadataHash ?? 'missing',
      }));
      const previewHash = await sha256Text(canonicalAgentRuntimeJson({
        checkpointId: checkpoint.id,
        projectId: input.projectId,
        kind: input.kind,
        entities: previewPayload,
      }));
      const previewToken = deterministicPreviewToken(actionId, previewHash);
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS).toISOString();
      const action: AgentUserCheckpointActionRow = {
        id: actionId,
        projectId: input.projectId,
        checkpointId: checkpoint.id,
        kind: input.kind,
        status: 'previewed',
        idempotencyKey: input.idempotencyKey,
        previewTokenHash: await sha256Text(previewToken),
        previewHash,
        expiresAt,
        overwriteConfirmed: false,
        targetConversationId: null,
        errorCode: null,
        errorMessage: null,
        createdAt: createdAt.toISOString(),
        updatedAt: createdAt.toISOString(),
        confirmedAt: null,
        completedAt: null,
      };
      const actionEntities: AgentUserCheckpointActionEntityRow[] = observed.map(
        ({ checkpoint: entity, current }, ordinal) => ({
          actionId,
          ordinal,
          projectId: input.projectId,
          entityKind: entity.entityKind,
          entityId: entity.entityId,
          expectedCurrentRevision: current?.yjsRevision ?? null,
          expectedCurrentStateHash: current?.stateHash ?? 'missing',
          expectedCurrentContentHash: current?.contentHash ?? 'missing',
          expectedCurrentMetadataHash: current?.metadataHash ?? 'missing',
          checkpointStateHash: entity.stateHash,
          checkpointContentHash: entity.contentHash,
          checkpointMetadataHash: entity.metadataHash,
          beforeRevision: null,
          beforeStateVector: null,
          beforeStateBlob: null,
          beforeContentHash: null,
          beforeMetadataJson: null,
          resultStateHash: null,
          status: 'pending',
          errorCode: null,
          errorMessage: null,
          updatedAt: createdAt.toISOString(),
        }),
      );
      await repository.createAction({ action, entities: actionEntities });
      const entities = observed.map(({ checkpoint: entity, current }) => ({
        entityKind: entity.entityKind,
        entityId: entity.entityId,
        displayName: entity.displayName,
        checkpointStateHash: entity.stateHash,
        currentStateHash: current?.stateHash ?? null,
        changed:
          !current ||
          current.contentHash !== entity.contentHash ||
          current.metadataHash !== entity.metadataHash,
        currentRevision: current?.yjsRevision ?? null,
        checkpointRevision: entity.yjsRevision,
        missing: !current,
      }));
      return {
        actionId,
        checkpointId: checkpoint.id,
        projectId: input.projectId,
        previewToken,
        expiresAt,
        entities,
        changedEntityCount: entities.filter((entity) => entity.changed).length,
        unchangedEntityCount: entities.filter((entity) => !entity.changed).length,
        requiresExplicitOverwrite: entities.some((entity) => entity.changed),
      };
    },

    async forkConversation(input) {
      const action = await requireAction(input.actionId);
      if (action.status === 'completed') return actionResult(action, 0, true);
      await validateToken(action, input.previewToken);
      if (action.kind !== 'conversation_fork') {
        throw new AgentUserCheckpointError(
          'CHECKPOINT_ACTION_CONFLICT',
          'This preview is not a conversation-only fork.',
        );
      }
      const checkpoint = await requireCheckpoint(action.checkpointId, action.projectId);
      const conversationId = createId();
      await repository.completeConversationFork({
        actionId: action.id,
        checkpointId: checkpoint.id,
        conversation: {
          id: conversationId,
          projectId: checkpoint.projectId,
          parentConversationId: checkpoint.conversationId,
          title: input.title?.trim() || `${checkpoint.label || '检查点'} · 分叉`,
          mode: input.mode,
          messages: checkpoint.conversationMessages,
          createdAt: now().toISOString(),
        },
      });
      return actionResult((await requireAction(action.id)), 0, false);
    },

    async restore(input) {
      let action = await requireAction(input.actionId);
      const actionRows = await repository.listActionEntities(action.id);
      if (action.status === 'completed') {
        return actionResult(action, actionRows.length, true);
      }
      await validateToken(action, input.previewToken);
      if (action.kind === 'conversation_fork') {
        throw new AgentUserCheckpointError(
          'CHECKPOINT_ACTION_CONFLICT',
          'This preview does not authorize a manuscript restore.',
        );
      }
      const checkpoint = await requireCheckpoint(action.checkpointId, action.projectId);
      const checkpointEntities = await repository.listCheckpointEntities(checkpoint.id);
      const checkpointByKey = new Map(
        checkpointEntities.map((entity) => [
          `${entity.entityKind}:${entity.entityId}`,
          entity,
        ]),
      );
      if (actionRows.some((row) => row.expectedCurrentStateHash === 'missing')) {
        throw new AgentUserCheckpointError(
          'CHECKPOINT_ENTITY_MISSING',
          'At least one checkpoint entity was deleted. The restore was not started.',
        );
      }
      const changed = actionRows.some(
        (row) =>
          row.expectedCurrentContentHash !== row.checkpointContentHash ||
          row.expectedCurrentMetadataHash !== row.checkpointMetadataHash,
      );
      if (changed && !input.overwriteConfirmed) {
        throw new AgentUserCheckpointError(
          'CHECKPOINT_OVERWRITE_CONFIRMATION_REQUIRED',
          'The manuscript changed after this checkpoint. Confirm the preview before replacing those changes.',
        );
      }
      for (const row of actionRows) {
        const current = await workspace.readEntityState(
          action.projectId,
          row.entityKind,
          row.entityId,
        );
        if (
          !current ||
          current.stateHash !== row.expectedCurrentStateHash ||
          current.metadataHash !== row.expectedCurrentMetadataHash
        ) {
          throw new AgentUserCheckpointError(
            'CHECKPOINT_PREVIEW_STALE',
            `“${checkpointByKey.get(`${row.entityKind}:${row.entityId}`)?.displayName ?? row.entityId}” changed after preview. Create a new preview.`,
          );
        }
      }
      const started = await repository.transitionAction({
        id: action.id,
        from: 'previewed',
        to: 'applying',
        now: now().toISOString(),
        overwriteConfirmed: input.overwriteConfirmed,
      });
      if (!started) {
        action = await requireAction(action.id);
        if (action.status === 'completed') return actionResult(action, actionRows.length, true);
        throw new AgentUserCheckpointError(
          'CHECKPOINT_ACTION_CONFLICT',
          'The checkpoint action is already running or has been settled.',
        );
      }

      try {
        for (const row of actionRows) {
          const target = checkpointByKey.get(`${row.entityKind}:${row.entityId}`);
          if (!target) throw new Error('Checkpoint entity payload is missing.');
          const before = await workspace.readEntityState(
            action.projectId,
            row.entityKind,
            row.entityId,
          );
          if (
            !before ||
            before.stateHash !== row.expectedCurrentStateHash ||
            before.metadataHash !== row.expectedCurrentMetadataHash
          ) {
            throw new AgentUserCheckpointError(
              'CHECKPOINT_PREVIEW_STALE',
              `“${target.displayName}” changed while the restore was starting.`,
            );
          }
          await repository.recordActionEntityBefore({
            actionId: action.id,
            entityKind: row.entityKind,
            entityId: row.entityId,
            beforeRevision: before.yjsRevision,
            beforeStateVector: before.stateVector,
            beforeStateBlob: before.stateBlob,
            beforeContentHash: before.contentHash,
            beforeMetadataJson: before.metadataJson,
            now: now().toISOString(),
          });
          await workspace.restoreEntityState({
            projectId: target.projectId,
            entityKind: target.entityKind,
            entityId: target.entityId,
            displayName: target.displayName,
            documentId: target.documentId,
            yjsRevision: target.yjsRevision,
            stateVector: target.stateVector,
            stateHash: target.stateHash,
            contentHash: target.contentHash,
            stateBlob: target.stateBlob,
            metadataJson: target.metadataJson,
            metadataHash: target.metadataHash,
          });
          const restored = await workspace.readEntityState(
            action.projectId,
            row.entityKind,
            row.entityId,
          );
          if (
            !restored ||
            restored.contentHash !== target.contentHash ||
            restored.metadataHash !== target.metadataHash
          ) {
            throw new Error(`“${target.displayName}” did not match the checkpoint after restore.`);
          }
          await repository.settleActionEntity({
            actionId: action.id,
            entityKind: row.entityKind,
            entityId: row.entityId,
            status: 'applied',
            resultStateHash: restored.stateHash,
            now: now().toISOString(),
          });
        }
        // Detect an author edit interleaved with a multi-entity restore before
        // publishing success. The compensation path only touches entities that
        // still equal our checkpoint result.
        for (const target of checkpointEntities) {
          const current = await workspace.readEntityState(
            action.projectId,
            target.entityKind,
            target.entityId,
          );
          if (
            !current ||
            current.contentHash !== target.contentHash ||
            current.metadataHash !== target.metadataHash
          ) {
            throw new AgentUserCheckpointError(
              'CHECKPOINT_PREVIEW_STALE',
              `“${target.displayName}” changed during the restore.`,
            );
          }
        }
        if (action.kind === 'restore_and_fork') {
          const conversationId = createId();
          await repository.completeConversationFork({
            actionId: action.id,
            checkpointId: checkpoint.id,
            conversation: {
              id: conversationId,
              projectId: checkpoint.projectId,
              parentConversationId: checkpoint.conversationId,
              title: input.forkTitle?.trim() || `${checkpoint.label || '检查点'} · 恢复分叉`,
              mode: input.mode ?? 'byok',
              messages: checkpoint.conversationMessages,
              createdAt: now().toISOString(),
            },
          });
        } else {
          const completed = await repository.transitionAction({
            id: action.id,
            from: 'applying',
            to: 'completed',
            now: now().toISOString(),
            completedAt: now().toISOString(),
          });
          if (!completed) throw new Error('Checkpoint action lost its applying lease.');
        }
        return actionResult(
          await requireAction(action.id),
          checkpointEntities.length,
          false,
        );
      } catch (cause) {
        await compensate(action, cause);
        if (cause instanceof AgentUserCheckpointError) throw cause;
        throw new AgentUserCheckpointError(
          'CHECKPOINT_RESTORE_FAILED',
          'The checkpoint restore failed and its applied entities were compensated.',
          cause,
        );
      }
    },

    async recoverIncomplete(projectId) {
      for (const action of await repository.listRecoverableActions(projectId)) {
        await compensate(
          action,
          new AgentUserCheckpointError(
            'CHECKPOINT_RESTORE_FAILED',
            'The renderer stopped during checkpoint restore; recovery compensated it.',
          ),
        );
      }
    },

    setPinned(id, pinned) {
      return repository.setPinned(id, pinned);
    },

    remove(id) {
      return repository.softDelete(id, now().toISOString());
    },
  };

  return service;
}

let productService: AgentUserCheckpointService | null = null;

export function getAgentUserCheckpointService(): AgentUserCheckpointService {
  productService ??= createAgentUserCheckpointService();
  return productService;
}

export const __agentUserCheckpointServiceTest = {
  deterministicPreviewToken,
  sha256Text,
};
