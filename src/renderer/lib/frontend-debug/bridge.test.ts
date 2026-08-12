import { describe, expect, it } from 'vitest';
import { shouldCaptureFrontendDebugResource } from './bridge';

describe('frontend debug resource telemetry', () => {
  const daemon = new URL('http://127.0.0.1:4318');

  it('excludes its own renderer transport to prevent telemetry feedback loops', () => {
    expect(
      shouldCaptureFrontendDebugResource('http://127.0.0.1:4318/renderer/telemetry', daemon),
    ).toBe(false);
    expect(shouldCaptureFrontendDebugResource('http://127.0.0.1:4318/renderer/next', daemon)).toBe(
      false,
    );
    expect(shouldCaptureFrontendDebugResource('http://localhost:3000/api/projects', daemon)).toBe(
      true,
    );
  });
});
