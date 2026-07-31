import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../../../domain/agent-conversation';
import { applyEvent } from '../../../../store/agent-chat-store';
import { LLMClient } from '../../../ai/client/llm-client';
import { DeepSeekProvider } from '../../../ai/client/providers/deepseek';
import { createDriftingToolSelectionStrategy } from '../drifting-tool-selection';
import { DriftingAgentModelDriver } from '../drivers/drifting-agent-driver';
import { createLocalGeneralAgentTransport } from '../local-transport';
import type {
  AgentJournalSink,
  AgentModelDriver,
  AgentModelRequest,
  AgentRuntimeJournalEntry,
} from '../types';
import {
  P1_EVAL_PROJECT_ID,
  P1LiveFixtureToolRuntime,
} from './p1-live-fixture';

const LIVE_EVAL_ENABLED = process.env.DRIFTING_AGENT_LIVE_EVAL === '1';
const DEFAULT_MODEL = 'deepseek-v4-flash';

interface ProductCanary {
  id: string;
  prompt: string;
  expectedTool: 'list_nodes' | 'get_overview';
  answerPatterns: readonly RegExp[];
  maxIterations: number;
}

const CANARIES: readonly ProductCanary[] = [
  {
    id: 'list-current-chapters',
    prompt:
      '请列出这个项目当前的全部章节和漂流节点，用完整名称分组说明。先调用最合适的章节目录工具，只根据工具结果回答。',
    expectedTool: 'list_nodes',
    answerPatterns: [/序章/u, /第二章/u, /空白章/u, /超长附录/u],
    maxIterations: 2,
  },
  {
    id: 'introduce-current-novel',
    prompt:
      '请介绍这个小说：准确说出书名、核心 premise、故事线和主要元素。先读取一次全书概览，只根据工具结果回答。',
    expectedTool: 'get_overview',
    answerPatterns: [/星海漂流/u, /寻找新家园|新家园/u, /林舟/u],
    maxIterations: 2,
  },
];

