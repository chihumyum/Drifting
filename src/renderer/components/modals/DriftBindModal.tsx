/**
 * DriftBindModal — picker for binding a drift node to a timeline marker or an
 * act (its 大纲/notes). Self-mounting (rendered once in App's modal layer):
 * listens for `drift-bind:open` and performs the bind itself, so the marker
 * pin / act band context menus only need to emit an event instead of hosting
 * a cramped inline submenu.
 *
 * Available drifts = drift nodes not already bound by ANY marker or act
 * (binding is exclusive — one drift, one anchor). Picking one binds + closes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { events } from '../../lib/events';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useTimelineMarkers } from '../../hooks/useTimelineMarkers';
import { useBookAct } from '../../usecase/useBookAct';
import { isDrift } from '../../domain/book-node';
import { actBoundDriftIds } from '../../domain/book-act';
import { BrushIcon } from '../ui/BrushIcon';
import { EmptyState } from '../ui/EmptyState';
import { KindMark } from '../ui/KindMark';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

type Target = { kind: 'marker' | 'act'; id: string };

export function DriftBindModal() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Target | null>(null);
  const [query, setQuery] = useState('');
  const { projectId } = useProjectNavigation();

  const bookNodes = useDataStore((s) => s.bookNodes);
  const bookActs = useDataStore((s) => s.bookActs);
  const { markers, updateMarker, boundDriftIds } = useTimelineMarkers(projectId);
  const { bindDrift } = useBookAct({ projectId: projectId ?? '' });

  useEffect(() => {
    const handler = (payload: { target: Target }) => {
      setTarget(payload.target);
      setQuery('');
    };
    events.on('drift-bind:open', handler);
    return () => events.off('drift-bind:open', handler);
  }, []);

  const close = useCallback(() => setTarget(null), []);

  // Drifts free to bind: drift kind, not already anchored by a marker or act.
  const options = useMemo(() => {
    const bound = new Set(boundDriftIds);
    for (const id of actBoundDriftIds(bookActs)) bound.add(id);
    const q = query.trim().toLowerCase();
    return bookNodes
      .filter(isDrift)
      .filter((n) => !bound.has(n.id))
      .filter((n) => !q || (n.title || '').toLowerCase().includes(q) || (n.summary || '').toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [bookNodes, bookActs, boundDriftIds, query]);

  const pick = useCallback(
    (driftNodeId: string) => {
      if (!target) return;
      if (target.kind === 'marker') {
        // Binding a previously label-only marker: the pin's caption now comes
        // from the drift's title, so the old free-text label is irrelevant.
        const m = markers.find((mk) => mk.id === target.id);
        if (m) updateMarker(target.id, { driftNodeId });
      } else {
        void bindDrift(target.id, driftNodeId);
      }
      close();
    },
    [target, markers, updateMarker, bindDrift, close],
  );

  if (!target) return null;

  return (
    <ModalRoot onClose={close} ariaLabel={t('driftBind.title')}>
      <ModalCard className="drift-bind-modal" width={460}>
        <ModalHeader
          kicker={t('driftBind.title')}
          title={
            target.kind === 'marker'
              ? t('driftBind.markerSubtitle')
              : t('driftBind.actSubtitle')
          }
          onClose={close}
          closeLabel={t('common.close')}
        />
        <ModalBody className="drift-bind-modal__body">
          <label className="ui-field glass glass--rest glass--field glass--small">
            <BrushIcon name="search" size={15} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('driftBind.searchPlaceholder')}
            />
          </label>
          <div className="drift-bind-modal__list">
            {options.length === 0 ? (
              <EmptyState
                density="compact"
                mark="drift"
                message={query.trim() ? t('driftBind.noMatches') : t('driftBind.empty')}
              />
            ) : (
              options.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => pick(n.id)}
                  className="menu-surface__item drift-bind-modal__option"
                >
                  <KindMark kind="drift" />
                  <span className="drift-bind-modal__text">
                    <span className="drift-bind-modal__title">{n.title || t('common.untitled')}</span>
                    {n.summary && <span className="drift-bind-modal__summary">{n.summary}</span>}
                  </span>
                </button>
              ))
            )}
          </div>
        </ModalBody>
      </ModalCard>
    </ModalRoot>
  );
}
