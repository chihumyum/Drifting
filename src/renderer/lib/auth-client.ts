import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import { getSessionToken, setSessionToken } from './session-token';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  plugins: [emailOTPClient()],
  fetchOptions: {
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
