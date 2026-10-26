import { useCallback, useMemo } from 'react';
import loglevel from 'loglevel';

import type { LibraryItem } from '../domain/library-item';
import type { ProjectAsset } from '../domain/project-asset';
import {
  serializeMaterialProvenance,
  withArtStyle,
  type MaterialProvenance,
} from '../domain/material-provenance';
import { platform } from '../platform';
import type { ImageInboxEntry } from '../platform';
import { assetStoreService } from '../services/asset-store.service';
import { releasePickedMaterialImport } from '../services/local-project-asset.service';
import { useDataStore } from '../store/data-store';
import { useImageInboxStore } from '../store/image-inbox-store';
import { useProjectStore } from '../store/project-store';
import type { useBookElement } from './useBookElement';
import { useEntityRelations } from './useEntityRelations';
import { useLibraryItem } from './useLibraryItem';
import { useProject } from './useProject';

const log = loglevel.getLogger('generatedImages');
log.setLevel(loglevel.levels.WARN);

export interface GeneratedImageCommands {
  /** Keeps the candidate as a material associated with the element. */
  keepCandidate(candidate: ImageInboxEntry, elementId: string): Promise<void>;
  /** Keeps the candidate as a material and makes a copy the element's portrait. */
  setPortraitFromCandidate(candidate: ImageInboxEntry, elementId: string): Promise<void>;
  discardCandidate(candidate: ImageInboxEntry): Promise<void>;
  saveArtStyle(styleText: string): Promise<void>;
  /** Picker replacement: keeps the outgoing portrait as a material first. */
  replacePortraitFromLocalFile(elementId: string, sourcePath: string): Promise<void>;
}

function generatedProvenance(candidate: ImageInboxEntry, elementId: string): MaterialProvenance {
  const { provenance } = candidate;
  return {
    v: 1,
    origin: 'generated',
    generation: {
      provider: provenance.provider,
      model: provenance.model,
      prompt: provenance.prompt,
      subjectPrompt: provenance.subjectPrompt,
      styleText: provenance.styleText,
      extraPrompt: provenance.extraPrompt,
      target: { kind: 'element', id: elementId },
      generationId: provenance.generationId,
      conversationId: provenance.conversationId,
      sourceItemIds: [],
      generatedAt: new Date(candidate.createdAtMs).toISOString(),
    },
  };
}

/**
 * The portrait asset to copy into a material before replacement, or null when
 * there is none or a material already holds the same bytes.
 */
export function portraitToPreserve(
  state: Pick<ReturnType<typeof useDataStore.getState>, 'bookElements' | 'projectAssets' | 'libraryItems'>,
  elementId: string,
): ProjectAsset | null {
  const element = state.bookElements.find((candidate) => candidate.id === elementId);
  const asset = element?.portraitAssetId
    ? state.projectAssets.find((candidate) => candidate.id === element.portraitAssetId)
    : undefined;
  if (!asset) return null;
  const sha256ByAsset = new Map(state.projectAssets.map((entry) => [entry.id, entry.sourceSha256]));
  const alreadyKept = state.libraryItems.some(
    (item) => item.assetId !== null && sha256ByAsset.get(item.assetId) === asset.sourceSha256,
  );
  return alreadyKept ? null : asset;
}

function materialTitle(elementId: string, suffix: string): string {
  const name = useDataStore.getState().bookElements.find((element) => element.id === elementId)?.name;
  return name?.trim() ? `${name.trim()} · ${suffix}` : suffix;
}

/**
 * Commands behind the element page's generation candidates. Kept images go
 * through the ordinary material import, so their bytes follow the local asset
 * and sync boundaries; candidates themselves stay unsynced inbox files.
 */
