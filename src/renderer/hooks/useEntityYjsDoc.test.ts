import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { snapshotYjsProseBlocks } from '../lib/agent/runtime/yjs-prose-command';
import { createEntitySeedUpdate } from './useEntityYjsDoc';

describe('createEntitySeedUpdate', () => {
  it('makes concurrent equivalent editor and Agent seeds merge idempotently', async () => {
    const contentJson = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'chapter-opening' },
          content: [{ type: 'text', text: 'Only one manuscript copy.' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'chapter-ending' },
          content: [{ type: 'text', text: 'The end.' }],
        },
      ],
    });
    const [editorSeed, agentSeed] = await Promise.all([
      createEntitySeedUpdate(contentJson),
      createEntitySeedUpdate(contentJson),
    ]);
    const merged = new Y.Doc({ gc: false });

    Y.applyUpdate(merged, editorSeed, 'editor-seed');
    Y.applyUpdate(merged, agentSeed, 'agent-seed');

    expect(editorSeed).toEqual(agentSeed);
    expect(snapshotYjsProseBlocks(merged).map((block) => block.id)).toEqual([
      'chapter-opening',
      'chapter-ending',
    ]);
    merged.destroy();
  });

  it('creates byte-stable unique ids for a current projection that has none or duplicates one', async () => {
    const contentJson = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Generated identity.' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'kept-id' },
          content: [{ type: 'text', text: 'Kept identity.' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'kept-id' },
          content: [{ type: 'text', text: 'Duplicate identity replaced.' }],
        },
      ],
    });

    const first = await createEntitySeedUpdate(contentJson);
    const second = await createEntitySeedUpdate(contentJson);
    const seeded = new Y.Doc({ gc: false });
    Y.applyUpdate(seeded, first);
    const ids = snapshotYjsProseBlocks(seeded).map((block) => block.id);

    expect(first).toEqual(second);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(ids[1]).toBe('kept-id');
    expect(ids[2]).not.toBe('kept-id');
    seeded.destroy();
  });
});
