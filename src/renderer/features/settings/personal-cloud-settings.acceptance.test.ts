import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('Hosted-only App sync boundary', () => {
  it('offers account sync and local recovery in any build', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const account = read('src/renderer/features/settings/panels/AccountSettingsPanel.tsx');
    expect(panel).toContain("navigate('/settings?section=account')");
    expect(panel).toContain('exportAllProjectsAsRelationalMarkdown()');
    expect(panel).toContain('projectImportEnabled &&');
    expect(account).toContain('run(synchronizeHostedNow)');
  });

  it('installs only Hosted provisioning in the production runtime', () => {
    const effects = read('src/renderer/app/effects/AppEffects.tsx');
    const runtime = read('src/renderer/sync/production-runtime.ts');
    expect(effects).toContain('installHostedSyncGenerationProvisioningRuntime()');
    expect(runtime).toContain("createHostedProvider('agent-chat-v1')");
  });

  it('labels project and conversation sync as Hosted', () => {
    for (const language of ['en', 'zh-CN']) {
      const locale = JSON.parse(read(`src/renderer/locales/${language}.json`));
      expect(locale.notifications.cloudSync.source).toBeTruthy();
    }
    expect(read('src/renderer/hooks/useNotificationFeed.ts')).toContain("source: 'hosted-sync'");
  });
});
