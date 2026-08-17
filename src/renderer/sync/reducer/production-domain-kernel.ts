import { and, eq, ne } from 'drizzle-orm';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

import {
  isEntityKind,
  isStructuralEntityKind,
} from '../../domain/entity-kinds';
import {
  normalizeRelationTypeDefinition,
  normalizeRelationTypeName,
  validateRelationAgainstType,
  type EntityRelationType,
} from '../../domain/entity-relation-type';
import {
  MAX_CELL_H,
  MAX_CELL_W,
  MIN_CELL_H,
  MIN_CELL_W,
} from '../../domain/plot-grid';
import { stringifyKv } from '../../domain/kv';
import {
  parseDocId,
  proseDocId,
  type DocKind,
  type ProseEntityType,
} from '../../lib/yjs-doc-id';
import {
  AgentMemoryTable,
  BookActTable,
  BookElementTable,
  BookNodeTable,
  CommentActionTable,
  CommentTable,
  DriftGroupTable,
  ElementCategoryTable,
  ElementPatchTable,
  EntityKvEntryTable,
  EntityRelationTable,
  EntityRelationTypeEndpointKindTable,
  EntityRelationTypeTable,
  LibraryItemTable,
  NodeContentTable,
  NodeStorylineLinkTable,
  PlotGridCellTable,
  PlotGridColumnTable,
  PlotGridDocumentTable,
  PlotGridRowTable,
  ProjectAssetTable,
  ProjectTable,
  StorylineTable,
  SyncBlobStateTable,
  SyncProviderBindingTable,
  SyncGenerationTable,
  TimelineMarkerTable,
} from '../../schema/drizzle';
import { createProjectAssetSqliteRepository } from '../../sqlite-repo/project-asset-repo';
import { createPlotGridRepository, plotGridDocumentId } from '../../sqlite-repo/plot-grid-repo';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { deleteProjectDataInTransaction } from '../../sqlite-repo/project-deletion-repo';
import { assertFractionalPositionKey } from '../journal/order-authority';
import {
  NODE_PRIMARY_STORYLINE_FIELD,
  NODE_PRIMARY_STORYLINE_REGISTER_KIND,
  STORYLINE_MEMBERSHIP_SET_KIND,
} from '../journal/storyline-membership';
import {
  compareUtf8Bytewise,
  parseProjectAssetMutationV1,
  validateProjectAssetBindSemantics,
  type CanonicalCborValue,
  type ProjectAssetBindPayloadV1,
  type ProjectAssetOwnerV1,
  type SyncMutationAction,
} from '../protocol';
import type {
  SemanticConflictDraft,
  ReducerEffect,
} from './types';
import type {
  SyncDomainMaterializationContext,
  SyncDomainMaterializationKernel,
} from './sqlite-materializer';

type CborRecord = Readonly<Record<string, CanonicalCborValue>>;
type FieldEffect = Extract<ReducerEffect, { type: 'field.set' }>;
type LifecycleEffect = Extract<ReducerEffect, { type: 'entity.lifecycle' }>;
type OrderEffect = Extract<ReducerEffect, { type: 'order.position' }>;
type ExternalEffect = Extract<ReducerEffect, { payload: CanonicalCborValue }>;
type AssetEffect = ExternalEffect & { readonly type: 'asset.bind' | 'asset.unbind' };

const EXTERNAL_ACTIONS = new Set<SyncMutationAction>([
  'yjs.update',
  'asset.bind',
  'asset.unbind',
  'sync-generation.purge',
]);

export const PRODUCTION_DOMAIN_KERNEL_COVERAGE = Object.freeze({
  entityKinds: Object.freeze([
    'project',
    'node',
    'node-content',
    'storyline',
    NODE_PRIMARY_STORYLINE_REGISTER_KIND,
    'element',
    'element-category',
    'element-patch',
    'library-item',
    'entity-relation',
    'entity-relation-type',
    'comment',
    'comment-action',
    'agent-memory',
    'book-act',
    'drift-group',
    'timeline-marker',
    'kv-entry',
    'plot-grid-row',
    'plot-grid-column',
    'plot-grid-cell',
  ]),
  setKinds: Object.freeze(['alias', 'membership']),
  orderKinds: Object.freeze([
    'storyline',
    'drift-group',
    'element-patch',
    'library-item',
    'kv-entry',
    'plot-grid-row',
    'plot-grid-column',
  ]),
  tupleKinds: Object.freeze(['node:graph.position', 'node-content:plot-grid-size']),
  externalActions: Object.freeze([...EXTERNAL_ACTIONS]),
  failClosedKinds: Object.freeze(['chapter']),
  failClosed: Object.freeze([
    'chapter target kind (chapters are node entities with an authored bookOrder field)',
    'retired node-storyline-link lifecycle/whole-array payloads',
    'unknown kind, field, tuple, set, order, payload, or future external action',
  ]),
});

const STRING = (value: CanonicalCborValue): boolean => typeof value === 'string';
const NON_EMPTY_STRING = (value: CanonicalCborValue): boolean =>
  typeof value === 'string' && value.trim().length > 0;
const NULLABLE_STRING = (value: CanonicalCborValue): boolean => value === null || STRING(value);
const BOOLEAN = (value: CanonicalCborValue): boolean => typeof value === 'boolean';
const FINITE_NUMBER = (value: CanonicalCborValue): boolean =>
  typeof value === 'number' && Number.isFinite(value);
const NULLABLE_FINITE_NUMBER = (value: CanonicalCborValue): boolean =>
  value === null || FINITE_NUMBER(value);

function record(value: CanonicalCborValue): CborRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? value as CborRecord
    : null;
}

