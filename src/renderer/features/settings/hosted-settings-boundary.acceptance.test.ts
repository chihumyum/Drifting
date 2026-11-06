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
    expect(withoutHostedAccountSettings(items, true)).toEqual([{ id: 'account' }, { id: 'sync' }]);
  });

  it('gates both desktop and standalone-mobile account panels before mounting them', () => {
    const desktop = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const mobile = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');
    expect(desktop).toContain('withoutHostedAccountSettings(RAIL_BASE, accountSettingsEnabled)');
    expect(desktop).toContain('{accountSettingsEnabled && (');
    expect(mobile).toContain('withoutHostedAccountSettings(group.items, accountSettingsEnabled)');
    expect(read('src/renderer/features/settings/StandaloneSettingsPanel.tsx')).toContain(
      "if (id === 'account' && !hostedAccountSettingsEnabled()) return null",
    );
    expect(mobile).not.toContain('<SubscriptionPanel');
    expect(desktop).not.toContain('<SubscriptionPanel');
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
    expect(privacyPanel).toContain("hostedSettings ? 'settings.privacy.noteHosted' : 'settings.privacy.noteLocal'");
    expect(privacyPanel).toContain("t('settings.privacy.crashLogs')");
    // Only controls that do something: no placeholder toggles for features that do not exist.
    expect(privacyPanel).not.toContain('settings.privacy.improveModels');
    expect(privacyPanel).not.toContain('settings.privacy.usageStats');
    expect(privacyPanel).not.toContain('disabled />');
  });

  it('does not mount the project-scoped import action in standalone mobile settings', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const desktop = read('src/renderer/features/settings/desktop/DesktopSettingsModal.tsx');
    const mobile = read('src/renderer/shells/mobile/standalone/MobileSettingsView.tsx');

    expect(panel).toContain('projectImportEnabled && (');
    expect(desktop).toContain('projectImportEnabled');
    expect(mobile).toContain('<StandaloneSettingsPanel');
    expect(read('src/renderer/features/settings/StandaloneSettingsPanel.tsx')).toContain('projectImportEnabled={false}');
  });

  it('records a local-first onboarding contract without trial or hosted-storage claims', () => {
    // Both shells open through the same first run (the welcome card on the sea).
    const onboarding = read('src/renderer/components/modals/PreAlphaOnboardingDialog.tsx');
    const mobileShelf = read('src/renderer/shells/mobile/standalone/MobileProjectShelfView.tsx');
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      preAlphaGuide: Record<string, string>;
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as {
      preAlphaGuide: Record<string, string>;
    };
    // v6 discloses content-free crash reports, which default on in Hosted builds.
    expect(read('src/renderer/lib/alpha-guide-key.ts')).toContain("ALPHA_GUIDE_VERSION = 'v6'");
    expect(onboarding).toContain('alphaGuideStorageKey(userId)');
    expect(onboarding).toContain("<p className=\"first-run-welcome__note\">{t('preAlphaGuide.crashReports')}</p>");
    expect(onboarding).toContain("{t('firstRun.local')}");
    expect(mobileShelf).toContain('<PreAlphaFirstRunGate>');
    expect(onboarding).not.toContain('export function PreAlphaOnboardingDialog');
    expect(onboarding).not.toContain('openExternal');
    expect(onboarding).not.toContain('quick-start');
    expect(onboarding).not.toContain("t('preAlphaGuide.backup')");
    expect(en.preAlphaGuide).not.toHaveProperty('backup');
    expect(zh.preAlphaGuide).not.toHaveProperty('backup');
    expect(onboarding).not.toContain("t('preAlphaGuide.trial')");
    expect(en.preAlphaGuide).not.toHaveProperty('trial');
    expect(zh.preAlphaGuide).not.toHaveProperty('trial');
  });

  it('does not promise active cloud sync in always-visible local preferences', () => {
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      settings: {
        editor: Record<string, string>;
        keys: { actions: { saveCurrentEditor: { desc: string } } };
      };
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as typeof en;

    // These follow a Hosted account (docs/hosted-sync/preferences.md) but local
    // builds show them too, so their copy names neither sync nor device-only storage.
    for (const desc of [en.settings.editor.caret_color_desc, en.settings.editor.entity_link_style_desc]) {
      expect(desc).not.toMatch(/sync|this device/i);
    }
    for (const desc of [zh.settings.editor.caret_color_desc, zh.settings.editor.entity_link_style_desc]) {
      expect(desc).not.toMatch(/同步|本机|这台设备/);
    }
    expect(en.settings.keys.actions.saveCurrentEditor.desc).toContain('local storage');
    expect(zh.settings.keys.actions.saveCurrentEditor.desc).toContain('本地存储');
  });

  it('removes account, plan and sign-out presentation from the local user menu', () => {
    const menu = read('src/renderer/components/topBars/UserMenu.tsx');
    const projectPicker = read('src/renderer/views/ProjectPickerView.tsx');
    const shelfRail = read('src/renderer/views/shelf/ShelfRail.tsx');
    const workspace = read('src/renderer/shells/mobile/desk/MobileDeskPanels.tsx');
    expect(menu).toContain("t('userMenu.localStatus')");
    expect(menu).toContain("scope === 'shelf' && accountSettingsEnabled &&");
    // Inside a book a Hosted build not signed in offers sign-in; a local build never does.
    expect(menu).toContain("const projectSignInShown = scope === 'project' && accountSettingsEnabled && !canSignOut;");
    const projectSignIn = menu.slice(menu.indexOf('{projectSignInShown && ('));
    expect(projectSignIn.slice(0, projectSignIn.indexOf('</MenuGroup>')))
      .toMatch(/name="gate-in"[\s\S]*t\('settings\.hosted\.sign_in_sync'\)[\s\S]*openSignIn\(\)/);
    expect(menu).toContain("'userMenu.accountMenu' : 'userMenu.localMenu'");
    expect(shelfRail).toContain("'userMenu.accountMenu' : 'userMenu.localMenu'");
    // The desktop shelf has no footer: the email shows only in the account menu.
    expect(projectPicker).not.toContain('pp-foot');
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
    expect(contract).toContain('`byok-provider`, or `agent-extension`');
    expect(contract).toContain('explicit per-server configuration and durable');
    expect(contract).toContain('public production CSP intentionally contains no Drifting hosted origin');
  });
});
