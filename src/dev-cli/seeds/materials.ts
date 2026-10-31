import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import type { DbClient } from '../../renderer/lib/db';
import type { ProjectAsset } from '../../renderer/domain/project-asset';
import { ensureLocalAuthoredAssetBlobVerified } from '../../renderer/sync/assets/local-authored-blob';
import { createLocalObjectRef, sha256Bytes } from '../../renderer/sync/protocol';
import type { SeedPreset } from '../../renderer/services/sample-project/presets';
import {
  commitSampleMaterials,
  planSampleMaterials,
  SAMPLE_ASSET_FIXTURES,
} from '../../renderer/services/sample-project/materials';
import { createAtomicRunner } from '../offline-workspace';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const assetDirectory = new URL('../../renderer/services/sample-project/assets/', import.meta.url);

/** Verify every checked-in byte before creating a project. No runtime codecs. */
export async function loadSeedAssets() {
  return Promise.all(SAMPLE_ASSET_FIXTURES.map(async (fixture) => {
    const source = await readFile(new URL(fixture.source, assetDirectory));
    if (source.length !== fixture.sizeBytes || sha256(source) !== fixture.sha256)
      throw new Error(`Development fixture integrity check failed: ${fixture.source}`);
    const variants = await Promise.all(Object.entries(fixture.variants).map(async ([variant, metadata]) => {
      const bytes = await readFile(new URL(metadata.file, assetDirectory));
      if (sha256(bytes) !== metadata.sha256) throw new Error(`Development fixture integrity check failed: ${metadata.file}`);
      return { variant, bytes };
    }));
    return { fixture, source, variants };
  }));
}

/** Exclusive writes: never replace a file owned by another import/profile. */
async function writeDurableFile(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Match native asset/sync-object layouts; only the isolated profile is passed in. */
async function importFixture(
  database: DbClient, appLocalDataDirectory: string, projectId: string,
  loaded: Awaited<ReturnType<typeof loadSeedAssets>>[number],
): Promise<{ asset: ProjectAsset; abandon: () => Promise<void> }> {
  const { fixture, source, variants } = loaded;
  const id = uuidv7();
  const directory = join(appLocalDataDirectory, 'assets', projectId, id);
  const sourceExt = fixture.kind === 'image' ? 'png' : 'pdf';
  const sourcePath = join(directory, `source.${sourceExt}`);
  let objectPath: string | null = null;
  const abandon = async () => {
    await rm(directory, { recursive: true, force: true });
    if (objectPath) await rm(objectPath, { force: true });
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeDurableFile(sourcePath, source);
    for (const { variant, bytes } of variants) await writeDurableFile(join(directory, `${variant}.jpg`), bytes);
    const asset: ProjectAsset = {
      id, projectId, kind: fixture.kind,
      sourceMime: fixture.kind === 'image' ? 'image/png' : 'application/pdf',
      sourceSizeBytes: source.length, sourceSha256: fixture.sha256,
      width: fixture.width, height: fixture.height, createdAt: new Date().toISOString(),
    };
    // Reuse the production verifier/receipt writer with an offline file port.
    // The receipt points to actual bytes readable by native sync after launch.
    await ensureLocalAuthoredAssetBlobVerified(asset, {
      database: () => database,
      nowIso: () => new Date().toISOString(),
      discardLocal: async () => { if (objectPath) await rm(objectPath, { force: true }); },
      blobPort: {
        async prepareOutbound({ syncGenerationId, declaration }) {
          const stored = await readFile(sourcePath);
          const hash = `sha256:${sha256(stored)}` as const;
          if (hash !== declaration.sourceSha256 || stored.length !== declaration.sourceSizeBytes)
            throw new Error('Seed source bytes changed during import');
          const token = uuidv7();
          const bucket = join(appLocalDataDirectory, 'sync-objects', token.slice(0, 2));
          await mkdir(bucket, { recursive: true, mode: 0o700 });
          objectPath = join(bucket, `${token}.object`);
          await writeDurableFile(objectPath, stored);
          return {
            sourceRef: createLocalObjectRef(`syncobj:${token}`),
            logicalKeyId: await sha256Bytes(new TextEncoder().encode(`blob/${syncGenerationId}/${hash}`)),
            storedSha256: hash, contentSha256: hash, sizeBytes: stored.length,
          };
        },
      },
    });
    return { asset, abandon };
  } catch (error) {
    await abandon();
    throw error;
  }
}

export async function seedMaterials(
  database: DbClient, projectId: string, appLocalDataDirectory: string,
  fixtures: Awaited<ReturnType<typeof loadSeedAssets>>, preset: SeedPreset,
): Promise<() => Promise<void>> {
  const plan = planSampleMaterials({ projectId, preset, now: new Date().toISOString(), newId: uuidv7 });
  const prepared: Awaited<ReturnType<typeof importFixture>>[] = [];
  let committed = false;
  try {
    for (let copy = 0; copy < preset.assetCopies; copy++) for (const fixture of fixtures) {
      const imported = await importFixture(database, appLocalDataDirectory, projectId, fixture);
      prepared.push(imported);
      plan.addAsset({ fixture: fixture.fixture, asset: imported.asset, copy });
    }
    await commitSampleMaterials(createAtomicRunner(database), projectId, plan, prepared.map(entry => entry.asset));
    committed = true;
    return async () => { for (const imported of prepared) await imported.abandon(); };
  } finally {
    if (!committed) for (const imported of prepared) await imported.abandon();
  }
}
