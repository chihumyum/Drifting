import { useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/Button';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { KindMark } from '../../../components/ui/KindMark';
import {
  isleAppearance,
  isleSection,
  type IsleTick,
} from '../../../features/graph/element-isles-model';

export interface ElementIsleDetailProps {
  name: string;
  summary: string;
  categoryName: string;
  color: string | undefined;
  mentions: number;
  ticks: readonly IsleTick[];
  companions: readonly { id: string; name: string; color: string | undefined; count: number }[];
  relations: readonly {
    id: string;
    typeName: string;
    color: string;
    /** The relation points at this element rather than from it. */
    incoming: boolean;
    otherName: string;
    otherMark: React.ReactNode;
    onSelect?: () => void;
  }[];
  isolated: boolean;
  onIsolate: () => void;
  onFocus: (elementId: string) => void;
  onEdit: (anchor: DOMRect) => void;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * The focused element on the islands: a lifted piece of desk at the
 * canvas's right edge. Its appearance strip is one stroke of sand per
 * chapter in book order, in the colour of that chapter's storyline and as
 * dense as the element is mentioned there; who it is mentioned with most
 * and the relations drawn to it follow, each one a way to move the focus.
 */
export function ElementIsleDetail({
  name, summary, categoryName, color, mentions, ticks, companions, relations,
  isolated, onIsolate, onFocus, onEdit, onOpen, onClose,
}: ElementIsleDetailProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);
  const appearance = isleAppearance(ticks);
  const most = ticks.reduce((max, tick) => Math.max(max, tick.count), 1);
  return (
    <aside ref={ref} className="se-detail" aria-label={name} data-super-modal>
      <div className="se-detail__head">
        <KindMark kind="element" color={color} />
        <div className="se-detail__title">
          <div className="se-detail__name">{name}</div>
          <div className="se-detail__meta">{t('superElement.isles.detail.meta', { category: categoryName, count: mentions })}</div>
        </div>
        <button type="button" className="se-detail__close" aria-label={t('superElement.isles.detail.close')} onClick={onClose}>
          <BrushIcon name="close" size={13} />
        </button>
      </div>
      {summary && <p className="se-detail__summary">{summary}</p>}

      <div className="se-detail__label">{t('superElement.isles.detail.appearance')}</div>
      <div className={ticks.length > 40 ? 'se-detail__ticks is-dense' : 'se-detail__ticks'} role="list">
        {ticks.map((tick) => {
          const section = isleSection(tick.number);
          const title = tick.count > 0
            ? t('superElement.isles.detail.tick', { section, title: tick.title, count: tick.count })
            : t('superElement.isles.detail.tickAbsent', { section, title: tick.title });
          return (
            <span
              key={tick.chapterId}
              role="listitem"
              title={title}
              aria-label={title}
              className={tick.count > 0 ? 'se-detail__tick' : 'se-detail__tick is-absent'}
              style={tick.count > 0 ? ({
                '--tick-c': tick.color ?? 'hsl(var(--ink-3))',
                '--tick-h': `${Math.round(8 + (tick.count / most) * 16)}px`,
                '--tick-o': (0.45 + (tick.count / most) * 0.55).toFixed(2),
              } as CSSProperties) : undefined}
            />
          );
        })}
      </div>
      <div className="se-detail__meta">
        {appearance.appeared > 0
          ? t('superElement.isles.detail.appeared', {
            appeared: appearance.appeared,
            total: appearance.total,
            first: isleSection(appearance.first ?? 0),
            last: isleSection(appearance.last ?? 0),
            gap: appearance.longestGap,
          })
          : t('superElement.isles.detail.never')}
      </div>

      {companions.length > 0 && (
        <>
          <div className="se-detail__label">{t('superElement.isles.detail.companions')}</div>
          <div className="se-detail__rows">
            {companions.map((companion) => (
              <button key={companion.id} type="button" className="menu-surface__item se-detail__row" onClick={() => onFocus(companion.id)}>
                <KindMark kind="element" color={companion.color} />
                <span className="se-detail__row-name">{companion.name}</span>
                <span className="se-detail__row-count">{t('superElement.isles.detail.times', { count: companion.count })}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {relations.length > 0 && (
        <>
          <div className="se-detail__label">{t('superElement.isles.detail.relations')}</div>
          <div className="se-detail__rows">
            {relations.map((relation) => (
              <button
                key={relation.id}
                type="button"
                className="menu-surface__item se-detail__row"
                disabled={!relation.onSelect}
                onClick={relation.onSelect}
              >
                <span className="se-detail__dash" style={{ '--dash-c': relation.color } as CSSProperties} aria-hidden />
                <span className="se-detail__row-type">{relation.incoming ? `${relation.typeName} ←` : relation.typeName}</span>
                {relation.otherMark}
                <span className="se-detail__row-name">{relation.otherName}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="se-detail__foot">
        <Button variant="ghost" size="sm" onClick={onIsolate}>
          {isolated ? t('superElement.isles.detail.showAll') : t('superElement.isles.detail.isolate')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const rect = ref.current?.getBoundingClientRect();
            if (rect) onEdit(rect);
          }}
        >
          {t('superElement.isles.detail.edit')}
        </Button>
        <Button variant="primary" size="sm" onClick={onOpen}>
          {t('nodeCardPopover.openInEditor')}
        </Button>
      </div>
    </aside>
  );
}