function stringArray(value: CanonicalCborValue): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function validJson(value: CanonicalCborValue): boolean {
  if (typeof value !== 'string') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function oneOf(...values: readonly string[]) {
  const allowed = new Set(values);
  return (value: CanonicalCborValue): boolean => typeof value === 'string' && allowed.has(value);
}

type FieldValidator = (value: CanonicalCborValue) => boolean;
const FIELD_POLICY: Readonly<Record<string, Readonly<Record<string, FieldValidator>>>> = {
  project: { name: NON_EMPTY_STRING, summary: STRING },
  node: {
    title: NON_EMPTY_STRING,
    summary: STRING,
    bookOrder: NULLABLE_FINITE_NUMBER,
    narrativeOrder: NULLABLE_FINITE_NUMBER,
    writingStatus: oneOf('draft', 'revising', 'done', 'drifting', 'sorted'),
    kind: oneOf('chapter', 'drift'),
    driftGroupId: NULLABLE_STRING,
    deletedAt: NULLABLE_STRING,
  },
  'node-content': {},
  [NODE_PRIMARY_STORYLINE_REGISTER_KIND]: {
    [NODE_PRIMARY_STORYLINE_FIELD]: NULLABLE_STRING,
  },
  storyline: {
    name: NON_EMPTY_STRING,
    color: NON_EMPTY_STRING,
    summary: STRING,
    nodeContentTemplateJson: validJson,
    deletedAt: NULLABLE_STRING,
  },
  element: {
    categoryId: NULLABLE_STRING,
    name: NON_EMPTY_STRING,
    summary: STRING,
    groupName: NULLABLE_STRING,
    portraitAssetId: NULLABLE_STRING,
    deletedAt: NULLABLE_STRING,
  },
  'element-category': {
    name: NON_EMPTY_STRING,
    elementTemplateJson: validJson,
    color: NON_EMPTY_STRING,
    layoutMode: oneOf('auto', 'pinned'),
    gridX: NULLABLE_FINITE_NUMBER,
    gridY: NULLABLE_FINITE_NUMBER,
    deletedAt: NULLABLE_STRING,
  },
  'element-patch': {
    sourceNodeId: NULLABLE_STRING,
    sourceBlockId: NULLABLE_STRING,
    sourceBlockText: NULLABLE_STRING,
    textAnchorJson: (value) => value === null || validJson(value),
    invalidatedAt: NULLABLE_STRING,
    title: NULLABLE_STRING,
    contentJson: validJson,
  },
  'library-item': {
    title: STRING,
    kind: oneOf('image', 'pdf', 'url', 'text'),
    assetId: NULLABLE_STRING,
    externalUrl: NULLABLE_STRING,
    bodyJson: (value) => value === null || validJson(value),
    notesJson: (value) => value === null || validJson(value),
  },
  'entity-relation': {
    fromKind: (value) => isEntityKind(value),
    fromId: NON_EMPTY_STRING,
    toKind: (value) => isStructuralEntityKind(value),
    toId: NON_EMPTY_STRING,
    relationTypeId: NON_EMPTY_STRING,
  },
  'entity-relation-type': {
    name: NON_EMPTY_STRING,
    normalizedName: NON_EMPTY_STRING,
    description: STRING,
    orientation: oneOf('directed', 'symmetric'),
    systemKey: (value) => value === null || value === 'generic-association',
    locked: BOOLEAN,
    sourceRole: STRING,
    targetRole: STRING,
    sourceKinds: (value) => stringArray(value) && value.every(isEntityKind),
    targetKinds: (value) => stringArray(value) && value.every(isStructuralEntityKind),
  },
  comment: {
    kind: oneOf('note', 'todo'),
    targetKind: (value) => value === null || isStructuralEntityKind(value),
    targetId: NULLABLE_STRING,
    targetBlockId: NULLABLE_STRING,
    anchorJson: validJson,
    authorKind: oneOf('user', 'ai', 'copilot', 'external'),
    authorId: NULLABLE_STRING,
    authorName: NULLABLE_STRING,
    bodyJson: validJson,
    status: oneOf('open', 'resolved', 'converted'),
    priority: NULLABLE_STRING,
    source: oneOf('manual', 'copilot', 'api'),
    metadataJson: (value) => value === null || validJson(value),
    targetBlockIdsJson: validJson,
    resolvedAt: NULLABLE_STRING,
  },
  'comment-action': {
    commentId: NON_EMPTY_STRING,
    kind: NON_EMPTY_STRING,
    label: NULLABLE_STRING,
    payloadJson: validJson,
    status: oneOf('pending', 'applied', 'failed'),
    resultJson: (value) => value === null || validJson(value),
    createdByKind: NON_EMPTY_STRING,
    createdById: NULLABLE_STRING,
    appliedAt: NULLABLE_STRING,
  },
  'agent-memory': {
    kind: oneOf('preference', 'veto', 'directive'),
    body: STRING,
    targetKind: NULLABLE_STRING,
    targetId: NULLABLE_STRING,
    targetBlockId: NULLABLE_STRING,
    source: oneOf('author', 'agent'),
    originRef: NULLABLE_STRING,
    status: oneOf('pending', 'active', 'dismissed'),
    supersedesId: NULLABLE_STRING,
    deletedAt: NULLABLE_STRING,
  },
  'book-act': {
    name: NON_EMPTY_STRING,
    color: NULLABLE_STRING,
    startOrder: NULLABLE_FINITE_NUMBER,
    driftNodeId: NULLABLE_STRING,
  },
  'drift-group': { name: NON_EMPTY_STRING, parentGroupId: NULLABLE_STRING, color: NULLABLE_STRING },
  'timeline-marker': { narrativeOrder: FINITE_NUMBER, label: STRING, driftNodeId: NULLABLE_STRING },
  'kv-entry': {
    ownerKind: oneOf('project', 'storyline', 'element-category', 'element'),
    ownerId: NON_EMPTY_STRING,
    namespace: oneOf('facts', 'storyline-template', 'element-template'),
    key: STRING,
    value: STRING,
  },
  'plot-grid-row': { documentId: NON_EMPTY_STRING, label: STRING },
  'plot-grid-column': { documentId: NON_EMPTY_STRING, label: STRING },
  'plot-grid-cell': {
    documentId: NON_EMPTY_STRING,
    rowId: NON_EMPTY_STRING,
    columnId: NON_EMPTY_STRING,
    value: STRING,
  },
};

const SEED_ONLY_POLICY: Readonly<Record<string, Readonly<Record<string, FieldValidator>>>> = {
  node: {
    positionX: FINITE_NUMBER,
    positionY: FINITE_NUMBER,
    // Canonical prose metrics are local projections. They may still appear in
    // a local create seed while the journal migration is being completed, but
    // the remote materializer never writes them.
    wordCount: FINITE_NUMBER,
    wordCountBasisKind: NULLABLE_STRING,
    wordCountBasisHash: NULLABLE_STRING,
    wordCountBasisRevision: NULLABLE_FINITE_NUMBER,
    wordCountBasisServerSeq: NULLABLE_FINITE_NUMBER,
  },
  'element-patch': { elementId: NON_EMPTY_STRING },
};

function conflict(
  effect: ReducerEffect,
  code: string,
  message: string,
  details: CanonicalCborValue = {},
): SemanticConflictDraft {
  return {
    code,
    scope: JSON.stringify([code, effect.target.kind, effect.target.id, effect.target.incarnation]),
    message,
    target: {
      kind: effect.target.kind,
      id: effect.target.id,
      incarnation: effect.target.incarnation,
    },
    details,
    blockedEffectIds: [effect.effectId],
  };
}

function effectsForEntity(effects: readonly ReducerEffect[], kind: string, id: string): readonly ReducerEffect[] {
  return effects.filter((effect) => effect.target.kind === kind && effect.target.id === id);
}

function entityConflict(
  effects: readonly ReducerEffect[],
  effect: ReducerEffect,
  code: string,
  message: string,
  details: CanonicalCborValue = {},
): SemanticConflictDraft {
  return {
    ...conflict(effect, code, message, details),
    blockedEffectIds: effectsForEntity(effects, effect.target.kind, effect.target.id)
      .map(({ effectId }) => effectId),
  };
}

function candidateRecord(effects: readonly ReducerEffect[], kind: string, id: string): CborRecord | null {
  const entityEffects = effectsForEntity(effects, kind, id);
  const lifecycle = entityEffects.find((effect): effect is LifecycleEffect =>
    effect.type === 'entity.lifecycle' && effect.status === 'live' && effect.seed !== null,
  );
  if (!lifecycle?.seed) return null;
  const result: Record<string, CanonicalCborValue> = { ...lifecycle.seed };
  for (const effect of entityEffects) {
    if (effect.type === 'field.set' && effect.materialize) result[effect.field] = effect.value;
  }
  return result;
}

function requiredSeedFields(kind: string): readonly string[] {
  switch (kind) {
    case 'project': return ['name'];
    case 'node': return ['title', 'kind'];
    case 'storyline': return ['name', 'color'];
    case 'element': return ['name'];
    case 'element-category': return ['name', 'color'];
    case 'element-patch': return ['elementId'];
    case 'library-item': return ['title', 'kind'];
    case 'entity-relation': return ['fromKind', 'fromId', 'toKind', 'toId', 'relationTypeId'];
    case 'entity-relation-type': return ['name', 'orientation', 'sourceKinds', 'targetKinds'];
    case 'comment': return ['kind', 'bodyJson'];
    case 'comment-action': return ['commentId', 'kind'];
    case 'agent-memory': return ['kind', 'body'];
    case 'book-act': return ['name'];
    case 'drift-group': return ['name'];
    case 'timeline-marker': return ['narrativeOrder'];
    case 'kv-entry': return ['ownerKind', 'ownerId', 'namespace', 'key', 'value'];
    case 'plot-grid-row':
    case 'plot-grid-column': return ['documentId'];
    case 'plot-grid-cell': return ['documentId', 'rowId', 'columnId'];
    case 'node-content': return [];
    default: return ['__unsupported__'];
  }
}

function lifecycleProseEntityType(kind: string): ProseEntityType | null {
  switch (kind) {
    case 'node': return 'node';
    case 'element': return 'element';
    case 'storyline': return 'storyline';
    case 'element-category': return 'category';
    default: return null;
  }
}

function proseOwnerKind(kind: DocKind): string {
  switch (kind) {
    case 'node-content': return 'node';
    case 'element': return 'element';
    case 'storyline': return 'storyline';
    case 'category': return 'element-category';
  }
}

function validateFieldEffect(effect: FieldEffect): SemanticConflictDraft | null {
  const policy = FIELD_POLICY[effect.target.kind]?.[effect.field];
  if (!policy) {
    return conflict(
      effect,
      'domain.unsupported-field',
      `Sync v1 does not classify ${effect.target.kind}.${effect.field} as a materializable authored field`,
      { field: effect.field },
    );
  }
  if (!policy(effect.value)) {
    return conflict(
      effect,
      'domain.invalid-field-value',
      `Invalid value for ${effect.target.kind}.${effect.field}`,
      { field: effect.field },
    );
  }
  return null;
}

function validateLifecycleEffect(effect: LifecycleEffect): readonly SemanticConflictDraft[] {
  if (effect.target.kind === 'chapter') {
    return [conflict(effect, 'domain.unsupported-kind', 'chapter is not a sync target; chapters are node entities')];
  }
  if (effect.target.kind === NODE_PRIMARY_STORYLINE_REGISTER_KIND) {
    return [conflict(effect, 'membership.register-has-no-lifecycle', 'Primary storyline authority is a field register, not an entity lifecycle')];
  }
  if (!Object.prototype.hasOwnProperty.call(FIELD_POLICY, effect.target.kind)) {
    return [conflict(effect, 'domain.unsupported-kind', `No production materializer exists for ${effect.target.kind}`)];
  }
  if (effect.status === 'unresolved') {
    return [conflict(effect, 'domain.unresolved-lifecycle', 'Unresolved lifecycle cannot materialize')];
  }
  if (effect.status !== 'live' || !effect.seed) return [];
  const issues: SemanticConflictDraft[] = [];
  for (const field of requiredSeedFields(effect.target.kind)) {
    if (field === '__unsupported__' || !Object.prototype.hasOwnProperty.call(effect.seed, field)) {
      issues.push(conflict(
        effect,
        'domain.incomplete-seed',
        `${effect.target.kind} seed is missing ${field}`,
        { field },
      ));
    }
  }
  for (const [field, value] of Object.entries(effect.seed)) {
    if (['id', 'projectId', 'createdAt', 'updatedAt'].includes(field)) continue;
    const validator = FIELD_POLICY[effect.target.kind]?.[field] ?? SEED_ONLY_POLICY[effect.target.kind]?.[field];
    if (!validator) {
      issues.push(conflict(
        effect,
        'domain.unsupported-seed-field',
        `Sync v1 does not classify ${effect.target.kind}.${field}`,
        { field },
      ));
    } else if (validator && !validator(value)) {
      issues.push(conflict(
        effect,
        'domain.invalid-seed-value',
        `Invalid seed value for ${effect.target.kind}.${field}`,
        { field },
      ));
    }
  }
  return issues;
}

function validateTupleEffect(effect: Extract<ReducerEffect, { type: 'tuple.set' }>): SemanticConflictDraft | null {
  const value = record(effect.value);
  if (effect.target.kind === 'node' && effect.tuple === 'graph.position') {
    if (value && FINITE_NUMBER(value.x) && FINITE_NUMBER(value.y) && Object.keys(value).length === 2) return null;
  } else if (effect.target.kind === 'node-content' && effect.tuple === 'plot-grid-size') {
    if (
      value &&
      FINITE_NUMBER(value.cellW) &&
      FINITE_NUMBER(value.cellH) &&
      (value.cellW as number) >= MIN_CELL_W &&
      (value.cellW as number) <= MAX_CELL_W &&
      (value.cellH as number) >= MIN_CELL_H &&
      (value.cellH as number) <= MAX_CELL_H &&
      Object.keys(value).length === 2
    ) return null;
  }
  return conflict(effect, 'domain.unsupported-or-invalid-tuple', `Invalid tuple ${effect.target.kind}.${effect.tuple}`);
}

function validateOrderEffect(effect: OrderEffect): SemanticConflictDraft | null {
  if (!PRODUCTION_DOMAIN_KERNEL_COVERAGE.orderKinds.includes(effect.target.kind as never)) {
    return conflict(effect, 'domain.unsupported-order', `No production order projection exists for ${effect.target.kind}`);
  }
  try {
    assertFractionalPositionKey(effect.positionKey);
  } catch (error) {
    return conflict(effect, 'domain.invalid-order-key', error instanceof Error ? error.message : String(error));
  }
  return null;
}

function validateSetEffect(effect: Extract<ReducerEffect, { type: 'set.member' }>): SemanticConflictDraft | null {
  if (effect.target.kind === 'alias') {
    return typeof effect.value === 'string' || (!effect.present && effect.value === null)
      ? null
      : conflict(effect, 'alias.invalid-value', 'Alias OR-set values must be strings');
  }
  if (effect.target.kind === STORYLINE_MEMBERSHIP_SET_KIND) {
    return effect.value === null
      ? null
      : conflict(effect, 'membership.invalid-value', 'Storyline membership OR-set values must be null');
  }
  return conflict(effect, 'domain.unsupported-set', `No production set projection exists for ${effect.target.kind}`);
}

function liveLifecycleCandidate(
  effects: readonly ReducerEffect[],
  kind: string,
  id: string,
): CborRecord | null | undefined {
  const lifecycle = effects.find((effect): effect is LifecycleEffect =>
    effect.type === 'entity.lifecycle' && effect.target.kind === kind && effect.target.id === id,
  );
  if (!lifecycle) return undefined;
  if (lifecycle.status !== 'live') return null;
  return candidateRecord(effects, kind, id);
}

async function validateLiveChapterAndStoryline(
  context: SyncDomainMaterializationContext,
  effect: ReducerEffect,
  nodeId: string,
  storylineId: string,
): Promise<readonly SemanticConflictDraft[]> {
  const issues: SemanticConflictDraft[] = [];
  const localNode = liveLifecycleCandidate(context.effects, 'node', nodeId);
  const storedNodes = localNode === undefined
    ? await context.tx
        .select({ kind: BookNodeTable.kind, deletedAt: BookNodeTable.deletedAt })
        .from(BookNodeTable)
        .where(and(eq(BookNodeTable.id, nodeId), eq(BookNodeTable.projectId, context.changeSet.projectId)))
        .limit(1)
    : [];
  const nodeKind = localNode?.kind ?? storedNodes[0]?.kind;
  const nodeLive = localNode !== null && (
    localNode !== undefined || (storedNodes[0] !== undefined && storedNodes[0].deletedAt === null)
  );
  if (!nodeLive || nodeKind !== 'chapter') {
    issues.push(conflict(
      effect,
      'membership.invalid-node',
      'Storyline membership requires a live chapter in the same project',
      { nodeId },
    ));
  }

  const localStoryline = liveLifecycleCandidate(context.effects, 'storyline', storylineId);
  const storedStorylines = localStoryline === undefined
    ? await context.tx
        .select({ id: StorylineTable.id, deletedAt: StorylineTable.deletedAt })
        .from(StorylineTable)
        .where(and(eq(StorylineTable.id, storylineId), eq(StorylineTable.projectId, context.changeSet.projectId)))
        .limit(1)
    : [];
  const storylineLive = localStoryline !== null && (
    localStoryline !== undefined ||
    (storedStorylines[0] !== undefined && storedStorylines[0].deletedAt === null)
  );
  if (!storylineLive) {
    issues.push(conflict(
      effect,
      'membership.invalid-storyline',
      'Storyline membership requires a live storyline in the same project',
      { storylineId },
    ));
  }
  return issues;
}

async function validateStorylineMembershipInvariant(
  context: SyncDomainMaterializationContext,
  effect: Extract<ReducerEffect, { type: 'set.member' }>,
): Promise<readonly SemanticConflictDraft[]> {
  if (effect.target.kind !== STORYLINE_MEMBERSHIP_SET_KIND || !effect.present) return [];
  return validateLiveChapterAndStoryline(
    context,
    effect,
    effect.memberId,
    effect.target.id,
  );
}

async function validatePrimaryStorylineInvariant(
  context: SyncDomainMaterializationContext,
  effect: FieldEffect,
): Promise<readonly SemanticConflictDraft[]> {
  if (
    effect.target.kind !== NODE_PRIMARY_STORYLINE_REGISTER_KIND ||
    effect.field !== NODE_PRIMARY_STORYLINE_FIELD ||
    effect.value === null
  ) return [];
  const storylineId = effect.value as string;
  const issues = [...await validateLiveChapterAndStoryline(
    context,
    effect,
    effect.target.id,
    storylineId,
  )];
  const canonicalMembership = context.effects.find(
    (candidate): candidate is Extract<ReducerEffect, { type: 'set.member' }> =>
      candidate.type === 'set.member' &&
      candidate.target.kind === STORYLINE_MEMBERSHIP_SET_KIND &&
      candidate.target.id === storylineId &&
      candidate.memberId === effect.target.id,
  );
  const storedMembership = canonicalMembership
    ? canonicalMembership.present
    : (await context.tx
        .select({ nodeId: NodeStorylineLinkTable.nodeId })
        .from(NodeStorylineLinkTable)
        .where(
          and(
            eq(NodeStorylineLinkTable.nodeId, effect.target.id),
            eq(NodeStorylineLinkTable.storylineId, storylineId),
          ),
        )
        .limit(1))[0] !== undefined;
  if (!storedMembership) {
    issues.push(conflict(
      effect,
      'membership.primary-not-member',
      'Primary storyline must reference a currently present OR-set membership',
      { storylineId },
    ));
  }
  return issues;
}

function parseYjsPayload(effect: Extract<ReducerEffect, { type: 'yjs.update' }>): Uint8Array | null {
  const payload = record(effect.payload);
  return payload?.update instanceof Uint8Array && payload.update.byteLength > 0
    ? payload.update
    : null;
}

async function validateExternalEffect(
  context: SyncDomainMaterializationContext,
  effect: Extract<ReducerEffect, { type: 'yjs.update' | 'asset.bind' | 'asset.unbind' | 'sync-generation.purge' }>,
): Promise<readonly SemanticConflictDraft[]> {
  if (effect.type === 'yjs.update') {
    const update = parseYjsPayload(effect);
    const parsedDoc = parseDocId(effect.target.id);
    if (!update || !parsedDoc || effect.target.kind !== 'prose-document') {
      return [conflict(effect, 'yjs.invalid-update', 'Yjs update requires a canonical prose doc id and non-empty byte update')];
    }
    try {
      const ownerKind = proseOwnerKind(parsedDoc.kind);
      let ownerExists = Boolean(
        candidateRecord(context.effects, ownerKind, parsedDoc.entityId),
      );
      if (parsedDoc.kind === 'node-content') {
        ownerExists ||= (await context.tx.select({ id: BookNodeTable.id }).from(BookNodeTable).where(and(eq(BookNodeTable.id, parsedDoc.entityId), eq(BookNodeTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
      } else if (parsedDoc.kind === 'element') {
        ownerExists ||= (await context.tx.select({ id: BookElementTable.id }).from(BookElementTable).where(and(eq(BookElementTable.id, parsedDoc.entityId), eq(BookElementTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
      } else if (parsedDoc.kind === 'storyline') {
        ownerExists ||= (await context.tx.select({ id: StorylineTable.id }).from(StorylineTable).where(and(eq(StorylineTable.id, parsedDoc.entityId), eq(StorylineTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
      } else {
        ownerExists ||= (await context.tx.select({ id: ElementCategoryTable.id }).from(ElementCategoryTable).where(and(eq(ElementCategoryTable.id, parsedDoc.entityId), eq(ElementCategoryTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
      }
      if (!ownerExists) {
        return [conflict(effect, 'yjs.missing-owner', 'Yjs document owner does not exist in this project')];
      }
      const document = new Y.Doc();
      const repository = createYjsRepository(context.tx);
      const snapshot = await repository.getSnapshot(effect.target.id);
      if (snapshot) Y.applyUpdate(document, snapshot.stateBlob);
      for (const existing of await repository.listUpdates(effect.target.id)) {
        Y.applyUpdate(document, existing.updateBlob);
      }
      Y.applyUpdate(document, update);
      return [];
    } catch (error) {
      return [conflict(effect, 'yjs.invalid-update', error instanceof Error ? error.message : String(error))];
    }
  }
  if (effect.type === 'asset.bind' || effect.type === 'asset.unbind') {
    const parsed = parseProjectAssetMutationV1({
      action: effect.type,
      target: effect.target,
      payload: effect.payload,
    });
    if (!parsed.ok || parsed.value.action !== effect.type) {
      return [conflict(effect, 'asset.invalid-payload', 'Asset mutation payload does not match the protocol schema')];
    }
    if (parsed.value.action === 'asset.bind') {
      const semantic = validateProjectAssetBindSemantics(parsed.value.payload);
      if (semantic.length > 0) {
        return [conflict(effect, 'asset.invalid-metadata', semantic.map(({ message }) => message).join('; '))];
      }
      const blob = await context.tx
        .select({ localState: SyncBlobStateTable.localState })
        .from(SyncBlobStateTable)
        .where(and(
          eq(SyncBlobStateTable.syncGenerationId, context.changeSet.syncGenerationId),
          eq(SyncBlobStateTable.blobId, parsed.value.payload.blobId),
        ))
        .limit(1);
      if (blob[0]?.localState !== 'verified') {
        return [conflict(effect, 'asset.blob-not-verified', 'Asset owner cannot materialize before its blob is locally verified')];
      }
      const payload = parsed.value.payload;
      const sourceSha256 = payload.sourceSha256.slice('sha256:'.length);
      const existing = await context.tx.select().from(ProjectAssetTable).where(eq(ProjectAssetTable.id, effect.target.id)).limit(1);
      if (existing[0] && (
        existing[0].projectId !== context.changeSet.projectId ||
        existing[0].kind !== payload.kind ||
        existing[0].sourceMime !== payload.sourceMime ||
        existing[0].sourceSizeBytes !== payload.sourceSizeBytes ||
        existing[0].sourceSha256 !== sourceSha256 ||
        existing[0].width !== payload.width ||
        existing[0].height !== payload.height
      )) {
        return [conflict(effect, 'asset.immutable-metadata-mismatch', 'Asset identity already has different immutable metadata')];
      }
      if (payload.owner.kind === 'element-portrait') {
        const owners = await context.tx.select({ id: BookElementTable.id, portraitAssetId: BookElementTable.portraitAssetId }).from(BookElementTable).where(and(eq(BookElementTable.id, payload.owner.id), eq(BookElementTable.projectId, context.changeSet.projectId))).limit(1);
        if (payload.kind !== 'image' || !owners[0] || (owners[0].portraitAssetId !== null && owners[0].portraitAssetId !== effect.target.id)) {
          return [conflict(effect, 'asset.invalid-owner', 'Portrait assets require an existing unbound element and image metadata')];
        }
      } else {
        const owners = await context.tx.select({ id: LibraryItemTable.id, kind: LibraryItemTable.kind, assetId: LibraryItemTable.assetId }).from(LibraryItemTable).where(and(eq(LibraryItemTable.id, payload.owner.id), eq(LibraryItemTable.projectId, context.changeSet.projectId))).limit(1);
        if (!owners[0] || owners[0].kind !== payload.kind || (owners[0].assetId !== null && owners[0].assetId !== effect.target.id)) {
          return [conflict(effect, 'asset.invalid-owner', 'Asset kind must match an existing unbound library item')];
        }
      }
      const [otherElements, otherLibraryItems] = await Promise.all([
        context.tx.select({ id: BookElementTable.id }).from(BookElementTable).where(and(eq(BookElementTable.portraitAssetId, effect.target.id), ne(BookElementTable.id, payload.owner.id))).limit(1),
        context.tx.select({ id: LibraryItemTable.id }).from(LibraryItemTable).where(and(eq(LibraryItemTable.assetId, effect.target.id), ne(LibraryItemTable.id, payload.owner.id))).limit(1),
      ]);
      if (otherElements[0] || otherLibraryItems[0]) {
        return [conflict(effect, 'asset.multiple-owners', 'An asset can have exactly one owner')];
      }
    }
    return [];
  }
  if (
    effect.target.kind !== 'sync-generation' ||
    effect.target.id !== context.changeSet.syncGenerationId ||
    record(effect.payload) === null ||
    Object.keys(record(effect.payload)!).length !== 0
  ) {
    return [conflict(effect, 'generation.invalid-purge', 'sync-generation.purge must target the current SyncGeneration with an empty payload')];
  }
  return [];
}

function winningIso(effect: ReducerEffect): string {
  const wallMs = 'order' in effect && effect.order ? effect.order.hlc.wallMs : Date.now();
  const date = new Date(wallMs);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

function baseSeed(context: SyncDomainMaterializationContext, effect: LifecycleEffect): Record<string, unknown> {
  return {
    ...(effect.seed ?? {}),
    id: effect.target.id,
    projectId: context.changeSet.projectId,
    createdAt: winningIso(effect),
    updatedAt: winningIso(effect),
  };
}

async function upsertLifecycleLive(
  context: SyncDomainMaterializationContext,
  effect: LifecycleEffect,
): Promise<void> {
  const seed = baseSeed(context, effect);
  switch (effect.target.kind) {
    case 'project':
      await context.tx.insert(ProjectTable).values({
        id: effect.target.id,
        name: seed.name as string,
        summary: (seed.summary as string | undefined) ?? '',
        userId: 'local-sync',
        createdAt: seed.createdAt as string,
        updatedAt: seed.updatedAt as string,
      }).onConflictDoUpdate({ target: ProjectTable.id, set: { name: seed.name as string, summary: (seed.summary as string | undefined) ?? '', updatedAt: seed.updatedAt as string } });
      return;
    case 'node':
      {
      const values = {
        id: effect.target.id,
        title: seed.title as string,
        summary: (seed.summary as string | undefined) ?? '',
        bookOrder:
          seed.kind === 'chapter'
            ? ((seed.bookOrder as number | null | undefined) ?? 0)
            : null,
        narrativeOrder: (seed.narrativeOrder as number | null | undefined) ?? null,
        projectId: context.changeSet.projectId,
        writingStatus: (seed.writingStatus as string | undefined) ?? ((seed.kind === 'drift') ? 'drifting' : 'draft'),
        kind: seed.kind as string,
        driftGroupId: (seed.driftGroupId as string | null | undefined) ?? null,
        positionX: (seed.positionX as number | undefined) ?? 0,
        positionY: (seed.positionY as number | undefined) ?? 0,
        createdAt: seed.createdAt as string,
        updatedAt: seed.updatedAt as string,
        deletedAt: null,
      } satisfies typeof BookNodeTable.$inferInsert;
      await context.tx.insert(BookNodeTable).values(values).onConflictDoUpdate({
        target: BookNodeTable.id,
        set: {
          title: values.title,
          summary: values.summary,
          bookOrder: values.bookOrder,
          narrativeOrder: values.narrativeOrder,
          projectId: values.projectId,
          writingStatus: values.writingStatus,
          kind: values.kind,
          driftGroupId: values.driftGroupId,
          positionX: values.positionX,
          positionY: values.positionY,
          deletedAt: null,
          updatedAt: values.updatedAt,
        },
      });
      await context.tx.insert(NodeContentTable).values({
        nodeId: effect.target.id,
        contentJson: '{}',
        createdAt: seed.createdAt as string,
        updatedAt: seed.updatedAt as string,
      }).onConflictDoNothing();
      return;
      }
    case 'node-content':
      await context.tx.insert(NodeContentTable).values({ nodeId: effect.target.id, contentJson: (seed.contentJson as string | undefined) ?? '{}', createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'storyline':
      await context.tx.insert(StorylineTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, name: seed.name as string, color: seed.color as string, summary: (seed.summary as string | undefined) ?? '', orderKey: 0, contentJson: '{}', nodeContentTemplateJson: (seed.nodeContentTemplateJson as string | undefined) ?? '{}', deletedAt: null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoUpdate({ target: StorylineTable.id, set: { projectId: context.changeSet.projectId, name: seed.name as string, color: seed.color as string, summary: (seed.summary as string | undefined) ?? '', nodeContentTemplateJson: (seed.nodeContentTemplateJson as string | undefined) ?? '{}', deletedAt: null, updatedAt: seed.updatedAt as string } });
      return;
    case 'element':
      await context.tx.insert(BookElementTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, categoryId: (seed.categoryId as string | null | undefined) ?? null, name: seed.name as string, summary: (seed.summary as string | undefined) ?? '', contentJson: '{}', groupName: (seed.groupName as string | null | undefined) ?? null, portraitAssetId: (seed.portraitAssetId as string | null | undefined) ?? null, deletedAt: null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoUpdate({ target: BookElementTable.id, set: { projectId: context.changeSet.projectId, categoryId: (seed.categoryId as string | null | undefined) ?? null, name: seed.name as string, summary: (seed.summary as string | undefined) ?? '', groupName: (seed.groupName as string | null | undefined) ?? null, portraitAssetId: (seed.portraitAssetId as string | null | undefined) ?? null, deletedAt: null, updatedAt: seed.updatedAt as string } });
      return;
    case 'element-category':
      await context.tx.insert(ElementCategoryTable).values({ id: effect.target.id, name: seed.name as string, contentJson: '{}', elementTemplateJson: (seed.elementTemplateJson as string | undefined) ?? '{}', color: seed.color as string, projectId: context.changeSet.projectId, layoutMode: (seed.layoutMode as string | undefined) ?? 'auto', gridX: (seed.gridX as number | null | undefined) ?? null, gridY: (seed.gridY as number | null | undefined) ?? null, deletedAt: null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoUpdate({ target: ElementCategoryTable.id, set: { name: seed.name as string, elementTemplateJson: (seed.elementTemplateJson as string | undefined) ?? '{}', color: seed.color as string, projectId: context.changeSet.projectId, layoutMode: (seed.layoutMode as string | undefined) ?? 'auto', gridX: (seed.gridX as number | null | undefined) ?? null, gridY: (seed.gridY as number | null | undefined) ?? null, deletedAt: null, updatedAt: seed.updatedAt as string } });
      return;
    case 'element-patch':
      await context.tx.insert(ElementPatchTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, elementId: seed.elementId as string, sourceNodeId: (seed.sourceNodeId as string | null | undefined) ?? null, sourceBlockId: (seed.sourceBlockId as string | null | undefined) ?? null, sourceBlockText: (seed.sourceBlockText as string | null | undefined) ?? null, textAnchorJson: (seed.textAnchorJson as string | null | undefined) ?? null, invalidatedAt: (seed.invalidatedAt as string | null | undefined) ?? null, title: (seed.title as string | null | undefined) ?? null, contentJson: (seed.contentJson as string | undefined) ?? '{}', orderKey: 0, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'library-item':
      await context.tx.insert(LibraryItemTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, title: seed.title as string, kind: seed.kind as string, assetId: (seed.assetId as string | null | undefined) ?? null, externalUrl: (seed.externalUrl as string | null | undefined) ?? null, bodyJson: (seed.bodyJson as string | null | undefined) ?? null, notesJson: (seed.notesJson as string | null | undefined) ?? null, orderKey: 0, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'entity-relation':
      await context.tx.insert(EntityRelationTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, fromKind: seed.fromKind as string, fromId: seed.fromId as string, toKind: seed.toKind as string, toId: seed.toId as string, relationTypeId: seed.relationTypeId as string, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'entity-relation-type': {
      await context.tx.insert(EntityRelationTypeTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, name: seed.name as string, normalizedName: normalizeRelationTypeName(seed.name as string), description: (seed.description as string | undefined) ?? '', orientation: seed.orientation as string, systemKey: (seed.systemKey as string | null | undefined) ?? null, locked: seed.locked === true, sourceRole: (seed.sourceRole as string | undefined) ?? '', targetRole: (seed.targetRole as string | undefined) ?? '', createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      await replaceRelationTypeEndpoints(context, effect.target.id, seed.sourceKinds as string[], seed.targetKinds as string[]);
      return;
    }
    case 'comment':
      await context.tx.insert(CommentTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, kind: seed.kind as string, targetKind: (seed.targetKind as string | null | undefined) ?? null, targetId: (seed.targetId as string | null | undefined) ?? null, targetBlockId: (seed.targetBlockId as string | null | undefined) ?? null, anchorJson: (seed.anchorJson as string | undefined) ?? '{}', authorKind: (seed.authorKind as string | undefined) ?? 'user', authorId: (seed.authorId as string | null | undefined) ?? null, authorName: (seed.authorName as string | null | undefined) ?? null, bodyJson: seed.bodyJson as string, status: (seed.status as string | undefined) ?? 'open', priority: (seed.priority as string | null | undefined) ?? null, source: (seed.source as string | undefined) ?? 'manual', metadataJson: (seed.metadataJson as string | null | undefined) ?? null, targetBlockIdsJson: (seed.targetBlockIdsJson as string | undefined) ?? '[]', resolvedAt: (seed.resolvedAt as string | null | undefined) ?? null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'comment-action':
      await context.tx.insert(CommentActionTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, commentId: seed.commentId as string, kind: seed.kind as string, label: (seed.label as string | null | undefined) ?? null, payloadJson: (seed.payloadJson as string | undefined) ?? '{}', status: (seed.status as string | undefined) ?? 'pending', resultJson: (seed.resultJson as string | null | undefined) ?? null, createdByKind: (seed.createdByKind as string | undefined) ?? 'user', createdById: (seed.createdById as string | null | undefined) ?? null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string, appliedAt: (seed.appliedAt as string | null | undefined) ?? null }).onConflictDoNothing();
      return;
    case 'agent-memory':
      await context.tx.insert(AgentMemoryTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, kind: seed.kind as string, body: seed.body as string, targetKind: (seed.targetKind as string | null | undefined) ?? null, targetId: (seed.targetId as string | null | undefined) ?? null, targetBlockId: (seed.targetBlockId as string | null | undefined) ?? null, source: (seed.source as string | undefined) ?? 'agent', originRef: (seed.originRef as string | null | undefined) ?? null, status: (seed.status as string | undefined) ?? 'pending', supersedesId: (seed.supersedesId as string | null | undefined) ?? null, deletedAt: (seed.deletedAt as string | null | undefined) ?? null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'book-act':
      await context.tx.insert(BookActTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, name: seed.name as string, color: (seed.color as string | null | undefined) ?? null, startOrder: (seed.startOrder as number | null | undefined) ?? null, driftNodeId: (seed.driftNodeId as string | null | undefined) ?? null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'drift-group':
      await context.tx.insert(DriftGroupTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, name: seed.name as string, parentGroupId: (seed.parentGroupId as string | null | undefined) ?? null, color: (seed.color as string | null | undefined) ?? null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'timeline-marker':
      await context.tx.insert(TimelineMarkerTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, narrativeOrder: seed.narrativeOrder as number, label: (seed.label as string | undefined) ?? '', driftNodeId: (seed.driftNodeId as string | null | undefined) ?? null, createdAt: seed.createdAt as string, updatedAt: seed.updatedAt as string }).onConflictDoNothing();
      return;
    case 'kv-entry':
      await context.tx.insert(EntityKvEntryTable).values({ id: effect.target.id, projectId: context.changeSet.projectId, ownerKind: seed.ownerKind as string, ownerId: seed.ownerId as string, namespace: seed.namespace as string, key: seed.key as string, value: seed.value as string }).onConflictDoNothing();
      return;
    case 'plot-grid-row':
      await context.tx.insert(PlotGridRowTable).values({ id: effect.target.id, documentId: seed.documentId as string, positionKey: 'pending', label: (seed.label as string | undefined) ?? '' }).onConflictDoNothing();
      return;
    case 'plot-grid-column':
      await context.tx.insert(PlotGridColumnTable).values({ id: effect.target.id, documentId: seed.documentId as string, positionKey: 'pending', label: (seed.label as string | undefined) ?? '' }).onConflictDoNothing();
      return;
    case 'plot-grid-cell':
      await context.tx.insert(PlotGridCellTable).values({ id: effect.target.id, documentId: seed.documentId as string, rowId: seed.rowId as string, columnId: seed.columnId as string, value: (seed.value as string | undefined) ?? '' }).onConflictDoNothing();
      return;
  }
}

async function replaceRelationTypeEndpoints(
  context: SyncDomainMaterializationContext,
  relationTypeId: string,
  sourceKinds: readonly string[],
  targetKinds: readonly string[],
): Promise<void> {
  const values = [
    ...sourceKinds.map((entityKind) => ({ relationTypeId, side: 'source', entityKind })),
    ...targetKinds.map((entityKind) => ({ relationTypeId, side: 'target', entityKind })),
  ];
  const existing = await context.tx
    .select({
      side: EntityRelationTypeEndpointKindTable.side,
      entityKind: EntityRelationTypeEndpointKindTable.entityKind,
    })
    .from(EntityRelationTypeEndpointKindTable)
    .where(eq(EntityRelationTypeEndpointKindTable.relationTypeId, relationTypeId));
  const endpointKey = ({ side, entityKind }: { side: string; entityKind: string }) =>
    `${side}\u0000${entityKind}`;
  const existingKeys = existing.map(endpointKey).sort(compareUtf8Bytewise);
  const desiredKeys = values.map(endpointKey).sort(compareUtf8Bytewise);
  if (
    existingKeys.length === desiredKeys.length &&
    existingKeys.every((key, index) => key === desiredKeys[index])
  ) {
    // The reducer replays the complete canonical projection for every remote
    // change-set. Re-materializing an unchanged locked built-in must be a
    // genuine no-op: its SQLite protection trigger intentionally forbids the
    // delete-and-reinsert sequence used for editable relation types.
    return;
  }

  if (existing.length === 0) {
    // Initial creation (and safe repair of a wholly missing projection) only
    // inserts endpoints. The locked built-in trigger still validates every
    // inserted kind, while no protected row is deleted or updated.
    if (values.length > 0) {
      await context.tx.insert(EntityRelationTypeEndpointKindTable).values(values);
    }
    return;
  }

  const relationType = await context.tx
    .select({ locked: EntityRelationTypeTable.locked })
    .from(EntityRelationTypeTable)
    .where(eq(EntityRelationTypeTable.id, relationTypeId))
    .limit(1);
  if (relationType[0]?.locked) {
    throw new Error(`Locked relation type ${relationTypeId} has non-canonical endpoints`);
  }

  await context.tx.delete(EntityRelationTypeEndpointKindTable).where(eq(EntityRelationTypeEndpointKindTable.relationTypeId, relationTypeId));
  if (values.length > 0) await context.tx.insert(EntityRelationTypeEndpointKindTable).values(values);
}

async function materializeField(context: SyncDomainMaterializationContext, effect: FieldEffect): Promise<void> {
  const updatedAt = winningIso(effect);
  const value = effect.value as never;
  switch (effect.target.kind) {
    case 'project': await context.tx.update(ProjectTable).set({ [effect.field]: value, updatedAt }).where(and(eq(ProjectTable.id, effect.target.id), eq(ProjectTable.id, context.changeSet.projectId))); return;
    case 'node': await context.tx.update(BookNodeTable).set({ [effect.field]: value, updatedAt }).where(and(eq(BookNodeTable.id, effect.target.id), eq(BookNodeTable.projectId, context.changeSet.projectId))); return;
    case 'node-content': await context.tx.update(NodeContentTable).set({ [effect.field]: value, updatedAt }).where(eq(NodeContentTable.nodeId, effect.target.id)); return;
    case NODE_PRIMARY_STORYLINE_REGISTER_KIND:
      await context.tx
        .update(NodeStorylineLinkTable)
        .set({ isPrimary: false })
        .where(eq(NodeStorylineLinkTable.nodeId, effect.target.id));
      if (typeof effect.value === 'string') {
        await context.tx
          .update(NodeStorylineLinkTable)
          .set({ isPrimary: true })
          .where(
            and(
              eq(NodeStorylineLinkTable.nodeId, effect.target.id),
              eq(NodeStorylineLinkTable.storylineId, effect.value),
            ),
          );
      }
      return;
    case 'storyline': await context.tx.update(StorylineTable).set({ [effect.field]: value, updatedAt }).where(and(eq(StorylineTable.id, effect.target.id), eq(StorylineTable.projectId, context.changeSet.projectId))); return;
    case 'element': await context.tx.update(BookElementTable).set({ [effect.field]: value, updatedAt }).where(and(eq(BookElementTable.id, effect.target.id), eq(BookElementTable.projectId, context.changeSet.projectId))); return;
    case 'element-category': await context.tx.update(ElementCategoryTable).set({ [effect.field]: value, updatedAt }).where(and(eq(ElementCategoryTable.id, effect.target.id), eq(ElementCategoryTable.projectId, context.changeSet.projectId))); return;
    case 'element-patch': await context.tx.update(ElementPatchTable).set({ [effect.field]: value, updatedAt }).where(and(eq(ElementPatchTable.id, effect.target.id), eq(ElementPatchTable.projectId, context.changeSet.projectId))); return;
    case 'library-item': await context.tx.update(LibraryItemTable).set({ [effect.field]: value, updatedAt }).where(and(eq(LibraryItemTable.id, effect.target.id), eq(LibraryItemTable.projectId, context.changeSet.projectId))); return;
    case 'entity-relation': await context.tx.update(EntityRelationTable).set({ [effect.field]: value, updatedAt }).where(and(eq(EntityRelationTable.id, effect.target.id), eq(EntityRelationTable.projectId, context.changeSet.projectId))); return;
    case 'entity-relation-type':
      if (effect.field === 'sourceKinds' || effect.field === 'targetKinds') {
        const sourceKinds = effect.field === 'sourceKinds' ? effect.value as string[] : await endpointKinds(context, effect.target.id, 'source');
        const targetKinds = effect.field === 'targetKinds' ? effect.value as string[] : await endpointKinds(context, effect.target.id, 'target');
        await replaceRelationTypeEndpoints(context, effect.target.id, sourceKinds, targetKinds);
      } else {
        const next = effect.field === 'name'
          ? { name: effect.value as string, normalizedName: normalizeRelationTypeName(effect.value as string), updatedAt }
          : { [effect.field]: value, updatedAt };
        await context.tx.update(EntityRelationTypeTable).set(next).where(and(eq(EntityRelationTypeTable.id, effect.target.id), eq(EntityRelationTypeTable.projectId, context.changeSet.projectId)));
      }
      return;
    case 'comment': await context.tx.update(CommentTable).set({ [effect.field]: value, updatedAt }).where(and(eq(CommentTable.id, effect.target.id), eq(CommentTable.projectId, context.changeSet.projectId))); return;
    case 'comment-action': await context.tx.update(CommentActionTable).set({ [effect.field]: value, updatedAt }).where(and(eq(CommentActionTable.id, effect.target.id), eq(CommentActionTable.projectId, context.changeSet.projectId))); return;
    case 'agent-memory': await context.tx.update(AgentMemoryTable).set({ [effect.field]: value, updatedAt }).where(and(eq(AgentMemoryTable.id, effect.target.id), eq(AgentMemoryTable.projectId, context.changeSet.projectId))); return;
    case 'book-act': await context.tx.update(BookActTable).set({ [effect.field]: value, updatedAt }).where(and(eq(BookActTable.id, effect.target.id), eq(BookActTable.projectId, context.changeSet.projectId))); return;
    case 'drift-group': await context.tx.update(DriftGroupTable).set({ [effect.field]: value, updatedAt }).where(and(eq(DriftGroupTable.id, effect.target.id), eq(DriftGroupTable.projectId, context.changeSet.projectId))); return;
    case 'timeline-marker': await context.tx.update(TimelineMarkerTable).set({ [effect.field]: value, updatedAt }).where(and(eq(TimelineMarkerTable.id, effect.target.id), eq(TimelineMarkerTable.projectId, context.changeSet.projectId))); return;
    case 'kv-entry': await context.tx.update(EntityKvEntryTable).set({ [effect.field]: value }).where(and(eq(EntityKvEntryTable.id, effect.target.id), eq(EntityKvEntryTable.projectId, context.changeSet.projectId))); return;
    case 'plot-grid-row': await context.tx.update(PlotGridRowTable).set({ [effect.field]: value }).where(eq(PlotGridRowTable.id, effect.target.id)); return;
    case 'plot-grid-column': await context.tx.update(PlotGridColumnTable).set({ [effect.field]: value }).where(eq(PlotGridColumnTable.id, effect.target.id)); return;
    case 'plot-grid-cell': await context.tx.update(PlotGridCellTable).set({ [effect.field]: value }).where(eq(PlotGridCellTable.id, effect.target.id)); return;
  }
}

async function endpointKinds(context: SyncDomainMaterializationContext, relationTypeId: string, side: 'source' | 'target'): Promise<string[]> {
  const rows = await context.tx.select({ entityKind: EntityRelationTypeEndpointKindTable.entityKind }).from(EntityRelationTypeEndpointKindTable).where(and(eq(EntityRelationTypeEndpointKindTable.relationTypeId, relationTypeId), eq(EntityRelationTypeEndpointKindTable.side, side)));
  return rows.map(({ entityKind }) => entityKind);
}

async function materializeTuple(context: SyncDomainMaterializationContext, effect: Extract<ReducerEffect, { type: 'tuple.set' }>): Promise<void> {
  const value = record(effect.value)!;
  if (effect.target.kind === 'node') {
    await context.tx.update(BookNodeTable).set({ positionX: value.x as number, positionY: value.y as number, updatedAt: winningIso(effect) }).where(and(eq(BookNodeTable.id, effect.target.id), eq(BookNodeTable.projectId, context.changeSet.projectId)));
    return;
  }
  const documentId = plotGridDocumentId(effect.target.id);
  await context.tx.insert(PlotGridDocumentTable).values({ id: documentId, nodeId: effect.target.id, cellWidth: value.cellW as number, cellHeight: value.cellH as number }).onConflictDoUpdate({ target: PlotGridDocumentTable.id, set: { cellWidth: value.cellW as number, cellHeight: value.cellH as number } });
}

async function rebuildNormalizedProjections(
  context: SyncDomainMaterializationContext,
  effects: readonly ReducerEffect[],
  affectedGridNodeIds: ReadonlySet<string>,
): Promise<void> {
  const kvRows = await context.tx.select().from(EntityKvEntryTable).where(eq(EntityKvEntryTable.projectId, context.changeSet.projectId));
  const positions = new Map(
    effects
      .filter((effect): effect is OrderEffect => effect.type === 'order.position' && effect.target.kind === 'kv-entry' && effect.materialize)
      .map((effect) => [effect.entityId, effect.positionKey]),
  );
  const owners = new Map<string, typeof kvRows>();
  for (const row of kvRows) {
    const key = JSON.stringify([row.ownerKind, row.ownerId, row.namespace]);
    const rows = owners.get(key) ?? [];
    rows.push(row);
    owners.set(key, rows);
  }
  for (const [scope, rows] of owners) {
    if (rows.some((row) => !positions.has(row.id))) continue;
    rows.sort((left, right) =>
      compareUtf8Bytewise(positions.get(left.id)!, positions.get(right.id)!) ||
      compareUtf8Bytewise(left.id, right.id),
    );
    const projection = stringifyKv(rows.map(({ key, value }) => ({ key, value })));
    const [ownerKind, ownerId, namespace] = JSON.parse(scope) as [string, string, string];
    if (ownerKind === 'project' && namespace === 'facts') {
      await context.tx.update(ProjectTable).set({ kvJson: projection }).where(eq(ProjectTable.id, ownerId));
    } else if (ownerKind === 'project' && namespace === 'storyline-template') {
      await context.tx.update(ProjectTable).set({ storylineTemplateKvJson: projection }).where(eq(ProjectTable.id, ownerId));
    } else if (ownerKind === 'storyline') {
      await context.tx.update(StorylineTable).set({ kvJson: projection }).where(eq(StorylineTable.id, ownerId));
    } else if (ownerKind === 'element-category') {
      await context.tx.update(ElementCategoryTable).set({ elementTemplateKvJson: projection }).where(eq(ElementCategoryTable.id, ownerId));
    } else if (ownerKind === 'element') {
      await context.tx.update(BookElementTable).set({ kvJson: projection }).where(eq(BookElementTable.id, ownerId));
    }
  }

  const gridNodeIds = new Set(affectedGridNodeIds);
  for (const effect of effects) {
    if (effect.type === 'tuple.set' && effect.target.kind === 'node-content' && effect.tuple === 'plot-grid-size') {
      gridNodeIds.add(effect.target.id);
    }
    if (effect.target.kind.startsWith('plot-grid-')) {
      const candidate = effect.type === 'entity.lifecycle' && effect.seed
        ? effect.seed.documentId
        : null;
      if (typeof candidate === 'string' && candidate.startsWith('plot-grid:')) {
        gridNodeIds.add(candidate.slice('plot-grid:'.length));
      }
    }
  }
  const repository = createPlotGridRepository(context.tx);
  for (const nodeId of gridNodeIds) {
    const projection = await repository.materializeProjection(nodeId);
    if (projection !== null) {
      await context.tx.update(NodeContentTable).set({ plotGridJson: projection, updatedAt: winningIso(effects[0]) }).where(eq(NodeContentTable.nodeId, nodeId));
    }
  }
}

async function collectAffectedGridNodeIds(
  context: SyncDomainMaterializationContext,
  effects: readonly ReducerEffect[],
): Promise<ReadonlySet<string>> {
  const nodeIds = new Set<string>();
  const documentIds = new Set<string>();
  for (const effect of effects) {
    if (effect.type === 'tuple.set' && effect.target.kind === 'node-content' && effect.tuple === 'plot-grid-size') {
      nodeIds.add(effect.target.id);
    }
    if (effect.type === 'order.position' && (effect.target.kind === 'plot-grid-row' || effect.target.kind === 'plot-grid-column')) {
      documentIds.add(effect.scope);
    }
    if (effect.type === 'entity.lifecycle' && effect.seed && typeof effect.seed.documentId === 'string') {
      documentIds.add(effect.seed.documentId);
    }
    if (effect.target.kind === 'plot-grid-row') {
      const rows = await context.tx.select({ documentId: PlotGridRowTable.documentId }).from(PlotGridRowTable).where(eq(PlotGridRowTable.id, effect.target.id)).limit(1);
      if (rows[0]) documentIds.add(rows[0].documentId);
    } else if (effect.target.kind === 'plot-grid-column') {
      const rows = await context.tx.select({ documentId: PlotGridColumnTable.documentId }).from(PlotGridColumnTable).where(eq(PlotGridColumnTable.id, effect.target.id)).limit(1);
      if (rows[0]) documentIds.add(rows[0].documentId);
    } else if (effect.target.kind === 'plot-grid-cell') {
      const rows = await context.tx.select({ documentId: PlotGridCellTable.documentId }).from(PlotGridCellTable).where(eq(PlotGridCellTable.id, effect.target.id)).limit(1);
      if (rows[0]) documentIds.add(rows[0].documentId);
    }
  }
  if (documentIds.size > 0) {
    const documents = await context.tx.select({ id: PlotGridDocumentTable.id, nodeId: PlotGridDocumentTable.nodeId }).from(PlotGridDocumentTable);
    for (const row of documents) if (documentIds.has(row.id)) nodeIds.add(row.nodeId);
  }
  return nodeIds;
}

async function materializeOrder(context: SyncDomainMaterializationContext, effect: OrderEffect): Promise<void> {
  const ordered = context.effects
    .filter(
      (candidate): candidate is OrderEffect =>
        candidate.type === 'order.position' &&
        candidate.materialize &&
        candidate.target.kind === effect.target.kind &&
        candidate.scope === effect.scope,
    )
    .sort(
      (left, right) =>
        compareUtf8Bytewise(left.positionKey, right.positionKey) ||
        compareUtf8Bytewise(left.entityId, right.entityId),
    );
  const rank = ordered.findIndex((candidate) => candidate.entityId === effect.entityId);
  if (rank < 0) throw new Error(`order projection rank is missing for ${effect.target.kind}:${effect.entityId}`);
  // Local authored writers already own their semantic `updatedAt`. Rebuilding a
  // numeric rank must not make an Agent receipt stale merely because the
  // derived projection changed after the receipt snapshot was captured. On a
  // remote apply, only entries actually authored by this change-set advance
  // `updatedAt`; siblings whose rank shifted are projection-only updates.
  const remoteAuthoredTimestamp =
    context.origin === 'remote' &&
    effect.source?.changeSetId === context.changeSet.changeSetId
      ? { updatedAt: winningIso(effect) }
      : {};
  switch (effect.target.kind) {
    case 'storyline': await context.tx.update(StorylineTable).set({ orderKey: rank, ...remoteAuthoredTimestamp }).where(and(eq(StorylineTable.id, effect.entityId), eq(StorylineTable.projectId, context.changeSet.projectId))); return;
    case 'drift-group': await context.tx.update(DriftGroupTable).set({ sortOrder: rank, ...remoteAuthoredTimestamp }).where(and(eq(DriftGroupTable.id, effect.entityId), eq(DriftGroupTable.projectId, context.changeSet.projectId))); return;
    case 'element-patch': await context.tx.update(ElementPatchTable).set({ orderKey: rank, ...remoteAuthoredTimestamp }).where(and(eq(ElementPatchTable.id, effect.entityId), eq(ElementPatchTable.projectId, context.changeSet.projectId))); return;
    case 'library-item': await context.tx.update(LibraryItemTable).set({ orderKey: rank, ...remoteAuthoredTimestamp }).where(and(eq(LibraryItemTable.id, effect.entityId), eq(LibraryItemTable.projectId, context.changeSet.projectId))); return;
    case 'plot-grid-row': await context.tx.update(PlotGridRowTable).set({ positionKey: effect.positionKey }).where(eq(PlotGridRowTable.id, effect.entityId)); return;
    case 'plot-grid-column': await context.tx.update(PlotGridColumnTable).set({ positionKey: effect.positionKey }).where(eq(PlotGridColumnTable.id, effect.entityId)); return;
    case 'kv-entry': return; // SyncOrderRegister is the direct authority consumed by the KV projection writer.
  }
}

async function materializeSet(context: SyncDomainMaterializationContext, effect: Extract<ReducerEffect, { type: 'set.member' }>): Promise<void> {
  if (effect.target.kind === 'alias') {
    const aliases = context.effects
      .filter((candidate): candidate is Extract<ReducerEffect, { type: 'set.member' }> =>
        candidate.type === 'set.member' &&
        candidate.target.kind === 'alias' &&
        candidate.target.id === effect.target.id &&
        candidate.present &&
        typeof candidate.value === 'string',
      )
      .map((candidate) => candidate.value as string)
      .sort(compareUtf8Bytewise);
    await context.tx.update(BookElementTable).set({ aliasesJson: JSON.stringify(aliases) }).where(and(
      eq(BookElementTable.id, effect.target.id),
      eq(BookElementTable.projectId, context.changeSet.projectId),
    ));
    return;
  }
  const storylineId = effect.target.id;
  const nodeId = effect.memberId;
  if (!effect.present) {
    await context.tx.delete(NodeStorylineLinkTable).where(and(eq(NodeStorylineLinkTable.nodeId, nodeId), eq(NodeStorylineLinkTable.storylineId, storylineId)));
    return;
  }
  // Primary storyline authority is a separate LWW register. Until that writer
  // lands, an OR-set membership is materialized only as non-primary.
  await context.tx.insert(NodeStorylineLinkTable).values({ nodeId, storylineId, isPrimary: false }).onConflictDoNothing();
}

async function purgeEntity(context: SyncDomainMaterializationContext, effect: LifecycleEffect): Promise<void> {
  switch (effect.target.kind) {
    case 'project': await context.tx.delete(ProjectTable).where(eq(ProjectTable.id, effect.target.id)); return;
    case 'node': await context.tx.delete(BookNodeTable).where(and(eq(BookNodeTable.id, effect.target.id), eq(BookNodeTable.projectId, context.changeSet.projectId))); return;
    case 'node-content': await context.tx.delete(NodeContentTable).where(eq(NodeContentTable.nodeId, effect.target.id)); return;
    case 'storyline': await context.tx.delete(StorylineTable).where(and(eq(StorylineTable.id, effect.target.id), eq(StorylineTable.projectId, context.changeSet.projectId))); return;
    case 'element': await context.tx.delete(BookElementTable).where(and(eq(BookElementTable.id, effect.target.id), eq(BookElementTable.projectId, context.changeSet.projectId))); return;
    case 'element-category': await context.tx.delete(ElementCategoryTable).where(and(eq(ElementCategoryTable.id, effect.target.id), eq(ElementCategoryTable.projectId, context.changeSet.projectId))); return;
    case 'element-patch': await context.tx.delete(ElementPatchTable).where(and(eq(ElementPatchTable.id, effect.target.id), eq(ElementPatchTable.projectId, context.changeSet.projectId))); return;
    case 'library-item': await context.tx.delete(LibraryItemTable).where(and(eq(LibraryItemTable.id, effect.target.id), eq(LibraryItemTable.projectId, context.changeSet.projectId))); return;
    case 'entity-relation': await context.tx.delete(EntityRelationTable).where(and(eq(EntityRelationTable.id, effect.target.id), eq(EntityRelationTable.projectId, context.changeSet.projectId))); return;
    case 'entity-relation-type': await context.tx.delete(EntityRelationTypeTable).where(and(eq(EntityRelationTypeTable.id, effect.target.id), eq(EntityRelationTypeTable.projectId, context.changeSet.projectId))); return;
    case 'comment': await context.tx.delete(CommentTable).where(and(eq(CommentTable.id, effect.target.id), eq(CommentTable.projectId, context.changeSet.projectId))); return;
    case 'comment-action': await context.tx.delete(CommentActionTable).where(and(eq(CommentActionTable.id, effect.target.id), eq(CommentActionTable.projectId, context.changeSet.projectId))); return;
    case 'agent-memory': await context.tx.delete(AgentMemoryTable).where(and(eq(AgentMemoryTable.id, effect.target.id), eq(AgentMemoryTable.projectId, context.changeSet.projectId))); return;
    case 'book-act': await context.tx.delete(BookActTable).where(and(eq(BookActTable.id, effect.target.id), eq(BookActTable.projectId, context.changeSet.projectId))); return;
    case 'drift-group': await context.tx.delete(DriftGroupTable).where(and(eq(DriftGroupTable.id, effect.target.id), eq(DriftGroupTable.projectId, context.changeSet.projectId))); return;
    case 'timeline-marker': await context.tx.delete(TimelineMarkerTable).where(and(eq(TimelineMarkerTable.id, effect.target.id), eq(TimelineMarkerTable.projectId, context.changeSet.projectId))); return;
    case 'kv-entry': await context.tx.delete(EntityKvEntryTable).where(and(eq(EntityKvEntryTable.id, effect.target.id), eq(EntityKvEntryTable.projectId, context.changeSet.projectId))); return;
    case 'plot-grid-row': await context.tx.delete(PlotGridRowTable).where(eq(PlotGridRowTable.id, effect.target.id)); return;
    case 'plot-grid-column': await context.tx.delete(PlotGridColumnTable).where(eq(PlotGridColumnTable.id, effect.target.id)); return;
    case 'plot-grid-cell': await context.tx.delete(PlotGridCellTable).where(eq(PlotGridCellTable.id, effect.target.id)); return;
  }
}

async function materializeAssetBind(context: SyncDomainMaterializationContext, effect: AssetEffect, payload: ProjectAssetBindPayloadV1): Promise<void> {
  const sourceSha256 = payload.sourceSha256.slice('sha256:'.length);
  const repository = createProjectAssetSqliteRepository(context.changeSet.projectId, context.tx);
  if (!(await repository.findById(effect.target.id))) {
    await repository.create({ id: effect.target.id, projectId: context.changeSet.projectId, kind: payload.kind, sourceMime: payload.sourceMime, sourceSizeBytes: payload.sourceSizeBytes, sourceSha256, width: payload.width, height: payload.height, createdAt: payload.createdAt });
  }
  await bindAssetOwner(context, effect.target.id, payload.owner);
}

async function bindAssetOwner(context: SyncDomainMaterializationContext, assetId: string, owner: ProjectAssetOwnerV1): Promise<void> {
  if (owner.kind === 'element-portrait') {
    await context.tx.update(BookElementTable).set({ portraitAssetId: assetId }).where(and(eq(BookElementTable.id, owner.id), eq(BookElementTable.projectId, context.changeSet.projectId)));
  } else {
    await context.tx.update(LibraryItemTable).set({ assetId }).where(and(eq(LibraryItemTable.id, owner.id), eq(LibraryItemTable.projectId, context.changeSet.projectId)));
  }
}

async function unbindAssetOwner(context: SyncDomainMaterializationContext, assetId: string, owner: ProjectAssetOwnerV1): Promise<void> {
  if (owner.kind === 'element-portrait') {
    await context.tx.update(BookElementTable).set({ portraitAssetId: null }).where(and(eq(BookElementTable.id, owner.id), eq(BookElementTable.projectId, context.changeSet.projectId), eq(BookElementTable.portraitAssetId, assetId)));
  } else {
    await context.tx.update(LibraryItemTable).set({ assetId: null }).where(and(eq(LibraryItemTable.id, owner.id), eq(LibraryItemTable.projectId, context.changeSet.projectId), eq(LibraryItemTable.assetId, assetId)));
  }
  await createProjectAssetSqliteRepository(context.changeSet.projectId, context.tx).delete(assetId);
}

async function materializeYjsUpdate(
  context: SyncDomainMaterializationContext,
  effect: Extract<ReducerEffect, { type: 'yjs.update' }>,
): Promise<void> {
  const parsed = parseDocId(effect.target.id);
  const update = parseYjsPayload(effect);
  if (!parsed || !update) {
    throw new Error(`Validated Yjs effect ${effect.effectId} lost its canonical payload`);
  }
  const repository = createYjsRepository(context.tx);
  const document = new Y.Doc();
  try {
    const snapshot = await repository.getSnapshot(effect.target.id);
    if (snapshot) Y.applyUpdate(document, snapshot.stateBlob, 'remote-sync');
    for (const existing of await repository.listUpdates(effect.target.id)) {
      Y.applyUpdate(document, existing.updateBlob, 'remote-sync');
    }
    Y.applyUpdate(document, update, 'remote-sync');
    const contentJson = JSON.stringify(yDocToProsemirrorJSON(document, 'default'));
    await repository.appendUpdate(effect.target.id, update, { kind: 'remote' });
    const updatedAt = winningIso(effect);
    switch (parsed.kind) {
      case 'node-content':
        await context.tx.insert(NodeContentTable).values({
          nodeId: parsed.entityId,
          contentJson,
          createdAt: updatedAt,
          updatedAt,
        }).onConflictDoUpdate({
          target: NodeContentTable.nodeId,
          set: { contentJson, updatedAt },
        });
        return;
      case 'element':
        await context.tx.update(BookElementTable).set({ contentJson, updatedAt }).where(and(
          eq(BookElementTable.id, parsed.entityId),
          eq(BookElementTable.projectId, context.changeSet.projectId),
        ));
        return;
      case 'storyline':
        await context.tx.update(StorylineTable).set({ contentJson, updatedAt }).where(and(
          eq(StorylineTable.id, parsed.entityId),
          eq(StorylineTable.projectId, context.changeSet.projectId),
        ));
        return;
      case 'category':
        await context.tx.update(ElementCategoryTable).set({ contentJson, updatedAt }).where(and(
          eq(ElementCategoryTable.id, parsed.entityId),
          eq(ElementCategoryTable.projectId, context.changeSet.projectId),
        ));
        return;
    }
  } finally {
    document.destroy();
  }
}

async function validateNamedInvariants(context: SyncDomainMaterializationContext): Promise<SemanticConflictDraft[]> {
  const issues: SemanticConflictDraft[] = [];
  for (const effect of context.effects) {
    if (!effect.materialize && effect.type !== 'entity.lifecycle') continue;
    if (effect.type === 'field.set') {
      const issue = validateFieldEffect(effect);
      if (issue) issues.push(issue);
      else issues.push(...await validatePrimaryStorylineInvariant(context, effect));
    } else if (effect.type === 'tuple.set') {
      const issue = validateTupleEffect(effect);
      if (issue) issues.push(issue);
    } else if (effect.type === 'order.position') {
      // Retired pre-release chapter order registers can remain in an older
      // reducer history until the next checkpoint. They are inert history,
      // not part of the transaction currently being admitted. Validate only
      // a newly authored order effect so new chapter fractional-order writes
      // still fail closed without poisoning unrelated current field writes.
      if (effect.source?.changeSetId === context.changeSet.changeSetId) {
        const issue = validateOrderEffect(effect);
        if (issue) issues.push(issue);
      }
    } else if (effect.type === 'set.member') {
      const issue = validateSetEffect(effect);
      if (issue) issues.push(issue);
      else issues.push(...await validateStorylineMembershipInvariant(context, effect));
    } else if (effect.type === 'entity.lifecycle') {
      issues.push(...validateLifecycleEffect(effect));
    } else {
      issues.push(...await validateExternalEffect(context, effect));
    }
  }

  for (const effect of context.effects) {
    if (
      effect.type !== 'entity.lifecycle' ||
      effect.status !== 'live' ||
      !effect.seed ||
      effect.source?.changeSetId !== context.changeSet.changeSetId
    ) {
      continue;
    }
    const entityType = lifecycleProseEntityType(effect.target.kind);
    if (!entityType) continue;
    const docId = proseDocId(entityType, effect.target.id);
    const stateUpdates = context.effects.filter((candidate) =>
      candidate.type === 'yjs.update' &&
      candidate.source.changeSetId === context.changeSet.changeSetId &&
      candidate.target.id === docId &&
      candidate.target.incarnation === effect.target.incarnation,
    );
    if (stateUpdates.length !== 1) {
      const currentChangeSetEffectIds = context.effects
        .filter((candidate) =>
          'source' in candidate &&
          candidate.source?.changeSetId === context.changeSet.changeSetId,
        )
        .map(({ effectId }) => effectId);
      issues.push({
        ...conflict(
          effect,
          'yjs.lifecycle-state-count',
          `${effect.target.kind} create/restore requires exactly one full Yjs state update in the same change-set`,
          { docId, updateCount: stateUpdates.length },
        ),
        blockedEffectIds: currentChangeSetEffectIds,
      });
    }
  }

  const relationTypeIds = new Set(
    context.effects
      .filter((effect) => effect.target.kind === 'entity-relation-type')
      .map((effect) => effect.target.id),
  );
  for (const id of relationTypeIds) {
    const existing = await context.tx.select({ locked: EntityRelationTypeTable.locked }).from(EntityRelationTypeTable).where(and(eq(EntityRelationTypeTable.id, id), eq(EntityRelationTypeTable.projectId, context.changeSet.projectId))).limit(1);
    if (!existing[0]?.locked) continue;
    for (const effect of effectsForEntity(context.effects, 'entity-relation-type', id)) {
      if (effect.type === 'field.set' || (effect.type === 'entity.lifecycle' && effect.status === 'purged')) {
        issues.push(entityConflict(context.effects, effect, 'relation-type.locked-builtin', 'Built-in relation types cannot be updated or purged'));
      }
    }
  }

  for (const effect of context.effects) {
    if (effect.type !== 'entity.lifecycle' || effect.status !== 'live' || !effect.seed) continue;
    const candidate = candidateRecord(context.effects, effect.target.kind, effect.target.id);
    if (!candidate) continue;
    const currentEntityEffects = effectsForEntity(
      context.effects,
      effect.target.kind,
      effect.target.id,
    ).filter((candidateEffect) =>
      'source' in candidateEffect &&
      candidateEffect.source?.changeSetId === context.changeSet.changeSetId,
    );
    const currentLifecycleChanged = currentEntityEffects.some(
      (candidateEffect) => candidateEffect.type === 'entity.lifecycle',
    );
    const currentFields = new Set(
      currentEntityEffects
        .filter((candidateEffect): candidateEffect is FieldEffect =>
          candidateEffect.type === 'field.set',
        )
        .map((candidateEffect) => candidateEffect.field),
    );
    if (effect.target.kind === 'entity-relation-type') {
      try {
        const normalized = normalizeRelationTypeDefinition({
          name: candidate.name as string,
          description: candidate.description as string | undefined,
          orientation: candidate.orientation as 'directed' | 'symmetric',
          sourceRole: candidate.sourceRole as string | undefined,
          targetRole: candidate.targetRole as string | undefined,
          sourceKinds: candidate.sourceKinds as string[] as never,
          targetKinds: candidate.targetKinds as string[] as never,
        });
        if (candidate.normalizedName !== undefined && candidate.normalizedName !== normalized.normalizedName) {
          throw new Error('normalizedName does not match portable name normalization');
        }
      } catch (error) {
        issues.push(entityConflict(context.effects, effect, 'relation-type.invalid-definition', error instanceof Error ? error.message : String(error)));
      }
    }
    if (effect.target.kind === 'entity-relation') {
      if (candidate.fromKind === candidate.toKind && candidate.fromId === candidate.toId) {
        issues.push(entityConflict(context.effects, effect, 'relation.self-edge', 'A relation cannot connect an entity to itself'));
        continue;
      }
      const endpointExists = async (kind: string, id: string): Promise<boolean> => {
        const wireKind = kind === 'patch'
          ? 'element-patch'
          : kind === 'category'
            ? 'element-category'
            : kind === 'library_item'
              ? 'library-item'
              : kind;
        if (candidateRecord(context.effects, wireKind, id)) return true;
        if (wireKind === 'node') return (await context.tx.select({ id: BookNodeTable.id }).from(BookNodeTable).where(and(eq(BookNodeTable.id, id), eq(BookNodeTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
        if (wireKind === 'element') return (await context.tx.select({ id: BookElementTable.id }).from(BookElementTable).where(and(eq(BookElementTable.id, id), eq(BookElementTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
        if (wireKind === 'element-patch') return (await context.tx.select({ id: ElementPatchTable.id }).from(ElementPatchTable).where(and(eq(ElementPatchTable.id, id), eq(ElementPatchTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
        if (wireKind === 'element-category') return (await context.tx.select({ id: ElementCategoryTable.id }).from(ElementCategoryTable).where(and(eq(ElementCategoryTable.id, id), eq(ElementCategoryTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
        if (wireKind === 'storyline') return (await context.tx.select({ id: StorylineTable.id }).from(StorylineTable).where(and(eq(StorylineTable.id, id), eq(StorylineTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
        if (wireKind === 'comment') return (await context.tx.select({ id: CommentTable.id }).from(CommentTable).where(and(eq(CommentTable.id, id), eq(CommentTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
        if (wireKind === 'library-item') return (await context.tx.select({ id: LibraryItemTable.id }).from(LibraryItemTable).where(and(eq(LibraryItemTable.id, id), eq(LibraryItemTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
        return false;
      };
      if (
        !(await endpointExists(candidate.fromKind as string, candidate.fromId as string)) ||
        !(await endpointExists(candidate.toKind as string, candidate.toId as string))
      ) {
        issues.push(entityConflict(context.effects, effect, 'relation.missing-endpoint', 'Relation endpoints must exist in the same project'));
        continue;
      }
      const typeId = candidate.relationTypeId as string;
      const localCandidate = candidateRecord(context.effects, 'entity-relation-type', typeId);
      let type: EntityRelationType | null = null;
      if (localCandidate) {
        type = {
          id: typeId,
          projectId: context.changeSet.projectId,
          name: localCandidate.name as string,
          normalizedName: normalizeRelationTypeName(localCandidate.name as string),
          description: (localCandidate.description as string | undefined) ?? '',
          orientation: localCandidate.orientation as EntityRelationType['orientation'],
          systemKey: (localCandidate.systemKey as EntityRelationType['systemKey'] | undefined) ?? null,
          locked: localCandidate.locked === true,
          sourceRole: (localCandidate.sourceRole as string | undefined) ?? '',
          targetRole: (localCandidate.targetRole as string | undefined) ?? '',
          sourceKinds: localCandidate.sourceKinds as EntityRelationType['sourceKinds'],
          targetKinds: localCandidate.targetKinds as EntityRelationType['targetKinds'],
          createdAt: '', updatedAt: '',
        };
      } else {
        const rows = await context.tx.select().from(EntityRelationTypeTable).where(and(eq(EntityRelationTypeTable.id, typeId), eq(EntityRelationTypeTable.projectId, context.changeSet.projectId))).limit(1);
        if (rows[0]) {
          type = {
            ...rows[0],
            orientation: rows[0].orientation as EntityRelationType['orientation'],
            systemKey: rows[0].systemKey as EntityRelationType['systemKey'],
            sourceKinds: await endpointKinds(context, typeId, 'source') as EntityRelationType['sourceKinds'],
            targetKinds: await endpointKinds(context, typeId, 'target') as EntityRelationType['targetKinds'],
          };
        }
      }
      if (!type) {
        issues.push(entityConflict(context.effects, effect, 'relation.missing-type', 'Relation type does not exist in this project'));
      } else {
        const result = validateRelationAgainstType(type, {
          fromKind: candidate.fromKind as never,
          fromId: candidate.fromId as string,
          toKind: candidate.toKind as never,
          toId: candidate.toId as string,
        });
        if (!result.ok || result.relation.fromKind !== candidate.fromKind || result.relation.fromId !== candidate.fromId) {
          issues.push(entityConflict(context.effects, effect, 'relation.invalid-endpoints', result.ok ? 'Symmetric relation endpoints are not in canonical order' : result.message));
        }
      }
    }
    if (effect.target.kind === 'element-patch' && candidate.sourceNodeId === null && candidate.sourceBlockId !== null && candidate.sourceBlockId !== undefined) {
      issues.push(entityConflict(context.effects, effect, 'element-patch.invalid-anchor', 'sourceBlockId requires sourceNodeId'));
    }
    if (effect.target.kind === 'comment') {
      const noTarget = candidate.targetKind === null && candidate.targetId === null && candidate.targetBlockId === null;
      const anchored = typeof candidate.targetKind === 'string' && typeof candidate.targetId === 'string';
      if (!noTarget && !anchored) issues.push(entityConflict(context.effects, effect, 'comment.invalid-anchor', 'Comment target fields must be all absent or identify a structural entity'));
    }
    if (effect.target.kind === 'kv-entry') {
      const key = `${candidate.ownerKind}:${candidate.namespace}`;
      if (!['project:facts', 'project:storyline-template', 'storyline:facts', 'element-category:element-template', 'element:facts'].includes(key)) {
        issues.push(entityConflict(context.effects, effect, 'kv.invalid-owner', `Unsupported KV owner namespace ${key}`));
      }
    }
    if (effect.target.kind === 'node') {
      const validatesBookOrder =
        currentLifecycleChanged ||
        currentFields.has('kind') ||
        currentFields.has('bookOrder');
      const validatesDriftGroup =
        currentLifecycleChanged ||
        currentFields.has('kind') ||
        currentFields.has('driftGroupId');
      if (
        validatesBookOrder &&
        candidate.kind === 'chapter' &&
        !FINITE_NUMBER(candidate.bookOrder)
      ) {
        issues.push(entityConflict(context.effects, effect, 'node.chapter-missing-book-order', 'Chapter nodes require a finite authored bookOrder'));
      }
      if (
        validatesBookOrder &&
        candidate.kind === 'drift' &&
        candidate.bookOrder !== null &&
        candidate.bookOrder !== undefined
      ) {
        issues.push(entityConflict(context.effects, effect, 'node.drift-has-book-order', 'Drift nodes cannot have a bookOrder'));
      }
      if (
        validatesDriftGroup &&
        candidate.kind === 'chapter' &&
        candidate.driftGroupId !== null &&
        candidate.driftGroupId !== undefined
      ) {
        issues.push(entityConflict(context.effects, effect, 'node.chapter-has-drift-group', 'Chapter nodes cannot belong to drift groups'));
      }
      if (validatesDriftGroup && typeof candidate.driftGroupId === 'string') {
        const groupExists = Boolean(candidateRecord(context.effects, 'drift-group', candidate.driftGroupId)) ||
          (await context.tx.select({ id: DriftGroupTable.id }).from(DriftGroupTable).where(and(eq(DriftGroupTable.id, candidate.driftGroupId), eq(DriftGroupTable.projectId, context.changeSet.projectId))).limit(1)).length === 1;
        if (!groupExists) issues.push(entityConflict(context.effects, effect, 'node.missing-drift-group', 'Drift group does not exist in this project'));
      }
    }
    if (effect.target.kind === 'drift-group' && candidate.parentGroupId === effect.target.id) {
      issues.push(entityConflict(context.effects, effect, 'drift-group.self-parent', 'A drift group cannot parent itself'));
    }
    if ((effect.target.kind === 'book-act' || effect.target.kind === 'timeline-marker') && typeof candidate.driftNodeId === 'string') {
      const local = candidateRecord(context.effects, 'node', candidate.driftNodeId);
      const stored = await context.tx.select({ kind: BookNodeTable.kind }).from(BookNodeTable).where(and(eq(BookNodeTable.id, candidate.driftNodeId), eq(BookNodeTable.projectId, context.changeSet.projectId))).limit(1);
      if ((local?.kind ?? stored[0]?.kind) !== 'drift') {
        issues.push(entityConflict(context.effects, effect, `${effect.target.kind}.invalid-drift-binding`, 'Binding must reference a drift node in this project'));
      }
    }
  }

  const relationEffects = context.effects.filter((effect): effect is LifecycleEffect => effect.type === 'entity.lifecycle' && effect.target.kind === 'entity-relation' && effect.status === 'live');
  const semanticGroups = new Map<string, LifecycleEffect[]>();
  for (const effect of relationEffects) {
    const candidate = candidateRecord(context.effects, 'entity-relation', effect.target.id);
    if (!candidate) continue;
    const key = JSON.stringify([candidate.fromKind, candidate.fromId, candidate.toKind, candidate.toId, candidate.relationTypeId]);
    const group = semanticGroups.get(key) ?? [];
    group.push(effect);
    semanticGroups.set(key, group);
  }
  for (const group of semanticGroups.values()) {
    group.sort((left, right) => compareUtf8Bytewise(left.target.id, right.target.id));
    for (const loser of group.slice(1)) {
      issues.push(conflict(loser, 'relation.semantic-duplicate', `Relation ${group[0].target.id} is the canonical semantic edge winner`, { winnerId: group[0].target.id }));
    }
  }
  const hasCurrentProseLifecycle = context.effects.some((effect) =>
    effect.type === 'entity.lifecycle' &&
    effect.status === 'live' &&
    !!effect.seed &&
    effect.source?.changeSetId === context.changeSet.changeSetId &&
    lifecycleProseEntityType(effect.target.kind) !== null,
  );
  if (!hasCurrentProseLifecycle) return issues;
  const currentEffectIds = new Set(
    context.effects
      .filter((effect) =>
        'source' in effect &&
        effect.source?.changeSetId === context.changeSet.changeSetId,
      )
      .map(({ effectId }) => effectId),
  );
  return issues.map((issue) =>
    issue.blockedEffectIds?.some((effectId) => currentEffectIds.has(effectId))
      ? { ...issue, blockedEffectIds: [...currentEffectIds] }
      : issue,
  );
}

export function createProductionSyncDomainMaterializationKernel(): SyncDomainMaterializationKernel {
  return {
    externallyMaterializedActions: EXTERNAL_ACTIONS,
    validate: validateNamedInvariants,
    async materializeDerived(context) {
      if (context.origin !== 'local') return;
      const orderEffects = context.effects.filter(
        (effect): effect is OrderEffect => effect.type === 'order.position',
      );
      const currentOrderChanged =
        orderEffects.some(
          (effect) => effect.source?.changeSetId === context.changeSet.changeSetId,
        ) ||
        context.effects.some((lifecycle) => {
          if (
            lifecycle.type !== 'entity.lifecycle' ||
            lifecycle.source?.changeSetId !== context.changeSet.changeSetId
          ) return false;
          const orderKind = lifecycle.target.kind;
          return orderEffects.some(
            (effect) =>
              effect.target.kind === orderKind &&
              effect.entityId === lifecycle.target.id,
          );
        });
      if (!currentOrderChanged) return;
      // A move can change scope, so the reduced state no longer contains its
      // old ownerId. Rebuild every live order projection instead of trying to
      // infer the departed scope from numeric columns. This is deterministic,
      // local-only work and never emits another change-set.
      for (const effect of orderEffects) {
        if (effect.materialize) await materializeOrder(context, effect);
      }
    },
    async materialize(context) {
      if (context.origin !== 'remote') return;
      const effects = context.effects.filter((effect) => effect.materialize);
      const affectedGridNodeIds = await collectAffectedGridNodeIds(context, context.effects);
      for (const effect of effects) {
        if (effect.type === 'entity.lifecycle' && effect.status === 'live') await upsertLifecycleLive(context, effect);
      }
      for (const effect of effects) {
        if (effect.type === 'set.member') await materializeSet(context, effect);
      }
      // Membership rows must exist before the independent primary register is
      // projected, regardless of deterministic effect-id ordering.
      for (const effect of effects) {
        if (effect.type === 'field.set') await materializeField(context, effect);
        else if (effect.type === 'tuple.set') await materializeTuple(context, effect);
        else if (effect.type === 'order.position') await materializeOrder(context, effect);
        else if (effect.type === 'yjs.update') await materializeYjsUpdate(context, effect);
        else if (effect.type === 'asset.bind') {
          const parsed = parseProjectAssetMutationV1({ action: effect.type, target: effect.target, payload: effect.payload });
          if (parsed.ok && parsed.value.action === 'asset.bind') await materializeAssetBind(context, effect, parsed.value.payload);
        } else if (effect.type === 'asset.unbind') {
          const parsed = parseProjectAssetMutationV1({ action: effect.type, target: effect.target, payload: effect.payload });
          if (parsed.ok && parsed.value.action === 'asset.unbind') await unbindAssetOwner(context, effect.target.id, parsed.value.payload.owner);
        } else if (effect.type === 'sync-generation.purge') {
          await deleteProjectDataInTransaction(context.tx, context.changeSet.projectId);
          await context.tx.update(SyncProviderBindingTable).set({ state: 'purged', updatedAt: winningIso(effect) }).where(eq(SyncProviderBindingTable.syncGenerationId, context.changeSet.syncGenerationId));
          await context.tx.update(SyncGenerationTable).set({ projectId: null, status: 'purged', purgedAt: winningIso(effect), updatedAt: winningIso(effect) }).where(eq(SyncGenerationTable.syncGenerationId, context.changeSet.syncGenerationId));
        }
      }
      for (const effect of effects) {
        if (effect.type !== 'entity.lifecycle') continue;
        if (effect.status === 'purged') await purgeEntity(context, effect);
        else if (effect.status === 'trashed') {
          const synthetic: FieldEffect = { ...effect, type: 'field.set', field: 'deletedAt', value: winningIso(effect), order: effect.order!, source: effect.source! };
          if (FIELD_POLICY[effect.target.kind]?.deletedAt) {
            await materializeField(context, synthetic);
          } else {
            // Some authored rows (including comments/actions, element patches,
            // relations and relation types) do not carry a domain deletedAt
            // projection. Their reducer
            // lifecycle still remains `trashed`, so a later incarnation can
            // restore the same logical ID from its full seed; only the SQLite
            // domain projection is removed here.
            await purgeEntity(context, effect);
          }
        }
      }
      if (effects.length > 0) await rebuildNormalizedProjections(context, effects, affectedGridNodeIds);
    },
  };
}

export const productionSyncDomainMaterializationKernel =
  createProductionSyncDomainMaterializationKernel();
