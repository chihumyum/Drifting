import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import type { DbClient } from '../../renderer/lib/db';
import type { LibraryItem } from '../../renderer/domain/library-item';
import type { MaterialFolder } from '../../renderer/domain/material-folder';
import type { ProjectAsset } from '../../renderer/domain/project-asset';
import { createPlainCommentDoc } from '../../renderer/domain/comment';
import { createLibraryItemSqliteRepository } from '../../renderer/sqlite-repo/library-item-repo';
import { createMaterialFolderRepository } from '../../renderer/sqlite-repo/material-folder-repo';
import { createProjectAssetSqliteRepository } from '../../renderer/sqlite-repo/project-asset-repo';
import { ensureLocalAuthoredAssetBlobVerified } from '../../renderer/sync/assets/local-authored-blob';
import { appendPlannedAuthoredOrderInTransaction, appendProjectAssetBindMutation } from '../../renderer/sync/journal';
import { createLocalObjectRef, sha256Bytes } from '../../renderer/sync/protocol';
import { libraryMutationPayload } from '../../renderer/usecase/library-item-payload';
import { createAtomicRunner } from '../offline-workspace';
import { allocateSeedLengths, type SeedPreset } from './presets';
import { createSeedProse, seedProsePlainText } from './prose';
import manifest from './assets/manifest.json';

const folderNames = ['调研', '地图与潮汐', '人物访谈', '场景速写', '航海档案', '修订计划', '对白摘记', '时间线', '参考图', '参考文档', '已整理', '待核实'];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Verify every checked-in byte before creating a project. No runtime codecs. */
export async function loadSeedAssets() {
  return Promise.all(manifest.map(async (fixture) => {
    const source = await readFile(new URL(`./assets/${fixture.source}`, import.meta.url));
    if (source.length !== fixture.sizeBytes || sha256(source) !== fixture.sha256)
      throw new Error(`Development fixture integrity check failed: ${fixture.source}`);
    const variants = await Promise.all(Object.entries(fixture.variants).map(async ([variant, metadata]) => {
      const bytes = await readFile(new URL(`./assets/${metadata.file}`, import.meta.url));
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
      id, projectId, kind: fixture.kind as 'image' | 'pdf',
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
  const now = new Date().toISOString();
  const folders: MaterialFolder[] = [];
  for (const [i, name] of folderNames.slice(0, preset.name === 'lite' ? 6 : 12).entries()) folders.push({
    id: uuidv7(), projectId, name, parentFolderId: i === 1 || i === 2 ? folders[0].id : i === 10 ? folders[4].id : null,
    createdAt: now, updatedAt: now,
  });
  const noteLengths = allocateSeedLengths(preset.materialNotes, 108);
  const items: LibraryItem[] = noteLengths.map((length, i) => ({
    id: uuidv7(), projectId, title: `笔记${String(i + 1).padStart(2, '0')} · ${folderNames[i % folderNames.length]}`,
    kind: 'text', assetId: null, externalUrl: null, previewImageUrl: null,
    bodyJson: JSON.stringify(createSeedProse(length, 8_000 + i, true)), notesJson: null, provenanceJson: null, orderKey: i,
    folderId: i % 7 === 0 ? null : folders[i % folders.length].id, taskTodos: i % 4 !== 0,
    createdAt: now, updatedAt: now,
  }));
  const prepared: Awaited<ReturnType<typeof importFixture>>[] = [];
  let committed = false;
  try {
    for (let copy = 0; copy < preset.assetCopies; copy++) for (const fixture of fixtures) {
      const imported = await importFixture(database, appLocalDataDirectory, projectId, fixture);
      prepared.push(imported);
      items.push({
        id: uuidv7(), projectId, title: `${fixture.fixture.title}${copy ? ` / ${copy + 1}` : ''}`, kind: imported.asset.kind,
        assetId: imported.asset.id, externalUrl: null, previewImageUrl: null, bodyJson: null,
        notesJson: createPlainCommentDoc(seedProsePlainText(createSeedProse(preset.name === 'stress' ? 500 + copy * 100 : 100, 9_000 + items.length))),
        provenanceJson: null, orderKey: items.length, folderId: folders[preset.name === 'lite' ? (imported.asset.kind === 'image' ? 1 : 4) : (imported.asset.kind === 'image' ? 8 : 9)].id,
        taskTodos: false, createdAt: now, updatedAt: now,
      });
    }
    await createAtomicRunner(database)(projectId, async (tx, sync, changes) => {
      const folderRepo = createMaterialFolderRepository(projectId, tx);
      for (const folder of folders) {
        await folderRepo.create(folder);
        await sync('materialFolder', 'create', folder.id, projectId, {
          id: folder.id, name: folder.name, parentFolderId: folder.parentFolderId,
          createdAt: folder.createdAt, updatedAt: folder.updatedAt,
        });
      }
      const itemRepo = createLibraryItemSqliteRepository(projectId, tx);
      for (const item of items) {
        if (item.assetId) {
          const asset = prepared.find(entry => entry.asset.id === item.assetId)!.asset;
          await createProjectAssetSqliteRepository(projectId, tx).create(asset);
          appendProjectAssetBindMutation(changes, projectId, asset, { kind: 'library-item', id: item.id });
        }
        await itemRepo.create(item);
        await sync('libraryItem', 'create', item.id, projectId, libraryMutationPayload(item));
      }
      await appendPlannedAuthoredOrderInTransaction(tx, changes, {
        projectId, listKind: 'library-item', scope: projectId, desiredEntityIds: items.map(item => item.id),
      });
    });
    committed = true;
    return async () => { for (const imported of prepared) await imported.abandon(); };
  } finally {
    if (!committed) for (const imported of prepared) await imported.abandon();
  }
}
