import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorderHarness = vi.hoisted(() => ({
  start: vi.fn(async (_options: unknown): Promise<void> => undefined),
  stop: vi.fn(async (): Promise<void> => undefined),
  cancel: vi.fn(),
}));

vi.mock('../lib/speech/voice-recorder', () => ({
  isVoiceRecordingSupported: () => true,
  VoiceRecorder: class {
    start(options: unknown) {
      return recorderHarness.start(options);
    }

    stop() {
      return recorderHarness.stop();
    }

    cancel() {
      return recorderHarness.cancel();
    }
  },
}));

vi.mock('../lib/speech/speech-credentials', () => ({
  speechKeychain: { get: vi.fn(async () => 'dashscope-test-key') },
}));

vi.mock('../lib/speech/dashscope-transcription', () => ({
  createDashScopeTranscriptionProvider: () => ({ transcribe: vi.fn() }),
}));

import { useVoiceCaptureStore } from './voice-capture-store';

beforeEach(() => {
  recorderHarness.start.mockClear();
  recorderHarness.stop.mockReset();
  recorderHarness.stop.mockResolvedValue(undefined);
  recorderHarness.cancel.mockClear();
  useVoiceCaptureStore.setState({
    sessionProjectId: null,
    phase: 'idle',
    recordingStartedAt: null,
    errorKey: null,
    pendingSegments: 0,
    failedSegments: 0,
  });
});

describe('voice capture stop lifecycle', () => {
  it('leaves the red recording phase immediately and recovers when stop rejects', async () => {
    let rejectStop: ((reason: unknown) => void) | undefined;
    recorderHarness.stop.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStop = reject;
        }),
    );

    await useVoiceCaptureStore.getState().startRecording({ context: 'project context' });
    expect(useVoiceCaptureStore.getState().phase).toBe('recording');

    const stopping = useVoiceCaptureStore.getState().stopRecording();
    expect(useVoiceCaptureStore.getState()).toMatchObject({
      phase: 'transcribing',
      recordingStartedAt: null,
    });

    rejectStop?.(new Error('MediaRecorder.onstop never fired'));
    await stopping;

    expect(useVoiceCaptureStore.getState()).toMatchObject({
      phase: 'error',
      recordingStartedAt: null,
      errorKey: 'voiceAgent.error.recordingFailed',
    });
  });
});
