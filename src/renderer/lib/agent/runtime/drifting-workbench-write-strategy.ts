import type {
  AgentRuntimeEntityWriteSnapshot,
  PersistedAgentRuntimeEntityWriteReceipt,
} from '../../../domain/agent-runtime-entity-write-receipt';
import type { PersistedAgentRuntimeWriteExpectation } from '../../../domain/agent-runtime-freshness';
import type { PersistedAgentRuntimeWriteEffect } from '../../../domain/agent-runtime-write-effect';
import { getDb, type DbExecutor } from '../../../lib/db';
import {
  createAgentRuntimeEntityWriteReceiptRepository,
  type AgentRuntimeEntityWriteReceiptRepository,
} from '../../../sqlite-repo/agent-runtime-entity-write-receipt-repo';
import type { AgentRuntimeFreshnessRepository } from '../../../sqlite-repo/agent-runtime-freshness-repo';
import { agentAuthoredJournal, type AgentAuthoredJournal } from './agent-authored-journal';
import type { DriftingWriteStrategy } from './drifting-write-strategies';
import { hashEntityWriteValue } from './entity-write-revision';
import { throwIfAgentAborted } from './errors';
import type { AgentToolExecutionRequest } from './types';
import { WORKBENCH_COMMAND_NAMES, type WorkbenchCommandName } from './drifting-workspace-tool-contract';
import type { WorkbenchCommand, WorkbenchResolution, WorkbenchScope } from './drifting-workbench-types';
import { MATERIAL_LIBRARY_COMMANDS } from './workbench-material-library';

/** Receipt and snapshot kind shared by every workbench scope. */
export const WORKBENCH_SNAPSHOT_KIND = 'authoring_scope' as const;

type AnyCommand = WorkbenchCommand<unknown>;
type AnyScope = WorkbenchScope<unknown>;

const COMMANDS: ReadonlyMap<string, AnyCommand> = new Map(
  ([...MATERIAL_LIBRARY_COMMANDS] as unknown as AnyCommand[]).map((command) => [command.name, command]),
);

for (const name of WORKBENCH_COMMAND_NAMES) {
  if (!COMMANDS.has(name)) throw new Error(`Workbench command "${name}" has no implementation`);
}

const SCOPES: ReadonlyMap<string, AnyScope> = new Map(
  [...COMMANDS.values()].map((command) => [command.scope.kind, command.scope]),
);

export function workbenchCommand(name: string): AnyCommand | undefined {
  return COMMANDS.get(name);
}

export function isWorkbenchScopeKind(kind: string): boolean {
  return SCOPES.has(kind);
}

/** Revision of a scope image: exact match only, like every Agent freshness token. */
export function workbenchScopeRevision(scope: AnyScope, state: unknown): Promise<string> {
  return hashEntityWriteValue({ scope: scope.kind, state });
}

function snapshot(
  scope: AnyScope,
  projectId: string,
  scopeId: string,
  state: unknown,
  revision: string,
): AgentRuntimeEntityWriteSnapshot {
  return {
    kind: WORKBENCH_SNAPSHOT_KIND,
    value: { id: scopeId, projectId, updatedAt: revision, scope: scope.kind, state },
  } as AgentRuntimeEntityWriteSnapshot;
}

/** Observations a canonical read records for the scopes it shows. */
export async function workbenchReadObservations(
  readTool: string,
  args: Readonly<Record<string, unknown>>,
  projectId: string,
  db?: DbExecutor,
): Promise<Array<{ entityKind: string; entityId: string; revision: string }>> {
  const observations: Array<{ entityKind: string; entityId: string; revision: string }> = [];
  for (const scope of SCOPES.values()) {
    if (scope.readTool !== readTool) continue;
    const command = [...COMMANDS.values()].find((candidate) => candidate.scope === scope)!;
    let scopeId: string;
    try {
      scopeId = command.scopeId(projectId, args);
    } catch {
      continue;
    }
    const state = await scope.load(db ?? getDb(), projectId, scopeId);
    observations.push({ entityKind: scope.kind, entityId: scopeId, revision: await workbenchScopeRevision(scope, state) });
  }
  return observations;
}

