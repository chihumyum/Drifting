import { beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  writeBytes: vi.fn(),
  copyFile: vi.fn(),
  deleteAsset: vi.fn(),
  getPath: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: {
    assetStore: mocks,
  },
}));

import { assetStoreService, flushPendingAssetPersistence } from './asset-store.service';

const STORED = {
  ok: true as const,
  filePath: '/asset/source.bin',
  fileUrl: 'asset://source.bin',
  sizeBytes: 4,
};

describe('local asset durability barrier', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('waits for an active native asset write', async () => {
    const write = deferred<typeof STORED>();
    mocks.writeBytes.mockReturnValue(write.promise);
    const persisted = assetStoreService.writeBytes(
      'project-1',
      'asset-1',
      'source',
      'bin',
      new Uint8Array([1, 2, 3, 4]),
    );
    let flushed = false;
    const flush = flushPendingAssetPersistence().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);
    write.resolve(STORED);

    await expect(persisted).resolves.toEqual({
      filePath: STORED.filePath,
      fileUrl: STORED.fileUrl,
      sizeBytes: STORED.sizeBytes,
    });
    await expect(flush).resolves.toBeUndefined();
    expect(flushed).toBe(true);
  });

  it('also drains an operation started while a flush is in progress', async () => {
    const first = deferred<typeof STORED>();
    const second = deferred<{ ok: true }>();
    mocks.copyFile.mockReturnValue(first.promise);
    mocks.deleteAsset.mockReturnValue(second.promise);

    const copy = assetStoreService.copyFile(
      'project-1',
      'asset-1',
      'source',
      'bin',
      '/picked/source.bin',
    );
    const flush = flushPendingAssetPersistence();
    const deletion = assetStoreService.deleteAsset('project-1', 'asset-2');

    first.resolve(STORED);
    await copy;
    let flushed = false;
    void flush.then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    second.resolve({ ok: true });
    await deletion;
    await expect(flush).resolves.toBeUndefined();
  });

  it('surfaces a mutation that fails while the barrier is draining', async () => {
    const deletion = deferred<{ ok: true }>();
    mocks.deleteAsset.mockReturnValue(deletion.promise);
    const operation = assetStoreService.deleteAsset('project-1', 'asset-1');
    const flush = flushPendingAssetPersistence();

    deletion.reject(new Error('native delete failed'));

    await expect(operation).rejects.toThrow('native delete failed');
    await expect(flush).rejects.toThrow('1 local asset persistence operation(s) failed');
  });
});