export function useGeneratedImageCommands(input: {
  projectId: string;
  userId: string;
  elementUsecases: ReturnType<typeof useBookElement>;
}): GeneratedImageCommands {
  const { projectId, userId, elementUsecases } = input;
  const { updateProject } = useProject({ userId });
  const { createLibraryItem } = useLibraryItem({ projectId, userId });
  const { addGenericAssociation } = useEntityRelations({ projectId, userId });

  const associate = useCallback(
    async (item: LibraryItem, elementId: string) => {
      // The material is already committed; a failed association only loses
      // the "current entry" filter link, which the author can add by hand.
      await addGenericAssociation('library_item', item.id, 'element', elementId).catch((error) =>
        log.warn('Failed to associate the material with its element', item.id, error),
      );
    },
    [addGenericAssociation],
  );

  const keepAsMaterial = useCallback(
    async (candidate: ImageInboxEntry, elementId: string) => {
      const sourcePath = await platform.imageGeneration.stageImport(candidate.projectId, candidate.id);
      let item: LibraryItem;
      try {
        item = await createLibraryItem({
          kind: 'image',
          sourcePath,
          title: materialTitle(elementId, '设定图'),
          provenanceJson: serializeMaterialProvenance(generatedProvenance(candidate, elementId)),
        });
      } catch (error) {
        await releasePickedMaterialImport(sourcePath).catch(() => undefined);
        throw error;
      }
      await associate(item, elementId);
    },
    [associate, createLibraryItem],
  );

  /**
   * Copies the current portrait into a material before it is replaced, unless
   * a material already holds the same bytes (e.g. it was a kept candidate).
   */
  const preserveCurrentPortrait = useCallback(
    async (elementId: string) => {
      const asset = portraitToPreserve(useDataStore.getState(), elementId);
      if (!asset) return;
      const source = await assetStoreService.requireVariant(projectId, asset, 'source');
      const item = await createLibraryItem({
        kind: 'image',
        sourcePath: source.filePath,
        releaseSourceImport: false,
        title: materialTitle(elementId, '旧设定图'),
        provenanceJson: serializeMaterialProvenance({
          v: 1,
          origin: 'element-portrait',
          elementId,
          replacedAt: new Date().toISOString(),
        }),
      });
      await associate(item, elementId);
    },
    [associate, createLibraryItem, projectId],
  );

  const replacePortraitFromLocalFile = useCallback(
    async (elementId: string, sourcePath: string) => {
      await preserveCurrentPortrait(elementId);
      await elementUsecases.setElementPortraitFromLocalFile(elementId, sourcePath);
    },
    [elementUsecases, preserveCurrentPortrait],
  );

  const discardCandidate = useCallback(async (candidate: ImageInboxEntry) => {
    await platform.imageGeneration.discard(candidate.projectId, candidate.id);
    useImageInboxStore.getState().removeCandidate(candidate.projectId, candidate.id);
  }, []);

  const keepCandidate = useCallback(
    async (candidate: ImageInboxEntry, elementId: string) => {
      await keepAsMaterial(candidate, elementId);
      await discardCandidate(candidate);
    },
    [discardCandidate, keepAsMaterial],
  );

  const setPortraitFromCandidate = useCallback(
    async (candidate: ImageInboxEntry, elementId: string) => {
      await keepAsMaterial(candidate, elementId);
      const sourcePath = await platform.imageGeneration.stageImport(candidate.projectId, candidate.id);
      try {
        await replacePortraitFromLocalFile(elementId, sourcePath);
      } catch (error) {
        await releasePickedMaterialImport(sourcePath).catch(() => undefined);
        throw error;
      }
      await discardCandidate(candidate);
    },
    [discardCandidate, keepAsMaterial, replacePortraitFromLocalFile],
  );

  const saveArtStyle = useCallback(
    async (styleText: string) => {
      const project = useProjectStore.getState().currentProject;
      if (!project || project.id !== projectId) return;
      await updateProject(project.id, { kvJson: withArtStyle(project.kvJson, styleText) });
    },
    [projectId, updateProject],
  );

  return useMemo(
    () => ({
      keepCandidate,
      setPortraitFromCandidate,
      discardCandidate,
      saveArtStyle,
      replacePortraitFromLocalFile,
    }),
    [keepCandidate, setPortraitFromCandidate, discardCandidate, saveArtStyle, replacePortraitFromLocalFile],
  );
}
