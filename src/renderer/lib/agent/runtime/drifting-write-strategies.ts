import { and, eq, isNull } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import type {
  PersistedAgentRuntimeWriteExpectation,
} from '../../../domain/agent-runtime-freshness';
import type {
  AgentRuntimeFreshnessRepository,
} from '../../../sqlite-repo/agent-runtime-freshness-repo';
import type {
  PersistedAgentRuntimeWriteEffect,
  AgentRuntimeWriteReversibility,
} from '../../../domain/agent-runtime-write-effect';
import type { DbTransaction } from '../../../lib/db';
import { getDb, type DbExecutor } from '../../../lib/db';
import { countWordsInPmJson } from '../../word-count';
import { proseDocId, type ProseEntityType } from '../../yjs-doc-id';
import { computeBlockChanges, type AgentBlockChange } from '../block-diff';
import { revertEntityBlock } from '../chapter-prose';
import { effectiveAgentEditMode } from '../agent-edit-mode';
import { resolveAgentProseReviewMode } from '../agent-prose-review-policy';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  StorylineTable,
} from '../../../schema/drizzle';
import {
  notifySyncMutationCommitted,
  persistSyncMutationInTransaction,
} from '../../../services/entity-sync.service';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { useDataStore } from '../../../store/data-store';
import { useAgentEditStore } from '../../../store/agent-edit-store';
import type {
  AgentToolContext,
} from '../tool-handlers';
import { runAgentTool } from '../tool-handlers';
import { throwIfAgentAborted } from './errors';
import type {
  AgentToolExecutionRequest,
} from './types';
import {
  createYjsProseSeedState,
  deserializePreparedYjsProseCommand,
  hashProseMirrorContentJson,
  snapshotYjsProseBlocks,
  toPortablePreparedYjsProseCommand,
  type PortablePreparedYjsProseCommand,
  type PreparedYjsProseCommand,
  type YjsProseBlock,
  type YjsProseOperation,
  type YjsProseProjectionPayload,
} from './yjs-prose-command';
import {
  createYjsProsePersistenceCoordinator,
  type PreparedYjsProsePersistenceCommand,
  type YjsProseCommitResult,
  type YjsProseCommandReceipt,
  type YjsProsePersistenceCoordinator,
} from './yjs-prose-persistence-coordinator';
import { createDriftingElementPatchWriteStrategy } from './drifting-element-patch-write-strategy';
import type {
  AgentRuntimeElementPatchReceiptRepository,
} from '../../../sqlite-repo/agent-runtime-element-patch-receipt-repo';
import { createDriftingEntityWriteStrategy } from './drifting-entity-write-strategy';
import {
  createDriftingStructuralWriteStrategy,
  DRIFTING_STRUCTURAL_WRITE_TOOLS,
  type DriftingStructuralWriteTool,
} from './drifting-structural-write-strategy';
import {
  DRIFTING_WORKSPACE_DELETE_TOOL,
  DRIFTING_WORKSPACE_EDIT_TOOL,
  DRIFTING_WORKSPACE_WRITE_TOOL,
  workspaceCommandFromArguments,
} from './drifting-workspace-tool-runtime';
import {
  parseWorkspaceTextReplacements,
  planWorkspaceProseFileEdit,
  planWorkspaceProseFileWrite,
} from './workspace-prose-file';
import {
  createDriftingDomainCrudWriteStrategy,
  DRIFTING_DOMAIN_CRUD_WRITE_TOOLS,
  type DriftingDomainCrudWriteTool,
} from './drifting-domain-crud-write-strategy';

export interface PreparedDriftingWriteEffect {
  observedRevision: unknown;
  preimage: unknown;
  forward: unknown;
  inverse: unknown | null;
  reversibility: AgentRuntimeWriteReversibility;
  /** Ephemeral prepared capability; never copied into the durable effect row. */
  execution?: unknown;
}

