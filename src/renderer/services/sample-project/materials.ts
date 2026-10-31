// The sample project's material library: folders, rich-text notes and one
// library item per image/PDF fixture. Shared by the development seed (which
// copies fixture bytes with Node) and the built-in sample (which imports them
// through the native asset store); both commit through commitSampleMaterials.

import type { LibraryItem } from '../../domain/library-item';
import type { MaterialFolder } from '../../domain/material-folder';
import type { ProjectAsset } from '../../domain/project-asset';
import { createPlainCommentDoc } from '../../domain/comment';
import { createLibraryItemSqliteRepository } from '../../sqlite-repo/library-item-repo';
import { createMaterialFolderRepository } from '../../sqlite-repo/material-folder-repo';
import { createProjectAssetSqliteRepository } from '../../sqlite-repo/project-asset-repo';
import { appendPlannedAuthoredOrderInTransaction, appendProjectAssetBindMutation } from '../../sync/journal';
import type { BookNodeAtomicTransactionRunner } from '../../usecase/book-node-write';
import { libraryMutationPayload } from '../../usecase/library-item-payload';
import { allocateSeedLengths, type SeedPreset } from './presets';
import { createSeedProse, seedProsePlainText } from './prose';
import fixtureManifest from './assets/manifest.json';

export interface SampleAssetFixture {
  name: string;
  title: string;
  kind: 'image' | 'pdf';
  source: string;
  sha256: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  variants: Record<string, { file: string; sha256: string }>;
}

/** Repository-owned synthetic image/PDF fixtures (assets/README.md). */
export const SAMPLE_ASSET_FIXTURES = fixtureManifest as SampleAssetFixture[];

const folderNames = ['调研', '地图与潮汐', '人物访谈', '场景速写', '航海档案', '修订计划', '对白摘记', '时间线', '参考图', '参考文档', '已整理', '待核实'];

export interface SampleMaterialPlan {
  folders: MaterialFolder[];
  /** Text notes first; asset items are appended with addAsset. */
  items: LibraryItem[];
  addAsset(input: { fixture: SampleAssetFixture; asset: ProjectAsset; copy: number }): LibraryItem;
}

export function planSampleMaterials(input: {
  projectId: string;
  preset: SeedPreset;
  now: string;
  newId: () => string;
}): SampleMaterialPlan {
  const { projectId, preset, now, newId } = input;
  const folders: MaterialFolder[] = [];
  for (const [i, name] of folderNames.slice(0, preset.name === 'lite' ? 6 : 12).entries()) folders.push({
    id: newId(), projectId, name, parentFolderId: i === 1 || i === 2 ? folders[0].id : i === 10 ? folders[4].id : null,
    createdAt: now, updatedAt: now,
  });
  const noteLengths = allocateSeedLengths(preset.materialNotes, 108);
  const items: LibraryItem[] = noteLengths.map((length, i) => ({
    id: newId(), projectId, title: `笔记${String(i + 1).padStart(2, '0')} · ${folderNames[i % folderNames.length]}`,
    kind: 'text', assetId: null, externalUrl: null, previewImageUrl: null,
    bodyJson: JSON.stringify(createSeedProse(length, 8_000 + i, true)), notesJson: null, provenanceJson: null, orderKey: i,
    folderId: i % 7 === 0 ? null : folders[i % folders.length].id, taskTodos: i % 4 !== 0,
    createdAt: now, updatedAt: now,
  }));
  return {
    folders,
    items,
    addAsset({ fixture, asset, copy }) {
      const item: LibraryItem = {
        id: newId(), projectId, title: `${fixture.title}${copy ? ` / ${copy + 1}` : ''}`, kind: asset.kind as 'image' | 'pdf',
        assetId: asset.id, externalUrl: null, previewImageUrl: null, bodyJson: null,
        notesJson: createPlainCommentDoc(seedProsePlainText(createSeedProse(preset.name === 'stress' ? 500 + copy * 100 : 100, 9_000 + items.length))),
        provenanceJson: null, orderKey: items.length, folderId: folders[preset.name === 'lite' ? (asset.kind === 'image' ? 1 : 4) : (asset.kind === 'image' ? 8 : 9)].id,
        taskTodos: false, createdAt: now, updatedAt: now,
      };
      items.push(item);
      return item;
    },
  };
}

/** Folders, assets and items in one authored transaction, as the app writes them. */
export async function commitSampleMaterials(
  runAtomic: BookNodeAtomicTransactionRunner,
  projectId: string,
  plan: Pick<SampleMaterialPlan, 'folders' | 'items'>,
  assets: readonly ProjectAsset[],
): Promise<void> {
  await runAtomic(projectId, async (tx, sync, changes) => {
    const folderRepo = createMaterialFolderRepository(projectId, tx);
    for (const folder of plan.folders) {
      await folderRepo.create(folder);
      await sync('materialFolder', 'create', folder.id, projectId, {
        id: folder.id, name: folder.name, parentFolderId: folder.parentFolderId,
        createdAt: folder.createdAt, updatedAt: folder.updatedAt,
      });
    }
    const itemRepo = createLibraryItemSqliteRepository(projectId, tx);
    for (const item of plan.items) {
      if (item.assetId) {
        const asset = assets.find(entry => entry.id === item.assetId);
        if (!asset) throw new Error(`Sample material ${item.id} has no imported asset`);
        await createProjectAssetSqliteRepository(projectId, tx).create(asset);
        appendProjectAssetBindMutation(changes, projectId, asset, { kind: 'library-item', id: item.id });
      }
      await itemRepo.create(item);
      await sync('libraryItem', 'create', item.id, projectId, libraryMutationPayload(item));
    }
    await appendPlannedAuthoredOrderInTransaction(tx, changes, {
      projectId, listKind: 'library-item', scope: projectId, desiredEntityIds: plan.items.map(item => item.id),
    });
  });
}
