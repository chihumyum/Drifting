import { describe, expect, it } from 'vitest';

import {
  DRIFTING_AGENT_CONTEXT_PROFILE,
  DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS,
  DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
  resolveDriftingAgentContextProfile,
} from './drifting-agent-product-contract';

describe('Drifting Agent provider context contract', () => {
  it('installs the current default driver at the 200k product target', () => {
    expect(
      resolveDriftingAgentContextProfile({
        declared: DRIFTING_AGENT_CONTEXT_PROFILE,
      }),
    ).toMatchObject({
      id: DRIFTING_AGENT_CONTEXT_PROFILE.id,
      contextWindowTokens: DRIFTING_AGENT_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: 8_192,
      source: 'driver',
    });
  });

  it('never enlarges a smaller provider declaration', () => {
    expect(
      resolveDriftingAgentContextProfile({
        declared: {
          id: 'small-provider-v1',
          contextWindowTokens: 64_000,
          maxOutputTokens: 4_096,
          providerOverheadTokens: 700,
          perToolOverheadTokens: 10,
        },
        requestedContextWindowTokens: 200_000,
      }),
    ).toEqual({
      id: 'small-provider-v1',
      contextWindowTokens: 64_000,
      maxOutputTokens: 4_096,
      providerOverheadTokens: 700,
      perToolOverheadTokens: 10,
      source: 'driver',
    });
  });

  it('uses a conservative window for an undeclared custom driver', () => {
    expect(resolveDriftingAgentContextProfile({})).toMatchObject({
      contextWindowTokens: DRIFTING_AGENT_UNDECLARED_PROVIDER_CONTEXT_WINDOW_TOKENS,
      source: 'conservative_fallback',
    });
  });
});
