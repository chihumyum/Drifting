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
