const LEGACY_ACCENT_PROPERTIES = [
  '--accent',
  '--accent-border',
  '--accent-foreground',
  '--ring',
] as const;

const ACCENT_OVERRIDE_PROPERTIES = [
  '--accent',
  '--accent-border',
  '--accent-foreground',
  '--ring',
] as const;

export const ACCENT_COLOR_DEFAULT_LIGHT = '#6a7da0';
export const ACCENT_COLOR_DEFAULT_DARK = '#879dc5';

export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : null;
}

function formatHslPart(value: number): string {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function accentHslTriplet(color: string): string {
  const red = Number.parseInt(color.slice(1, 3), 16) / 255;
  const green = Number.parseInt(color.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(color.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }

  if (hue < 0) hue += 360;
  return `${formatHslPart(hue)} ${formatHslPart(saturation * 100)}% ${formatHslPart(lightness * 100)}%`;
}

function relativeLuminance(color: string): number {
  const channels = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function accentForegroundTriplet(color: string): string {
  const luminance = relativeLuminance(color);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  return whiteContrast >= blackContrast ? '0 0% 100%' : '0 0% 0%';
}

/**
 * Remove direct localStorage/inline overrides left by the retired accentHue
 * implementation before the settings-owned accent preference is applied.
 *
 * Keeping those values would outrank both the shared light/dark defaults and
 * the current persisted preference.
 */
export function initAccentColor() {
  const root = document.documentElement;
  for (const property of LEGACY_ACCENT_PROPERTIES) root.style.removeProperty(property);
  try {
    localStorage.removeItem('accentHue');
    localStorage.removeItem('accentColor');
  } catch {
    // Some embedded/privacy-restricted WebViews expose localStorage but deny
    // access. Palette initialization must still leave the app bootable.
  }
}

/**
 * Apply a user accent override while preserving the stylesheet-owned light and
 * dark defaults when the preference is null or malformed.
 *
 * Consumers expect an HSL triplet because they compose alpha values as
 * `hsl(var(--accent) / <alpha>)`; writing the color picker's hex value directly
 * would invalidate those declarations.
 */
export function applyAccentColor(value: unknown) {
  const root = document.documentElement;
  const color = normalizeAccentColor(value);
  for (const property of ACCENT_OVERRIDE_PROPERTIES) root.style.removeProperty(property);
  if (!color) return;

  const accent = accentHslTriplet(color);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-foreground', accentForegroundTriplet(color));
  root.style.setProperty('--ring', accent);
}
