/**
 * Crash reports describe where Drifting failed, never what the author wrote.
 * Error messages are developer-authored but can embed data (a parse error
 * quoting its input, a thrown value carrying prose), so every free-text field
 * is truncated and long natural-language runs and quoted spans are redacted.
 */

const MAX_MESSAGE = 300;
const MAX_FRAMES = 40;
const MAX_STACK = 16 * 1024;
// Twelve or more consecutive CJK characters are prose, not an identifier.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？、；：“”‘’（）《》]{12,}/gu;
// Quoted spans longer than 40 characters, in ASCII or typographic quotes.
const LONG_QUOTED = /(["'`“‘「『])[^"'`”’」』\n]{40,}(["'`”’」』])/gu;
// Long runs of words separated by spaces read like sentences of content.
const LONG_SENTENCE = /(?:\b[\p{L}'’-]+\b[ ,;:]+){12,}\b[\p{L}'’-]+\b/gu;
const HOME_PATH = /\/(?:Users|home)\/[^/\s:)]+/g;

export function sanitizeReportText(text: string, max = MAX_MESSAGE): string {
  const redacted = text
    .replace(HOME_PATH, '~')
    .replace(CJK_RUN, '[text]')
    .replace(LONG_QUOTED, '$1[text]$2')
    .replace(LONG_SENTENCE, '[text]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/** Keep only stack frames (JS and Rust), without the leading message line. */
export function sanitizeStack(stack: string | undefined): string {
  if (!stack) return '';
  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      /^at\s/.test(line) || /@.*:\d+:\d+$/.test(line) || /^\d+:\s/.test(line) || /^at\s.*:\d+/.test(line),
    )
    .slice(0, MAX_FRAMES)
    .map((line) => sanitizeReportText(line, 400));
  const joined = frames.join('\n');
  return joined.length > MAX_STACK ? joined.slice(0, MAX_STACK) : joined;
}

const TOKEN_UNSAFE = /[^A-Za-z0-9:._-]+/g;

export function reportToken(value: string, max = 64): string {
  const token = value.replace(TOKEN_UNSAFE, '-').replace(/^-+|-+$/g, '');
  return (token || 'unknown').slice(0, max);
}

/** A stable grouping key: kind, error name and the first frame's file location. */
export function reportFingerprint(kind: string, name: string, stack: string): string {
  const frame = stack.split('\n')[0] ?? '';
  // Bundled file names change with every build, so only their stem is kept.
  const location = (frame.match(/([A-Za-z0-9_.-]+?)(?:-[A-Za-z0-9_]{6,})?\.(?:js|ts|tsx|rs)(?::\d+)?/)?.[0] ?? '')
    .replace(/-[A-Za-z0-9_]{6,}(?=\.)/, '');
  return reportToken(`${kind}:${name}:${location}`, 128);
}
