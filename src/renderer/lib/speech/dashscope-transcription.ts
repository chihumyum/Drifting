/**
 * DashScope (阿里云百炼) speech transcription over qwen3-asr-flash.
 *
 * BYOK: the request goes directly from the renderer to DashScope with the
 * author's own key — no Drifting server is involved. The recognition context
 * rides in a system message, which qwen3-asr treats as biasing text rather
 * than a role prompt; that is where the project's proper nouns go.
 *
 * Non-streaming whole-segment recognition. The synchronous API accepts at
 * most ~10MB of base64-encoded audio and about five minutes per request, so
 * the recorder keeps segments comfortably below both limits.
 */

import {
  SpeechTranscriptionError,
  type SpeechTranscriptionProvider,
  type TranscribeAudioInput,
} from './transcription';

export const DASHSCOPE_ASR_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const DASHSCOPE_ASR_MODEL = 'qwen3-asr-flash';

/** Raw-audio ceiling that keeps the base64 payload under the 10MB API cap. */
export const DASHSCOPE_MAX_AUDIO_BYTES = 7_000_000;

export interface DashScopeTranscriptionOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface DashScopeContentPart {
  text?: unknown;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function containerMime(mimeType: string): string {
  const bare = mimeType.split(';')[0]?.trim();
  return bare || 'audio/webm';
}

function parseTranscript(payload: unknown): string {
  const content = (
    payload as {
      output?: { choices?: Array<{ message?: { content?: DashScopeContentPart[] } }> };
    }
  )?.output?.choices?.[0]?.message?.content;
  if (!Array.isArray(content)) {
    throw new SpeechTranscriptionError('unknown', 'DashScope response had no transcript content');
  }
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function errorFromStatus(status: number, body: string): SpeechTranscriptionError {
  const detail = body.slice(0, 300);
  if (status === 401 || status === 403) {
    return new SpeechTranscriptionError('auth', `DashScope rejected the API key (${status})`);
  }
  if (status === 429) {
    return new SpeechTranscriptionError('rate-limit', 'DashScope rate limit reached (429)');
  }
  if (status >= 400 && status < 500) {
    return new SpeechTranscriptionError(
      'invalid-input',
      `DashScope rejected the request (${status}): ${detail}`,
    );
  }
  return new SpeechTranscriptionError('unknown', `DashScope request failed (${status}): ${detail}`);
}

export function createDashScopeTranscriptionProvider(
  options: DashScopeTranscriptionOptions,
): SpeechTranscriptionProvider {
  const endpoint = options.endpoint ?? DASHSCOPE_ASR_ENDPOINT;
  const model = options.model ?? DASHSCOPE_ASR_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async transcribe(input: TranscribeAudioInput): Promise<string> {
      if (input.audio.size === 0) return '';
      if (input.audio.size > DASHSCOPE_MAX_AUDIO_BYTES) {
        throw new SpeechTranscriptionError(
          'invalid-input',
          `Audio segment too large for synchronous recognition (${input.audio.size} bytes)`,
        );
      }

      const base64 = await blobToBase64(input.audio);
      const context = input.context?.trim();
      const messages = [
        ...(context ? [{ role: 'system', content: [{ text: context }] }] : []),
        {
          role: 'user',
          content: [{ audio: `data:${containerMime(input.mimeType)};base64,${base64}` }],
        },
      ];

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: { messages },
            // ITN off: spoken numbers stay as the author voiced them; the
            // Agent turn owns any later normalization.
            parameters: { asr_options: { enable_itn: false } },
          }),
          signal: input.signal,
        });
      } catch (cause) {
        if (input.signal?.aborted) throw cause;
        throw new SpeechTranscriptionError('network', 'DashScope request did not reach the API', {
          cause,
        });
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw errorFromStatus(response.status, body);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        throw new SpeechTranscriptionError('unknown', 'DashScope response was not JSON', { cause });
      }
      return parseTranscript(payload);
    },
  };
}
