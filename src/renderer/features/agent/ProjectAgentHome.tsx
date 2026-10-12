import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  useProjectCheckinStore,
  type ProjectCheckinRecord,
  type StoredCheckinCard,
} from '../../store/project-checkin-store';
import {
  openCheckinConversation,
  startCheckinCardSession,
  startProjectHomeConversation,
  useProjectCheckin,
} from '../../usecase/useProjectCheckin';
import '../../../styles/project-agent-home.css';

/**
 * The Project Home Agent entry: a composer that opens a General Agent
 * conversation about the project, and the check-in cards the Agent prepared
 * from recent changes. Each card is a question to ask or work to do; opening
 * it starts an ordinary General Agent session with the card as its task.
 */
export function ProjectAgentHome({
  projectId,
  projectName,
  openAgent,
  compact = false,
}: {
  projectId: string;
  projectName: string;
  /** Reveal the platform's Agent surface and return its chat view id. */
  openAgent: () => string;
  compact?: boolean;
}) {
  const checkin = useProjectCheckin(projectId, projectName);
  return (
    <ProjectAgentHomeView
      projectId={projectId}
      openAgent={openAgent}
      compact={compact}
      {...checkin}
    />
  );
}

export function ProjectAgentHomeView({
  projectId,
  openAgent,
  compact,
  record,
  running,
  enabled,
  runNow,
}: {
  projectId: string;
  openAgent: () => string;
  compact: boolean;
  record: ProjectCheckinRecord;
  running: boolean;
  enabled: boolean;
  runNow: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState('');
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null);
  const [sending, setSending] = useState(false);

  const visibleCards = record.cards;

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await startProjectHomeConversation(projectId, draft, openAgent);
      setDraft('');
    } finally {
      setSending(false);
    }
  };

  const act = async (card: StoredCheckinCard) => {
    if (busyCard) return;
    setBusyCard(card.id);
    setCardError(null);
    try {
      if (card.status === 'started' && card.conversationId) {
        await openCheckinConversation(projectId, card.conversationId, openAgent);
      } else {
        await startCheckinCardSession(projectId, card, openAgent);
      }
    } catch (error) {
      setCardError({ id: card.id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyCard(null);
    }
  };

  const lastCheckin = record.lastCheckinAt
    ? new Date(record.lastCheckinAt).toLocaleString(i18n.language, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;


  return (
    <div className={`pagent${compact ? ' pagent--compact' : ''}`} data-debug-id="project-agent-home">
      <div className="pagent__composer">
        <textarea
          className="pagent__input"
          value={draft}
          rows={2}
          placeholder={t('projectAgent.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="pagent__send"
          disabled={!draft.trim() || sending}
          onClick={() => void send()}
        >
          {t('projectAgent.send')}
        </button>
      </div>

      <div className="pagent__checkin-head">
        <span className="pagent__checkin-title">{t('projectAgent.checkinTitle')}</span>
        <span className="pagent__checkin-status">
          {running
            ? t('projectAgent.checkinRunning')
            : !enabled
              ? t('projectAgent.disabled')
              : lastCheckin
                ? t('projectAgent.lastCheckin', { time: lastCheckin })
                : ''}
        </span>
        <span className="pagent__checkin-tools">
          {enabled && !running && (
            <button type="button" className="pagent__link" onClick={runNow}>
              {t('projectAgent.checkNow')}
            </button>
          )}
          <button
            type="button"
            className="pagent__link"
            onClick={() => useProjectCheckinStore.getState().setEnabled(!enabled)}
          >
            {enabled ? t('projectAgent.disable') : t('projectAgent.enable')}
          </button>
        </span>
      </div>

      {record.error && !running && (
        <div className="pagent__notice pagent__notice--error" role="alert">
          {t('projectAgent.checkinFailed', { error: record.error })}
        </div>
      )}

      {visibleCards.length === 0 ? (
        !running && (
          <div className="pagent__notice">
            {record.lastCheckinAt ? t('projectAgent.checkinEmpty') : t('projectAgent.checkinNever')}
          </div>
        )
      ) : (
        <div className="pagent__cards">
          {visibleCards.map((card) => (
            <article
              key={card.id}
              className={`pagent__card${card.status === 'started' ? ' pagent__card--started' : ''}`}
            >
              {/* The card is the action: its title is the question to ask or
                  the work to do, and opening it hands that to the Agent. */}
              <button
                type="button"
                className="pagent__card-open"
                disabled={busyCard !== null}
                title={
                  card.status === 'started'
                    ? t('projectAgent.openConversation')
                    : t('projectAgent.start')
                }
                onClick={() => void act(card)}
              >
                {card.target ? (
                  <span className="pagent__card-target">「{card.target.title}」</span>
                ) : null}
                <span className="pagent__card-title">{card.title}</span>
                {card.detail ? <span className="pagent__card-detail">{card.detail}</span> : null}
                {card.status === 'started' ? (
                  <span className="pagent__card-status">{t('projectAgent.started')}</span>
                ) : null}
              </button>
              {cardError?.id === card.id && (
                <p className="pagent__card-error" role="alert">
                  {t('projectAgent.startFailed', { error: cardError.message })}
                </p>
              )}
              <button
                type="button"
                className="pagent__card-dismiss"
                aria-label={t('projectAgent.dismiss')}
                title={t('projectAgent.dismiss')}
                onClick={() => useProjectCheckinStore.getState().dismissCard(projectId, card.id)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
