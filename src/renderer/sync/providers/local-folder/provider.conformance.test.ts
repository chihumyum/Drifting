import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryProviderLocalObjectStore } from '../local-object-store';
import {
  DEFAULT_CONFORMANCE_BINDING,
  defineObjectLogProviderConformance,
} from '../object-log-provider.conformance';
import { NodeLocalFolderTestTransport } from './node-test-transport';
import { LocalFolderObjectLogProvider } from './provider';

defineObjectLogProviderConformance({
  name: 'LocalFolder',
  async create(options) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'drifting-local-folder-conformance-'));
    const localObjects = new MemoryProviderLocalObjectStore();
    const transport = new NodeLocalFolderTestTransport(rootPath, localObjects);
    const provider = new LocalFolderObjectLogProvider(transport, options);
    const generation = await provider.openGeneration(DEFAULT_CONFORMANCE_BINDING);
    const transportSyncGeneration = transport.transportSyncGenerationFor(generation.syncGenerationId);
    return {
      provider,
      localObjects,
      generation,
      removeRemoteObject(logicalKeyId) {
        return transport.recordRemoval(transportSyncGeneration, logicalKeyId);
      },
      corruptRemoteObject(objectId) {
        return transport.corruptObject(transportSyncGeneration, objectId);
      },
      cleanup() {
        return rm(rootPath, { recursive: true, force: true });
      },
    };
  },
});
