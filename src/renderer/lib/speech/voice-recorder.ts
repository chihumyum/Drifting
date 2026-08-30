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
  private segmentMs = VOICE_SEGMENT_MS;

  get recording(): boolean {
    return this.recorder !== null;
  }

  async start(options: {
    onSegment(segment: VoiceRecorderSegment): void;
    segmentMs?: number;
  }): Promise<void> {
    if (this.recorder) return;
    this.onSegment = options.onSegment;
    this.segmentMs = options.segmentMs ?? VOICE_SEGMENT_MS;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.startRecorder();
  }

  /** Stop and flush the final segment. Resolves after the segment is emitted. */
  async stop(): Promise<void> {
    this.clearRollTimer();
    const recorder = this.recorder;
    if (!recorder) {
      this.releaseStream();
      return;
    }
    await this.finalizeRecorder(recorder);
    this.recorder = null;
    this.releaseStream();
  }

  /** Discard everything without emitting a segment. */
  cancel(): void {
    this.clearRollTimer();
    const recorder = this.recorder;
    this.recorder = null;
    this.onSegment = null;
    this.chunks = [];
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      try {
        recorder.stop();
      } catch {
        // Already stopped by the platform; releasing the stream is what matters.
      }
    }
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
    recorder.start();
    this.recorder = recorder;
    this.rollTimer = setTimeout(() => {
      void this.rollSegment();
    }, this.segmentMs);
  }

  private async rollSegment(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    await this.finalizeRecorder(recorder);
    if (this.recorder === recorder) {
      this.recorder = null;
      this.startRecorder();
    }
  }

  private finalizeRecorder(recorder: MediaRecorder): Promise<void> {
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        if (blob.size > 0) this.onSegment?.({ blob, mimeType });
        resolve();
      };
      if (recorder.state === 'inactive') {
        recorder.onstop = null;
        resolve();
        return;
      }
      recorder.stop();
    });
  }

  private clearRollTimer(): void {
    if (this.rollTimer !== null) {
      clearTimeout(this.rollTimer);
      this.rollTimer = null;
    }
  }

  private releaseStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
