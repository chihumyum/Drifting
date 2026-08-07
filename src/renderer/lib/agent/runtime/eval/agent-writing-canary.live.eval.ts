import { describe, expect, it } from 'vitest';

import { LLMClient } from '../../../ai/client/llm-client';
import { DeepSeekProvider } from '../../../ai/client/providers/deepseek';
import { DriftingAgentModelDriver } from '../drivers/drifting-agent-driver';
import { createLocalGeneralAgentTransport } from '../local-transport';
import type {
  AgentJournalSink,
  AgentRuntimeJournalEntry,
  AgentToolDefinition,
  AgentToolExecutionRequest,
  AgentToolExecutionResult,
  AgentToolRuntime,
} from '../types';

const LIVE_EVAL_ENABLED = process.env.DRIFTING_AGENT_LIVE_EVAL === '1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const PROJECT_ID = 'writing-canary-project';
const CHAPTER = '雨夜';
const SELECTED_TEXT = '她把伞靠在门边，没有回头。';

class WritingCanaryTools implements AgentToolRuntime {
  text = `雨压得很低。\n\n${SELECTED_TEXT}\n\n楼上的钟响了一次。`;
  readonly trace: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  private read = false;

  listDefinitions(): readonly AgentToolDefinition[] {
    return [
      definition('read_chapter', 'Read one current chapter.', 'read', {
        type: 'object',
        additionalProperties: false,
        properties: { chapter: { type: 'string' } },
        required: ['chapter'],
      }),
      definition('revise_chapter', 'Revise current passages in one chapter.', 'write', {
        type: 'object',
        additionalProperties: false,
        properties: {
          chapter: { type: 'string' },
          changes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                currentText: { type: 'string' },
                revisedText: { type: 'string' },
              },
              required: ['currentText', 'revisedText'],
            },
          },
        },
        required: ['chapter', 'changes'],
      }),
    ];
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    this.trace.push({ name: request.name, arguments: structuredClone(request.arguments) });
    if (request.context.route.projectId !== PROJECT_ID) {
      return { ok: false, error: 'CROSS_PROJECT_DENIED' };
    }
    if (request.arguments.chapter !== CHAPTER) return { ok: false, error: 'TARGET_NOT_FOUND' };
    if (request.name === 'read_chapter') {
      this.read = true;
      return { ok: true, data: { chapter: CHAPTER, body: this.text } };
    }
    if (request.name !== 'revise_chapter') return { ok: false, error: 'UNKNOWN_TOOL' };
    if (!this.read) return { ok: false, error: 'READ_REQUIRED_BEFORE_EDIT' };
    const changes = request.arguments.changes;
    if (!Array.isArray(changes)) return { ok: false, error: 'INVALID_CHANGES' };
    for (const change of changes) {
      if (!change || typeof change !== 'object') {
        return { ok: false, error: 'INVALID_CHANGE' };
      }
      const currentText = (change as Record<string, unknown>).currentText;
      const revisedText = (change as Record<string, unknown>).revisedText;
      if (
        typeof currentText !== 'string' ||
        typeof revisedText !== 'string' ||
        !this.text.includes(currentText)
      ) {
        return { ok: false, error: 'CURRENT_TEXT_NOT_FOUND' };
      }
      this.text = this.text.replace(currentText, revisedText);
    }
    return { ok: true, data: { saved: true, chapter: CHAPTER, changes: changes.length } };
  }
}

function definition(
  name: string,
  description: string,
  access: 'read' | 'write',
  inputSchema: object,
): AgentToolDefinition {
  return {
    name,
    description,
    access,
    inputSchema,
    validateInput: (input) => ({ ok: true, value: input }),
  };
}

describe.skipIf(!LIVE_EVAL_ENABLED)('DeepSeek author-directed writing canary', () => {
  it(
    'follows an explicit author rule without a product-imposed writing scope',
    async () => {
      const apiKey = process.env.DEEPSEEK_AI_API_KEY;
      if (!apiKey) {
        throw new Error('DEEPSEEK_AI_API_KEY is required; use pnpm eval:agent:writing:live');
      }
      const model = process.env.DEEPSEEK_AGENT_MODEL ?? DEFAULT_MODEL;
      const prompt =
        '读一下章节「雨夜」，把“她把伞靠在门边，没有回头。”润色得更有压抑感，别动剧情和相邻段落。';
      const tools = new WritingCanaryTools();
      const entries: AgentRuntimeJournalEntry[] = [];
      const journal: AgentJournalSink = {
        append: (entry) => {
          entries.push(entry);
        },
      };
      const driver = new DriftingAgentModelDriver({
        defaultModel: model,
        createClient: async () =>
          new LLMClient(new DeepSeekProvider({ apiKey, defaultModel: model, thinking: false })),
      });
      const transport = createLocalGeneralAgentTransport({
        driver,
        tools,
        journal,
        limits: {
          maxDurationMs: 120_000,
          maxModelIterations: 4,
          maxToolCalls: 4,
          maxInputTokens: 40_000,
          maxOutputTokens: 3_000,
          maxTotalTokens: 43_000,
        },
        createId: (kind) => `writing-canary-${kind}`,
      });
      const turnId = 'writing-canary-turn';
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const subscription = transport.subscribeJournal((entry) => {
        if (entry.turnId === turnId && entry.event.type === 'turn_finished') resolveDone();
      });
      if (!subscription.ok) throw new Error(subscription.error);
      const started = await transport.start({
        turnId,
        route: { kind: 'chat', projectId: PROJECT_ID, conversationId: 'writing-canary' },
        prompt,
        projectName: '写作 canary',
        model,
        thinking: 'off',
        toolSearch: 'off',
      });
      expect(started).toMatchObject({ ok: true });
      await done;
      subscription.value();

      const terminal = [...entries].reverse().find((entry) => entry.event.type === 'turn_finished');
      expect(terminal?.event).toMatchObject({ type: 'turn_finished', outcome: 'completed' });
      expect(tools.trace.map((call) => call.name)).toEqual(['read_chapter', 'revise_chapter']);
      const edit = tools.trace[1]?.arguments;
      expect(edit?.chapter).toBe(CHAPTER);
      const changes = edit?.changes;
      expect(Array.isArray(changes)).toBe(true);
      expect(
        (changes as Array<Record<string, unknown>>).every(
          (change) =>
            typeof change.currentText === 'string' && SELECTED_TEXT.includes(change.currentText),
        ),
      ).toBe(true);
      expect(tools.text).toContain('雨压得很低。');
      expect(tools.text).toContain('楼上的钟响了一次。');
      expect(tools.text).not.toContain(SELECTED_TEXT);
    },
    3 * 60_000,
  );
});
