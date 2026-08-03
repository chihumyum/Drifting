import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDataStore } from '../../store/data-store';
import { toolEntityRef } from './tool-entity-ref';

const initialDataState = useDataStore.getState();
const timestamp = '2026-08-02T00:00:00.000Z';

describe('workspace Agent entity activity projection', () => {
  beforeEach(() => {
    useDataStore.setState({
      bookNodes: [
        {
          id: 'node-added',
          projectId: 'project-1',
          kind: 'chapter',
          title: '雨/城',
          summary: '',
          bookOrder: 1,
          narrativeOrder: null,
          driftGroupId: null,
          writingStatus: 'draft',
          position: { x: 0, y: 0 },
          wordCount: 12,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      bookElements: [],
      storylines: [],
      bookElementCategories: [],
    });
  });

  afterEach(() => {
    useDataStore.setState(initialDataState, true);
  });

  it('maps a successful write_file create result to an Added node', () => {
    expect(
      toolEntityRef(
        'write_file',
        { path: '/chapters/雨城/prose.md', content: '雨落。' },
        JSON.stringify({
          path: '/chapters/雨%2F城/prose.md',
          operation: 'created',
          updated: true,
        }),
      ),
    ).toEqual({
      entityType: 'node',
      id: 'node-added',
      op: 'create',
      spots: { structural: true },
    });
  });

  it('keeps an existing workspace file write classified as Modified', () => {
    expect(
      toolEntityRef(
        'edit_file',
        { path: '/chapters/雨%2F城/prose.md' },
        JSON.stringify({
          path: '/chapters/雨%2F城/prose.md',
          replacements: 1,
          updated: true,
        }),
      ),
    ).toMatchObject({
      entityType: 'node',
      id: 'node-added',
      op: 'write',
    });
  });
});
