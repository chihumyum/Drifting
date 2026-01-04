// Configuration for local-first development
// This file controls whether the app uses online features or runs fully offline

/**
 * Local-first mode configuration (Obsidian-style)
 * When enabled, the app runs completely offline without any server dependencies
 */
export const APP_CONFIG = {
  // Local-first mode: disable all network features
  LOCAL_ONLY_MODE: true,
  
  // Sync configuration
  ENABLE_SYNC: false,  // Disable automatic sync to server
  
  // Authentication
  REQUIRE_AUTH: false,  // Skip authentication, work directly with local data
  
  // API endpoints (not used in local-only mode)
  API_BASE_URL: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  
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
 * Log debug message if debug mode is enabled
 */
export function debugLog(message: string, ...args: any[]): void {
  if (APP_CONFIG.ENABLE_DEBUG_LOGS) {
    console.log(`[DEBUG] ${message}`, ...args);
  }
}
