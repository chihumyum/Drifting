import { describe, expect, it } from 'vitest';
import type { EntityRelationType } from '../../domain/entity-relation-type';
import type { EntityRelationLink } from '../../store/data-store';
import {
  buildSuperViewRelationMenuModel,
  isRelationRenderableOnSuperView,
} from './super-view-relation-menu-model';

function relationType(
  id: string,
  sourceKinds: EntityRelationType['sourceKinds'],
  targetKinds: EntityRelationType['targetKinds'],
): EntityRelationType {
  return {
    id,
    projectId: 'project',
    name: id,
    normalizedName: id,
    description: '',
    orientation: 'directed',
    systemKey: null,
    locked: false,
    sourceRole: 'source',
    targetRole: 'target',
    sourceKinds,
    targetKinds,
    createdAt: '',
    updatedAt: '',
  };
}

function relation(
  id: string,
  fromKind: EntityRelationLink['fromKind'],
  toKind: EntityRelationLink['toKind'],
  relationTypeId: string,
  fromId = `${id}:from`,
  toId = `${id}:to`,
): EntityRelationLink {
  return {
    id,
    projectId: 'project',
    fromKind,
    fromId,
    toKind,
    toId,
    relationTypeId,
    createdAt: '',
    updatedAt: '',
  };
}

describe('super-view relation menu model', () => {
  it('only treats relations whose two endpoints can render on Element as canvas instances', () => {
    expect(
      isRelationRenderableOnSuperView(relation('ee', 'element', 'element', 'ee'), 'element'),
    ).toBe(true);
    expect(
      isRelationRenderableOnSuperView(relation('en', 'element', 'node', 'en'), 'element'),
    ).toBe(true);
    expect(
      isRelationRenderableOnSuperView(relation('ne', 'node', 'element', 'ne'), 'element'),
    ).toBe(true);
    expect(
      isRelationRenderableOnSuperView(relation('ec', 'element', 'category', 'ec'), 'element'),
    ).toBe(false);
    expect(isRelationRenderableOnSuperView(relation('nn', 'node', 'node', 'nn'), 'element')).toBe(
      false,
    );
  });

  it('orders used Element types before available types and folds off-canvas types', () => {
    const relationTypes = [
      relationType('element-node-unused', ['element'], ['node']),
      relationType('off-canvas', ['comment'], ['category']),
      relationType('compatible-used-elsewhere', ['element', 'comment'], ['element', 'category']),
      relationType('element-element-unused', ['element'], ['element']),
      relationType('element-node-used', ['element'], ['node']),
      relationType('element-element-used', ['element'], ['element']),
    ];
    const relations = [
      relation('used-1', 'element', 'element', 'element-element-used'),
      relation('used-2', 'element', 'element', 'element-element-used'),
      relation('used-3', 'element', 'node', 'element-node-used', 'element', 'drift'),
      relation('elsewhere', 'comment', 'category', 'off-canvas'),
      relation('compatible-elsewhere', 'comment', 'category', 'compatible-used-elsewhere'),
    ];

    const model = buildSuperViewRelationMenuModel({
      canvas: 'element',
      relationTypes,
      relations,
      driftNodeIds: new Set(['drift']),
    });

    expect(model.usedTypes.map((item) => item.type.id)).toEqual([
      'element-element-used',
      'element-node-used',
    ]);
    expect(model.availableTypes.map((item) => item.type.id)).toEqual([
      'compatible-used-elsewhere',
      'element-element-unused',
      'element-node-unused',
    ]);
    expect(model.otherTypes.map((item) => item.type.id)).toEqual(['off-canvas']);
    expect(model.relationTypeIdOrder).toEqual([
      'element-element-used',
      'element-node-used',
    ]);
    expect(model.driftDerivedRelationTypeIds).toEqual(new Set(['element-node-used']));
    expect(model.worldRelationTypeIds).toEqual(new Set(['element-element-used']));
  });

  it('uses node-to-node as the renderable Story Graph contract', () => {
    const model = buildSuperViewRelationMenuModel({
      canvas: 'graph',
      relationTypes: [
        relationType('node-node', ['node'], ['node']),
        relationType('element-node', ['element'], ['node']),
      ],
      relations: [relation('node-edge', 'node', 'node', 'node-node')],
      driftNodeIds: new Set(),
    });

    expect(model.usedTypes.map((item) => item.type.id)).toEqual(['node-node']);
    expect(model.otherTypes.map((item) => item.type.id)).toEqual(['element-node']);
  });
});
