/**
 * Output-language resolution (Task 1). Copilot capabilities resolve the
 * project's desired output language here and pass the resulting directive to
 * callStructured, which appends it to the system prompt. This keeps the 副手
 * writing in the manuscript's language instead of drifting into the language
 * of its (English) instructions — the canonical failure being English prose
 * leaking into a Chinese novel.
 *
 * The per-project setting ('auto' = follow manuscriptLocale) lives in the
 * settings store; this module reads it imperatively so non-React callers
 * (capabilities, runners) can use it.
 */
import { useSettingsStore, type LocaleCode } from '../../store/settings-store';

const LOCALE_NAME: Record<LocaleCode, string> = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French (français)',
};

/**
 * Resolve the effective output-language name for a project, or undefined if
 * it can't be determined. 'auto'/unset follows the app's manuscriptLocale.
 * The returned string is a human-readable language name suitable for a prompt
 * directive ("Simplified Chinese (简体中文)").
 */
export function resolveOutputLanguageName(projectId: string): string | undefined {
  const s = useSettingsStore.getState();
  const per = s.copilotOutputLangByProject[projectId];
  const locale: LocaleCode = !per || per === 'auto' ? s.manuscriptLocale : per;
  return LOCALE_NAME[locale];
}
