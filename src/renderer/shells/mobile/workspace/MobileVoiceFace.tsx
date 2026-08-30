import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Loader2, Mic, Square, X } from 'lucide-react';
import {
  MessageView,
  PendingRow,
  RuntimeControlCard,
  STREAM_FOLLOW_BOTTOM_THRESHOLD_PX,
} from '../../../features/agent/AgentMessageViews';
import { AgentComposerConfig } from '../../../features/agent/AgentComposerConfig';
import { useAutosizeTextArea } from '../../../hooks/useAutosizeTextArea';
import { useWorkspaceNavigator } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import type { GeneralAgentAuthStatus } from '../../../lib/agent/protocol';
import { generalAgentTransport } from '../../../lib/agent/transport';
import { events } from '../../../lib/events';
import { scrollToBlockWhenReady } from '../../../lib/scroll-to-block';
import { buildVoiceContextPackFromStores } from '../../../lib/speech/voice-context-pack';
import {
  selectControlStatus,
  selectMessages,
  selectPendingControl,
  selectRunning,
  useAgentChatStore,
} from '../../../store/agent-chat-store';
import { useDataStore } from '../../../store/data-store';
import { useProjectStore } from '../../../store/project-store';
import { useSettingsStore } from '../../../store/settings-store';
import { useVoiceCaptureStore } from '../../../store/voice-capture-store';
import {
  buildMobileAgentTurnContext,
  collectMobileAgentEvidence,
  openMobileAgentEvidence,
  type MobileAgentEvidenceRef,
} from './mobile-agent-model';
import { requestMobileWorkspaceBack } from './mobile-workspace-back';

function voiceEvidenceLabel(evidence: MobileAgentEvidenceRef, deletedLabel: string): string {
  const data = useDataStore.getState();
  const label =
    evidence.entityType === 'node'
      ? data.bookNodes.find((item) => item.id === evidence.entityId)?.title
      : evidence.entityType === 'element'
        ? data.bookElements.find((item) => item.id === evidence.entityId)?.name
        : evidence.entityType === 'storyline'
          ? data.storylines.find((item) => item.id === evidence.entityId)?.name
          : data.bookElementCategories.find((item) => item.id === evidence.entityId)?.name;
  return label || deletedLabel;
}

