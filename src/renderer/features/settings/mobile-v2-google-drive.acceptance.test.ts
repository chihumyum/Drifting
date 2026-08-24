import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

describe('Mobile V2 Google Drive Settings release boundary', () => {
  it('reuses the provider-neutral product controls without mounting project import', () => {
    const mobile = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');
    const panel = read(
      'src/renderer/features/settings/panels/ControlSettingsPanels.tsx',
    );
    expect(mobile).toContain(
      '<SyncPanel registerRef={REGISTER_NOOP} projectImportEnabled={false} />',
    );
    for (const command of [
      'connectGoogleDrive',
      'cancelPendingGoogleDrive',
      'retryProvisioning',
      'reauthorizeGoogleDrive',
      'triggerManualSync',
      'setPaused',
      'disconnectGoogleDrive',
    ]) {
      expect(panel).toContain(`productSyncCommands.${command}`);
    }
  });

  it('reauthorizes the same account and resumes the owned disconnect in one action', () => {
    const panel = read(
      'src/renderer/features/settings/panels/ControlSettingsPanels.tsx',
    );
    const reauthorize = panel.indexOf('await productSyncCommands.reauthorizeGoogleDrive()');
    const continueDisconnect = panel.indexOf(
      'await productSyncCommands.disconnectGoogleDrive(signal)',
      reauthorize,
    );
    expect(panel).toContain("authority.transitionKind === 'disconnect'");
    expect(panel).toContain('settings.sync.reauthorize_and_disconnect');
    expect(reauthorize).toBeGreaterThan(0);
    expect(continueDisconnect).toBeGreaterThan(reauthorize);
  });

  it('fails closed until every native seam is available', () => {
    const presentation = read(
      'src/renderer/features/settings/google-drive-settings-presentation.ts',
    );
    const panel = read(
      'src/renderer/features/settings/panels/ControlSettingsPanels.tsx',
    );
    for (const capability of [
      'featureStatus.googleDriveOAuth',
      'featureStatus.googleDriveTransport',
      'featureStatus.syncObjectStore',
    ]) {
      expect(presentation).toContain(capability);
    }
    expect(panel).toContain('disabled={!googleDriveReadiness.available || cloudBusy !== null}');
    expect(panel).toContain("data-state={googleDriveReadiness.available ? 'ready' : 'setup-required'}");
  });

  it('renders localized actions and sanitized codes instead of native error messages', () => {
    const panel = read(
      'src/renderer/features/settings/panels/ControlSettingsPanels.tsx',
    );
    const presentation = read(
      'src/renderer/features/settings/google-drive-settings-presentation.ts',
    );
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      settings: { sync: { issues: Record<string, { title: string; desc: string }> } };
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as typeof en;
    const cloudAction = panel.slice(
      panel.indexOf('const runCloudAction = async'),
      panel.indexOf('const handleMarkdownExport = async'),
    );
    expect(panel).toContain('role="alert"');
    expect(panel).toContain('<code>{cloudIssue.code}</code>');
    expect(cloudAction).not.toMatch(/error\.message|String\(error\)/u);
    expect(presentation).toContain("slice(0, 64)");
    expect(presentation).toContain("replace(/[^A-Za-z0-9_.-]/gu, '-')");
    for (const issue of [
      'configuration',
      'offline',
      'reauthorize',
      'account-mismatch',
      'permission',
      'rate-limited',
      'quota',
      'cancelled',
      'update-required',
      'data-integrity',
      'retry',
    ]) {
      expect(en.settings.sync.issues[issue]?.title).toBeTruthy();
      expect(en.settings.sync.issues[issue]?.desc).toBeTruthy();
      expect(zh.settings.sync.issues[issue]?.title).toBeTruthy();
      expect(zh.settings.sync.issues[issue]?.desc).toBeTruthy();
    }
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
