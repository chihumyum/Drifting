import {
  ALL_ENTITY_KINDS,
  STRUCTURAL_ENTITY_KINDS,
  isEntityKind,
  isStructuralEntityKind,
  type EntityKind,
  type EntityRefSourceKind,
  type EntityRefTargetKind,
} from './entity-kinds';

export const ENTITY_RELATION_ORIENTATIONS = [
  'directed',
  'symmetric',
  'unconfigured',
] as const;

export type EntityRelationOrientation = (typeof ENTITY_RELATION_ORIENTATIONS)[number];
export type EntityRelationEndpointSide = 'source' | 'target';

export interface EntityRelationType {
  id: string;
  projectId: string;
  name: string;
  normalizedName: string;
  description: string;
  orientation: EntityRelationOrientation;
  sourceRole: string;
  targetRole: string;
  sourceKinds: EntityRefSourceKind[];
  targetKinds: EntityRefTargetKind[];
  createdAt: string;
  updatedAt: string;
}

export interface EntityRelationTypeDefinition {
  name: string;
  description?: string;
  orientation: Exclude<EntityRelationOrientation, 'unconfigured'>;
  sourceRole?: string;
  targetRole?: string;
  sourceKinds: readonly EntityRefSourceKind[];
  targetKinds: readonly EntityRefTargetKind[];
}

export interface EntityRelationSemanticInput {
  fromKind: EntityRefSourceKind;
  fromId: string;
  toKind: EntityRefTargetKind;
  toId: string;
}

export type EntityRelationSemanticResult =
  | { ok: true; relation: EntityRelationSemanticInput }
  | {
      ok: false;
      code: 'RELATION_TYPE_UNCONFIGURED' | 'RELATION_ENDPOINT_MISMATCH';
      message: string;
      suggestedSwap: boolean;
    };

export const LEGACY_RELATION_SOURCE_KINDS = [...ALL_ENTITY_KINDS] as EntityRefSourceKind[];
export const LEGACY_RELATION_TARGET_KINDS = [
  ...STRUCTURAL_ENTITY_KINDS,
] as EntityRefTargetKind[];

export function isEntityRelationOrientation(value: unknown): value is EntityRelationOrientation {
  return (
    typeof value === 'string' &&
    ENTITY_RELATION_ORIENTATIONS.includes(value as EntityRelationOrientation)
  );
}

