import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import { getSessionToken, setSessionToken } from './session-token';
import { runtimeViteEnv } from './vite-runtime-env';
import { canUseHostedService } from './config';

const API_BASE_URL =
  (runtimeViteEnv.VITE_API_BASE_URL as string | undefined) ||
  (runtimeViteEnv.VITE_API_URL as string | undefined) ||
  'http://localhost:3000';

/**
 * Transport-level account boundary. Login routes and auth-store actions also
 * gate hosted access, but the Better Auth client is exported and must remain
 * fail-closed even if a future caller invokes it directly in a local-only build.
 */
export const hostedAuthFetch: typeof globalThis.fetch = async (input, init) => {
  if (!canUseHostedService()) {
    const error = new Error(
      'HOSTED_SERVICE_DISABLED: account authentication is unavailable in this build.',
    ) as Error & { code: string };
    error.code = 'HOSTED_SERVICE_DISABLED';
    throw error;
  }
  return globalThis.fetch(input, init);
};

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  plugins: [emailOTPClient()],
  fetchOptions: {
    customFetchImpl: hostedAuthFetch,
    // Token auth instead of cookies. The desktop renderer is a different site
    // from the API, so cookies would be cross-site AND better-auth rejects
    // cookie requests without a valid Origin. Sending no cookies makes
    // better-auth skip the origin/CSRF check; the Bearer token carries the
    // session. The token is captured from the `set-auth-token` header below.
    credentials: 'omit',
    auth: {
      type: 'Bearer',
      token: () => getSessionToken() ?? '',
    },
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get('set-auth-token');
      if (token) setSessionToken(token);
    },
  },
});

export type Session = typeof authClient.$Infer.Session;