function formatElapsed(fromMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Fullscreen voice-Agent surface — the expanded state of the voice session.
 * Speak, watch the transcript land in the composer, send it to the
 * read-write Agent, and follow what changed through the evidence links.
 * Collapsing (Back or the chevron) keeps the session alive as the floating
 * pill; ✕ ends the session.
 */
export function MobileVoiceFace({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = generalAgentTransport;
  const navigate = useNavigate();
  const location = useLocation();
  const projectName =
    useProjectStore((state) => state.currentProject?.name) ?? t('agentPanel.mobile.currentProject');
  const agentAuth = useSettingsStore((state) => state.agentAuth);
  const messages = useAgentChatStore(selectMessages);
  const prompt = useAgentChatStore((state) => state.prompt);
  const running = useAgentChatStore(selectRunning);
  const starting = useAgentChatStore((state) => state.starting);
  const pendingControl = useAgentChatStore(selectPendingControl);
  const controlStatus = useAgentChatStore(selectControlStatus);
  const setPrompt = useAgentChatStore((state) => state.setPrompt);
  const send = useAgentChatStore((state) => state.send);
  const abort = useAgentChatStore((state) => state.abort);
  const respondPermission = useAgentChatStore((state) => state.respondPermission);
  const cancelRecoveredControl = useAgentChatStore((state) => state.cancelRecoveredControl);
  const bindProject = useAgentChatStore((state) => state.bindProject);
  const { open } = useWorkspaceNavigator();

  const phase = useVoiceCaptureStore((state) => state.phase);
  const errorKey = useVoiceCaptureStore((state) => state.errorKey);
  const failedSegments = useVoiceCaptureStore((state) => state.failedSegments);
  const recordingStartedAt = useVoiceCaptureStore((state) => state.recordingStartedAt);
  const startRecording = useVoiceCaptureStore((state) => state.startRecording);
  const stopRecording = useVoiceCaptureStore((state) => state.stopRecording);
  const retryTranscription = useVoiceCaptureStore((state) => state.retryTranscription);
  const closeSession = useVoiceCaptureStore((state) => state.closeSession);

  const [status, setStatus] = useState<GeneralAgentAuthStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const textAreaRef = useAutosizeTextArea(prompt);

  const turnContext = useMemo(
    () =>
      buildMobileAgentTurnContext({
        projectId,
        projectName,
        target: null,
        targetLabel: t('agentPanel.mobile.target.dashboard'),
      }),
    [projectId, projectName, t],
  );
  const evidence = useMemo(() => collectMobileAgentEvidence(messages), [messages]);

  useEffect(() => bindProject(projectId), [bindProject, projectId]);
  useEffect(() => {
    const refresh = () => {
      if (!api.capability.available) {
        setStatus({ byokConnected: false, apiKeyConnected: false, hostedAvailable: false });
        return;
      }
      void api.authStatus().then(
        (result) =>
          setStatus(
            result.ok
              ? result.value
              : { byokConnected: false, apiKeyConnected: false, hostedAvailable: false },
          ),
        () => setStatus({ byokConnected: false, apiKeyConnected: false, hostedAvailable: false }),
      );
    };
    refresh();
    events.on('agent:auth-changed', refresh);
    return () => events.off('agent:auth-changed', refresh);
  }, [api]);
  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    if (stickRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [controlStatus, messages, pendingControl]);

  const usable =
    status !== null &&
    (agentAuth === 'hosted'
      ? status.hostedAvailable
      : agentAuth === 'apikey'
        ? status.apiKeyConnected
        : status.byokConnected);
  const lastMessage = messages[messages.length - 1];
  const waiting =
    (running || starting) &&
    !pendingControl &&
    !(
      lastMessage &&
      ((lastMessage.kind === 'assistant' && lastMessage.streaming) ||
        (lastMessage.kind === 'thinking' && lastMessage.streaming) ||
        (lastMessage.kind === 'tool' && lastMessage.status === 'running'))
    );

  const handleToggleRecording = async () => {
    if (phase === 'recording') {
      await stopRecording();
      return;
    }
    await startRecording({
      context: buildVoiceContextPackFromStores({ projectId, projectName }),
    });
  };

  const handleSend = () => {
    stickRef.current = true;
    void send({ turnContext, toolAccess: 'read_write' });
  };

  const micStatus =
    phase === 'recording' && recordingStartedAt !== null
      ? `${t('voiceAgent.recording')} · ${formatElapsed(recordingStartedAt, now)}`
      : phase === 'transcribing'
        ? t('voiceAgent.transcribing')
        : errorKey
          ? t(errorKey)
          : t('voiceAgent.hint');

  return (
    <div className="m-voice-face" role="dialog" aria-modal="true" aria-label={t('voiceAgent.title')}>
      <header className="m-voice-face__header">
        <button
          type="button"
          className="m-voice-face__chrome"
          onClick={() => requestMobileWorkspaceBack('visible')}
          aria-label={t('voiceAgent.collapse')}
        >
          <ChevronDown size={20} aria-hidden="true" />
        </button>
        <strong className="m-voice-face__title">{t('voiceAgent.title')}</strong>
        <span className="m-voice-face__spacer" />
        <button
          type="button"
          className="m-voice-face__chrome"
          onClick={() => {
            void closeSession();
            requestMobileWorkspaceBack('visible');
          }}
          aria-label={t('voiceAgent.endSession')}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="m-voice-face__pane m-agent" data-mobile-agent="voice">
        {!usable && status !== null && (
          <div className="m-agent__provider-state" data-state="error">
            <span>
              {api.capability.available
                ? t('agentPanel.setup.title')
                : t('agentPanel.unavailableTitle')}
            </span>
            <button
              type="button"
              onClick={() => navigate('/settings', { state: { from: location.pathname } })}
            >
              {t('agentPanel.setup.openSettings')}
            </button>
          </div>
        )}

        <div className="m-agent__log-wrap">
          <div
            ref={logRef}
            className="m-agent__log"
            onScroll={(event) => {
              const element = event.currentTarget;
              stickRef.current =
                element.scrollHeight - element.scrollTop - element.clientHeight <
                STREAM_FOLLOW_BOTTOM_THRESHOLD_PX;
            }}
          >
            {messages.length === 0 && <div className="m-tool-empty">{t('voiceAgent.empty')}</div>}
            {messages.map((message, index) => (
              <div key={index} className="m-agent__message" data-kind={message.kind}>
                <MessageView msg={message} />
              </div>
            ))}
            {waiting && <PendingRow status={controlStatus} />}
            {pendingControl && (
              <RuntimeControlCard
                pending={pendingControl}
                onPermission={(decision, scope) => void respondPermission(decision, scope)}
                onCancelRecovered={() => void cancelRecoveredControl()}
              />
            )}
            {evidence.length > 0 && (
              <section className="m-agent-evidence" aria-label={t('agentPanel.mobile.evidenceAria')}>
                <strong>{t('agentPanel.mobile.evidenceTitle')}</strong>
                <div>
                  {evidence.map((item) => (
                    <button
                      key={`${item.entityType}:${item.entityId}:${item.blockId ?? ''}`}
                      type="button"
                      onClick={() =>
                        openMobileAgentEvidence(item, {
                          open,
                          scrollToBlock: scrollToBlockWhenReady,
                        })
                      }
                    >
                      {voiceEvidenceLabel(item, t('agentPanel.mobile.target.deleted'))}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>

        <div className="m-voice-face__mic-zone">
          <button
            type="button"
            className="m-voice-face__mic"
            data-state={phase}
            onClick={() => void handleToggleRecording()}
            disabled={phase === 'transcribing'}
            aria-pressed={phase === 'recording'}
            aria-label={phase === 'recording' ? t('voiceAgent.stopRecord') : t('voiceAgent.record')}
          >
            {phase === 'recording' ? (
              <Square size={24} aria-hidden="true" />
            ) : phase === 'transcribing' ? (
              <Loader2 size={26} aria-hidden="true" className="agt-mic__spin" />
            ) : (
              <Mic size={26} aria-hidden="true" />
            )}
          </button>
          <div className="m-voice-face__mic-status" role="status" data-error={errorKey ? 'true' : undefined}>
            {micStatus}
            {errorKey === 'voiceAgent.error.noKey' && (
              <button
                type="button"
                onClick={() => navigate('/settings', { state: { from: location.pathname } })}
              >
                {t('agentPanel.setup.openSettings')}
              </button>
            )}
            {failedSegments > 0 && (
              <button type="button" onClick={retryTranscription}>
                {t('voiceAgent.retry')}
              </button>
            )}
          </div>
        </div>

        <div className="m-agent__composer">
          <div className="agt-composer">
            <textarea
              ref={textAreaRef}
              className="agt-composer__text"
              value={prompt}
              rows={1}
              disabled={!usable || starting || Boolean(pendingControl?.requiresContinuation)}
              placeholder={usable ? t('voiceAgent.composerPlaceholder') : t('agentPanel.setup.title')}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <div className="agt-composer__bar">
              <AgentComposerConfig />
              <span className="agt-composer__spacer" />
              {running ? (
                <button type="button" className="agt-send agt-send--stop" onClick={abort}>
                  {t('agentPanel.composer.stop')}
                </button>
              ) : (
                <button
                  type="button"
                  className="agt-send"
                  disabled={!usable || starting || !prompt.trim()}
                  onClick={handleSend}
                >
                  {t('agentPanel.composer.send')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
