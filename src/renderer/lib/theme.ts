// Initialize accent color theme on app load
export function initAccentColor() {
  const savedHue = localStorage.getItem('accentHue');
  const hue = savedHue ? parseInt(savedHue) : 30; // Default to brown

  applyAccentColor(hue);
}

export function applyAccentColor(hue: number) {
  const root = document.documentElement;

  // Generate accent color variations based on hue
  // Base saturation and lightness values for scholarly aesthetic
  const accentBase = `hsl(${hue}, 35%, 55%)`; // Main accent - mild saturation, medium light
  const accentHover = `hsl(${hue}, 35%, 48%)`; // Hover - slightly darker
  const accentActive = `hsl(${hue}, 35%, 42%)`; // Active - darker still
  const accentBorder = `hsl(${hue}, 25%, 82%)`; // Border - very light, low saturation
  const accentBorderLight = `hsl(${hue}, 20%, 90%)`; // Border light - extremely light

  root.style.setProperty('--accent', accentBase);
  root.style.setProperty('--accent-hover', accentHover);
  root.style.setProperty('--accent-active', accentActive);
  root.style.setProperty('--accent-border', accentBorder);
  root.style.setProperty('--accent-border-light', accentBorderLight);
}