export interface DriftingWriteStrategy {
  prepare(
    request: AgentToolExecutionRequest,
    context: AgentToolContext,
    expectation?: PersistedAgentRuntimeWriteExpectation | null,
  ): Promise<PreparedDriftingWriteEffect>;
  applyForward?(
    request: AgentToolExecutionRequest,
    context: AgentToolContext,
    prepared: PreparedDriftingWriteEffect,
  ): Promise<unknown>;
  captureEffect(
    request: AgentToolExecutionRequest,
    context: AgentToolContext,
    result: unknown,
    prepared: PreparedDriftingWriteEffect,
  ): Promise<unknown>;
  /**
   * Inspect a durable domain receipt after the outer write-effect journal lost
   * the response. Returning null means the mutation is still genuinely
   * uncertain; returning a value proves it can advance without re-execution.
   */
  reconcileEnteredEffect?(
    effect: PersistedAgentRuntimeWriteEffect,
    context: AgentToolContext,
    signal: AbortSignal,
  ): Promise<{ handlerResult: unknown; committedEffect: unknown } | null>;
  /**
   * Rebuild the editor-only review/reveal projection after the canonical review
   * row and result receipt exist. It must never mutate domain state.
   */
  projectReview?(
    effect: PersistedAgentRuntimeWriteEffect,
    context: AgentToolContext,
    blockDecisions?: Readonly<Record<string, 'accepted' | 'reverted'>>,
  ): Promise<void> | void;
  /** Immutable paragraph identities represented by this review batch. */
  reviewBlocks?(
    effect: PersistedAgentRuntimeWriteEffect,
    context: AgentToolContext,
  ): Promise<readonly { blockId: string; ordinal: number }[]>;
  /**
   * Apply one guarded paragraph inverse. This operation must be idempotent so a
   * durable `revert_started` row can resume after renderer interruption.
   */
  applyReviewBlockInverse?(
    effect: PersistedAgentRuntimeWriteEffect,
    blockId: string,
    context: AgentToolContext,
    signal: AbortSignal,
  ): Promise<unknown>;
  applyInverse(
    effect: PersistedAgentRuntimeWriteEffect,
    context: AgentToolContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const nodeFieldStrategies = new Map<string, 'title' | 'summary'>([
  ['rename_node', 'title'],
  ['set_node_summary', 'summary'],
]);

const proseWriteTools = new Set([
  'edit_prose_file',
  'edit_block',
  'edit_blocks',
  'append_paragraph',
  'insert_blocks',
  'remove_blocks',
  'replace_block_range',
]);

const entityWriteTools = new Set([
  'create_comment',
  'update_element',
  'update_storyline',
  'update_project_facts',
] as const);

const structuralWriteTools = new Set<string>(DRIFTING_STRUCTURAL_WRITE_TOOLS);
const domainCrudWriteTools = new Set<string>(DRIFTING_DOMAIN_CRUD_WRITE_TOOLS);

export interface DriftingWriteStrategyOptions {
  freshness?: AgentRuntimeFreshnessRepository | null;
  elementPatchDb?: DbExecutor;
  elementPatchReceipts?: AgentRuntimeElementPatchReceiptRepository;
  elementPatchPersistSyncMutation?: typeof persistSyncMutationInTransaction;
  elementPatchNotifySyncCommitted?: typeof notifySyncMutationCommitted;
  now?: () => string;
  proseCoordinator?: YjsProsePersistenceCoordinator;
  readNodeContent?: (nodeId: string) => Promise<string | null>;
  dispatch?: (
    name: string,
    arguments_: Record<string, unknown>,
    context: AgentToolContext,
  ) => Promise<unknown>;
}

/**
 * Return only independently certified write strategies. P3 installed the two
 * guarded node-field writes; P5 adds the six chapter-prose commands whose
 * forward/inverse path is owned by the Yjs persistence coordinator.
 */
export function getDriftingWriteStrategy(
  toolName: string,
  options: DriftingWriteStrategyOptions = {},
): DriftingWriteStrategy | undefined {
  if (
    toolName === DRIFTING_WORKSPACE_EDIT_TOOL ||
    toolName === DRIFTING_WORKSPACE_WRITE_TOOL ||
    toolName === DRIFTING_WORKSPACE_DELETE_TOOL
  ) {
    return workspaceEditStrategy(options);
  }
  if (structuralWriteTools.has(toolName) && options.freshness) {
    return createDriftingStructuralWriteStrategy(
      toolName as DriftingStructuralWriteTool,
      {
        freshness: options.freshness,
        ...(options.elementPatchDb ? { db: options.elementPatchDb } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.elementPatchPersistSyncMutation
          ? { persistSyncMutation: options.elementPatchPersistSyncMutation }
          : {}),
        ...(options.elementPatchNotifySyncCommitted
          ? { notifySyncCommitted: options.elementPatchNotifySyncCommitted }
          : {}),
      },
    );
  }
  if (domainCrudWriteTools.has(toolName) && options.freshness) {
    return createDriftingDomainCrudWriteStrategy(
      toolName as DriftingDomainCrudWriteTool,
      {
        freshness: options.freshness,
        db: options.elementPatchDb ?? getDb(),
        ...(options.now ? { now: options.now } : {}),
        ...(options.elementPatchPersistSyncMutation
          ? { persistSyncMutation: options.elementPatchPersistSyncMutation }
          : {}),
        ...(options.elementPatchNotifySyncCommitted
          ? { notifySyncCommitted: options.elementPatchNotifySyncCommitted }
          : {}),
      },
    );
  }
  const field = nodeFieldStrategies.get(toolName);
  if (field) return nodeFieldStrategy(field);
  if (
    (toolName === 'create_element_patch' ||
      toolName === 'update_element_patch' ||
      toolName === 'delete_element_patch') &&
    options.freshness
  ) {
    return createDriftingElementPatchWriteStrategy(toolName, {
      freshness: options.freshness,
      ...(options.elementPatchDb ? { db: options.elementPatchDb } : {}),
      ...(options.elementPatchReceipts
        ? { receipts: options.elementPatchReceipts }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.elementPatchPersistSyncMutation
        ? {
            persistSyncMutation:
              options.elementPatchPersistSyncMutation,
          }
        : {}),
      ...(options.elementPatchNotifySyncCommitted
        ? {
            notifySyncCommitted:
              options.elementPatchNotifySyncCommitted,
          }
        : {}),
    });
  }
  if (
    entityWriteTools.has(
      toolName as
        | 'create_comment'
        | 'update_element'
        | 'update_storyline'
        | 'update_project_facts',
    ) &&
    options.freshness
  ) {
    return createDriftingEntityWriteStrategy(
      toolName as
        | 'create_comment'
        | 'update_element'
        | 'update_storyline'
        | 'update_project_facts',
      {
        freshness: options.freshness,
        ...(options.elementPatchDb ? { db: options.elementPatchDb } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.elementPatchPersistSyncMutation
          ? {
              persistSyncMutation:
                options.elementPatchPersistSyncMutation,
            }
          : {}),
        ...(options.elementPatchNotifySyncCommitted
          ? {
              notifySyncCommitted:
                options.elementPatchNotifySyncCommitted,
            }
          : {}),
      },
    );
  }
  if (!proseWriteTools.has(toolName)) return undefined;
  return proseWriteStrategy(
    toolName,
    options.proseCoordinator ?? createYjsProsePersistenceCoordinator(),
    options.readNodeContent ??
      (async (nodeId) =>
        (await createBookContentRepository().findByNodeId(nodeId))
          ?.contentJson ?? null),
  );
}

/**
 * Keep the virtual file operation as the durable outer effect while delegating
 * its mutation, receipt reconciliation, and inverse to the already-certified
 * domain strategy selected during runtime-owned path preparation.
 */
function workspaceEditStrategy(
  options: DriftingWriteStrategyOptions,
): DriftingWriteStrategy {
  const resolve = (arguments_: unknown) => {
    const command = workspaceCommandFromArguments(arguments_);
    if (!command) {
      throw new Error('The workspace write has no runtime-prepared command');
    }
    const strategy = getDriftingWriteStrategy(command.name, options);
    if (!strategy) {
      throw new Error(`The workspace command "${command.name}" is not certified`);
    }
    return { command, strategy };
  };
  const innerRequest = (
    request: AgentToolExecutionRequest,
    command: ReturnType<typeof workspaceCommandFromArguments> & {},
  ): AgentToolExecutionRequest => ({
    ...request,
    name: command.name,
    arguments: command.arguments,
  });
  const innerEffect = (
    effect: PersistedAgentRuntimeWriteEffect,
    command: ReturnType<typeof workspaceCommandFromArguments> & {},
  ): PersistedAgentRuntimeWriteEffect => ({
    ...effect,
    toolName: command.name,
    arguments: command.arguments,
  });

  return {
    async prepare(request, context, expectation) {
      const { command, strategy } = resolve(request.arguments);
      return strategy.prepare(innerRequest(request, command), context, expectation);
    },

    async applyForward(request, context, prepared) {
      const { command, strategy } = resolve(request.arguments);
      const inner = innerRequest(request, command);
      return strategy.applyForward
        ? strategy.applyForward(inner, context, prepared)
        : (options.dispatch ?? runAgentTool)(command.name, command.arguments, context);
    },

    async captureEffect(request, context, result, prepared) {
      const { command, strategy } = resolve(request.arguments);
      return strategy.captureEffect(
        innerRequest(request, command),
        context,
        result,
        prepared,
      );
    },

    async reconcileEnteredEffect(effect, context, signal) {
      const { command, strategy } = resolve(effect.arguments);
      if (!strategy.reconcileEnteredEffect) return null;
      return strategy.reconcileEnteredEffect(
        innerEffect(effect, command),
        context,
        signal,
      );
    },

    async projectReview(effect, context, blockDecisions) {
      const { command, strategy } = resolve(effect.arguments);
      await strategy.projectReview?.(
        innerEffect(effect, command),
        context,
        blockDecisions,
      );
    },

    async reviewBlocks(effect, context) {
      const { command, strategy } = resolve(effect.arguments);
      return strategy.reviewBlocks
        ? strategy.reviewBlocks(innerEffect(effect, command), context)
        : [];
    },

    async applyReviewBlockInverse(effect, blockId, context, signal) {
      const { command, strategy } = resolve(effect.arguments);
      if (!strategy.applyReviewBlockInverse) {
        throw new Error(
          `Tool "${command.name}" has no block-review inverse`,
        );
      }
      return strategy.applyReviewBlockInverse(
        innerEffect(effect, command),
        blockId,
        context,
        signal,
      );
    },

    async applyInverse(effect, context, signal) {
      const { command, strategy } = resolve(effect.arguments);
      return strategy.applyInverse(
        innerEffect(effect, command),
        context,
        signal,
      );
    },
  };
}

function nodeFieldStrategy(field: 'title' | 'summary'): DriftingWriteStrategy {
  return {
    async prepare(request) {
      throwIfAgentAborted(request.signal);
      const node = resolveProjectNode(request);
      const next = requiredString(
        request.arguments[field === 'title' ? 'title' : 'summary'],
        `${request.name} requires ${field}`,
        field === 'summary',
      );
      const previous = node[field];
      return {
        observedRevision: nodeRevision(node),
        preimage: {
          kind: 'node_field',
          nodeId: node.id,
          field,
          value: previous,
        },
        forward: {
          kind: 'node_field',
          nodeId: node.id,
          field,
          value: next,
        },
        inverse: {
          kind: 'node_field',
          nodeId: node.id,
          field,
          value: previous,
        },
        reversibility: 'exact',
      };
    },

    async captureEffect(request, _context, result, prepared) {
      const target = parseNodeFieldPayload(prepared.forward, field);
      const node = useDataStore
        .getState()
        .bookNodes.find(
          (candidate) =>
            candidate.id === target.nodeId &&
            candidate.projectId === request.context.route.projectId,
        );
      if (!node) throw new Error('The written node disappeared before receipt');
      return {
        kind: 'node_field',
        nodeId: node.id,
        field,
        value: node[field],
        revision: nodeRevision(node),
        handlerResult: result,
      };
    },

    async applyInverse(effect, context, signal) {
      throwIfAgentAborted(signal);
      const inverse = parseNodeFieldPayload(effect.inverse, field);
      const forward = parseNodeFieldPayload(effect.effect, field);
      const current = useDataStore
        .getState()
        .bookNodes.find(
          (node) =>
            node.id === inverse.nodeId &&
            node.projectId === effect.projectId,
        );
      if (!current) {
        throw new Error('The node for this Agent review no longer exists');
      }
      // A process can die after the exact inverse usecase commits but before
      // the review row advances from revert_started to reverted. Re-entering
      // review settlement must recognize that durable postimage instead of
      // applying the inverse twice or misclassifying a successful revert as a
      // conflict.
      if (current[field] === inverse.value) {
        return {
          kind: 'node_field_revert',
          nodeId: inverse.nodeId,
          field,
          value: inverse.value,
          revision: nodeRevision(current),
          reconciled: true,
        };
      }
      // Reject must not erase a newer manual edit. Exact inversion is available
      // only while the field still equals the effect this review represents.
      if (current[field] !== forward.value) {
        throw new Error(
          `The node ${field} changed after the Agent write; exact revert is unavailable`,
        );
      }
      const guard = { expectedRevision: current.updatedAt };
      if (field === 'title') {
        await context.write.renameNode(inverse.nodeId, inverse.value, guard);
      } else {
        await context.write.updateNode(
          inverse.nodeId,
          { summary: inverse.value },
          guard,
        );
      }
      throwIfAgentAborted(signal);
      const reverted = useDataStore
        .getState()
        .bookNodes.find((node) => node.id === inverse.nodeId);
      if (!reverted || reverted[field] !== inverse.value) {
        throw new Error(`The node ${field} inverse did not settle exactly`);
      }
      return {
        kind: 'node_field_revert',
        nodeId: inverse.nodeId,
        field,
        value: inverse.value,
        revision: nodeRevision(reverted),
      };
    },
  };
}

interface ProseExecution {
  command: PreparedYjsProsePersistenceCommand;
  nodeId: string;
  /** Omitted for legacy/node commands so existing durable payloads stay valid. */
  entityType?: ProseEntityType;
  projectId: string;
  beforeContentJson: string;
}

interface PersistedProseCommandPayload {
  kind: 'yjs_prose';
  nodeId: string;
  /** Omitted means the legacy `node` body. */
  entityType?: ProseEntityType;
  docId: string;
  command: PortablePreparedYjsProseCommand;
  /**
   * A durable UI-review baseline only. It is never a prose write source and
   * must validate against the command's canonical Yjs base hash before use.
   */
  reviewSnapshot: PersistedProseReviewSnapshot;
}

interface PersistedProseReviewSnapshot {
  format: 'drifting.prose-review-snapshot';
  schemaVersion: 1 | 2;
  effectId: string;
  reviewId: string;
  baseContentJson: string;
  baseStateHash: string;
  /** Present on v2. Hashes the exact semantic PM review baseline. */
  baseContentHash?: string;
  mode: 'auto' | 'approve';
}

interface ProseHandlerResult {
  ok: true;
  nodeId: string;
  affectedBlockIds: readonly string[];
  stateHash: string;
  revision: string;
  outcome: YjsProseCommitResult['outcome'];
}

function proseWriteStrategy(
  toolName: string,
  coordinator: YjsProsePersistenceCoordinator,
  readNodeContent: (nodeId: string) => Promise<string | null>,
): DriftingWriteStrategy {
  return {
    async prepare(request, _context, expectation) {
      throwIfAgentAborted(request.signal);
      const entity = resolveProjectProseEntity(request);
      const proseExpectation = requireProseExpectation(
        expectation,
        request,
        entity.id,
        entity.entityType,
      );
      const contentJson =
        entity.entityType === 'node'
          ? await readNodeContent(entity.id)
          : readProjectedProseContent(entity.entityType, entity.id);
      if (contentJson === null) {
        throw new Error(`${entity.entityType} content for ${entity.id} was not found`);
      }
      const seedStateUpdate = await createYjsProseSeedState(
        contentJson,
      );
      const docId = proseDocId(entity.entityType, entity.id);
      const base = await coordinator.readBase(docId, seedStateUpdate);
      assertProseBaseMatchesExpectation(base, proseExpectation);
      const baseBlocks = blocksFromState(base.stateUpdate);
      const beforeContentJson = contentJsonFromState(base.stateUpdate);
      const operation = await proseOperation(
        toolName,
        request,
        baseBlocks,
      );
      const command = await coordinator.prepare({
        docId,
        commandId: proseCommandId(request.idempotencyKey),
        expectedBase: {
          revision: base.revision,
          stateVector: proseExpectation.expectedStateVector,
          stateHash: proseExpectation.expectedStateHash,
        },
        operation,
        ...(base.sourceKind === 'seed' ? { seedStateUpdate } : {}),
      });
      const reviewMode = resolveAgentProseReviewMode(
        effectiveAgentEditMode(),
        beforeContentJson,
        command.prepared.projection.contentJson,
      );
      const reviewSnapshot = await proseReviewSnapshot(
        request.idempotencyKey,
        beforeContentJson,
        base.stateHash,
        reviewMode,
      );
      const payload: PersistedProseCommandPayload = {
        kind: 'yjs_prose',
        nodeId: entity.id,
        ...(entity.entityType === 'node' ? {} : { entityType: entity.entityType }),
        docId,
        command: toPortablePreparedYjsProseCommand(command.prepared),
        reviewSnapshot,
      };
      return {
        observedRevision: {
          kind: 'yjs_prose_revision',
          nodeId: entity.id,
          docId,
          revision: proseRevision(base.revision),
          stateHash: base.stateHash,
        },
        preimage: {
          kind: 'yjs_prose_state',
          nodeId: entity.id,
          docId,
          revision: proseRevision(base.revision),
          stateHash: base.stateHash,
          blockIds: baseBlocks.map((block) => block.id),
        },
        forward: payload,
        inverse: payload,
        reversibility: 'exact',
        execution: {
          command,
          nodeId: entity.id,
          ...(entity.entityType === 'node' ? {} : { entityType: entity.entityType }),
          projectId: entity.projectId,
          beforeContentJson,
        } satisfies ProseExecution,
      };
    },

    async applyForward(request, _context, prepared) {
      throwIfAgentAborted(request.signal);
      const execution = parseProseExecution(prepared.execution);
      const result = await commitProseCommand(
        coordinator,
        execution,
        'forward',
        execution.command.base.revision,
      );
      throwIfAgentAborted(request.signal);
      return proseHandlerResult(execution.nodeId, result);
    },

    async captureEffect(_request, _context, result, prepared) {
      const payload = parseProsePayload(prepared.forward);
      const verified = await deserializePreparedYjsProseCommand(
        payload.command,
      );
      await assertProseReviewSnapshot(payload.reviewSnapshot, verified);
      const handler = parseProseHandlerResult(result);
      if (
        handler.nodeId !== payload.nodeId ||
        handler.stateHash !== verified.projection.stateHash
      ) {
        throw new Error('The committed prose receipt does not match its command');
      }
      const receipt = await coordinator.getReceipt(
        payload.command.commandId,
        'forward',
      );
      if (
        !receipt ||
        receipt.docId !== payload.docId ||
        receipt.resultStateHash !== handler.stateHash ||
        proseRevision(receipt.committedRevision) !== handler.revision
      ) {
        throw new Error('The written prose command has no exact durable receipt');
      }
      return {
        kind: 'yjs_prose',
        nodeId: payload.nodeId,
        docId: payload.docId,
        commandId: payload.command.commandId,
        affectedBlockIds: [...payload.command.affectedBlockIds],
        stateHash: receipt.resultStateHash,
        revision: proseRevision(receipt.committedRevision),
        handlerResult: result,
      };
    },

    async reconcileEnteredEffect(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parseProsePayload(effect.forward);
      assertPersistedProseProvenance(effect, payload);
      const prepared = await deserializePreparedYjsProseCommand(
        payload.command,
      );
      const receipt = await coordinator.getReceipt(
        prepared.commandId,
        'forward',
      );
      if (!receipt) return null;
      assertForwardReceiptMatches(payload, prepared, receipt);
      await assertProseReviewSnapshot(
        payload.reviewSnapshot,
        prepared,
      );
      const handlerResult: ProseHandlerResult = {
        ok: true,
        nodeId: payload.nodeId,
        affectedBlockIds: [...prepared.affectedBlockIds],
        stateHash: receipt.resultStateHash,
        revision: proseRevision(receipt.committedRevision),
        outcome: 'reconciled',
      };
      return {
        handlerResult,
        committedEffect: {
          kind: 'yjs_prose',
          nodeId: payload.nodeId,
          docId: payload.docId,
          commandId: prepared.commandId,
          affectedBlockIds: [...prepared.affectedBlockIds],
          stateHash: receipt.resultStateHash,
          revision: proseRevision(receipt.committedRevision),
          handlerResult,
          reconciled: true,
        },
      };
    },

    async projectReview(effect, _context, blockDecisions) {
      const { payload, changes } =
        await verifiedProseReviewChanges(effect);
      recordVisibleProseReview(
        prosePayloadEntityType(payload),
        payload.nodeId,
        changes,
        payload.reviewSnapshot,
        blockDecisions,
      );
    },

    async reviewBlocks(effect) {
      const { changes } = await verifiedProseReviewChanges(effect);
      return changes.map((change, ordinal) => ({
        blockId: change.blockId,
        ordinal,
      }));
    },

    async applyReviewBlockInverse(effect, blockId, context, signal) {
      throwIfAgentAborted(signal);
      const { payload, changes } = await verifiedProseReviewChanges(effect);
      const change = changes.find((candidate) => candidate.blockId === blockId);
      if (!change) {
        throw new Error(
          `The durable prose review has no block "${blockId}"`,
        );
      }
      await revertEntityBlock(
        prosePayloadEntityType(payload),
        payload.nodeId,
        change,
        context,
      );
      throwIfAgentAborted(signal);
      return {
        kind: 'yjs_prose_block_revert',
        reviewId: payload.reviewSnapshot.reviewId,
        blockId,
      };
    },

    async applyInverse(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parseProsePayload(effect.inverse);
      assertPersistedProseProvenance(effect, payload);
      if (
        payload.nodeId !==
          resolveEffectProjectProseEntity(
            effect,
            prosePayloadEntityType(payload),
            payload.nodeId,
          ).id ||
        payload.docId !== proseDocId(prosePayloadEntityType(payload), payload.nodeId)
      ) {
        throw new Error('The persisted prose inverse targets the wrong node');
      }
      const prepared = await deserializePreparedYjsProseCommand(
        payload.command,
      );
      await assertProseReviewSnapshot(payload.reviewSnapshot, prepared);
      const forwardReceipt = await coordinator.getReceipt(
        prepared.commandId,
        'forward',
      );
      if (!forwardReceipt || forwardReceipt.docId !== payload.docId) {
        throw new Error('The prose forward receipt is missing');
      }
      const command = restorePersistenceCommand(payload, prepared);
      const result = await commitProseCommand(
        coordinator,
        {
          command,
          nodeId: payload.nodeId,
          ...(prosePayloadEntityType(payload) === 'node'
            ? {}
            : { entityType: prosePayloadEntityType(payload) }),
          projectId: effect.projectId,
          beforeContentJson: prepared.projection.contentJson,
        },
        'inverse',
        forwardReceipt.committedRevision,
      );
      throwIfAgentAborted(signal);
      const rebased =
        result.receipt.baseRevision > forwardReceipt.committedRevision;
      if (
        !rebased &&
        result.receipt.resultStateHash !==
        prepared.durableWatermark.baseStateHash
      ) {
        throw new Error('The prose inverse did not restore the exact base hash');
      }
      return {
        kind: 'yjs_prose_revert',
        nodeId: payload.nodeId,
        docId: payload.docId,
        commandId: prepared.commandId,
        stateHash: result.receipt.resultStateHash,
        revision: proseRevision(result.receipt.committedRevision),
        rebased,
        reconciled: result.outcome !== 'committed',
      };
    },
  };
}

function requireProseExpectation(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  request: AgentToolExecutionRequest,
  entityId: string,
  entityType: ProseEntityType,
): PersistedAgentRuntimeWriteExpectation & {
  expectedStateVector: Uint8Array;
  expectedStateHash: string;
} {
  if (
    !expectation ||
    expectation.entityKind !== `${entityType}_prose` ||
    expectation.entityId !== entityId ||
    expectation.expectedRevision !==
      (request.arguments.expectedRevision as { revision?: unknown } | undefined)
        ?.revision ||
    !expectation.expectedStateVector ||
    !expectation.expectedStateHash ||
    parseProseRevision(expectation.expectedRevision) === null
  ) {
    throw new Error(
      `${request.name} requires Yjs freshness copied from read_node(prose=true)`,
    );
  }
  return expectation as PersistedAgentRuntimeWriteExpectation & {
    expectedStateVector: Uint8Array;
    expectedStateHash: string;
  };
}

function assertProseBaseMatchesExpectation(
  base: {
    revision: number;
    stateVector: Uint8Array;
    stateHash: string;
  },
  expectation: PersistedAgentRuntimeWriteExpectation & {
    expectedStateVector: Uint8Array;
    expectedStateHash: string;
  },
): void {
  if (
    parseProseRevision(expectation.expectedRevision) !== base.revision ||
    !bytesEqual(expectation.expectedStateVector, base.stateVector) ||
    expectation.expectedStateHash !== base.stateHash
  ) {
    const error = new Error(
      'The entity prose changed after read_node; read it again before writing',
    ) as Error & { code: string };
    error.code = 'STALE_REVISION';
    throw error;
  }
}

function blocksFromState(stateUpdate: Uint8Array): YjsProseBlock[] {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, stateUpdate, 'agent-runtime:prose-strategy-read');
    return snapshotYjsProseBlocks(doc);
  } finally {
    doc.destroy();
  }
}

