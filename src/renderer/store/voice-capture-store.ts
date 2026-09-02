/**
 * Voice capture — module-level pipeline state for spoken input. One recording
 * pipeline serves every surface (mobile voice face, mobile Agent panel,
 * desktop composer): segments stream through transcription in order and land
 * in the shared Agent composer prompt, so a capture survives collapsing the
 * voice face or switching surfaces mid-sentence.
 *
 * `sessionProjectId` additionally drives the mobile floating pill: non-null
 * means a voice session is live above the workspace.
 *
 * The transcript is appended to the Agent prompt as each segment resolves —
 * the capture is never held hostage by a failed later segment; failed
 * segments stay queued for retry.
 */

import { create } from 'zustand';
import {
  createDashScopeTranscriptionProvider,
} from '../lib/speech/dashscope-transcription';
import { correctTranscriptByPinyin } from '../lib/speech/pinyin-correction';
import { speechKeychain } from '../lib/speech/speech-credentials';
import {
  SpeechTranscriptionError,
  type SpeechTranscriptionProvider,
} from '../lib/speech/transcription';
import {
  VoiceRecorder,
  isVoiceRecordingSupported,
  type VoiceRecorderSegment,
} from '../lib/speech/voice-recorder';
import { useAgentChatStore } from './agent-chat-store';

export type VoiceCapturePhase = 'idle' | 'recording' | 'transcribing' | 'error';

export interface VoiceCaptureState {
  /** Mobile voice session; the floating pill renders while non-null. */
  sessionProjectId: string | null;
  phase: VoiceCapturePhase;
  recordingStartedAt: number | null;
  /** i18n key under `voiceAgent.error.*`; null when healthy. */
  errorKey: string | null;
  pendingSegments: number;
  failedSegments: number;
  /** Proper nouns restored by the pinyin layer since recording started. */
  lastCorrections: number;
  lastTranscriptAt: number | null;

  openSession(projectId: string): void;
  closeSession(): Promise<void>;
  startRecording(input: { context: string; glossary?: readonly string[] }): Promise<void>;
  stopRecording(): Promise<void>;
  retryTranscription(): void;
  dismissError(): void;
}

const recorder = new VoiceRecorder();
let provider: SpeechTranscriptionProvider | null = null;
let captureContext = '';
let captureGlossary: readonly string[] = [];
let queue: Promise<void> = Promise.resolve();
const failed: VoiceRecorderSegment[] = [];

function appendToAgentPrompt(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const chat = useAgentChatStore.getState();
  const current = chat.prompt;
  chat.setPrompt(current.trim() ? `${current.replace(/\s+$/u, '')}\n${trimmed}` : trimmed);
}

function errorKeyFor(error: unknown): string {
  if (error instanceof SpeechTranscriptionError) {
    if (error.kind === 'auth') return 'voiceAgent.error.auth';
    if (error.kind === 'invalid-input') return 'voiceAgent.error.segmentRejected';
    return 'voiceAgent.error.transcribeFailed';
  }
  return 'voiceAgent.error.transcribeFailed';
}

/**
 * Every failure of the capture pipeline is invisible at the OS level (no
 * permission prompt, no recording indicator), so the underlying cause is
 * logged for devtools alongside the i18n key the UI shows.
 */
function reportVoiceFailure(stage: string, errorKey: string, cause?: unknown): void {
  const detail =
    cause instanceof Error ? `${cause.name}: ${cause.message}` : cause === undefined ? '' : String(cause);
  console.warn(`[voice-capture] ${stage} failed → ${errorKey}${detail ? ` (${detail})` : ''}`);
}

