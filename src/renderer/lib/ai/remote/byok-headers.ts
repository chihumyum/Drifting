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
import { byokKeychain } from '../../byok-keychain';

/**
 * Returns the BYOK headers to attach to a copilot request, or an empty object
 * for the hosted path. The active provider is the user's `byokProvider`
 * setting; its key is read just-in-time from the OS keychain. Async because the
 * keychain read crosses to the main process.
 */
export async function aiByokHeaders(): Promise<Record<string, string>> {
  const { aiMode, byokProvider } = useSettingsStore.getState();
  if (aiMode !== 'byok') return {};
  const key = await byokKeychain.get(byokProvider);
  if (!key) {
    // BYOK selected but the chosen provider has no key — fall back to the hosted
    // path rather than failing the call (surfaced in the UI as a warning).
    console.warn(
      `[ai] ai_mode=byok but no "${byokProvider}" key in keychain — falling back to hosted`,
    );
    return {};
  }
  return { 'X-AI-Provider': byokProvider, 'X-AI-Provider-Key': key };
}
