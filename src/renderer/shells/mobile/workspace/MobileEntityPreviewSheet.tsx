import { Check, FilePlus2, X } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { isChapter, isDrift } from '../../../domain/book-node';
import type { StructuralEntityKind } from '../../../domain/entity-kinds';
import { useDataStore } from '../../../store/data-store';
import { useMobilePaperPresentation } from './MobilePaperContent';

interface PreviewField {
  label: string;
  value: string;
}

function statusLabel(value: string): string {
  return (
    (
      {
        draft: '草稿',
        finished: '已完成',
        discarded: '已搁置',
        drifting: '流动中',
        resting: '已休眠',
      } as Record<string, string>
    )[value] ?? value
  );
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

export function MobileEntityPreviewSheet({
  target,
  paperOpen,
  onClose,
  onInsert,
}: {
  target: WorkspaceTarget;
  paperOpen: boolean;
  onClose: () => void;
  onInsert: () => void;
}) {
  const { t } = useTranslation();
  const presentation = useMobilePaperPresentation(target);
  const data = useDataStore();

  const details = useMemo(() => {
    const fields: PreviewField[] = [];
    let updatedAt: string | undefined;
    let relationKind: StructuralEntityKind | null = null;

    if (target.entityType === 'node') {
      const node = data.bookNodes.find((item) => item.id === target.id);
      if (node) {
        relationKind = 'node';
        updatedAt = node.updatedAt;
        fields.push({ label: '状态', value: statusLabel(node.writingStatus) });
        fields.push({ label: '字数', value: node.wordCount.toLocaleString() });
        if (isChapter(node)) {
          const storyline = data.storylines.find(
            (item) => item.id === data.primaryStorylineByNode[node.id],
          );
          fields.push({
            label: '故事线',
            value: storyline?.name ?? t('nodeEditor.empty.noStoryline'),
          });
          fields.push({ label: '阅读顺序', value: String(node.bookOrder + 1) });
        } else if (isDrift(node)) {
          const group = data.driftGroups.find((item) => item.id === node.driftGroupId);
          fields.push({ label: '分组', value: group?.name ?? '未分组' });
        }
      }
    } else if (target.entityType === 'element') {
      const element = data.bookElements.find((item) => item.id === target.id);
      if (element) {
        relationKind = 'element';
        updatedAt = element.updatedAt;
        const category = data.bookElementCategories.find((item) => item.id === element.categoryId);
        fields.push({ label: '类目', value: category?.name ?? '未分类' });
        fields.push({ label: '分组', value: element.groupName ?? '未分组' });
        fields.push({ label: '别名', value: element.aliases.join('、') || '—' });
      }
    } else if (target.entityType === 'category') {
      const category = data.bookElementCategories.find((item) => item.id === target.id);
      if (category) {
        relationKind = 'category';
        updatedAt = category.updatedAt;
        fields.push({
          label: '元素',
          value: String(data.bookElements.filter((item) => item.categoryId === category.id).length),
        });
      }
    } else if (target.entityType === 'storyline') {
      const storyline = data.storylines.find((item) => item.id === target.id);
      if (storyline) {
        relationKind = 'storyline';
        updatedAt = storyline.updatedAt;
        fields.push({
          label: '章节',
          value: String(data.storylineNodeMapping[storyline.id]?.length ?? 0),
        });
      }
    }

    if (relationKind) {
      const count = data.entityRelations.filter(
        (relation) =>
          (relation.fromKind === relationKind && relation.fromId === target.id) ||
          (relation.toKind === relationKind && relation.toId === target.id),
      ).length;
      fields.push({ label: '关联', value: String(count) });
    }
    fields.push({ label: '最近更新', value: formatUpdatedAt(updatedAt) });
    return fields;
  }, [data, t, target]);

  return (
    <div className="m-entity-preview-sheet" role="presentation" onPointerDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="m-entity-preview-title"
        onPointerDown={(event) => event.stopPropagation()}
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
            <h2 id="m-entity-preview-title">{presentation.title}</h2>
            <span data-open={paperOpen ? 'true' : 'false'}>
              {paperOpen && <Check size={13} aria-hidden="true" />}
              {paperOpen ? '已在纸张中' : '尚未打开'}
            </span>
          </div>
          <section className="m-entity-preview-sheet__summary" aria-label="摘要">
            <small>摘要</small>
            <p>{presentation.preview || '还没有摘要。'}</p>
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

        <footer>
          <p>这里只读预览。插入纸张后才能编辑。</p>
          <button type="button" onClick={onInsert}>
            <FilePlus2 size={18} aria-hidden="true" />
            {paperOpen ? '打开已有纸张' : '插入一张纸'}
          </button>
        </footer>
      </section>
    </div>
  );
}
