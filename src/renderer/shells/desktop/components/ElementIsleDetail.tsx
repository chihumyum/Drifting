import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { HoverCardHeading, HoverCardRow } from '../../../components/ui/HoverCard';
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
  /** Grow the card into the island's editor. */
  onEdit: () => void;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * The focused element on the islands, as the island's small card
 * (SuperElementIsland), laid out as a hover card is: its head, its summary,
 * then its sections parted by the menus' hairline. Its appearance strip is one stroke of sand per
 * chapter in book order, in the colour of that chapter's storyline and as
 * dense as the element is mentioned there; who it is mentioned with most
 * and the relations drawn to it follow, each one a way to move the focus.
 */
export function ElementIsleDetail({
  name, summary, categoryName, color, mentions, ticks, companions, relations,
  isolated, onIsolate, onFocus, onEdit, onOpen,
}: ElementIsleDetailProps) {
  const { t } = useTranslation();
  const appearance = isleAppearance(ticks);
  const most = ticks.reduce((max, tick) => Math.max(max, tick.count), 1);
  return (
    <div className="se-detail" aria-label={name}>
      <div className="hover-card__body">
        <HoverCardHeading
          title={name}
          mark={{ kind: 'element', color }}
          index={t('superElement.isles.island.mentions', { count: mentions })}
          detail={<span className="hover-card__tag"><KindMark kind="category" color={color} />{categoryName}</span>}
        />
        {summary && <div className="hover-card__text">{summary}</div>}
      </div>
      <div className="hover-card__actions">
        <div className="hover-card__section">
          <div className="hover-card__section-label">{t('superElement.isles.detail.appearance')}</div>
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
          <div className="hover-card__note">
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
        </div>

        {companions.length > 0 && (
          <div className="hover-card__section">
            <div className="hover-card__section-label">{t('superElement.isles.detail.companions')}</div>
            {companions.map((companion) => (
              <HoverCardRow
                key={companion.id}
                icon={{ kind: 'element', color: companion.color }}
                label={companion.name}
                aside={t('superElement.isles.detail.times', { count: companion.count })}
                onClick={() => onFocus(companion.id)}
              />
            ))}
          </div>
        )}

        {relations.length > 0 && (
          <div className="hover-card__section">
            <div className="hover-card__section-label">{t('superElement.isles.detail.relations')}</div>
            {relations.map((relation) => (
              <HoverCardRow
                key={relation.id}
                icon={{ kind: 'storyline', color: relation.color }}
                disabled={!relation.onSelect}
                onClick={relation.onSelect}
              >
                <span className="hover-card__row-type">{relation.incoming ? `${relation.typeName} ←` : relation.typeName}</span>
                {relation.otherMark}
                <span className="hover-card__row-label">{relation.otherName}</span>
              </HoverCardRow>
            ))}
          </div>
        )}

        <div className="hover-card__section">
          <HoverCardRow
            icon={{ brush: 'locate' }}
            label={isolated ? t('superElement.isles.detail.showAll') : t('superElement.isles.detail.isolate')}
            onClick={onIsolate}
          />
          <HoverCardRow icon={{ brush: 'arrow-out' }} label={t('superElement.isles.island.openInTab')} data-se-open-tab="" onClick={onOpen} />
          <HoverCardRow icon={{ brush: 'edit' }} label={t('superElement.isles.detail.edit')} onClick={onEdit} />
        </div>
      </div>
    </div>
  );
}

