import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { BrushIcon } from '../../../components/ui/BrushIcon';
import { KindMark } from '../../../components/ui/KindMark';
import { kindMarkOfTarget } from '../../../components/ui/kind-mark';
import { isDrift } from '../../../domain/book-node';
import { ENTITY_MARK, entityRefName } from '../../../features/agent/entity-ref-name';
import { useWorkspaceNavigator } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import { useDataStore } from '../../../store/data-store';
import type { StoredCheckinCard } from '../../../store/project-checkin-store';
import type { OrganizeRun, OrganizeRunEntity } from '../../../store/project-organize-store';
import { describeOrganizeCounts } from '../../../usecase/useProjectOrganize';
import type { WorkspaceEntityType } from '../../../features/workspace/navigation/workspace-target';
import type { HomeAgentModel } from './useHomeAgent';

function CardMark({ card }: { card: StoredCheckinCard }) {
  const node = useDataStore((state) =>
    card.target?.entityType === 'node'
      ? state.bookNodes.find((candidate) => candidate.id === card.target?.entityId)
      : undefined,
  );
  if (!card.target) return <BrushIcon name="shikigami" size={12} />;
  const kind = kindMarkOfTarget(card.target.entityType as WorkspaceEntityType, node ? isDrift(node) : false);
  return <KindMark kind={kind} seed={card.target.entityId} />;
}

const MAX_ORGANIZE_CHIPS = 16;

