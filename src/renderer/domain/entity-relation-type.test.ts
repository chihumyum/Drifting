import { describe, expect, it } from 'vitest';

import {
  genericAssociationRelationType,
  genericAssociationRelationTypeId,
  GENERIC_ASSOCIATION_SYSTEM_KEY,
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
    systemKey: null,
    locked: false,
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

    // UTF-8 byte order is locale-independent: ASCII z sorts before UTF-8 é.
    expect(
      validateRelationAgainstType(symmetric, {
        fromKind: 'node',
        fromId: 'é',
        toKind: 'node',
        toId: 'z',
      }),
    ).toEqual({
      ok: true,
      relation: {
        fromKind: 'node',
        fromId: 'z',
        toKind: 'node',
        toId: 'é',
      },
    });
  });

  it('builds one locale-independent locked generic association type per project', () => {
    const builtIn = genericAssociationRelationType('项目-A', AT);
    expect(builtIn).toMatchObject({
      id: genericAssociationRelationTypeId('项目-A'),
      name: 'Generic association',
      systemKey: GENERIC_ASSOCIATION_SYSTEM_KEY,
      locked: true,
      orientation: 'directed',
      sourceKinds: ['comment', 'library_item'],
    });
    expect(
      validateRelationAgainstType(builtIn, {
        fromKind: 'comment',
        fromId: 'comment-1',
        toKind: 'node',
        toId: 'node-1',
      }),
    ).toMatchObject({ ok: true });
  });
});
