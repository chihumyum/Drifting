const LEGACY_ACCENT_PROPERTIES = [
  '--accent',
  '--accent-border',
  '--accent-foreground',
  '--ring',
] as const;

/**
 * Remove the pre-skin custom-accent override.
 *
 * Accent is now a semantic part of each classic/modern + light/dark palette
 * in index.css. Keeping the old inline override would outrank every palette
 * and could pair one theme's accent with another theme's foreground/ring.
 */
export function initAccentColor() {
  const root = document.documentElement;
  for (const property of LEGACY_ACCENT_PROPERTIES) root.style.removeProperty(property);
  try {
    localStorage.removeItem('accentHue');
  } catch {
    // Some embedded/privacy-restricted WebViews expose localStorage but deny
    // access. Palette initialization must still leave the app bootable.
  }
}
