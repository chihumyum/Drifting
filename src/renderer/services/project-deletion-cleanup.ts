import LogLevel from 'loglevel';
import type { ProjectDeletionReceipt } from '../sqlite-repo/project-deletion-repo';
import { useProjectStore } from '../store/project-store';
import { assetStoreService } from './asset-store.service';
import { useRecentEntitiesStore } from '../store/recent-entities-store';
import { useWritingStatsStore } from '../store/writing-stats-store';
import { useUiStore } from '../store/ui-store';
import { useSettingsStore } from '../store/settings-store';
import { useAgentEditStore } from '../store/agent-edit-store';

const log = LogLevel.getLogger('ProjectDeletionCleanup');

export async function cleanupDeletedProject(id: string, deletion: ProjectDeletionReceipt): Promise<void> {
  // SQLite is now committed. Remove every rebuildable/presentation trace
  // keyed by this project before attempting fallible native file cleanup.
  useProjectStore.getState().removeProject(id);
  useRecentEntitiesStore.getState().clearProject(id);
  useWritingStatsStore.getState().clearProject(id);
  useUiStore.getState().clearProjectTabs(id);
  useSettingsStore.getState().clearProjectSettings(id);
  useAgentEditStore
    .getState()
    .clearProject(id, deletion.proseDocIds, deletion.agentReviewIds);

  const cleanupResults = await Promise.allSettled([
    import('./markdown-projection.service').then(module => module.removeMarkdownProjection(id)),
    ...deletion.assetIds.map((assetId) => assetStoreService.deleteAsset(id, assetId)),
  ]);
  const cleanupFailures = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (cleanupFailures.length > 0) {
    // The project is already durably deleted, so returning false or
    // throwing would tell the UI a retry is safe when it is not. Keep the
    // failure visible until a durable project-directory GC lands.
    log.warn(
      `Project ${id} was deleted, but ${cleanupFailures.length} local asset cleanup(s) failed`,
      new AggregateError(cleanupFailures),
    );
  }
}
