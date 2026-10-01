import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./config', () => ({ APP_CONFIG: { API_BASE_URL: 'https://synthetic.example.test' } }));
import { readHostedProfile, writeHostedProfile } from './hosted-profile';
const entries = new Map<string, string>();
beforeEach(() => {
  entries.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('Offline Hosted profile cache', () => {
  it('keeps only display metadata, including avatar removal, and never stores tokens', () => {
    const profile = {
      id: 'synthetic',
      email: 'synthetic@example.test',
      name: 'Author',
      image: null,
      emailVerified: true,
      token: 'must-not-cache',
    };
    writeHostedProfile(profile);
    expect(readHostedProfile()).toEqual({
      id: profile.id,
      email: profile.email,
      name: 'Author',
      image: null,
      emailVerified: true,
    });
    expect([...entries.values()][0]).not.toContain('must-not-cache');
    writeHostedProfile(null);
    expect(readHostedProfile()).toBeNull();
  });
  it('does not display externally hosted images or profiles from another service', () => {
    writeHostedProfile({
      id: 'synthetic',
      email: 'synthetic@example.test',
      name: 'Author',
      image: 'https://example.test/avatar.jpg',
      emailVerified: true,
    });
    expect(readHostedProfile()?.image).toBeNull();
    for (const [key, value] of entries)
      entries.set(
        key,
        value.replace('https://synthetic.example.test', 'https://other.example.test'),
      );
    expect(readHostedProfile()).toBeNull();
  });
});
