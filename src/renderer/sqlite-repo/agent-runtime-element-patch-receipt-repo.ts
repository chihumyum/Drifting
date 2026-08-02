import { and, eq } from 'drizzle-orm';

import type {
  AgentRuntimeElementPatchSnapshot,
  CreateAgentRuntimeElementPatchReceipt,
  PersistedAgentRuntimeElementPatchReceipt,
} from '../domain/agent-runtime-element-patch-receipt';
import { getDb, type DbExecutor } from '../lib/db';
import {
  AgentRuntimeElementPatchReceiptTable,
  AgentRuntimeWriteEffectTable,
} from '../schema/drizzle';
import { hashElementPatchValue } from '../lib/agent/runtime/element-patch-revision';
import { canonicalAgentRuntimeJson } from './agent-runtime-persistence-repo';

export class AgentRuntimeElementPatchReceiptError extends Error {
  constructor(
    readonly code:
      | 'INVALID_PATCH_RECEIPT'
      | 'PATCH_RECEIPT_CONFLICT'
      | 'PATCH_RECEIPT_INTEGRITY',
    message: string,
  ) {
    super(message);
    this.name = 'AgentRuntimeElementPatchReceiptError';
  }
}

export interface AgentRuntimeElementPatchReceiptRepository {
  persist(
    input: CreateAgentRuntimeElementPatchReceipt,
  ): Promise<PersistedAgentRuntimeElementPatchReceipt>;
  get(
    commandId: string,
    direction: 'forward' | 'inverse',
  ): Promise<PersistedAgentRuntimeElementPatchReceipt | null>;
}

export interface AgentRuntimeElementPatchReceiptEffectProvenance {
  id: string;
  projectId: string;
  sessionId: string;
  toolName: string;
  idempotencyKey: string;
  preimage: unknown | null;
  forward: unknown | null;
  inverse: unknown | null;
}

interface ElementPatchCommandPayload {
  kind: 'element_patch_command';
  commandId: string;
  effectId: string;
  toolName:
    | 'create_element_patch'
    | 'update_element_patch'
    | 'delete_element_patch';
  projectId: string;
  elementId: string;
  patchId: string;
  expectedEntityKind: 'element_patch_set' | 'element_patch';
  expectedRevision: string;
  create: Record<string, unknown> | null;
  update: Record<string, unknown> | null;
  preimage: AgentRuntimeElementPatchSnapshot | null;
}

const SNAPSHOT_KEYS = [
  'contentJson',
  'createdAt',
  'elementId',
  'id',
  'invalidatedAt',
  'orderKey',
  'projectId',
  'sourceBlockId',
  'sourceBlockText',
  'sourceNodeId',
  'textAnchorJson',
  'title',
  'updatedAt',
] as const;

const PATCH_REVISION_PATTERN = /^element-patch:sha256:[0-9a-f]{64}$/;
const PATCH_SET_REVISION_PATTERN =
  /^element-patch-set:sha256:[0-9a-f]{64}$/;

