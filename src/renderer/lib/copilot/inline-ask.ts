/**
 * Inline-ask (renderer) — the manual "discuss / get feedback on my prose"
 * capability (copilot popover「提问 / 讨论」). Phase 5: the ask prompt prose is
 * built + run on the SERVER and streamed back; this file only ships the prose
 * CONTEXT (the author's own text) and consumes the stream.
 *
 * Transport: native `fetch` (NOT axios — axios buffers the body, defeating
 * streaming) to `POST /api/ai/stream/inline-ask`. Auth rides the bearer token
 * (Authorization header), NOT cookies — same as the shared axios client. Cookies
 * are omitted on purpose: a cookie-bearing cross-site/custom-scheme request has
 * no usable Origin and better-auth rejects it (MISSING_OR_NULL_ORIGIN). The
 * server replies with NDJSON frames: {delta} per chunk, a terminal {usage}, or
 * {error} on failure. We yield each delta string, so the popover consumer
 * (`for await (const delta of ...)`) is unchanged.
 *
 * Nothing is persisted — this is an ephemeral chat living only in the popover.
 */
import { AIError, type AIErrorKind } from '../ai/types';
import { aiByokHeaders } from '../ai/remote/byok-headers';
import { getSessionToken } from '../session-token';
import { runtimeViteEnv } from '../vite-runtime-env';

const API_BASE_URL =
  (runtimeViteEnv.VITE_API_BASE_URL as string | undefined) ||
  (runtimeViteEnv.VITE_API_URL as string | undefined) ||
  'http://localhost:3000';

/** Prose context the answer is grounded in — captured once when the chat opens. */
export interface InlineAskContext {
  /** The selected span under discussion (empty when invoked on a bare caret). */
  selectedText?: string;
  /** Blocks immediately above (上文), for local context. */
  contextBefore?: string;
  /** Blocks immediately below (下文), for local context. */
  contextAfter?: string;
  /** Rolling segment summaries near the region — the local narrative arc. */
  segmentSummaries?: string[];
}

/** One turn in the discussion. `model` is the assistant. */
export interface AskTurn {
  role: 'user' | 'model';
  content: string;
}

interface AskFrame {
  delta?: string;
  error?: AIErrorKind;
  message?: string;
}

/**
 * Stream an answer for the latest turn. `history` is the full conversation so
 * far, with the new user question as its last entry. Yields incremental text
 * deltas; the caller accumulates and renders them. The prose context is fixed
 * for the conversation and sent with the request; the ask prompt itself lives
 * server-side.
 */
export async function* runInlineAskStream(params: {
  history: AskTurn[];
  context: InlineAskContext;
  projectId: string;
  signal?: AbortSignal;
}): AsyncIterable<string> {
  const { history, context, projectId, signal } = params;

  let res: Response;
  try {
    const token = getSessionToken();
    res = await fetch(`${API_BASE_URL}/api/ai/stream/inline-ask`, {
      method: 'POST',
      // Bearer auth, no cookies — see file header. Cookies would re-trigger
      // better-auth's origin/CSRF check on a request that has no Origin.
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // BYOK key (when ai_mode='byok'); empty for the hosted path.
        ...(await aiByokHeaders()),
      },
      body: JSON.stringify({
        context,
        history,
        projectId,
      }),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new AIError('aborted', 'Request aborted', err);
    }
    throw new AIError('network', err instanceof Error ? err.message : String(err), err);
  }

  if (!res.ok || !res.body) {
    const kind: AIErrorKind =
      res.status === 401 || res.status === 403 || res.status === 503
        ? 'auth'
        : res.status === 429
          ? 'rate-limit'
          : res.status >= 500
            ? 'network'
            : 'unknown';
    throw new AIError(kind, `inline-ask stream failed (HTTP ${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame: AskFrame;
        try {
          frame = JSON.parse(line) as AskFrame;
        } catch {
          continue; // ignore a partial/garbage line
        }
        if (frame.error) {
          throw new AIError(frame.error, frame.message ?? 'inline-ask failed');
        }
        if (frame.delta) yield frame.delta;
      }
    }
  } catch (err) {
    if (err instanceof AIError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new AIError('aborted', 'Request aborted', err);
    }
    throw new AIError('network', err instanceof Error ? err.message : String(err), err);
  }
}
