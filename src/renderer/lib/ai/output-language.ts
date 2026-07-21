/**
 * Writing-language resolution for the BYOK Claude agent (client side).
 *
 * The Gemini/Copilot path resolves this on the server (private service
 * modules/ai/output-language.ts) from synced preferences. Renderer-local Shadow,
 * goal, and Agent flows cannot use that helper, so this mirror resolves the same
 * effective language from local settings (global manuscriptLocale plus a
 * per-project override).
 */
import { useSettingsStore } from '../../store/settings-store';

const LOCALE_NAME: Record<string, string> = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French (français)',
};

/**
 * Human-readable name of the project's writing language (e.g. "Simplified
 * Chinese (简体中文)"), or undefined if the locale isn't recognized. The
 * per-project override 'auto'/unset follows the global manuscriptLocale.
 */
export function resolveWritingLanguage(projectId: string | null | undefined): string | undefined {
  const s = useSettingsStore.getState();
  const per = projectId ? s.copilotOutputLangByProject[projectId] : undefined;
  const locale = !per || per === 'auto' ? s.manuscriptLocale : per;
  return LOCALE_NAME[locale];
}
