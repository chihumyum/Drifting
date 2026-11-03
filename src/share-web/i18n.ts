import i18next from 'i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import es from './locales/es.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import ptBR from './locales/pt-BR.json';
import { detectUiLocale } from '../shared/ui-locales';
import { formatRelativeTime } from '../shared/locale-format';

const READER_TRANSLATIONS = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, ja, ko, es, de, fr, 'pt-BR': ptBR };

export const locale = detectUiLocale(typeof navigator === 'undefined' ? ['en'] : navigator.languages?.length ? navigator.languages : [navigator.language]);
const reader = i18next.createInstance();
void reader.init({
  resources: Object.fromEntries(Object.entries(READER_TRANSLATIONS).map(([code, translation]) => [code, { translation: translation }])),
  lng: locale, fallbackLng: 'en', initAsync: false, interpolation: { escapeValue: false },
});
const text = (key: string, values: Record<string, string | number> = {}) => reader.t(key, values);
const errors = Object.fromEntries(Object.keys(READER_TRANSLATIONS.en.errors).map(code => [code, text(`errors.${code}`)]));

export const t = {
  loading: text('loading'), notFound: text('notFound'), loadFailed: text('loadFailed'), retry: text('retry'),
  updatedNow: text('updatedNow'), commentsClosed: text('commentsClosed'), comments: text('comments'),
  addComment: text('addComment'), placeholder: text('placeholder'), post: text('post'), posting: text('posting'),
  cancel: text('cancel'), close: text('close'), resolved: text('resolved'), withdraw: text('withdraw'),
  you: text('you'), passageChanged: text('passageChanged'), signIn: text('signIn'), signUp: text('signUp'), signOut: text('signOut'),
  name: text('name'), email: text('email'), password: text('password'), code: text('code'), verify: text('verify'),
  haveAccount: text('haveAccount'), needAccount: text('needAccount'), outline: text('outline'),
  sharedBy: (name: string) => name ? text('sharedBy', { name }) : text('sharedManuscript'),
  updatedAt: (time: string) => text('updatedAt', { time }),
  commentCount: (count: number) => count ? text('commentCount', { count }) : text('comments'),
  codeSent: (email: string) => text('codeSent', { email }),
  signedInAs: (name: string) => text('signedInAs', { name }),
  hiddenItems: (count: number) => text('hiddenItems', { count }),
  chapterNumber: (count: number) => text('chapterNumber', { count }),
  words: (count: number) => text('words', { count: count.toLocaleString(locale) }),
  kinds: Object.fromEntries(Object.keys(READER_TRANSLATIONS.en.kinds).map(kind => [kind, text(`kinds.${kind}`)])) as Record<'chapter' | 'drift' | 'element' | 'storyline' | 'category', string>,
  errors,
};

const ALIASES: Record<string, string> = {
  HTTP_429: 'RATE_LIMITED', USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'USER_ALREADY_EXISTS', INVALID_PASSWORD: 'INVALID_EMAIL_OR_PASSWORD',
};
export function errorText(code: string): string {
  return t.errors[ALIASES[code] ?? code] ?? t.errors.fallback!;
}
export function formatTime(iso: string): string {
  return formatRelativeTime(iso, locale);
}
if (typeof document !== 'undefined') {
  document.documentElement.lang = locale;
  document.documentElement.dir = 'ltr';
}
