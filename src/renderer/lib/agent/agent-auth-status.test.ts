import { describe, expect, it } from 'vitest';
import { isGeneralAgentUsable, type GeneralAgentAuthStatus } from './protocol';

const disconnected: GeneralAgentAuthStatus = {
  byokConnected: false,
  apiKeyConnected: false,
  hostedAvailable: false,
  chatgptConnected: false,
};

describe('General Agent product availability', () => {
  it('accepts a native ChatGPT sign-in without a selected-provider API key', () => {
    expect(
      isGeneralAgentUsable('apikey', {
        ...disconnected,
        chatgptConnected: true,
      }),
    ).toBe(true);
  });

  it('preserves the legacy mode-specific connection checks', () => {
    expect(isGeneralAgentUsable('apikey', disconnected)).toBe(false);
    expect(
      isGeneralAgentUsable('apikey', { ...disconnected, apiKeyConnected: true }),
    ).toBe(true);
    expect(
      isGeneralAgentUsable('oauth', { ...disconnected, byokConnected: true }),
    ).toBe(true);
    expect(
      isGeneralAgentUsable('hosted', { ...disconnected, hostedAvailable: true }),
    ).toBe(true);
  });
});