function contentJsonFromState(stateUpdate: Uint8Array): string {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, stateUpdate, 'agent-runtime:prose-strategy-projection');
    return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
  } finally {
    doc.destroy();
  }
}

function recordVisibleProseReview(
  entityType: ProseEntityType,
  entityId: string,
  changes: readonly AgentBlockChange[],
  provenance: Pick<
    PersistedProseReviewSnapshot,
    'effectId' | 'reviewId' | 'mode'
  >,
  blockDecisions?: Readonly<Record<string, 'accepted' | 'reverted'>>,
): void {
  const editState = useAgentEditStore.getState();
  if (editState.reviewBatches[provenance.reviewId]) return;
  if (changes.length === 0) return;
  editState.recordReview(
    entityType,
    entityId,
    [...changes],
    provenance.mode,
    provenance,
  );
  if (blockDecisions) {
    useAgentEditStore
      .getState()
      .syncReviewBlockDecisions(provenance.reviewId, blockDecisions);
  }
}

async function verifiedProseReviewChanges(
  effect: PersistedAgentRuntimeWriteEffect,
): Promise<{
  payload: PersistedProseCommandPayload;
  prepared: PreparedYjsProseCommand;
  changes: AgentBlockChange[];
}> {
  const payload = parseProsePayload(effect.forward);
  assertPersistedProseProvenance(effect, payload);
  const prepared = await deserializePreparedYjsProseCommand(payload.command);
  await assertProseReviewSnapshot(payload.reviewSnapshot, prepared);
  return {
    payload,
    prepared,
    changes: computeBlockChanges(
      payload.reviewSnapshot.baseContentJson,
      prepared.projection.contentJson,
    ),
  };
}

