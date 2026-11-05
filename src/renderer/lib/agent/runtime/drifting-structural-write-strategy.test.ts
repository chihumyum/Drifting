import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BookElement } from '../../../domain/book-element';
import { useDataStore } from '../../../store/data-store';
import { events } from '../../events';
import { projectSnapshot } from './drifting-structural-write-strategy';

const element = (name: string): BookElement => ({
  id: `element-${name}`, projectId: 'project-1', categoryId: 'category-1', name, summary: '', contentJson: '',
  kvJson: '[]', aliases: ['华强'], groupName: null, portraitAssetId: null,
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
});

describe('projecting an Agent element write', () => {
  afterEach(() => {
    useDataStore.setState({ bookElements: [] });
  });

  it('announces a new element so open editors link the names already in the prose', () => {
    const created = vi.fn();
    events.on('element:element-created', created);
    try {
      const value = element('刘华强');
      projectSnapshot({ entityKind: 'element', entityId: value.id }, { kind: 'element', value });
      expect(useDataStore.getState().bookElements.map((item) => item.id)).toEqual([value.id]);
      expect(created).toHaveBeenCalledOnce();
      expect(created).toHaveBeenCalledWith({ element: value });

      // A replayed receipt or a later update is not a second creation.
      projectSnapshot({ entityKind: 'element', entityId: value.id }, { kind: 'element', value: { ...value, summary: '瓜摊常客' } });
      expect(created).toHaveBeenCalledOnce();
      expect(useDataStore.getState().bookElements[0].summary).toBe('瓜摊常客');
    } finally {
      events.off('element:element-created', created);
    }
  });
});
