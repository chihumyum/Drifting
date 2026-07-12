/**
 * BYOK request headers (Phase 4).
 *
 * When the user's ai_mode is 'byok' and they have a provider key in the OS
 * keychain, copilot requests carry the key in `X-AI-Provider-Key` (+ provider
 * id in `X-AI-Provider`). The server uses it transiently to build a throwaway
 * client for that one request and never persists it. Pre-Alpha has no hosted
 * fallback: a missing key is an explicit configuration error.
 *
 * The key lives only in the OS keychain (via byok-keychain → main process); it
 * is read just-in-time per request and never stored in the renderer's state or
 * localStorage. Only DeepSeek is supported server-side for now.
 */
import { useSettingsStore } from '../../../store/settings-store';
import { byokKeychain } from '../../byok-keychain';
import { AIError } from '../types';

/**
 * Returns the BYOK headers to attach to a copilot request. The active provider is the user's `byokProvider`
 * setting; its key is read just-in-time from the OS keychain. Async because the
 * keychain read crosses to the main process.
 */
export async function aiByokHeaders(): Promise<Record<string, string>> {
  const { copilotAiMode, copilotByokProvider } = useSettingsStore.getState();
  if (copilotAiMode !== 'byok') {
    throw new AIError('auth', 'BYOK_REQUIRED: hosted AI is disabled in Pre-Alpha.');
  }
  const key = await byokKeychain.get(copilotByokProvider);
  if (!key) {
    throw new AIError(
      'auth',
      `BYOK_REQUIRED: configure a ${copilotByokProvider} API key in Settings.`,
    );
  }
  return { 'X-AI-Provider': copilotByokProvider, 'X-AI-Provider-Key': key };
}
