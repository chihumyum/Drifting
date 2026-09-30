import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('shared Settings while Google Drive is suspended', () => {
  it('reuses local recovery and Hosted account controls without mounting project import', () => {
    const mobile = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    expect(mobile).toContain('<StandaloneSettingsPanel');
    expect(read('src/renderer/features/settings/StandaloneSettingsPanel.tsx')).toContain(
      '<SyncPanel registerRef={REGISTER_NOOP} projectImportEnabled={false} />',
    );
    expect(panel).not.toContain('productSyncCommands.');
    expect(panel).toContain('settings.hosted.manage');
    expect(panel).toContain('exportAllProjectsAsRelationalMarkdown()');
  });

  it('keeps compact Settings portrait-safe, touch-sized, and hardware-Back owned', () => {
    const mobile = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');
    const back = read('src/renderer/shells/mobile/useMobileAndroidBack.ts');
    const css = read('src/styles/mobile-settings.css');
    expect(mobile).toContain('useMobileAndroidBack(handleBack)');
    expect(back).toContain('onBackButtonPress(() =>');
    expect(back).toContain('const latest = consumers[consumers.length - 1]');
    expect(css).toContain('width: 100dvw');
    expect(css).toContain('height: 100dvh');
    expect(css).toContain('var(--safe-area-top)');
    expect(css).toContain('overflow-x: hidden');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('touch-action: pan-y');
    expect(css).toContain('overflow-wrap: anywhere');
  });

  it('keeps production configuration local and the renderer credential contract opaque', () => {
    const ignore = read('.gitignore');
    const mobileArchitecture = read(
      'src/renderer/sync/providers/google-drive/mobile-oauth.architecture.test.ts',
    );
    const launcherAcceptance = read(
      'src/renderer/platform/mobile-tauri-launcher.acceptance.test.ts',
    );
    expect(ignore).toContain('.env.local');
    expect(mobileArchitecture).toContain(
      'expect(oauthDtos).not.toMatch(/accessToken|refreshToken|email|sessionUri/u)',
    );
    expect(mobileArchitecture).toContain(
      "expect(capabilities).not.toContain('drifting-google-drive-oauth')",
    );
    expect(launcherAcceptance).toContain('mode & 0o777).toBe(0o600)');
    expect(launcherAcceptance).toContain(
      'expect(JSON.stringify(summary)).not.toContain(clientId)',
    );
  });

  it('keeps the real-account hard gate machine-complete and privacy-strict', () => {
    const contract = JSON.parse(
      read('docs/qa/google-drive-physical-evidence-contract.json'),
    ) as {
      requiredPlatforms: string[];
      requiredScenarios: string[];
    };
    const template = JSON.parse(
      read('docs/qa/google-drive-physical-evidence.template.json'),
    ) as {
      artifacts: Record<string, unknown>;
      scenarios: Array<{ result: string }>;
    };
    const validator = read('scripts/check-google-drive-physical-evidence.ts');
    expect(contract.requiredPlatforms).toEqual(['desktop', 'ios', 'android']);
    expect(contract.requiredScenarios).toHaveLength(40);
    expect(Object.keys(template.artifacts).sort()).toEqual(['android', 'desktop', 'ios']);
    expect(template.scenarios).toHaveLength(contract.requiredScenarios.length);
    expect(template.scenarios.every((scenario) => scenario.result === 'not-run')).toBe(true);
    expect(validator).toContain('evidence contains a forbidden credential, account, URL, or local-path shape');
    expect(validator).toContain("scenario.result === 'pass'");
    expect(validator).toContain('scenario.evidenceSha256.length === 0');
  });
});