function assertPersistedProseProvenance(
  effect: PersistedAgentRuntimeWriteEffect,
  payload: PersistedProseCommandPayload,
): void {
  if (
    !proseWriteTools.has(effect.toolName) ||
    payload.command.commandId !== proseCommandId(effect.idempotencyKey) ||
    payload.docId !== proseDocId(prosePayloadEntityType(payload), payload.nodeId) ||
    payload.reviewSnapshot.effectId !== effect.id ||
    payload.reviewSnapshot.effectId !==
      proseWriteEffectId(effect.idempotencyKey) ||
    payload.reviewSnapshot.reviewId !==
      proseWriteReviewId(payload.reviewSnapshot.effectId)
  ) {
    throw new Error(
      'The durable prose receipt does not match the entered write provenance',
    );
  }
  resolveEffectProjectProseEntity(
    effect,
    prosePayloadEntityType(payload),
    payload.nodeId,
  );
}

async function proseReviewSnapshot(
  idempotencyKey: string,
  baseContentJson: string,
  baseStateHash: string,
  mode: 'auto' | 'approve',
): Promise<PersistedProseReviewSnapshot> {
  const effectId = proseWriteEffectId(idempotencyKey);
  return {
    format: 'drifting.prose-review-snapshot',
    schemaVersion: 2,
    effectId,
    reviewId: proseWriteReviewId(effectId),
    baseContentJson,
    baseStateHash,
    baseContentHash: await hashProseMirrorContentJson(baseContentJson),
    mode,
  };
}

