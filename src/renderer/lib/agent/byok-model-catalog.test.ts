import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ByokListedModel, ByokModelCatalogResponse } from '../../platform/contracts';
import { events } from '../events';
import { byokModelLists, createByokModelList } from './byok-model-catalog';
import {
  BYOK_AGENT_PROVIDERS,
  agentProviderOption,
  setByokModelCatalog,
} from './runtime/agent-provider-contract';

const model = (id: string): ByokListedModel => ({
  id, displayName: null, created: null, contextWindow: null,
  maxOutputTokens: null, adaptiveThinking: null, efforts: null, defaultEffort: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function fixture(list: () => Promise<ByokModelCatalogResponse> = async () => ({ models: [model('gpt-6.2-nova')] })) {
  const source = vi.fn(list);
  const publish = vi.fn();
  const available = vi.fn(() => true);
  let now = 1_000;
  const catalog = createByokModelList('openai', source, publish, available, () => now);
  return { source, publish, available, catalog, advance: (ms = 300_001) => { now += ms; } };
}

afterEach(() => {
  for (const provider of BYOK_AGENT_PROVIDERS) setByokModelCatalog(provider, null);
});

describe('API-key provider model lists', () => {
  it('publishes the provider list and re-reads it only after five minutes or on demand', async () => {
    const { catalog, source, publish, advance } = fixture();
    await catalog.refresh();
    expect(source).toHaveBeenCalledWith('openai');
    expect(publish).toHaveBeenLastCalledWith('openai', [model('gpt-6.2-nova')]);
    expect(catalog.getSnapshot()).toEqual({ state: 'ready', updatedAt: 1_000 });
    await catalog.refresh();
    expect(source).toHaveBeenCalledOnce();
    advance();
    await catalog.refresh();
    await catalog.refresh(true);
    expect(source).toHaveBeenCalledTimes(3);
  });

  it('keeps the last list when a refresh fails and never surfaces provider text', async () => {
    let fail = false;
    const { catalog, publish } = fixture(async () => {
      if (fail) throw new Error('BYOK_MODELS_FAILED: provider_rejected (500)');
      return { models: [model('gpt-6.2-nova')] };
    });
    await catalog.refresh();
    fail = true;
    await catalog.refresh(true);
    expect(catalog.getSnapshot()).toEqual({ state: 'error', updatedAt: 1_000 });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalledWith('openai', null);
  });

  it('falls back to the bundled models without a key and waits for a key change', async () => {
    const { catalog, source, publish } = fixture(async () => {
      throw new Error('BYOK_MODELS_MISSING_KEY: no API key is configured for this provider');
    });
    await catalog.refresh();
    expect(publish).toHaveBeenLastCalledWith('openai', null);
    expect(catalog.getSnapshot().state).toBe('missing-key');
    await catalog.refresh();
    expect(source).toHaveBeenCalledOnce();
    catalog.invalidate();
    await catalog.refresh();
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('drops a response that arrives after the key changed', async () => {
    const pending = deferred<ByokModelCatalogResponse>();
    const { catalog, publish } = fixture(() => pending.promise);
    const request = catalog.refresh();
    catalog.invalidate();
    pending.resolve({ models: [model('gpt-6.2-nova')] });
    await request;
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith('openai', null);
    expect(catalog.getSnapshot()).toEqual({ state: 'idle', updatedAt: null });
  });

  it('does not read the key or contact the provider when unavailable or offline', async () => {
    const { catalog, source, available } = fixture();
    available.mockReturnValue(false);
    await catalog.refresh(true);
    expect(source).not.toHaveBeenCalled();
  });

  it('clears every provider list when Settings reports a key change', () => {
    setByokModelCatalog('openai', [model('gpt-6.2-nova')]);
    expect(agentProviderOption('openai').models.map((item) => item.value)).toEqual(['gpt-6.2-nova']);
    expect(Object.keys(byokModelLists)).toEqual(['deepseek', 'anthropic', 'openai']);
    events.emit('byok:keys-changed');
    expect(agentProviderOption('openai').models[0]!.value).toBe('gpt-6-astra');
  });
});