export const useVoiceCaptureStore = create<VoiceCaptureState>((set, get) => {
  const settle = () => {
    set((state) => {
      if (state.phase === 'recording') return state;
      if (state.pendingSegments > 0) return state;
      if (state.errorKey) return { ...state, phase: 'error' };
      provider = null;
      return { ...state, phase: 'idle' };
    });
  };

  const enqueue = (segment: VoiceRecorderSegment) => {
    set((state) => ({ ...state, pendingSegments: state.pendingSegments + 1 }));
    queue = queue.then(async () => {
      try {
        const active = provider;
        if (!active) throw new SpeechTranscriptionError('auth', 'No transcription provider');
        const text = await active.transcribe({
          audio: segment.blob,
          mimeType: segment.mimeType,
          context: captureContext,
        });
        // The raw transcript is never held hostage by the correction layer.
        let restored = { text, corrections: [] as { from: string; to: string }[] };
        try {
          restored = await correctTranscriptByPinyin(text, captureGlossary);
        } catch (error) {
          reportVoiceFailure('pinyin correction', 'skipped', error);
        }
        if (restored.corrections.length > 0) {
          console.info('[voice-capture] restored proper nouns', restored.corrections);
        }
        appendToAgentPrompt(restored.text);
        set((state) => ({
          ...state,
          lastCorrections: state.lastCorrections + restored.corrections.length,
          lastTranscriptAt: Date.now(),
        }));
      } catch (error) {
        failed.push(segment);
        const errorKey = errorKeyFor(error);
        reportVoiceFailure('transcription', errorKey, error);
        set((state) => ({
          ...state,
          errorKey,
          failedSegments: failed.length,
        }));
      } finally {
        set((state) => ({ ...state, pendingSegments: state.pendingSegments - 1 }));
        settle();
      }
    });
  };

  return {
    sessionProjectId: null,
    phase: 'idle',
    recordingStartedAt: null,
    errorKey: null,
    pendingSegments: 0,
    failedSegments: 0,
    lastCorrections: 0,
    lastTranscriptAt: null,

    openSession: (projectId) => set({ sessionProjectId: projectId }),

    closeSession: async () => {
      if (get().phase === 'recording') await get().stopRecording();
      set({ sessionProjectId: null });
    },

    startRecording: async ({ context, glossary }) => {
      const state = get();
      if (state.phase === 'recording') return;
      if (!isVoiceRecordingSupported()) {
        reportVoiceFailure(
          'support check',
          'voiceAgent.error.unsupported',
          `MediaRecorder=${typeof MediaRecorder}, navigator.mediaDevices=${typeof navigator.mediaDevices}, isSecureContext=${String(globalThis.isSecureContext)}`,
        );
        set({ phase: 'error', errorKey: 'voiceAgent.error.unsupported' });
        return;
      }
      let apiKey: string | null = null;
      try {
        apiKey = await speechKeychain.get();
      } catch (error) {
        reportVoiceFailure('keychain read', 'voiceAgent.error.noKey', error);
        apiKey = null;
      }
      if (!apiKey) {
        set({ phase: 'error', errorKey: 'voiceAgent.error.noKey' });
        return;
      }
      provider = createDashScopeTranscriptionProvider({ apiKey });
      captureContext = context;
      captureGlossary = glossary ?? [];
      try {
        await recorder.start({
          onSegment: enqueue,
          onError: (error) => {
            reportVoiceFailure('recording', 'voiceAgent.error.recordingFailed', error);
            set({
              phase: 'error',
              recordingStartedAt: null,
              errorKey: 'voiceAgent.error.recordingFailed',
            });
          },
        });
      } catch (error) {
        reportVoiceFailure('getUserMedia', 'voiceAgent.error.micDenied', error);
        set({ phase: 'error', errorKey: 'voiceAgent.error.micDenied' });
        return;
      }
      set({
        phase: 'recording',
        recordingStartedAt: Date.now(),
        errorKey: null,
        lastCorrections: 0,
        lastTranscriptAt: null,
      });
    },

    stopRecording: async () => {
      if (get().phase !== 'recording') return;
      // Leave the red recording state immediately. The final segment is
      // emitted (and enqueued) before stop() resolves.
      set({ phase: 'transcribing', recordingStartedAt: null });
      try {
        await recorder.stop();
      } catch {
        set({ phase: 'error', errorKey: 'voiceAgent.error.recordingFailed' });
      } finally {
        set((state) => ({
          ...state,
          recordingStartedAt: null,
          phase: state.errorKey
            ? 'error'
            : state.pendingSegments > 0
              ? 'transcribing'
              : 'idle',
        }));
      }
      settle();
    },

    retryTranscription: () => {
      if (failed.length === 0) return;
      const retrying = failed.splice(0, failed.length);
      set((state) => ({
        ...state,
        errorKey: null,
        failedSegments: 0,
        phase: state.phase === 'recording' ? 'recording' : 'transcribing',
      }));
      retrying.forEach(enqueue);
    },

    dismissError: () => {
      failed.splice(0, failed.length);
      set((state) => ({
        ...state,
        errorKey: null,
        failedSegments: 0,
        phase: state.phase === 'error' ? 'idle' : state.phase,
      }));
    },
  };
});
