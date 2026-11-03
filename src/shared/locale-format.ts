import { normalizeUiLocale } from './ui-locales';

/** UI time and counts follow the selected language, independently of the OS. */
export function formatRelativeTime(iso: string | number, locale: string, now = Date.now()): string {
  const then = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const elapsed = Math.max(0, now - then);
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86400000], ['month', 30 * 86400000], ['day', 86400000],
    ['hour', 3600000], ['minute', 60000],
  ];
  const format = new Intl.RelativeTimeFormat(normalizeUiLocale(locale), { numeric: 'auto' });
  for (const [unit, milliseconds] of units) {
    if (elapsed >= milliseconds) return format.format(-Math.floor(elapsed / milliseconds), unit);
  }
  return format.format(0, 'second');
}

export function formatCompactCount(count: number, locale: string): string {
  return new Intl.NumberFormat(normalizeUiLocale(locale), {
    notation: 'compact', maximumFractionDigits: 1,
  }).format(count);
}
