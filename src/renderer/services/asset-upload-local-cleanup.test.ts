import { describe, expect, it, vi } from 'vitest';
import type { AssetUploadJob } from '../domain/asset-upload-job';
import {
  cleanupAssetUploadLocalFiles,
  type AssetUploadLocalCleanupDependencies,
} from './asset-upload-local-cleanup';

function job(
  stage: AssetUploadJob['stage'],
): Pick<AssetUploadJob, 'id' | 'projectId' | 'sourcePath' | 'stage'> {
  return {
    id: 'job-1',
    projectId: 'project-1',
    sourcePath: '/app/imports/source.png',
    stage,
  };
}

function dependencies(): AssetUploadLocalCleanupDependencies & {
  deleteCache: ReturnType<typeof vi.fn>;
  deleteImport: ReturnType<typeof vi.fn>;
} {
  return {
    deleteCache: vi.fn(async () => undefined),
    deleteImport: vi.fn(async () => ({ ok: true as const })),
  };
}

describe('asset upload local cleanup', () => {
  it('retains the canonical cache after a successful upload', async () => {
    const deps = dependencies();

    await cleanupAssetUploadLocalFiles(job('cleanup'), deps);

    expect(deps.deleteCache).not.toHaveBeenCalled();
    expect(deps.deleteImport).toHaveBeenCalledWith('/app/imports/source.png');
  });

  it('deletes both the cache and import after cancellation', async () => {
    const deps = dependencies();

    await cleanupAssetUploadLocalFiles(job('canceled'), deps);

    expect(deps.deleteCache).toHaveBeenCalledWith('project-1', 'job-1');
    expect(deps.deleteImport).toHaveBeenCalledWith('/app/imports/source.png');
  });

  it('surfaces import cleanup failures so the durable job can retry', async () => {
    const deps = dependencies();
    deps.deleteImport.mockResolvedValue({ ok: false as const, error: 'file busy' });

    await expect(cleanupAssetUploadLocalFiles(job('cleanup'), deps)).rejects.toThrow('file busy');
  });
});
