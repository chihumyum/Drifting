import { describe, expect, it } from 'vitest';
import { noticeLink, parseAccountNotices } from './notice-api';

const text = { title: '今晚维护', body: '22:00 起同步暂停约十分钟。' };

describe('account notices v1 response', () => {
  it('keeps well-formed notices in publication order', () => {
    const parsed = parseAccountNotices({
      notices: [
        { id: 'b', seq: 7, personal: true, content: { zh: text }, link: null, publishedAt: '2026-11-13T07:00:00.000Z', expiresAt: 'x' },
        { id: 'a', seq: 3, personal: false, content: { zh: text, en: { title: ' Maintenance ', body: ' Tonight. ' } },
          link: 'https://example.test/status', publishedAt: '2026-11-12T07:00:00.000Z' },
      ],
      readThrough: 3,
      refreshAfterSeconds: 60,
    });
    expect(parsed).toEqual({
      notices: [
        { id: 'a', seq: 3, personal: false, content: { zh: text, en: { title: 'Maintenance', body: 'Tonight.' } },
          link: 'https://example.test/status', publishedAt: '2026-11-12T07:00:00.000Z' },
        { id: 'b', seq: 7, personal: true, content: { zh: text }, link: null, publishedAt: '2026-11-13T07:00:00.000Z' },
      ],
      readThrough: 3,
      refreshAfterSeconds: 60,
    });
  });

  it('drops what is malformed instead of showing it half', () => {
    const parsed = parseAccountNotices({
      notices: [
        null,
        { id: '', seq: 1, content: { zh: text } },
        { id: 'no-seq', content: { zh: text } },
        { id: 'negative', seq: -1, content: { zh: text } },
        { id: 'no-text', seq: 2, content: {} },
        { id: 'blank-title', seq: 3, content: { zh: { title: '  ', body: '正文' } } },
        { id: 'markup', seq: 4, content: { zh: { title: 7, body: '正文' }, en: { title: 'Kept', body: '' } }, link: 'javascript:alert(1)' },
      ],
      readThrough: '9',
    });
    expect(parsed.notices).toEqual([
      { id: 'markup', seq: 4, personal: false, content: { en: { title: 'Kept', body: '' } }, link: null, publishedAt: '' },
    ]);
    expect(parsed.readThrough).toBe(0);
  });

  it('refuses a response without a notice list', () => {
    for (const value of [null, [], {}, { notices: 'none' }]) expect(() => parseAccountNotices(value)).toThrow('invalid-response');
  });

  it('keeps the refresh interval between fifteen seconds and an hour', () => {
    const refresh = (refreshAfterSeconds: unknown) => parseAccountNotices({ notices: [], refreshAfterSeconds }).refreshAfterSeconds;
    expect(refresh(undefined)).toBe(60);
    expect(refresh('soon')).toBe(60);
    expect(refresh(Number.NaN)).toBe(60);
    expect(refresh(1)).toBe(15);
    expect(refresh(20)).toBe(20);
    expect(refresh(86_400)).toBe(3600);
  });

  it('opens only an https page without credentials', () => {
    expect(noticeLink('https://example.test/a?b=1')).toBe('https://example.test/a?b=1');
    for (const link of ['http://example.test', 'javascript:alert(1)', 'drifting://open', 'https://user:pw@example.test', 'example.test', '', null, 7])
      expect(noticeLink(link)).toBeNull();
  });
});