async function assertProseReviewSnapshot(
  snapshot: PersistedProseReviewSnapshot,
  prepared: PreparedYjsProseCommand,
): Promise<void> {
  if (
    snapshot.baseStateHash !==
    prepared.durableWatermark.baseStateHash
  ) {
    throw new Error(
      'The persisted prose review snapshot does not match the command base hash',
    );
  }
  const baseContentHash = await hashProseMirrorContentJson(
    snapshot.baseContentJson,
  );
  if (snapshot.schemaVersion === 2) {
    if (snapshot.baseContentHash !== baseContentHash) {
      throw new Error(
        'The persisted prose review snapshot failed canonical verification',
      );
    }
    return;
  }

  // Compatibility for effects entered before projection hashes were added.
  // Validate that the legacy PM baseline survives the supported schema
  // round-trip semantically. Do not demand the same Yjs hash: mark instance
  // keys and schema default attrs are intentionally normalized by that path.
  const seedState = await createYjsProseSeedState(snapshot.baseContentJson);
  if (
    (await hashProseMirrorContentJson(contentJsonFromState(seedState))) !==
    baseContentHash
  ) {
    throw new Error(
      'The persisted prose review snapshot failed canonical verification',
    );
  }
}

function assertForwardReceiptMatches(
  payload: PersistedProseCommandPayload,
  prepared: PreparedYjsProseCommand,
  receipt: YjsProseCommandReceipt,
): void {
  if (
    receipt.commandId !== prepared.commandId ||
    receipt.docId !== payload.docId ||
    receipt.direction !== 'forward' ||
    receipt.sourceKind !== prepared.durableWatermark.sourceKind ||
    receipt.baseRevision !== prepared.durableWatermark.baseRevision ||
    receipt.baseStateHash !== prepared.durableWatermark.baseStateHash ||
    !bytesEqual(
      receipt.baseStateVector,
      prepared.durableWatermark.baseStateVector,
    ) ||
    receipt.resultStateHash !==
      prepared.durableWatermark.forwardStateHash ||
    !bytesEqual(
      receipt.resultStateVector,
      prepared.durableWatermark.forwardStateVector,
    ) ||
    receipt.updateHash !== prepared.durableWatermark.forwardUpdateHash
  ) {
    throw new Error(
      'The durable prose receipt does not match the verified command',
    );
  }
}

async function proseOperation(
  toolName: string,
  request: AgentToolExecutionRequest,
  blocks: readonly YjsProseBlock[],
): Promise<YjsProseOperation> {
  switch (toolName) {
    case 'edit_prose_file':
      return typeof request.arguments.content === 'string'
        ? planWorkspaceProseFileWrite({
            blocks,
            content: request.arguments.content,
            idempotencyKey: request.idempotencyKey,
          })
        : planWorkspaceProseFileEdit({
            blocks,
            replacements: parseWorkspaceTextReplacements(
              request.arguments.replacements,
            ),
            idempotencyKey: request.idempotencyKey,
          });
    case 'edit_block': {
      const block = resolveBlockTarget(blocks, request.arguments);
      return {
        kind: 'edit',
        blockId: block.id,
        block: blockWithText(block, stringArgument(request, 'text', true)),
      };
    }
    case 'edit_blocks': {
      const raw = request.arguments.edits;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('edit_blocks requires a non-empty edits array');
      }
      const edits = raw.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`edit_blocks.edits[${index}] must be an object`);
        }
        const arguments_ = value as Record<string, unknown>;
        const block = resolveBlockTarget(blocks, arguments_);
        return {
          blockId: block.id,
          block: blockWithText(
            block,
            requiredString(
              arguments_.text,
              `edit_blocks.edits[${index}].text must be a string`,
              true,
            ),
          ),
        };
      });
      if (new Set(edits.map((edit) => edit.blockId)).size !== edits.length) {
        throw new Error('edit_blocks cannot target the same block twice');
      }
      return { kind: 'edit_many', edits };
    }
    case 'append_paragraph':
      return {
        kind: 'append',
        blocks: [
          await newParagraph(
            request,
            0,
            stringArgument(request, 'text', false),
          ),
        ],
      };
    case 'insert_blocks': {
      const texts = stringArrayArgument(request, 'blocks', false);
      const afterBlockId = resolveOptionalBlockTarget(
        blocks,
        request.arguments.afterBlock,
        request.arguments.afterBlockId,
        'afterBlock',
      );
      return {
        kind: 'insert',
        afterBlockId,
        blocks: await Promise.all(
          texts.map((text, index) => newParagraph(request, index, text)),
        ),
      };
    }
    case 'remove_blocks': {
      const ids = Array.isArray(request.arguments.blockIds)
        ? request.arguments.blockIds.map((value) => String(value))
        : [];
      const numbers = Array.isArray(request.arguments.blockNumbers)
        ? request.arguments.blockNumbers.map((value) => Number(value))
        : [];
      const resolved = [
        ...ids.map((id) => resolveBlockTarget(blocks, { blockId: id }).id),
        ...numbers.map(
          (block) => resolveBlockTarget(blocks, { block }).id,
        ),
      ];
      if (resolved.length === 0) {
        throw new Error(
          'remove_blocks requires blockIds or blockNumbers from read_node',
        );
      }
      if (new Set(resolved).size !== resolved.length) {
        throw new Error('remove_blocks cannot target the same block twice');
      }
      return { kind: 'remove', blockIds: resolved };
    }
    case 'replace_block_range': {
      const fromBlockId = resolveRequiredRangeTarget(
        blocks,
        request.arguments.fromBlock,
        request.arguments.fromBlockId,
        'fromBlock',
      );
      const toBlockId = resolveRequiredRangeTarget(
        blocks,
        request.arguments.toBlock,
        request.arguments.toBlockId,
        'toBlock',
      );
      const texts = stringArrayArgument(request, 'blocks', true);
      return {
        kind: 'replace',
        fromBlockId,
        toBlockId,
        blocks: await Promise.all(
          texts.map((text, index) => newParagraph(request, index, text)),
        ),
      };
    }
    default:
      throw new Error(`Unsupported certified prose tool "${toolName}"`);
  }
}

