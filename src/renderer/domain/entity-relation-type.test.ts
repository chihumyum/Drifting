import { describe, expect, it } from 'vitest';

import {
  legacyRelationType,
  legacyRelationTypeId,
  normalizeRelationTypeDefinition,
  validateRelationTypeDefinitionAgainstRelation,
  validateRelationAgainstType,
  type EntityRelationType,
} from './entity-relation-type';

const AT = '2026-08-12T00:00:00.000Z';

function relationType(
  overrides: Partial<EntityRelationType> = {},
): EntityRelationType {
  return {
    id: 'type-1',
    projectId: 'project-1',
    name: 'foreshadows',
    normalizedName: 'foreshadows',
    description: '',
    orientation: 'directed',
    sourceRole: 'setup',
    targetRole: 'payoff',
    sourceKinds: ['node'],
    targetKinds: ['storyline'],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe('entity relation type semantics', () => {
  it('rejects an inline-created definition that excludes the relation being authored', () => {
    const checked = validateRelationTypeDefinitionAgainstRelation(
      {
        name: 'appears in',
        orientation: 'directed',
        sourceRole: 'element',
        targetRole: 'scene',
        sourceKinds: ['node'],
        targetKinds: ['node'],
      },
      {
        fromKind: 'element',
        fromId: 'character-a',
        toKind: 'node',
        toId: 'chapter-a',
      },
    );

    expect(checked).toMatchObject({ ok: false, suggestedSwap: false });
  });

  it('normalizes names and rejects incomplete directed roles', () => {
    expect(
      normalizeRelationTypeDefinition({
        name: '  Foreshadows  ',
        orientation: 'directed',
        sourceRole: ' setup ',
        targetRole: ' payoff ',
        sourceKinds: ['node', 'node'],
        targetKinds: ['storyline'],
      }),
    ).toMatchObject({
      name: 'Foreshadows',
      normalizedName: 'foreshadows',
      sourceRole: 'setup',
      targetRole: 'payoff',
      sourceKinds: ['node'],
    });
    expect(() =>
      normalizeRelationTypeDefinition({
        name: 'contains',
        orientation: 'directed',
        sourceRole: '',
        targetRole: 'member',
        sourceKinds: ['storyline'],
        targetKinds: ['node'],
      }),
    ).toThrow(/源角色和目标角色/u);
    expect(() =>
      normalizeRelationTypeDefinition({
        name: 'invalid',
        orientation: 'directed',
        sourceRole: 'source',
        targetRole: 'target',
        sourceKinds: ['node', 'unknown' as 'node'],
        targetKinds: ['node'],
      }),
    ).toThrow(/不支持的源实体类型/u);
  });

  it('rejects reversed directed endpoints with an explicit swap suggestion', () => {
    expect(
      validateRelationAgainstType(relationType(), {
        fromKind: 'storyline',
        fromId: 'storyline-1',
        toKind: 'node',
        toId: 'node-1',
      }),
    ).toMatchObject({
      ok: false,
      code: 'RELATION_ENDPOINT_MISMATCH',
      suggestedSwap: true,
      message: expect.stringContaining('交换两端'),
    });
  });

  it('canonicalizes symmetric endpoints deterministically', () => {
    const symmetric = relationType({
      orientation: 'symmetric',
      sourceRole: 'peer',
      targetRole: 'peer',
      sourceKinds: ['node'],
      targetKinds: ['node'],
    });
    expect(
      validateRelationAgainstType(symmetric, {
        fromKind: 'node',
        fromId: 'z',
        toKind: 'node',
        toId: 'a',
      }),
    ).toEqual({
      ok: true,
      relation: {
        fromKind: 'node',
        fromId: 'a',
        toKind: 'node',
        toId: 'z',
      },
    });
  });

  it('keeps migrated labels deterministic and blocks new writes until configured', () => {
    const legacy = legacyRelationType('项目-A', '  认识  ', AT, AT);
    expect(legacy.id).toBe(legacyRelationTypeId('项目-A', '认识'));
    expect(legacyRelationTypeId('project-1', 'ÉCHO')).toBe(
      legacyRelationTypeId('project-1', 'Écho'),
    );
    expect(legacyRelationTypeId('project-1', 'ÉCHO')).not.toBe(
      legacyRelationTypeId('project-1', 'écho'),
    );
    expect(legacy.orientation).toBe('unconfigured');
    expect(
      validateRelationAgainstType(legacy, {
        fromKind: 'element',
        fromId: 'element-1',
        toKind: 'node',
        toId: 'node-1',
      }),
    ).toMatchObject({
      ok: false,
      code: 'RELATION_TYPE_UNCONFIGURED',
      suggestedSwap: false,
    });
  });
});
