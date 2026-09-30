// A tiny classic script, served as-is before the application module graph.
// Keep the theme defaults aligned with renderer/lib/initial-theme.ts.
(() => {
  let settings;
  try {
    settings = JSON.parse(window.localStorage.getItem('settings-storage'))?.state;
  } catch {
    // Missing, corrupt or unavailable storage uses the normal light/Chinese defaults.
  }
  const dark = settings?.themeMode === 'dark' ||
    (settings?.themeMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset.colorScheme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  const english = settings?.uiLocale === 'en';
  root.lang = english ? 'en' : 'zh-CN';
  document.getElementById('app-startup-loading')?.setAttribute(
    'aria-label', english ? 'Starting Drifting' : '正在启动 Drifting',
  );
})();
