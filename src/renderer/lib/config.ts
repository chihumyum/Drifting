// Configuration for local-first operation. Network capabilities are separated
// by purpose below: hosted service, personal cloud, author-selected BYOK,
// external content, and explicitly configured Agent extensions.
import loglevel from 'loglevel';
import { runtimeViteEnv } from './vite-runtime-env';

const log = loglevel.getLogger('ConfigLib');
log.setLevel(loglevel.levels.ERROR);

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Local-first mode configuration. When enabled, the app has no dependency on a
 * Drifting-operated server; author-selected providers remain separate capabilities.
 */
export const APP_CONFIG = {
  // Public builds are offline-first unless an operator explicitly opts in.
  LOCAL_ONLY_MODE: readBooleanEnv(runtimeViteEnv.VITE_LOCAL_ONLY_MODE as string | undefined, true),

  // Authentication
  REQUIRE_AUTH: readBooleanEnv(runtimeViteEnv.VITE_REQUIRE_AUTH as string | undefined, false),

  // Public Alpha is BYOK-only. Hosted AI is deliberately unavailable regardless
  // of persisted settings or build environment.
  BYOK_ONLY: true,

  // API endpoints
  API_BASE_URL:
    (runtimeViteEnv.VITE_API_BASE_URL as string | undefined) ||
    (runtimeViteEnv.VITE_API_URL as string | undefined) ||
    'http://localhost:3000',

  // Operators enabling account flows must provide their own consumer terms.
  TERMS_URL: (runtimeViteEnv.VITE_TERMS_URL as string | undefined) || '',
  PRIVACY_URL:
    (runtimeViteEnv.VITE_PRIVACY_URL as string | undefined) ||
    'https://github.com/chihumyum/Drifting/blob/main/PRIVACY.md',

  // Development
  ENABLE_DEBUG_LOGS: true,
} as const;

/**
 * Network access is a capability decision, not the inverse of local-only mode.
 *
 * A local-first build must still be able to call an author-selected BYOK model
 * and, once implemented, an author-selected personal cloud provider. Only the
 * separately operated Drifting hosted service is disabled by LOCAL_ONLY_MODE.
 */
export type NetworkPurpose =
  | 'hosted-service'
  | 'personal-cloud'
  | 'byok-provider'
  | 'external-content'
  | 'agent-extension';

function isBrowserOnline(): boolean {
  // Node 22 exposes a partial `navigator` whose `onLine` is undefined. Only an
  // explicit browser/native `false` means offline; headless tooling must not be
  // mistaken for a disconnected app.
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function canUseNetwork(purpose: NetworkPurpose): boolean {
  if (!isBrowserOnline()) return false;
  if (purpose === 'hosted-service') return !APP_CONFIG.LOCAL_ONLY_MODE;
  return true;
}

export function canUseHostedService(): boolean {
  return canUseNetwork('hosted-service');
}

export function canUsePersonalCloud(): boolean {
  return canUseNetwork('personal-cloud');
}

export function canUseByokProvider(): boolean {
  return canUseNetwork('byok-provider');
}

/** Author-requested web metadata and remote preview images. */
export function canUseExternalContent(): boolean {
  return canUseNetwork('external-content');
}

/**
 * Explicitly configured Agent extensions may use the network in local-first
 * builds. Their durable per-server and per-tool grants remain the authority;
 * this capability only represents current network availability.
 */
export function canUseAgentExtension(): boolean {
  return canUseNetwork('agent-extension');
}

/**
 * Check if authentication is required
 */
export function isAuthRequired(): boolean {
  // LOCAL_ONLY_MODE is the hard product boundary. A stale or contradictory
  // VITE_REQUIRE_AUTH value must never turn a public/local build back into an
  // account client or start a Better Auth session probe.
  return !APP_CONFIG.LOCAL_ONLY_MODE && APP_CONFIG.REQUIRE_AUTH;
}

/**
 * Whether this is a BYOK-only build (hosted AI tier disabled). When true, every
 * AI subsystem (Copilot / General Agent) hides its hosted option and
 * routes only through the user's own credentials. General Agent currently uses
 * the shared DeepSeek BYOK credential; Drifting-hosted inference is off.
 */
export function isByokOnly(): boolean {
  return APP_CONFIG.BYOK_ONLY;
}

/**
 * Log debug message if debug mode is enabled
 */
export function debugLog(message: string, ...args: unknown[]): void {
  if (APP_CONFIG.ENABLE_DEBUG_LOGS) {
    log.debug(`[DEBUG] ${message}`, ...args);
  }
}
