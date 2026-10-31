import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function source(path: string): Promise<string> {
  return readFile(`${CORE_ROOT}${path}`, 'utf8');
}

describe('central AI provider settings acceptance', () => {
  it('keeps every writable provider credential inside Models & API', async () => {
    const text = await source(
      '/src/renderer/features/settings/desktop/DesktopSettingsModal.tsx',
    );
    const intelligence = await source(
      '/src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx',
    );
    const agent = await source('/src/renderer/features/settings/panels/AgentSettingsPanel.tsx');
    const models = intelligence.slice(intelligence.indexOf('export function ModelsPanel('));

    expect(text).toContain("id: 'models'");
    expect(models.match(/<ProviderRow/g)).toHaveLength(3);
    expect(models).toContain('<ChatGptSubscriptionRow');
    expect(intelligence).toContain("events.emit('agent:auth-changed')");
    expect(agent).not.toContain('<ProviderRow');
    expect(agent).not.toContain('AgentAuthRow');
    expect(text).not.toContain('function ShadowPanel(');
  });

  it('leaves General Agent selection in chat and retires the Copilot route', async () => {
    const settings = await source(
      '/src/renderer/features/settings/desktop/DesktopSettingsModal.tsx',
    );
    const companion = await source('/src/renderer/features/agent/desktop/DesktopAgentPanel.tsx');
    const intelligence = await source(
      '/src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx',
    );
    const agent = await source('/src/renderer/features/settings/panels/AgentSettingsPanel.tsx');
    const composer = await source('/src/renderer/features/agent/AgentComposerConfig.tsx');
    const runtime = await source('/src/renderer/lib/agent/useDriftingAgentRuntime.ts');

    expect(intelligence).not.toContain('CopilotPanel');
    expect(settings).not.toContain("id: 'copilot'");
    expect(settings).not.toContain('setShadowByokProvider');
    expect(settings).not.toContain('setShadowByokModel');
    expect(agent).not.toContain('setAgentProvider');
    expect(agent).not.toContain('setAgentModel');
    expect(composer).toContain('setAgentProvider');
    expect(composer).toContain('setAgentModel');
    expect(companion).toContain("railId: 'models'");
    expect(companion).toContain('isGeneralAgentUsable(agentAuth, status)');
    expect(runtime).toContain('chatgptConnected');
    expect(runtime).toContain('platform.codexSubscription');
  });

  it('lets the Agent panel first run only add a tested key or pick a route that can run', async () => {
    const onboarding = await source('/src/renderer/features/agent/onboarding/AgentOnboarding.tsx');
    const connect = await source('/src/renderer/lib/agent/connect-agent-provider.ts');

    expect(onboarding).toContain('connectAgentProviderKey(provider, draft)');
    expect(onboarding).toContain('selectAgentProvider(id)');
    expect(onboarding).not.toMatch(/byokKeychain\.(set|clear|get)\(/);
    expect(onboarding).not.toContain('<ProviderRow');
    expect(connect).toContain('testByokProviderConnection(provider');
    expect(connect).toContain("events.emit('agent:auth-changed')");
  });

  it('tests every credential directly without a hosted BYOK relay', async () => {
    const intelligence = await source(
      '/src/renderer/features/settings/panels/IntelligenceSettingsPanels.tsx',
    );
    const connection = await source('/src/renderer/lib/ai/test-provider-connection.ts');

    expect(intelligence).toContain('testByokProviderConnection(provider');
    expect(intelligence).not.toContain('apiClient');
    expect(connection).toContain('buildDirectBYOKClient');
    expect(connection).toContain('platform.openAIResponses.request');
    expect(connection).not.toContain(['/api/ai/byok', 'test'].join('/'));
  });
});
