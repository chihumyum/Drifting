import { MemoryProviderLocalObjectStore } from './local-object-store';
import { MemoryObjectLogProvider } from './memory-provider';
import {
  DEFAULT_CONFORMANCE_BINDING,
  defineObjectLogProviderConformance,
} from './object-log-provider.conformance';

defineObjectLogProviderConformance({
  name: 'Memory',
  async create(options) {
    const localObjects = new MemoryProviderLocalObjectStore();
    const provider = new MemoryObjectLogProvider(localObjects, options);
    const generation = await provider.openGeneration({ ...DEFAULT_CONFORMANCE_BINDING, secretRef: null });
    return {
      provider,
      localObjects,
      generation,
      removeRemoteObject(logicalKeyId) {
        provider.removeRemoteObject(generation, logicalKeyId);
      },
      corruptRemoteObject(objectId) {
        provider.corruptRemoteBytes(generation, objectId);
      },
    };
  },
});
