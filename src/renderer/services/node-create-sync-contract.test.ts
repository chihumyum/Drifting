import { describe, expect, it } from 'vitest';

import {
  buildNodeCreateSyncPayload,
  normalizeNodeCreateSyncPayload,
} from './node-create-sync-contract';

describe('node create sync contract', () => {
  it('always writes the explicit primary-storyline signal for new producers', () => {
    expect(buildNodeCreateSyncPayload({ id: 'drift-1', kind: 'drift' }, null)).toEqual({
      id: 'drift-1',
      kind: 'drift',
      mainStorylineId: null,
    });
    expect(
      buildNodeCreateSyncPayload({ id: 'chapter-1', kind: 'chapter' }, 'storyline-1'),
    ).toEqual({
      id: 'chapter-1',
      kind: 'chapter',
      mainStorylineId: 'storyline-1',
    });
  });

  it('upgrades a legacy durable payload without overwriting an explicit signal', () => {
    expect(normalizeNodeCreateSyncPayload({ id: 'legacy-drift', kind: 'drift' })).toEqual({
      id: 'legacy-drift',
      kind: 'drift',
      mainStorylineId: null,
    });

    const explicit = { id: 'chapter-1', mainStorylineId: 'storyline-1' };
    expect(normalizeNodeCreateSyncPayload(explicit)).toBe(explicit);
    expect(normalizeNodeCreateSyncPayload(undefined)).toEqual({ mainStorylineId: null });
  });
});
