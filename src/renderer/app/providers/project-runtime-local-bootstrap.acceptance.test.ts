import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('local project bootstrap and lifecycle architecture', () => {
  it('hydrates the workspace from one local SQLite projection transaction', () => {
    const provider = source('./ProjectRuntimeProvider.tsx');

    expect(provider).not.toContain("from '../../services/entity-sync.service'");
    expect(provider).not.toContain('pullAndHydrateProjectGraph');
    expect(provider).not.toContain('startPreferencesSync');
    expect(provider).toContain('captureWorkspaceProjection({ projectId, userId })');
    expect(provider).toContain('commitWorkspaceProjection(projectId, epoch, capture.data)');
    expect(provider).toContain('clearWorkspaceProjection(projectId, epoch)');
    expect(provider).toContain('<Navigate to="/" replace />');
    expect(provider).not.toContain('useNavigate');
    expect(provider).not.toContain('nodeUsecases.loadNodes()');
    expect(provider).toContain('return retainProjectReferenceIndex(projectId)');
    expect(provider).not.toContain('rebuildProjectInlineReferenceIndex');
    const editor = source('../../hooks/useEntityEditor.ts');
    expect(editor).not.toContain('createInlineMentionRepository');
    expect(editor).not.toContain('projectInlineMentionsFromDoc');
    expect(source('../../components/editor/PatchEditorCard.tsx')).not.toContain('createInlineMentionRepository');

    const projection = source('../../services/workspace-projection.service.ts');
    expect(projection).toContain('return database.transaction(async (tx) =>');
    expect(projection).toContain('createBookNodeSqliteRepository(input.projectId, tx)');
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
