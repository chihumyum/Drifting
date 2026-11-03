import { formatCompactCount } from '../../../shared/locale-format';

/** Counts follow the selected interface language. */
export function formatShelfWords(words: number, locale: string): string {
  return formatCompactCount(words, locale);
}

/** The heatmap's month under a week's column: 11月, Nov. */
export function formatShelfMonth(iso: string, locale: string): string {
  const [y, m] = iso.split('-').map(Number);
  if (locale.startsWith('zh')) return `${m}月`;
  return new Date(y, (m ?? 1) - 1, 1).toLocaleString(locale, { month: 'short' });
}

/** A day as the heatmap's hover card heads it: 11月2日周一, Mon, Nov 2. */
export function formatShelfDay(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'short' });
}