/** The element's facts above its editor in the island: the appearance strip and who it is mentioned with. */
export function ElementIsleStrip({ ticks, companions, onFocus }: {
  ticks: readonly IsleTick[];
  companions: ElementIsleDetailProps['companions'];
  onFocus: (elementId: string) => void;
}) {
  const { t } = useTranslation();
  const appearance = isleAppearance(ticks);
  const most = ticks.reduce((max, tick) => Math.max(max, tick.count), 1);
  return (
    <>
      <div className="se-strip__row">
        <span className="se-detail__label">{t('superElement.isles.detail.appearance')}</span>
        <div className={ticks.length > 40 ? 'se-detail__ticks se-strip__ticks is-dense' : 'se-detail__ticks se-strip__ticks'} role="list">
          {ticks.map((tick) => (
            <span
              key={tick.chapterId}
              role="listitem"
              title={tick.count > 0
                ? t('superElement.isles.detail.tick', { section: isleSection(tick.number), title: tick.title, count: tick.count })
                : t('superElement.isles.detail.tickAbsent', { section: isleSection(tick.number), title: tick.title })}
              className={tick.count > 0 ? 'se-detail__tick' : 'se-detail__tick is-absent'}
              style={tick.count > 0 ? ({
                '--tick-c': tick.color ?? 'hsl(var(--ink-3))',
                '--tick-h': `${Math.round(5 + (tick.count / most) * 9)}px`,
                '--tick-o': (0.45 + (tick.count / most) * 0.55).toFixed(2),
              } as CSSProperties) : undefined}
            />
          ))}
        </div>
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
        <div className="se-strip__chips">
          {companions.map((companion) => (
            <button key={companion.id} type="button" className="se-strip__chip" onClick={() => onFocus(companion.id)}>
              <KindMark kind="element" color={companion.color} />
              <span>{companion.name}</span>
              <span className="se-detail__row-count">{t('superElement.isles.detail.times', { count: companion.count })}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** A category as the island's small card: its elements, most mentioned first. */
export function CategoryIsleDetail({ name, color, members, onFocus, onEdit, onOpen }: {
  name: string;
  color: string | undefined;
  members: readonly { id: string; name: string; mentions: number }[];
  onFocus: (elementId: string) => void;
  onEdit: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="se-detail" aria-label={name}>
      <div className="hover-card__body">
        <HoverCardHeading
          title={name}
          mark={{ kind: 'category', color }}
          index={t('superElement.isles.island.categoryMeta', { count: members.length })}
        />
      </div>
      <div className="hover-card__actions">
        {members.length > 0 && (
          <div className="hover-card__section">
            {members.slice(0, 8).map((member) => (
              <HoverCardRow
                key={member.id}
                icon={{ kind: 'element', color }}
                label={member.name}
                aside={member.mentions > 0
                  ? t('superElement.isles.island.mentions', { count: member.mentions })
                  : t('superElement.isles.island.unmentioned')}
                onClick={() => onFocus(member.id)}
              />
            ))}
          </div>
        )}
        <div className="hover-card__section">
          <HoverCardRow icon={{ brush: 'arrow-out' }} label={t('superElement.isles.island.openInTab')} data-se-open-tab="" onClick={onOpen} />
          <HoverCardRow icon={{ brush: 'edit' }} label={t('superElement.isles.detail.edit')} onClick={onEdit} />
        </div>
      </div>
    </div>
  );
}

/** A category's facts above its editor in the island: its elements, most mentioned first. */
export function CategoryIsleStrip({ color, members, onFocus }: {
  color: string | undefined;
  members: readonly { id: string; name: string; mentions: number }[];
  onFocus: (elementId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="se-strip__row">
        <span className="se-detail__label">{t('superElement.isles.island.categoryMeta', { count: members.length })}</span>
        <span className="se-detail__meta">{t('superElement.isles.island.mostMentioned')}</span>
      </div>
      {members.length > 0 && (
        <div className="se-strip__chips">
          {members.slice(0, 12).map((member) => (
            <button key={member.id} type="button" className="se-strip__chip" onClick={() => onFocus(member.id)}>
              <KindMark kind="element" color={color} />
              <span>{member.name}</span>
              {member.mentions > 0 && (
                <span className="se-detail__row-count">{t('superElement.isles.island.mentions', { count: member.mentions })}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
