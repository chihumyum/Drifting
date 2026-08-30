import { describe, expect, it, vi } from 'vitest';
import {
  DASHSCOPE_ASR_ENDPOINT,
  DASHSCOPE_ASR_MODEL,
  DASHSCOPE_MAX_AUDIO_BYTES,
  createDashScopeTranscriptionProvider,
} from './dashscope-transcription';
import { SpeechTranscriptionError } from './transcription';

const OK_PAYLOAD = {
  output: {
    choices: [{ message: { content: [{ text: '林雾生沿着雾港的堤岸走。' }] } }],
  },
};

function okResponse(): Response {
  return new Response(JSON.stringify(OK_PAYLOAD), { status: 200 });
}

function audioBlob(bytes = 16): Blob {
  return new Blob([new Uint8Array(bytes).fill(7)], { type: 'audio/webm' });
}

describe('DashScope transcription provider', () => {
  it('sends context as a system message and audio as an inline data URI', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const provider = createDashScopeTranscriptionProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const text = await provider.transcribe({
      audio: audioBlob(),
      mimeType: 'audio/webm;codecs=opus',
      context: '主要角色：林雾生（又称：老林）',
    });

    expect(text).toBe('林雾生沿着雾港的堤岸走。');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DASHSCOPE_ASR_ENDPOINT);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');

    const body = JSON.parse(String(init.body)) as {
      model: string;
      input: { messages: Array<{ role: string; content: Array<Record<string, string>> }> };
      parameters: { asr_options: { enable_itn: boolean } };
    };
    expect(body.model).toBe(DASHSCOPE_ASR_MODEL);
    expect(body.parameters.asr_options.enable_itn).toBe(false);
    expect(body.input.messages[0]).toEqual({
      role: 'system',
      content: [{ text: '主要角色：林雾生（又称：老林）' }],
    });
    // Codec parameters are stripped from the data-URI container mime.
    expect(body.input.messages[1]?.content[0]?.audio).toMatch(/^data:audio\/webm;base64,/);
  });

  it('omits the system message when no context is provided', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const provider = createDashScopeTranscriptionProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.transcribe({ audio: audioBlob(), mimeType: 'audio/mp4' });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      input: { messages: Array<{ role: string }> };
    };
    expect(body.input.messages).toHaveLength(1);
    expect(body.input.messages[0]?.role).toBe('user');
  });

  it('skips the network entirely for an empty segment', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const provider = createDashScopeTranscriptionProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.transcribe({ audio: audioBlob(0), mimeType: 'audio/mp4' })).resolves.toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a segment beyond the synchronous API budget before uploading', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const provider = createDashScopeTranscriptionProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const oversized = new Blob([new Uint8Array(DASHSCOPE_MAX_AUDIO_BYTES + 1)]);
    await expect(
      provider.transcribe({ audio: oversized, mimeType: 'audio/mp4' }),
    ).rejects.toMatchObject({ kind: 'invalid-input' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps provider failures onto typed error kinds', async () => {
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate-limit'],
      [400, 'invalid-input'],
      [500, 'unknown'],
    ];
    for (const [status, kind] of cases) {
      const provider = createDashScopeTranscriptionProvider({
        apiKey: 'sk-test',
        fetchImpl: (async () => new Response('{"message":"nope"}', { status })) as typeof fetch,
      });
      await expect(
        provider.transcribe({ audio: audioBlob(), mimeType: 'audio/mp4' }),
      ).rejects.toMatchObject({ kind });
    }

    const offline = createDashScopeTranscriptionProvider({
      apiKey: 'sk-test',
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    await expect(
      offline.transcribe({ audio: audioBlob(), mimeType: 'audio/mp4' }),
    ).rejects.toBeInstanceOf(SpeechTranscriptionError);
  });
});
