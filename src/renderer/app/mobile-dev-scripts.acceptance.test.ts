import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('mobile dev scripts', () => {
  it('exposes development commands and a standalone iOS device Debug installer', () => {
    const rootPackage = JSON.parse(source('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(rootPackage.scripts['mobile:ios:dev']).toBe('node scripts/run-mobile-dev.mjs ios');
    expect(rootPackage.scripts['mobile:android:dev']).toBe(
      'node scripts/run-mobile-dev.mjs android',
    );
    expect(rootPackage.scripts['mobile:ios:device:debug']).toBe(
      'node scripts/install-ios-debug-device.mjs',
    );
  });

  it('keeps mobile defaults reachable and accepts explicit device/options forwarding', () => {
    const runner = source('scripts/run-mobile-dev.mjs');

    expect(runner).toContain('rawForwardedArgs[0] ===');
    expect(runner).toContain('rawForwardedArgs.slice(1)');
    expect(runner).toContain('networkInterfaces()');
    expect(runner).toContain(
      "return lanAddress ? `http://${lanAddress}:3000` : 'http://localhost:3000'",
    );
    expect(runner).toContain("env.VITE_LOCAL_ONLY_MODE === 'false'");
    expect(runner).toContain('await assertServiceReachable(env.VITE_API_BASE_URL)');
    expect(runner).toContain('await findAvailableVitePort()');
    expect(runner).toContain("['127.0.0.1', '::1', findLanIpv4()]");
    expect(runner).toContain('isPortAvailable(port, host)');
    expect(runner).toContain('build: { devUrl: `http://localhost:${vitePort}` }');
    expect(runner).toContain('env.DRIFTING_VITE_PORT = String(vitePort)');
    expect(runner).toContain('use the default local-only mode');
    expect(runner).toContain('env.NDK_HOME, env.ANDROID_NDK_HOME');
    expect(runner).toContain("path.join(homedir(), 'Library', 'Android', 'sdk')");
    expect(runner).toContain("'dev', '--config', devConfig, ...forwardedArgs");
    expect(runner).toContain("path.join(repoDir, '.env.local')");
    expect(runner).toContain('...readLocalEnvironment(envFile)');
    expect(runner).toContain('...stringEnvironment(baseEnvironment)');
    expect(runner).toContain('writeIosGoogleOauthLocalConfig(env)');
  });

  it('exposes the Tauri device host through Vite and records manual acceptance', () => {
    const vite = source('vite.renderer.config.ts');
    const readme = source('README.md');
    const docsIndex = source('docs/README.md');
    const runbook = source('docs/mobile-device-acceptance.md');

    expect(vite).toContain('process.env.TAURI_DEV_HOST');
    expect(vite).toContain('host: tauriDevHost || false');
    expect(vite).toContain("process.env.DRIFTING_VITE_PORT ?? '5173'");
    expect(vite).toContain('clientPort: devPort');
    expect(readme).toContain('docs/README.md');
    expect(docsIndex).toContain('mobile-device-acceptance.md');
    expect(runbook).toContain('pnpm mobile:ios:dev');
    expect(runbook).toContain('pnpm mobile:android:dev');
    expect(runbook).toContain('pnpm mobile:ios:device:debug -- --device');
    expect(runbook).toContain('不启动 Vite dev server');
    expect(runbook).toContain('VITE_LOCAL_ONLY_MODE=false');
    expect(runbook).toContain('不能表述为移动端整体已验收');
  });
});
