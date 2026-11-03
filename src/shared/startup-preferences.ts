import { readInitialUiLocale } from './ui-locales';

/** Bundled without dependencies into public/startup.js before the app graph. */
const STARTUP_LABELS = {
  'zh-CN': '正在启动 Drifting', 'zh-TW': '正在啟動 Drifting', en: 'Starting Drifting',
  ja: 'Drifting を起動しています', ko: 'Drifting 시작 중', es: 'Iniciando Drifting',
  de: 'Drifting wird gestartet', fr: 'Démarrage de Drifting', 'pt-BR': 'Iniciando o Drifting',
};
let themeMode: unknown;
try {
  themeMode = JSON.parse(localStorage.getItem('settings-storage') ?? 'null')?.state?.themeMode;
} catch { /* Restricted or corrupt storage uses the default light theme. */ }
const dark = themeMode === 'dark' || (themeMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
const root = document.documentElement;
root.classList.toggle('dark', dark);
root.dataset.colorScheme = dark ? 'dark' : 'light';
root.style.colorScheme = dark ? 'dark' : 'light';
const locale = readInitialUiLocale();
root.lang = locale;
root.dir = 'ltr';
document.getElementById('app-startup-loading')?.setAttribute('aria-label', STARTUP_LABELS[locale]);
