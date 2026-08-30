import { Loader2, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVoiceCaptureStore } from '../../../store/voice-capture-store';

/**
 * Floating voice pill — the collapsed state of a live voice session. It sits
 * above every workspace surface so the author can keep speaking (or keep an
 * eye on transcription) while reading their material; tapping it expands the
 * fullscreen voice face.
 */
export function MobileVoicePill({ onExpand }: { onExpand(): void }) {
  const { t } = useTranslation();
  const phase = useVoiceCaptureStore((state) => state.phase);
  return (
    <button
      type="button"
      className="m-voice-pill"
      data-state={phase}
      onClick={onExpand}
      aria-label={t('voiceAgent.expand')}
    >
      {phase === 'transcribing' ? (
        <Loader2 size={20} aria-hidden="true" className="agt-mic__spin" />
      ) : (
        <Mic size={20} aria-hidden="true" />
      )}
      {phase === 'recording' && <span className="m-voice-pill__dot" aria-hidden="true" />}
    </button>
  );
}
