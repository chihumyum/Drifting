import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('local project bootstrap and lifecycle architecture', () => {
  it('hydrates the workspace only from local SQLite use cases', () => {
    const provider = source('./ProjectRuntimeProvider.tsx');

    expect(provider).not.toContain("from '../../services/entity-sync.service'");
    expect(provider).not.toContain('pullAndHydrateProjectGraph');
    expect(provider).not.toContain('startPreferencesSync');
    for (const localLoad of [
      'projectUsecases.loadProject(projectId)',
      'nodeUsecases.loadNodes()',
      'storylineUsecases.loadStorylines()',
      'elementUsecases.loadInitial()',
      'categoryUsecases.loadCategories()',
      'projectAssetUsecases.loadInitial()',
      'libraryItemUsecases.loadInitial()',
      'relationUsecases.loadInitial()',
      'commentUsecases.loadInitial()',
    ]) {
      expect(provider).toContain(localLoad);
    }
  });

  it('keeps project startup independent from child editor routes', () => {
    const provider = source('./ProjectRuntimeProvider.tsx');

    expect(provider).not.toContain('useNavigate');
    expect(provider).toContain("status: 'missing'");
    expect(provider).toContain('<Navigate to="/" replace />');
  });

  it('keeps lifecycle durability local and exposes only the new SyncEngine hook', () => {
    const lifecycle = source('../../lib/persistence-lifecycle.ts');

    expect(lifecycle).toContain('flushPendingAtomicSyncTransactions');
    expect(lifecycle).toContain('flushAllOpenYjsDocuments');
    expect(lifecycle).toContain('flushPendingAssetPersistence');
    expect(lifecycle).toContain('installSyncEngineLifecycleHook');
    expect(lifecycle).not.toMatch(
      /entity-sync\.service|flushPendingEntityPersistence|forceFlushEntitySync|forceSyncAllDocuments|flushPreferencesSync/u,
    );
  });

  it('records the retirement boundary in durable documentation', () => {
    const evidence = source('../../../../docs/sync-engine/phase1-local-runtime-boundary.md');

    expect(evidence).toContain('ProjectRuntimeProvider');
    expect(evidence).toContain('installSyncEngineLifecycleHook');
    expect(evidence).toContain('deletes the retired `entity-sync.service.ts`');
  });
});