function resolveBlockTarget(
  blocks: readonly YjsProseBlock[],
  arguments_: Record<string, unknown>,
): YjsProseBlock {
  const hasNumber =
    arguments_.block !== undefined &&
    arguments_.block !== null &&
    arguments_.block !== '';
  const hasId =
    typeof arguments_.blockId === 'string' &&
    arguments_.blockId.trim().length > 0;
  if (hasNumber === hasId) {
    throw new Error('Provide exactly one of block or blockId');
  }
  if (hasNumber) {
    const ordinal = Number(arguments_.block);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > blocks.length) {
      throw new Error(
        `block must be in the 1..${blocks.length} range from read_node`,
      );
    }
    return blocks[ordinal - 1];
  }
  const id = (arguments_.blockId as string).trim();
  const block = blocks.find((candidate) => candidate.id === id);
  if (!block) throw new Error(`Block "${id}" was not found in this chapter`);
  return block;
}

function resolveOptionalBlockTarget(
  blocks: readonly YjsProseBlock[],
  ordinal: unknown,
  id: unknown,
  label: string,
): string | null {
  const omittedOrdinal = ordinal === undefined || ordinal === null || ordinal === '';
  const omittedId = typeof id !== 'string' || !id.trim();
  if (omittedOrdinal && omittedId) return null;
  if (!omittedOrdinal && !omittedId) {
    throw new Error(`Provide only one of ${label} or ${label}Id`);
  }
  return resolveBlockTarget(blocks, {
    ...(omittedOrdinal ? {} : { block: ordinal }),
    ...(omittedId ? {} : { blockId: id }),
  }).id;
}

function resolveRequiredRangeTarget(
  blocks: readonly YjsProseBlock[],
  ordinal: unknown,
  id: unknown,
  label: string,
): string {
  const resolved = resolveOptionalBlockTarget(blocks, ordinal, id, label);
  if (!resolved) {
    throw new Error(`Provide exactly one of ${label} or ${label}Id`);
  }
  return resolved;
}

function blockWithText(block: YjsProseBlock, text: string): YjsProseBlock {
  if (
    block.type === 'bulletList' ||
    block.type === 'orderedList' ||
    block.type === 'listItem' ||
    block.type === 'horizontalRule'
  ) {
    throw new Error(
      `Block "${block.id}" has structural type ${block.type}; use a range replacement instead`,
    );
  }
  if (block.type === 'blockquote') {
    const contentText = stripRenderedBlockPrefix(block, text);
    const existing = block.content?.find(
      (node) => node.kind === 'element' && node.type === 'paragraph',
    );
    return {
      ...block,
      content: [
        {
          kind: 'element',
          type: 'paragraph',
          ...(existing?.kind === 'element' && existing.attrs
            ? { attrs: existing.attrs }
            : {}),
          ...(contentText
            ? { content: [{ kind: 'text', text: contentText }] }
            : {}),
        },
      ],
    };
  }
  const contentText = stripRenderedBlockPrefix(block, text);
  return {
    ...block,
    content: contentText ? [{ kind: 'text', text: contentText }] : [],
  };
}

/**
 * `read_node` uses compact Markdown-like prefixes only to expose block type.
 * They are not part of the Yjs block text. Models commonly copy the rendered
 * line back verbatim, so normalize the two editable structural types at the
 * write boundary instead of persisting `# # Heading` / `> > Quote` artifacts.
 */
function stripRenderedBlockPrefix(
  block: YjsProseBlock,
  text: string,
): string {
  if (block.type === 'heading') {
    return text.replace(/^\s{0,3}#{1,6}[\t ]+/, '');
  }
  if (block.type === 'blockquote') {
    return text.replace(/^\s{0,3}>[\t ]?/, '');
  }
  return text;
}

async function newParagraph(
  request: AgentToolExecutionRequest,
  index: number,
  text: string,
): Promise<YjsProseBlock> {
  return {
    id: await deterministicCommandBlockId(request.idempotencyKey, index),
    type: 'paragraph',
    content: text ? [{ kind: 'text', text }] : [],
  };
}

async function deterministicCommandBlockId(
  idempotencyKey: string,
  index: number,
): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        `drifting.agent-prose-block:${idempotencyKey}:${index}`,
      ) as BufferSource,
    ),
  );
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stringArgument(
  request: AgentToolExecutionRequest,
  key: string,
  allowEmpty: boolean,
): string {
  return requiredString(
    request.arguments[key],
    `${request.name} requires ${key}`,
    allowEmpty,
  );
}

function stringArrayArgument(
  request: AgentToolExecutionRequest,
  key: string,
  allowEmptyArray: boolean,
): string[] {
  const value = request.arguments[key];
  if (
    !Array.isArray(value) ||
    (!allowEmptyArray && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`${request.name} requires a valid ${key} string array`);
  }
  return [...value] as string[];
}

async function commitProseCommand(
  coordinator: YjsProsePersistenceCoordinator,
  execution: ProseExecution,
  direction: 'forward' | 'inverse',
  expectedRevision: number,
): Promise<YjsProseCommitResult> {
  const entityType = proseExecutionEntityType(execution);
  let projectedNode:
    | {
        wordCount: number;
        updatedAt: string;
      }
    | undefined;
  let projectedUpdatedAt: string | undefined;
  let outboxPersisted = false;
  const committedAt = new Date().toISOString();
  const result = await coordinator.commit({
    command: execution.command,
    direction,
    expectedRevision,
    async persistProjection(tx, projection) {
      if (entityType === 'node') {
        const content = await createBookContentRepository(tx).updateByNodeId(
          execution.nodeId,
          {
            contentJson: projection.contentJson,
            updatedAt: committedAt,
          },
        );
        if (!content) {
          throw new Error(`Node content for ${execution.nodeId} was not found`);
        }
        const wordCount = countWordsInPmJson(projection.contentJson);
        const rows = await tx
          .update(BookNodeTable)
          .set({ wordCount, updatedAt: committedAt })
          .where(
            and(
              eq(BookNodeTable.id, execution.nodeId),
              eq(BookNodeTable.projectId, execution.projectId),
              isNull(BookNodeTable.deletedAt),
            ),
          )
          .returning({
            wordCount: BookNodeTable.wordCount,
            updatedAt: BookNodeTable.updatedAt,
          });
        if (rows.length !== 1) {
          throw new Error(
            `Book node ${execution.nodeId} no longer exists in project ${execution.projectId}`,
          );
        }
        projectedNode = rows[0];
        return;
      }
      projectedUpdatedAt = await persistStructuredProseProjection(
        tx,
        entityType,
        execution.nodeId,
        execution.projectId,
        projection.contentJson,
        committedAt,
      );
    },
    async persistOutbox(tx, projection) {
      outboxPersisted =
        (await persistProseOutbox(
          tx as DbTransaction,
          execution,
          projection,
          committedAt,
        )) || outboxPersisted;
    },
  });
  if (outboxPersisted) notifySyncMutationCommitted();
  if (projectedNode) {
    useDataStore.setState((state) => ({
      bookNodes: state.bookNodes.map((node) =>
        node.id === execution.nodeId &&
        node.projectId === execution.projectId
          ? {
              ...node,
              wordCount: projectedNode!.wordCount,
              updatedAt: projectedNode!.updatedAt,
            }
          : node,
      ),
    }));
  } else if (projectedUpdatedAt) {
    if (entityType === 'node') {
      throw new Error('A node prose projection lost its node metadata result');
    }
    projectStructuredProse(
      entityType,
      execution.nodeId,
      execution.projectId,
      result.projection.contentJson,
      projectedUpdatedAt,
    );
  }
  return result;
}

