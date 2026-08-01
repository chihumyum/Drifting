import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { snapshotYjsProseBlocks } from '../lib/agent/runtime/yjs-prose-command';
import { createEntityLegacySeedUpdate } from './useEntityYjsDoc';

describe('createEntityLegacySeedUpdate', () => {
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
      createEntityLegacySeedUpdate(contentJson),
      createEntityLegacySeedUpdate(contentJson),
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
});