describe.skipIf(!LIVE_EVAL_ENABLED)(
  'General Agent DeepSeek product canaries',
  () => {
    it(
      'streams, uses one bounded directory read, and returns a final answer',
      async () => {
        const apiKey = process.env.DEEPSEEK_AI_API_KEY;
        if (!apiKey) {
          throw new Error(
            'DEEPSEEK_AI_API_KEY is required; use pnpm eval:agent:canary',
          );
        }
        const model = process.env.DEEPSEEK_AGENT_MODEL ?? DEFAULT_MODEL;

        for (const canary of CANARIES) {
          const productDriver = new DriftingAgentModelDriver({
            defaultModel: model,
            createClient: async () =>
              new LLMClient(
                new DeepSeekProvider({
                  apiKey,
                  defaultModel: model,
                  thinking: false,
                }),
              ),
          });
          const providerRequests: {
            iteration: number;
            toolNames: string[];
          }[] = [];
          const driver = recordingDriver(
            productDriver,
            providerRequests,
          );
          const tools = new P1LiveFixtureToolRuntime();
          const journalEntries: AgentRuntimeJournalEntry[] = [];
          let textDeltaCount = 0;
          let transcript: AgentChatMessage[] = [
            { kind: 'user', text: canary.prompt },
          ];
          const streamingSnapshots: AgentChatMessage[][] = [];
          const journal: AgentJournalSink = {
            append: (entry) => {
              journalEntries.push(entry);
            },
          };

          const route = {
            kind: 'chat' as const,
            projectId: P1_EVAL_PROJECT_ID,
            conversationId: `canary-${canary.id}`,
          };
          const turnId = `canary-turn-${canary.id}`;
          const transport = createLocalGeneralAgentTransport({
            driver,
            tools,
            toolSelector: createDriftingToolSelectionStrategy(),
            journal,
            createId: (kind) => `canary-${kind}-${canary.id}`,
            limits: {
              maxDurationMs: 120_000,
              maxModelIterations: 4,
              maxToolCalls: 4,
              maxInputTokens: 50_000,
              maxOutputTokens: 4_000,
              maxTotalTokens: 54_000,
            },
          });
          let resolveDone!: () => void;
          const done = new Promise<void>((resolve) => {
            resolveDone = resolve;
          });
          const subscription = transport.subscribeEvents((envelope) => {
            if (envelope.turnId !== turnId) return;
            transcript = applyEvent(transcript, envelope.event);
            if (envelope.event.type === 'assistant_delta') {
              textDeltaCount += 1;
              streamingSnapshots.push(structuredClone(transcript));
            }
            if (envelope.event.type === 'done') resolveDone();
          });
          if (!subscription.ok) {
            throw new Error(subscription.error);
          }

          const started = await transport.start({
            turnId,
            route,
            prompt: canary.prompt,
            model,
            projectName: '星海漂流',
            projectFacts: [{ key: '题材', value: '近未来科幻' }],
            thinking: 'off',
            toolSearch: 'auto',
          });
          expect(started, `${canary.id} transport start`).toMatchObject({
            ok: true,
          });
          await done;
          subscription.value();

          const terminal = [...journalEntries]
            .reverse()
            .find((entry) => entry.event.type === 'turn_finished')
            ?.event;
          if (!terminal || terminal.type !== 'turn_finished') {
            throw new Error(`${canary.id} did not emit turn_finished`);
          }
          const toolResults = journalEntries
            .map((entry) => entry.event)
            .filter((event) => event.type === 'tool_result');
          const actualTools = toolResults.map((event) => event.name);
          const assistantText = transcript
            .filter((message) => message.kind === 'assistant')
            .map((message) => message.text)
            .join('');
          const eventTypes = journalEntries.map((entry) => entry.event.type);
          const toolIterations = new Map(
            journalEntries
              .map((entry) => entry.event)
              .filter((event) => event.type === 'tool_call_ready')
              .map((event) => [event.callId, event.iteration] as const),
          );

          const toolTrace = toolResults.map(
            (event) =>
              `${event.name}@${toolIterations.get(event.callId) ?? '?'}:${event.ok ? 'ok' : 'failed'}`,
          );

          console.log(
            `[agent-product-canary] ${canary.id} status=${terminal.outcome} iterations=${terminal.modelIterations} tools=${toolTrace.join(',') || '-'} schemas=${providerRequests
              .map(
                (request) =>
                  `${request.iteration}:[${request.toolNames.join(',')}]`,
              )
              .join(';')} textDeltas=${textDeltaCount} tokens=${terminal.usage.inputTokens}+${terminal.usage.outputTokens} latencyMs=${terminal.durationMs}`,
          );

          expect(terminal.outcome, canary.id).toBe('completed');
          expect(
            terminal.modelIterations,
            `${canary.id} iterations`,
          ).toBeLessThanOrEqual(canary.maxIterations);
          expect(actualTools, `${canary.id} exact tool plan`).toEqual([
            canary.expectedTool,
          ]);
          expect(
            toolResults.every((event) => event.ok),
            `${canary.id} failed tools`,
          ).toBe(true);
          for (const pattern of canary.answerPatterns) {
            expect(assistantText, canary.id).toMatch(pattern);
          }
          expect(textDeltaCount, `${canary.id} streamed text`).toBeGreaterThan(
            1,
          );
          expect(
            streamingSnapshots[0]?.some(
              (message) =>
                message.kind === 'assistant' && message.streaming === true,
            ),
            `${canary.id} panel streaming state`,
          ).toBe(true);
          expect(
            transcript.some(
              (message) =>
                message.kind === 'assistant' &&
                message.streaming === false &&
                message.text.length > 0,
            ),
            `${canary.id} panel finalized state`,
          ).toBe(true);
          expect(
            transcript.some(
              (message) =>
                message.kind === 'tool' &&
                message.name === canary.expectedTool &&
                message.status === 'ok',
            ),
            `${canary.id} panel tool projection`,
          ).toBe(true);
          expect(eventTypes.indexOf('text_delta'), canary.id).toBeLessThan(
            eventTypes.indexOf('turn_finished'),
          );
          expect(
            providerRequests.every(
              (request) => request.toolNames.length <= 8,
            ),
            `${canary.id} bounded schemas`,
          ).toBe(true);
          expect(tools.violations).toEqual({
            unauthorizedWrite: 0,
            crossProject: 0,
            unknownTool: 0,
            fixtureMutation: 0,
          });
        }
      },
      5 * 60_000,
    );
  },
);

function recordingDriver(
  delegate: AgentModelDriver,
  requests: { iteration: number; toolNames: string[] }[],
): AgentModelDriver {
  return {
    id: delegate.id,
    capabilities: delegate.capabilities,
    stream(request: AgentModelRequest) {
      requests.push({
        iteration: request.iteration,
        toolNames: request.tools.map((tool) => tool.name),
      });
      return delegate.stream(request);
    },
  };
}
