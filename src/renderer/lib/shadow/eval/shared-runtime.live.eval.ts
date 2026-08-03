import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { LLMClient } from '../../ai/client/llm-client';
import { DeepSeekProvider } from '../../ai/client/providers/deepseek';
import type { AITool, AIUsage } from '../../ai/types';
import {
  runShadowAgentRuntime,
  type ShadowAgentRuntimeToolRound,
} from '../agent-runtime';

const LIVE_EVAL_ENABLED = process.env.DRIFTING_AGENT_LIVE_EVAL === '1';
const DEFAULT_MODEL = 'deepseek-v4-flash';

const READ_CANON_TOOL: AITool = {
  name: 'read_canon',
  description:
    '读取奥伦当前的作者设定，并返回本次验收专用 nonce。裁决前必须先调用并等待结果。',
  parametersSchema: Type.Object(
    { entity: Type.Literal('奥伦') },
    { additionalProperties: false },
  ),
};

const SUBMIT_VERDICTS_TOOL: AITool = {
  name: 'submit_verdicts',
  description:
    '使用 read_canon 返回的 nonce 提交最终裁决。只允许在 read_canon 工具结果返回后调用。',
  parametersSchema: Type.Object(
    {
      nonce: Type.String(),
      violated: Type.Boolean(),
      block: Type.Integer({ minimum: 1, maximum: 1 }),
      basis: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
};

describe.skipIf(!LIVE_EVAL_ENABLED)('Shadow shared Agent Runtime live canary', () => {
  it(
    'closes a real DeepSeek reasoning + tool-result + completion-tool loop',
    async () => {
      const apiKey = process.env.DEEPSEEK_AI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'DEEPSEEK_AI_API_KEY is required; use pnpm eval:shadow:live',
        );
      }

      const model = process.env.DEEPSEEK_AGENT_MODEL ?? DEFAULT_MODEL;
      const nonce = crypto.randomUUID();
      const rounds: ShadowAgentRuntimeToolRound[] = [];
      const usage: AIUsage[] = [];
      const client = new LLMClient(
        new DeepSeekProvider({ apiKey, defaultModel: model, thinking: false }),
      );
      const result = await runShadowAgentRuntime({
        projectId: 'shadow-live-canary',
        chapterId: 'chapter-1',
        operation: 'eval',
        feature: 'shadow-shared-runtime-live-canary',
        client,
        model,
        systemPrompt: [
          '你是 Shadow shared Agent Runtime 的付费端点验收器。',
          '第一轮只能调用 read_canon({"entity":"奥伦"})，必须等待工具结果；不要同时提交裁决。',
          '拿到工具结果后调用 submit_verdicts，nonce 必须逐字复制工具返回值。',
          '根据当前设定判断正文是否冲突；不要输出普通文字。',
        ].join('\n'),
        prompt: '正文第 1 段：奥伦用右手举起青鳞剑。请核对作者设定。',
        tools: [READ_CANON_TOOL, SUBMIT_VERDICTS_TOOL],
        completionTool: SUBMIT_VERDICTS_TOOL.name,
        maxModelIterations: 3,
        maxToolCalls: 3,
        reasoning: { enabled: true, effort: 'high' },
        executeTool: async (name) => {
          if (name !== READ_CANON_TOOL.name) {
            return {
              content: `Unexpected canary tool: ${name}`,
              status: 'denied',
              note: 'unexpected tool',
            };
          }
          return {
            content: [
              `nonce=${nonce}`,
              '奥伦：惯用左手；右手旧伤，不能持剑。',
              '对本章已生效的 element patch：无。',
            ].join('\n'),
            status: 'ok',
          };
        },
        onToolRound: (round) => rounds.push(round),
        onUsage: (entry) => usage.push(entry),
      });

      const submitted = result.completion.arguments;
      const toolNames = result.runtime.state.toolOrder.map(
        (callId) => result.runtime.state.tools[callId]?.name ?? 'unknown',
      );
      const eventTypes = result.runtime.entries.map((entry) => entry.event.type);

      console.log(
        `[shadow-shared-runtime-canary] model=${model} status=${result.runtime.state.status} iterations=${result.runtime.state.modelIterations} tools=${toolNames.join(',')} tokens=${result.runtime.state.usage.inputTokens}+${result.runtime.state.usage.outputTokens}`,
      );

      expect(result.runtime.state.status).toBe('completed');
      expect(result.runtime.state.modelIterations).toBeGreaterThanOrEqual(2);
      expect(toolNames).toEqual(['read_canon', 'submit_verdicts']);
      expect(rounds.flatMap((round) => round.calls.map((call) => call.tool))).toEqual([
        'read_canon',
      ]);
      expect(submitted).toMatchObject({
        nonce,
        violated: true,
        block: 1,
      });
      expect(String(submitted.basis)).toMatch(/左手|右手|旧伤/u);
      expect(eventTypes).toContain('completion_tool_accepted');
      expect(usage).toHaveLength(result.runtime.state.modelIterations);
      expect(result.runtime.state.usage.inputTokens).toBeGreaterThan(0);
      expect(result.runtime.state.usage.outputTokens).toBeGreaterThan(0);
    },
    120_000,
  );
});
