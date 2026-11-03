import { ComponentProps, ElementType, useEffect, useState } from 'react';
import { GoogleIcon } from '../components/auth/OAuthIcon';
import { hostedAccountFetch } from './auth-client';
import { APP_CONFIG, canUseHostedService } from './config';

/**
 * Providers this client can show, by the name the service registers them
 * under. Adding one (WeChat later) is an entry here plus its icon; the service
 * decides which of them are actually offered.
 */
export const OAUTH_PROVIDERS = ['google'] as const;
export type SupportedOAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const OAUTH_PROVIDER_CONFIG: Record<
  SupportedOAuthProvider,
  { name: string; Icon: ElementType<ComponentProps<'svg'>> }
> = {
  google: { name: 'Google', Icon: GoogleIcon },
};

let offered: Promise<SupportedOAuthProvider[]> | null = null;

/**
 * The providers the service declares (`GET /api/auth/providers`) that this
 * client knows, in the client's order. A failed request offers none and is
 * retried next time; a successful answer is kept for the session.
 */
export function loadOAuthProviders(): Promise<SupportedOAuthProvider[]> {
  if (!canUseHostedService()) return Promise.resolve([]);
  offered ??= (async () => {
    const response = await hostedAccountFetch(
      `${APP_CONFIG.API_BASE_URL.replace(/\/$/, '')}/api/auth/providers`,
      { headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store' },
    );
    if (!response.ok) throw new Error(`OAuth providers unavailable (${response.status})`);
    const body = (await response.json()) as { providers?: unknown };
    if (!Array.isArray(body.providers)) throw new Error('OAuth providers response is malformed');
    const declared = new Set(body.providers.map((entry) => (entry as { id?: unknown } | null)?.id));
    return OAUTH_PROVIDERS.filter((id) => declared.has(id));
  })().catch(() => {
    offered = null;
    return [];
  });
  return offered;
}

export function useOAuthProviders(): SupportedOAuthProvider[] {
  const [providers, setProviders] = useState<SupportedOAuthProvider[]>([]);
  useEffect(() => {
    let active = true;
    void loadOAuthProviders().then((list) => {
      if (active) setProviders(list);
    });
    return () => {
      active = false;
    };
  }, []);
  return providers;
}

/** Test seam: forget the cached answer. */
export function resetOAuthProvidersForTests(): void {
  offered = null;
}
