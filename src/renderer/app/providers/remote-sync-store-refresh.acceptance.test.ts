import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('remote SyncEngine UI refresh boundary', () => {
  it('notifies product state only after the durable remote Yjs reconcile barrier', () => {
    const runtime = source('../../sync/engine/durable-runtime.ts');
    const reconcile = runtime.indexOf('await this.reconcileOpenYjsDocuments?.({', runtime.indexOf('const applied ='));
    const notify = runtime.indexOf('this.onRemoteChangeCommitted?.({', reconcile);
    expect(reconcile).toBeGreaterThan(0);
    expect(notify).toBeGreaterThan(reconcile);

    const composition = source('../../sync/production-runtime.ts');
    expect(composition).toContain("events.emit('sync:project-changed', { projectId })");
  });

  it('coalesces committed remote changes into one project-scoped SQLite projection', () => {
    const projectRuntime = source('./ProjectRuntimeProvider.tsx');
    expect(projectRuntime).toContain("events.on('sync:project-changed', scheduleRefresh)");
    expect(projectRuntime).toContain('await flushPendingAtomicSyncTransactions()');
    expect(projectRuntime).toContain('await captureWorkspaceProjection({ projectId, userId })');
    expect(projectRuntime).toContain("requestWorkspaceProjection(projectId, 'refreshing')");
    expect(projectRuntime).toContain('commitWorkspaceProjection(projectId, epoch, capture.data)');
    expect(projectRuntime).not.toContain('nodeUsecases.loadNodes()');
    expect(projectRuntime).toContain('clearWorkspaceProjection(projectId, epoch)');
    expect(projectRuntime).toContain('<Navigate to="/" replace />');
    expect(projectRuntime).not.toContain('useNavigate');

    const projection = source('../../services/workspace-projection.service.ts');
    expect(projection).toContain('return getDb().transaction(async (tx) =>');
    expect(projection).toContain('.where(eq(EntityRelationTable.projectId, input.projectId))');

    const picker = source('../../views/ProjectPickerView.tsx');
    expect(picker).toContain("events.on('sync:project-changed', refresh)");
    expect(picker).toContain('void fetchProjects()');
  });

  it('binds sync progress and restored-tab cleanup to project identity', () => {
    const status = source('../../sync/engine/status-store.ts');
    expect(status).toContain('readonly projectId?: string | null');

    const projectRuntime = source('./ProjectRuntimeProvider.tsx');
    expect(projectRuntime).not.toContain('app-project-sync-pill');
    expect(projectRuntime).toContain('className="app-workspace-blocking-status"');

    const footer = source('../../components/BottomStatusBar.tsx');
    expect(footer).toContain('generation.projectId === projectId');
    expect(footer).toContain("phase === 'pulling'");
    expect(footer).toContain("phase === 'ingesting' || phase === 'applying'");
    expect(footer).toContain('role="status"');
    expect(footer).toContain('aria-live="polite"');

    const zh = source('../../locales/zh-CN.json');
    expect(zh).toContain('"checking": "正在检查 Google Drive 更新"');
    expect(zh).toContain('"applying": "正在应用 Google Drive 更改"');

    const desktopShellCss = source('../../../styles/desktop-shell.css');
    expect(desktopShellCss).not.toContain('.app-project-sync-pill');

    const commands = source('../../sync/product-commands.ts');
    expect(commands).toContain("events.emit('sync:projects-restored', { projectIds })");
    const appEffects = source('../effects/AppEffects.tsx');
    expect(appEffects).toContain('clearProjectTabs(projectId)');
  });
});
