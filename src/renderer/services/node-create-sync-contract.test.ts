import { describe, expect, it } from 'vitest';

import { buildNodeCreateSyncPayload } from './node-create-sync-contract';

describe('node create sync contract', () => {
  it('keeps storyline membership out of the entity lifecycle seed', () => {
    expect(buildNodeCreateSyncPayload({ id: 'drift-1', kind: 'drift' })).toEqual({
      id: 'drift-1',
      kind: 'drift',
    });
    expect(buildNodeCreateSyncPayload({ id: 'chapter-1', kind: 'chapter' })).toEqual({
      id: 'chapter-1',
      kind: 'chapter',
    });
  });
});
