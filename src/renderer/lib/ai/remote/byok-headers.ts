/**
 * BYOK request headers (Phase 4).
 *
 * When the user's ai_mode is 'byok' and they have a provider key in the OS
 * keychain, copilot requests carry the key in `X-AI-Provider-Key` (+ provider
 * id in `X-AI-Provider`). The server uses it transiently to build a throwaway
 * client for that one request and never persists it. When ai_mode is 'hosted'
 * (or no key is set), no header is attached and the server uses its own key.
 *
 * The key lives only in the OS keychain (via byok-keychain → main process); it
 * is read just-in-time per request and never stored in the renderer's state or
 * localStorage. Only DeepSeek is supported server-side for now.
 */
import { useSettingsStore } from '../../../store/settings-store';
import { byokKeychain, type BYOKProvider } from '../../byok-keychain';

/** The single BYOK provider the server currently accepts. */
const BYOK_PROVIDER: BYOKProvider = 'deepseek';

/**
 * Returns the BYOK headers to attach to a copilot request, or an empty object
 * for the hosted path. Async because the key is read from the OS keychain.
 */
export async function aiByokHeaders(): Promise<Record<string, string>> {
  if (useSettingsStore.getState().aiMode !== 'byok') return {};
  const key = await byokKeychain.get(BYOK_PROVIDER);
  if (!key) {
    // BYOK selected but no key configured — fall back to the hosted path rather
    // than failing the call. (Once a quota gate exists, surface this in the UI.)
    console.warn('[ai] ai_mode=byok but no key in keychain — falling back to hosted');
    return {};
  }
  return { 'X-AI-Provider': BYOK_PROVIDER, 'X-AI-Provider-Key': key };
}
