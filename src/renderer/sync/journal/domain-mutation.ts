import {
  assertCanonicalCborValue,
  compareUtf8Bytewise,
  type CanonicalCborValue,
} from '../protocol';
import { SyncChangeBuilder } from './change-builder';

export const AUTHORED_DOMAIN_ENTITY_KINDS = [
  'project',
  'node',
  'nodeContent',
  'storyline',
  'element',
  'elementCategory',
  'elementPatch',
  'libraryItem',
  'entityRelation',
  'entityRelationType',
  'comment',
  'commentAction',
  'agentMemory',
  'bookAct',
  'driftGroup',
  'timelineMarker',
] as const;

export type AuthoredDomainEntityKind = (typeof AUTHORED_DOMAIN_ENTITY_KINDS)[number];
export type AuthoredDomainMutationKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'softDelete'
  | 'restore';

export interface AuthoredDomainMutation {
  readonly entityType: AuthoredDomainEntityKind;
  readonly mutationType: AuthoredDomainMutationKind;
  readonly entityId: string;
  readonly projectId: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly parentId?: string;
  readonly incarnation?: number;
}

const WIRE_KIND: Readonly<Record<AuthoredDomainEntityKind, string>> = {
  project: 'project',
  node: 'node',
  nodeContent: 'node-content',
  storyline: 'storyline',
  element: 'element',
  elementCategory: 'element-category',
  elementPatch: 'element-patch',
  libraryItem: 'library-item',
  entityRelation: 'entity-relation',
  entityRelationType: 'entity-relation-type',
  comment: 'comment',
  commentAction: 'comment-action',
  agentMemory: 'agent-memory',
  bookAct: 'book-act',
  driftGroup: 'drift-group',
  timelineMarker: 'timeline-marker',
};

/**
 * Fields carried by the provider-neutral entity protocol. SQLite identity,
 * timestamps, normalized collections and numeric order columns are not wire
 * authority; their dedicated lifecycle/set/order/tuple/Yjs writers own them.
 */
const AUTHORED_FIELDS: Readonly<Record<AuthoredDomainEntityKind, ReadonlySet<string>>> = {
  project: new Set(['name', 'summary']),
  node: new Set([
    'title',
    'summary',
    'bookOrder',
    'narrativeOrder',
    'writingStatus',
    'kind',
    'driftGroupId',
    'deletedAt',
  ]),
  nodeContent: new Set(),
  storyline: new Set([
    'name',
    'color',
    'summary',
    'nodeContentTemplateJson',
    'deletedAt',
  ]),
  element: new Set([
    'categoryId',
    'name',
    'summary',
    'groupName',
    'deletedAt',
  ]),
  elementCategory: new Set([
    'name',
    'elementTemplateJson',
    'color',
    'layoutMode',
    'gridX',
    'gridY',
    'deletedAt',
  ]),
  elementPatch: new Set([
    'elementId',
    'sourceNodeId',
    'sourceBlockId',
    'sourceBlockText',
    'textAnchorJson',
    'invalidatedAt',
    'title',
    'contentJson',
  ]),
  libraryItem: new Set([
    'title',
    'kind',
    'externalUrl',
    'bodyJson',
    'notesJson',
  ]),
  entityRelation: new Set([
    'fromKind',
    'fromId',
    'toKind',
    'toId',
    'relationTypeId',
  ]),
  entityRelationType: new Set([
    'name',
    'normalizedName',
    'description',
    'orientation',
    'systemKey',
    'locked',
    'sourceRole',
    'targetRole',
    'sourceKinds',
    'targetKinds',
  ]),
  comment: new Set([
    'kind',
    'targetKind',
    'targetId',
    'targetBlockId',
    'anchorJson',
    'authorKind',
    'authorId',
    'authorName',
    'bodyJson',
    'status',
    'priority',
    'source',
    'metadataJson',
    'targetBlockIdsJson',
    'resolvedAt',
  ]),
  commentAction: new Set([
    'commentId',
    'kind',
    'label',
    'payloadJson',
    'status',
    'resultJson',
    'createdByKind',
    'createdById',
    'appliedAt',
  ]),
  agentMemory: new Set([
    'kind',
    'body',
    'targetKind',
    'targetId',
    'targetBlockId',
    'source',
    'originRef',
    'status',
    'supersedesId',
    'deletedAt',
  ]),
  bookAct: new Set(['name', 'color', 'startOrder', 'driftNodeId']),
  driftGroup: new Set(['name', 'parentGroupId', 'color']),
  timelineMarker: new Set(['narrativeOrder', 'label', 'driftNodeId']),
};

