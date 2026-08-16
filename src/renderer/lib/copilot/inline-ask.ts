/**
 * Inline-ask — the manual "discuss / get feedback on my prose" capability
 * (copilot popover「提问 / 讨论」). Unlike inline-edit, this NEVER touches the
 * document: the author asks a question about a passage ("这段节奏好不好？",
 * "他这句话符合人设吗？") and gets a streamed, free-form answer back. It's a
 * read-only, multi-turn conversation that lives only in the popover — nothing
 * is persisted.
 *
 * Why this doesn't go through definePrompt/callStructured: those force a
 * single-turn tool call for structured JSON. A discussion is multi-turn and
 * free-form, so we build the `messages` history directly and stream plain text
 * via LLMClient.stream(). The prose under discussion is fixed for the whole
 * conversation, so it lives in the system prompt (sent once) and the visible
 * turns stay clean.
 */
import type { AIMessage } from '../ai/types';
import { resolveCopilotModel } from '../ai/copilot-route';
import { resolveCopilotOutputLanguage } from '../ai/run-structured';
import { useSettingsStore } from '../../store/settings-store';
import { copilotRuntime } from './runtime';

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

function buildAskSystem(ctx: InlineAskContext, projectId: string): string {
  const parts: string[] = [
    'You are a sharp, candid writing companion embedded in a fiction-writing ' +
      'app. The author asks questions ABOUT their own prose — for feedback, a ' +
      'second opinion, or to think through a craft choice. Answer directly and ' +
      'concretely, grounded in the text they gave you.\n\n' +
      'IMPORTANT — your context is LOCAL and INCOMPLETE. You are shown only a ' +
      'small excerpt: the selected passage, a few neighboring paragraphs, and ' +
      'maybe a couple of nearby summaries. You do NOT have the book\'s premise, ' +
      'the full outline, the overall plot, the character arcs, or the ' +
      'worldbuilding. So:\n' +
      '  - Focus on the WRITING ITSELF at the sentence/paragraph level: grammar ' +
      'and language errors, clarity, flow and rhythm, word choice, imagery, ' +
      'tone, repetition, pacing within the passage.\n' +
      '  - Do NOT pass judgment on PLOT, story logic, foreshadowing, character ' +
      'consistency, or whether events "make sense" for the book — you lack the ' +
      'global context to judge those, so such commentary would be misleading. ' +
      'If the author explicitly asks about plot/story, briefly note that you ' +
      'only see a local excerpt and answer only as far as this passage supports.\n\n' +
      'How to answer:\n' +
      '  - Be specific: point at actual words, lines, and moments — not generic ' +
      'writing-advice platitudes.\n' +
      '  - Be honest but constructive: name what works AND what is weak or unclear.\n' +
      '  - This is a DISCUSSION, not an edit. Do NOT silently rewrite their prose ' +
      'or hand back a full revised version unless they explicitly ask for one; ' +
      'when you suggest a change, say it in words or show a short illustrative ' +
      'snippet.\n' +
      '  - Keep it tight: no flattery, no preamble, no padding. Match the depth ' +
      'of the question.\n' +
      '  - Never invent story facts beyond what the passage and context show; if ' +
      'something depends on info you lack, say so.\n' +
      '  - PLAIN TEXT ONLY. The app shows your reply as raw text with NO markdown ' +
      'rendering, so markdown would show as literal symbols. Do NOT use markdown: ' +
      'no **bold**, no *italics*, no `#` headings, no `-`/`*` bullet lists, no ' +
      '`>` quotes, no backticks or code fences, no tables. Write in plain ' +
      'paragraphs; if you must enumerate, use a plain "1. " / "2. " or 「」 to ' +
      'quote a phrase, and keep it readable as raw text.',
  ];

  const text = ctx.selectedText?.trim();
  if (text) parts.push(`The passage under discussion:\n${text}`);

  const before = ctx.contextBefore?.trim();
  if (before) parts.push(`Context above it (上文, for reference only):\n${before}`);

  const after = ctx.contextAfter?.trim();
  if (after) parts.push(`Context below it (下文, for reference only):\n${after}`);

  const summaries = (ctx.segmentSummaries ?? []).map((s) => s.trim()).filter(Boolean);
  if (summaries.length) {
    parts.push(
      `Story so far — nearby summaries (context only):\n` +
        summaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n'),
    );
  }

  parts.push(`Write your reply in ${resolveCopilotOutputLanguage(projectId)}.`);

  return parts.join('\n\n');
}

/**
 * Stream an answer for the latest turn. `history` is the full conversation so
 * far, with the new user question as its last entry. Yields incremental text
 * deltas; the caller accumulates and renders them. The prose context is fixed
 * for the conversation and supplied separately (it lives in the system prompt).
 */
export async function* runInlineAskStream(params: {
  history: AskTurn[];
  context: InlineAskContext;
  projectId: string;
  signal?: AbortSignal;
}): AsyncIterable<string> {
  const { history, context, projectId, signal } = params;
  const settings = useSettingsStore.getState();
  const provider = settings.copilotByokProvider;
  const model = resolveCopilotModel(
    provider,
    settings.copilotByokModel,
  );
  const client = await copilotRuntime.getClient(provider);
  const system = buildAskSystem(context, projectId);
  const messages: AIMessage[] = history.map((t) => ({ role: t.role, content: t.content }));

  for await (const chunk of client.stream({
    model,
    system,
    messages,
    temperature: 0.7,
    // Discussion benefits from reasoning — force thinking on for this call,
    // regardless of the provider's default (DeepSeek honors this).
    thinking: true,
    signal,
    metadata: { feature: 'inline-ask' },
  })) {
    if (chunk.delta) yield chunk.delta;
  }
}
