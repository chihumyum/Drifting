import { describe, expect, it } from 'vitest';

import type {
  AICompletionRequest,
  AICompletionResponse,
} from '../types';
import { formatEntryAsMarkdown } from './markdown-format';
import {
  snapshotRequest,
  snapshotResponse,
  type AIRequestLogEntry,
} from './request-log';

const parallelResponse: AICompletionResponse = {
  toolCall: {
    id: 'call-1',
    name: 'read_node',
    arguments: { node: '第一章' },
  },
  toolCalls: [
    {
      id: 'call-1',
      name: 'read_node',
      arguments: { node: '第一章' },
    },
    {
      id: 'call-2',
      name: 'search_prose',
      arguments: { query: '旧港' },
    },
  ],
  usage: {
    inputTokens: 120,
    outputTokens: 18,
    cachedTokens: 40,
  },
};

describe('AI request log response snapshots', () => {
  it('captures every parallel tool call while retaining the first-call alias', () => {
    expect(snapshotResponse(parallelResponse)).toEqual({
      text: undefined,
      toolCall: {
        id: 'call-1',
        name: 'read_node',
        arguments: { node: '第一章' },
      },
      toolCalls: [
        {
          id: 'call-1',
          name: 'read_node',
          arguments: { node: '第一章' },
        },
        {
          id: 'call-2',
          name: 'search_prose',
          arguments: { query: '旧港' },
        },
      ],
      usage: {
        inputTokens: 120,
        outputTokens: 18,
        cachedTokens: 40,
      },
    });
  });

  it('promotes a legacy toolCall-only response into the complete snapshot shape', () => {
    const response: AICompletionResponse = {
      toolCall: {
        name: 'get_project_brief',
        arguments: {},
      },
      usage: {
        inputTokens: 12,
        outputTokens: 3,
      },
    };

    expect(snapshotResponse(response)).toEqual({
      text: undefined,
      toolCall: {
        name: 'get_project_brief',
        arguments: {},
      },
      toolCalls: [
        {
          name: 'get_project_brief',
          arguments: {},
        },
      ],
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cachedTokens: undefined,
      },
    });
  });
});

describe('AI request log request snapshots', () => {
  it('preserves assistant call and tool-result topology across model iterations', () => {
    const request: AICompletionRequest = {
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'model',
          content: '',
          toolCalls: parallelResponse.toolCalls,
        },
        {
          role: 'tool',
          toolCallId: 'call-2',
          content: '{"matches":[]}',
        },
      ],
      metadata: { feature: 'general-agent' },
    };

    expect(snapshotRequest(request).messages).toEqual([
      {
        role: 'model',
        content: '',
        toolCalls: parallelResponse.toolCalls,
      },
      {
        role: 'tool',
        content: '{"matches":[]}',
        toolCallId: 'call-2',
      },
    ]);
  });
});

describe('AI request log Markdown', () => {
  it('renders every parallel tool call in order with ids and arguments', () => {
    const entry = {
      id: 'request-1',
      startedAt: Date.parse('2026-07-31T00:00:00.000Z'),
      finishedAt: Date.parse('2026-07-31T00:00:01.000Z'),
      durationMs: 1_000,
      status: 'success',
      request: {
        model: 'deepseek-v4-flash',
        feature: 'general-agent',
        messages: [{ role: 'user', content: '读取并搜索' }],
        toolNames: ['read_node', 'search_prose'],
      },
      response: snapshotResponse(parallelResponse),
    } satisfies AIRequestLogEntry;

    const markdown = formatEntryAsMarkdown(entry);

    expect(markdown).toContain(
      [
        '## Tool call 1/2 · `read_node`',
        '',
        '- **Call ID**: `call-1`',
        '',
        '````json',
        '{',
        '  "node": "第一章"',
        '}',
        '````',
      ].join('\n'),
    );
    expect(markdown).toContain(
      [
        '## Tool call 2/2 · `search_prose`',
        '',
        '- **Call ID**: `call-2`',
        '',
        '````json',
        '{',
        '  "query": "旧港"',
        '}',
        '````',
      ].join('\n'),
    );
    expect(markdown.indexOf('Tool call 1/2')).toBeLessThan(
      markdown.indexOf('Tool call 2/2'),
    );
  });

  it('renders request call/result ids and terminal reason for trajectory diagnosis', () => {
    const entry = {
      id: 'trajectory-request',
      startedAt: Date.parse('2026-07-31T00:00:00.000Z'),
      status: 'success',
      request: {
        model: 'deepseek-v4-flash',
        feature: 'general-agent',
        metadata: {
          agentSessionId: 'session-1',
          agentTurnId: 'turn-1',
          agentIteration: 2,
        },
        messages: [
          {
            role: 'model',
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'read_node',
                arguments: { node: '第一章' },
              },
            ],
          },
          {
            role: 'tool',
            content: '{"title":"第一章"}',
            toolCallId: 'call-1',
          },
        ],
        toolNames: ['read_node'],
      },
      response: {
        text: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    } satisfies AIRequestLogEntry;

    const markdown = formatEntryAsMarkdown(entry);

    expect(markdown).toContain('- **Finish reason**: `stop`');
    expect(markdown).toContain('- **Agent session**: `session-1`');
    expect(markdown).toContain('- **Agent turn**: `turn-1`');
    expect(markdown).toContain('- **Agent iteration**: 2');
    expect(markdown).toContain(
      '- **Assistant tool calls**: `read_node#call-1`',
    );
    expect(markdown).toContain('- **Tool result for**: `call-1`');
  });

  it('still renders stored toolCall-only entries once with the legacy heading', () => {
    const entry = {
      id: 'legacy-request',
      startedAt: Date.parse('2026-07-31T00:00:00.000Z'),
      status: 'success',
      request: {
        model: 'legacy-model',
        feature: 'legacy-feature',
        messages: [],
        toolNames: ['legacy_tool'],
      },
      response: {
        toolCall: {
          name: 'legacy_tool',
          arguments: { value: 1 },
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
      },
    } satisfies AIRequestLogEntry;

    const markdown = formatEntryAsMarkdown(entry);

    expect(markdown).toContain('## Tool call · `legacy_tool`');
    expect(markdown).not.toContain('Tool call 1/1');
    expect(markdown.match(/## Tool call/g)).toHaveLength(1);
  });
});
