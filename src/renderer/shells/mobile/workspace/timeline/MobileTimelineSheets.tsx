import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BookAct } from '../../../../domain/book-act';
import {
  CHAPTER_WRITING_STATUSES,
  canonicalWordCount,
  type BookNode,
  type ChapterWritingStatus,
} from '../../../../domain/book-node';
import type { Storyline } from '../../../../domain/storyline';
import type { TimelineMarker } from '../../../../domain/timeline-marker';
import { MobileToolSheet } from '../MobileToolSheet';

export type TimelineView = 'book' | 'narrative';

function RenameRow({
  label,
  value,
  placeholder,
  onCommit,
  onRenamingChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
  onRenamingChange: (renaming: boolean) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onRenamingChange(renaming);
    if (renaming) inputRef.current?.focus();
  }, [onRenamingChange, renaming]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    setRenaming(false);
  };
  if (renaming) {
    return (
      <div className="m-sheet__rename">
        <input
          ref={inputRef}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      </div>
    );
  }
  return (
    <button type="button" className="m-sheet__row" onClick={() => setRenaming(true)}>
      {label}
      <span className="m-sheet__row-value">
        {value}
        <ChevronRight size={14} aria-hidden="true" />
      </span>
    </button>
  );
}

/** Chapter menu: storyline pills, open, move, unplace, new act here, status. */
export function MobileTimelineChapterSheet({
  node,
  chapterIndex,
  view,
  storylines,
  primaryStorylineId,
  showUnaffiliated,
  onOpen,
  onChangeStoryline,
  onMovePosition,
  onPlaceAtEnd,
  onUnplace,
  onStartAct,
  onSetStatus,
  onClose,
}: {
  node: BookNode;
  chapterIndex: number;
  view: TimelineView;
  storylines: readonly Storyline[];
  primaryStorylineId: string | null;
  showUnaffiliated: boolean;
  onOpen: () => void;
  onChangeStoryline: (storylineId: string | null) => void;
  onMovePosition: () => void;
  onPlaceAtEnd: () => void;
  onUnplace: () => void;
  onStartAct: () => void;
  onSetStatus: (status: ChapterWritingStatus) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const placed =
    view === 'book' ? typeof node.bookOrder === 'number' : typeof node.narrativeOrder === 'number';
  const words = canonicalWordCount(node);
  return (
    <MobileToolSheet
      ariaLabel={node.title}
      onClose={onClose}
      className="m-vtl-sheet"
      debugId="mobile-timeline-chapter-sheet"
    >
      <div className="m-sheet__kick">
        {t('mobileTimeline.chapterNumber', { index: chapterIndex })}
        {words !== null ? ` · ${t('mobileTimeline.wordCount', { count: words })}` : ''}
        {' · '}
        {t(`mobileTimeline.status.${node.writingStatus}`, { defaultValue: node.writingStatus })}
      </div>
      <div className="m-sheet__title">{node.title || t('common.untitled')}</div>
      <div className="m-sheet__label">{t('mobileTimeline.primaryStoryline')}</div>
      <div className="m-vtl-sheet__pills">
        {storylines.map((storyline) => {
          const active = storyline.id === primaryStorylineId;
          return (
            <button
              key={storyline.id}
              type="button"
              className={`m-vtl-pill m-vtl-pill--big${active ? ' is-on' : ''}`}
              style={{ ['--c' as string]: storyline.color }}
              aria-pressed={active}
              onClick={() => onChangeStoryline(storyline.id)}
            >
              <i aria-hidden="true" />
              {storyline.name}
            </button>
          );
        })}
        {showUnaffiliated && (
          <button
            type="button"
            className={`m-vtl-pill m-vtl-pill--big m-vtl-pill--none${primaryStorylineId === null ? ' is-on' : ''}`}
            aria-pressed={primaryStorylineId === null}
            onClick={() => onChangeStoryline(null)}
          >
            <i aria-hidden="true" />
            {t('bottomTimeline.synthetic.unaffiliated')}
          </button>
        )}
      </div>
      <div className="m-sheet__hint">{t('mobileTimeline.storylineHint')}</div>
      <div className="m-sheet__rows">
        <button type="button" className="m-sheet__row" onClick={onOpen}>
          {t('mobileTimeline.openPaper')}
          <span className="m-sheet__row-value">
            <ChevronRight size={14} aria-hidden="true" />
          </span>
        </button>
        {placed ? (
          <button type="button" className="m-sheet__row" onClick={onMovePosition}>
            {t('mobileTimeline.movePosition')}
            <span className="m-sheet__row-sub">{t('mobileTimeline.movePositionHint')}</span>
          </button>
        ) : (
          <button type="button" className="m-sheet__row" onClick={onMovePosition}>
            {t('mobileTimeline.placeInto')}
            <span className="m-sheet__row-sub">{t('mobileTimeline.movePositionHint')}</span>
          </button>
        )}
        {!placed && (
          <button type="button" className="m-sheet__row" onClick={onPlaceAtEnd}>
            {t('mobileTimeline.placeAtEnd')}
          </button>
        )}
        {view === 'narrative' && placed && (
          <button type="button" className="m-sheet__row" onClick={onUnplace}>
            {t('bottomTimeline.menu.detachFromNarrative')}
            <span className="m-sheet__row-sub">{t('mobileTimeline.unplaceHint')}</span>
          </button>
        )}
        <button
          type="button"
          className={`m-sheet__row${view !== 'book' ? ' m-sheet__row--off' : ''}`}
          disabled={view !== 'book'}
          onClick={onStartAct}
        >
          {t('bottomTimeline.menu.startActHere')}
          {view !== 'book' && (
            <span className="m-sheet__row-sub">{t('mobileTimeline.bookViewOnly')}</span>
          )}
        </button>
        <div className="m-sheet__row m-sheet__row--static">
          {t('mobileTimeline.writingStatus')}
          <span className="m-vtl-sheet__status">
            {CHAPTER_WRITING_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                aria-pressed={node.writingStatus === status}
                onClick={() => onSetStatus(status)}
              >
                {t(`mobileTimeline.status.${status}`)}
              </button>
            ))}
          </span>
        </div>
      </div>
    </MobileToolSheet>
  );
}

