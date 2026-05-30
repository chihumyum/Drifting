/**
 * Claude OAuth (PKCE, manual code-paste flow).
 *
 * This is the same flow Claude Code's `setup-token` uses: we open the Claude
 * authorize page in the user's browser, they approve and copy the displayed
 * authorization code, paste it back into the app, and we exchange it for a
 * long-lived OAuth token used as CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Values (client_id / endpoints / scopes) are the public Claude Code OAuth
 * client — ported from the Apache-2.0 craft-agents project.
 */
import { randomBytes, createHash } from 'node:crypto';

const CONFIG = {
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  AUTH_URL: 'https://claude.ai/oauth/authorize',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  REDIRECT_URI: 'https://console.anthropic.com/oauth/code/callback',
  SCOPES: 'org:create_api_key user:profile user:inference',
} as const;

const USER_AGENT = 'Drifting/1.0 (claude-agent)';
const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export interface ClaudeTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

interface OAuthFlowState {
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

// In-memory state for the in-progress flow (single concurrent flow is fine).
let currentFlow: OAuthFlowState | null = null;

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * Build the authorization URL and stash PKCE/state in memory.
 * Caller opens this URL in the user's browser.
 */
export function prepareClaudeOAuth(): string {
  const state = randomBytes(32).toString('hex');
  const { codeVerifier, codeChallenge } = generatePKCE();

  currentFlow = { state, codeVerifier, expiresAt: Date.now() + STATE_EXPIRY_MS };

  const params = new URLSearchParams({
    code: 'true',
    client_id: CONFIG.CLIENT_ID,
    response_type: 'code',
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: CONFIG.SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${CONFIG.AUTH_URL}?${params.toString()}`;
}

/** Exchange the pasted authorization code for tokens. */
export async function exchangeClaudeCode(authorizationCode: string): Promise<ClaudeTokens> {
  if (!currentFlow) {
    throw new Error('No OAuth flow in progress. Start the connection again.');
  }
  if (Date.now() > currentFlow.expiresAt) {
    currentFlow = null;
    throw new Error('Authorization code window expired (>10 min). Start again.');
  }

  // The pasted code is often "code#state" or "code&state" — strip fragments.
  const cleanedCode = authorizationCode.trim().split('#')[0]?.split('&')[0] ?? authorizationCode.trim();

  const body = {
    grant_type: 'authorization_code',
    client_id: CONFIG.CLIENT_ID,
    code: cleanedCode,
    redirect_uri: CONFIG.REDIRECT_URI,
    code_verifier: currentFlow.codeVerifier,
    state: currentFlow.state,
  };

  const res = await fetch(CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} - ${await readError(res)}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  currentFlow = null;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    scopes: data.scope ? data.scope.split(' ') : undefined,
  };
}

/** Refresh an expired access token using the stored refresh token. */
export async function refreshClaudeToken(refreshToken: string): Promise<ClaudeTokens> {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CONFIG.CLIENT_ID,
  };

  const res = await fetch(CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} - ${await readError(res)}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/** True if the token is missing an expiry that is within 5 minutes. */
export function isTokenExpired(expiresAt?: number): boolean {
  if (!expiresAt) return false;
  return Date.now() + 5 * 60 * 1000 >= expiresAt;
}

async function readError(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return `HTTP ${res.status} ${res.statusText}`;
  }
  try {
    const j = JSON.parse(text) as { error_description?: string; error?: string };
    return j.error_description || j.error || text;
  } catch {
    return text;
  }
}
