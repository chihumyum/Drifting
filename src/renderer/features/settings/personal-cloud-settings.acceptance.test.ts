import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('personal-cloud Settings boundary', () => {
  it('routes the trusted-cloud controls through the sanitized product command layer', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    expect(panel).toContain('productSyncCommands.connectGoogleDrive(signal)');
    expect(panel).toContain('productSyncCommands.triggerManualSync()');
    expect(panel).toContain('productSyncCommands.setPaused(');
    expect(panel).toContain('productSyncCommands.disconnectGoogleDrive(signal)');
    expect(panel).toContain('productSyncCommands.cancelPendingGoogleDrive(signal)');
    expect(panel).toContain('productSyncCommands.reauthorizeGoogleDrive()');
    expect(panel).not.toMatch(
      /credentialSecretRef|bearer|refreshToken|providerGenerationRef/,
    );
  });

  it('gates connection on the complete native OAuth, transport, and staging boundary', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const presentation = read(
      'src/renderer/features/settings/google-drive-settings-presentation.ts',
    );
    expect(panel).toContain('resolveGoogleDriveSettingsReadiness(capabilities)');
    expect(panel).toContain('disabled={!googleDriveReadiness.available || cloudBusy !== null}');
    expect(panel).toContain('data-state={googleDriveReadiness.available');
    expect(presentation).toContain('featureStatus.googleDriveOAuth');
    expect(presentation).toContain('featureStatus.googleDriveTransport');
    expect(presentation).toContain('featureStatus.syncObjectStore');
    expect(panel).toContain("authority.status === 'local'");
    expect(panel).not.toContain('recoveryConfirmationRequired');
    expect(panel).not.toContain('restoreRecoveryInputRequired');
  });

  it('localizes account, SDK-state, permission, network, and integrity failures', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const syncPanel = panel.slice(
      panel.indexOf('export function SyncPanel'),
      panel.indexOf('export function UpdatePanel'),
    );
    const presentation = read(
      'src/renderer/features/settings/google-drive-settings-presentation.ts',
    );
    expect(syncPanel).toContain('data-google-drive-issue={cloudIssue.id}');
    expect(syncPanel).toContain('resolveGoogleDriveSettingsIssue(error)');
    const cloudAction = syncPanel.slice(
      syncPanel.indexOf('const runCloudAction = async'),
      syncPanel.indexOf('const handleMarkdownExport = async'),
    );
    expect(cloudAction).not.toContain('error instanceof Error ? error.message');
    expect(cloudAction).not.toContain('String(error)');
    for (const code of [
      'account-mismatch',
      'needs-reauth',
      'permission-denied',
      'offline',
      'rate-limited',
      'quota-exceeded',
      'blocked-update',
      'remote-corrupt',
    ]) {
      expect(presentation).toContain(code);
    }
  });

  it('has no recovery-code, QR, biometric, or recovery-confirmation surface', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    expect(panel).not.toMatch(/recovery|qrPayload|QrDataUrl|Touch ?ID|biometric/iu);
    expect(panel).not.toContain('productSyncCommands.restoreGoogleDrive(');
    expect(panel).not.toContain('productSyncCommands.retryGoogleDriveRestore(');
    expect(panel).not.toContain('productSyncCommands.revealRecovery(');
    expect(panel).not.toContain('productSyncCommands.revealPendingConnectRecovery(');
    expect(panel).not.toContain('productSyncCommands.confirmPendingConnectRecoverySaved(');
  });

  it('requires an explicit second action before App-wide disconnect', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    expect(panel).toContain('disconnectArmed ?');
    expect(panel).toContain("t('settings.sync.confirm_disconnect')");
    expect(panel).toContain('setDisconnectArmed(true)');
    expect(panel).toContain('transitionCancelArmed ?');
    expect(panel).toContain("t('settings.sync.confirm_cancel_pending_cloud')");
    expect(panel).toContain('setTransitionCancelArmed(true)');
  });

  it('keeps connect and disconnect visibly busy instead of only disabling controls', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      settings: { sync: Record<string, unknown> };
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as typeof en;

    expect(panel).toContain('className="set-operation-feedback"');
    expect(panel).toContain('role="status"');
    expect(panel).toContain('aria-busy="true"');
    expect(panel).toContain("visibleCloudOperation === 'disconnect'");
    expect(panel).toContain('disconnect_confirm_desc');
    expect(JSON.stringify(en.settings.sync)).toContain('up to two minutes');
    expect(JSON.stringify(zh.settings.sync)).toContain('最长可能需要两分钟');
  });

  it('closes the same-frame double-tap window before native cloud operations start', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const cloudAction = panel.slice(
      panel.indexOf('const runCloudAction = async'),
      panel.indexOf('const handleMarkdownExport = async'),
    );
    expect(cloudAction).toContain('if (cloudBusy || operationRef.current) return');
    expect(cloudAction).toContain('operationRef.current = controller');
    expect(cloudAction.indexOf('if (cloudBusy || operationRef.current) return')).toBeLessThan(
      cloudAction.indexOf('operationRef.current = controller'),
    );
    expect(cloudAction).toContain('if (mountedRef.current && successKey)');
    expect(cloudAction).toContain('if (mountedRef.current && !controller.signal.aborted)');
    expect(panel).toContain('if (mountedRef.current) setCloudBusy(null)');
  });

  it('grants only the native dialog message/confirm permissions used by desktop UI', () => {
    const capability = JSON.parse(read('src-tauri/capabilities/desktop.json')) as {
      permissions: string[];
    };

    expect(capability.permissions).toContain('dialog:allow-message');
    expect(capability.permissions).toContain('dialog:allow-confirm');
    expect(capability.permissions).not.toContain('dialog:default');
  });

  it('uses Google sign-in for both connection and automatic project discovery', () => {
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      settings: { sync: Record<string, string> };
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as typeof en;
    expect(en.settings.sync.connect).toBe('Sign in with Google');
    expect(en.settings.sync.connect_google_drive_desc).toContain(
      'automatically discovers and restores projects',
    );
    expect(en.settings.sync.connect_google_drive_desc).toContain('only on this device');
    expect(en.settings.sync.connect_google_drive_desc).toContain('Google account');
    expect(zh.settings.sync.connect).toBe('登录 Google');
    expect(zh.settings.sync.connect_google_drive_desc).toContain('自动发现');
    expect(zh.settings.sync.connect_google_drive_desc).toContain('恢复');
    expect(zh.settings.sync.connect_google_drive_desc).toContain('只存在于本机');
    expect(zh.settings.sync.connect_google_drive_desc).toContain('Google 账号');
  });

  it('names projects publicly and states that Google is inside the trust boundary', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      settings: { sync: Record<string, string> };
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as typeof en;
    const syncCopy = JSON.stringify({ en: en.settings.sync, zh: zh.settings.sync });

    expect(en.settings.sync.cloud_sub).toContain('SQLite remains the working copy');
    expect(en.settings.sync.cloud_sub).toContain('part of the trust boundary');
    expect(en.settings.sync.cloud_sub).toContain('not end-to-end encryption against Google');
    expect(zh.settings.sync.cloud_sub).toContain('SQLite');
    expect(zh.settings.sync.cloud_sub).toContain('信任边界');
    expect(zh.settings.sync.cloud_sub).toContain('不是对 Google 端到端加密');
    expect(syncCopy).not.toContain('SyncGeneration');
    expect(syncCopy).not.toContain('syncGenerationId');
    expect(syncCopy).not.toMatch(/recovery code|恢复码|二维码/iu);
    expect(panel).not.toContain('hint="E2EE"');
  });

  it('separates durable authority attention from the last runtime cycle failure', () => {
    const panel = read('src/renderer/features/settings/panels/ControlSettingsPanels.tsx');
    const en = JSON.parse(read('src/renderer/locales/en.json')) as {
      settings: { sync: Record<string, string> };
    };
    const zh = JSON.parse(read('src/renderer/locales/zh-CN.json')) as typeof en;

    expect(panel).not.toContain('displayedErrorCode');
    expect(panel).toContain(
      'control={<span className="set-mono">{authorityIssue?.code ?? \'unexpected\'}</span>}',
    );
    expect(panel).toContain(
      "generation.lastOutcome === 'failed' && generation.lastErrorCode",
    );
    expect(panel).toContain("authority.status === 'cloud-ready'");
    expect(panel).toContain("runtimeFailure?.lastErrorCode === 'invalid-request'");
    expect(panel).toContain("runtimeFailure.lastFailedPhase === 'publishing-segments'");
    expect(panel).toContain("? 'settings.sync.last_sync_error'");
    expect(panel).toContain('runtimeFailure.lastFailedPhase');
    expect(zh.settings.sync.last_sync_error).toBe('上次同步错误');
    expect(zh.settings.sync.last_sync_error_publish_invalid_desc).toContain('内部发布请求失败');
    expect(zh.settings.sync.last_sync_error_publish_invalid_desc).toContain('本地内容安全');
    expect(en.settings.sync.last_sync_error_publish_invalid_desc).toContain(
      'internal publish request failed',
    );
    expect(en.settings.sync.last_sync_error_publish_invalid_desc).toContain(
      'Local content is safe',
    );
  });
});
