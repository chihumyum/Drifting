import { describe, expect, it } from 'vitest';
import { errorText, t } from './i18n';

describe('share reader errors', () => {
  it('says when verification mail cannot go out instead of the generic failure', () => {
    for (const code of ['MAIL_QUOTA_EXHAUSTED', 'MAIL_DELIVERY_FAILED']) {
      expect(errorText(code)).not.toBe(t.errors.fallback);
    }
    expect(errorText('MAIL_QUOTA_EXHAUSTED')).toMatch(/tomorrow|明天/);
  });
});

// Each translation keeps opaque authored values and authentication errors intact.
describe('localized share reader', () => {
  it('preserves author names, emails and chapter numbers', () => {
    expect(t.sharedBy('Synthetic Ω')).toContain('Synthetic Ω');
    expect(t.codeSent('synthetic@example.invalid')).toContain('synthetic@example.invalid');
    expect(t.chapterNumber(42)).toContain('42');
    expect(errorText('unknown-error')).toBe(t.errors.fallback);
  });
});
