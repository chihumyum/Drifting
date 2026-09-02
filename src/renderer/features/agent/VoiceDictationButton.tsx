import { useEffect, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  buildVoiceContextPackFromStores,
  buildVoiceGlossaryFromStores,
} from '../../lib/speech/voice-context-pack';
import { useProjectStore } from '../../store/project-store';
import { useVoiceCaptureStore } from '../../store/voice-capture-store';

/** How long the "restored N proper nouns" note stays beside an idle mic. */
const CORRECTION_NOTE_MS = 8000;

function formatElapsed(fromMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Composer mic — one shared control for the desktop composer and the mobile
 * Agent panel. Tap to record, tap again to stop; the transcript (biased by
 * the project's proper nouns) lands in the shared composer prompt, so the
 * author reviews before sending. Every non-idle state is spelled out next to
 * the button: nothing about capture is visible at the OS level when it fails,
 * so a colour change alone cannot carry the message. `onNeedsSetup` fires
 * when no transcription key is configured, letting each surface route to its
 * own settings entry.
 */
export function VoiceDictationButton({
  projectId,
  onNeedsSetup,
}: {
  projectId: string;
  onNeedsSetup(): void;
}) {
  const { t } = useTranslation();
  const phase = useVoiceCaptureStore((state) => state.phase);
  const errorKey = useVoiceCaptureStore((state) => state.errorKey);
  const failedSegments = useVoiceCaptureStore((state) => state.failedSegments);
  const recordingStartedAt = useVoiceCaptureStore((state) => state.recordingStartedAt);
  const lastCorrections = useVoiceCaptureStore((state) => state.lastCorrections);
  const lastTranscriptAt = useVoiceCaptureStore((state) => state.lastTranscriptAt);
  const startRecording = useVoiceCaptureStore((state) => state.startRecording);
  const stopRecording = useVoiceCaptureStore((state) => state.stopRecording);
  const retryTranscription = useVoiceCaptureStore((state) => state.retryTranscription);
  const dismissError = useVoiceCaptureStore((state) => state.dismissError);
  const projectName = useProjectStore((state) => state.currentProject?.name) ?? '';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (phase !== 'recording') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    if (lastTranscriptAt === null) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), CORRECTION_NOTE_MS);
    return () => clearTimeout(timer);
  }, [lastTranscriptAt]);

  const handleClick = async () => {
    if (phase === 'recording') {
      await stopRecording();
      return;
    }
    await startRecording({
      context: buildVoiceContextPackFromStores({ projectId, projectName }),
      glossary: buildVoiceGlossaryFromStores(projectId),
    });
    if (useVoiceCaptureStore.getState().errorKey === 'voiceAgent.error.noKey') {
      onNeedsSetup();
    }
  };

  const statusText =
    phase === 'recording'
      ? `${t('voiceAgent.recording')}${
          recordingStartedAt !== null ? ` ${formatElapsed(recordingStartedAt, now)}` : ''
        } · ${t('voiceAgent.tapToStop')}`
      : phase === 'transcribing'
        ? t('voiceAgent.transcribing')
        : errorKey
          ? t(errorKey)
          : lastCorrections > 0 &&
              lastTranscriptAt !== null &&
              now - lastTranscriptAt < CORRECTION_NOTE_MS
            ? t('voiceAgent.corrected', { count: lastCorrections })
            : null;
  const title = statusText ?? t('voiceAgent.record');

  return (
    <>
      <button
        type="button"
        className="agt-cfg agt-mic"
        data-state={phase}
        onClick={() => void handleClick()}
        disabled={phase === 'transcribing'}
        title={title}
        aria-label={title}
        aria-pressed={phase === 'recording'}
      >
        {phase === 'recording' ? (
          <Square size={14} aria-hidden="true" />
        ) : phase === 'transcribing' ? (
          <Loader2 size={15} aria-hidden="true" className="agt-mic__spin" />
        ) : (
          <Mic size={15} aria-hidden="true" />
        )}
      </button>
      {statusText && (
        <span className="agt-mic__status" role="status" data-state={phase}>
          <span className="agt-mic__status-text">{statusText}</span>
          {errorKey === 'voiceAgent.error.noKey' && (
            <button type="button" className="agt-mic__link" onClick={onNeedsSetup}>
              {t('agentPanel.setup.openSettings')}
            </button>
          )}
          {failedSegments > 0 && (
            <button type="button" className="agt-mic__link" onClick={retryTranscription}>
              {t('voiceAgent.retry')}
            </button>
          )}
          {errorKey && (
            <button
              type="button"
              className="agt-mic__link"
              onClick={dismissError}
              aria-label={t('common.close')}
            >
              ×
            </button>
          )}
        </span>
      )}
    </>
  );
}
