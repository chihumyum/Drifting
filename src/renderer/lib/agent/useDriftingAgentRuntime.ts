import { useLayoutEffect, useReducer } from 'react';
import { BYOKCredentialsProvider } from '../ai/credentials/byok';
import { ChainCredentialsProvider } from '../ai/credentials/chain';
import { EnvCredentialsProvider } from '../ai/credentials/env';
import type { GeneralAgentAuthStatus } from './protocol';
import {
  createDriftingReadToolRuntime,
  createLocalGeneralAgentTransport,
  DriftingAgentModelDriver,
} from './runtime';
import {
  installGeneralAgentTransport,
  type GeneralAgentTransport,
} from './transport';

async function readLocalAgentAuthStatus(): Promise<GeneralAgentAuthStatus> {
  const credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);
  let connected = false;
  try {
    connected = Boolean(await credentials.getApiKey('deepseek'));
  } catch {
    connected = false;
  }
  return {
    // Both legacy BYOK labels resolve to the same P1 DeepSeek credential. The
    // settings migration selects `apikey`; keeping both truthful makes an old
    // hydrated window usable before its state is rewritten.
    byokConnected: connected,
    apiKeyConnected: connected,
    hostedAvailable: false,
  };
}

export function createDriftingLocalAgentTransport(): GeneralAgentTransport {
  return createLocalGeneralAgentTransport({
    driver: new DriftingAgentModelDriver(),
    tools: createDriftingReadToolRuntime(),
    authStatus: readLocalAgentAuthStatus,
  });
}

// One product transport per renderer lifetime. React Strict Mode may mount,
// clean up, and remount effects; reusing this instance preserves subscriptions
// and prevents a turn from being attached to a discarded duplicate.
const driftingLocalAgentTransport = createDriftingLocalAgentTransport();

/** Install the provider-neutral local runtime behind the existing chat seam. */
export function useDriftingAgentRuntime(): void {
  const [, refreshCapabilities] = useReducer((value: number) => value + 1, 0);
  useLayoutEffect(() => {
    const restore = installGeneralAgentTransport(
      driftingLocalAgentTransport,
    );
    // The facade is intentionally external to React. Re-render the owning
    // layout once so child panels observe the newly installed capability
    // before paint instead of keeping their first unsupported projection.
    refreshCapabilities();
    return restore;
  }, []);
}
