import { describe, expect, it } from 'vitest';

import { legacyRelationTypeId } from '../domain/entity-relation-type';
import {
  entityRelationRequestPayload,
  projectRelationTypeProjection,
  type ProjectGraphPayload,
} from './entity-sync.service';

function graph(overrides: Partial<ProjectGraphPayload> = {}): ProjectGraphPayload {
  return {
    project: { id: 'project-1' },
    nodes: [],
    nodeContents: [],
    storylines: [],
    nodeStorylineLinks: [],
    elements: [],
    elementCategories: [],
    entityRelations: [],
    inlineMentions: [],
    entityPatches: [],
    blockSections: [],
    libraryItems: [],
    comments: [],
    commentActions: [],
    ...overrides,
  };
}

describe('relation type sync projection', () => {
  it('hydrates explicit definitions and endpoint child rows from a graph payload', () => {
    const projected = projectRelationTypeProjection(
      graph({
        entityRelationTypes: [
          {
            id: 'type-1',
            projectId: 'project-1',
            name: 'contains',
            normalizedName: 'contains',
            orientation: 'directed',
            sourceRole: 'container',
            targetRole: 'member',
            sourceKinds: ['storyline'],
            targetKinds: ['node'],
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
          },
        ],
        entityRelations: [
          {
            id: 'relation-1',
            projectId: 'project-1',
            relationTypeId: 'type-1',
            kind: 'contains',
          },
        ],
      }),
    );

    expect(projected.types).toEqual([
      expect.objectContaining({
        id: 'type-1',
        orientation: 'directed',
        sourceKinds: ['storyline'],
        targetKinds: ['node'],
      }),
    ]);
    expect(projected.endpointRows).toEqual(
      expect.arrayContaining([
        { relationTypeId: 'type-1', side: 'source', entityKind: 'storyline' },
        { relationTypeId: 'type-1', side: 'target', entityKind: 'node' },
      ]),
    );
    expect(projected.relationTypeIdFor(graph().entityRelations[0] ?? {})).toBeNull();
  });

  it('materializes an older server label as an unconfigured deterministic type', () => {
    const relation = {
      id: 'relation-legacy',
      projectId: '项目-A',
      fromKind: 'element',
      fromId: 'element-1',
      toKind: 'node',
      toId: 'node-1',
      kind: '认识',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    };
    const projected = projectRelationTypeProjection(graph({ entityRelations: [relation] }));
    const expectedId = legacyRelationTypeId('项目-A', '认识');

    expect(projected.relationTypeIdFor(relation)).toBe(expectedId);
    expect(projected.types).toEqual([
      expect.objectContaining({
        id: expectedId,
        name: '认识',
        orientation: 'unconfigured',
      }),
    ]);
    expect(projected.endpointRows).toEqual(
      expect.arrayContaining([
        { relationTypeId: expectedId, side: 'source', entityKind: 'comment' },
        { relationTypeId: expectedId, side: 'target', entityKind: 'patch' },
      ]),
    );
  });
});

describe('relation mutation request projection', () => {
  it('preserves an atomic endpoint swap and strips local-only fields', () => {
    expect(
      entityRelationRequestPayload(
        {
          id: 'relation-1',
          projectId: 'project-1',
          fromKind: 'node',
          fromId: 'node-1',
          toKind: 'storyline',
          toId: 'storyline-1',
          kind: 'contains',
          relationTypeId: 'type-1',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
        'update',
      ),
    ).toEqual({
      fromKind: 'node',
      fromId: 'node-1',
      toKind: 'storyline',
      toId: 'storyline-1',
      kind: 'contains',
      relationTypeId: 'type-1',
    });
  });
});
