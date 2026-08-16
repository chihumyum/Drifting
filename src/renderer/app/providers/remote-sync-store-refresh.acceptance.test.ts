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

  it('coalesces committed remote changes into local SQLite-backed workspace and shelf reloads', () => {
    const projectRuntime = source('./ProjectRuntimeProvider.tsx');
    expect(projectRuntime).toContain("events.on('sync:project-changed', scheduleRefresh)");
    expect(projectRuntime).toContain('await flushPendingAtomicSyncTransactions()');
    expect(projectRuntime).toContain('await projectUsecases.loadProject(projectId)');
    expect(projectRuntime).toContain("navigate('/', { replace: true })");

    const picker = source('../../views/ProjectPickerView.tsx');
    expect(picker).toContain("events.on('sync:project-changed', refresh)");
    expect(picker).toContain('void fetchProjects()');
  });
});
