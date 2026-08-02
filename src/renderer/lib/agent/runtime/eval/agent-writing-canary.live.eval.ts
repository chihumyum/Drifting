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
const PATH = '/chapters/雨夜/prose.md';
const SELECTED_TEXT = '她把伞靠在门边，没有回头。';

class WritingCanaryTools implements AgentToolRuntime {
  text = `雨压得很低。\n\n${SELECTED_TEXT}\n\n楼上的钟响了一次。`;
  readonly trace: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  private read = false;

  listDefinitions(): readonly AgentToolDefinition[] {
    return [
      definition('read_file', 'Read one current manuscript file.', 'read', {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
      definition('edit_file', 'Replace exact current text in one manuscript file.', 'write', {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          replacements: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                oldText: { type: 'string' },
                newText: { type: 'string' },
              },
              required: ['oldText', 'newText'],
            },
          },
        },
        required: ['path', 'replacements'],
      }),
    ];
  }

  async execute(request: AgentToolExecutionRequest): Promise<AgentToolExecutionResult> {
    this.trace.push({ name: request.name, arguments: structuredClone(request.arguments) });
    if (request.context.route.projectId !== PROJECT_ID) {
      return { ok: false, error: 'CROSS_PROJECT_DENIED' };
    }
    if (request.arguments.path !== PATH) return { ok: false, error: 'PATH_NOT_FOUND' };
    if (request.name === 'read_file') {
      this.read = true;
      return { ok: true, data: { path: PATH, content: this.text } };
    }
    if (request.name !== 'edit_file') return { ok: false, error: 'UNKNOWN_TOOL' };
    if (!this.read) return { ok: false, error: 'READ_REQUIRED_BEFORE_EDIT' };
    const replacements = request.arguments.replacements;
    if (!Array.isArray(replacements)) return { ok: false, error: 'INVALID_REPLACEMENTS' };
    for (const replacement of replacements) {
      if (!replacement || typeof replacement !== 'object') {
        return { ok: false, error: 'INVALID_REPLACEMENT' };
      }
      const oldText = (replacement as Record<string, unknown>).oldText;
      const newText = (replacement as Record<string, unknown>).newText;
      if (
        typeof oldText !== 'string' ||
        typeof newText !== 'string' ||
        !this.text.includes(oldText)
      ) {
        return { ok: false, error: 'OLD_TEXT_NOT_FOUND' };
      }
      this.text = this.text.replace(oldText, newText);
    }
    return { ok: true, data: { saved: true, path: PATH, replacements: replacements.length } };
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
        '先读取当前正文，然后只润色我选中的这句话。必须调用 edit_file 落下改动；不要改剧情，不要修改相邻段落。';
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
      expect(tools.trace.map((call) => call.name)).toEqual(['read_file', 'edit_file']);
      const edit = tools.trace[1]?.arguments;
      expect(edit?.path).toBe(PATH);
      const replacements = edit?.replacements;
      expect(Array.isArray(replacements)).toBe(true);
      expect(
        (replacements as Array<Record<string, unknown>>).every(
          (replacement) =>
            typeof replacement.oldText === 'string' && SELECTED_TEXT.includes(replacement.oldText),
        ),
      ).toBe(true);
      expect(tools.text).toContain('雨压得很低。');
      expect(tools.text).toContain('楼上的钟响了一次。');
      expect(tools.text).not.toContain(SELECTED_TEXT);
    },
    3 * 60_000,
  );
});