export async function currentWorkbenchRevision(
  entityKind: string,
  projectId: string,
  scopeId: string,
  db?: DbExecutor,
): Promise<string> {
  const scope = SCOPES.get(entityKind);
  if (!scope) throw new Error(`Unknown workbench scope "${entityKind}"`);
  return workbenchScopeRevision(scope, await scope.load(db ?? getDb(), projectId, scopeId));
}

function scopeIdFor(command: AnyCommand, projectId: string, args: Readonly<Record<string, unknown>>): string {
  return typeof args.scopeId === 'string' && args.scopeId ? args.scopeId : command.scopeId(projectId, args);
}

/** The read that must back a workbench write, for the write runtime. */
export function workbenchFreshnessKind(
  toolName: string,
): { readToolNames: readonly [string]; entityKind: string } | null {
  const command = COMMANDS.get(toolName);
  return command ? { readToolNames: [command.scope.readTool], entityKind: command.scope.kind } : null;
}

export async function resolveWorkbenchFreshnessTarget(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  projectId: string,
  db?: DbExecutor,
): Promise<{ readToolNames: readonly [string]; entityKind: string; entityId: string; currentRevision: string } | null> {
  const command = COMMANDS.get(toolName);
  if (!command) return null;
  const scopeId = scopeIdFor(command, projectId, args);
  return {
    readToolNames: [command.scope.readTool],
    entityKind: command.scope.kind,
    entityId: scopeId,
    currentRevision: await currentWorkbenchRevision(command.scope.kind, projectId, scopeId, db),
  };
}

/** Resolve author-domain arguments before the runtime cites its fresh read. */
export async function resolveWorkbenchCommand(
  toolName: WorkbenchCommandName,
  projectId: string,
  args: Readonly<Record<string, unknown>>,
  db?: DbExecutor,
): Promise<{ scope: AnyScope; scopeId: string; resolution: WorkbenchResolution }> {
  const command = COMMANDS.get(toolName);
  if (!command) throw new Error(`Unknown workbench command "${toolName}"`);
  const scopeId = command.scopeId(projectId, args);
  const state = await command.scope.load(db ?? getDb(), projectId, scopeId);
  return { scope: command.scope, scopeId, resolution: command.resolve(state, args, projectId) };
}

interface WorkbenchPayload {
  kind: 'workbench_command';
  commandId: string;
  effectId: string;
  toolName: string;
  projectId: string;
  scope: string;
  scopeId: string;
  expectedRevision: string;
  preimage: AgentRuntimeEntityWriteSnapshot;
  next: unknown;
  nextRevision: string;
  extra: unknown;
  summary: string;
}

export interface DriftingWorkbenchWriteStrategyOptions {
  freshness: AgentRuntimeFreshnessRepository;
  db?: DbExecutor;
  receipts?: AgentRuntimeEntityWriteReceiptRepository;
  now?: () => string;
  journal?: AgentAuthoredJournal;
}

