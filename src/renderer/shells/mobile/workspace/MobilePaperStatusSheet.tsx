import { Check, X } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getWritingStatusLabel } from '../../../components/editor/EditorTopBar';
import {
  canonicalWordCount,
  isChapter,
  sumCanonicalChapterWordCounts,
} from '../../../domain/book-node';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useDataStore } from '../../../store/data-store';
import { useMobilePaperPresentation } from './MobilePaperContent';

interface StatusField {
  label: string;
  value: string;
}

function formatUpdatedAt(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function MobilePaperStatusSheet({
  target,
  paperIndex,
  paperCount,
  onClose,
}: {
  target: WorkspaceTarget;
  paperIndex: number;
  paperCount: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const presentation = useMobilePaperPresentation(target);
  const data = useDataStore();
  const details = useMemo<StatusField[]>(() => {
    const fields: StatusField[] = [
      {
        label: t('mobileWorkspace.paperStatus.position', { defaultValue: '纸张位置' }),
        value: `${paperIndex + 1} / ${paperCount}`,
      },
    ];
    let updatedAt: string | undefined;

    if (target.entityType === 'node') {
      const node = data.bookNodes.find((item) => item.id === target.id);
      if (node) {
        updatedAt = node.updatedAt;
        fields.push({
          label: t('mobileWorkspace.paperStatus.writingStatus', { defaultValue: '写作状态' }),
          value: getWritingStatusLabel(node.writingStatus, t),
        });
        fields.push({
          label: t('mobileWorkspace.paperStatus.words', { defaultValue: '字数' }),
          value: canonicalWordCount(node)?.toLocaleString() ?? t('common.counting'),
        });
        if (isChapter(node)) {
          const storyline = data.storylines.find(
            (item) => item.id === data.primaryStorylineByNode[node.id],
          );
          fields.push({
            label: t('mobileWorkspace.paperStatus.storyline', { defaultValue: '故事线' }),
            value: storyline?.name ?? t('nodeEditor.empty.noStoryline'),
          });
        }
      }
    } else if (target.entityType === 'storyline') {
      const storyline = data.storylines.find((item) => item.id === target.id);
      updatedAt = storyline?.updatedAt;
      fields.push({
        label: t('mobileWorkspace.paperStatus.chapters', { defaultValue: '章节' }),
        value: String(data.storylineNodeMapping[target.id]?.length ?? 0),
      });
    } else if (target.entityType === 'element') {
      const element = data.bookElements.find((item) => item.id === target.id);
      updatedAt = element?.updatedAt;
      const category = data.bookElementCategories.find((item) => item.id === element?.categoryId);
      fields.push({
        label: t('mobileWorkspace.paperStatus.category', { defaultValue: '类目' }),
        value: category?.name ?? t('common.uncategorized', { defaultValue: '未分类' }),
      });
    } else if (target.entityType === 'category') {
      const category = data.bookElementCategories.find((item) => item.id === target.id);
      updatedAt = category?.updatedAt;
      fields.push({
        label: t('mobileWorkspace.paperStatus.elements', { defaultValue: '元素' }),
        value: String(data.bookElements.filter((item) => item.categoryId === target.id).length),
      });
    } else {
      const chapters = data.bookNodes.filter(isChapter);
      const words = sumCanonicalChapterWordCounts(data.bookNodes);
      fields.push({
        label: t('mobileWorkspace.paperStatus.chapters', { defaultValue: '章节' }),
        value: String(chapters.length),
      });
      fields.push({
        label: t('mobileWorkspace.paperStatus.words', { defaultValue: '字数' }),
        value: words.ready ? words.count.toLocaleString() : t('common.counting'),
      });
    }

    fields.push({
      label: t('mobileWorkspace.paperStatus.updated', { defaultValue: '最近更新' }),
      value: formatUpdatedAt(updatedAt),
    });
    return fields;
  }, [data, paperCount, paperIndex, t, target]);

  return (
    <div
      className="m-entity-preview-sheet m-paper-status-sheet"
      role="presentation"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="m-paper-status-title"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="m-entity-preview-sheet__grab" aria-hidden="true" />
        <header>
          <div>
            <span style={{ background: presentation.color || 'hsl(var(--ink-4))' }} />
            <small>{presentation.kicker}</small>
          </div>
          <button type="button" aria-label={t('common.close')} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className="m-entity-preview-sheet__scroll">
          <div className="m-entity-preview-sheet__title-row">
            <h2 id="m-paper-status-title">{presentation.title}</h2>
            <span data-open="true">
              <Check size={13} aria-hidden="true" />
              {t('mobileWorkspace.paperStatus.current', { defaultValue: '当前纸张' })}
            </span>
          </div>
          <section
            className="m-entity-preview-sheet__summary"
            aria-label={t('globalSearch.field.summary')}
          >
            <small>{t('globalSearch.field.summary')}</small>
            <p>{presentation.preview || t('editorMainArea.emptyHint')}</p>
          </section>
          <dl>
            {details.map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
