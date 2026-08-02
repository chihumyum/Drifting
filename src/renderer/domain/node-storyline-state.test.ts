import { describe, expect, it } from 'vitest';

import { deriveNodeStorylineState, resolvePrimaryStorylineId } from './node-storyline-state';

describe('node storyline state', () => {
  it('hydrates memberships and primary storylines from the same link snapshot', () => {
    expect(
      deriveNodeStorylineState([
        { nodeId: 'chapter-1', storylineId: 'story-1', isPrimary: true },
        { nodeId: 'chapter-1', storylineId: 'story-2', isPrimary: false },
        { nodeId: 'chapter-2', storylineId: 'story-2', isPrimary: true },
      ]),
    ).toEqual({
      storylineNodeMapping: {
        'story-1': ['chapter-1'],
        'story-2': ['chapter-1', 'chapter-2'],
      },
      primaryStorylineByNode: {
        'chapter-1': 'story-1',
        'chapter-2': 'story-2',
      },
    });
  });

  it('falls back to the first membership when the declared primary is absent or stale', () => {
    expect(resolvePrimaryStorylineId(undefined, ['story-1', 'story-2'])).toBe('story-1');
    expect(resolvePrimaryStorylineId('deleted-story', ['story-1', 'story-2'])).toBe('story-1');
    expect(resolvePrimaryStorylineId('story-2', ['story-1', 'story-2'])).toBe('story-2');
    expect(resolvePrimaryStorylineId(null, [])).toBeNull();
  });
});