async function persistProseOutbox(
  tx: DbTransaction,
  execution: ProseExecution,
  projection: YjsProseProjectionPayload,
  committedAt: string,
): Promise<boolean> {
  const entityType = proseExecutionEntityType(execution);
  const timestamp = Date.parse(committedAt);
  if (entityType !== 'node') {
    return persistSyncMutationInTransaction(tx, {
      entityType: entityType === 'category' ? 'elementCategory' : entityType,
      mutationType: 'update',
      entityId: execution.nodeId,
      projectId: execution.projectId,
      payload: { contentJson: projection.contentJson },
      timestamp,
    });
  }
  const contentPersisted = await persistSyncMutationInTransaction(tx, {
    entityType: 'nodeContent',
    mutationType: 'update',
    entityId: execution.nodeId,
    projectId: execution.projectId,
    payload: { contentJson: projection.contentJson },
    timestamp,
  });
  const nodePersisted = await persistSyncMutationInTransaction(tx, {
    entityType: 'node',
    mutationType: 'update',
    entityId: execution.nodeId,
    projectId: execution.projectId,
    payload: { wordCount: countWordsInPmJson(projection.contentJson) },
    timestamp,
  });
  return contentPersisted || nodePersisted;
}

async function persistStructuredProseProjection(
  tx: DbExecutor,
  entityType: Exclude<ProseEntityType, 'node'>,
  entityId: string,
  projectId: string,
  contentJson: string,
  updatedAt: string,
): Promise<string> {
  if (entityType === 'element') {
    const rows = await tx
      .update(BookElementTable)
      .set({ contentJson, updatedAt })
      .where(
        and(
          eq(BookElementTable.id, entityId),
          eq(BookElementTable.projectId, projectId),
          isNull(BookElementTable.deletedAt),
        ),
      )
      .returning({ updatedAt: BookElementTable.updatedAt });
    if (rows.length === 1) return rows[0]!.updatedAt;
  } else if (entityType === 'storyline') {
    const rows = await tx
      .update(StorylineTable)
      .set({ contentJson, updatedAt })
      .where(
        and(
          eq(StorylineTable.id, entityId),
          eq(StorylineTable.projectId, projectId),
          isNull(StorylineTable.deletedAt),
        ),
      )
      .returning({ updatedAt: StorylineTable.updatedAt });
    if (rows.length === 1) return rows[0]!.updatedAt;
  } else {
    const rows = await tx
      .update(ElementCategoryTable)
      .set({ contentJson, updatedAt })
      .where(
        and(
          eq(ElementCategoryTable.id, entityId),
          eq(ElementCategoryTable.projectId, projectId),
          isNull(ElementCategoryTable.deletedAt),
        ),
      )
      .returning({ updatedAt: ElementCategoryTable.updatedAt });
    if (rows.length === 1) return rows[0]!.updatedAt;
  }
  throw new Error(`${entityType} ${entityId} no longer exists in project ${projectId}`);
}

function projectStructuredProse(
  entityType: Exclude<ProseEntityType, 'node'>,
  entityId: string,
  projectId: string,
  contentJson: string,
  updatedAt: string,
): void {
  useDataStore.setState((state) => {
    if (entityType === 'element') {
      return {
        bookElements: state.bookElements.map((entity) =>
          entity.id === entityId && entity.projectId === projectId
            ? { ...entity, contentJson, updatedAt }
            : entity,
        ),
      };
    }
    if (entityType === 'storyline') {
      return {
        storylines: state.storylines.map((entity) =>
          entity.id === entityId && entity.projectId === projectId
            ? { ...entity, contentJson, updatedAt }
            : entity,
        ),
      };
    }
    return {
      bookElementCategories: state.bookElementCategories.map((entity) =>
        entity.id === entityId && entity.projectId === projectId
          ? { ...entity, contentJson, updatedAt }
          : entity,
      ),
    };
  });
}

function proseHandlerResult(
  nodeId: string,
  result: YjsProseCommitResult,
): ProseHandlerResult {
  return {
    ok: true,
    nodeId,
    affectedBlockIds: [...result.projection.affectedBlockIds],
    stateHash: result.receipt.resultStateHash,
    revision: proseRevision(result.receipt.committedRevision),
    outcome: result.outcome,
  };
}

function parseProseHandlerResult(value: unknown): ProseHandlerResult {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { ok?: unknown }).ok !== true ||
    typeof (value as { nodeId?: unknown }).nodeId !== 'string' ||
    typeof (value as { stateHash?: unknown }).stateHash !== 'string' ||
    typeof (value as { revision?: unknown }).revision !== 'string'
  ) {
    throw new Error('The prose handler result is invalid');
  }
  return value as ProseHandlerResult;
}

function parseProseExecution(value: unknown): ProseExecution {
  const entityType =
    value && typeof value === 'object'
      ? (value as { entityType?: unknown }).entityType
      : undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    !(value as { command?: unknown }).command ||
    typeof (value as { nodeId?: unknown }).nodeId !== 'string' ||
    typeof (value as { projectId?: unknown }).projectId !== 'string' ||
    typeof (value as { beforeContentJson?: unknown }).beforeContentJson !==
      'string' ||
    (entityType !== undefined && !isProseEntityTypeValue(entityType))
  ) {
    throw new Error('The prepared prose execution capability is missing');
  }
  return value as ProseExecution;
}

function parseProsePayload(value: unknown): PersistedProseCommandPayload {
  const reviewSnapshot =
    value && typeof value === 'object'
      ? (value as { reviewSnapshot?: unknown }).reviewSnapshot
      : null;
  const entityType =
    value && typeof value === 'object'
      ? (value as { entityType?: unknown }).entityType
      : undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { kind?: unknown }).kind !== 'yjs_prose' ||
    typeof (value as { nodeId?: unknown }).nodeId !== 'string' ||
    typeof (value as { docId?: unknown }).docId !== 'string' ||
    (entityType !== undefined && !isProseEntityTypeValue(entityType)) ||
    !(value as { command?: unknown }).command ||
    typeof (value as { command?: { commandId?: unknown } }).command
      ?.commandId !== 'string' ||
    !reviewSnapshot ||
    typeof reviewSnapshot !== 'object' ||
    Array.isArray(reviewSnapshot) ||
    (reviewSnapshot as { format?: unknown }).format !==
      'drifting.prose-review-snapshot' ||
    ((reviewSnapshot as { schemaVersion?: unknown }).schemaVersion !== 1 &&
      (reviewSnapshot as { schemaVersion?: unknown }).schemaVersion !== 2) ||
    typeof (reviewSnapshot as { effectId?: unknown }).effectId !== 'string' ||
    !(reviewSnapshot as { effectId: string }).effectId.trim() ||
    typeof (reviewSnapshot as { reviewId?: unknown }).reviewId !== 'string' ||
    !(reviewSnapshot as { reviewId: string }).reviewId.trim() ||
    typeof (reviewSnapshot as { baseContentJson?: unknown })
      .baseContentJson !== 'string' ||
    ((reviewSnapshot as { mode?: unknown }).mode !== 'auto' &&
      (reviewSnapshot as { mode?: unknown }).mode !== 'approve') ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(
        (reviewSnapshot as { baseStateHash?: unknown }).baseStateHash ?? '',
      ),
    )
  ) {
    throw new Error('The persisted prose command is invalid');
  }
  const schemaVersion = (reviewSnapshot as { schemaVersion: 1 | 2 })
    .schemaVersion;
  const expectedKeys = [
    'baseContentJson',
    'baseStateHash',
    'effectId',
    'format',
    'mode',
    'reviewId',
    'schemaVersion',
    ...(schemaVersion === 2 ? ['baseContentHash'] : []),
  ];
  if (
    !hasExactKeys(reviewSnapshot, expectedKeys) ||
    (schemaVersion === 2 &&
      !/^sha256:[0-9a-f]{64}$/.test(
        String(
          (reviewSnapshot as { baseContentHash?: unknown })
            .baseContentHash ?? '',
        ),
      ))
  ) {
    throw new Error('The persisted prose command is invalid');
  }
  return value as PersistedProseCommandPayload;
}

function hasExactKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function restorePersistenceCommand(
  payload: PersistedProseCommandPayload,
  prepared: PreparedYjsProseCommand,
): PreparedYjsProsePersistenceCommand {
  return {
    base: {
      docId: payload.docId,
      sourceKind: prepared.durableWatermark.sourceKind,
      revision: prepared.durableWatermark.baseRevision,
      stateVector: new Uint8Array(
        prepared.durableWatermark.baseStateVector,
      ),
      stateHash: prepared.durableWatermark.baseStateHash,
      // Inverse commits always start from the durable forward state; the seed
      // bytes are never consulted. The exact base survives in the command's
      // verified inverse update and watermark.
      stateUpdate: new Uint8Array(),
    },
    prepared,
  };
}

function resolveEffectProjectProseEntity(
  effect: PersistedAgentRuntimeWriteEffect,
  entityType: ProseEntityType,
  entityId: string,
) {
  const state = useDataStore.getState();
  const entity =
    entityType === 'node'
      ? state.bookNodes.find(
          (candidate) =>
            candidate.id === entityId && candidate.projectId === effect.projectId,
        )
      : entityType === 'element'
        ? state.bookElements.find(
            (candidate) =>
              candidate.id === entityId && candidate.projectId === effect.projectId,
          )
        : entityType === 'storyline'
          ? state.storylines.find(
              (candidate) =>
                candidate.id === entityId && candidate.projectId === effect.projectId,
            )
          : state.bookElementCategories.find(
              (candidate) =>
                candidate.id === entityId && candidate.projectId === effect.projectId,
            );
  if (!entity) {
    throw new Error(`The ${entityType} for this prose review no longer exists`);
  }
  return entity;
}

function proseExecutionEntityType(execution: ProseExecution): ProseEntityType {
  return execution.entityType ?? 'node';
}

function prosePayloadEntityType(payload: PersistedProseCommandPayload): ProseEntityType {
  return payload.entityType ?? 'node';
}

function isProseEntityTypeValue(value: unknown): value is ProseEntityType {
  return (
    value === 'node' ||
    value === 'element' ||
    value === 'storyline' ||
    value === 'category'
  );
}

function proseCommandId(idempotencyKey: string): string {
  return `agent-prose:${idempotencyKey}`;
}

function proseWriteEffectId(idempotencyKey: string): string {
  return `agent-write:${idempotencyKey}`;
}

function proseWriteReviewId(effectId: string): string {
  return `agent-review:${effectId}`;
}

function proseRevision(revision: number): string {
  return `yjs:${revision}`;
}

function parseProseRevision(value: string): number | null {
  const match = /^yjs:(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function resolveProjectProseEntity(request: AgentToolExecutionRequest): {
  id: string;
  projectId: string;
  entityType: ProseEntityType;
} {
  const projectId = request.context.route.projectId;
  const entityType = String(request.arguments.kind ?? 'node');
  if (
    !projectId ||
    (entityType !== 'node' &&
      entityType !== 'chapter' &&
      entityType !== 'drift' &&
      entityType !== 'element' &&
      entityType !== 'storyline' &&
      entityType !== 'category')
  ) {
    throw new Error(`${request.name} requires a project-scoped prose entity`);
  }
  if (entityType === 'node' || entityType === 'chapter' || entityType === 'drift') {
    const node = resolveProjectNode(request);
    return { id: node.id, projectId: node.projectId, entityType: 'node' };
  }
  const ref = String(
    request.arguments.entity ?? request.arguments.node ?? '',
  ).trim();
  if (!ref) throw new Error(`${request.name} requires an entity name`);
  const state = useDataStore.getState();
  const candidates =
    entityType === 'element'
      ? state.bookElements.filter((entity) => entity.projectId === projectId)
      : entityType === 'storyline'
        ? state.storylines.filter((entity) => entity.projectId === projectId)
        : state.bookElementCategories.filter((entity) => entity.projectId === projectId);
  const label = (entity: (typeof candidates)[number]) => entity.name;
  const direct = candidates.find((entity) => entity.id === ref);
  const normalized = ref.toLocaleLowerCase();
  const matches = direct
    ? [direct]
    : candidates.filter(
        (entity) => label(entity).trim().toLocaleLowerCase() === normalized,
      );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No ${entityType} named "${ref}" exists in this project`
        : `${entityType} reference "${ref}" is ambiguous`,
    );
  }
  return { id: matches[0]!.id, projectId, entityType };
}

function readProjectedProseContent(
  entityType: Exclude<ProseEntityType, 'node'>,
  entityId: string,
): string | null {
  const state = useDataStore.getState();
  if (entityType === 'element') {
    return state.bookElements.find((entity) => entity.id === entityId)?.contentJson ?? null;
  }
  if (entityType === 'storyline') {
    return state.storylines.find((entity) => entity.id === entityId)?.contentJson ?? null;
  }
  return (
    state.bookElementCategories.find((entity) => entity.id === entityId)?.contentJson ?? null
  );
}

function resolveProjectNode(request: AgentToolExecutionRequest) {
  const projectId = request.context.route.projectId;
  const ref = String(
    request.arguments.node ??
      request.arguments.nodeId ??
      request.arguments.entity ??
      '',
  ).trim();
  const kind = String(request.arguments.kind ?? 'node');
  if (kind !== 'node' && kind !== 'chapter' && kind !== 'drift') {
    throw new Error(`${request.name} currently certifies node prose only`);
  }
  if (!projectId || !ref) {
    throw new Error(`${request.name} requires a project-scoped node`);
  }
  const candidates = useDataStore
    .getState()
    .bookNodes.filter((node) => node.projectId === projectId);
  const direct = candidates.find((node) => node.id === ref);
  if (direct) return direct;
  const normalized = ref.toLocaleLowerCase();
  const matches = candidates.filter(
    (node) => node.title.trim().toLocaleLowerCase() === normalized,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No node named "${ref}" exists in this project`
        : `Node reference "${ref}" is ambiguous`,
    );
  }
  return matches[0];
}

function requiredString(
  value: unknown,
  message: string,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(message);
  }
  return value;
}

function nodeRevision(node: { id: string; updatedAt: string }) {
  return {
    kind: 'entity_revision',
    entityKind: 'node',
    entityId: node.id,
    updatedAt: node.updatedAt,
  };
}

function parseNodeFieldPayload(
  value: unknown,
  expectedField: 'title' | 'summary',
): { nodeId: string; field: 'title' | 'summary'; value: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { kind?: unknown }).kind !== 'node_field' ||
    typeof (value as { nodeId?: unknown }).nodeId !== 'string' ||
    (value as { field?: unknown }).field !== expectedField ||
    typeof (value as { value?: unknown }).value !== 'string'
  ) {
    throw new Error('The persisted Agent inverse is invalid');
  }
  return value as {
    nodeId: string;
    field: 'title' | 'summary';
    value: string;
  };
}
