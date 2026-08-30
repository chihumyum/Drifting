import { Loader2, Mic, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buildVoiceContextPackFromStores } from '../../lib/speech/voice-context-pack';
import { useProjectStore } from '../../store/project-store';
import { useVoiceCaptureStore } from '../../store/voice-capture-store';

/**
 * Composer mic — one shared control for the desktop composer and the mobile
 * Agent panel. Tap to record, tap again to stop; the transcript (biased by
 * the project's proper nouns) lands in the shared composer prompt, so the
 * author reviews before sending. `onNeedsSetup` fires when no transcription
 * key is configured, letting each surface route to its own settings entry.
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
  const startRecording = useVoiceCaptureStore((state) => state.startRecording);
  const stopRecording = useVoiceCaptureStore((state) => state.stopRecording);
  const projectName = useProjectStore((state) => state.currentProject?.name) ?? '';

  const handleClick = async () => {
    if (phase === 'recording') {
      await stopRecording();
      return;
    }
    await startRecording({
      context: buildVoiceContextPackFromStores({ projectId, projectName }),
    });
    if (useVoiceCaptureStore.getState().errorKey === 'voiceAgent.error.noKey') {
      onNeedsSetup();
    }
  };

  const title =
    phase === 'recording'
      ? t('voiceAgent.stopRecord')
      : phase === 'transcribing'
        ? t('voiceAgent.transcribing')
        : errorKey
          ? t(errorKey)
          : t('voiceAgent.record');

  return (
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
  );
}