export function createDriftingWorkbenchWriteStrategy(
  toolName: string,
  options: DriftingWorkbenchWriteStrategyOptions,
): DriftingWriteStrategy {
  const command = COMMANDS.get(toolName);
  if (!command) throw new Error(`Unknown workbench command "${toolName}"`);
  const scope = command.scope;
  const db = () => options.db ?? getDb();
  const receipts = () => options.receipts ?? createAgentRuntimeEntityWriteReceiptRepository(db());
  const now = options.now ?? (() => new Date().toISOString());
  const journal = options.journal ?? agentAuthoredJournal;

  const project = async (payload: WorkbenchPayload) => {
    await scope.project(payload.projectId, payload.scopeId);
  };

  return {
    async prepare(request, _context, expectation) {
      throwIfAgentAborted(request.signal);
      const projectId = request.context.route.projectId;
      if (!projectId) throw new Error(`${toolName} requires a project route`);
      const scopeId = scopeIdFor(command, projectId, request.arguments);
      requireExpectation(expectation, request, scope.kind, scopeId);
      const state = await scope.load(db(), projectId, scopeId);
      const revision = await workbenchScopeRevision(scope, state);
      if (expectation.expectedRevision !== revision) {
        throw new Error(`The target changed after ${scope.readTool}; read it again before writing`);
      }
      const at = now();
      const plan = await command.plan(state, request.arguments, {
        projectId,
        idempotencyKey: request.idempotencyKey,
        at,
      });
      const nextRevision = await workbenchScopeRevision(scope, plan.next);
      if (nextRevision === revision) throw new Error(`${toolName} would not change anything`);
      const payload: WorkbenchPayload = {
        kind: 'workbench_command',
        commandId: `agent-entity-write:${request.idempotencyKey}`,
        effectId: `agent-write:${request.idempotencyKey}`,
        toolName,
        projectId,
        scope: scope.kind,
        scopeId,
        expectedRevision: revision,
        preimage: snapshot(scope, projectId, scopeId, state, revision),
        next: plan.next,
        nextRevision,
        extra: plan.extra ?? null,
        summary: typeof request.arguments.changeSummary === 'string' ? request.arguments.changeSummary : '',
      };
      return {
        observedRevision: revision,
        preimage: payload.preimage,
        forward: payload,
        inverse: payload,
        reversibility: 'exact',
      };
    },

    async applyForward(request, _context, prepared) {
      throwIfAgentAborted(request.signal);
      const payload = parsePayload(prepared.forward, toolName);
      const receipt = await options.freshness.executeGuardedMutation({
        effectId: payload.effectId,
        projectId: payload.projectId,
        sessionId: request.sessionId,
        readCurrentVersion: async (tx, expectation) => {
          if (
            expectation.projectId !== payload.projectId ||
            expectation.entityKind !== payload.scope ||
            expectation.entityId !== payload.scopeId
          ) {
            return null;
          }
          return { revision: await currentWorkbenchRevision(payload.scope, payload.projectId, payload.scopeId, tx) };
        },
        mutate: async (tx) => {
          const current = await scope.load(tx, payload.projectId, payload.scopeId);
          if ((await workbenchScopeRevision(scope, current)) !== payload.expectedRevision) {
            throw new Error('The target changed before the write committed; read it again');
          }
          const at = now();
          const changes = journal.createChangeSet();
          await scope.apply(tx, {
            projectId: payload.projectId,
            from: current,
            to: payload.next,
            direction: 'forward',
            extra: payload.extra,
            changes,
            journal,
            at,
          });
          const applied = await scope.load(tx, payload.projectId, payload.scopeId);
          const appliedRevision = await workbenchScopeRevision(scope, applied);
          if (appliedRevision !== payload.nextRevision) {
            throw new Error(`${toolName} did not produce its planned state`);
          }
          const postimage = snapshot(scope, payload.projectId, payload.scopeId, applied, appliedRevision);
          const persisted = await createAgentRuntimeEntityWriteReceiptRepository(tx).persist({
            id: receiptId(payload, 'forward'),
            effectId: payload.effectId,
            commandId: payload.commandId,
            direction: 'forward',
            projectId: payload.projectId,
            sessionId: request.sessionId,
            toolName: payload.toolName as PersistedAgentRuntimeEntityWriteReceipt['toolName'],
            entityKind: WORKBENCH_SNAPSHOT_KIND,
            entityId: payload.scopeId,
            expectedRevision: payload.expectedRevision,
            resultRevision: appliedRevision,
            preimage: payload.preimage,
            preimageHash: await hashEntityWriteValue(payload.preimage),
            postimage,
            postimageHash: await hashEntityWriteValue(postimage),
            createdAt: at,
          });
          await journal.record(tx, { projectId: payload.projectId, changes, committedAt: at });
          return persisted;
        },
      });
      await project(payload);
      return handlerResult(payload, receipt);
    },

    async captureEffect(_request, _context, result, prepared) {
      const payload = parsePayload(prepared.forward, toolName);
      assertHandlerResult(result, payload);
      const receipt = await receipts().get(payload.commandId, 'forward');
      assertReceipt(receipt, payload, 'forward');
      return committedEffect(payload, receipt);
    },

    async reconcileEnteredEffect(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parsePayload(effect.forward, toolName);
      assertEffect(effect, payload);
      const receipt = await receipts().get(payload.commandId, 'forward');
      if (!receipt) return null;
      assertReceipt(receipt, payload, 'forward');
      await project(payload);
      return {
        handlerResult: handlerResult(payload, receipt),
        committedEffect: { ...committedEffect(payload, receipt), reconciled: true },
      };
    },

    async applyInverse(effect, _context, signal) {
      throwIfAgentAborted(signal);
      const payload = parsePayload(effect.inverse, toolName);
      assertEffect(effect, payload);
      const forward = await receipts().get(payload.commandId, 'forward');
      assertReceipt(forward, payload, 'forward');
      const existing = await receipts().get(payload.commandId, 'inverse');
      if (existing) {
        assertReceipt(existing, payload, 'inverse');
        await project(payload);
        return inverseEffect(existing, true);
      }
      const committed = await db().transaction(
        async (tx) => {
          const repo = createAgentRuntimeEntityWriteReceiptRepository(tx);
          const again = await repo.get(payload.commandId, 'inverse');
          if (again) return again;
          const current = await scope.load(tx, payload.projectId, payload.scopeId);
          const currentRevision = await workbenchScopeRevision(scope, current);
          if (currentRevision !== forward.resultRevision) {
            throw new Error('这处结构在 Agent 修改之后又变过，无法精确撤销；请手动调整');
          }
          await command.assertInverseSafe?.(tx, payload.projectId, payload.extra);
          const before = (payload.preimage.value as { state: unknown }).state;
          const target = command.inverseImage ? command.inverseImage(before, payload.extra) : before;
          const targetRevision = await workbenchScopeRevision(scope, target);
          const at = now();
          const changes = journal.createChangeSet();
          await scope.apply(tx, {
            projectId: payload.projectId,
            from: current,
            to: target,
            direction: 'inverse',
            extra: payload.extra,
            changes,
            journal,
            at,
          });
          const restored = await scope.load(tx, payload.projectId, payload.scopeId);
          const restoredRevision = await workbenchScopeRevision(scope, restored);
          if (restoredRevision !== targetRevision) {
            throw new Error(`${toolName} could not restore its exact preimage`);
          }
          const postimage = snapshot(scope, payload.projectId, payload.scopeId, restored, restoredRevision);
          const persisted = await repo.persist({
            id: receiptId(payload, 'inverse'),
            effectId: payload.effectId,
            commandId: payload.commandId,
            direction: 'inverse',
            projectId: payload.projectId,
            sessionId: effect.sessionId,
            toolName: payload.toolName as PersistedAgentRuntimeEntityWriteReceipt['toolName'],
            entityKind: WORKBENCH_SNAPSHOT_KIND,
            entityId: payload.scopeId,
            expectedRevision: forward.resultRevision,
            resultRevision: restoredRevision,
            preimage: payload.preimage,
            preimageHash: await hashEntityWriteValue(payload.preimage),
            postimage,
            postimageHash: await hashEntityWriteValue(postimage),
            createdAt: at,
          });
          await journal.record(tx, { projectId: payload.projectId, changes, committedAt: at });
          return persisted;
        },
        { behavior: 'immediate' },
      );
      await project(payload);
      return inverseEffect(committed, false);
    },
  };
}

