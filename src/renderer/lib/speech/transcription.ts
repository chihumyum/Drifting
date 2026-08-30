/**
 * Speech transcription — provider-neutral contract for turning one recorded
 * audio segment into text. Mirrors the agent driver seam: implementations own
 * their wire protocol; callers own recording, segmentation, and what happens
 * to the transcript.
 */

export type SpeechTranscriptionErrorKind =
  | 'auth'
  | 'network'
  | 'rate-limit'
  | 'invalid-input'
  | 'unknown';

export class SpeechTranscriptionError extends Error {
  readonly kind: SpeechTranscriptionErrorKind;
  readonly cause?: unknown;

  constructor(kind: SpeechTranscriptionErrorKind, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SpeechTranscriptionError';
    this.kind = kind;
    this.cause = options?.cause;
  }
}

export interface TranscribeAudioInput {
  audio: Blob;
  /** Container mime, e.g. `audio/mp4` or `audio/webm;codecs=opus`. */
  mimeType: string;
  /**
   * Recognition context: the project's proper nouns and framing. Providers
   * that support context biasing inject it; others may ignore it.
   */
  context?: string;
  signal?: AbortSignal;
}

export interface SpeechTranscriptionProvider {
  transcribe(input: TranscribeAudioInput): Promise<string>;
}