/** Act menu: rename, act note (bound drift), bind / unbind, delete (merge). */
export function MobileTimelineActSheet({
  act,
  position,
  count,
  chapterCount,
  driftTitle,
  onRename,
  onOpenNote,
  onBind,
  onUnbind,
  onDelete,
  onClose,
}: {
  act: BookAct;
  position: number;
  count: number;
  chapterCount: number;
  driftTitle: string | null;
  onRename: (name: string) => void;
  onOpenNote: () => void;
  onBind: () => void;
  onUnbind: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  return (
    <MobileToolSheet
      ariaLabel={act.name}
      onClose={onClose}
      keyboardAware={renaming}
      className="m-vtl-sheet"
      debugId="mobile-timeline-act-sheet"
    >
      <div className="m-sheet__kick">
        {t('bottomTimeline.act.railLabel')} · {position} / {count} ·{' '}
        {t('bottomTimeline.act.chapterCount', { count: chapterCount })}
      </div>
      {!renaming && <div className="m-sheet__title">{act.name}</div>}
      <div className="m-sheet__rows">
        <RenameRow
          label={t('bottomTimeline.pinMenu.rename')}
          value={act.name}
          placeholder={act.name}
          onCommit={onRename}
          onRenamingChange={setRenaming}
        />
        {act.driftNodeId ? (
          <>
            <button type="button" className="m-sheet__row" onClick={onOpenNote}>
              {t('bottomTimeline.act.openActNote')}
              <span className="m-sheet__row-sub">⚓ {driftTitle ?? t('bottomTimeline.act.actNote')}</span>
            </button>
            <button type="button" className="m-sheet__row" onClick={onUnbind}>
              {t('bottomTimeline.act.unbindDrift')}
            </button>
          </>
        ) : (
          <button type="button" className="m-sheet__row" onClick={onBind}>
            {t('bottomTimeline.pinMenu.bindDrift')}
          </button>
        )}
        <div className="m-sheet__row m-sheet__row--static">
          {t('mobileTimeline.moveBoundary')}
          <span className="m-sheet__row-sub">{t('mobileTimeline.moveBoundaryHint')}</span>
        </div>
        <button type="button" className="m-sheet__row m-sheet__row--danger" onClick={onDelete}>
          {position === 1
            ? t('bottomTimeline.act.deleteMergeNext')
            : t('bottomTimeline.act.deleteMergePrev')}
        </button>
      </div>
    </MobileToolSheet>
  );
}

/** Marker menu: rename, open bound drift, bind / unbind, delete. */
export function MobileTimelineMarkerSheet({
  marker,
  driftTitle,
  onRename,
  onOpenDrift,
  onBind,
  onUnbind,
  onDelete,
  onClose,
}: {
  marker: TimelineMarker;
  driftTitle: string | null;
  onRename: (label: string) => void;
  onOpenDrift: () => void;
  onBind: () => void;
  onUnbind: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const caption = marker.driftNodeId ? (driftTitle ?? marker.label) : marker.label;
  return (
    <MobileToolSheet
      ariaLabel={caption}
      onClose={onClose}
      keyboardAware={renaming}
      className="m-vtl-sheet"
      debugId="mobile-timeline-marker-sheet"
    >
      <div className="m-sheet__kick">{t('bottomTimeline.axis.time')}</div>
      {!renaming && <div className="m-sheet__title">{caption}</div>}
      <div className="m-sheet__rows">
        {!marker.driftNodeId && (
          <RenameRow
            label={t('bottomTimeline.pinMenu.rename')}
            value={marker.label}
            placeholder={t('bottomTimeline.marker.defaultLabel')}
            onCommit={onRename}
            onRenamingChange={setRenaming}
          />
        )}
        {marker.driftNodeId ? (
          <>
            <button type="button" className="m-sheet__row" onClick={onOpenDrift}>
              {t('bottomTimeline.pinMenu.openDrift')}
              <span className="m-sheet__row-sub">⚓ {driftTitle ?? ''}</span>
            </button>
            <button type="button" className="m-sheet__row" onClick={onUnbind}>
              {t('bottomTimeline.pinMenu.unbind')}
            </button>
          </>
        ) : (
          <button type="button" className="m-sheet__row" onClick={onBind}>
            {t('bottomTimeline.pinMenu.bindDrift')}
          </button>
        )}
        <div className="m-sheet__row m-sheet__row--static">
          {t('mobileTimeline.moveMarker')}
          <span className="m-sheet__row-sub">{t('mobileTimeline.moveMarkerHint')}</span>
        </div>
        <button type="button" className="m-sheet__row m-sheet__row--danger" onClick={onDelete}>
          {t('bottomTimeline.pinMenu.deleteMarker')}
        </button>
      </div>
    </MobileToolSheet>
  );
}

/** "+" and long-press-on-empty-track: create a chapter, an act, or a marker. */
export function MobileTimelineCreateSheet({
  view,
  atEnd,
  onCreateChapter,
  onCreateAct,
  onCreateMarker,
  onClose,
}: {
  view: TimelineView;
  atEnd: boolean;
  onCreateChapter: () => void;
  onCreateAct: () => void;
  onCreateMarker: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const where = atEnd ? t('mobileTimeline.atEnd') : t('mobileTimeline.here');
  return (
    <MobileToolSheet
      ariaLabel={t('mobileTimeline.create')}
      onClose={onClose}
      className="m-vtl-sheet"
      debugId="mobile-timeline-create-sheet"
    >
      <div className="m-sheet__kick">{t('mobileTimeline.create')}</div>
      <div className="m-sheet__rows">
        <button type="button" className="m-sheet__row" onClick={onCreateChapter}>
          {t('mobileTimeline.createChapter')}
          <span className="m-sheet__row-sub">{where}</span>
        </button>
        <button
          type="button"
          className={`m-sheet__row${view !== 'book' ? ' m-sheet__row--off' : ''}`}
          disabled={view !== 'book'}
          onClick={onCreateAct}
        >
          {t('bottomTimeline.act.newAct')}
          <span className="m-sheet__row-sub">
            {view === 'book' ? where : t('mobileTimeline.bookViewOnly')}
          </span>
        </button>
        <button
          type="button"
          className={`m-sheet__row${view !== 'narrative' ? ' m-sheet__row--off' : ''}`}
          disabled={view !== 'narrative'}
          onClick={onCreateMarker}
        >
          {t('mobileTimeline.createMarker')}
          <span className="m-sheet__row-sub">
            {view === 'narrative' ? where : t('mobileTimeline.narrativeViewOnly')}
          </span>
        </button>
      </div>
    </MobileToolSheet>
  );
}
