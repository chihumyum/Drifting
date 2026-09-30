import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canUseAgentExtension,
  canUseByokProvider,
  canUseExternalContent,
  canUseHostedService,
  canUseNetwork,
  canUsePersonalCloud,
  isAuthRequired,
} from './config';

function setOnline(value: boolean): void {
  vi.stubGlobal('navigator', { onLine: value });
}

describe('network capability policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps BYOK available but suspends personal cloud in the default local-only build', () => {
    setOnline(true);

    expect(canUseHostedService()).toBe(false);
    expect(canUsePersonalCloud()).toBe(false);
    expect(canUseByokProvider()).toBe(true);
    expect(canUseExternalContent()).toBe(true);
    expect(canUseAgentExtension()).toBe(true);
    expect(canUseNetwork('hosted-service')).toBe(false);
    expect(isAuthRequired()).toBe(false);
  });

  it('blocks every network purpose while the OS reports offline', () => {
    setOnline(false);

    expect(canUseHostedService()).toBe(false);
    expect(canUsePersonalCloud()).toBe(false);
    expect(canUseByokProvider()).toBe(false);
    expect(canUseExternalContent()).toBe(false);
    expect(canUseAgentExtension()).toBe(false);
  });

  it('enables a configured Hosted service while Drive remains suspended', async () => {
    setOnline(true);
    vi.stubEnv('VITE_LOCAL_ONLY_MODE', 'false');
    vi.resetModules();
    const configured = await import('./config');
    expect(configured.canUseHostedService()).toBe(true);
    expect(configured.canUsePersonalCloud()).toBe(false);
    expect(configured.canUseNetwork('personal-cloud')).toBe(false);
    expect(configured.canUseByokProvider()).toBe(true);
  });

  it('does not treat Node\'s partial navigator without onLine as offline', () => {
    vi.stubGlobal('navigator', {});

    expect(canUseByokProvider()).toBe(true);
    expect(canUsePersonalCloud()).toBe(false);
    expect(canUseExternalContent()).toBe(true);
    expect(canUseAgentExtension()).toBe(true);
  });
});
