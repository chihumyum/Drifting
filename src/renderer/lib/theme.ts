// Initialize accent color theme on app load
export function initAccentColor() {
  const savedHue = localStorage.getItem('accentHue');
  const hue = savedHue ? parseInt(savedHue) : 30; // Default to brown

  applyAccentColor(hue);
}

export function applyAccentColor(hue: number) {
  const root = document.documentElement;

  // Design tokens are HSL triplets (no hsl() wrapper). Consumers must wrap
  // them as `hsl(var(--accent))` to render — this lets the same token also
  // be used with alpha, e.g. `hsl(var(--accent) / 0.1)`.
  root.style.setProperty('--accent', `${hue} 35% 55%`);
  root.style.setProperty('--accent-border', `${hue} 25% 82%`);
}
