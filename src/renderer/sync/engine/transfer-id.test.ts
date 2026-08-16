import { describe, expect, it } from 'vitest';

import { createProviderTransferId } from './transfer-id';

describe('provider transfer identity', () => {
  it('hashes structured durable identities into stable native-safe tokens', async () => {
    const input = {
      direction: 'upload' as const,
      syncGenerationId: 'sync-generation-with-[json]-punctuation',
      objectIdentity: `sha256:${'a'.repeat(64)}`,
    };
    const first = await createProviderTransferId(input);
    const second = await createProviderTransferId(input);

    expect(first).toBe(second);
    expect(first).toMatch(/^upload-[0-9a-f]{64}$/u);
    expect(first.length).toBeLessThanOrEqual(200);
    expect(first).not.toContain(input.syncGenerationId);
  });

  it('separates direction, SyncGeneration and object identity and rejects empty input', async () => {
    const base = {
      direction: 'upload' as const,
      syncGenerationId: 'sync-generation-a',
      objectIdentity: 'object-a',
    };
    const expected = await createProviderTransferId(base);

    const download = await createProviderTransferId({ ...base, direction: 'download' });
    expect(download).not.toBe(expected);
    expect(download).toMatch(/^download-[0-9a-f]{64}$/u);
    await expect(createProviderTransferId({ ...base, syncGenerationId: 'sync-generation-b' })).resolves.not.toBe(
      expected,
    );
    await expect(createProviderTransferId({ ...base, objectIdentity: 'object-b' })).resolves.not.toBe(
      expected,
    );
    await expect(
      createProviderTransferId({ ...base, objectIdentity: '' }),
    ).rejects.toThrow(/must not be empty/u);
  });
});