export function normalizeRelationTypeName(value: string): string {
  // SQLite's built-in lower() is ASCII-only. Keep this portable normalization
  // identical in TypeScript, SQLite backfills and Postgres migrations so a
  // legacy label always derives the same durable id on every client/server.
  return value.trim().replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function legacyRelationTypeId(projectId: string, name: string): string {
  return `legacy:${utf8Hex(`${projectId}:${normalizeRelationTypeName(name)}`)}`;
}

function orderedUniqueSourceKinds(values: readonly unknown[]): EntityRefSourceKind[] {
  const set = new Set(values.filter(isEntityKind));
  return ALL_ENTITY_KINDS.filter((kind) => set.has(kind));
}

function orderedUniqueTargetKinds(values: readonly unknown[]): EntityRefTargetKind[] {
  const set = new Set(values.filter(isStructuralEntityKind));
  return STRUCTURAL_ENTITY_KINDS.filter((kind) => set.has(kind));
}

export function normalizeRelationTypeDefinition(
  input: EntityRelationTypeDefinition,
): Omit<
  EntityRelationType,
  'id' | 'projectId' | 'createdAt' | 'updatedAt'
> {
  const name = input.name.trim();
  if (!name) throw new Error('关系类型名称不能为空');
  const description = input.description?.trim() ?? '';
  if (input.sourceKinds.some((kind) => !isEntityKind(kind))) {
    throw new Error('关系类型包含不支持的源实体类型');
  }
  if (input.targetKinds.some((kind) => !isStructuralEntityKind(kind))) {
    throw new Error('关系类型包含不支持的目标实体类型');
  }
  const sourceKinds = orderedUniqueSourceKinds(input.sourceKinds);
  const targetKinds = orderedUniqueTargetKinds(input.targetKinds);
  if (sourceKinds.length === 0 || targetKinds.length === 0) {
    throw new Error('关系类型必须至少允许一种源实体和一种目标实体');
  }

  if (input.orientation === 'directed') {
    const sourceRole = input.sourceRole?.trim() ?? '';
    const targetRole = input.targetRole?.trim() ?? '';
    if (!sourceRole || !targetRole) {
      throw new Error('有向关系类型必须填写源角色和目标角色');
    }
    return {
      name,
      normalizedName: normalizeRelationTypeName(name),
      description,
      orientation: input.orientation,
      sourceRole,
      targetRole,
      sourceKinds,
      targetKinds,
    };
  }

  const symmetricKinds = orderedUniqueTargetKinds(sourceKinds);
  if (
    sourceKinds.some((kind) => !isStructuralEntityKind(kind)) ||
    symmetricKinds.join('\u0000') !== targetKinds.join('\u0000')
  ) {
    throw new Error('对称关系只能连接结构实体，且两端允许的实体类型必须一致');
  }
  const role = input.sourceRole?.trim() || input.targetRole?.trim() || '端点';
  return {
    name,
    normalizedName: normalizeRelationTypeName(name),
    description,
    orientation: input.orientation,
    sourceRole: role,
    targetRole: role,
    sourceKinds,
    targetKinds,
  };
}

function endpointKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

function endpointAllowed(
  type: EntityRelationType,
  fromKind: EntityRefSourceKind,
  toKind: EntityRefTargetKind,
): boolean {
  return type.sourceKinds.includes(fromKind) && type.targetKinds.includes(toKind);
}

export function validateRelationAgainstType(
  type: EntityRelationType,
  relation: EntityRelationSemanticInput,
  options: { allowUnconfigured?: boolean } = {},
): EntityRelationSemanticResult {
  if (type.orientation === 'unconfigured') {
    if (options.allowUnconfigured) return { ok: true, relation };
    return {
      ok: false,
      code: 'RELATION_TYPE_UNCONFIGURED',
      message: `关系类型「${type.name}」尚未配置方向和端点角色；请先由作者完成配置。`,
      suggestedSwap: false,
    };
  }

  if (endpointAllowed(type, relation.fromKind, relation.toKind)) {
    if (type.orientation !== 'symmetric') return { ok: true, relation };
    const fromKey = endpointKey(relation.fromKind, relation.fromId);
    const toKey = endpointKey(relation.toKind, relation.toId);
    return fromKey.localeCompare(toKey) <= 0
      ? { ok: true, relation }
      : {
          ok: true,
          relation: {
            fromKind: relation.toKind,
            fromId: relation.toId,
            toKind: relation.fromKind as EntityRefTargetKind,
            toId: relation.fromId,
          },
        };
  }

  const suggestedSwap =
    isStructuralEntityKind(relation.fromKind) &&
    endpointAllowed(type, relation.toKind, relation.fromKind);
  const expected = `${type.sourceRole || '源端'} → ${type.targetRole || '目标端'}`;
  return {
    ok: false,
    code: 'RELATION_ENDPOINT_MISMATCH',
    message: suggestedSwap
      ? `关系类型「${type.name}」要求 ${expected}；当前两端方向相反，请交换两端后重试。`
      : `关系类型「${type.name}」要求 ${expected}，当前实体类型不符合其端点约束。`,
    suggestedSwap,
  };
}

/** Validate an unsaved definition against the relation that prompted its
 * creation. Modal creation uses this before persistence so it cannot create a
 * type that immediately disappears from the compatible selector. */
export function validateRelationTypeDefinitionAgainstRelation(
  definition: EntityRelationTypeDefinition,
  relation: EntityRelationSemanticInput,
): EntityRelationSemanticResult {
  const normalized = normalizeRelationTypeDefinition(definition);
  return validateRelationAgainstType(
    {
      id: 'draft-relation-type',
      projectId: 'draft-project',
      ...normalized,
      createdAt: '',
      updatedAt: '',
    },
    relation,
  );
}

export function legacyRelationType(
  projectId: string,
  name: string,
  createdAt: string,
  updatedAt: string,
): EntityRelationType {
  const trimmed = name.trim();
  return {
    id: legacyRelationTypeId(projectId, trimmed),
    projectId,
    name: trimmed,
    normalizedName: normalizeRelationTypeName(trimmed),
    description: '',
    orientation: 'unconfigured',
    sourceRole: '',
    targetRole: '',
    sourceKinds: [...LEGACY_RELATION_SOURCE_KINDS],
    targetKinds: [...LEGACY_RELATION_TARGET_KINDS],
    createdAt,
    updatedAt,
  };
}