function integrityError(receiptId: string, detail: string): never {
  throw new AgentRuntimeElementPatchReceiptError(
    'PATCH_RECEIPT_INTEGRITY',
    `Element patch receipt ${receiptId} failed its immutable payload check: ${detail}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseStoredJson(value: string, receiptId: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    integrityError(receiptId, 'persisted JSON is malformed');
  }
}

function parseSnapshot(
  value: unknown,
  receiptId: string,
  label: string,
): AgentRuntimeElementPatchSnapshot {
  if (!isRecord(value)) {
    integrityError(receiptId, `${label} is not an object`);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== SNAPSHOT_KEYS.length ||
    SNAPSHOT_KEYS.some((key, index) => keys[index] !== key)
  ) {
    integrityError(receiptId, `${label} does not have the exact snapshot shape`);
  }
  const nullableStrings = [
    'sourceNodeId',
    'sourceBlockId',
    'sourceBlockText',
    'textAnchorJson',
    'invalidatedAt',
    'title',
  ] as const;
  if (
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.projectId !== 'string' ||
    !value.projectId.trim() ||
    typeof value.elementId !== 'string' ||
    !value.elementId.trim() ||
    typeof value.contentJson !== 'string' ||
    typeof value.orderKey !== 'number' ||
    !Number.isFinite(value.orderKey) ||
    typeof value.createdAt !== 'string' ||
    !value.createdAt.trim() ||
    typeof value.updatedAt !== 'string' ||
    !value.updatedAt.trim() ||
    nullableStrings.some(
      (key) => value[key] !== null && typeof value[key] !== 'string',
    )
  ) {
    integrityError(receiptId, `${label} has invalid field types`);
  }
  try {
    JSON.parse(value.contentJson);
  } catch {
    integrityError(receiptId, `${label}.contentJson is malformed`);
  }
  return value as unknown as AgentRuntimeElementPatchSnapshot;
}

function parsePayload(
  value: unknown,
  receiptId: string,
): ElementPatchCommandPayload {
  if (
    !isRecord(value) ||
    value.kind !== 'element_patch_command' ||
    typeof value.commandId !== 'string' ||
    typeof value.effectId !== 'string' ||
    (value.toolName !== 'create_element_patch' &&
      value.toolName !== 'update_element_patch' &&
      value.toolName !== 'delete_element_patch') ||
    typeof value.projectId !== 'string' ||
    typeof value.elementId !== 'string' ||
    typeof value.patchId !== 'string' ||
    (value.expectedEntityKind !== 'element_patch_set' &&
      value.expectedEntityKind !== 'element_patch') ||
    typeof value.expectedRevision !== 'string' ||
    (value.create !== null && !isRecord(value.create)) ||
    (value.update !== null && !isRecord(value.update))
  ) {
    integrityError(receiptId, 'write-effect command payload is malformed');
  }
  return {
    kind: 'element_patch_command',
    commandId: value.commandId,
    effectId: value.effectId,
    toolName: value.toolName,
    projectId: value.projectId,
    elementId: value.elementId,
    patchId: value.patchId,
    expectedEntityKind: value.expectedEntityKind,
    expectedRevision: value.expectedRevision,
    create: value.create,
    update: value.update,
    preimage:
      value.preimage === null
        ? null
        : parseSnapshot(value.preimage, receiptId, 'command preimage'),
  };
}

function sameSnapshotField(
  left: AgentRuntimeElementPatchSnapshot,
  right: AgentRuntimeElementPatchSnapshot,
  key: keyof AgentRuntimeElementPatchSnapshot,
): boolean {
  return left[key] === right[key];
}

function assertStablePatchIdentity(
  receiptId: string,
  left: AgentRuntimeElementPatchSnapshot,
  right: AgentRuntimeElementPatchSnapshot,
): void {
  const stableKeys: Array<keyof AgentRuntimeElementPatchSnapshot> = [
    'id',
    'projectId',
    'elementId',
    'sourceNodeId',
    'sourceBlockId',
    'sourceBlockText',
    'textAnchorJson',
    'invalidatedAt',
    'orderKey',
    'createdAt',
  ];
  if (stableKeys.some((key) => !sameSnapshotField(left, right, key))) {
    integrityError(receiptId, 'update changed immutable patch identity');
  }
}

function valueOrNull(
  value: Record<string, unknown>,
  key: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : null;
}

function assertCreatePostimage(
  receiptId: string,
  payload: ElementPatchCommandPayload,
  postimage: AgentRuntimeElementPatchSnapshot,
): void {
  const create = payload.create!;
  const createKeys = Object.keys(create);
  if (
    createKeys.some(
      (key) =>
        ![
          'id',
          'projectId',
          'elementId',
          'sourceNodeId',
          'sourceBlockId',
          'sourceBlockText',
          'textAnchorJson',
          'title',
          'contentJson',
        ].includes(key),
    ) ||
    [
      'sourceNodeId',
      'sourceBlockId',
      'sourceBlockText',
      'textAnchorJson',
      'title',
    ].some(
      (key) =>
        Object.prototype.hasOwnProperty.call(create, key) &&
        create[key] !== null &&
        typeof create[key] !== 'string',
    ) ||
    (Object.prototype.hasOwnProperty.call(create, 'contentJson') &&
      typeof create.contentJson !== 'string') ||
    create.id !== payload.patchId ||
    create.projectId !== payload.projectId ||
    create.elementId !== payload.elementId ||
    postimage.id !== payload.patchId ||
    postimage.projectId !== payload.projectId ||
    postimage.elementId !== payload.elementId ||
    postimage.sourceNodeId !== valueOrNull(create, 'sourceNodeId') ||
    postimage.sourceBlockId !== valueOrNull(create, 'sourceBlockId') ||
    postimage.sourceBlockText !== valueOrNull(create, 'sourceBlockText') ||
    postimage.textAnchorJson !== valueOrNull(create, 'textAnchorJson') ||
    postimage.invalidatedAt !== null ||
    postimage.title !== valueOrNull(create, 'title') ||
    postimage.contentJson !== (create.contentJson ?? '{}') ||
    postimage.orderKey !== 0 ||
    postimage.createdAt !== postimage.updatedAt
  ) {
    integrityError(receiptId, 'create postimage does not match its command');
  }
}

function assertUpdatePostimage(
  receiptId: string,
  payload: ElementPatchCommandPayload,
  postimage: AgentRuntimeElementPatchSnapshot,
  direction: 'forward' | 'inverse',
): void {
  const preimage = payload.preimage!;
  assertStablePatchIdentity(receiptId, preimage, postimage);
  if (direction === 'inverse') {
    if (
      postimage.title !== preimage.title ||
      postimage.contentJson !== preimage.contentJson
    ) {
      integrityError(receiptId, 'inverse postimage does not restore preimage');
    }
    return;
  }
  const update = payload.update!;
  const keys = Object.keys(update);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== 'title' && key !== 'contentJson') ||
    (Object.prototype.hasOwnProperty.call(update, 'title') &&
      typeof update.title !== 'string') ||
    (Object.prototype.hasOwnProperty.call(update, 'contentJson') &&
      typeof update.contentJson !== 'string') ||
    postimage.title !== (update.title ?? preimage.title) ||
    postimage.contentJson !== (update.contentJson ?? preimage.contentJson)
  ) {
    integrityError(receiptId, 'update postimage does not match its command');
  }
}

function toDomain(
  row: typeof AgentRuntimeElementPatchReceiptTable.$inferSelect,
): PersistedAgentRuntimeElementPatchReceipt {
  return {
    id: row.id,
    effectId: row.effectId,
    commandId: row.commandId,
    direction: row.direction as PersistedAgentRuntimeElementPatchReceipt['direction'],
    projectId: row.projectId,
    sessionId: row.sessionId,
    toolName:
      row.toolName as PersistedAgentRuntimeElementPatchReceipt['toolName'],
    patchId: row.patchId,
    expectedRevision: row.expectedRevision ?? null,
    resultRevision: row.resultRevision ?? null,
    postimage:
      row.postimageJson === null
        ? null
        : parseSnapshot(
            parseStoredJson(row.postimageJson, row.id),
            row.id,
            'postimage',
          ),
    postimageHash: row.postimageHash ?? null,
    createdAt: row.createdAt,
  };
}

function sameReceipt(
  left: PersistedAgentRuntimeElementPatchReceipt,
  right: CreateAgentRuntimeElementPatchReceipt,
): boolean {
  return (
    left.id === right.id &&
    left.effectId === right.effectId &&
    left.commandId === right.commandId &&
    left.direction === right.direction &&
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.toolName === right.toolName &&
    left.patchId === right.patchId &&
    left.expectedRevision === right.expectedRevision &&
    left.resultRevision === right.resultRevision &&
    left.postimageHash === right.postimageHash &&
    canonicalAgentRuntimeJson(left.postimage) ===
      canonicalAgentRuntimeJson(right.postimage) &&
    left.createdAt === right.createdAt
  );
}

async function assertReceiptIntegrity(
  receipt: PersistedAgentRuntimeElementPatchReceipt,
  provenance: AgentRuntimeElementPatchReceiptEffectProvenance,
  forwardReceipt: PersistedAgentRuntimeElementPatchReceipt | null = null,
): Promise<void> {
  const postimage = receipt.postimage;
  const payload = parsePayload(provenance.forward, receipt.id);
  parsePayload(provenance.inverse, receipt.id);
  const expectedReceiptId = `agent-element-patch-receipt:${receipt.effectId}:${receipt.direction}`;
  const expectedCommandId = `agent-element-patch:${provenance.idempotencyKey}`;
  if (
    !receipt.id.trim() ||
    !receipt.effectId.trim() ||
    !receipt.commandId.trim() ||
    !receipt.projectId.trim() ||
    !receipt.sessionId.trim() ||
    !receipt.patchId.trim() ||
    receipt.id !== expectedReceiptId ||
    receipt.commandId !== expectedCommandId ||
    provenance.id !== receipt.effectId ||
    provenance.projectId !== receipt.projectId ||
    provenance.sessionId !== receipt.sessionId ||
    provenance.toolName !== receipt.toolName ||
    payload.commandId !== receipt.commandId ||
    payload.effectId !== receipt.effectId ||
    payload.projectId !== receipt.projectId ||
    payload.toolName !== receipt.toolName ||
    payload.patchId !== receipt.patchId ||
    canonicalAgentRuntimeJson(provenance.forward) !==
      canonicalAgentRuntimeJson(provenance.inverse) ||
    canonicalAgentRuntimeJson(payload.preimage) !==
      canonicalAgentRuntimeJson(provenance.preimage) ||
    (postimage !== null
      ? !receipt.resultRevision ||
        !receipt.postimageHash ||
        postimage.id !== receipt.patchId ||
        postimage.projectId !== receipt.projectId ||
        (await hashElementPatchValue(postimage)) !== receipt.postimageHash ||
        receipt.resultRevision !==
          `element-patch:${receipt.postimageHash}`
      : receipt.resultRevision !== null || receipt.postimageHash !== null)
  ) {
    integrityError(receipt.id, 'receipt provenance or revision is inconsistent');
  }

  if (receipt.direction === 'forward') {
    if (receipt.expectedRevision !== payload.expectedRevision) {
      integrityError(receipt.id, 'forward receipt has invalid revisions');
    }
    if (receipt.toolName === 'create_element_patch') {
      if (
        payload.expectedEntityKind !== 'element_patch_set' ||
        !PATCH_SET_REVISION_PATTERN.test(payload.expectedRevision) ||
        payload.preimage !== null ||
        payload.create === null ||
        payload.update !== null
      ) {
        integrityError(receipt.id, 'create command semantics are invalid');
      }
      if (!postimage) {
        integrityError(receipt.id, 'create command lost its postimage');
      }
      assertCreatePostimage(receipt.id, payload, postimage);
      return;
    }
    if (
      payload.expectedEntityKind !== 'element_patch' ||
      !PATCH_REVISION_PATTERN.test(payload.expectedRevision) ||
      payload.preimage === null ||
      payload.create !== null ||
      payload.preimage.id !== receipt.patchId ||
      payload.preimage.projectId !== receipt.projectId ||
      payload.preimage.elementId !== payload.elementId ||
      payload.preimage.invalidatedAt !== null ||
      payload.expectedRevision !==
        `element-patch:${await hashElementPatchValue(payload.preimage)}`
    ) {
      integrityError(receipt.id, 'patch command preimage is invalid');
    }
    if (receipt.toolName === 'delete_element_patch') {
      if (payload.update !== null || postimage !== null) {
        integrityError(receipt.id, 'delete command semantics are invalid');
      }
      return;
    }
    if (payload.update === null || !postimage) {
      integrityError(receipt.id, 'update command semantics are invalid');
    }
    assertUpdatePostimage(receipt.id, payload, postimage, 'forward');
    return;
  }

  if (
    !forwardReceipt ||
    forwardReceipt.direction !== 'forward' ||
    forwardReceipt.effectId !== receipt.effectId ||
    forwardReceipt.commandId !== receipt.commandId ||
    forwardReceipt.projectId !== receipt.projectId ||
    forwardReceipt.sessionId !== receipt.sessionId ||
    forwardReceipt.toolName !== receipt.toolName ||
    forwardReceipt.patchId !== receipt.patchId ||
    (receipt.toolName === 'delete_element_patch'
      ? forwardReceipt.resultRevision !== null
      : !forwardReceipt.resultRevision) ||
    receipt.expectedRevision !== forwardReceipt.resultRevision
  ) {
    integrityError(receipt.id, 'inverse receipt is not paired to its forward');
  }
  if (receipt.toolName === 'create_element_patch') {
    if (postimage !== null) {
      integrityError(receipt.id, 'create inverse must delete its postimage');
    }
    return;
  }
  if (receipt.toolName === 'delete_element_patch') {
    if (
      !postimage ||
      receipt.expectedRevision !== null ||
      !payload.preimage ||
      canonicalAgentRuntimeJson(postimage) !==
        canonicalAgentRuntimeJson(payload.preimage)
    ) {
      integrityError(receipt.id, 'delete inverse must exactly restore its preimage');
    }
    return;
  }
  if (!postimage || !PATCH_REVISION_PATTERN.test(receipt.expectedRevision!)) {
    integrityError(receipt.id, 'update inverse must restore a postimage');
  }
  assertUpdatePostimage(receipt.id, payload, postimage, 'inverse');
}

/** @internal Exported for focused integrity tests. */
export const assertAgentRuntimeElementPatchReceiptIntegrity =
  assertReceiptIntegrity;

export function createAgentRuntimeElementPatchReceiptRepository(
  dbOverride?: DbExecutor,
): AgentRuntimeElementPatchReceiptRepository {
  const db = () => dbOverride ?? getDb();

  const getRaw = async (
    commandId: string,
    direction: 'forward' | 'inverse',
  ): Promise<PersistedAgentRuntimeElementPatchReceipt | null> => {
    const rows = await db()
      .select()
      .from(AgentRuntimeElementPatchReceiptTable)
      .where(
        and(
          eq(AgentRuntimeElementPatchReceiptTable.commandId, commandId),
          eq(AgentRuntimeElementPatchReceiptTable.direction, direction),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;
    return toDomain(rows[0]);
  };

  const getProvenance = async (
    effectId: string,
    receiptId: string,
  ): Promise<AgentRuntimeElementPatchReceiptEffectProvenance> => {
    const rows = await db()
      .select({
        id: AgentRuntimeWriteEffectTable.id,
        projectId: AgentRuntimeWriteEffectTable.projectId,
        sessionId: AgentRuntimeWriteEffectTable.sessionId,
        toolName: AgentRuntimeWriteEffectTable.toolName,
        idempotencyKey: AgentRuntimeWriteEffectTable.idempotencyKey,
        preimageJson: AgentRuntimeWriteEffectTable.preimageJson,
        forwardJson: AgentRuntimeWriteEffectTable.forwardJson,
        inverseJson: AgentRuntimeWriteEffectTable.inverseJson,
      })
      .from(AgentRuntimeWriteEffectTable)
      .where(eq(AgentRuntimeWriteEffectTable.id, effectId))
      .limit(1);
    const row = rows[0];
    if (!row || row.forwardJson === null || row.inverseJson === null) {
      integrityError(receiptId, 'write-effect provenance is unavailable');
    }
    return {
      id: row.id,
      projectId: row.projectId,
      sessionId: row.sessionId,
      toolName: row.toolName,
      idempotencyKey: row.idempotencyKey,
      preimage:
        row.preimageJson === null
          ? null
          : parseStoredJson(row.preimageJson, receiptId),
      forward: parseStoredJson(row.forwardJson, receiptId),
      inverse: parseStoredJson(row.inverseJson, receiptId),
    };
  };

  const validate = async (
    receipt: PersistedAgentRuntimeElementPatchReceipt,
  ): Promise<void> => {
    const provenance = await getProvenance(receipt.effectId, receipt.id);
    if (receipt.direction === 'forward') {
      await assertReceiptIntegrity(receipt, provenance);
      return;
    }
    const forward = await getRaw(receipt.commandId, 'forward');
    if (forward) await assertReceiptIntegrity(forward, provenance);
    await assertReceiptIntegrity(receipt, provenance, forward);
  };

  const get: AgentRuntimeElementPatchReceiptRepository['get'] = async (
    commandId,
    direction,
  ) => {
    const receipt = await getRaw(commandId, direction);
    if (!receipt) return null;
    await validate(receipt);
    return receipt;
  };

  return {
    get,

    async persist(input) {
      if (
        (input.toolName !== 'create_element_patch' &&
          input.toolName !== 'update_element_patch' &&
          input.toolName !== 'delete_element_patch') ||
        (input.direction !== 'forward' && input.direction !== 'inverse')
      ) {
        throw new AgentRuntimeElementPatchReceiptError(
          'INVALID_PATCH_RECEIPT',
          'Element patch receipt has an unsupported tool or direction.',
        );
      }
      await validate(input);
      const existing = await get(input.commandId, input.direction);
      if (existing) {
        if (sameReceipt(existing, input)) return existing;
        throw new AgentRuntimeElementPatchReceiptError(
          'PATCH_RECEIPT_CONFLICT',
          `Element patch command ${input.commandId}:${input.direction} already has a different receipt.`,
        );
      }
      await db().insert(AgentRuntimeElementPatchReceiptTable).values({
        id: input.id,
        effectId: input.effectId,
        commandId: input.commandId,
        direction: input.direction,
        projectId: input.projectId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        patchId: input.patchId,
        expectedRevision: input.expectedRevision,
        resultRevision: input.resultRevision,
        postimageJson:
          input.postimage === null
            ? null
            : canonicalAgentRuntimeJson(input.postimage),
        postimageHash: input.postimageHash,
        createdAt: input.createdAt,
      });
      const inserted = await get(input.commandId, input.direction);
      if (!inserted || !sameReceipt(inserted, input)) {
        throw new AgentRuntimeElementPatchReceiptError(
          'PATCH_RECEIPT_INTEGRITY',
          `Element patch receipt ${input.id} was not persisted exactly.`,
        );
      }
      return inserted;
    },
  };
}
