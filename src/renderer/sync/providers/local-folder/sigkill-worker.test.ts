import process from 'node:process';
import { describe, it } from 'vitest';

import { sha256Bytes } from '../../protocol';
import { MemoryProviderLocalObjectStore } from '../local-object-store';
import {
  NodeLocalFolderTestTransport,
  type LocalFolderDurabilityBoundary,
} from './node-test-transport';
import { LocalFolderObjectLogProvider } from './provider';

const rootPath = process.env.DRIFTING_LOCAL_FOLDER_SIGKILL_ROOT;
const boundary = process.env
  .DRIFTING_LOCAL_FOLDER_SIGKILL_BOUNDARY as LocalFolderDurabilityBoundary | undefined;

describe.skipIf(!rootPath || !boundary)('LocalFolder SIGKILL child writer', () => {
  it('blocks exactly at the requested durability boundary', async () => {
    if (!rootPath || !boundary) throw new Error('SIGKILL child environment is incomplete');
    const localObjects = new MemoryProviderLocalObjectStore();
    const transport = new NodeLocalFolderTestTransport(rootPath, localObjects, {
      async onDurabilityBoundary(current) {
        if (current !== boundary) return;
        process.stdout.write(`BOUNDARY:${current}\n`);
        await new Promise<void>(() => {
          setInterval(() => {}, 1_000);
        });
      },
    });
    const provider = new LocalFolderObjectLogProvider(transport);
    const generation = await provider.openGeneration({
      bindingId: 'binding-a',
      syncGenerationId: 'sync-generation-a',
      accountRef: null,
      secretRef: 'local-folder-root:test',
      authorityGeneration: 1,
    });
    const bytes = new TextEncoder().encode('sigkill-object');
    await provider.uploadImmutable({
      generation,
      sourceRef: localObjects.put('sigkill-source', bytes),
      objectKind: 'segment',
      logicalKeyId: 'segment-sigkill',
      storedSha256: await sha256Bytes(bytes),
      sizeBytes: bytes.byteLength,
      transferId: `sigkill-${boundary}`,
      signal: new AbortController().signal,
    });
    throw new Error(`child writer unexpectedly passed ${boundary}`);
  });
});
