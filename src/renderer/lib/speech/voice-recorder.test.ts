import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceRecorder } from './voice-recorder';

type StopBehavior = 'success' | 'error' | 'hang' | 'manual' | 'throw';

class FakeTrack extends EventTarget {
  stop = vi.fn();
}

class FakeMediaRecorder extends EventTarget {
  static behavior: StopBehavior = 'success';
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return type === 'audio/mp4';
  }

  state: RecordingState = 'inactive';
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  stopCalls = 0;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.stopCalls += 1;
    if (FakeMediaRecorder.behavior === 'throw') throw new Error('stop failed');
    if (FakeMediaRecorder.behavior === 'hang' || FakeMediaRecorder.behavior === 'manual') return;
    queueMicrotask(() => {
      if (FakeMediaRecorder.behavior === 'error') {
        this.state = 'inactive';
        this.onerror?.(new Event('error'));
        return;
      }
      this.finishSuccessfully();
    });
  }

  finishSuccessfully(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice']) } as BlobEvent);
    this.onstop?.(new Event('stop'));
  }
}

let track: FakeTrack;

beforeEach(() => {
  track = new FakeTrack();
  FakeMediaRecorder.behavior = 'success';
  FakeMediaRecorder.instances = [];
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VoiceRecorder', () => {
  it('flushes a final standalone segment and releases the microphone', async () => {
    const onSegment = vi.fn();
    const recorder = new VoiceRecorder();

    await recorder.start({ onSegment, stopTimeoutMs: 50 });
    await recorder.stop();

    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0]?.[0]).toMatchObject({ mimeType: 'audio/mp4' });
    expect(await onSegment.mock.calls[0]?.[0].blob.text()).toBe('voice');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder.recording).toBe(false);
  });

  it.each([
    ['error', 'recorder-error'],
    ['throw', 'stop-failed'],
    ['hang', 'stop-timeout'],
  ] as const)('rejects a %s stop without retaining the stream', async (behavior, kind) => {
    FakeMediaRecorder.behavior = behavior;
    const recorder = new VoiceRecorder();
    await recorder.start({ onSegment: vi.fn(), stopTimeoutMs: 10 });

    await expect(recorder.stop()).rejects.toMatchObject({ kind });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder.recording).toBe(false);
  });

  it('reports an unexpectedly ended microphone track and resets synchronously', async () => {
    const onError = vi.fn();
    const recorder = new VoiceRecorder();
    await recorder.start({ onSegment: vi.fn(), onError, stopTimeoutMs: 50 });

    track.dispatchEvent(new Event('ended'));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'track-ended' }),
    );
    expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder.recording).toBe(false);
  });

  it('shares an in-flight segment finalization with a simultaneous user stop', async () => {
    vi.useFakeTimers();
    try {
      FakeMediaRecorder.behavior = 'manual';
      const recorder = new VoiceRecorder();
      await recorder.start({ onSegment: vi.fn(), segmentMs: 5, stopTimeoutMs: 50 });

      await vi.advanceTimersByTimeAsync(5);
      const platformRecorder = FakeMediaRecorder.instances[0];
      expect(platformRecorder?.stopCalls).toBe(1);

      const stopping = recorder.stop();
      expect(platformRecorder?.stopCalls).toBe(1);
      platformRecorder?.finishSuccessfully();
      await stopping;
      await Promise.resolve();

      expect(FakeMediaRecorder.instances).toHaveLength(1);
      expect(recorder.recording).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
