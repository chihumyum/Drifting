import { describe, expect, it } from 'vitest';
import { BoundedTelemetryBuffer, redactDebugValue, truncateText } from './redaction';

describe('frontend debug evidence safety', () => {
  it('redacts credentials and excludes prose-shaped fields recursively', () => {
    expect(
      redactDebugValue({
        Authorization: 'Bearer secret',
        nested: { apiKey: 'key', contentJson: '{"type":"doc"}', title: 'Visible' },
      }),
    ).toEqual({
      Authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', contentJson: '[OMITTED_PROSE]', title: 'Visible' },
    });
  });

  it('marks bounded text and keeps telemetry ids monotonic', () => {
    expect(truncateText('abcdef', 3)).toEqual({ value: 'abc…', truncated: true });
    const buffer = new BoundedTelemetryBuffer();
    const first = buffer.push({ at: '2026-08-13T00:00:00.000Z', channel: 'console', value: 'a' });
    const second = buffer.push({ at: '2026-08-13T00:00:01.000Z', channel: 'console', value: 'b' });
    expect(first.id).toBe(1);
    expect(buffer.list(first.id).events).toEqual([second]);
  });

  it('masks bearer values and sensitive URL parameters inside evidence strings', () => {
    expect(
      redactDebugValue({
        message: 'failed with Bearer abc.def.ghi',
        url: 'https://example.test/path?token=secret&cursor=2#private',
      }),
    ).toEqual({
      message: 'failed with Bearer [REDACTED]',
      url: 'https://example.test/path?token=%5BREDACTED%5D&cursor=2',
    });
  });
});
