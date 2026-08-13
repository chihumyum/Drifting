import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  encodeCapturedDocumentStateForCheckpoint,
  finalizeCheckpointBeforeCursor,
} from './yjs-sync.service';

describe('Yjs sync checkpoint bootstrap', () => {
  it('encodes only the frozen update generation', () => {
    const source = new Y.Doc({ gc: false });
    const text = source.getText('default');
    text.insert(0, 'first');
    const firstGeneration = Y.encodeStateAsUpdate(source);
    const firstVector = Y.encodeStateVector(source);
    text.insert(text.length, '-later');
    const laterUpdate = Y.encodeStateAsUpdate(source, firstVector);

    const checkpoint = encodeCapturedDocumentStateForCheckpoint(null, [
      { updateBlob: firstGeneration },
    ]);
    const restored = new Y.Doc({ gc: false });
    Y.applyUpdate(restored, checkpoint);
    expect(restored.getText('default').toString()).toBe('first');

    Y.applyUpdate(restored, laterUpdate);
    expect(restored.getText('default').toString()).toBe('first-later');
    source.destroy();
    restored.destroy();
  });

  it('never advances the local cursor when checkpoint upload fails', async () => {
    const advance = vi.fn(async () => undefined);

    await expect(
      finalizeCheckpointBeforeCursor(async () => {
        throw new Error('checkpoint unavailable');
      }, advance),
    ).rejects.toThrow('checkpoint unavailable');
    expect(advance).not.toHaveBeenCalled();
  });
});
