import { afterEach, expect, it, vi } from 'vitest';
import viteConfiguration from '../../../vite.renderer.config';
// @ts-expect-error Build/launcher modules execute as native ESM.
import { sentryBuildConfiguration, sentryOrigin, sentrySecurityOverride } from '../../../scripts/sentry-environment.mjs';
// @ts-expect-error Build/launcher modules execute as native ESM.
import { createDesktopTauriConfigOverride } from '../../../scripts/run-desktop-tauri.mjs';
// @ts-expect-error Build/launcher modules execute as native ESM.
import { createWorktreePlan } from '../../../scripts/run-worktree-dev.mjs';
import { configuredSentryDsn } from '../services/diagnostics/sentry-policy';

const environment = { VITE_LOCAL_ONLY_MODE: 'false', DRIFTING_HOSTED_ORIGIN: 'https://sync.example.test',
  VITE_SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@errors.example.test/42' };
const build = { command: 'build', version: '0.1.0', revision: 'synthetic' };
afterEach(() => vi.unstubAllEnvs());

it('requires a separate acceptance build for the packaged controls and leaves normal entries untouched', () => {
  vi.stubEnv('DRIFTING_SENTRY_PACKAGED_ACCEPTANCE', '1');
  expect(() => viteConfiguration({ command: 'serve', mode: 'development' })).toThrow(/explicit Hosted-capable/);
  vi.stubEnv('DRIFTING_SENTRY_PACKAGED_ACCEPTANCE', '');
  const config = viteConfiguration({ command: 'serve', mode: 'development' });
  expect(JSON.stringify(config.plugins)).not.toContain('sentry-packaged-acceptance');
});

it('keeps the local-only network boundary even when a DSN was inherited', () => {
  const local = { ...environment, VITE_LOCAL_ONLY_MODE: 'true' };
  expect(sentryOrigin(local)).toBeNull();
  expect(sentryBuildConfiguration(local, build)).toBeNull();
  expect(createDesktopTauriConfigOverride({ command: 'dev', environment: local })).toBeNull();
});

it('validates the same DSN in the renderer and build, and scopes CSP to its exact host', () => {
  expect(sentryOrigin(environment)).toBe('https://errors.example.test');
  expect(configuredSentryDsn(environment.VITE_SENTRY_DSN)).not.toBeNull();
  const security = sentrySecurityOverride({ csp: "default-src 'self'; connect-src 'self'", devCsp: "connect-src 'self'" }, environment);
  expect(security.csp).toContain("connect-src 'self' https://errors.example.test");
  expect(security.csp).not.toContain('0123456789abcdef');
  expect(sentrySecurityOverride(security, environment)).toEqual(security);
  expect(createDesktopTauriConfigOverride({ command: 'dev', environment }).app.security.csp).toContain('https://errors.example.test');
});

it('fails configured production builds without source map upload credentials', () => {
  expect(() => sentryBuildConfiguration(environment, build)).toThrow('SENTRY_AUTH_TOKEN');
  expect(sentryBuildConfiguration({ ...environment, SENTRY_AUTH_TOKEN: 'synthetic-token', SENTRY_ORG: 'synthetic', SENTRY_PROJECT: 'client' }, build))
    .toEqual({ release: 'drifting@0.1.0+synthetic', environment: 'production' });
  expect(sentryBuildConfiguration(environment, { ...build, command: 'serve' }).environment).toBe('development');
  expect(() => sentryOrigin({ ...environment, VITE_SENTRY_DSN: 'https://private-token@errors.example.test/42' })).toThrow();
});

it('passes only explicitly configured diagnostic values into isolated Hosted development', () => {
  const online = createWorktreePlan({ online: true, baseEnvironment: { ...environment,
    VITE_DRIFTING_CRASH_REPORTS_IN_DEV: '1', VITE_PROVIDER_SECRET: 'must-not-enter-renderer',
  } });
  expect(online.environment.VITE_SENTRY_DSN).toBe(environment.VITE_SENTRY_DSN);
  expect(online.environment.VITE_PROVIDER_SECRET).toBeUndefined();
  expect(online.tauriConfig.app.security.devCsp).toContain('https://errors.example.test');
  const local = createWorktreePlan({ baseEnvironment: environment });
  expect(local.environment.VITE_SENTRY_DSN).toBeUndefined();
  expect(local.tauriConfig.app.security.devCsp).not.toContain('https://errors.example.test');
});

it('configures hidden source maps and matching release metadata without exposing upload credentials', () => {
  for (const [key, value] of Object.entries({ ...environment, VITE_API_BASE_URL: 'https://sync.example.test',
    SENTRY_AUTH_TOKEN: 'synthetic-upload-token', SENTRY_ORG: 'synthetic', SENTRY_PROJECT: 'client',
    VITE_SENTRY_RELEASE: 'drifting@acceptance+synthetic', DRIFTING_BUILD_REVISION: 'synthetic',
  })) vi.stubEnv(key, value);
  const config = viteConfiguration({ command: 'build', mode: 'production' });
  expect(config.build?.sourcemap).toBe('hidden');
  expect(config.define?.['import.meta.env.VITE_SENTRY_RELEASE']).toBe('"drifting@acceptance+synthetic"');
  expect(JSON.stringify(config.define)).not.toContain('synthetic-upload-token');
  const plugins: unknown[] = config.plugins ?? [];
  expect(plugins.flat(4).some(plugin => typeof plugin === 'object' && plugin && 'name' in plugin
    && String(plugin.name).includes('sentry'))).toBe(true);
});
