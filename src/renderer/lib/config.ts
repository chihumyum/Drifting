// Configuration for local-first development
// This file controls whether the app uses online features or runs fully offline
import loglevel from 'loglevel';

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
  // Local-only mode: disable all network features when explicitly requested.
  LOCAL_ONLY_MODE: readBooleanEnv(import.meta.env.VITE_LOCAL_ONLY_MODE, false),

  // Sync configuration
  ENABLE_SYNC: readBooleanEnv(import.meta.env.VITE_ENABLE_SYNC, true),

  // Authentication
  REQUIRE_AUTH: readBooleanEnv(import.meta.env.VITE_REQUIRE_AUTH, true),

  // BYOK-only build: the server carries NO hosted AI key (we can't legally bill),
  // so the "hosted" AI tier is disabled — the UI hides it and any persisted
  // 'hosted' selection is coerced to BYOK so it can't silently route to the
  // keyless server. Off by default; set VITE_BYOK_ONLY=true in the beta build.
  BYOK_ONLY: readBooleanEnv(import.meta.env.VITE_BYOK_ONLY, false),

  // API endpoints
  API_BASE_URL:
    import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000',

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
 * AI subsystem (Copilot / Shadow / General Agent) hides its hosted option and
 * routes only through the user's own key/account.
 */
export function isByokOnly(): boolean {
  return APP_CONFIG.BYOK_ONLY;
}

/**
 * Log debug message if debug mode is enabled
 */
export function debugLog(message: string, ...args: any[]): void {
  if (APP_CONFIG.ENABLE_DEBUG_LOGS) {
    log.debug(`[DEBUG] ${message}`, ...args);
  }
}