function requireExpectation(
  expectation: PersistedAgentRuntimeWriteExpectation | null | undefined,
  request: AgentToolExecutionRequest,
  entityKind: string,
  entityId: string,
): asserts expectation is PersistedAgentRuntimeWriteExpectation {
  if (
    !expectation ||
    expectation.projectId !== request.context.route.projectId ||
    expectation.sessionId !== request.sessionId ||
    expectation.writeTurnId !== request.turnId ||
    expectation.entityKind !== entityKind ||
    expectation.entityId !== entityId
  ) {
    throw new Error(`${request.name} lost its exact dependent-read expectation`);
  }
}

function parsePayload(value: unknown, toolName: string): WorkbenchPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { kind?: unknown }).kind !== 'workbench_command' ||
    (value as { toolName?: unknown }).toolName !== toolName
  ) {
    throw new Error(`${toolName} lost its prepared workbench payload`);
  }
  return value as WorkbenchPayload;
}

function receiptId(payload: WorkbenchPayload, direction: 'forward' | 'inverse'): string {
  return `agent-entity-write-receipt:${payload.effectId}:${direction}`;
}

function assertReceipt(
  receipt: PersistedAgentRuntimeEntityWriteReceipt | null,
  payload: WorkbenchPayload,
  direction: 'forward' | 'inverse',
): asserts receipt is PersistedAgentRuntimeEntityWriteReceipt {
  if (
    !receipt ||
    receipt.id !== receiptId(payload, direction) ||
    receipt.commandId !== payload.commandId ||
    receipt.effectId !== payload.effectId ||
    receipt.direction !== direction ||
    receipt.projectId !== payload.projectId ||
    receipt.toolName !== payload.toolName ||
    receipt.entityKind !== WORKBENCH_SNAPSHOT_KIND ||
    receipt.entityId !== payload.scopeId
  ) {
    throw new Error(`${payload.toolName} has no matching immutable ${direction} receipt`);
  }
}

