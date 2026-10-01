export interface SettingsSliderBounds {
  min: number;
  max: number;
  integer?: boolean;
}

export function parseSettingsSliderValue(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function normalizeSettingsSliderValue(
  value: number,
  { min, max, integer = false }: SettingsSliderBounds,
): number {
  const bounded = Math.min(max, Math.max(min, value));
  return integer ? Math.floor(bounded) : bounded;
}

export function adjustSettingsSliderValue(
  value: number,
  amount: number,
  bounds: SettingsSliderBounds,
): number {
  // Correct arithmetic tails, while preserving a manually entered value's
  // offset instead of snapping it to the slider or arrow increment grid.
  const next = Number((normalizeSettingsSliderValue(value, bounds) + amount).toPrecision(15));
  return normalizeSettingsSliderValue(next, bounds);
}

export function formatSettingsSliderValue(value: number, minimumPrecision: number): string {
  const formatted = value.toFixed(minimumPrecision);
  return Number(formatted) === value ? formatted : String(value);
}
