import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AICompletionRequest,
  AICompletionResponse,
} from '../types';
import { LoggingInterceptor } from './logging-interceptor';

const request: AICompletionRequest = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'test' }],
  metadata: { feature: 'general-agent' },
};

describe('LoggingInterceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints all parallel tool calls in the compact response line', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response: AICompletionResponse = {
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

    new LoggingInterceptor('agent').after(request, response);

    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[agent] ← general-agent tools:read_node#call-1,search_prose#call-2 in=120 out=18 cached=40',
    );
  });

  it('preserves the legacy single toolCall console format', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
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

    new LoggingInterceptor('agent').after(request, response);

    expect(info).toHaveBeenCalledExactlyOnceWith(
      '[agent] ← general-agent tool:get_project_brief in=12 out=3',
    );
  });
});