function assertEffect(effect: PersistedAgentRuntimeWriteEffect, payload: WorkbenchPayload): void {
  if (
    effect.id !== payload.effectId ||
    effect.projectId !== payload.projectId ||
    effect.idempotencyKey !== payload.commandId.replace(/^agent-entity-write:/, '')
  ) {
    throw new Error('The workbench effect conflicts with its prepared payload');
  }
}

function handlerResult(
  payload: WorkbenchPayload,
  receipt: PersistedAgentRuntimeEntityWriteReceipt,
): Record<string, unknown> {
  return {
    ok: true,
    entityType: payload.scope,
    entityId: payload.scopeId,
    revision: receipt.resultRevision,
    ...(payload.summary ? { summary: payload.summary } : {}),
  };
}

function assertHandlerResult(value: unknown, payload: WorkbenchPayload): void {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { ok?: unknown }).ok !== true ||
    (value as { entityId?: unknown }).entityId !== payload.scopeId
  ) {
    throw new Error('The workbench handler result is invalid');
  }
}

function committedEffect(payload: WorkbenchPayload, receipt: PersistedAgentRuntimeEntityWriteReceipt) {
  return {
    kind: 'workbench_write',
    commandId: payload.commandId,
    scope: payload.scope,
    entityId: payload.scopeId,
    revision: receipt.resultRevision,
    receiptId: receipt.id,
    handlerResult: handlerResult(payload, receipt),
  };
}

function inverseEffect(receipt: PersistedAgentRuntimeEntityWriteReceipt, reconciled: boolean) {
  return {
    kind: 'workbench_write_revert',
    commandId: receipt.commandId,
    entityId: receipt.entityId,
    revision: receipt.resultRevision,
    receiptId: receipt.id,
    reconciled,
  };
}
