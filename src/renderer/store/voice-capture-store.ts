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

  openSession(projectId: string): void;
  closeSession(): Promise<void>;
  startRecording(input: { context: string }): Promise<void>;
  stopRecording(): Promise<void>;
  retryTranscription(): void;
  dismissError(): void;
}

const recorder = new VoiceRecorder();
let provider: SpeechTranscriptionProvider | null = null;
let captureContext = '';
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
        appendToAgentPrompt(text);
      } catch (error) {
        failed.push(segment);
        set((state) => ({
          ...state,
          errorKey: errorKeyFor(error),
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

    openSession: (projectId) => set({ sessionProjectId: projectId }),

    closeSession: async () => {
      if (get().phase === 'recording') await get().stopRecording();
      set({ sessionProjectId: null });
    },

    startRecording: async ({ context }) => {
      const state = get();
      if (state.phase === 'recording') return;
      if (!isVoiceRecordingSupported()) {
        set({ phase: 'error', errorKey: 'voiceAgent.error.unsupported' });
        return;
      }
      let apiKey: string | null = null;
      try {
        apiKey = await speechKeychain.get();
      } catch {
        apiKey = null;
      }
      if (!apiKey) {
        set({ phase: 'error', errorKey: 'voiceAgent.error.noKey' });
        return;
      }
      provider = createDashScopeTranscriptionProvider({ apiKey });
      captureContext = context;
      try {
        await recorder.start({ onSegment: enqueue });
      } catch {
        set({ phase: 'error', errorKey: 'voiceAgent.error.micDenied' });
        return;
      }
      set({ phase: 'recording', recordingStartedAt: Date.now(), errorKey: null });
    },

    stopRecording: async () => {
      if (get().phase !== 'recording') return;
      // The final segment is emitted (and enqueued) before stop() resolves.
      await recorder.stop();
      set((state) => ({
        ...state,
        recordingStartedAt: null,
        phase: state.pendingSegments > 0 ? 'transcribing' : state.errorKey ? 'error' : 'idle',
      }));
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
