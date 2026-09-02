/**
 * Voice recorder — MediaRecorder wrapper producing standalone playable
 * segments. Rolls to a fresh recorder on a timer so every emitted blob stays
 * within the synchronous transcription API's duration/size caps; a rolled
 * segment is finalized (not a mid-stream fragment), so each transcribes
 * independently and in order.
 *
 * WKWebView emits `audio/mp4` (AAC), Android WebView `audio/webm` (Opus);
 * both are accepted by the DashScope endpoint.
 */

export interface VoiceRecorderSegment {
  blob: Blob;
  mimeType: string;
}

export const VOICE_SEGMENT_MS = 240_000;
export const VOICE_RECORDER_STOP_TIMEOUT_MS = 5_000;

export type VoiceRecorderFailureKind =
  | 'start-failed'
  | 'recorder-error'
  | 'track-ended'
  | 'stop-failed'
  | 'stop-timeout';

export class VoiceRecorderError extends Error {
  constructor(readonly kind: VoiceRecorderFailureKind, message: string) {
    super(message);
    this.name = 'VoiceRecorderError';
  }
}

const CANDIDATE_MIME_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

export function isVoiceRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined;
  return CANDIDATE_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private rollTimer: ReturnType<typeof setTimeout> | null = null;
  private chunks: Blob[] = [];
  private onSegment: ((segment: VoiceRecorderSegment) => void) | null = null;
  private onError: ((error: VoiceRecorderError) => void) | null = null;
  private segmentMs = VOICE_SEGMENT_MS;
  private stopTimeoutMs = VOICE_RECORDER_STOP_TIMEOUT_MS;
  private stopping = false;
  private trackEndedHandlers = new Map<MediaStreamTrack, () => void>();
  private pendingFinalization: {
    recorder: MediaRecorder;
    reject(error: VoiceRecorderError): void;
  } | null = null;
  private pendingFinalizationPromise: Promise<void> | null = null;

  get recording(): boolean {
    return this.recorder !== null;
  }

  async start(options: {
    onSegment(segment: VoiceRecorderSegment): void;
    onError?(error: VoiceRecorderError): void;
    segmentMs?: number;
    stopTimeoutMs?: number;
  }): Promise<void> {
    if (this.recorder) return;
    this.onSegment = options.onSegment;
    this.onError = options.onError ?? null;
    this.segmentMs = options.segmentMs ?? VOICE_SEGMENT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? VOICE_RECORDER_STOP_TIMEOUT_MS;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.observeStreamTracks();
      this.startRecorder();
    } catch (error) {
      this.cancel();
      if (error instanceof VoiceRecorderError) throw error;
      throw new VoiceRecorderError('start-failed', 'Could not start voice recording');
    }
  }

  /** Stop and flush the final segment. Resolves after the segment is emitted. */
  async stop(): Promise<void> {
    this.clearRollTimer();
    const recorder = this.recorder;
    if (!recorder) {
      this.releaseStream();
      return;
    }
    this.stopping = true;
    try {
      await this.finalizeRecorder(recorder);
    } finally {
      if (this.recorder === recorder) this.recorder = null;
      this.stopRecorderSilently(recorder);
      this.chunks = [];
      this.onSegment = null;
      this.onError = null;
      this.releaseStream();
      this.stopping = false;
    }
  }

  /** Discard everything without emitting a segment. */
  cancel(): void {
    this.clearRollTimer();
    const recorder = this.recorder;
    const pendingFinalization = this.pendingFinalization;
    this.recorder = null;
    this.onSegment = null;
    this.onError = null;
    this.chunks = [];
    if (pendingFinalization?.recorder === recorder) {
      pendingFinalization.reject(
        new VoiceRecorderError('stop-failed', 'Voice recording was cancelled while stopping'),
      );
    }
    if (recorder) this.stopRecorderSilently(recorder);
    this.releaseStream();
  }

  private startRecorder(): void {
    if (!this.stream) return;
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(this.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64_000,
    });
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onerror = () => {
      this.failActiveRecorder(
        recorder,
        new VoiceRecorderError('recorder-error', 'The platform voice recorder failed'),
      );
    };
    this.recorder = recorder;
    try {
      recorder.start();
    } catch {
      this.recorder = null;
      this.stopRecorderSilently(recorder);
      throw new VoiceRecorderError('start-failed', 'The platform voice recorder did not start');
    }
    this.rollTimer = setTimeout(() => {
      void this.rollSegment();
    }, this.segmentMs);
  }

  private async rollSegment(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    try {
      await this.finalizeRecorder(recorder);
      if (this.recorder === recorder) {
        this.recorder = null;
        if (!this.stopping) this.startRecorder();
      }
    } catch (error) {
      if (this.stopping) return;
      const failure =
        error instanceof VoiceRecorderError
          ? error
          : new VoiceRecorderError('recorder-error', 'Could not roll the voice segment');
      this.failActiveRecorder(recorder, failure);
    }
  }

  private finalizeRecorder(recorder: MediaRecorder): Promise<void> {
    if (
      this.pendingFinalization?.recorder === recorder &&
      this.pendingFinalizationPromise
    ) {
      return this.pendingFinalizationPromise;
    }

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const finish = (error?: VoiceRecorderError) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        if (this.pendingFinalization?.recorder === recorder) {
          this.pendingFinalization = null;
          this.pendingFinalizationPromise = null;
        }
        recorder.onstop = null;
        recorder.onerror = null;
        if (error) {
          this.chunks = [];
          reject(error);
          return;
        }
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        if (blob.size > 0) this.onSegment?.({ blob, mimeType });
        resolve();
      };

      this.pendingFinalization = {
        recorder,
        reject: (error) => finish(error),
      };
      recorder.onstop = () => finish();
      recorder.onerror = () => {
        finish(new VoiceRecorderError('recorder-error', 'The platform voice recorder failed'));
      };
      if (recorder.state === 'inactive') {
        finish();
        return;
      }
      timeout = setTimeout(() => {
        finish(
          new VoiceRecorderError(
            'stop-timeout',
            `The platform voice recorder did not stop within ${this.stopTimeoutMs}ms`,
          ),
        );
      }, this.stopTimeoutMs);
      try {
        recorder.stop();
      } catch {
        finish(
          new VoiceRecorderError('stop-failed', 'The platform voice recorder did not stop'),
        );
      }
    });
    if (this.pendingFinalization?.recorder === recorder) {
      this.pendingFinalizationPromise = promise;
    }
    return promise;
  }

  private observeStreamTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      const onEnded = () => {
        const recorder = this.recorder;
        if (!recorder) return;
        this.failActiveRecorder(
          recorder,
          new VoiceRecorderError('track-ended', 'The microphone stream ended unexpectedly'),
        );
      };
      track.addEventListener('ended', onEnded, { once: true });
      this.trackEndedHandlers.set(track, onEnded);
    }
  }

  private failActiveRecorder(recorder: MediaRecorder, error: VoiceRecorderError): void {
    if (this.recorder !== recorder) return;
    if (this.pendingFinalization?.recorder === recorder) {
      this.pendingFinalization.reject(error);
      return;
    }
    const onError = this.onError;
    this.cancel();
    onError?.(error);
  }

  private stopRecorderSilently(recorder: MediaRecorder): void {
    recorder.onstop = null;
    recorder.onerror = null;
    recorder.ondataavailable = null;
    if (recorder.state === 'inactive') return;
    try {
      recorder.stop();
    } catch {
      // A failed or already-stopped recorder is still abandoned below.
    }
  }

  private clearRollTimer(): void {
    if (this.rollTimer !== null) {
      clearTimeout(this.rollTimer);
      this.rollTimer = null;
    }
  }

  private releaseStream(): void {
    for (const [track, onEnded] of this.trackEndedHandlers) {
      track.removeEventListener('ended', onEnded);
    }
    this.trackEndedHandlers.clear();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
