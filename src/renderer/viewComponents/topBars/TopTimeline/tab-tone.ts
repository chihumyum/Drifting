interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface TabTone {
  normalBackground: string;
  hoverBackground: string;
  selectedBackground: string;
  selectedBorder: string;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColor(hex: string): RgbColor | null {
  const normalized = hex.trim();
  if (!normalized.startsWith('#')) {
    return null;
  }

  const raw = normalized.slice(1);
  if (raw.length === 3) {
    const [r, g, b] = raw.split('');
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }

  if (raw.length === 6) {
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
    };
  }

  return null;
}

function parseRgbColor(input: string): RgbColor | null {
  const match = input
    .trim()
    .match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+\s*)?\)$/i);
  if (!match) {
    return null;
  }

  return {
    r: clampByte(Number(match[1])),
    g: clampByte(Number(match[2])),
    b: clampByte(Number(match[3])),
  };
}

function toRgba(color: RgbColor, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function getBaseRgb(color: string | null | undefined): RgbColor {
  const fallback = { r: 184, g: 153, b: 104 };
  if (!color) {
    return fallback;
  }

  return parseHexColor(color) ?? parseRgbColor(color) ?? fallback;
}

export function getSubtleTabTone(color: string | null | undefined): TabTone {
  const base = getBaseRgb(color);
  return {
    normalBackground: toRgba(base, 0.12),
    hoverBackground: toRgba(base, 0.2),
    selectedBackground: toRgba(base, 0.3),
    selectedBorder: toRgba(base, 0.42),
  };
}
