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
    expect(composition).toContain(
      "events.emit('sync:project-changed', { projectId, projectionImpact })",
    );
  });

  it('keeps pure remote prose live while structural changes use one project-scoped projection', () => {
    const projectRuntime = source('./ProjectRuntimeProvider.tsx');
    expect(projectRuntime).toContain("events.on('sync:project-changed', scheduleRefresh)");
    const proseBranch = projectRuntime.indexOf(
      "if (event.projectionImpact === 'prose-only')",
    );
    const metricReconciliation = projectRuntime.indexOf(
      'scheduleMetricReconciliation();',
      proseBranch,
    );
    const structuralRefresh = projectRuntime.indexOf(
      "requestWorkspaceProjection(projectId, 'refreshing')",
      proseBranch,
    );
    expect(proseBranch).toBeGreaterThan(0);
    expect(metricReconciliation).toBeGreaterThan(proseBranch);
    expect(structuralRefresh).toBeGreaterThan(metricReconciliation);
    expect(projectRuntime).toContain('await flushPendingAtomicSyncTransactions()');
    expect(projectRuntime).toContain('await captureWorkspaceProjection({ projectId, userId })');
    expect(projectRuntime).toContain("requestWorkspaceProjection(projectId, 'refreshing')");
    expect(projectRuntime).toContain('commitWorkspaceProjection(projectId, epoch, capture.data)');
    expect(projectRuntime).not.toContain('nodeUsecases.loadNodes()');
    expect(projectRuntime).toContain('clearWorkspaceProjection(projectId, epoch)');
    expect(projectRuntime).toContain('<Navigate to="/" replace />');
    expect(projectRuntime).not.toContain('useNavigate');

    const restore = source('../../sync/restore/google-drive-restore.ts');
    expect(restore).toContain("projectionImpact: 'workspace'");

    const metrics = source('../../services/node-prose-metrics.service.ts');
    expect(metrics).not.toContain('updateBookNode(input.nodeId, result.node)');
    expect(metrics).toContain('wordCountBasisRevision: result.node.wordCountBasisRevision');

    const projection = source('../../services/workspace-projection.service.ts');
    expect(projection).toContain('return getDb().transaction(async (tx) =>');
    expect(projection).toContain('.where(eq(EntityRelationTable.projectId, input.projectId))');

    const picker = source('../../views/ProjectPickerView.tsx');
    expect(picker).toContain("events.on('sync:project-changed', refresh)");
    expect(picker).toContain('void fetchProjects()');
  });

  it('binds sync progress to top-right notifications and restored-tab cleanup to project identity', () => {
    const status = source('../../sync/engine/status-store.ts');
    expect(status).toContain('readonly projectId?: string | null');

    const projectRuntime = source('./ProjectRuntimeProvider.tsx');
    expect(projectRuntime).not.toContain('app-project-sync-pill');
    expect(projectRuntime).toContain('className="app-workspace-blocking-status"');

    const footer = source('../../components/BottomStatusBar.tsx');
    expect(footer).not.toContain('useProductSyncRuntime');
    expect(footer).not.toContain('bsb__storage');

    const notificationFeed = source('../../hooks/useNotificationFeed.ts');
    expect(notificationFeed).toContain('productSyncRuntimeControl.subscribe(inspect)');
    expect(notificationFeed).toContain("source: 'google-drive'");
    expect(notificationFeed).toContain('generation.transferProgress');

    const notification = source('../../components/notifications/NotificationPill.tsx');
    expect(notification).toContain('n.progress.value * 100');
    expect(notification).toContain('role="progressbar"');

    const zh = source('../../locales/zh-CN.json');
    expect(zh).toContain('"syncingProject": "正在更新项目结构…"');
    expect(zh).toContain('完成前，这个项目暂时无法编辑。');
    expect(zh).toContain('"downloading": "正在从 Google Drive 拉取…"');
    expect(zh).toContain('"uploadingChanges": "正在向 Google Drive 推送更改…"');

    const en = source('../../locales/en.json');
    expect(en).toContain('"syncingProject": "Updating project structure…"');
    expect(en).toContain('This project cannot be edited until the update finishes.');

    const desktopShellCss = source('../../../styles/desktop-shell.css');
    expect(desktopShellCss).not.toContain('.app-project-sync-pill');

    const commands = source('../../sync/product-commands.ts');
    expect(commands).toContain("events.emit('sync:projects-restored', { projectIds })");
    const appEffects = source('../effects/AppEffects.tsx');
    expect(appEffects).toContain('clearProjectTabs(projectId)');
  });
});
