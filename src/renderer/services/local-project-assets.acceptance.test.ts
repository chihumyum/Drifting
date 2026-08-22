import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function pathExists(path: string): boolean {
  return existsSync(new URL(path, import.meta.url));
}

describe('clean local project asset architecture', () => {
  it('has one kind-discriminated LibraryItem model and minimal ProjectAsset metadata', () => {
    const library = source('../domain/library-item.ts');
    const asset = source('../domain/project-asset.ts');
    const schema = source('../schema/drizzle.ts');

    for (const text of [library, schema]) {
      expect(text).not.toMatch(/\blocalPath\b|\bthumbnailUri\b|LibraryItemSource/u);
    }
    expect(library).toContain("kind: 'image' | 'pdf'");
    expect(library).toContain('assetId: string');
    expect(library).toContain("kind: 'url'");
    expect(library).toContain('externalUrl: string');
    expect(library).toContain("kind: 'text'");

    for (const retiredField of [
      'ownerKind',
      'ownerId',
      'status',
      'sourceObjectKey',
      'displayObjectKey',
      'thumbnailObjectKey',
      'completedAt',
      'deletedAt',
      'updatedAt',
    ]) {
      expect(asset).not.toContain(retiredField);
    }
    expect(asset).toContain('sourceSha256: string');
    expect(asset).toContain('sourceSizeBytes: number');
  });

  it('removes the retired hosted upload runtime instead of preserving dormant compatibility', () => {
    for (const retiredPath of [
      '../domain/asset-upload-job.ts',
      '../sqlite-repo/asset-upload-job-repo.ts',
      './durable-asset-upload.service.ts',
      './project-asset.service.ts',
      './asset-cache.service.ts',
      './library-item-sync-boundary.ts',
    ]) {
      expect(pathExists(retiredPath)).toBe(false);
    }

    const store = source('./asset-store.service.ts');
    expect(store).toContain('platform.assetStore');
    expect(store).not.toMatch(/apiClient|signed|upload|download|providerObjectKey/u);
  });

  it('settles sibling file writes before failed-import cleanup', () => {
    const importer = source('./local-project-asset.service.ts');
    const writes = importer.indexOf('Promise.allSettled');
    const failed = importer.indexOf('if (failedWrite) throw failedWrite.reason', writes);
    const cleanup = importer.lastIndexOf('assetStoreService.deleteAsset');

    expect(writes).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(writes);
    expect(cleanup).toBeGreaterThan(failed);
    expect(importer).not.toContain('Promise.all([' + '\n' + '        assetStoreService');
  });

  it('keeps asset metadata and owner binding in the same SQLite transaction', () => {
    const libraryUsecase = source('../usecase/useLibraryItem.ts');
    const elementUsecase = source('../usecase/useBookElement.ts');

    expect(libraryUsecase).toContain('createProjectAssetSqliteRepository(projectId, tx).create');
    expect(libraryUsecase).toContain('createLibraryItemSqliteRepository(projectId, tx).create');
    expect(libraryUsecase).toContain('appendProjectAssetBindMutation');
    expect(libraryUsecase).toContain('withAtomicSyncTransaction');
    expect(elementUsecase).toContain('createProjectAssetSqliteRepository(activeProjectId, tx).create');
    expect(elementUsecase).toContain('portraitAssetId: asset.id');
    expect(elementUsecase).toContain('appendProjectAssetBindMutation');
    expect(elementUsecase).toContain('appendProjectAssetUnbindMutation');
  });

  it('verifies the native blob before authored asset.bind validation', () => {
    const importer = source('./local-project-asset.service.ts');
    const verifiedBlob = source('../sync/assets/local-authored-blob.ts');

    expect(importer).toContain('ensureLocalAuthoredAssetBlobVerified(asset)');
    expect(verifiedBlob).toContain("localState: 'verified'");
    expect(verifiedBlob).toContain('nativeSyncAssetBlobPort');
    expect(verifiedBlob).toContain('findActiveSyncGenerationInTransaction');
    expect(verifiedBlob).not.toMatch(/filePath|absolutePath|credentialSecretRef/u);
  });

  it('shows explicit picker/import progress and inline failures', () => {
    const dialog = source('../features/library/LibraryDialogs.tsx');

    expect(dialog).toContain('memoMaterial.dialog.importingImage');
    expect(dialog).toContain('memoMaterial.dialog.importingPdf');
    expect(dialog).toContain('material-import-feedback');
    expect(dialog).toContain('role="status"');
    expect(dialog).toContain('role="alert"');
    expect(dialog).not.toContain('alert(');
  });

  it('uses derived bytes for image rendering and canonical source bytes for fidelity hand-offs', () => {
    const preview = source('../features/library/LibraryItemPreview.tsx');
    const libraryPanel = source('../features/library/LibraryPanel.tsx');
    const desktopLibrary = source('../shells/desktop/views/DesktopSuperMemoMaterialView.tsx');

    expect(preview).toMatch(
      /const assetImageSource = useStoredLibraryItemVariant\(\s*material,\s*'display'/u,
    );
    expect(preview).toMatch(
      /const assetPdfSource = useStoredLibraryItemVariant\(\s*material,\s*'source'/u,
    );
    expect(libraryPanel).toContain(
      "assetStoreService.requireVariant(projectId, asset, 'source')",
    );
    expect(desktopLibrary).toContain(
      "assetStoreService.requireVariant(projectId, asset, 'source')",
    );
  });

  it('deletes a library owner and its relation rows through one transaction boundary', () => {
    const libraryUsecase = source('../usecase/useLibraryItem.ts');
    const deletion = source('../usecase/library-item-deletion.ts');

    expect(libraryUsecase).toContain(
      'deleteLibraryItemInTransaction(tx, sync, changes, projectId, existing)',
    );
    expect(libraryUsecase).toContain('setEntityRelations(remainingRelations)');
    expect(deletion).toContain('deleteEntityRelationsInTransaction');
    expect(deletion).toContain('appendProjectAssetUnbindMutation');
    expect(deletion).toContain('createLibraryItemSqliteRepository(projectId, tx).delete');
    expect(deletion).toContain('createProjectAssetSqliteRepository(projectId, tx).delete');
  });

  it('removes app-owned source directories only after project deletion commits', () => {
    const projectUsecase = source('../usecase/useProject.ts');
    const deletionRepo = source('../sqlite-repo/project-deletion-repo.ts');
    const transaction = projectUsecase.indexOf('const deletion = await runAuthoredTransaction');
    const capture = deletionRepo.indexOf('const assets = await tx');
    const purge = projectUsecase.indexOf('deleteProjectDataInTransaction(tx, id)', transaction);
    const committed = projectUsecase.indexOf('if (!deletion) return false', purge);
    const fileCleanup = projectUsecase.indexOf('assetStoreService.deleteAsset(id, assetId)');

    expect(transaction).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(-1);
    expect(purge).toBeGreaterThan(transaction);
    expect(committed).toBeGreaterThan(purge);
    expect(fileCleanup).toBeGreaterThan(committed);
  });

  it('records the frozen public Alpha compatibility rule as a durable agent policy', () => {
    const agents = source('../../../AGENTS.md');
    expect(agents).toContain('## Public Alpha compatibility policy');
    expect(agents).toContain('0.1.0-alpha.1');
    expect(agents).toContain('Published migrations are immutable');
    expect(agents).toContain('Development databases created before');
  });
});
