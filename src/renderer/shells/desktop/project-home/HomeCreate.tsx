import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { BrushIcon } from '../../../components/ui/BrushIcon';
import { KindMark } from '../../../components/ui/KindMark';
import type { KindMarkKind } from '../../../components/ui/kind-mark';
import type { HomeCreateKind } from './home-create';
import type { HomeCreateEntry, HomeCreateModel } from './useHomeCreate';

const MARK_OF: Record<HomeCreateKind, KindMarkKind> = {
  chapter: 'chapter',
  drift: 'drift',
  element: 'element',
  storyline: 'storyline',
  category: 'category',
  material: 'material',
};

function Mark({ kind, busy, size }: { kind: HomeCreateKind; busy: boolean; size: number }) {
  return busy ? (
    <BrushIcon name="loader" size={size} className="ui-spin" />
  ) : (
    <KindMark kind={MARK_OF[kind]} seed="project-home" />
  );
}

function Picks({ entry, model }: { entry: HomeCreateEntry; model: HomeCreateModel }) {
  if (!entry.picks) return null;
  return (
    <div className="home-create__picks" role="group" aria-label={entry.picksLabel}>
      {entry.picks.map((pick) => {
        const busy = model.busyKey === pick.key;
        return (
          <button
            key={pick.key}
            type="button"
            className={`home-create__pick glass glass--rest glass--small${pick.accent ? ' is-accent' : ''}`}
            style={pick.color ? ({ '--glass-cc': pick.color } as CSSProperties) : undefined}
            disabled={model.busyKey !== null}
            aria-busy={busy || undefined}
            onClick={pick.run}
          >
            {busy ? (
              <BrushIcon name="loader" size={12} className="ui-spin" />
            ) : pick.mark ? (
              <KindMark kind={pick.mark.kind} color={pick.mark.color} hollow={pick.mark.hollow} />
            ) : pick.icon ? (
              <BrushIcon name={pick.icon} size={12} />
            ) : null}
            {pick.label}
          </button>
        );
      })}
    </div>
  );
}

function Slot({
  entry,
  model,
  children,
}: {
  entry: HomeCreateEntry;
  model: HomeCreateModel;
  children: ReactNode;
}) {
  return (
    <div
      className={`home-create__slot${model.openKind === entry.kind ? ' is-open' : ''}`}
      data-kind={entry.kind}
      onPointerLeave={() => {
        if (model.openKind === entry.kind) model.setOpenKind(null);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !entry.picks) return;
        model.setOpenKind(null);
        event.currentTarget.querySelector<HTMLButtonElement>('[data-home-kind]')?.focus();
      }}
    >
      {children}
      <Picks entry={entry} model={model} />
    </div>
  );
}

function activate(entry: HomeCreateEntry, model: HomeCreateModel) {
  if (entry.picks) model.setOpenKind(model.openKind === entry.kind ? null : entry.kind);
  else entry.create();
}

function CreateError({ model }: { model: HomeCreateModel }) {
  const { t } = useTranslation();
  if (!model.error) return null;
  return (
    <p className="home-create__error" role="alert">
      <BrushIcon name="status-warning" size={13} inline />
      {t('projectHome.create.failed', { error: model.error })}
    </p>
  );
}

/** In the page: six sand cells, the mark above the name. */
export function HomeCreateTiles({ model }: { model: HomeCreateModel }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="home-create home-create--tiles" role="group" aria-label={t('projectHome.create.title')}>
        {model.entries.map((entry) => (
          <Slot key={entry.kind} entry={entry} model={model}>
            <button
              type="button"
              data-home-kind
              className="sand-cell home-create__tile"
              aria-haspopup={entry.picks ? 'true' : undefined}
              aria-expanded={entry.picks ? model.openKind === entry.kind : undefined}
              aria-busy={model.busyKey === entry.kind || undefined}
              disabled={model.busyKey !== null && !entry.picks}
              onClick={() => activate(entry, model)}
            >
              <span className="home-create__mark">
                <Mark kind={entry.kind} busy={model.busyKey === entry.kind} size={16} />
              </span>
              <span className="home-create__name">{entry.label}</span>
              <i className="cell-ring" aria-hidden="true" />
            </button>
          </Slot>
        ))}
      </div>
      <CreateError model={model} />
    </>
  );
}

/**
 * Floating at the foot of the page after the dock's +: one round glass per
 * kind holding only its mark; the name comes up faintly under the one the
 * pointer is on.
 */
export function HomeCreateFloat({ model }: { model: HomeCreateModel }) {
  const { t } = useTranslation();
  return (
    <>
      <CreateError model={model} />
      <div className="home-create home-create--float" role="group" aria-label={t('projectHome.create.title')}>
        {model.entries.map((entry) => (
          <Slot key={entry.kind} entry={entry} model={model}>
            <button
              type="button"
              data-home-kind
              className="home-create__orb glass glass--rest glass--round"
              aria-label={entry.label}
              aria-haspopup={entry.picks ? 'true' : undefined}
              aria-expanded={entry.picks ? model.openKind === entry.kind : undefined}
              aria-busy={model.busyKey === entry.kind || undefined}
              disabled={model.busyKey !== null && !entry.picks}
              onClick={() => activate(entry, model)}
            >
              <Mark kind={entry.kind} busy={model.busyKey === entry.kind} size={15} />
            </button>
            <span className="home-create__label" aria-hidden="true">{entry.label}</span>
          </Slot>
        ))}
      </div>
    </>
  );
}