const NON_WIRE_PROJECTION_FIELDS = new Set([
  'id',
  'projectId',
  'createdAt',
  'updatedAt',
  'contentJson',
  'kvJson',
  'storylineTemplateKvJson',
  'elementTemplateKvJson',
  'aliasesJson',
  'outlineJson',
  'plotGridJson',
  'previewImageUrl',
  'wordCount',
  'wordCountBasisKind',
  'wordCountBasisHash',
  'wordCountBasisRevision',
  'wordCountBasisServerSeq',
  'positionX',
  'positionY',
  'orderKey',
  'sortOrder',
  'mainStorylineId',
  'storylineIds',
  'portraitAssetId',
  'assetId',
]);

function canonicalValue(value: unknown, path: string): CanonicalCborValue {
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalValue(entry, `${path}/${index}`));
  }
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path}: sync payload must use plain objects`);
    }
    const result: Record<string, CanonicalCborValue> = {};
    for (const key of Object.keys(value).sort(compareUtf8Bytewise)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = canonicalValue(entry, `${path}/${key}`);
    }
    return result;
  }
  assertCanonicalCborValue(value);
  return value;
}

function canonicalRecord(
  entityType: AuthoredDomainEntityKind,
  payload: Readonly<Record<string, unknown>> | undefined,
  parentId: string | undefined,
): Readonly<Record<string, CanonicalCborValue>> {
  const normalized = canonicalValue(payload ?? {}, '$payload');
  if (
    !normalized ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized) ||
    normalized instanceof Uint8Array
  ) {
    throw new TypeError('domain sync payload must be an object');
  }
  const record: Record<string, CanonicalCborValue> = {};
  const allowed = AUTHORED_FIELDS[entityType];
  for (const [field, value] of Object.entries(
    normalized as Readonly<Record<string, CanonicalCborValue>>,
  )) {
    if (allowed.has(field)) {
      record[field] = value;
      continue;
    }
    if (NON_WIRE_PROJECTION_FIELDS.has(field)) continue;
    throw new TypeError(`${entityType}.${field} is not classified by the sync domain manifest`);
  }
  if (parentId !== undefined && !Object.prototype.hasOwnProperty.call(record, 'parentId')) {
    throw new TypeError(`${entityType}.parentId is not an authored sync field`);
  }
  return record;
}

/** Append one provider-neutral domain mutation to the current atomic change-set. */
export function appendAuthoredDomainMutation(
  changes: SyncChangeBuilder,
  mutation: AuthoredDomainMutation,
): void {
  const kind = WIRE_KIND[mutation.entityType];
  const incarnation = mutation.incarnation ?? 0;
  const target = {
    family: 'entity' as const,
    kind,
    id: mutation.entityId,
    incarnation,
  };
  const payload = canonicalRecord(mutation.entityType, mutation.payload, mutation.parentId);

  switch (mutation.mutationType) {
    case 'create':
      changes.add({ action: 'entity.create', target, payload: { seed: payload } });
      return;
    case 'restore':
      changes.add({ action: 'entity.restore', target, payload: { seed: payload } });
      return;
    case 'softDelete':
      changes.add({ action: 'entity.trash', target, payload: {} });
      return;
    case 'delete':
      changes.add({ action: 'entity.purge', target, payload: {} });
      return;
    case 'update': {
      const fields = Object.keys(payload).sort(compareUtf8Bytewise);
      if (fields.length === 0) {
        throw new Error(`${mutation.entityType} update must contain at least one authored field`);
      }
      for (const field of fields) {
        changes.add({
          action: 'field.set',
          target,
          payload: { field, value: payload[field] },
        });
      }
      return;
    }
  }
}
