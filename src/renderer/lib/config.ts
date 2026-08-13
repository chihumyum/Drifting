// Configuration for local-first development
// This file controls whether the app uses online features or runs fully offline
import loglevel from 'loglevel';
import { runtimeViteEnv } from './vite-runtime-env';

const log = loglevel.getLogger('ConfigLib');
log.setLevel(loglevel.levels.ERROR);

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Local-first mode configuration (Obsidian-style)
 * When enabled, the app runs completely offline without any server dependencies
 */
export const APP_CONFIG = {
  // Public builds are offline-first unless an operator explicitly opts in.
  LOCAL_ONLY_MODE: readBooleanEnv(runtimeViteEnv.VITE_LOCAL_ONLY_MODE as string | undefined, true),

  // Sync configuration
  ENABLE_SYNC: readBooleanEnv(runtimeViteEnv.VITE_ENABLE_SYNC as string | undefined, false),

  // Authentication
  REQUIRE_AUTH: readBooleanEnv(runtimeViteEnv.VITE_REQUIRE_AUTH as string | undefined, false),

  // Pre-Alpha is BYOK-only. Hosted AI is deliberately unavailable regardless
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
    'https://github.com/chihumyum/drifting/blob/main/PRIVACY.md',

  // Database
  DEFAULT_DB_NAME: 'default-project.db',

  // Development
  ENABLE_DEBUG_LOGS: true,
} as const;

/**
 * Check if the app should attempt network operations
 */
export function canUseNetwork(): boolean {
  return !APP_CONFIG.LOCAL_ONLY_MODE && navigator.onLine;
}

/**
 * Check if sync is enabled
 */
export function isSyncEnabled(): boolean {
  return APP_CONFIG.ENABLE_SYNC && canUseNetwork();
}

/**
 * Check if authentication is required
 */
export function isAuthRequired(): boolean {
  return APP_CONFIG.REQUIRE_AUTH;
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
