export type ResolvedColorScheme = 'light' | 'dark';
export type PersistedThemeMode = ResolvedColorScheme | 'system';

export function readPersistedThemeMode(raw: string | null): PersistedThemeMode {
  if (!raw) return 'light';
  try {
    const value = JSON.parse(raw) as { state?: { themeMode?: unknown } };
    const mode = value.state?.themeMode;
    return mode === 'dark' || mode === 'system' || mode === 'light' ? mode : 'light';
  } catch {
    return 'light';
  }
}

export function resolveColorScheme(
  mode: PersistedThemeMode,
  systemPrefersDark: boolean,
): ResolvedColorScheme {
  return mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode;
}

export function applyResolvedColorScheme(
  root: HTMLElement,
  scheme: ResolvedColorScheme,
): void {
  root.classList.toggle('dark', scheme === 'dark');
  root.dataset.colorScheme = scheme;
  root.style.colorScheme = scheme;
}

/** Apply persisted appearance before React mounts so dark mode never waits on an effect. */
export function applyInitialThemeBeforeRender(): ResolvedColorScheme {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem('settings-storage');
  } catch {
    // Restricted webviews can reject storage access. The public default stays light.
  }
  const mode = readPersistedThemeMode(raw);
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const scheme = resolveColorScheme(mode, systemPrefersDark);
  applyResolvedColorScheme(document.documentElement, scheme);
  return scheme;
}
