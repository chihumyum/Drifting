import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  hostedAccountSettingsEnabled,
  withoutHostedAccountSettings,
} from './hosted-settings-policy';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('hosted settings boundary', () => {
  it('defaults public builds to local settings while preserving the hosted seam', () => {
    const items = [{ id: 'account' }, { id: 'subscription' }, { id: 'sync' }];
    expect(hostedAccountSettingsEnabled()).toBe(false);
    expect(withoutHostedAccountSettings(items, false)).toEqual([{ id: 'sync' }]);
    expect(withoutHostedAccountSettings(items, true)).toEqual(items);
  });

  it('gates both desktop and standalone-mobile account panels before mounting them', () => {
    const desktop = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const mobile = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');
    expect(desktop).toContain('withoutHostedAccountSettings(RAIL_BASE, accountSettingsEnabled)');
    expect(desktop).toContain('{accountSettingsEnabled && (');
    expect(mobile).toContain('withoutHostedAccountSettings(group.items, accountSettingsEnabled)');
    expect(mobile).toContain(
      'accountSettingsEnabled ? <AccountPanel registerRef={REGISTER_NOOP} /> : null',
    );
    expect(mobile).toContain(
      'accountSettingsEnabled ? <SubscriptionPanel registerRef={REGISTER_NOOP} /> : null',
    );
  });

  it('does not mount hosted telemetry controls in local-only Privacy settings', () => {
    const controls = read(
      'src/renderer/features/settings/panels/ControlSettingsPanels.tsx',
    );
    const privacyStart = controls.indexOf('export function PrivacyPanel');
    const aboutStart = controls.indexOf('export function AboutPanel');
    const privacyPanel = controls.slice(privacyStart, aboutStart);

    expect(privacyPanel).toContain('const hostedSettings = hostedAccountSettingsEnabled()');
    expect(privacyPanel).toContain('{hostedSettings && (');
    expect(privacyPanel).toContain("t('settings.privacy.improveModels')");
    expect(privacyPanel).toContain("t('settings.privacy.usageStats')");
    expect(privacyPanel).toContain("t('settings.privacy.crashLogs')");
  });

  it('does not mount the project-scoped import action in standalone mobile settings', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const desktop = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const mobile = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');

    expect(panel).toContain('projectImportEnabled && (');
    expect(desktop).toContain('projectImportEnabled');
    expect(mobile).toContain('projectImportEnabled={false}');
  });

  it('records a local-first onboarding contract without trial or hosted-storage claims', () => {
    const onboarding = read('src/renderer/components/modals/PreAlphaOnboardingDialog.tsx');
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      preAlphaGuide: Record<string, string>;
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as {
      preAlphaGuide: Record<string, string>;
    };
    expect(onboarding).toContain("const GUIDE_VERSION = 'v4'");
    expect(onboarding).toContain("t('preAlphaGuide.localData')");
    expect(onboarding).not.toContain("t('preAlphaGuide.backup')");
    expect(en.preAlphaGuide).not.toHaveProperty('backup');
    expect(zh.preAlphaGuide).not.toHaveProperty('backup');
    expect(onboarding).not.toContain("t('preAlphaGuide.trial')");
    expect(en.preAlphaGuide).not.toHaveProperty('trial');
    expect(zh.preAlphaGuide).not.toHaveProperty('trial');
    expect(en.preAlphaGuide.localData).toContain('No Drifting account is required');
    expect(zh.preAlphaGuide.localData).toContain('无需 Drifting 账号');
  });

  it('does not promise active cloud sync in always-visible local preferences', () => {
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      settings: {
        editor: Record<string, string>;
        keys: { actions: { saveCurrentEditor: { desc: string } } };
      };
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as typeof en;

    expect(en.settings.editor.caret_color_desc).toContain('saved locally');
    expect(en.settings.editor.entity_link_style_desc).toContain('saved locally');
    expect(en.settings.keys.actions.saveCurrentEditor.desc).toContain('local storage');
    expect(zh.settings.editor.caret_color_desc).toContain('保存在本机');
    expect(zh.settings.editor.entity_link_style_desc).toContain('保存在本机');
    expect(zh.settings.keys.actions.saveCurrentEditor.desc).toContain('本地存储');
  });

  it('removes account, plan and sign-out presentation from the local user menu', () => {
    const menu = read('src/renderer/components/topBars/UserMenu.tsx');
    const shelf = read('src/renderer/shells/mobile/standalone/MobileProjectShelfContent.tsx');
    const projectPicker = read('src/renderer/views/ProjectPickerView.tsx');
    const workspace = read('src/renderer/shells/mobile/workspace/MobileWorkspacePanels.tsx');
    expect(menu).toContain("t('userMenu.localStatus')");
    expect(menu).toContain("scope === 'shelf' && accountSettingsEnabled &&");
    expect(menu).toContain("'userMenu.accountMenu' : 'userMenu.localMenu'");
    expect(shelf).toContain("'userMenu.accountMenu' : 'userMenu.localMenu'");
    expect(shelf).toContain('accountSettingsEnabled && user?.email');
    expect(projectPicker).toContain("'userMenu.accountMenu' : 'userMenu.localMenu'");
    expect(projectPicker).toContain('hostedAccountSettingsEnabled() && user?.email');
    expect(workspace).not.toContain('<UserAvatar');
    expect(workspace).not.toContain('hostedAccountSettingsEnabled');
  });

  it('omits inert help, update and Finder actions instead of rendering dead controls', () => {
    const menu = read('src/renderer/components/topBars/UserMenu.tsx');
    const controls = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      userMenu: Record<string, string>;
      settings: { sync: Record<string, string>; about: Record<string, string> };
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as typeof en;

    expect(menu).not.toContain('helpFeedback');
    expect(controls).not.toContain('settings.sync.show_in_finder');
    expect(controls).not.toContain('settings.about.checkUpdates');
    expect(en.userMenu).not.toHaveProperty('helpFeedback');
    expect(zh.userMenu).not.toHaveProperty('helpFeedback');
    expect(en.settings.sync).not.toHaveProperty('show_in_finder');
    expect(zh.settings.sync).not.toHaveProperty('show_in_finder');
    expect(en.settings.about).not.toHaveProperty('checkUpdates');
    expect(zh.settings.about).not.toHaveProperty('checkUpdates');
  });

  it('keeps the public production CSP free of an implicit hosted-service origin', () => {
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      app: { security: { csp: string; devCsp: string } };
    };

    expect(tauri.app.security.csp).not.toContain('api.drifting.cc');
    expect(tauri.app.security.csp).toContain('https://api.deepseek.com');
    expect(tauri.app.security.csp).toContain('https://api.anthropic.com');
    expect(tauri.app.security.csp).toContain('https://api.openai.com');
    expect(tauri.app.security.csp).toContain("img-src 'self' asset: http://asset.localhost blob: data: https:");
    expect(tauri.app.security.devCsp).toContain('https://api.drifting.cc');
  });

  it('keeps the durable hosted-service document aligned with the UI contract', () => {
    const contract = read('docs/official-service.md');
    expect(contract).toContain('Settings omit the Account and');
    expect(contract).toContain('hosted telemetry controls');
    expect(contract).toMatch(/Trash and the separate\s+30-day entity history are local SQLite/);
    expect(contract).toContain('Trash items remain local until');
    expect(contract).toContain('project-scoped mobile workspace owns its Trash');
    expect(contract).toContain("Better Auth's own custom fetch transport");
    expect(contract).toContain('`external-content`, or `agent-extension`');
    expect(contract).toContain('explicit per-server configuration and durable');
    expect(contract).toContain('public production CSP intentionally contains no Drifting hosted origin');
  });
});