/** The Agent's closing reply without Markdown emphasis, heading or link marks. */
function plainSummary(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\*\*|__|`/gu, '')
    .replace(/^#{1,6}\s*/gmu, '')
    .trim();
}

function organizeDocuments(run: OrganizeRun): string {
  const shown = run.documents.slice(0, 3).filter(Boolean).join(' · ');
  return run.documents.length > 3 ? `${shown} …` : shown;
}

function OrganizeChip({ entity }: { entity: OrganizeRunEntity }) {
  const { t } = useTranslation();
  const deleted = t('common.deleted_paren');
  const name = useDataStore((state) => entityRefName(state, entity, deleted));
  const { open } = useWorkspaceNavigator();
  return (
    <button
      type="button"
      className="home-agent__chip glass glass--surface glass--small"
      onClick={() => open({ entityType: entity.entityType, id: entity.id })}
    >
      <KindMark kind={ENTITY_MARK[entity.entityType]} seed={entity.id} />
      <span>{name}</span>
      <span className="home-agent__chip-op">
        {entity.op === 'create' ? t('agentPanel.entity.created') : t('agentPanel.entity.edited')}
      </span>
    </button>
  );
}

/** The latest organize pass over what the author wrote last time. */
function OrganizeCard({ agent }: { agent: HomeAgentModel }) {
  const { t } = useTranslation();
  const run = agent.organize;
  if (!run) return null;
  const running = run.status === 'running';
  const detail =
    run.status === 'completed'
      ? plainSummary(run.summary) || describeOrganizeCounts(run.counts)
      : run.status === 'failed'
        ? (run.error ?? '')
        : '';
  return (
    <article
      className="home-agent__card home-agent__organize glass glass--rest glass--surface"
      data-debug-id="project-home-organize"
    >
      <button
        type="button"
        className="home-agent__card-open"
        disabled={agent.busyCard !== null}
        onClick={() => void agent.openOrganize()}
      >
        <span className="home-agent__card-target">
          {running ? (
            <BrushIcon name="loader" size={12} className="ui-spin" />
          ) : (
            <BrushIcon name="shikigami" size={12} />
          )}
          {organizeDocuments(run)}
        </span>
        <span className="home-agent__card-title">{t(`organize.notify.${run.status}`)}</span>
        {detail && <span className="home-agent__card-detail home-agent__organize-summary">{detail}</span>}
        <span className="home-agent__card-go">{t('projectAgent.openConversation')}</span>
      </button>
      {run.entities.length > 0 && (
        <div className="home-agent__chips">
          {run.entities.slice(0, MAX_ORGANIZE_CHIPS).map((entity) => (
            <OrganizeChip key={`${entity.entityType}:${entity.id}`} entity={entity} />
          ))}
        </div>
      )}
      {agent.organizeError && (
        <p className="home-agent__notice is-error" role="alert">
          {t('projectAgent.startFailed', { error: agent.organizeError })}
        </p>
      )}
      {!running && (
        <button
          type="button"
          className="home-agent__dismiss"
          aria-label={t('projectAgent.dismiss')}
          title={t('projectAgent.dismiss')}
          onClick={agent.dismissOrganize}
        >
          <BrushIcon name="close" size={12} />
        </button>
      )}
    </article>
  );
}

function Composer({
  agent,
  inputRef,
  showHint,
}: {
  agent: HomeAgentModel;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  showHint: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="ui-field ui-field--area glass glass--rest glass--field home-agent__composer">
      <textarea
        ref={inputRef}
        value={agent.draft}
        rows={2}
        placeholder={t('projectHome.agent.placeholder')}
        aria-label={t('projectHome.agent.placeholder')}
        onChange={(event) => agent.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void agent.send();
          }
        }}
      />
      <span className="home-agent__composer-foot">
        {showHint && <span className="home-agent__hint">⌘↵</span>}
        <button
          type="button"
          className="home-agent__send glass glass--primary glass--round"
          aria-label={t('projectAgent.send')}
          title={t('projectAgent.send')}
          disabled={!agent.draft.trim() || agent.sending}
          onClick={() => void agent.send()}
        >
          <BrushIcon name="lift" size={14} />
        </button>
      </span>
    </div>
  );
}

/** In the page: a header with the check-in's state, whole cards, the box. */
export function HomeAgentFlow({
  agent,
  inputRef,
  onOpenMemory,
}: {
  agent: HomeAgentModel;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onOpenMemory: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { record, running, enabled } = agent;
  const lastCheckin = record.lastCheckinAt
    ? new Date(record.lastCheckinAt).toLocaleString(i18n.language, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  const status = running
    ? t('projectAgent.checkinRunning')
    : !enabled
      ? t('projectAgent.disabled')
      : lastCheckin
        ? t('projectAgent.lastCheckin', { time: lastCheckin })
        : '';

  return (
    <div className="home-agent" data-debug-id="project-agent-home">
      <div className="dash-sec__head">
        <BrushIcon name="shikigami" size={15} />
        <h2 className="dash-sec__title">{t('projectAgent.title')}</h2>
        <span className="dash-sec__spacer" />
        {running && <BrushIcon name="loader" size={12} className="ui-spin" />}
        {status && <span className="dash-ro">{status}</span>}
        {enabled && !running && (
          <button type="button" className="dash-text-button" onClick={agent.runNow}>
            {t('projectAgent.checkNow')}
          </button>
        )}
        <button type="button" className="dash-text-button" onClick={onOpenMemory}>
          <BrushIcon name="knots" size={13} inline />
          {t('projectMemory.title')}
        </button>
      </div>

      {record.error && !running && (
        <p className="home-agent__notice is-error" role="alert">
          {t('projectAgent.checkinFailed', { error: record.error })}
        </p>
      )}

      <OrganizeCard agent={agent} />

      {record.cards.length > 0 && (
        <div className="home-agent__cards">
          {record.cards.map((card) => (
            <article key={card.id} className="home-agent__card glass glass--rest glass--surface">
              <button
                type="button"
                className="home-agent__card-open"
                disabled={agent.busyCard !== null}
                onClick={() => void agent.act(card)}
              >
                {card.target && (
                  <span className="home-agent__card-target">
                    <CardMark card={card} />
                    {card.target.title}
                  </span>
                )}
                <span className="home-agent__card-title">{card.title}</span>
                {card.detail && <span className="home-agent__card-detail">{card.detail}</span>}
                <span className="home-agent__card-go">
                  {card.status === 'started' ? t('projectAgent.openConversation') : t('projectAgent.start')}
                </span>
              </button>
              {agent.cardError?.id === card.id && (
                <p className="home-agent__notice is-error" role="alert">
                  {t('projectAgent.startFailed', { error: agent.cardError.message })}
                </p>
              )}
              <button
                type="button"
                className="home-agent__dismiss"
                aria-label={t('projectAgent.dismiss')}
                title={t('projectAgent.dismiss')}
                onClick={() => agent.dismiss(card.id)}
              >
                <BrushIcon name="close" size={12} />
              </button>
            </article>
          ))}
        </div>
      )}

      <Composer agent={agent} inputRef={inputRef} showHint />
    </div>
  );
}

/** Floating at the foot of the page: one short pill per card, then the box. */
export function HomeAgentFloat({
  agent,
  inputRef,
}: {
  agent: HomeAgentModel;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useTranslation();
  const organize = agent.organize;
  return (
    <div className="home-agent home-agent--float">
      {(agent.record.cards.length > 0 || organize) && (
        <div className="home-agent__minis">
          {organize && (
            <div className="home-agent__mini glass glass--rest glass--surface glass--small">
              <button
                type="button"
                className="home-agent__mini-open"
                title={t(`organize.notify.${organize.status}`)}
                disabled={agent.busyCard !== null}
                onClick={() => void agent.openOrganize()}
              >
                {organize.status === 'running' ? (
                  <BrushIcon name="loader" size={12} className="ui-spin" />
                ) : (
                  <BrushIcon name="shikigami" size={12} />
                )}
                <span className="home-agent__mini-title">{t(`organize.notify.${organize.status}`)}</span>
              </button>
              {organize.status !== 'running' && (
                <button
                  type="button"
                  className="home-agent__dismiss"
                  aria-label={t('projectAgent.dismiss')}
                  title={t('projectAgent.dismiss')}
                  onClick={agent.dismissOrganize}
                >
                  <BrushIcon name="close" size={12} />
                </button>
              )}
            </div>
          )}
          {agent.record.cards.map((card) => (
            <div key={card.id} className="home-agent__mini glass glass--rest glass--surface glass--small">
              <button
                type="button"
                className="home-agent__mini-open"
                title={card.title}
                disabled={agent.busyCard !== null}
                onClick={() => void agent.act(card)}
              >
                <CardMark card={card} />
                {card.target && <span className="home-agent__mini-target">{card.target.title}</span>}
                <span className="home-agent__mini-title">{card.title}</span>
              </button>
              <button
                type="button"
                className="home-agent__dismiss"
                aria-label={t('projectAgent.dismiss')}
                title={t('projectAgent.dismiss')}
                onClick={() => agent.dismiss(card.id)}
              >
                <BrushIcon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <Composer agent={agent} inputRef={inputRef} showHint={false} />
    </div>
  );
}
