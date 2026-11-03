/** Words as the shelf writes them: 8.6 万 in Chinese, 86.4k otherwise. */
export function formatShelfWords(words: number, locale: string): string {
  if (!locale.startsWith('zh')) return words < 1000 ? String(words) : `${(words / 1000).toFixed(1)}k`;
  if (words < 10_000) return String(words);
  return `${(words / 10_000).toFixed(1).replace(/\.0$/, '')} 万`;
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
