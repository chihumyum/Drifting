import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../store/data-store';
import { countWordsInPmJson } from '../../lib/word-count';
import { noteTaskItems } from '../../lib/note-tasks';
import { EmptyState } from '../../components/ui/EmptyState';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import type { WorkspaceTarget } from '../workspace/navigation/workspace-target';
import {
  DetailValue,
  formatDateTime,
  MetaGrid,
  MetaK,
  MetaV,
  ProgressBar,
  SnapshotEntryButton,
  StatsLinkRow,
  StatsRow,
  StatsSection,
} from './StatsPrimitives';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Embedded material ids in a note body, in document order. */
function embeddedMaterialIds(bodyJson: string | null): string[] {
  if (!bodyJson) return [];
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as { type?: unknown; attrs?: { libraryItemId?: unknown }; content?: unknown };
    if (record.type === 'materialEmbed' && typeof record.attrs?.libraryItemId === 'string') {
      ids.push(record.attrs.libraryItemId);
    }
    if (Array.isArray(record.content)) record.content.forEach(walk);
  };
  try {
    walk(JSON.parse(bodyJson));
  } catch {
    return [];
  }
  return ids;
}

/** The stats tab for a material: where it sits, what it holds, its history. */
export function MaterialStats({ libraryItemId }: { libraryItemId: string }) {
  const { t } = useTranslation();
  const { open } = useWorkspaceNavigator();
  const item = useDataStore((s) => s.libraryItems.find((candidate) => candidate.id === libraryItemId));
  const libraryItems = useDataStore((s) => s.libraryItems);
  const asset = useDataStore((s) =>
    item?.assetId ? s.projectAssets.find((candidate) => candidate.id === item.assetId) : undefined,
  );
  const comments = useDataStore((s) => s.comments);
  const entityRelations = useDataStore((s) => s.entityRelations);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const bookElements = useDataStore((s) => s.bookElements);
  const storylines = useDataStore((s) => s.storylines);
  const categories = useDataStore((s) => s.bookElementCategories);

  const bodyJson = item?.kind === 'text' ? item.bodyJson : null;
  const shape = useMemo(() => {
    const tasks = noteTaskItems(bodyJson);
    return {
      words: bodyJson ? countWordsInPmJson(bodyJson) : 0,
      tasks: tasks.length,
      done: tasks.filter((task) => task.checked).length,
      embeds: embeddedMaterialIds(bodyJson),
    };
  }, [bodyJson]);
  const openComments = comments.filter(
    (comment) =>
      comment.targetKind === 'library_item' && comment.targetId === libraryItemId && comment.status === 'open',
  ).length;
  const related = useMemo(() => {
    const rows: Array<{ key: string; name: string; target: WorkspaceTarget }> = [];
    for (const relation of entityRelations) {
      if (relation.fromKind !== 'library_item' || relation.fromId !== libraryItemId) continue;
      if (relation.toKind === 'patch') continue;
      const key = `${relation.toKind}:${relation.toId}`;
      if (rows.some((row) => row.key === key)) continue;
      const name =
        relation.toKind === 'node'
          ? bookNodes.find((node) => node.id === relation.toId)?.title
          : relation.toKind === 'element'
            ? bookElements.find((element) => element.id === relation.toId)?.name
            : relation.toKind === 'storyline'
              ? storylines.find((storyline) => storyline.id === relation.toId)?.name
              : relation.toKind === 'category'
                ? categories.find((category) => category.id === relation.toId)?.name
                : undefined;
      if (name === undefined) continue;
      rows.push({ key, name: name || t('common.untitled'), target: { entityType: relation.toKind, id: relation.toId } });
    }
    return rows;
  }, [bookElements, bookNodes, categories, entityRelations, libraryItemId, storylines, t]);

  if (!item) return <EmptyState message={t('rightSidebar.empty.missingMaterial')} />;
  const kindLabel = t(`memoMaterial.kind.${item.kind}`, { defaultValue: item.kind });

  return (
    <div style={{ padding: 12 }}>
      <StatsSection title={t('rightSidebar.stats.materialCoordinates')}>
        <MetaGrid>
          <MetaK>{t('rightSidebar.stats.type')}</MetaK>
          <MetaV>
            <DetailValue>{kindLabel}</DetailValue>
          </MetaV>
          <MetaK>{t('rightSidebar.stats.created')}</MetaK>
          <MetaV>
            <DetailValue>{formatDateTime(item.createdAt)}</DetailValue>
          </MetaV>
          <MetaK>{t('rightSidebar.stats.updated')}</MetaK>
          <MetaV>
            <DetailValue>{formatDateTime(item.updatedAt)}</DetailValue>
          </MetaV>
        </MetaGrid>
      </StatsSection>

      {item.kind === 'text' ? (
        <StatsSection title={t('rightSidebar.stats.noteShape')} topBorder>
          <StatsRow k={t('rightSidebar.stats.noteWords')} v={t('rightSidebar.stats.wordsValue', { count: shape.words })} />
          <StatsRow
            k={t('rightSidebar.stats.noteTasks')}
            v={shape.tasks === 0 ? '—' : t('rightSidebar.stats.noteTasksValue', { done: shape.done, total: shape.tasks })}
          >
            {shape.tasks > 0 && <ProgressBar pct={(shape.done / shape.tasks) * 100} />}
          </StatsRow>
          <StatsRow k={t('rightSidebar.stats.openComments')} v={String(openComments)} />
        </StatsSection>
      ) : (
        <StatsSection title={t('rightSidebar.stats.materialFile')} topBorder>
          <StatsRow k={t('rightSidebar.stats.fileType')} v={asset?.sourceMime ?? '—'} />
          <StatsRow k={t('rightSidebar.stats.fileSize')} v={asset ? formatBytes(asset.sourceSizeBytes) : '—'} />
          {asset?.width && asset.height ? (
            <StatsRow k={t('rightSidebar.stats.dimensions')} v={`${asset.width} × ${asset.height}`} />
          ) : null}
          <StatsRow k={t('rightSidebar.stats.openComments')} v={String(openComments)} />
        </StatsSection>
      )}

      {shape.embeds.length > 0 && (
        <StatsSection title={t('rightSidebar.stats.embeddedMaterials')} topBorder>
          {shape.embeds.map((id, index) => {
            const embedded = libraryItems.find((candidate) => candidate.id === id);
            if (!embedded) return null;
            return (
              <StatsLinkRow
                key={`${id}:${index}`}
                name={embedded.title || t('common.untitled')}
                meta={t(`memoMaterial.kind.${embedded.kind}`, { defaultValue: embedded.kind })}
                onOpen={() => open({ entityType: 'library_item', id })}
              />
            );
          })}
        </StatsSection>
      )}

      {related.length > 0 && (
        <StatsSection title={t('rightSidebar.stats.materialRelations')} topBorder>
          {related.map((row) => (
            <StatsLinkRow key={row.key} name={row.name} onOpen={() => open(row.target)} />
          ))}
        </StatsSection>
      )}

      {item.kind === 'text' && <SnapshotEntryButton entityKind="library_item" entityId={item.id} />}
    </div>
  );
}
