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
  });

  it('keeps author-selected network purposes available in the default local-only build', () => {
    setOnline(true);

    expect(canUseHostedService()).toBe(false);
    expect(canUsePersonalCloud()).toBe(true);
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

  it('does not treat Node\'s partial navigator without onLine as offline', () => {
    vi.stubGlobal('navigator', {});

    expect(canUseByokProvider()).toBe(true);
    expect(canUsePersonalCloud()).toBe(true);
    expect(canUseExternalContent()).toBe(true);
    expect(canUseAgentExtension()).toBe(true);
  });
});
