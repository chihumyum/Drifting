import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Bytes } from '../../protocol';
import { MemoryProviderLocalObjectStore } from '../local-object-store';
import { NodeLocalFolderTestTransport, type LocalFolderDurabilityBoundary } from './node-test-transport';
import { LocalFolderObjectLogProvider } from './provider';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })),
  );
});

async function runKilledWriter(boundary: LocalFolderDurabilityBoundary): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), `drifting-local-folder-${boundary}-`));
  temporaryRoots.push(rootPath);
  const vitest = path.resolve(process.cwd(), 'node_modules/.bin/vitest');
  const worker = path.resolve(
    process.cwd(),
    'src/renderer/sync/providers/local-folder/sigkill-worker.test.ts',
  );
  const child = spawn(vitest, ['run', worker, '--reporter=dot'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DRIFTING_LOCAL_FOLDER_SIGKILL_ROOT: rootPath,
      DRIFTING_LOCAL_FOLDER_SIGKILL_BOUNDARY: boundary,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${boundary}; stdout=${stdout}; stderr=${stderr}`));
    }, 15_000);
    const inspect = () => {
      if (!stdout.includes(`BOUNDARY:${boundary}`)) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code, signal) => {
      if (stdout.includes(`BOUNDARY:${boundary}`)) return;
      clearTimeout(timeout);
      reject(
        new Error(
          `Writer exited before ${boundary} (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        ),
      );
    });
  });
  const exit = once(child, 'exit');
  if (!child.kill('SIGKILL')) throw new Error(`Failed to SIGKILL local-folder writer ${child.pid}`);
  const [code, signal] = (await exit) as [number | null, NodeJS.Signals | null];
  expect(code).toBeNull();
  expect(signal).toBe('SIGKILL');
  return rootPath;
}

async function reopenInventory(rootPath: string) {
  const localObjects = new MemoryProviderLocalObjectStore();
  const transport = new NodeLocalFolderTestTransport(rootPath, localObjects);
  const provider = new LocalFolderObjectLogProvider(transport);
  const generation = await provider.openGeneration({
    bindingId: 'binding-reopen',
    syncGenerationId: 'sync-generation-a',
    accountRef: null,
    secretRef: 'local-folder-root:test',
    authorityGeneration: 1,
  });
  return { localObjects, provider, generation };
}

describe.skipIf(process.platform === 'win32')('LocalFolder SIGKILL durability', () => {
  it('never exposes a fully fsynced staging event killed before atomic rename', async () => {
    const rootPath = await runKilledWriter('stage-durable');
    const { provider, generation } = await reopenInventory(rootPath);
    await expect(provider.listInventory({ generation })).resolves.toEqual({ objects: [] });
    await expect(provider.captureStartCursor(generation)).resolves.toBe('local-folder-cursor:0');
  });

  it.each(['commit-renamed', 'commit-directory-durable'] as const)(
    'reopens a complete verified object after SIGKILL at %s',
    async (boundary) => {
      const rootPath = await runKilledWriter(boundary);
      const { localObjects, provider, generation } = await reopenInventory(rootPath);
      const inventory = await provider.listInventory({ generation });
      expect(inventory.objects).toHaveLength(1);
      const object = inventory.objects[0]!;
      expect(object.logicalKeyId).toBe('segment-sigkill');
      const destinationRef = localObjects.ref(`reopen-${boundary}`);
      await provider.downloadImmutable({
        generation,
        objectId: object.objectId,
        destinationRef,
        expectedStoredSha256: object.storedSha256,
        transferId: `reopen-${boundary}`,
        signal: new AbortController().signal,
      });
      expect(new TextDecoder().decode(localObjects.bytes(destinationRef)!)).toBe('sigkill-object');
      const bytes = new TextEncoder().encode('sigkill-object');
      await expect(
        provider.uploadImmutable({
          generation,
          sourceRef: localObjects.put(`retry-${boundary}`, bytes),
          objectKind: 'segment',
          logicalKeyId: 'segment-sigkill',
          storedSha256: await sha256Bytes(bytes),
          sizeBytes: bytes.byteLength,
          transferId: `retry-${boundary}`,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ status: 'already-present' });
      await expect(provider.captureStartCursor(generation)).resolves.toBe('local-folder-cursor:1');
    },
  );
});
