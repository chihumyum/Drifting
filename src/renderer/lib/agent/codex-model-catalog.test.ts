import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexModel, CodexSubscriptionStatus } from '../../platform/contracts';
import { createCodexModelCatalog } from './codex-model-catalog';
import {
  agentProviderOption,
  normalizeAgentProviderEffort,
  normalizeAgentProviderModel,
  normalizeAgentProviderThinking,
  resolveAgentProviderContextProfile,
  resolveAgentProviderReasoningProfile,
  setCodexModelCatalog,
} from './runtime/agent-provider-contract';
import { useSettingsStore } from '../../store/settings-store';
import { AgentRuntime, DEFAULT_AGENT_RUNTIME_LIMITS } from './runtime/runtime';
import { DriftingAgentModelDriver } from './runtime/drivers/drifting-agent-driver';
import { OpenAIResponsesAgentDriver } from './runtime/drivers/openai-responses-driver';
import { resolveDriftingAgentContextProfile } from './runtime/drifting-agent-product-contract';
import type { AgentModelRequest } from './runtime/types';

const nextModel: CodexModel = {
  slug: 'gpt-next', displayName: 'Next model', contextWindow: 256_000,
  supportedReasoningEfforts: ['low', 'high', 'ultra'], defaultReasoningEffort: 'high',
  supportsReasoningSummary: false, supportsVerbosity: false,
};
const signedIn = (accountId = 'synthetic-account'): CodexSubscriptionStatus => ({
  signedIn: true, account: { accountId, email: null, plan: null }, login: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function fixture() {
  const source = { status: vi.fn(async () => signedIn()), listModels: vi.fn(async () => [nextModel]) };
  const publish = vi.fn(setCodexModelCatalog);
  const available = vi.fn(() => true);
  let now = 1_000;
  const catalog = createCodexModelCatalog(source, publish, available, () => now);
  return { source, publish, available, catalog, advance: () => { now += 300_001; } };
}

afterEach(() => setCodexModelCatalog(null));

describe('ChatGPT account model discovery', () => {
  it.each(['discovered', 'unresolved'] as const)(
    'completes an uncapped tool loop with a %s subscription model',
    async (catalogState) => {
      if (catalogState === 'discovered') await fixture().catalog.refresh();
      const requests: AgentModelRequest[] = [];
      const bodies: Record<string, unknown>[] = [];
      const finalText = '文'.repeat(16_384);
      const provider = new OpenAIResponsesAgentDriver({
        provider: 'openai-codex', defaultModel: 'gpt-next',
        transport: { request: async (body) => {
          bodies.push(JSON.parse(body));
          const tool = { id: 'fc_read', type: 'function_call', call_id: 'read-1', name: 'read_fixture', arguments: '{}', status: 'completed' };
          const reasoning = { id: 'rs_read', type: 'reasoning', encrypted_content: 'synthetic-state', summary: [] };
          const events = bodies.length === 1 ? [
            { type: 'response.output_item.added', item: { ...tool, arguments: '' } },
            { type: 'response.function_call_arguments.delta', item_id: tool.id, delta: '{}' },
            { type: 'response.output_item.done', item: tool },
          ] : [{ type: 'response.output_text.delta', delta: finalText }];
          return new Response([...events, {
            type: 'response.completed', response: {
              status: 'completed', output: bodies.length === 1 ? [reasoning, tool] : [],
              usage: { input_tokens: 12, output_tokens: 16_384 },
            },
          }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
        } },
      });
      const driver = new DriftingAgentModelDriver({
        createProviderDriver: async () => ({
          id: 'synthetic-subscription-provider',
          stream(request) {
            requests.push(request);
            return provider.stream(request);
          },
        }),
      });
      const execute = vi.fn(async () => ({ ok: true as const, data: { text: 'Synthetic fixture.' } }));
      const runtime = new AgentRuntime({
        driver,
        tools: {
          listDefinitions: () => [{
            name: 'read_fixture', description: 'Read a synthetic fixture.', access: 'read',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            validateInput: (value) => ({ ok: true, value }),
          }],
          execute,
        },
        contextPlanning: {
          resolveProviderProfile: (input) => resolveDriftingAgentContextProfile({
            declared: resolveAgentProviderContextProfile(input.provider, input.model),
          }),
        },
      });
      expect(DEFAULT_AGENT_RUNTIME_LIMITS.maxOutputTokensPerIteration).toBeNull();
      const result = await runtime.runTurn({
        sessionId: 'catalog-session', turnId: 'catalog-turn',
        route: { kind: 'test', projectId: 'synthetic-project' },
        provider: 'openai-codex', model: 'gpt-next', prompt: 'Review the synthetic fixture.',
      });

      expect(result.state.status).toBe('completed');
      expect(execute).toHaveBeenCalledOnce();
      expect(requests.map(({ model, maxOutputTokens }) => ({ model, maxOutputTokens }))).toEqual([
        { model: 'gpt-next', maxOutputTokens: null },
        { model: 'gpt-next', maxOutputTokens: null },
      ]);
      const plans = result.entries.filter((entry) => entry.event.type === 'context_planned');
      expect(plans).toHaveLength(2);
      for (const plan of plans) expect(plan.event).toMatchObject({ snapshot: { reservedOutputTokens: 8_192 } });
      expect(result.state.usage.outputTokens).toBe(32_768);
      expect(result.messages[result.messages.length - 1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: finalText }] });
      expect(bodies).toHaveLength(2);
      for (const body of bodies) expect(body).not.toHaveProperty('max_output_tokens');
      expect(bodies[1].input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'read-1' }),
      ]));
      expect(result.state.terminal?.failureCode).toBeUndefined();
      expect(result.completedContextCheckpoint).toBeDefined();
    },
  );

  it('loads fresh choices with account capabilities and preserves their server order', async () => {
    const { catalog, source } = fixture();
    source.listModels.mockResolvedValue([nextModel, { ...nextModel, slug: 'gpt-small', contextWindow: null }]);
    await catalog.refresh();
    expect(catalog.getSnapshot().state).toBe('ready');
    expect(agentProviderOption('openai-codex').models.map((model) => model.value)).toEqual(['gpt-next', 'gpt-small']);
    expect(normalizeAgentProviderModel('openai-codex', 'gpt-next')).toBe('gpt-next');
    expect(resolveAgentProviderContextProfile('openai-codex', 'gpt-next').contextWindowTokens).toBe(256_000);
    expect(resolveAgentProviderContextProfile('openai-codex', 'gpt-next').maxOutputTokens).toBeNull();
    expect(resolveAgentProviderContextProfile('openai-codex', 'gpt-small').contextWindowTokens).toBe(32_768);
    expect(normalizeAgentProviderThinking('openai-codex', 'gpt-next', 'off')).toBe('adaptive');
    expect(normalizeAgentProviderEffort('openai-codex', 'gpt-next', 'max')).toBe('high');
    expect(normalizeAgentProviderEffort('openai-codex', 'gpt-next', 'ultra')).toBe('ultra');
    expect(agentProviderOption('openai').models[0].value).toBe('gpt-5.6-sol');
  });

  it('deduplicates concurrent requests, caches for five minutes and supports forced refresh', async () => {
    const { catalog, source, advance } = fixture();
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
    await catalog.refresh();
    expect(source.listModels).toHaveBeenCalledTimes(1);
    await catalog.refresh(true);
    expect(source.listModels).toHaveBeenCalledTimes(2);
    advance();
    await catalog.refresh();
    expect(source.listModels).toHaveBeenCalledTimes(3);
  });

  it('preserves the last good catalog and selected model after a failed or empty refresh', async () => {
    const { catalog, source } = fixture();
    await catalog.refresh();
    source.listModels.mockRejectedValueOnce(new Error('private provider response'));
    await catalog.refresh(true);
    expect(catalog.getSnapshot()).toEqual({ state: 'error', updatedAt: 1_000 });
    expect(agentProviderOption('openai-codex').models[0].value).toBe('gpt-next');
    source.listModels.mockResolvedValueOnce([]);
    await catalog.refresh(true);
    expect(agentProviderOption('openai-codex').models[0].value).toBe('gpt-next');
  });

  it('clears the old account catalog even when the new account cannot fetch models', async () => {
    const { catalog, source, publish } = fixture();
    await catalog.refresh();
    source.status.mockResolvedValueOnce(signedIn('another-account'));
    source.listModels.mockRejectedValueOnce(new Error('unavailable'));
    await catalog.refresh(true);
    expect(publish).toHaveBeenLastCalledWith(null);
    expect(catalog.getSnapshot()).toEqual({ state: 'error', updatedAt: null });
    expect(agentProviderOption('openai-codex').models[0].value).toBe('gpt-5.6-sol');
  });

  it('discards a late response after logout or account invalidation', async () => {
    const { catalog, source, publish } = fixture();
    const pending = deferred<CodexModel[]>();
    source.listModels.mockReturnValueOnce(pending.promise);
    const old = catalog.refresh();
    await vi.waitFor(() => expect(source.listModels).toHaveBeenCalledOnce());
    catalog.invalidate();
    source.status.mockResolvedValueOnce({ signedIn: false, account: null, login: null });
    await catalog.refresh();
    pending.resolve([nextModel]);
    await old;
    expect(publish).toHaveBeenLastCalledWith(null);
    expect(catalog.getSnapshot().state).toBe('signed-out');
    expect(source.listModels).toHaveBeenCalledOnce();
  });

  it('does not read credentials or contact the provider when unavailable/offline', async () => {
    const { catalog, source, available } = fixture();
    available.mockReturnValue(false);
    await catalog.refresh(true);
    expect(source.status).not.toHaveBeenCalled();
    expect(source.listModels).not.toHaveBeenCalled();
  });

  it('preserves a saved remote selection across restart without inventing a large context window', () => {
    expect(normalizeAgentProviderModel('openai-codex', 'gpt-next')).toBe('gpt-next');
    expect(resolveAgentProviderContextProfile('openai-codex', 'gpt-next').contextWindowTokens).toBe(32_768);
    expect(normalizeAgentProviderModel('openai-codex', 'deepseek-v4-flash')).toBe('gpt-5.6-sol');
    expect(normalizeAgentProviderModel('openai', 'gpt-next')).toBe('gpt-5.6-sol');
    expect(normalizeAgentProviderModel('openai-codex', 'https://example.test/model')).toBe('gpt-5.6-sol');
  });

  it('selects newly discovered models in settings without silently rewriting them', async () => {
    const { catalog } = fixture();
    const before = useSettingsStore.getState();
    try {
      await catalog.refresh();
      useSettingsStore.getState().setAgentProvider('openai-codex');
      useSettingsStore.getState().setAgentModel('gpt-next');
      useSettingsStore.getState().setAgentEffort('ultra');
      expect(useSettingsStore.getState()).toMatchObject({ agentModel: 'gpt-next', agentThinking: 'adaptive', agentEffort: 'ultra' });
      catalog.invalidate();
      useSettingsStore.getState().setAgentModel('gpt-next');
      expect(useSettingsStore.getState().agentModel).toBe('gpt-next');
    } finally {
      useSettingsStore.setState(before);
    }
  });

  it('supports models with optional or no reasoning without adding unsupported effort levels', () => {
    setCodexModelCatalog([{ ...nextModel, supportedReasoningEfforts: ['none', 'minimal', 'low'] }]);
    expect(resolveAgentProviderReasoningProfile('openai-codex', 'gpt-next')).toMatchObject({
      thinkingModes: ['off', 'adaptive'], efforts: ['minimal', 'low'], defaultEffort: 'minimal',
    });
    setCodexModelCatalog([{ ...nextModel, supportedReasoningEfforts: [] }]);
    expect(resolveAgentProviderReasoningProfile('openai-codex', 'gpt-next')).toMatchObject({ thinkingModes: ['off'], efforts: [] });
  });
});
